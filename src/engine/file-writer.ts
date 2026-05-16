import {createHash, randomBytes} from 'node:crypto';
import {mkdir, open, readFile, rename, stat, unlink} from 'node:fs/promises';
import {dirname, extname, isAbsolute, join, resolve, sep} from 'node:path';
import {BindingScope, injectable} from '@loopback/core';
import createDebug from 'debug';
import {ContractsCodegenError} from '../helpers';
import type {EmittedFile} from '../interfaces';

const debug = createDebug('loopback:contracts:file-writer');

/**
 * Outcome of a single {@link FileWriter.writeAll} call.
 *
 * Paths are absolute. Each emitted file lands in exactly one bucket; the
 * union of all four buckets equals the input file set.
 *
 * @internal
 */
export interface WriteResult {
  /** Files that did not exist before this run. */
  readonly created: readonly string[];
  /** Files whose on-disk bytes changed during this run. */
  readonly updated: readonly string[];
  /** Files already on disk with identical bytes — no write performed. */
  readonly unchanged: readonly string[];
  /** Files with `policy: 'skipIfExists'` whose target already existed. */
  readonly skipped: readonly string[];
}

/**
 * One classification bucket used by {@link FileWriter.detectChanges}. Same
 * semantics as {@link WriteResult} but populated without touching the
 * filesystem.
 *
 * @internal
 */
export interface ChangeReport {
  readonly created: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  readonly skipped: readonly string[];
}

interface ResolvedFile {
  readonly absPath: string;
  readonly relPath: string;
  readonly bytes: Buffer;
  readonly policy: 'regen' | 'skipIfExists';
}

const HEADER_BANNER = 'AUTO-GENERATED — do not edit. Regenerate with: lb4 gen';

