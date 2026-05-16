import {BindingScope, inject, injectable} from '@loopback/core';
import {isIP} from 'node:net';
import {ContractsSourceError} from '../helpers';
import type {SchemaSource, SchemaSourceResult} from '../interfaces';
import {SOURCE_TAG} from '../keys';
import {SchemaSourceCache} from './source-cache';

/**
 * Built-in {@link SchemaSource} for `https://` descriptors. Two shapes are
 * supported:
 *
 *   - **Single file** — when the URI's path ends in `.json` or
 *     `.schema.json`, the source issues a single `GET` and returns one
 *     entry.
 *   - **Directory-like** — otherwise the source fetches `<uri>/index.json`,
 *     expects an array of filenames (strings) or `{path}` objects, and
 *     issues one `GET` per listed file.
 *
 * Both shapes honour ETags via `<projectRoot>/.loopback/cache/schemas/etags.json`;
 * a conditional `If-None-Match` request that returns `304` reuses the
 * cached manifest. Any `4xx`/`5xx` aborts the fetch with the status code
 * embedded in the error message; 304 is treated as success-from-cache.
 *
 * Returns each fetched file as-is; bundled multi-schema files (with `$defs`)
 * are returned as one entry and split downstream by the pipeline.
 *
 * Node 22+ `fetch` is used directly — no `node-fetch` dependency.
 *
 * @remarks
 * **Security hardening.** Only `https://` URIs are accepted; any other
 * protocol is rejected up-front. Outbound requests to RFC1918, loopback,
 * link-local, and `localhost`-like hosts are refused to mitigate SSRF
 * against cloud metadata endpoints (e.g., `169.254.169.254`) and other
 * internal services. Set the environment variable
 * `LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1` to opt in to private
 * destinations — only do so for trusted internal mirrors.
 *
 * Every request is bounded by a per-call timeout (default 30000ms,
 * override with `LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS`) and the directory
 * listing fan-out is capped at 8 concurrent requests via an in-process
 * semaphore.
 *
 * Redirects are followed (`fetch` default). The ETag cache is keyed by the
 * final response URL (`res.url`) — and the original-to-final URL mapping
 * is persisted — so a `301` does not cause repeated re-fetches of the
 * redirected resource.
 *
 * @internal
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[SOURCE_TAG]: SOURCE_TAG, scheme: 'https'},
})
export class HttpSchemaSource implements SchemaSource {
  readonly scheme = 'https';
  private readonly cache: SchemaSourceCache;

  constructor(
    @inject('platform.contracts.project-root', {optional: true})
    private readonly projectRoot: string = process.cwd(),
  ) {
    this.cache = new SchemaSourceCache(this.projectRoot);
  }

  /**
   * Resolve `uri` to a single schema file or a directory listing and return
   * every fetched file's contents.
   *
   * @throws ContractsSourceError On non-2xx responses, malformed index files,
   *   network errors, non-`https://` protocols, or blocked private hosts.
   */
  async fetch(uri: string): Promise<SchemaSourceResult> {
    assertHttpsScheme(uri, this.scheme);
    assertHostAllowed(uri, this.scheme, allowPrivateHostsFromEnv());
    if (isSingleFile(uri)) {
      return this.fetchSingle(uri);
    }
    return this.fetchDirectory(uri);
  }

  /**
   * Issue a conditional `GET` for one file. On `304 Not Modified` returns
   * the cached entry; on `2xx` updates the cache, the ETag store, and (if
   * applicable) the redirect store. The ETag is keyed by the final response
   * URL (after any redirects) so a permanent redirect does not defeat the
   * conditional GET.
   *
   * @remarks
   * **Trust boundary.** The cached redirect target is trusted for the
   * next-call host check — {@link assertHostAllowed} is re-run against it,
   * but the value itself comes from disk. `etags.json` and `redirects.json`
   * must not be writable by lower-trust processes: CI cache restores from
   * untrusted sources must invalidate `.loopback/cache/` before the next
   * run.
   *
   * **Retry bound.** A 304 with an evaporated manifest re-issues the fetch
   * as an unconditional `GET`, but the retry chain is depth-bounded
   * (`MAX_RETRY_ATTEMPTS = 2`). A persistent racing invalidator would
   * otherwise cause unbounded recursion; instead the caller sees a
   * structured `ContractsSourceError`.
   */
  private async fetchSingle(
    uri: string,
    attempt = 0,
  ): Promise<SchemaSourceResult> {
    const requestUrl = (await this.cache.redirect(uri)) ?? uri;
    assertHostAllowed(requestUrl, this.scheme, allowPrivateHostsFromEnv());
    const headers = new Headers();
    const previousEtag = await this.cache.etag(requestUrl);
    if (previousEtag !== undefined) headers.set('If-None-Match', previousEtag);

    const fetched = await safeFetch(requestUrl, headers, this.scheme);
    const res = fetched.response;
    if (res.status === 304) {
      // Manifest key = descriptor URI (stable); ETag key = final URL (follows redirects).
      const cached = await this.cache.read(uri);
      if (cached !== undefined) return cached;
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        throw new ContractsSourceError(
          'cache evaporated during fetch retry — possibly concurrent invalidation',
          {scheme: this.scheme, uri},
        );
      }
      // Cache evaporated between the ETag and the manifest read — drop the
      // ETag and the redirect mapping, then re-issue an unconditional GET.
      await this.cache.invalidate(requestUrl);
      await this.cache.invalidate(uri);
      return this.fetchSingle(uri, attempt + 1);
    }
    assertOk(res, requestUrl, this.scheme);
    const content = await readBodyText(fetched, requestUrl, this.scheme);
    const result: SchemaSourceResult = [{source: uri, path: uri, content}];
    await this.cache.write(uri, result);
    const newEtag = res.headers.get('etag');
    const finalUrl = res.url || requestUrl;
    if (finalUrl !== uri) {
      await this.cache.setRedirect(uri, finalUrl);
    }
    if (newEtag) await this.cache.setEtag(finalUrl, newEtag);
    return result;
  }

  /**
   * Fetch `<uri>/index.json`, walk its listing, and `GET` each entry. The
   * index file is treated as authoritative — entries not in the index are
   * not discoverable. File-level fetches are bounded by an 8-wide semaphore.
   * The 304-evaporated retry chain is depth-bounded by
   * {@link MAX_RETRY_ATTEMPTS} like {@link fetchSingle}.
   */
  private async fetchDirectory(
    uri: string,
    attempt = 0,
  ): Promise<SchemaSourceResult> {
    const base = uri.replace(/\/+$/, '');
    const indexUrl = `${base}/index.json`;
    const indexRequestUrl = (await this.cache.redirect(indexUrl)) ?? indexUrl;
    assertHostAllowed(indexRequestUrl, this.scheme, allowPrivateHostsFromEnv());
    const headers = new Headers();
    const previousEtag = await this.cache.etag(indexRequestUrl);
    if (previousEtag !== undefined) headers.set('If-None-Match', previousEtag);

    const fetchedIndex = await safeFetch(indexRequestUrl, headers, this.scheme);
    const indexRes = fetchedIndex.response;
    if (indexRes.status === 304) {
      const cached = await this.cache.read(uri);
      if (cached !== undefined) return cached;
      if (attempt >= MAX_RETRY_ATTEMPTS) {
        throw new ContractsSourceError(
          'cache evaporated during fetch retry — possibly concurrent invalidation',
          {scheme: this.scheme, uri},
        );
      }
      await this.cache.invalidate(uri);
      await this.cache.invalidate(indexUrl);
      await this.cache.invalidate(indexRequestUrl);
      return this.fetchDirectory(uri, attempt + 1);
    }
    assertOk(indexRes, indexRequestUrl, this.scheme);
    const indexBody = await readBodyText(
      fetchedIndex,
      indexRequestUrl,
      this.scheme,
    );
    const filenames = parseIndex(indexBody, indexRequestUrl, this.scheme);

    const limit = createSemaphore(MAX_CONCURRENT_FETCHES);
    const results: SchemaSourceResult = await Promise.all(
      filenames.map(name =>
        limit(async () => {
          const fileUrl = `${base}/${name}`;
          assertHostAllowed(fileUrl, this.scheme, allowPrivateHostsFromEnv());
          const fetchedFile = await safeFetch(
            fileUrl,
            new Headers(),
            this.scheme,
          );
          assertOk(fetchedFile.response, fileUrl, this.scheme);
          const content = await readBodyText(fetchedFile, fileUrl, this.scheme);
          return {source: uri, path: fileUrl, content};
        }),
      ),
    );
    await this.cache.write(uri, results);
    const newEtag = indexRes.headers.get('etag');
    const finalUrl = indexRes.url || indexRequestUrl;
    if (finalUrl !== indexUrl) {
      await this.cache.setRedirect(indexUrl, finalUrl);
    }
    if (newEtag) await this.cache.setEtag(finalUrl, newEtag);
    return results;
  }
}

