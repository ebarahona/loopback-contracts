// `lb-contracts ds <name> --adapter <kind>` — append a new entry to the project's `datasources.json`.
//
// One-shot scaffolder: refuses to overwrite an existing entry. Creates the
// file if missing, complete with the `$schema` reference VS Code needs for
// `_meta/datasources.schema.json` autocomplete. Prompts interactively (via
// `@clack/prompts`) for any missing required field when a TTY is attached;
// runs silently when invoked from a script with everything pre-flagged.
//
// See `loopback-contracts.md` §"CLI command reference" — entry for `lb-contracts ds`.

import {existsSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {applyEdits, format, modify} from 'jsonc-parser';
import {createCliContext} from '../cli-context';
import {
  ContractsError,
  ContractsValidationError,
  readDatasourcesDoc,
} from '../../helpers';
import type {LoopbackConfigJson} from '../../types';
import {note, select, text} from '../prompts';

/**
 * Code raised by `../prompts` when the user cancels — mirrors the
 * dispatcher's own constant so this command's catch block stays
 * decoupled from the helper module.
 */
const CANCEL_CODE = 'CONTRACTS_CLI_CANCELLED';

/**
 * Credential-bearing field names. Any literal (non env-ref) value parsed
 * into one of these slots triggers a stderr warning before write, unless
 * the user opts out with `--allow-literal-secrets`. The list is
 * intentionally broad — every connector with a "shared-secret" auth model
 * uses at least one of these key names, and a single source of truth
 * keeps the warning surface uniform across `--password`, the matching
 * `--<field>-env` flags, and the URL-userinfo check.
 */
const CREDENTIAL_FIELDS: readonly string[] = [
  'password',
  'secret',
  'apiKey',
  'token',
  'accessKey',
  'accessSecret',
  'clientSecret',
];

/**
 * Regex for the env-ref escape — a single `${VAR_NAME}` placeholder that
 * the runtime resolves from `process.env`. Values matching this pattern
 * are safe to persist verbatim and do NOT trigger the literal-secret
 * warning.
 */
const ENV_REF_RE = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

/** Bare env-var-name grammar used to validate `--<field>-env <NAME>`. */
const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Flags `lb-contracts ds` recognises as first-class — everything else is
 * pass-through. Includes the credential-companion `--<field>-env` flags
 * (one per {@link CREDENTIAL_FIELDS} entry) plus `--allow-literal-secrets`
 * to suppress the literal-credential warning.
 */
const KNOWN_FLAGS = new Set<string>([
  'adapter',
  'url',
  'database',
  'host',
  'port',
  'user',
  'password',
  'allow-literal-secrets',
  ...CREDENTIAL_FIELDS.map(f => `${kebab(f)}-env`),
]);

/** Convert `camelCase` to `kebab-case` for CLI flag rendering. */
function kebab(s: string): string {
  return s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

/** Adapter kinds offered by the interactive picker. */
type AdapterChoice =
  | 'mongodb'
  | 'postgres'
  | 'mysql'
  | 'redis'
  | 'memory'
  | 'other';

/**
 * Parsed, normalised command-line arguments for one `lb-contracts ds` invocation.
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
  /**
   * Credential-bearing values keyed by canonical field name (e.g.
   * `password`, `apiKey`). Populated from either the direct literal flag
   * (e.g. `--password mysecret`) or the env-ref flag (e.g.
   * `--password-env POSTGRES_PASSWORD`, which lands here as
   * `"${POSTGRES_PASSWORD}"`). Lives separately from the named slots so
   * the warning + conflict checks can scan a single map.
   */
  credentials: Record<string, string>;
  /** User opted out of the literal-credential warning. */
  allowLiteralSecrets: boolean;
  /** Additional `--<key> <value>` pairs the user passed through. */
  passthrough: Record<string, string>;
}

/**
 * Run `lb-contracts ds <name> --adapter <kind>`. Returns `0` on success, non-zero on user-visible
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
          `lb-contracts ds: missing required ${missing.join(', ')} ` +
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
      process.stderr.write(
        'lb-contracts ds: internal error: name or adapter empty.\n',
      );
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

    // Emit a stderr warning for any credential-bearing literal that the
    // user did not opt out of via `--allow-literal-secrets`. This is the
    // last gate before the value lands in `datasources.json` — once
    // written, the only safe recovery is rotating the credential and
    // scrubbing git history, both of which are out-of-band for this CLI.
    warnLiteralCredentials(parsed);

    const entry = buildEntry(parsed);
    await writeDatasourceEntry(datasourcesPath, name, entry);

    note(
      [
        `Added datasource '${name}' (adapter: ${adapter}).`,
        '',
        `  ${datasourcesPath}`,
        '',
        'Next: bind a contract to this datasource via `lb-contracts contract <name>` ' +
          'or hand-edit an existing `configs/*.config.json`, ' +
          'then run `lb-contracts gen`.',
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
  const out: ParsedArgs = {
    passthrough: {},
    credentials: {},
    allowLiteralSecrets: false,
  };
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
      // Boolean flags (no value expected) must NOT consume the following
      // positional — guard them explicitly. Add new boolean flags here.
      const isBooleanFlag = key === 'allow-literal-secrets';
      const next = argv[i + 1];
      if (!isBooleanFlag && next !== undefined && !next.startsWith('--')) {
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
  // Anything past the first positional is ignored — `lb-contracts ds` takes one name.
  return out;
}

/** Dispatch a `--<key>` flag into the correct named slot or `passthrough`. */
function assignFlag(out: ParsedArgs, key: string, value: string): void {
  // Credential env-ref companion flags (`--password-env`, `--api-key-env`,
  // ...). Validate the env-var name, then store the resolved
  // `${VAR_NAME}` placeholder under the canonical field name so the
  // write path treats it exactly like a literal value would be — except
  // it's safe to commit. Conflict with a direct `--password` is checked
  // in `assertCredentialFlagsConsistent` after parsing completes; here
  // we only stash the placeholder.
  const envMatch = matchCredentialEnvFlag(key);
  if (envMatch !== undefined) {
    if (!ENV_VAR_NAME_RE.test(value)) {
      throw new ContractsValidationError(
        `--${key} expects an env-var name matching ${ENV_VAR_NAME_RE.source}; ` +
          `got '${value}'.`,
        {sourcePath: '<argv>', instancePath: `/${key}`},
      );
    }
    setCredential(out, envMatch, `\${${value}}`, key);
    return;
  }

  if (key === 'allow-literal-secrets') {
    out.allowLiteralSecrets = true;
    return;
  }

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
        setCredential(out, 'password', value, key);
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

  // Pass-through flags may still carry credentials (e.g. `--apiKey` for a
  // connector this CLI doesn't model first-class). Mirror those into the
  // credentials map so the warning path catches them too.
  if (CREDENTIAL_FIELDS.includes(key)) {
    setCredential(out, key, value, key);
  }
  out.passthrough[key] = value;
}

/**
 * Map a `--<field>-env` flag back to its canonical credential field name,
 * or `undefined` if the flag is not a credential env-ref companion. Used
 * by {@link assignFlag} so the env-ref dispatch happens in one place.
 */
function matchCredentialEnvFlag(key: string): string | undefined {
  for (const field of CREDENTIAL_FIELDS) {
    if (key === `${kebab(field)}-env`) return field;
  }
  return undefined;
}

/**
 * Record a credential value under `field`, rejecting the case where the
 * same field is filled from two conflicting sources (e.g. both
 * `--password mysecret` and `--password-env POSTGRES_PASSWORD`).
 */
function setCredential(
  out: ParsedArgs,
  field: string,
  value: string,
  flag: string,
): void {
  const existing = out.credentials[field];
  if (existing !== undefined && existing !== value) {
    throw new ContractsValidationError(
      `cannot pass both --${kebab(field)} and --${kebab(field)}-env ` +
        '(conflicting sources for the same credential).',
      {sourcePath: '<argv>', instancePath: `/${flag}`},
    );
  }
  out.credentials[field] = value;
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
  // Credentials (including the `${VAR_NAME}` placeholder produced by
  // `--<field>-env`) ride through `parsed.credentials`; `--password`
  // populates the same slot so this loop is the single write site for
  // every credential-bearing field.
  for (const [field, value] of Object.entries(parsed.credentials)) {
    if (value === '') continue;
    entry[field] = value;
  }
  for (const [key, value] of Object.entries(parsed.passthrough)) {
    if (value === '') continue;
    // Skip pass-through keys already written via the credentials map to
    // avoid double-writing the same field.
    if (CREDENTIAL_FIELDS.includes(key)) continue;
    entry[key] = value;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Credential-warning gate — last stop before write
// ---------------------------------------------------------------------------

/**
 * Walk every credential-bearing field on `parsed` plus the URL userinfo
 * component, emitting a single multi-line stderr warning per offending
 * value. The warning is suppressed when the user passed
 * `--allow-literal-secrets`. Env-ref values (`${VAR}`) are always
 * skipped — they are the recommended-and-safe shape.
 *
 * Routed through `process.stderr.write` so a script piping stdout from
 * `lb-contracts ds` does not see the warning interleaved with the
 * command's structured output.
 */
function warnLiteralCredentials(parsed: ParsedArgs): void {
  if (parsed.allowLiteralSecrets) return;

  for (const field of CREDENTIAL_FIELDS) {
    const value = parsed.credentials[field];
    if (value === undefined || value === '') continue;
    if (ENV_REF_RE.test(value)) continue;
    emitLiteralWarning(`--${kebab(field)}`);
  }

  // URL-shaped credential leak — `--url postgres://u:p@host/db` smuggles a
  // password into the userinfo segment. Refuse silently if the URL won't
  // parse (the meta-schema will catch shape errors downstream) — only
  // warn on a confirmed credential to avoid false positives on adapter
  // strings that aren't WHATWG URLs.
  if (parsed.url !== undefined && parsed.url !== '') {
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = new URL(parsed.url);
    } catch {
      parsedUrl = undefined;
    }
    if (parsedUrl !== undefined && parsedUrl.password.length > 0) {
      // URL-userinfo gets a bespoke message — there is no `--url-env`
      // companion flag; the right fix is to embed `${VAR}` directly in
      // the URL itself.
      process.stderr.write(
        'Warning: --url contains a userinfo password. ' +
          'This will be persisted in datasources.json as plaintext.\n' +
          'Recommended: embed an `${VAR}` placeholder inside the URL ' +
          '(e.g. `postgres://user:${PG_PASSWORD}@host/db`) so the ' +
          'credential resolves from process.env at runtime.\n' +
          'Pass --allow-literal-secrets to suppress this warning.\n',
      );
    }
  }
}

/** Format and write the canonical literal-credential warning to stderr. */
function emitLiteralWarning(flag: string): void {
  // `flag` is `--<kebab-field>` for credential fields; the matching
  // env-companion is `--<kebab-field>-env`.
  const fieldFlag = flag.startsWith('--') ? flag.slice(2) : flag;
  process.stderr.write(
    `Warning: ${flag} received a literal value. ` +
      'This will be persisted in datasources.json as plaintext.\n' +
      `Recommended: use \`--${fieldFlag}-env <NAME>\` to write a ` +
      '`${NAME}` placeholder that resolves from process.env at runtime.\n' +
      'Pass --allow-literal-secrets to suppress this warning.\n',
  );
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
 * The actual read + JSONC parse is delegated to
 * {@link readDatasourcesDoc} so every CLI surface that touches
 * `datasources.json` (`ds`, `contract`, the engine pipeline) produces
 * an identical error block on corruption — path, JSONC error code, and
 * the 1-based line:col where parsing went off the rails.
 *
 * Existing-but-unreadable / malformed file is a hard failure: the helper
 * throws a {@link ContractsValidationError} that propagates through the
 * caller's try/catch and is re-thrown to the dispatcher's `renderError`.
 * Silently treating it as `{}` would let duplicate detection be bypassed
 * and would clobber any user comment containing the original (broken)
 * content — the user must fix `datasources.json` before `lb-contracts ds`
 * can run.
 *
 * The array-form (legacy `[{name, adapter, ...}]`) layout is rejected
 * here: `lb-contracts ds` only writes the keyed-map shape, and inserting
 * a new entry into an array would silently change the document's
 * structure. Users mid-migration must convert by hand.
 */
function readDatasources(path: string): Record<string, unknown> {
  const doc = readDatasourcesDoc(path);
  if (doc === undefined) {
    return {$schema: './_meta/datasources.schema.json'};
  }

  if (Array.isArray(doc)) {
    throw new ContractsValidationError(
      `datasources.json at ${path} must be a JSON object ` +
        '(keyed-map of datasource entries) for `lb-contracts ds`; ' +
        'the legacy array-of-objects shape is read-only. ' +
        'Convert the file by hand before re-running.',
      {sourcePath: path, instancePath: ''},
    );
  }

  // `Array.isArray` narrowed away the `readonly unknown[]` arm, but TS
  // doesn't fold `readonly`-tagged tuple types out of the union here —
  // re-cast to the keyed-map member explicitly.
  return doc as Record<string, unknown>;
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
