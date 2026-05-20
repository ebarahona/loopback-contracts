import {BindingScope, inject, injectable} from '@loopback/core';
import {lookup as dnsLookupCb} from 'node:dns';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Agent, fetch as undiciFetch, type Dispatcher} from 'undici';
import {ContractsSourceError} from '../helpers';
import type {SchemaSource, SchemaSourceResult} from '../interfaces';
import {ContractsBindings, SOURCE_TAG} from '../keys';
import {ContractsEngineBindings} from '../engine/tokens';
import type {LoopbackConfigJson} from '../types';
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
 * internal services.
 *
 * Every guard is configurable from three sources, in precedence order:
 * `loopback.config.json` `security.http.*` (bound under
 * {@link ContractsBindings.CONFIG}) wins over the matching
 * `LOOPBACK_CONTRACTS_*` env var, which wins over the built-in default.
 * See {@link HttpSecurityOptions} for the resolved shape and
 * {@link resolveHttpSecurity} for the precedence ladder.
 *
 * Every request is bounded by a per-call timeout (default 30000ms) and the
 * directory listing fan-out is capped at 8 concurrent requests via an
 * in-process semaphore.
 *
 * Redirects are followed manually via {@link followRedirects} (capped at
 * the resolved `maxRedirects`); each hop is re-validated against
 * {@link assertHostAllowed} **before** the next request lands, closing the
 * SSRF window where `redirect: 'follow'` would silently hit a private
 * destination (e.g., `169.254.169.254`) reached via a public-host redirect.
 * The ETag cache is keyed by the final response URL — and the
 * original-to-final URL mapping is persisted — so a `301` does not cause
 * repeated re-fetches of the redirected resource.
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
    @inject(ContractsEngineBindings.PROJECT_ROOT_TAG, {optional: true})
    private readonly projectRoot: string = process.cwd(),
    // Optional so test harnesses that wire the source directly (without
    // binding a full `loopback.config.json`) keep working. When absent,
    // every back-compat default applies — env-var fallbacks remain in
    // force and no allowlist is enforced.
    @inject(ContractsBindings.CONFIG, {optional: true})
    private readonly config?: LoopbackConfigJson,
    // Optional dispatcher override. Tests inject an undici `MockAgent` here
    // to intercept fetches by URL pattern; when absent the source builds a
    // DNS-pinning {@link Agent} per-fetch via {@link buildPinnedDispatcher}.
    // Production callers should never set this — the per-call pinned
    // dispatcher is the load-bearing safety net for the DNS-rebinding /
    // TOCTOU window described on {@link assertResolvedIpAllowed}.
    private readonly dispatcherOverride?: Dispatcher,
  ) {
    this.cache = new SchemaSourceCache(this.projectRoot);
  }

  /**
   * Resolve `uri` to a single schema file or a directory listing and return
   * every fetched file's contents.
   *
   * @throws ContractsSourceError On non-2xx responses, malformed index files,
   *   network errors, non-`https://` protocols, blocked private hosts, or
   *   a hostname not present in `security.http.allowedHosts` when that
   *   allowlist is set.
   */
  async fetch(uri: string): Promise<SchemaSourceResult> {
    assertHttpsScheme(uri, this.scheme);
    const options = this.resolveHttpSecurity();
    assertHostAllowed(uri, this.scheme, options);
    await assertResolvedIpAllowed(uri, this.scheme, options);
    const {dispatcher, owned} = this.dispatcherFor(options);
    try {
      if (isSingleFile(uri)) {
        return await this.fetchSingle(uri, options, dispatcher);
      }
      return await this.fetchDirectory(uri, options, dispatcher);
    } finally {
      // Only close the dispatcher when WE created it — when the caller
      // injected a test-only `dispatcherOverride` (e.g., a `MockAgent`),
      // the caller owns the lifecycle and closing here would break the
      // next assertion in the same test file. Long-lived `lb-contracts
      // gen --watch` processes would otherwise accumulate one connection
      // pool per fetch since the per-fetch pinned {@link Agent} is never
      // re-used across calls.
      if (owned) {
        try {
          await dispatcher.close();
        } catch {
          // Cleanup is best-effort — a dispatcher that fails to close
          // cleanly (already closed, mid-shutdown, etc.) must not mask
          // the success/failure of the fetch itself.
        }
      }
    }
  }

  /**
   * Resolve the {@link Dispatcher} that backs every `fetch` issued during
   * this call AND the ownership flag the caller uses to decide whether to
   * close it. When a test-only `dispatcherOverride` was injected (e.g., a
   * `MockAgent`), it wins and `owned` is `false` — the test owns the
   * lifecycle. Otherwise a freshly-built DNS-pinning {@link Agent} is
   * returned with `owned: true` so the lookup hook closes the connect-time
   * TOCTOU window described on {@link assertResolvedIpAllowed} AND the
   * connection pool is released after the call.
   *
   * @internal
   */
  private dispatcherFor(options: HttpSecurityOptions): {
    dispatcher: Dispatcher;
    owned: boolean;
  } {
    if (this.dispatcherOverride !== undefined) {
      return {dispatcher: this.dispatcherOverride, owned: false};
    }
    return {dispatcher: buildPinnedDispatcher(options), owned: true};
  }

  /**
   * Build the fully-resolved HTTP security options for this run. Precedence
   * ladder (highest first):
   *
   *   1. `loopback.config.json` `security.http.<field>` — explicit per-project
   *      setting under {@link ContractsBindings.CONFIG}.
   *   2. `LOOPBACK_CONTRACTS_<FIELD>` env var — operator override at the
   *      shell, kept for back-compat with pre-config-block releases.
   *   3. Built-in default — sensible, hardened-by-default choice.
   *
   * Every field is returned fully resolved — callers never have to re-check
   * `undefined` — except {@link HttpSecurityOptions.allowedHosts}, which is
   * left `undefined` to encode "no allowlist; any public host permitted".
   */
  private resolveHttpSecurity(): HttpSecurityOptions {
    const http = this.config?.security?.http;
    return {
      timeoutMs: http?.timeoutMs ?? httpTimeoutMsFromEnv(),
      maxBodyBytes: http?.maxBodyBytes ?? maxBodyBytesFromEnv(),
      allowPrivateHosts: http?.allowPrivateHosts ?? allowPrivateHostsFromEnv(),
      verifyResolvedIps: http?.verifyResolvedIps ?? true,
      allowedHosts: http?.allowedHosts,
      allowRedirects: http?.allowRedirects ?? true,
      maxRedirects: http?.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      allowInsecureRedirects:
        http?.allowInsecureRedirects ?? allowInsecureRedirectsFromEnv(),
    };
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
    options: HttpSecurityOptions,
    dispatcher: Dispatcher,
    attempt = 0,
  ): Promise<SchemaSourceResult> {
    const requestUrl = (await this.cache.redirect(uri)) ?? uri;
    assertHostAllowed(requestUrl, this.scheme, options);
    await assertResolvedIpAllowed(requestUrl, this.scheme, options);
    const headers = new Headers();
    const previousEtag = await this.cache.etag(requestUrl);
    if (previousEtag !== undefined) headers.set('If-None-Match', previousEtag);

    const fetched = await followRedirects(
      requestUrl,
      headers,
      this.scheme,
      options,
      dispatcher,
    );
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
      return this.fetchSingle(uri, options, dispatcher, attempt + 1);
    }
    assertOk(res, fetched.finalUrl, this.scheme);
    const content = await readBodyText(
      fetched,
      fetched.finalUrl,
      this.scheme,
      options,
    );
    const result: SchemaSourceResult = [{source: uri, path: uri, content}];
    await this.cache.write(uri, result);
    const newEtag = res.headers.get('etag');
    const finalUrl = fetched.finalUrl;
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
    options: HttpSecurityOptions,
    dispatcher: Dispatcher,
    attempt = 0,
  ): Promise<SchemaSourceResult> {
    const base = uri.replace(/\/+$/, '');
    const indexUrl = `${base}/index.json`;
    const indexRequestUrl = (await this.cache.redirect(indexUrl)) ?? indexUrl;
    assertHostAllowed(indexRequestUrl, this.scheme, options);
    await assertResolvedIpAllowed(indexRequestUrl, this.scheme, options);
    const headers = new Headers();
    const previousEtag = await this.cache.etag(indexRequestUrl);
    if (previousEtag !== undefined) headers.set('If-None-Match', previousEtag);

    const fetchedIndex = await followRedirects(
      indexRequestUrl,
      headers,
      this.scheme,
      options,
      dispatcher,
    );
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
      return this.fetchDirectory(uri, options, dispatcher, attempt + 1);
    }
    assertOk(indexRes, fetchedIndex.finalUrl, this.scheme);
    const indexBody = await readBodyText(
      fetchedIndex,
      fetchedIndex.finalUrl,
      this.scheme,
      options,
    );
    const filenames = parseIndex(indexBody, fetchedIndex.finalUrl, this.scheme);

    const limit = createSemaphore(MAX_CONCURRENT_FETCHES);
    const results: SchemaSourceResult = await Promise.all(
      filenames.map(name =>
        limit(async () => {
          const fileUrl = `${base}/${name}`;
          assertHostAllowed(fileUrl, this.scheme, options);
          await assertResolvedIpAllowed(fileUrl, this.scheme, options);
          const fetchedFile = await followRedirects(
            fileUrl,
            new Headers(),
            this.scheme,
            options,
            dispatcher,
          );
          assertOk(fetchedFile.response, fetchedFile.finalUrl, this.scheme);
          const content = await readBodyText(
            fetchedFile,
            fetchedFile.finalUrl,
            this.scheme,
            options,
          );
          return {source: uri, path: fetchedFile.finalUrl, content};
        }),
      ),
    );
    await this.cache.write(uri, results);
    const newEtag = indexRes.headers.get('etag');
    const finalUrl = fetchedIndex.finalUrl;
    if (finalUrl !== indexUrl) {
      await this.cache.setRedirect(indexUrl, finalUrl);
    }
    if (newEtag) await this.cache.setEtag(finalUrl, newEtag);
    return results;
  }
}