/**
 * Atomic, idempotent file writer used by the contracts engine to materialize
 * {@link EmittedFile} descriptors returned by emitters.
 *
 * Responsibilities:
 *
 * - Prepend a language-appropriate auto-generated header to every emitted
 *   file (skipped for JSON because the format has no comment syntax).
 * - Enforce per-file overwrite policy: `'regen'` (always) and
 *   `'skipIfExists'` (write once, leave alone afterwards).
 * - Detect output-path collisions across emitters and refuse the run with a
 *   diagnostic that names both producers.
 * - Skip re-writes when on-disk bytes already match (SHA-256 fingerprint)
 *   so mtime stays stable for downstream watchers and build caches.
 * - Write atomically via `rename()` from a sibling tmp file so a crash mid-
 *   write can never leave a half-written artifact on disk.
 *
 * The class is a singleton — it holds no per-run state — and is part of the
 * engine's internal surface; emitters never instantiate it directly.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class FileWriter {
  /**
   * Materialize every descriptor under `outputDir`.
   *
   * Steps, in order:
   *
   * 1. Validate output paths and detect cross-emitter collisions; throw
   *    {@link ContractsCodegenError} naming both producers if any two
   *    descriptors target the same path.
   * 2. Prepend the appropriate header comment for each file's extension.
   * 3. For each file, classify against on-disk state and either skip,
   *    write atomically, or honor `'skipIfExists'`.
   *
   * Writes are two-phased so a mid-batch failure cannot leave a partial
   * batch committed on disk:
   *
   * - Phase 1: classify every descriptor against on-disk state and, for
   *   each one that needs writing, `mkdir -p` + write content to a
   *   sibling tmp path (`<final>.tmp.<rand>`). Each tmp is `fsync`-ed
   *   before close for POSIX durability. If any phase-1 write throws,
   *   every tmp produced so far is unlinked (best-effort) and the
   *   original error is re-thrown — nothing has been renamed yet, so the
   *   target tree is untouched.
   * - Phase 2: once every tmp is on disk, `rename(tmp, final)` is issued
   *   for every entry. A failure partway through phase 2 leaves a
   *   partial state on disk — this should be vanishingly rare under
   *   normal filesystem operation (rename within the same directory is
   *   atomic on POSIX and on NTFS) and we still best-effort unlink any
   *   tmp files that have not yet been renamed.
   *
   * Identical bytes are a no-op (SHA-256 compare) and do not touch
   * mtime. When every descriptor is unchanged the method skips both
   * phases entirely.
   *
   * @internal
   * @param outputDir - Absolute or cwd-relative directory under which
   *   every descriptor's `path` is resolved by default.
   * @param files - Descriptors to write; each `path` is treated as
   *   relative to `outputDir` unless overridden by `perFileRoots`.
   * @param perFileRoots - Optional map keyed by {@link EmittedFile.path}
   *   whose value replaces `outputDir` for that one descriptor. Lets the
   *   engine batch writes that anchor at different roots (e.g. emitter
   *   output under `paths.outputDir` and meta-schema files under
   *   `paths.root/_meta`) in a single atomic phase-2 commit, preserving
   *   the no-partial-writes guarantee across both roots. The
   *   {@link EmittedFile} public interface is untouched — the map keys
   *   are the same `path` strings already present in the descriptors,
   *   so emitters never have to know about this knob.
   * @returns Per-file classification — see {@link WriteResult}.
   * @throws ContractsCodegenError When two descriptors collide on the
   *   same absolute output path (after applying any per-file root
   *   override).
   */
  async writeAll(
    outputDir: string,
    files: readonly EmittedFile[],
    perFileRoots?: ReadonlyMap<string, string>,
  ): Promise<WriteResult> {
    const root = resolve(outputDir);
    const resolved = this.resolveFiles(root, files, perFileRoots);

    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const skipped: string[] = [];

    // Pre-scan: classify every descriptor against on-disk state. Only
    // entries that land in `created` or `updated` actually need a tmp
    // write in phase 1.
    interface Pending {
      readonly file: ResolvedFile;
      readonly bucket: 'created' | 'updated';
    }
    const pending: Pending[] = [];

    for (const file of resolved) {
      const existing = await readIfExists(file.absPath);

      if (existing === undefined) {
        pending.push({file, bucket: 'created'});
        continue;
      }

      if (file.policy === 'skipIfExists') {
        skipped.push(file.absPath);
        continue;
      }

      if (sha256(existing) === sha256(file.bytes)) {
        unchanged.push(file.absPath);
        continue;
      }

      pending.push({file, bucket: 'updated'});
    }

    // Fast path: nothing to write. Honors the idempotency guarantee —
    // no tmp files created, no renames, no mtime churn.
    if (pending.length === 0) {
      return {created, updated, unchanged, skipped};
    }

    // Phase 1: write every pending entry to a sibling tmp path. Collect
    // (final -> tmp) so phase 2 can rename and so a mid-phase failure
    // can clean up.
    const tmpFor = new Map<string, string>();
    try {
      for (const {file} of pending) {
        await mkdir(dirname(file.absPath), {recursive: true});
        const tmpPath = `${file.absPath}.tmp.${randomBytes(6).toString('hex')}`;
        await writeTmpDurable(tmpPath, file.bytes);
        tmpFor.set(file.absPath, tmpPath);
      }
    } catch (err) {
      // Phase 1 aborted — no rename has happened yet, so the target
      // tree is still in its pre-call state. Clean up every tmp we
      // managed to write; allSettled so a cleanup failure can't mask
      // the original error.
      await Promise.allSettled(Array.from(tmpFor.values(), p => unlink(p)));
      throw err;
    }

    // Phase 2: promote each tmp into place. A failure here is rare
    // (rename within a directory is atomic on POSIX and NTFS) but
    // leaves a partial state — earlier renames stay committed, later
    // ones never happen. Best-effort unlink any tmps not yet renamed
    // and wrap the OS error in a typed ContractsCodegenError whose
    // message lists every path that did vs did not get committed so the
    // caller can reason about the partial state and rerun safely.
    //
    // `failedPath` is set to `file.absPath` at the start of every
    // iteration before any `await`, and cleared only after a successful
    // `rename` returns. The catch block can only fire while
    // `failedPath` is set — there is no path that throws with
    // `failedPath === undefined` — so the variable is guaranteed
    // defined inside the catch and needs no fallback expression.
    const renamed: string[] = [];
    let failedPath: string | undefined;
    try {
      for (const {file, bucket} of pending) {
        const tmpPath = tmpFor.get(file.absPath);
        // Defensive: tmpFor was populated in lock-step with pending in
        // phase 1, so this is always defined; satisfy the type checker
        // without an `any`.
        if (tmpPath === undefined) continue;
        failedPath = file.absPath;
        await rename(tmpPath, file.absPath);
        renamed.push(file.absPath);
        failedPath = undefined;
        if (bucket === 'created') {
          created.push(file.absPath);
        } else {
          updated.push(file.absPath);
        }
      }
    } catch (cause) {
      const renamedSet = new Set(renamed);
      const pendingPaths: string[] = [];
      const leftover: string[] = [];
      for (const [finalPath, tmpPath] of tmpFor) {
        if (!renamedSet.has(finalPath)) {
          pendingPaths.push(finalPath);
          leftover.push(tmpPath);
        }
      }
      await Promise.allSettled(leftover.map(p => unlink(p)));
      // `failedPath` is always set before the throw — see the comment
      // on the `let` declaration. Keep the empty-string fallback as a
      // type-narrowing safety net (TS cannot prove the invariant) but
      // do not include `pendingPaths[0]`: it would be unreachable and
      // misleading because the failing path is always recorded.
      const firstFailed = failedPath ?? '';
      const committedList = renamed.length > 0 ? renamed.join(', ') : '(none)';
      const pendingList =
        pendingPaths.length > 0 ? pendingPaths.join(', ') : '(none)';
      throw new ContractsCodegenError(
        `file-writer phase 2 rename failed at '${firstFailed}': ` +
          `${(cause as Error).message}. ` +
          `Committed (${renamed.length}): ${committedList}. ` +
          `Pending / not written (${pendingPaths.length}): ${pendingList}. ` +
          `Tmp files for pending paths have been cleaned up; rerun to retry.`,
        {
          emitterKind: 'file-writer',
          schemaId: '',
          outputPath: firstFailed,
        },
        {cause},
      );
    }

    return {created, updated, unchanged, skipped};
  }

  /**
   * Classify each descriptor against on-disk state without writing. Used
   * by `lb4 gen --dry-run` to preview the diff. Same classification rules
   * as {@link writeAll}.
   *
   * @internal
   */
  async detectChanges(
    outputDir: string,
    files: readonly EmittedFile[],
  ): Promise<ChangeReport> {
    const root = resolve(outputDir);
    const resolved = this.resolveFiles(root, files);

    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const skipped: string[] = [];

    for (const file of resolved) {
      const existing = await readIfExists(file.absPath);
      if (existing === undefined) {
        created.push(file.absPath);
        continue;
      }
      if (file.policy === 'skipIfExists') {
        skipped.push(file.absPath);
        continue;
      }
      if (sha256(existing) === sha256(file.bytes)) {
        unchanged.push(file.absPath);
      } else {
        updated.push(file.absPath);
      }
    }

    return {created, updated, unchanged, skipped};
  }

  // Resolve, validate, header-prepend, and check for collisions in one pass.
  // `perFileRoots` (optional) lets a single `writeAll` call straddle two
  // roots — anchor the per-file root override using the raw `file.path`
  // key (NOT the normalised one) so callers compose the map with the
  // exact same string they put into the descriptor.
  private resolveFiles(
    root: string,
    files: readonly EmittedFile[],
    perFileRoots?: ReadonlyMap<string, string>,
  ): ResolvedFile[] {
    const seen = new Map<string, string>(); // absPath -> producer label
    const resolved: ResolvedFile[] = [];

    for (const file of files) {
      const relPath = normalizeRel(file.path);
      const fileRoot = perFileRoots?.get(file.path);
      const effectiveRoot = fileRoot !== undefined ? resolve(fileRoot) : root;
      const absPath = join(effectiveRoot, relPath);

      if (seen.has(absPath)) {
        const first = seen.get(absPath) ?? '<unknown>';
        const second = file.producer ?? '<unknown>';
        throw new ContractsCodegenError(
          `Two emitters target the same output path '${relPath}': ` +
            `'${first}' and '${second}'. Rename one or change its outputSuffix.`,
          {
            emitterKind: second,
            schemaId: '<unknown>',
            outputPath: absPath,
          },
        );
      }
      seen.set(absPath, file.producer ?? '<unknown>');

      const withHeader = applyHeader(relPath, file);
      const bytes =
        file.encoding === 'binary'
          ? Buffer.from(withHeader, 'binary')
          : Buffer.from(withHeader, 'utf8');

      resolved.push({
        absPath,
        relPath,
        bytes,
        policy: file.policy ?? 'regen',
      });
    }

    return resolved;
  }
}