/** Default per-request timeout in milliseconds, when env var is unset. */
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/** Maximum number of in-flight `fetch` calls during a directory walk. */
const MAX_CONCURRENT_FETCHES = 8;

/**
 * Maximum depth for the 304+cache-evaporated retry chain. Two attempts is
 * enough to ride out a single concurrent invalidation; beyond that something
 * is racing pathologically and we should surface a structured error rather
 * than spinning indefinitely.
 */
const MAX_RETRY_ATTEMPTS = 2;

/**
 * Treat `.json` / `.schema.json` URIs as single-file fetches and everything
 * else as a directory-with-index. Only the parsed `pathname` is examined —
 * query strings and fragments are ignored — and the suffix match is strict
 * (must be at end of pathname, not contained mid-segment).
 *
 * @remarks
 * Heuristic: a pathname ending in `.json` is always treated as a single file.
 * If your CDN serves a directory under a path that happens to end in `.json`,
 * append a trailing `/` to the URL so the directory-with-index path is taken
 * instead.
 */
function isSingleFile(uri: string): boolean {
  let path: string;
  try {
    path = new URL(uri).pathname;
  } catch {
    return false;
  }
  return /(?:^|\/)[^/]+\.(?:schema\.json|json)$/.test(path);
}

/**
 * Read the per-request timeout (ms) from the env. Falls back to the default
 * when unset or not a positive integer.
 */
