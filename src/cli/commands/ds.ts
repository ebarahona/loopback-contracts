// `lb4 ds <name>` — append a new entry to the project's `datasources.json`.
//
// One-shot scaffolder: refuses to overwrite an existing entry. Creates the
// file if missing, complete with the `$schema` reference VS Code needs for
// `_meta/datasources.schema.json` autocomplete. Prompts interactively (via
// `@clack/prompts`) for any missing required field when a TTY is attached;
// runs silently when invoked from a script with everything pre-flagged.
//
// See `loopback-contracts.md` §"CLI command reference" — entry for `lb4 ds`.

import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {
  applyEdits,
  format,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser';
import {createCliContext} from '../cli-context';
import {ContractsError, ContractsValidationError} from '../../helpers';
import type {LoopbackConfigJson} from '../../types';
import {note, select, text} from '../prompts';

/**
 * Code raised by `../prompts` when the user cancels — mirrors the
 * dispatcher's own constant so this command's catch block stays
 * decoupled from the helper module.
 */
const CANCEL_CODE = 'CONTRACTS_CLI_CANCELLED';

/** Flags `lb4 ds` recognises as first-class — everything else is pass-through. */
const KNOWN_FLAGS = new Set([
  'adapter',
  'url',
  'database',
  'host',
  'port',
  'user',
  'password',
]);

/** Adapter kinds offered by the interactive picker. */
type AdapterChoice =
  | 'mongodb'
  | 'postgres'
  | 'mysql'
  | 'redis'
  | 'memory'
  | 'other';

/**
 * Parsed, normalised command-line arguments for one `lb4 ds` invocation.
 * Every field except `name` and `adapter` is optional at parse time; the
 * interactive layer fills the required ones when stdin is a TTY.
 */
interface ParsedArgs {
  name?: string;
  adapter?: string;
  url?: string;
  database?: string;
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  /** Additional `--<key> <value>` pairs the user passed through. */
  passthrough: Record<string, string>;
}

/**
 * Run `lb4 ds <name>`. Returns `0` on success, non-zero on user-visible
 * failure. Never throws past its own boundary — every failure surfaces
 * through the exit code so the CLI dispatcher renders a uniform frame.
 *
 * @public
 */
export async function runDs(opts: {
  projectRoot: string;
  config: LoopbackConfigJson;
  argv: readonly string[];
}): Promise<number> {
  // The `config` parameter is part of the public signature so the
  // dispatcher hands every command the same context bundle; this command
  // does not read it (datasources live in their own file).
  void opts.config;

  const parsed = parseArgs(opts.argv);

  try {
    // Interactive top-up of any required fields the user did not supply on
    // the command line. Disabled when stdin is not a TTY so the command
    // can be driven from CI / scripts without hanging.
    const interactive = process.stdin.isTTY === true;
    if (interactive) {
      await promptMissing(parsed);
    } else {
      const missing = collectMissing(parsed);
      if (missing.length > 0) {
        process.stderr.write(
          `lb4 ds: missing required ${missing.join(', ')} ` +
            `(non-interactive run; pass --${missing[0]} or run from a TTY).\n`,
        );
        return 1;
      }
    }

    const name = parsed.name ?? '';
    const adapter = parsed.adapter ?? '';
    if (name === '' || adapter === '') {
      // Defensive — should be unreachable after the interactive /
      // non-interactive gates above.
      process.stderr.write('lb4 ds: internal error: name or adapter empty.\n');
      return 1;
    }

    const datasourcesPath = resolve(opts.projectRoot, 'datasources.json');
    const existing = readDatasources(datasourcesPath);

    if (Object.prototype.hasOwnProperty.call(existing, name)) {
      process.stderr.write(
        `Datasource '${name}' already exists in datasources.json. ` +
          'Hand-edit to modify.\n',
      );
      // Refusal-to-overwrite: per the CLI exit-code policy, hand-edits
      // own the file from then on. Code 2 signals "won't clobber".
      return 2;
    }

    const entry = buildEntry(parsed);
    await writeDatasourceEntry(datasourcesPath, name, entry);

    note(
      [
        `Added datasource '${name}' (adapter: ${adapter}).`,
        '',
        `  ${datasourcesPath}`,
        '',
        'Next: bind a contract to this datasource via `lb4 contract` ' +
          'or hand-edit an existing `configs/*.config.json`, ' +
          'then run `lb4 gen`.',
      ].join('\n'),
      'Datasource added',
    );

    return 0;
  } catch (err) {
    if (err instanceof ContractsError && err.code === CANCEL_CODE) {
      process.stderr.write('Cancelled.\n');
      // SIGINT-equivalent exit code per UNIX convention.
      return 130;
    }
    // Typed validation errors (e.g. malformed `datasources.json`) are
    // re-thrown so the CLI dispatcher's `renderError` path can format the
    // structured fields (sourcePath, instancePath) into the standard error
    // block. Anything else falls back to a flat one-line message.
    if (err instanceof ContractsValidationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Argument parsing — hand-rolled (no `mri` / `minimist` dependency)
// ---------------------------------------------------------------------------

/**
 * Tokenise `argv` into a {@link ParsedArgs} bundle. Hand-rolled rather than
 * pulling in `mri` so the dependency surface stays minimal and unknown
 * flags survive as `passthrough` entries without lossy coercion.
 *
 * Grammar:
 *   - The first positional token (not starting with `-`) is the datasource
 *     name. Subsequent positional tokens are ignored with a warning.
 *   - `--flag value` and `--flag=value` are both accepted. A bare `--flag`
 *     (no value) is treated as the empty string for that flag.
 *   - Known flags populate the named fields; everything else accumulates
 *     into `passthrough` for the connector-specific config block.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {passthrough: {}};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const stripped = token.slice(2);
    let key: string;
    let value: string;
    const eq = stripped.indexOf('=');
    if (eq >= 0) {
      key = stripped.slice(0, eq);
      value = stripped.slice(eq + 1);
    } else {
      key = stripped;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = '';
      }
    }
    if (key === '') continue;
    assignFlag(out, key, value);
  }

  const firstPositional = positionals[0];
  if (firstPositional !== undefined) out.name = firstPositional;
  // Anything past the first positional is ignored — `lb4 ds` takes one name.
  return out;
}

/** Dispatch a `--<key>` flag into the correct named slot or `passthrough`. */
function assignFlag(out: ParsedArgs, key: string, value: string): void {
  if (KNOWN_FLAGS.has(key)) {
    switch (key) {
      case 'adapter':
        out.adapter = value;
        break;
      case 'url':
        out.url = value;
        break;
      case 'database':
        out.database = value;
        break;
      case 'host':
        out.host = value;
        break;
      case 'port':
        out.port = value;
        break;
      case 'user':
        out.user = value;
        break;
      case 'password':
        out.password = value;
        break;
      default:
        // KNOWN_FLAGS gates entry; unreachable in practice. Throw rather
        // than silently drop so a future flag added to the set without a
        // case branch surfaces immediately.
        throw new ContractsValidationError(`unhandled known flag: ${key}`, {
          sourcePath: '<argv>',
          instancePath: `/${key}`,
        });
    }
    return;
  }
  out.passthrough[key] = value;
}

/**
 * List required fields not yet provided. Used by the non-interactive
 * (script / CI) path to fail fast with an actionable message.
 */
function collectMissing(parsed: ParsedArgs): string[] {
  const missing: string[] = [];
  if (parsed.name === undefined || parsed.name === '') missing.push('name');
  if (parsed.adapter === undefined || parsed.adapter === '') {
    missing.push('adapter');
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Interactive prompts (TTY only)
// ---------------------------------------------------------------------------

/**
 * Walk through the four wizard prompts the spec calls out, filling
 * `parsed` in-place. The `../prompts` facade throws a typed
 * `CONTRACTS_CLI_CANCELLED` `ContractsError` on user cancel; the caller's
 * top-level try/catch maps that to exit code 130, so this function no
 * longer needs to thread a sentinel return value.
 */
async function promptMissing(parsed: ParsedArgs): Promise<ParsedArgs> {
  if (parsed.name === undefined || parsed.name === '') {
    const answer = await text({
      message: 'Datasource name?',
      validate(value): string | undefined {
        const v = value.trim();
        if (v === '') return 'Datasource name is required';
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(v)) {
          return 'Datasource name must be a valid identifier';
        }
        return undefined;
      },
    });
    parsed.name = answer.trim();
  }

  if (parsed.adapter === undefined || parsed.adapter === '') {
    const picked = await select<AdapterChoice>({
      message: 'Adapter?',
      options: [
        {label: 'MongoDB', value: 'mongodb'},
        {label: 'PostgreSQL', value: 'postgres'},
        {label: 'MySQL', value: 'mysql'},
        {label: 'Redis', value: 'redis'},
        {label: 'In-memory (dev only)', value: 'memory'},
        {label: 'Other (specify)', value: 'other'},
      ],
    });
    if (picked === 'other') {
      const other = await text({
        message: 'Adapter name?',
        validate(value): string | undefined {
          if (value.trim() === '') return 'Adapter name is required';
          return undefined;
        },
      });
      parsed.adapter = other.trim();
    } else {
      parsed.adapter = picked;
    }
  }

  if (parsed.url === undefined || parsed.url === '') {
    const fallback = `\${${parsed.name.toUpperCase()}_URL}`;
    const url = await text({
      message: 'URL? (env var refs allowed, e.g. ${MONGO_URL})',
      defaultValue: fallback,
      placeholder: fallback,
    });
    parsed.url = url.trim() === '' ? fallback : url.trim();
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Entry construction — match the doc's keyed-object `datasources.json` shape
// ---------------------------------------------------------------------------

/**
 * Build the JSON value to slot under `datasources.json#/<name>`. Drops
 * undefined / empty-string fields so the on-disk shape stays minimal and
 * matches the example in `loopback-contracts.md` §"datasources.json".
 *
 * Pass-through flags ride alongside the known fields under the same object
 * (the meta-schema's `additionalProperties: true` for adapter blocks lets
 * connector-specific keys land verbatim).
 */
function buildEntry(parsed: ParsedArgs): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (parsed.adapter !== undefined && parsed.adapter !== '') {
    entry['adapter'] = parsed.adapter;
  }
  if (parsed.url !== undefined && parsed.url !== '') entry['url'] = parsed.url;
  if (parsed.database !== undefined && parsed.database !== '') {
    entry['database'] = parsed.database;
  }
  if (parsed.host !== undefined && parsed.host !== '') {
    entry['host'] = parsed.host;
  }
  if (parsed.port !== undefined && parsed.port !== '') {
    const numeric = Number(parsed.port);
    entry['port'] = Number.isFinite(numeric) ? numeric : parsed.port;
  }
  if (parsed.user !== undefined && parsed.user !== '') {
    entry['user'] = parsed.user;
  }
  if (parsed.password !== undefined && parsed.password !== '') {
    entry['password'] = parsed.password;
  }
  for (const [key, value] of Object.entries(parsed.passthrough)) {
    if (value === '') continue;
    entry[key] = value;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// `datasources.json` IO — JSONC-preserving via `jsonc-parser`
// ---------------------------------------------------------------------------

/**
 * Load every existing datasource name from `datasources.json`, parsing it
 * as JSONC so a user-added comment doesn't break this round-trip. Returns
 * the parsed root object for the caller to probe for duplicates.
 *
 * Missing file is the "fresh project, first datasource" case — returns a
 * keyed-map seed with the `$schema` pointer so the duplicate-check sees a
 * well-formed document. The companion {@link writeDatasourceEntry} also
 * seeds `$schema` on disk when the file is missing; the in-memory seed
 * here just mirrors that on-disk shape.
 *
 * Existing-but-unreadable / malformed file is a hard failure: throws a
 * {@link ContractsValidationError} carrying the absolute path and parse
 * error message. Silently treating it as `{}` would let duplicate
 * detection be bypassed and would clobber any user comment containing the
 * original (broken) content — the user must fix `datasources.json` before
 * `lb-contracts ds` can run.
 */
function readDatasources(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {$schema: './_meta/datasources.schema.json'};
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ContractsValidationError(
      `Could not read datasources.json at ${path}: ${reason}. ` +
        'Fix the file before re-running `lb-contracts ds`.',
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
    const suffix =
      errors.length > 1 ? ` (+${errors.length - 1} more error(s))` : '';
    throw new ContractsValidationError(
      `Malformed datasources.json at ${path}: JSONC parse error at ` +
        `offset ${first.offset}: ${kind}${suffix}. ` +
        'Fix the file before re-running `lb-contracts ds`.',
      {sourcePath: path, instancePath: ''},
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ContractsValidationError(
      `Malformed datasources.json at ${path}: expected a top-level JSON ` +
        'object (keyed-map of datasource entries). ' +
        'Fix the file before re-running `lb-contracts ds`.',
      {sourcePath: path, instancePath: ''},
    );
  }

  return parsed as Record<string, unknown>;
}

/**
 * Insert (or seed) a single datasource entry under `datasources.json`,
 * preserving any existing JSONC formatting / comments. Creates the file
 * with the meta-schema `$schema` reference when missing.
 */
async function writeDatasourceEntry(
  path: string,
  name: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), {recursive: true});

  const formatting = {tabSize: 2, insertSpaces: true, eol: '\n'} as const;

  let text: string;
  if (existsSync(path)) {
    text = readFileSync(path, 'utf8');
  } else {
    // Seed an empty object and add `$schema` through the same
    // `jsonc-parser` `modify` + `format` path the new entry takes — keeps
    // the on-disk formatting (key order, indentation, trailing newline)
    // identical for files this CLI creates vs. files it updates.
    text = '{}';
    const seedEdits = modify(
      text,
      ['$schema'],
      './_meta/datasources.schema.json',
      {formattingOptions: formatting},
    );
    text = applyEdits(text, seedEdits);
  }

  // Insert the new entry at the top-level key matching `name`. `jsonc-parser`
  // preserves any surrounding comments and existing key ordering.
  const edits = modify(text, [name], entry, {formattingOptions: formatting});
  let nextText = applyEdits(text, edits);
  nextText = applyEdits(nextText, format(nextText, undefined, formatting));
  if (!nextText.endsWith('\n')) nextText += '\n';

  await writeFile(path, nextText);
}

/**
 * Dispatcher-facing adapter. Builds the standard {@link CliContext}
 * (which requires a discoverable `loopback.config.json`) and delegates to
 * {@link runDs}. The internal `runDs` export remains the entry point for
 * unit tests.
 *
 * @internal
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const ctx = await createCliContext({requireConfig: true});
  return runDs({
    projectRoot: ctx.projectRoot,
    config: ctx.config,
    argv,
  });
};