/**
 * Fully-resolved HTTP security posture for one `fetch` invocation. Built
 * once at the top of {@link HttpSchemaSource.fetch} and threaded through
 * every helper that could otherwise re-read env vars or hard-coded
 * defaults — keeping a single source of truth per call avoids the
 * "config drift between hops" bug class.
 *
 * Every field is fully resolved EXCEPT {@link allowedHosts}, which uses
 * `undefined` to encode "no allowlist; any public host permitted" — an
 * empty array would otherwise be ambiguous with "deny everything".
 *
 * @internal
 */
interface HttpSecurityOptions {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly allowPrivateHosts: boolean;
  readonly verifyResolvedIps: boolean;
  readonly allowedHosts: readonly string[] | undefined;
  readonly allowRedirects: boolean;
  readonly maxRedirects: number;
  /**
   * Permit a redirect chain to downgrade the transport from `https://` to
   * `http://`. Default `false` (safe). When `false`, any redirect target
   * whose scheme is not exactly `https:` is rejected before the next hop
   * fires — the source only ever accepts `https://` descriptors initially,
   * so a redirect to `http://` would silently drop TLS (loss of integrity,
   * MITM-able, no certificate validation). Opt in only when integrating
   * with a known legacy partner.
   */
  readonly allowInsecureRedirects: boolean;
}

