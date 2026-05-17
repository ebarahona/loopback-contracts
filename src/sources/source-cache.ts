import {mkdir, readFile, rename, rm, unlink, writeFile} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {join, resolve} from 'node:path';
import {ContractsSourceError} from '../helpers';
import type {SchemaSourceResult} from '../interfaces';

/**
 * Persisted shape of a per-URI cache manifest. Records the URI that produced
 * the cache, the timestamp of the last successful fetch, and the list of
 * `{path, content}` entries the source returned.
 *
 * @internal
 */
interface CacheManifest {
  readonly uri: string;
  readonly fetchedAt: string;
  readonly entries: ReadonlyArray<{path: string; content: string}>;
  /**
   * Source-supplied identity of the payload, when knowable. Examples:
   * a resolved git SHA for `git+` sources (helps debug "what did we
   * actually check out?" for branch-name refs that resolve to a moving
   * target). Never read back by the cache itself — present purely for
   * operator inspection.
   */
  readonly resolvedRef?: string;
}

/**
 * Persisted shape of the per-cache-dir ETag store — a single JSON file
 * mapping URI to last-seen `ETag` header value so the HTTP source can issue
 * conditional `If-None-Match` requests.
 *
 * @internal
 */
interface EtagFile {
  [uri: string]: string;
}

/**
 * Persisted shape of the per-cache-dir redirect store — a single JSON file
 * mapping descriptor URI to the final URL it last redirected to. Kept
 * separate from {@link EtagFile} so a real ETag value cannot collide with a
 * URL-shaped redirect target stored under the same key (a server is free to
 * emit any opaque string as an ETag, including one shaped like a URL).
 *
 * @internal
 */
interface RedirectFile {
  [uri: string]: string;
}

/**
 * Content-addressed cache for remote schema sources. Each URI hashes (sha256)
 * to a sub-directory under `<projectRoot>/.loopback/cache/schemas/`; the
 * directory holds a `manifest.json` (one per URI) plus two shared metadata
 * files one level up — `etags.json` (descriptor URI to last-seen `ETag`)
 * and `redirects.json` (descriptor URI to final post-redirect URL). The
 * two stores are intentionally split so a server emitting an opaque ETag
 * string that happens to look like a URL cannot collide with a stored
 * redirect target. The cache is shared infrastructure for the git and HTTP
 * sources — it is intentionally not itself a {@link SchemaSource}.
 *
 * Invalidation is explicit: callers ({@link GitSchemaSource},
 * {@link HttpSchemaSource}) compare the freshly fetched payload's identity
 * (git SHA, HTTP `ETag`) against the cached entry and call
 * {@link SchemaSourceCache.invalidate | invalidate} when a mismatch is
 * detected. The cache never expires entries on its own.
 *
 * All writes are atomic: payloads are written to a `.tmp.<rand>` sibling
 * then renamed onto the final path so a crash mid-write or a concurrent
 * writer cannot leave a half-written JSON file on disk. Read-modify-write
 * cycles against the shared `etags.json` file go through an in-process
 * mutex keyed by absolute file path so two parallel {@link setEtag} calls
 * cannot race and drop each other's entries.
 *
 * @internal
 */
export class SchemaSourceCache {
  /** Absolute filesystem root of the cache tree. */
  private readonly root: string;
  /** Path to the per-cache-tree shared `etags.json` file. */
  private readonly etagFilePath: string;
  /** Path to the per-cache-tree shared `redirects.json` file. */
  private readonly redirectFilePath: string;
  /**
   * In-process mutex registry keyed by absolute file path. Each value is the
   * tail of a promise chain — `withLock` awaits the current tail before
   * running its critical section, then publishes its own tail for the next
   * caller. The mutex is process-local and does *not* protect against
   * concurrent writers in separate processes.
   */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(projectRoot: string) {
    this.root = resolve(projectRoot, '.loopback', 'cache', 'schemas');
    this.etagFilePath = join(this.root, 'etags.json');
    this.redirectFilePath = join(this.root, 'redirects.json');
  }

  /**
   * Absolute path to the per-URI cache directory. The directory is *not*
   * created by this method — callers create it lazily on the first
   * {@link write} call.
   */
  cacheDir(uri: string): string {
    const digest = createHash('sha256').update(uri).digest('hex');
    return join(this.root, digest);
  }

