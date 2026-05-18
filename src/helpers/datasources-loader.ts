// Shared loader for `<projectRoot>/datasources.json`.
//
// Multiple CLI surfaces (`lb-contracts ds`, `lb-contracts contract`, and the
// engine pipeline) all need to slurp the project's datasources doc, parse it
// as JSONC, and react identically to corruption. Before this helper existed
// `contract.ts` swallowed parse errors with `return []` while `ds.ts` threw
// a typed `ContractsValidationError` — same input produced two different
// user-visible behaviours depending on which command happened to hit the
// file first. That drift produced a misleading "no datasources declared"
// nudge when the actual problem was a typo in the JSON.
//
// Centralising the read here gives every caller the same diagnostic block
// (path + JSONC error code + line:col + offset) so users can fix the file
// once and move on. Callers retain full control over the "missing file" case
// — the helper returns `undefined` and the caller decides whether absence is
// benign (the `ds` command seeds a fresh doc; `contract` treats absence as
// "no datasources yet, run `lb-contracts ds` first").

import {existsSync, readFileSync} from 'node:fs';
import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser';
import {ContractsValidationError} from './errors';

/**
 * Shape of the parsed `datasources.json` document. Both on-disk layouts
 * surface through this union:
 *
 *   - The canonical keyed-object shape `lb-contracts ds` writes today,
 *     where each top-level key is the datasource name and the value is
 *     the adapter block (with an optional `$schema` sibling).
 *   - The legacy array-of-objects shape `[{name, adapter, ...}]` that
 *     hand-authored or imported configs may still carry — kept so users
 *     mid-migration don't get a false "no datasources" reading.
 *
 * Callers narrow with `Array.isArray(...)` before consuming.
 *
 * @public
 */
export type DatasourcesDoc = Record<string, unknown> | readonly unknown[];

/**
 * Convert a flat character offset within `raw` into a 1-based
 * `{line, column}` pair (UTF-16 code units). Used by
 * {@link readDatasourcesDoc} to translate `jsonc-parser`'s raw offset
 * into a human-actionable pointer in the parse-error message.
 *
 * Pure: no allocation in the hot path, only called once on failure.
 * Offsets at or past `raw.length` clamp to the document's last line/col
 * so a trailing-EOF error still produces a sensible coordinate.
 *
 * @public
 */
export function offsetToLineCol(
  raw: string,
  offset: number,
): {line: number; column: number} {
  const limit = offset < 0 ? 0 : offset > raw.length ? raw.length : offset;
  let line = 1;
  let column = 1;
  for (let i = 0; i < limit; i++) {
    if (raw.charCodeAt(i) === 0x0a /* \n */) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return {line, column};
}

/**
 * Read + JSONC-parse `datasources.json` at the given absolute path.
 *
 * Behaviour matrix:
 *
 *   - Missing file → returns `undefined`. The caller decides whether
 *     absence is benign (the `ds` command seeds a fresh doc; the
 *     `contract` command surfaces a "no datasources declared" nudge; the
 *     engine pipeline simply skips datasource emission).
 *   - Unreadable file (EPERM, EISDIR, etc.) → throws
 *     {@link ContractsValidationError} with `code: 'CONTRACTS_VALIDATION'`,
 *     `sourcePath` = absolute path, `instancePath: ''`.
 *   - Malformed JSONC → throws {@link ContractsValidationError} carrying
 *     the printable JSONC error code (`printParseErrorCode`), the
 *     1-based line/column (via {@link offsetToLineCol}), and the raw
 *     character offset for tooling that wants to seek directly.
 *   - Non-object, non-array top-level (`null`, string, number, boolean)
 *     → throws {@link ContractsValidationError} naming the unexpected
 *     `typeof json` so the user can spot a bare-value typo at a glance.
 *
 * Every throw uses the same error class so the CLI dispatcher renders an
 * identical block regardless of which command triggered the read. That
 * uniformity is the point: before this helper existed `contract.ts`
 * silently returned `[]` on parse failure and the user got a misleading
 * "no datasources declared" message instead of a parse-error pointer.
 *
 * @public
 */
export function readDatasourcesDoc(path: string): DatasourcesDoc | undefined {
  if (!existsSync(path)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ContractsValidationError(
      `datasources.json at ${path} could not be read: ${reason}. ` +
        'Check file permissions.',
      {sourcePath: path, instancePath: ''},
    );
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;

  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    const kind = printParseErrorCode(first.error);
    const {line, column} = offsetToLineCol(raw, first.offset);
    const suffix =
      errors.length > 1 ? ` (+${errors.length - 1} more error(s))` : '';
    throw new ContractsValidationError(
      `datasources.json at ${path} is malformed: ${kind} at ` +
        `line ${line}, column ${column} (offset ${first.offset})${suffix}. ` +
        'Fix the file before re-running.',
      {sourcePath: path, instancePath: ''},
    );
  }

  if (
    parsed === null ||
    (typeof parsed !== 'object' && !Array.isArray(parsed))
  ) {
    throw new ContractsValidationError(
      `datasources.json at ${path} must be a JSON array or object ` +
        `(got ${parsed === null ? 'null' : typeof parsed}).`,
      {sourcePath: path, instancePath: ''},
    );
  }

  // `typeof parsed === 'object'` covers both array and keyed-map cases —
  // `Array.isArray` callers can still narrow downstream.
  return parsed as DatasourcesDoc;
}