function httpTimeoutMsFromEnv(): number {
  const raw = process.env['LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS'];
  if (raw === undefined || raw === '') return DEFAULT_HTTP_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HTTP_TIMEOUT_MS;
}

/**
 * True when `LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS` is set to a truthy
 * value (`1`, `true`, `yes`, `on` — case-insensitive). Any other value
 * — or an unset variable — disables the override.
 */
function allowPrivateHostsFromEnv(): boolean {
  const raw = process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Reject any URI whose protocol is not exactly `https:`. The HTTP source is
 * registered solely for the `https` scheme; `http://` is refused explicitly
 * so a misconfiguration cannot silently fall through.
 */
function assertHttpsScheme(uri: string, scheme: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (cause) {
    throw new ContractsSourceError(
      `HTTP source received an unparseable URI: '${uri}'`,
      {scheme, uri},
      {cause},
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new ContractsSourceError(
      `Only https:// is supported; got ${parsed.protocol}`,
      {scheme: parsed.protocol.replace(/:$/, ''), uri},
    );
  }
}

/**
 * Reject hostnames that resolve (literally, by name) to loopback, link-local,
 * or RFC1918 private address space, plus `localhost`/`*.localhost`/`*.local`.
 * Set `allowPrivateHosts` to `true` to opt out — the engine reads that flag
 * from `LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS`.
 *
 * Note: only string-literal hostnames are inspected. DNS resolution and the
 * post-resolution address are not checked here; deployments that must defend
 * against DNS-rebinding should additionally pin DNS or run behind an
 * egress proxy.
 */
function assertHostAllowed(
  uri: string,
  scheme: string,
  allowPrivateHosts: boolean,
): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (cause) {
    throw new ContractsSourceError(
      `HTTP source received an unparseable URI: '${uri}'`,
      {scheme, uri},
      {cause},
    );
  }
  if (allowPrivateHosts) return;
  // Node's `URL` retains the brackets on IPv6 literals — strip them so the
  // `isIP` check below sees a bare address.
  const raw = parsed.hostname.toLowerCase();
  const hostname =
    raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (isBlockedHostname(hostname)) {
    throw new ContractsSourceError(
      `Refused to fetch from ${hostname} — RFC1918/loopback/link-local. ` +
        'Set LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1 to override.',
      {scheme, uri: redactUri(parsed)},
    );
  }
}

/**
 * True when `hostname` is a loopback, link-local, RFC1918 private, or
 * `localhost`-family name. Pure function — no I/O, no DNS.
 */
function isBlockedHostname(hostname: string): boolean {
  if (hostname === '') return true;
  if (hostname === 'localhost') return true;
  if (hostname.endsWith('.localhost')) return true;
  if (hostname.endsWith('.local')) return true;

  const ipKind = isIP(hostname);
  if (ipKind === 4) return isBlockedIPv4(hostname);
  if (ipKind === 6) return isBlockedIPv6(hostname);
  return false;
}

/**
 * Match IPv4 literals in `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`,
 * `169.254.0.0/16`, `192.168.0.0/16`, plus `0.0.0.0`.
 */
function isBlockedIPv4(addr: string): boolean {
  const parts = addr.split('.').map(p => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some(p => !Number.isFinite(p))) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  return false;
}

/**
 * Match IPv6 loopback (`::1`), unspecified (`::`), unique-local (`fc00::/7`),
 * and link-local (`fe80::/10`). Conservatively also blocks IPv4-mapped IPv6
 * (`::ffff:a.b.c.d`) when the embedded IPv4 is blocked.
 */
function isBlockedIPv6(addr: string): boolean {
  const norm = addr.toLowerCase();
  if (norm === '::' || norm === '::1') return true;
  if (/^fe[89ab][0-9a-f]?:/.test(norm)) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(norm)) return true; // fc00::/7
  // Dotted-decimal IPv4-mapped form: ::ffff:a.b.c.d
  const mappedDotted = /^::ffff:([0-9.]+)$/.exec(norm);
  if (
    mappedDotted &&
    mappedDotted[1] !== undefined &&
    isIP(mappedDotted[1]) === 4
  ) {
    return isBlockedIPv4(mappedDotted[1]);
  }
  // Hex IPv4-mapped form: ::ffff:HHHH:HHHH (two 16-bit groups encode the
  // 32-bit IPv4 address). e.g. ::ffff:7f00:1 is 127.0.0.1.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(norm);
  if (mappedHex && mappedHex[1] !== undefined && mappedHex[2] !== undefined) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedIPv4(dotted);
    }
  }
  return false;
}