/** Default per-request timeout in milliseconds, when env var is unset. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Default cap on response body size in bytes, when env var is unset. A 5 MB
 * cap is well above any realistic JSON Schema payload (the largest published
 * `@schemastore` files are \<500 KB) while still bounding the OOM risk from a
 * hostile or malfunctioning endpoint that streams gigabytes.
 *
 * Override via `LOOPBACK_CONTRACTS_HTTP_MAX_BYTES`.
 */
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Maximum number of in-flight `fetch` calls during a directory walk. */
const MAX_CONCURRENT_FETCHES = 8;

/**
 * Default cap on HTTP redirects when neither the config block nor a future
 * env var override sets one. Matches the undici/`fetch` default so that
 * opting into manual redirect handling does not silently shrink the
 * redirect budget observed by callers.
 */
const DEFAULT_MAX_REDIRECTS = 10;

/**
 * HTTP status codes that designate a redirect with a `Location` header
 * (RFC 7231 §6.4 / RFC 7538). 304 is intentionally excluded — it is handled
 * by the caller's ETag path, not the redirect loop.
 */
const REDIRECT_STATUSES = new Set<number>([301, 302, 303, 307, 308]);

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
 * when unset or not a positive integer. Used as the second tier of
 * {@link resolveHttpSecurity}'s precedence ladder (config \> env \> default).
 */
