// Strict JSONC reader for authored sidecar files.
//
// `jsonc-parser`'s `parse()` does not throw on malformed input — it records
// every `ParseError` it encounters into a caller-supplied array and returns
// the partial AST it managed to recover. Call sites that forget to inspect
// the array therefore silently scaffold from broken input, which is exactly
// the failure mode Finding 3 surfaced in `override.ts` (the override flow
// happily produced extension stubs from schema/config files that had been
// hand-edited into invalid JSON).
//
// This helper centralises the read + parse + error-array check + diagnostic
// formatting so every authored sidecar (schema, config, future
// `_meta/*.schema.json`) shares one user-visible error block. The `label`
// argument is folded into the message so users know which file broke at a
// glance ("schema 'customer'" vs "config for contract 'customer'") without
// having to eyeball the absolute path.

import {readFileSync} from 'node:fs';
import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser';
import {ContractsValidationError} from './errors';
import {offsetToLineCol} from './datasources-loader';

/**
 * JSONC-parse the file at `path`, throwing a typed
 * {@link ContractsValidationError} when the file cannot be read OR when
 * `jsonc-parser` records one or more `ParseError` entries against the
 * input. The standard `jsonc-parser` convention (allocate an empty
 * `errors` array, hand it to `parse()`, then remember to inspect it) is
 * too easy to forget; the silent partial-data parse this helper exists to
 * prevent has bitten the override flow once already.
 *
 * Behaviour matrix:
 *
 *   - Unreadable file (EPERM, EISDIR, etc.) → throws
 *     {@link ContractsValidationError} carrying the absolute `sourcePath`
 *     and an empty `instancePath`.
 *   - Malformed JSONC (one or more `ParseError` entries) → throws
 *     {@link ContractsValidationError} carrying the printable JSONC error
 *     code (`printParseErrorCode`), 1-based line/column derived via
 *     {@link offsetToLineCol}, and the raw character offset for tooling
 *     that wants to seek directly. Additional errors are summarised with
 *     `(+N more)` rather than concatenated — the first error is almost
 *     always the actionable one.
 *   - Clean parse → returns the parsed value as `unknown` so the caller
 *     can narrow with its own type-guard (the helper deliberately stays
 *     schema-agnostic so it can serve every authored sidecar).
 *
 * `label` is the human-readable identifier of the file (e.g.
 * `"schema 'customer'"`); it is prefixed to every error message. The
 * absolute `path` is also included so editor "jump to file" tooling can
 * pick it up from the rendered diagnostic.
 *
 * @public
 */
export function readJsoncStrict(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ContractsValidationError(
      `${label} at ${path} could not be read: ${reason}. ` +
        'Check file permissions.',
      {sourcePath: path, instancePath: ''},
      {cause: err},
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
    const suffix = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
    throw new ContractsValidationError(
      `${label} at ${path} is malformed: ${kind} at ` +
        `line ${line}, column ${column} (offset ${first.offset})${suffix}. ` +
        'Fix the file before re-running.',
      {sourcePath: path, instancePath: ''},
    );
  }

  return parsed;
}
