import {BindingScope, inject, injectable} from '@loopback/core';
import {spawn} from 'node:child_process';
import {mkdir, readFile, rm} from 'node:fs/promises';
import createDebug from 'debug';
import {
  collectSchemaFiles,
  ContractsSourceError,
  redactUrl,
  redactUrlsInText,
} from '../helpers';
import type {SchemaSource, SchemaSourceResult} from '../interfaces';
import {SOURCE_TAG} from '../keys';
import {SchemaSourceCache} from './source-cache';

const debug = createDebug('loopback:contracts:git-source');

/** Default per-git-invocation timeout in milliseconds. */
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/**
 * Resolve the per-git-invocation timeout from the environment, falling back
 * to {@link DEFAULT_GIT_TIMEOUT_MS}. A non-positive or unparseable override
 * is ignored so the env var cannot disable the safeguard entirely.
 */
function resolveGitTimeoutMs(): number {
  const raw = process.env['LOOPBACK_CONTRACTS_GIT_TIMEOUT_MS'];
  if (raw === undefined || raw === '') return DEFAULT_GIT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GIT_TIMEOUT_MS;
  return parsed;
}

/**
 * Built-in {@link SchemaSource} for `git+https://` and `git+ssh://`
 * descriptors. The class registers under the single `git+` scheme — the
 * source-resolver registry folds both transports to that one prefix.
 *
 * The fetch strategy is content-addressed: each `git+<transport>://...#<ref>`
 * URI hashes to a cache directory under
 * `<projectRoot>/.loopback/cache/schemas/<sha256-of-redacted-uri>/`. Because
 * the ref is part of the URI, bumping the pin changes the hash and forces a
 * fresh clone — the previous pin's cache is left intact for downgrades. The
 * cache key is computed from the credential-redacted URI so the on-disk path
 * never embeds `user:pass@host` secrets. The cache is treated as
 * authoritative when present and never expires on its own; delete
 * `.loopback/cache/schemas/` to force a re-fetch.
 *
 * Authentication is delegated to git itself — we do not read tokens from
 * the environment. SSH URIs use the user's `~/.ssh/` keys; HTTPS URIs use
 * the user's credential helper or `GIT_ASKPASS`. The child process inherits
 * the parent environment, so CI tokens injected via `GIT_ASKPASS`,
 * `GIT_TERMINAL_PROMPT=0`, or `~/.netrc` work without special handling.
 *
 * Every git invocation runs under an `AbortController` + `setTimeout` guard
 * (default 60s, overridable via `LOOPBACK_CONTRACTS_GIT_TIMEOUT_MS`) so a
 * slow or unreachable host cannot wedge the engine indefinitely.
 *
 * Returns each file as-is; bundled schemas (with `$defs`) are split by the
 * pipeline downstream.
 *
 * @internal
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[SOURCE_TAG]: SOURCE_TAG, scheme: 'git+'},
})
export class GitSchemaSource implements SchemaSource {
  readonly scheme = 'git+';
  private readonly cache: SchemaSourceCache;

  constructor(
    @inject('platform.contracts.project-root', {optional: true})
    private readonly projectRoot: string = process.cwd(),
  ) {
    this.cache = new SchemaSourceCache(this.projectRoot);
  }

  /**
   * Clone the pinned git ref (using the cache when warm) and read every
   * `*.schema.json` file from the resulting working tree.
   *
   * @remarks
   * **Ref immutability assumption.** The cache is treated as authoritative
   * once warm. SHA-shaped refs (`/^[0-9a-f]{7,40}$/i`) and SemVer tags
   * (`vMAJOR.MINOR.PATCH`) are genuinely immutable. Branch names (`main`,
   * `master`, `HEAD`) and non-SemVer tags are mutable upstream but are
   * still cached at v1.0 — auto-refetching would defeat the cache for a
   * common case (pin-by-branch in dev). A `debug()` line is emitted when
   * such a ref is served from cache so operators can spot stale checkouts.
   *
   * To force a refresh, delete the per-URI cache directory under
   * `<projectRoot>/.loopback/cache/schemas/` (a `--no-cache` CLI flag is on
   * the roadmap but not yet wired).
   *
   * @throws ContractsSourceError On URI parse failure, clone failure (auth /
   *   404 / network / timeout), or when the cloned tree cannot be read.
   */
  async fetch(uri: string): Promise<SchemaSourceResult> {
    const safeUri = redactUrl(uri);
    const {repoUrl, ref} = parseGitUri(uri, this.scheme, safeUri);
    const cached = await this.cache.read(safeUri);
    if (cached !== undefined) {
      if (!isImmutableRef(ref)) {
        debug(
          'serving mutable git ref %s from cache for %s; delete %s to refresh',
          ref,
          safeUri,
          this.cache.cacheDir(safeUri),
        );
      }
      return cached;
    }

    const dir = this.cache.cacheDir(safeUri);
    // The cache dir may exist from a previous failed clone; wipe and recreate
    // so `git clone` lands in an empty directory.
    await rm(dir, {recursive: true, force: true});
    await mkdir(dir, {recursive: true});

    await cloneAtRef(repoUrl, ref, dir, safeUri, this.scheme);
    const resolvedRef = await resolveHeadSha(dir);

    const files = await collectSchemaFiles(dir);
    const results = await Promise.all(
      files.map(async absPath => {
        const content = await readFile(absPath, 'utf8');
        return {source: safeUri, path: absPath, content};
      }),
    );
    await this.cache.write(
      safeUri,
      results,
      resolvedRef !== undefined ? {resolvedRef} : undefined,
    );
    return results;
  }
}