function httpTimeoutMsFromEnv(): number {
  const raw = process.env['LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS'];
  if (raw === undefined || raw === '') return DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * Read the response-body cap (bytes) from the env. Falls back to
 * {@link DEFAULT_MAX_BODY_BYTES} when unset, non-numeric, or non-positive.
 * Used as the second tier of {@link resolveHttpSecurity}'s precedence
 * ladder (config \> env \> default).
 *
 * @remarks
 * The cap exists to keep a hostile or malfunctioning endpoint from OOMing the
 * build by streaming gigabytes. It is enforced twice: a `Content-Length`
 * pre-check (cheap, refuses before any body bytes are read) and a streamed
 * byte-count tally (defends against missing/lying length headers).
 */
function maxBodyBytesFromEnv(): number {
  const raw = process.env['LOOPBACK_CONTRACTS_HTTP_MAX_BYTES'];
  if (raw === undefined || raw === '') return DEFAULT_MAX_BODY_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

/**
 * True when `LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS` is set to a truthy
 * value (`1`, `true`, `yes`, `on` — case-insensitive). Any other value
 * — or an unset variable — disables the override. Used as the second
 * tier of {@link resolveHttpSecurity}'s precedence ladder.
 */
function allowPrivateHostsFromEnv(): boolean {
  const raw = process.env['LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS'];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * True when `LOOPBACK_CONTRACTS_ALLOW_INSECURE_REDIRECTS` is set to a truthy
 * value (`1`, `true`, `yes`, `on` — case-insensitive). Any other value — or
 * an unset variable — keeps the default `false`. Used as the second tier of
 * {@link resolveHttpSecurity}'s precedence ladder for the redirect-downgrade
 * gate. Opting in lets a redirect chain step down from `https://` to
 * `http://`, losing TLS — only do so for trusted legacy partners.
 */
function allowInsecureRedirectsFromEnv(): boolean {
  const raw = process.env['LOOPBACK_CONTRACTS_ALLOW_INSECURE_REDIRECTS'];
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
 * When the resolved {@link HttpSecurityOptions.allowedHosts} allowlist is
 * non-empty, ALSO reject any hostname not present in the list — even if it
 * would otherwise pass the private-host gate.
 *
 * Set {@link HttpSecurityOptions.allowPrivateHosts} to `true` to opt out
 * of the RFC1918/loopback/link-local gate. The allowlist gate is
 * independent — opting in to private hosts does not bypass the
 * allowlist when one is configured.
 *
 * Note: only string-literal hostnames are inspected. DNS resolution and the
 * post-resolution address are checked by {@link assertResolvedIpAllowed};
 * deployments that must defend against DNS-rebinding should additionally
 * pin DNS or run behind an egress proxy.
 */
function assertHostAllowed(
  uri: string,
  scheme: string,
  options: HttpSecurityOptions,
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
  // Node's `URL` retains the brackets on IPv6 literals — strip them so the
  // `isIP` check below sees a bare address.
  const raw = parsed.hostname.toLowerCase();
  const hostname =
    raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (!options.allowPrivateHosts && isBlockedHostname(hostname)) {
    throw new ContractsSourceError(
      `Refused to fetch from ${hostname} — RFC1918/loopback/link-local. ` +
        'Set security.http.allowPrivateHosts=true (or ' +
        'LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1) to override.',
      {scheme, uri: redactUri(parsed)},
    );
  }
  // Allowlist gate. Independent of the private-host gate: an operator who
  // explicitly enumerates trusted partners should not have that surface
  // silently widened by `allowPrivateHosts`.
  if (options.allowedHosts !== undefined && options.allowedHosts.length > 0) {
    const port = parsed.port;
    const hostWithPort = port === '' ? hostname : `${hostname}:${port}`;
    const allowed = options.allowedHosts.some(entry => {
      const normalised = entry.trim().toLowerCase();
      if (normalised.includes(':')) {
        return normalised === hostWithPort;
      }
      return normalised === hostname;
    });
    if (!allowed) {
      throw new ContractsSourceError(
        `hostname ${hostname} not in security.http.allowedHosts allowlist ` +
          `[${options.allowedHosts.join(', ')}]`,
        {scheme, uri: redactUri(parsed)},
      );
    }
  }
}

/**
 * Resolve `uri`'s hostname via DNS and refuse the fetch when ANY resolved
 * address falls in a disallowed range (loopback, RFC1918, link-local, CGNAT,
 * unique-local IPv6, multicast, IPv4-mapped IPv6 of a blocked v4, etc.).
 *
 * Closes the DNS-rebinding bypass that the string-only
 * {@link assertHostAllowed} cannot defend against: a public-looking hostname
 * can resolve to `169.254.169.254` (cloud metadata), `127.0.0.1`, RFC1918
 * space, or IPv6 private/link-local. Called per-fetch and per-redirect-hop.
 *
 * @remarks
 * `lookup({all: true, verbatim: true})` returns every A and AAAA record so
 * dual-stack hosts are checked exhaustively — one bad address in the set is
 * enough to abort. `verbatim: true` preserves OS-resolver ordering rather
 * than re-sorting v4-before-v6, which keeps the test surface deterministic.
 *
 * IP literals in `hostname` short-circuit through {@link isBlockedHostname}'s
 * cousins without a DNS round trip — `dns.lookup` returns the literal as-is.
 *
 * Skipped entirely when {@link HttpSecurityOptions.allowPrivateHosts} is
 * `true` OR when {@link HttpSecurityOptions.verifyResolvedIps} is `false`.
 * Setting `verifyResolvedIps: false` opts out of this defence and accepts
 * the DNS-rebinding risk — only do so for trusted intranets where every
 * resolved IP is known good.
 *
 * **TOCTOU closure.** This preflight stays for early fail-fast UX (operator
 * gets a clear error before any connection attempt), but the load-bearing
 * defence against the connect-time TOCTOU / DNS-rebinding window is the
 * undici {@link Agent} built by {@link buildPinnedDispatcher}: its
 * `connect.lookup` hook runs the SAME private-IP checks INSIDE undici's
 * socket-establishment, so the address validated is the address dialed.
 * Preflight + connect-time DNS pin via undici dispatcher closes the
 * TOCTOU window.
 */
async function assertResolvedIpAllowed(
  uri: string,
  scheme: string,
  options: HttpSecurityOptions,
): Promise<void> {
  if (options.allowPrivateHosts) return;
  if (!options.verifyResolvedIps) return;
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
  const raw = parsed.hostname.toLowerCase();
  const hostname =
    raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (hostname === '') return; // assertHostAllowed already rejected it
  // Literal IPs round-trip through dns.lookup unchanged; we still call lookup
  // so the one code path enforces the rule against every address that would
  // actually be dialed.
  let addresses: ReadonlyArray<{address: string; family: number}>;
  try {
    addresses = await lookup(hostname, {all: true, verbatim: true});
  } catch (cause) {
    throw new ContractsSourceError(
      `DNS lookup for '${hostname}' failed`,
      {scheme, uri: redactUri(parsed)},
      {cause},
    );
  }
  for (const {address, family} of addresses) {
    const blocked =
      family === 4 ? isBlockedIPv4(address) : isBlockedIPv6(address);
    if (blocked) {
      throw new ContractsSourceError(
        `hostname ${hostname} resolved to private/link-local IP ${address}; ` +
          'refusing to fetch (set security.http.allowPrivateHosts=true or ' +
          'LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1 to opt in)',
        {scheme, uri: redactUri(parsed)},
      );
    }
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
 * Match IPv4 literals in the disallowed ranges:
 *
 *   - `0.0.0.0/8` (unspecified)
 *   - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC1918 private)
 *   - `127.0.0.0/8` (loopback)
 *   - `169.254.0.0/16` (link-local, includes the cloud-metadata endpoint
 *     `169.254.169.254`)
 *   - `100.64.0.0/10` (CGNAT — carrier-grade NAT space; a public-looking
 *     hostname pinned to a CGNAT IP should not be reachable from the build)
 *   - `224.0.0.0/4` (multicast)
 *   - `240.0.0.0/4` (reserved for future use, includes `255.255.255.255`
 *     broadcast)
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
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224 && a <= 239) return true; // multicast 224.0.0.0/4
  if (a >= 240) return true; // reserved 240.0.0.0/4 (incl. 255.255.255.255)
  return false;
}

/**
 * Match IPv6 loopback (`::1`), unspecified (`::`), unique-local (`fc00::/7`),
 * link-local (`fe80::/10`), and multicast (`ff00::/8`). Conservatively also
 * blocks IPv4-mapped IPv6 (`::ffff:a.b.c.d`) when the embedded IPv4 is
 * blocked.
 */
function isBlockedIPv6(addr: string): boolean {
  const norm = addr.toLowerCase();
  if (norm === '::' || norm === '::1') return true;
  if (/^fe[89ab][0-9a-f]?:/.test(norm)) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(norm)) return true; // fc00::/7
  if (/^ff[0-9a-f]{2}:/.test(norm)) return true; // ff00::/8 multicast
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

/**
 * True when `address` (a literal IP returned by a DNS lookup) falls in any
 * of the IPv4 or IPv6 ranges denied by {@link isBlockedIPv4} /
 * {@link isBlockedIPv6}. Centralises the address-classification rule so the
 * preflight {@link assertResolvedIpAllowed} and the connect-time lookup
 * hook in {@link buildPinnedDispatcher} apply the SAME predicate — drift
 * between the two tiers would re-open the TOCTOU window the dispatcher is
 * here to close.
 *
 * @internal
 */
function isBlockedResolvedAddress(address: string, family: number): boolean {
  if (family === 6) return isBlockedIPv6(address);
  // Anything not explicitly tagged IPv6 is treated as IPv4; `dns.lookup`
  // returns `family: 4` for v4 literals and `family: 6` for v6 literals, so
  // the default branch matches the v4 path naturally.
  return isBlockedIPv4(address);
}

/**
 * Build a DNS-pinning undici {@link Agent} whose `connect.lookup` hook runs
 * INSIDE undici's socket-establishment phase — so the IP undici dials is
 * the IP we just classified. Closes the connect-time TOCTOU window that
 * the string-only {@link assertHostAllowed} and the preflight-only
 * {@link assertResolvedIpAllowed} cannot defend against on their own (an
 * attacker controlling fast-changing DNS could rebind between preflight
 * and connect; this hook fires at connect time so there is no window).
 *
 * Honours the same `allowPrivateHosts` / `verifyResolvedIps` opt-outs as
 * the preflight: when either is set, the hook short-circuits to the plain
 * `dns.lookup` answer without applying the deny list, preserving the
 * intranet escape hatch.
 *
 * @internal
 */
function buildPinnedDispatcher(options: HttpSecurityOptions): Dispatcher {
  const enforce = !options.allowPrivateHosts && options.verifyResolvedIps;
  // Typed as `unknown` for the `lookup` slot because undici's exported
  // `BuildOptions` is the union of Node's TCP and TLS connect-opts, and
  // both surface `lookup` with overload-heavy signatures that fight a
  // single inline arrow. The shape we hand undici matches its runtime
  // expectation (drop-in for `dns.lookup`); a typed local alias would
  // be churnier than the targeted cast at the call site.
  const lookupHook = (
    hostname: string,
    lookupOpts: {family?: number; hints?: number; all?: boolean} | undefined,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void,
  ): void => {
    // Force the single-result callback shape — `all: true` would change the
    // callback signature to `(err, addresses[])`, breaking the deny check.
    const opts = {...(lookupOpts ?? {}), all: false as const};
    dnsLookupCb(hostname, opts, (err, address, family) => {
      if (err !== null && err !== undefined) {
        // Preserve the original DNS-failure signal so callers see the real
        // `ENOTFOUND` / `EAI_AGAIN` rather than a synthesised one.
        return callback(err, '', 0);
      }
      if (enforce && isBlockedResolvedAddress(address, family)) {
        const blockErr: NodeJS.ErrnoException = new Error(
          `hostname ${hostname} resolved to private/link-local IP ` +
            `${address} at connect time; refusing (set ` +
            'security.http.allowPrivateHosts=true or ' +
            'LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS=1 to opt in)',
        );
        blockErr.code = 'LB4_CONTRACTS_DNS_REBIND_BLOCKED';
        return callback(blockErr, '', 0);
      }
      callback(null, address, family);
    });
  };
  return new Agent({
    connect: {
      lookup: lookupHook as unknown as undefined,
    },
  });
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
 * timeout (see {@link readBodyText}). `finalUrl` is the URL of the request
 * that produced `response` — for a single-hop `safeFetch` call it equals
 * the input `url`; after {@link followRedirects} it reflects the last URL
 * the redirect loop validated and fetched.
 */
interface SafeFetchResult {
  readonly response: Response;
  readonly controller: AbortController;
  readonly finalUrl: string;
}

/**
 * Wrap `fetch` so network errors surface as `ContractsSourceError` and every
 * request is bounded by a per-call timeout via `AbortController`. The
 * controller is returned alongside the {@link Response} so the body-read
 * phase can be guarded by a sibling timeout — see {@link readBodyText}.
 *
 * @remarks
 * Issues exactly one hop with `redirect: 'manual'` so redirect handling can
 * be done in {@link followRedirects}, which re-runs {@link assertHostAllowed}
 * on every hop. Calling `fetch` with `redirect: 'follow'` would let undici
 * silently land on a private/link-local destination after a public-host
 * 30x — the very SSRF window this loader defends against. The loader only
 * ever issues GETs (schemas are immutable downloads), which keeps the
 * 307/308 method-preservation contract trivially satisfied; non-GET callers
 * would need to extend {@link followRedirects} accordingly.
 */
async function safeFetch(
  url: string,
  headers: Headers,
  scheme: string,
  timeoutMs: number,
  dispatcher: Dispatcher,
): Promise<SafeFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // `.unref()` so a hung fetch's pending timer does not keep the event loop
  // alive past resolution — the `finally` block clears it on every path.
  timer.unref();
  try {
    // `headers` is a WHATWG `Headers` instance — undici accepts it but
    // its types narrow to its own `HeadersInit`, so cast via `unknown` to
    // satisfy both bindings without copying the header pairs.
    const response = (await undiciFetch(url, {
      headers: headers as unknown as Record<string, string>,
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
    })) as unknown as Response;
    return {response, controller, finalUrl: url};
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
 * Issue {@link safeFetch} in a loop, manually following HTTP 30x responses
 * with `assertHostAllowed` re-validated on every hop. Caps the chain at
 * the resolved {@link HttpSecurityOptions.maxRedirects}.
 *
 * Defends against the SSRF window where a public host returns a redirect
 * (e.g., 302 → `http://169.254.169.254/...`) and `fetch`'s built-in
 * `redirect: 'follow'` lands on the private destination before the caller
 * can inspect `Response.url`. Here, every redirect target is parsed,
 * scheme-checked (`http:`/`https:` only — `javascript:`, `data:`, `file:`,
 * etc. are rejected), host-checked via {@link assertHostAllowed}, and only
 * then re-fetched.
 *
 * When {@link HttpSecurityOptions.allowRedirects} is `false`, ANY 3xx with
 * a `Location` header is refused before the next hop fires — the operator
 * has explicitly opted out of cross-origin redirect handling.
 *
 * Assumes the request method is `GET` — schemas are immutable downloads and
 * the loader only ever fetches them. Non-2xx 30x responses on a non-GET
 * request would need a method-preserving (307/308) vs method-degrading
 * (301/302/303) split; if you extend this loader to issue POSTs, add that
 * branch and throw on the degrading codes.
 *
 * Returns the first non-3xx response together with the URL that produced it,
 * so caller-side ETag/redirect bookkeeping can key on the final URL.
 */
async function followRedirects(
  url: string,
  headers: Headers,
  scheme: string,
  options: HttpSecurityOptions,
  dispatcher: Dispatcher,
): Promise<SafeFetchResult> {
  let currentUrl = url;
  let hops = 0;
  for (;;) {
    const fetched = await safeFetch(
      currentUrl,
      headers,
      scheme,
      options.timeoutMs,
      dispatcher,
    );
    const res = fetched.response;
    if (!REDIRECT_STATUSES.has(res.status)) {
      return {...fetched, finalUrl: currentUrl};
    }
    if (!options.allowRedirects) {
      throw new ContractsSourceError(
        `HTTP redirect (${res.status}) from '${currentUrl}' received but ` +
          'security.http.allowRedirects = false',
        {scheme, uri: currentUrl},
      );
    }
    const location = res.headers.get('location');
    if (location === null || location === '') {
      throw new ContractsSourceError(
        `HTTP redirect (${res.status}) from '${currentUrl}' without Location header`,
        {scheme, uri: currentUrl},
      );
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch (cause) {
      throw new ContractsSourceError(
        `HTTP redirect from '${currentUrl}' has unparseable Location '${location}'`,
        {scheme, uri: currentUrl},
        {cause},
      );
    }
    if (nextUrl.protocol !== 'https:') {
      // A non-https target is either an unsupported scheme entirely
      // (`javascript:`, `data:`, `file:`, etc.) OR — the load-bearing case
      // — `http:`, which silently strips TLS off a chain that started at
      // `https://`. The opt-in is scoped to the http downgrade only;
      // exotic schemes are always refused regardless of the flag.
      if (nextUrl.protocol === 'http:' && options.allowInsecureRedirects) {
        // Operator explicitly accepted the downgrade — fall through to
        // the host/IP checks below and let the next hop fire.
      } else if (nextUrl.protocol === 'http:') {
        throw new ContractsSourceError(
          `HTTP redirect from '${currentUrl}' to '${nextUrl.toString()}' ` +
            'downgrades the transport to HTTP — refusing for transport ' +
            'integrity. Configure security.http.allowInsecureRedirects=true ' +
            'to opt in (NOT recommended).',
          {scheme, uri: currentUrl},
        );
      } else {
        throw new ContractsSourceError(
          `HTTP redirect from '${currentUrl}' targets disallowed scheme ` +
            `'${nextUrl.protocol}' — only https: is followed`,
          {scheme, uri: currentUrl},
        );
      }
    }
    assertHostAllowed(nextUrl.toString(), scheme, options);
    await assertResolvedIpAllowed(nextUrl.toString(), scheme, options);
    hops++;
    if (hops > options.maxRedirects) {
      throw new ContractsSourceError(
        `HTTP redirect chain from '${url}' exceeded cap (${options.maxRedirects} hops)`,
        {scheme, uri: url},
      );
    }
    currentUrl = nextUrl.toString();
  }
}

/**
 * Read the response body as UTF-8 text under a fresh per-call timeout that
 * shares the connection-phase {@link AbortController}, AND enforce a hard cap
 * on body size to defend against an OOM-via-giant-payload DoS.
 *
 * Two-layer cap:
 *
 *   1. **`Content-Length` pre-check.** If the header is present and exceeds
 *      the resolved `maxBodyBytes`, throw immediately — no body bytes are
 *      read.
 *   2. **Streamed byte tally.** Headers can be missing or lie about the
 *      length. Read the body chunk-by-chunk via `response.body.getReader()`,
 *      tracking `bytesRead` after each chunk. If the running total exceeds
 *      the cap, abort the request controller (releases the socket) and
 *      throw.
 *
 * On a clean completion, concatenate the accumulated `Uint8Array` chunks
 * into one buffer and decode as UTF-8. The buffer is allocated once at the
 * end — interim chunks live in a small array — so peak memory is roughly
 * `2 × bytesRead` worst case, still bounded by the cap.
 *
 * @remarks
 * **Slow-drip protection.** The body-read timer aborts the same controller
 * the connection phase used, so a server that returns headers promptly but
 * trickles bytes can no longer outlive the resolved `timeoutMs`.
 *
 * **Concurrent fetches under abort.** Each {@link safeFetch} call owns its
 * own `AbortController`; aborting one (whether for timeout or overrun) does
 * not cancel siblings. In a directory walk, a single oversize file rejects
 * the `Promise.all` immediately but in-flight peers continue downloading
 * until they settle. Their byte counts are still bounded by the same cap.
 *
 * Throws a {@link ContractsSourceError} on overrun, body-read timeout, or
 * any other read-side failure.
 */
async function readBodyText(
  fetched: SafeFetchResult,
  url: string,
  scheme: string,
  options: HttpSecurityOptions,
): Promise<string> {
  const cap = options.maxBodyBytes;
  const declared = fetched.response.headers.get('content-length');
  if (declared !== null && declared !== '') {
    const declaredN = Number.parseInt(declared, 10);
    if (Number.isFinite(declaredN) && declaredN > cap) {
      // Refuse before reading a single byte — the cheap path.
      fetched.controller.abort();
      throw new ContractsSourceError(
        `HTTP body from '${url}' exceeds max bytes ` +
          `(header reports ${declaredN}, cap ${cap})`,
        {scheme, uri: url},
      );
    }
  }

  const timeoutMs = options.timeoutMs;
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
    return await Promise.race([
      readBodyStreamed(fetched, url, scheme, cap),
      bodyTimeout,
    ]);
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

/**
 * Drain `fetched.response.body` chunk-by-chunk, tallying bytes against `cap`
 * and aborting mid-stream if the running total exceeds it. Returns the
 * concatenated UTF-8 decoding of every accumulated chunk on clean completion.
 *
 * Split out from {@link readBodyText} so the body-timeout `Promise.race` has
 * a single clean awaitable to compete with.
 */
async function readBodyStreamed(
  fetched: SafeFetchResult,
  url: string,
  scheme: string,
  cap: number,
): Promise<string> {
  const body = fetched.response.body;
  // A null body (e.g., HEAD-style empty) is treated as the empty string.
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    bytesRead += value.byteLength;
    if (bytesRead > cap) {
      // Release the socket immediately — we will not consume the rest.
      fetched.controller.abort();
      try {
        await reader.cancel();
      } catch {
        // Cancellation best-effort; the abort already detached the socket.
      }
      throw new ContractsSourceError(
        `HTTP body from '${url}' exceeds max bytes ` +
          `(streamed ${bytesRead} bytes, cap ${cap})`,
        {scheme, uri: url},
      );
    }
    chunks.push(value);
  }
  // Single allocation at the end so peak memory stays bounded by the cap.
  const combined = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(combined);
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