/** Strip userinfo and query-string from a URL before embedding in errors. */
function redactUri(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * Parse a directory index file. Accepts an array of filenames or
 * `{path: string}` objects; rejects anything else with a structured error.
 */
function parseIndex(body: string, indexUrl: string, scheme: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new ContractsSourceError(
      `HTTP source index at '${indexUrl}' is not valid JSON`,
      {scheme, uri: indexUrl},
      {cause},
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ContractsSourceError(
      `HTTP source index at '${indexUrl}' must be a JSON array of filenames`,
      {scheme, uri: indexUrl},
    );
  }
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as {path?: unknown}).path === 'string'
    ) {
      out.push((entry as {path: string}).path);
    } else {
      throw new ContractsSourceError(
        `HTTP source index entry at '${indexUrl}' must be a string ` +
          'or an object with a string `path` field',
        {scheme, uri: indexUrl},
      );
    }
  }
  return out;
}

/**
 * Response + controller pair returned by {@link safeFetch}. The controller is
 * surfaced so the call site can abort the body-read phase under the same
 * timeout (see {@link readBodyText}).
 */
interface SafeFetchResult {
  readonly response: Response;
  readonly controller: AbortController;
}

/**
 * Wrap `fetch` so network errors surface as `ContractsSourceError` and every
 * request is bounded by a per-call timeout via `AbortController`. The
 * controller is returned alongside the {@link Response} so the body-read
 * phase can be guarded by a sibling timeout — see {@link readBodyText}.
 */