// Write `bytes` to `tmpPath` and fsync before close so the data is
// durable on POSIX filesystems. Some filesystems (notably certain
// network mounts, and Windows ReFS in some configurations) do not
// support fsync; the call is wrapped so an EINVAL/ENOTSUP there does
// not derail the write. The fsync error is surfaced via the `debug`
// channel (`DEBUG=loopback:contracts:file-writer`) but never thrown —
// the rename in phase 2 still provides crash-atomicity for the visible
// target, and we don't want to spam `process.emitWarning` on every
// write on filesystems that simply don't implement fsync.
async function writeTmpDurable(tmpPath: string, bytes: Buffer): Promise<void> {
  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(bytes);
    try {
      await handle.sync();
    } catch (err) {
      debug('fsync unsupported on %s: %s', tmpPath, (err as Error).message);
    }
  } finally {
    await handle.close();
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readIfExists(absPath: string): Promise<Buffer | undefined> {
  try {
    const s = await stat(absPath);
    if (!s.isFile()) return undefined;
    return await readFile(absPath);
  } catch (err) {
    if (isNodeErrnoCode(err, 'ENOENT')) return undefined;
    throw err;
  }
}

function isNodeErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as {code: unknown}).code === code
  );
}

function normalizeRel(p: string): string {
  // EmittedFile.path is documented as relative to outputDir. Reject
  // absolute paths and any segment that escapes the output root — both
  // would let an emitter scribble outside the project tree.
  if (isAbsolute(p)) {
    throw new ContractsCodegenError(
      `EmittedFile.path must be relative to outputDir, got absolute '${p}'`,
      {emitterKind: '<unknown>', schemaId: '<unknown>', outputPath: p},
    );
  }
  const parts = p.split(/[\\/]/).filter(seg => seg.length > 0 && seg !== '.');
  if (parts.some(seg => seg === '..')) {
    throw new ContractsCodegenError(
      `EmittedFile.path must not contain '..' segments, got '${p}'`,
      {emitterKind: '<unknown>', schemaId: '<unknown>', outputPath: p},
    );
  }
  return parts.join(sep);
}

// Header injection: pick the comment syntax that matches the file's
// extension. JSON has no comment grammar, so we deliberately skip it.
// An explicit `headerComment` on the descriptor overrides the default.
function applyHeader(relPath: string, file: EmittedFile): string {
  const ext = extname(relPath).toLowerCase();
  if (file.headerComment !== undefined) {
    return ensureTrailingNewline(file.headerComment) + file.content;
  }
  const header = defaultHeaderFor(ext);
  if (header === undefined) return file.content;
  return header + file.content;
}

function defaultHeaderFor(ext: string): string | undefined {
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.mjs':
    case '.cjs':
      return `// ${HEADER_BANNER}\n`;
    case '.yaml':
    case '.yml':
    case '.proto':
    case '.avsc':
    case '.graphql':
    case '.gql':
      return `# ${HEADER_BANNER}\n`;
    case '.json':
      return undefined;
    default:
      return undefined;
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}
