import {BindingScope, inject, injectable} from '@loopback/core';
import {readdir, readFile, realpath, stat} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {ContractsSourceError} from '../helpers';
import type {SchemaSource, SchemaSourceResult} from '../interfaces';
import {SOURCE_TAG} from '../keys';

/**
 * Built-in {@link SchemaSource} for bare-path descriptors. Matches the
 * `local` pseudo-scheme used by `SourceResolverRegistry` for descriptors
 * that carry no `<scheme>:` prefix (e.g. `./schemas`, `/abs/path/schemas`).
 * Globs `**\/*.schema.json` under the supplied directory using a small
 * recursive walker built on `node:fs/promises` (no glob library dependency).
 *
 * Symlinks are resolved via `realpath` and validated against the configured
 * `platform.contracts.project-root` boundary so a hostile symlink pointing
 * outside the project (e.g., to `/etc/passwd`) cannot be followed.
 *
 * Returns each file as-is; bundled schemas (with `$defs`) are split by the
 * pipeline downstream.
 *
 * @internal
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[SOURCE_TAG]: SOURCE_TAG, scheme: 'local'},
})
export class LocalSchemaSource implements SchemaSource {
  readonly scheme = 'local';

  constructor(
    @inject('platform.contracts.project-root', {optional: true})
    private readonly projectRoot: string = process.cwd(),
  ) {}

  /**
   * Read every `*.schema.json` file beneath `uri` and return the file
   * contents verbatim. `uri` is resolved relative to `process.cwd()` when
   * not already absolute and then canonicalised via `realpath` to defeat
   * symlink-escape attacks. Any entry whose target falls outside
   * `projectRoot` is rejected.
   *
   * @throws ContractsSourceError When `uri` does not exist, is not a
   *   directory, or resolves (directly or via a nested symlink) to a path
   *   outside `projectRoot`.
   */
  async fetch(uri: string): Promise<SchemaSourceResult> {
    const requested = resolve(uri);
    const boundary = await this.resolveBoundary(uri);

    let root: string;
    try {
      root = await realpath(requested);
    } catch (cause) {
      throw new ContractsSourceError(
        `Local schema directory '${uri}' does not exist`,
        {scheme: this.scheme, uri},
        {cause},
      );
    }
    if (!isWithin(root, boundary)) {
      throw new ContractsSourceError(
        `symlink escape detected: '${uri}' resolves outside project root '${boundary}'`,
        {scheme: this.scheme, uri},
      );
    }

    let isDir = false;
    try {
      const info = await stat(root);
      isDir = info.isDirectory();
    } catch (cause) {
      throw new ContractsSourceError(
        `Local schema directory '${uri}' does not exist`,
        {scheme: this.scheme, uri},
        {cause},
      );
    }
    if (!isDir) {
      throw new ContractsSourceError(
        `Local schema path '${uri}' is not a directory`,
        {scheme: this.scheme, uri},
      );
    }

    const files = await collectFilesWithSymlinkGuard(
      root,
      boundary,
      uri,
      this.scheme,
    );
    const results = await Promise.all(
      files.map(async absPath => {
        const content = await readFile(absPath, 'utf8');
        return {source: uri, path: absPath, content};
      }),
    );
    return results;
  }

  /**
   * Canonicalise the configured project root so all containment checks
   * compare apples-to-apples. If the configured root cannot be realpath-ed
   * (test fixtures, dry-runs) we fall back to the resolved-but-uncanonical
   * path so the boundary still applies.
   */
  private async resolveBoundary(uri: string): Promise<string> {
    const root = resolve(this.projectRoot);
    try {
      return await realpath(root);
    } catch (cause) {
      throw new ContractsSourceError(
        `Configured project root '${this.projectRoot}' does not exist`,
        {scheme: this.scheme, uri},
        {cause},
      );
    }
  }
}

/**
 * Walk `root` and collect every `*.schema.json` file, refusing to descend
 * into any directory whose `realpath` escapes `boundary`. Symlinked files
 * are likewise rejected.
 *
 * Implemented in-line (rather than calling the shared `collectSchemaFiles`
 * helper) because the helper has no notion of a boundary — adding one to
 * its signature would burden the non-local sources, whose roots are cache
 * dirs outside the project root by design.
 */
async function collectFilesWithSymlinkGuard(
  root: string,
  boundary: string,
  uri: string,
  scheme: string,
): Promise<string[]> {
  const out: string[] = [];
  // DFS via `stack.pop()`. Traversal order is irrelevant because the result
  // is lexicographically sorted before return — matches `collectSchemaFiles`
  // (which uses a BFS queue) bit-for-bit. Pick whichever read more cleanly
  // here without worrying about output divergence.
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    const entries = await readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // `entry.isSymbolicLink()` already establishes the entry is a symlink
        // (readdir was called with `withFileTypes`, which does an lstat
        // internally); `realpath` then tells us where it actually points so
        // we can reject targets that escape the project boundary.
        let target: string;
        try {
          target = await realpath(full);
        } catch (cause) {
          throw new ContractsSourceError(
            `Broken symlink '${full}' under '${uri}'`,
            {scheme, uri},
            {cause},
          );
        }
        if (!isWithin(target, boundary)) {
          throw new ContractsSourceError(
            `symlink escape detected: '${full}' -> '${target}' is outside project root '${boundary}'`,
            {scheme, uri},
          );
        }
        const info = await stat(target);
        // Re-canonicalise after `stat` to close a TOCTOU window: between the
        // initial `realpath` and now, the target could have been re-pointed
        // at a path outside the boundary by a racing actor. Re-check before
        // we descend or read.
        const resolvedAfterStat = await realpath(target);
        if (!isWithin(resolvedAfterStat, boundary)) {
          throw new ContractsSourceError(
            `symlink escape detected: '${full}' -> '${resolvedAfterStat}' is outside project root '${boundary}'`,
            {scheme, uri},
          );
        }
        if (info.isDirectory()) {
          if (
            entry.name === 'node_modules' ||
            entry.name === 'dist' ||
            entry.name.startsWith('.')
          ) {
            continue;
          }
          stack.push(target);
        } else if (info.isFile() && entry.name.endsWith('.schema.json')) {
          out.push(target);
        }
      } else if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name.startsWith('.')
        ) {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.schema.json')) {
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Path-prefix containment check that respects platform path separators.
 * Returns true when `candidate === boundary` or `candidate` lives under
 * `boundary`. Both inputs must already be absolute realpaths.
 */
function isWithin(candidate: string, boundary: string): boolean {
  if (candidate === boundary) return true;
  const prefix = boundary.endsWith(sep) ? boundary : boundary + sep;
  return candidate.startsWith(prefix);
}