async function safeFetch(
  url: string,
  headers: Headers,
  scheme: string,
): Promise<SafeFetchResult> {
  const controller = new AbortController();
  const timeoutMs = httpTimeoutMsFromEnv();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // `.unref()` so a hung fetch's pending timer does not keep the event loop
  // alive past resolution — the `finally` block clears it on every path.
  timer.unref();
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    return {response, controller};
  } catch (cause) {
    const code =
      cause instanceof Error
        ? (cause as Error & {code?: unknown}).code
        : undefined;
    const aborted =
      cause instanceof Error &&
      (cause.name === 'AbortError' ||
        (typeof code === 'string' && code === 'ABORT_ERR'));
    if (aborted) {
      throw new ContractsSourceError(
        `HTTP request to '${url}' timed out after ${timeoutMs}ms`,
        {scheme, uri: url},
        {cause},
      );
    }
    throw new ContractsSourceError(
      `HTTP request to '${url}' failed before a response was received`,
      {scheme, uri: url},
      {cause},
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the response body as UTF-8 text under a fresh per-call timeout that
 * shares the connection-phase {@link AbortController}. A slow-drip server
 * that returns headers promptly but trickles bytes would otherwise bypass
 * the connection-phase timer. Reuses {@link httpTimeoutMsFromEnv} so the
 * body and connection share one budget knob.
 *
 * Throws a {@link ContractsSourceError} on body-read timeout or any other
 * read-side failure.
 */
async function readBodyText(
  fetched: SafeFetchResult,
  url: string,
  scheme: string,
): Promise<string> {
  const timeoutMs = httpTimeoutMsFromEnv();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bodyTimeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      fetched.controller.abort();
      reject(
        new ContractsSourceError(
          `HTTP body read from '${url}' timed out after ${timeoutMs}ms`,
          {scheme, uri: url},
        ),
      );
    }, timeoutMs);
    // Same rationale as `safeFetch` — keep a hung body-read timer from
    // pinning the event loop. The `finally` block clears it on every path.
    timer.unref();
  });
  try {
    return await Promise.race([fetched.response.text(), bodyTimeout]);
  } catch (cause) {
    if (cause instanceof ContractsSourceError) throw cause;
    throw new ContractsSourceError(
      `HTTP body read from '${url}' failed`,
      {scheme, uri: url},
      {cause},
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Throw a structured error for any non-success, non-304 status. */
function assertOk(res: Response, url: string, scheme: string): void {
  if (res.ok || res.status === 304) return;
  throw new ContractsSourceError(
    `HTTP fetch of '${url}' failed with status ${res.status} ${res.statusText}`,
    {scheme, uri: url},
  );
}

/**
 * Tiny FIFO semaphore — returns a function that wraps an async task so at
 * most `max` tasks run concurrently. Tasks queue up in submission order and
 * release the slot on settle (success or failure).
 */
function createSemaphore(
  max: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    if (active >= max) return;
    const run = queue.shift();
    if (run === undefined) return;
    active++;
    run();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}