/**
 * Best-effort: ask `git rev-parse HEAD` what the just-checked-out tree
 * actually resolves to. Used for the `resolvedRef` manifest field so a
 * branch-name pin records the concrete SHA. Returns `undefined` on any
 * failure — this is purely diagnostic, never load-bearing.
 */
async function resolveHeadSha(repoDir: string): Promise<string | undefined> {
  const res = await runGit(['rev-parse', 'HEAD'], repoDir);
  if (res.code !== 0) return undefined;
  const trimmed = res.stdout.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Heuristic: is `ref` genuinely immutable upstream? Matches SHA-shaped refs
 * (7–40 lowercase hex chars) and `vMAJOR.MINOR.PATCH` SemVer tags. Branch
 * names and non-SemVer tags are treated as mutable.
 */
function isImmutableRef(ref: string): boolean {
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return true;
  if (/^v\d+\.\d+\.\d+$/.test(ref)) return true;
  return false;
}

/**
 * Split a `git+<transport>://<url>#<ref>` descriptor into the bare repo URL
 * (with the `git+` prefix stripped) and the ref. `safeUri` is the redacted
 * form used in any error message so credentials never escape the process.
 */
function parseGitUri(
  uri: string,
  scheme: string,
  safeUri: string,
): {repoUrl: string; ref: string} {
  const trimmed = uri.trim();
  if (!/^git\+/i.test(trimmed)) {
    throw new ContractsSourceError(
      `Malformed git source URI '${safeUri}'; expected 'git+https://' or 'git+ssh://' prefix`,
      {scheme, uri: safeUri},
    );
  }
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx === -1) {
    throw new ContractsSourceError(
      `Git source URI '${safeUri}' is missing a '#<ref>' pin; ` +
        'pin a branch, tag, or commit SHA for reproducible builds',
      {scheme, uri: safeUri},
    );
  }
  const repoUrl = trimmed.slice('git+'.length, hashIdx);
  const ref = trimmed.slice(hashIdx + 1);
  if (!repoUrl || !ref) {
    throw new ContractsSourceError(
      `Git source URI '${safeUri}' is malformed; expected 'git+<transport>://<url>#<ref>'`,
      {scheme, uri: safeUri},
    );
  }
  return {repoUrl, ref};
}

/**
 * Shallow-clone `repoUrl` at `ref` into `dest`. Tries `--branch` first
 * (works for branches and tags); on failure, falls back to `init` + `fetch`
 * + `checkout` so arbitrary commit SHAs and non-default refs still resolve.
 */
async function cloneAtRef(
  repoUrl: string,
  ref: string,
  dest: string,
  safeUri: string,
  scheme: string,
): Promise<void> {
  const branchAttempt = await runGit(
    ['clone', '--depth', '1', '--branch', ref, repoUrl, dest],
    process.cwd(),
  );
  if (branchAttempt.code === 0) return;

  // Wipe and retry via fetch — `--branch` failed because `ref` is a SHA, a
  // tag inside a nested namespace, or the remote rejected the shallow op.
  await rm(dest, {recursive: true, force: true});
  await mkdir(dest, {recursive: true});
  const initRes = await runGit(['init', '--quiet'], dest);
  if (initRes.code !== 0) {
    throw wrapGitFailure(initRes.stderr, safeUri, scheme, branchAttempt.stderr);
  }
  const remoteRes = await runGit(['remote', 'add', 'origin', repoUrl], dest);
  if (remoteRes.code !== 0) {
    throw wrapGitFailure(
      remoteRes.stderr,
      safeUri,
      scheme,
      branchAttempt.stderr,
    );
  }
  const fetchRes = await runGit(['fetch', '--depth', '1', 'origin', ref], dest);
  if (fetchRes.code !== 0) {
    throw wrapGitFailure(
      fetchRes.stderr,
      safeUri,
      scheme,
      branchAttempt.stderr,
    );
  }
  const checkoutRes = await runGit(['checkout', 'FETCH_HEAD'], dest);
  if (checkoutRes.code !== 0) {
    throw wrapGitFailure(
      checkoutRes.stderr,
      safeUri,
      scheme,
      branchAttempt.stderr,
    );
  }
}