  /**
   * Read the cached entries for a URI, or `undefined` when no manifest exists
   * yet or cannot be parsed as JSON. Manifests whose JSON parses but whose
   * shape is structurally invalid (wrong `uri`, missing/non-array `entries`,
   * or malformed entry objects) raise a {@link ContractsSourceError} so a
   * corrupted-but-syntactically-valid cache cannot silently feed bad data
   * downstream.
   */
  async read(uri: string): Promise<SchemaSourceResult | undefined> {
    const manifestPath = join(this.cacheDir(uri), 'manifest.json');
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!isCacheManifestShape(parsed) || parsed.uri !== uri) {
      throw new ContractsSourceError(
        `cache manifest at ${manifestPath} is structurally invalid`,
        {scheme: 'n/a', uri},
      );
    }
    return parsed.entries.map(e => ({
      source: uri,
      path: e.path,
      content: e.content,
    }));
  }

  /**
   * Write a fresh manifest for a URI. Creates the per-URI cache directory if
   * it does not already exist. The manifest is written atomically via a
   * `.tmp.<rand>` sibling + `rename`.
   *
   * Sources may pass an optional `meta.resolvedRef` (e.g. a git SHA) that
   * is persisted alongside `entries` for operator inspection — the cache
   * does not read it back.
   *
   * @remarks Current single-URI cache model — the `source` field on
   * {@link SchemaSourceResult} entries is reconstructed from `uri` on read;
   * do not write aggregated multi-source results without persisting the
   * `source` field on each entry.
   */
  async write(
    uri: string,
    result: SchemaSourceResult,
    meta?: {resolvedRef?: string},
  ): Promise<void> {
    const dir = this.cacheDir(uri);
    await mkdir(dir, {recursive: true});
    const manifest: CacheManifest = {
      uri,
      fetchedAt: new Date().toISOString(),
      entries: result.map(e => ({path: e.path, content: e.content})),
      ...(meta?.resolvedRef !== undefined
        ? {resolvedRef: meta.resolvedRef}
        : {}),
    };
    await this.writeFileAtomic(
      join(dir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
  }

  /**
   * Last-seen `ETag` header value for `uri`, or `undefined` when none has
   * been recorded yet.
   */
  async etag(uri: string): Promise<string | undefined> {
    const map = await this.readEtagFile();
    return map[uri];
  }

  /**
   * Record an `ETag` header value for `uri`. Creates the cache root and the
   * `etags.json` file lazily. The full read-modify-write cycle runs under
   * the per-path mutex so concurrent calls for different URIs do not race
   * and drop each other's entries.
   */
  async setEtag(uri: string, etag: string): Promise<void> {
    await this.withLock(this.etagFilePath, async () => {
      await mkdir(this.root, {recursive: true});
      const map = await this.readEtagFile();
      map[uri] = etag;
      await this.writeFileAtomic(
        this.etagFilePath,
        JSON.stringify(map, null, 2),
      );
    });
  }

  /**
   * Last-seen final URL that `uri` redirected to, or `undefined` when no
   * redirect has been observed yet. Stored separately from {@link etag} so a
   * server ETag value that happens to be URL-shaped cannot collide with a
   * stored redirect target.
   */
  async redirect(uri: string): Promise<string | undefined> {
    const map = await this.readRedirectFile();
    return map[uri];
  }

  /**
   * Record the final URL `target` that `uri` was last redirected to. Creates
   * the cache root and `redirects.json` lazily and serializes against the
   * per-path mutex like {@link setEtag}.
   */
  async setRedirect(uri: string, target: string): Promise<void> {
    await this.withLock(this.redirectFilePath, async () => {
      await mkdir(this.root, {recursive: true});
      const map = await this.readRedirectFile();
      map[uri] = target;
      await this.writeFileAtomic(
        this.redirectFilePath,
        JSON.stringify(map, null, 2),
      );
    });
  }

  /**
   * Remove the per-URI cache directory and drop the URI's ETag and redirect
   * entries, if any. Safe to call when the cache directory does not exist.
   * The two metadata-file mutations each run under their respective file's
   * mutex.
   */
  async invalidate(uri: string): Promise<void> {
    await rm(this.cacheDir(uri), {recursive: true, force: true});
    await this.withLock(this.etagFilePath, async () => {
      const map = await this.readEtagFile();
      if (uri in map) {
        delete map[uri];
        await this.writeFileAtomic(
          this.etagFilePath,
          JSON.stringify(map, null, 2),
        );
      }
    });
    await this.withLock(this.redirectFilePath, async () => {
      const map = await this.readRedirectFile();
      if (uri in map) {
        delete map[uri];
        await this.writeFileAtomic(
          this.redirectFilePath,
          JSON.stringify(map, null, 2),
        );
      }
    });
  }

  /**
   * Internal: load the shared `etags.json` map, defaulting to `{}` only when
   * the file does not exist. Permission errors, I/O errors, and malformed
   * JSON are surfaced as a {@link ContractsSourceError} so the caller can
   * decide whether to abort the build or proceed with a degraded cache.
   *
   * @remarks
   * Asymmetry with {@link read}: a structurally valid JSON document whose
   * top-level value is not a plain object (e.g., an array, a number, or a
   * string) is treated as an empty map rather than raising. ETags are
   * cache-only metadata — losing one costs at most one redundant `200`
   * response on the next fetch, whereas losing manifest entries would feed
   * downstream consumers stale data. The {@link read} path therefore throws
   * on shape violations; this path tolerates them.
   */
  private async readEtagFile(): Promise<EtagFile> {
    let raw: string;
    try {
      raw = await readFile(this.etagFilePath, 'utf8');
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === 'ENOENT') return {};
      throw new ContractsSourceError(
        `failed to read etag cache file at ${this.etagFilePath}`,
        {scheme: 'n/a', uri: this.etagFilePath},
        {cause: err},
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ContractsSourceError(
        `failed to parse etag cache file at ${this.etagFilePath}`,
        {scheme: 'n/a', uri: this.etagFilePath},
        {cause: err},
      );
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as EtagFile;
    }
    return {};
  }

  /**
   * Internal: load the shared `redirects.json` map, defaulting to `{}` only
   * when the file does not exist. Shares the same documentation asymmetry
   * as {@link readEtagFile} — redirects are cache-only metadata and losing
   * one costs at most one redundant follow on the next fetch.
   */
  private async readRedirectFile(): Promise<RedirectFile> {
    let raw: string;
    try {
      raw = await readFile(this.redirectFilePath, 'utf8');
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === 'ENOENT') return {};
      throw new ContractsSourceError(
        `failed to read redirect cache file at ${this.redirectFilePath}`,
        {scheme: 'n/a', uri: this.redirectFilePath},
        {cause: err},
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ContractsSourceError(
        `failed to parse redirect cache file at ${this.redirectFilePath}`,
        {scheme: 'n/a', uri: this.redirectFilePath},
        {cause: err},
      );
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as RedirectFile;
    }
    return {};
  }

  /**
   * Internal: atomic file write. Writes the payload to a `.tmp.<rand>`
   * sibling of `finalPath`, then `rename`s it onto `finalPath`. On rename
   * failure the temp file is best-effort unlinked and the original error is
   * re-thrown so the caller sees the underlying I/O failure.
   */
  private async writeFileAtomic(
    finalPath: string,
    data: string,
  ): Promise<void> {
    const tmpPath = `${finalPath}.tmp.${randomBytes(8).toString('hex')}`;
    await writeFile(tmpPath, data, 'utf8');
    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Internal: serialize `fn` against every other caller using the same
   * `path`. Each call appends to a promise chain stored in {@link locks};
   * the entry is garbage-collected when no caller has chained behind us so
   * the map cannot grow unbounded across the process lifetime.
   */
  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => (release = r));
    const chained = prev.then(() => next);
    this.locks.set(path, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(path) === chained) this.locks.delete(path);
    }
  }
}

/**
 * Narrow `unknown` to {@link NodeJS.ErrnoException} so callers can branch on
 * `err.code` without resorting to `any`.
 */
function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

/**
 * Manual structural check for the {@link CacheManifest} shape. Verifies the
 * top-level `uri` is a string and `entries` is an array of
 * `{path: string, content: string}` objects. We deliberately avoid Ajv here — the cache
 * manifest is internal and the schema is two fields.
 */
function isCacheManifestShape(value: unknown): value is CacheManifest {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as {
    uri?: unknown;
    entries?: unknown;
    resolvedRef?: unknown;
  };
  if (typeof candidate.uri !== 'string') return false;
  if (!Array.isArray(candidate.entries)) return false;
  if (
    candidate.resolvedRef !== undefined &&
    typeof candidate.resolvedRef !== 'string'
  ) {
    return false;
  }
  for (const entry of candidate.entries) {
    if (entry === null || typeof entry !== 'object') return false;
    const e = entry as {path?: unknown; content?: unknown};
    if (typeof e.path !== 'string') return false;
    if (typeof e.content !== 'string') return false;
  }
  return true;
}