/**
 * Translate a git stderr blob into a structured {@link ContractsSourceError}
 * with a hint tied to the recognised failure shape (404, auth, timeout,
 * generic). Both stderr blobs are credential-redacted before inspection and
 * before being embedded in the resulting message.
 */
function wrapGitFailure(
  stderr: string,
  safeUri: string,
  scheme: string,
  earlierStderr: string,
): ContractsSourceError {
  const safeStderr = redactUrlsInText(stderr);
  const safeEarlierStderr = redactUrlsInText(earlierStderr);
  const combined = `${safeEarlierStderr}\n${safeStderr}`.toLowerCase();
  if (
    combined.includes('timed out after') ||
    combined.includes('operation timed out')
  ) {
    return new ContractsSourceError(
      `Git source '${safeUri}' timed out: ${
        safeStderr.trim() || safeEarlierStderr.trim()
      }`,
      {scheme, uri: safeUri},
    );
  }
  if (
    combined.includes('repository not found') ||
    combined.includes('not found') ||
    combined.includes('does not exist') ||
    combined.includes('404')
  ) {
    return new ContractsSourceError(
      `Git source not found at '${safeUri}'; check the pin or auth credentials`,
      {scheme, uri: safeUri},
    );
  }
  if (
    combined.includes('authentication') ||
    combined.includes('permission denied') ||
    combined.includes('could not read username') ||
    combined.includes('terminal prompts disabled')
  ) {
    return new ContractsSourceError(
      `Git source '${safeUri}' requires authentication; ` +
        'supply an SSH key or `GIT_ASKPASS` for HTTPS access',
      {scheme, uri: safeUri},
    );
  }
  return new ContractsSourceError(
    `Git clone of '${safeUri}' failed: ${
      safeStderr.trim() || safeEarlierStderr.trim()
    }`,
    {scheme, uri: safeUri},
  );
}

/** Result of one `git` invocation. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `git <args>` in `cwd`, collect stdout/stderr, and resolve with the
 * exit code instead of rejecting so callers can branch on failure shape.
 * `GIT_TERMINAL_PROMPT=0` is forced into the environment so a missing
 * credential helper fails fast rather than hanging the parent process.
 *
 * The child is wrapped in an `AbortController` + `setTimeout` so a slow or
 * unreachable host cannot wedge the engine. On timeout the child is
 * `SIGKILL`-ed and the result surfaces with `code=-1` and a `stderr` blob
 * that {@link wrapGitFailure} maps to a structured timeout error.
 */
function runGit(args: string[], cwd: string): Promise<GitResult> {
  const timeoutMs = resolveGitTimeoutMs();
  return new Promise(resolvePromise => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      // `controller.abort()` propagates SIGTERM by default; force-kill so a
      // hung clone over a half-open TCP socket is reaped immediately.
      child.kill('SIGKILL');
    }, timeoutMs);
    // Unref so a hung clone cannot keep the event loop alive between
    // `controller.abort()` and the child's `close` event — matches the
    // unref'd timer pattern used by other sources.
    timer.unref();

    const child = spawn('git', args, {
      cwd,
      env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: controller.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const finalize = (code: number): void => {
      clearTimeout(timer);
      if (timedOut) {
        const note = `git ${args[0] ?? ''} timed out after ${timeoutMs}ms`;
        resolvePromise({
          code: -1,
          stdout,
          stderr: stderr ? `${stderr}\n${note}` : note,
        });
        return;
      }
      resolvePromise({code, stdout, stderr});
    };
    child.on('error', err => {
      clearTimeout(timer);
      if (timedOut) {
        const note = `git ${args[0] ?? ''} timed out after ${timeoutMs}ms`;
        resolvePromise({
          code: -1,
          stdout,
          stderr: stderr ? `${stderr}\n${note}` : note,
        });
        return;
      }
      resolvePromise({code: -1, stdout, stderr: stderr + String(err)});
    });
    child.on('close', code => {
      finalize(code ?? -1);
    });
  });
}
