// Builds a per-invocation context for each CLI command — project root
// plus the optional `loopback.config.json`. Centralising discovery here
// keeps the command files free of filesystem walking and ensures the
// dispatcher → context → command flow Just Works for every subcommand.
//
// Each command rebuilds its own LB4 `Application` because the bindings
// they need differ (some want `ContractsComponent` alone, some need
// `PROJECT_PATHS` + `IMPORT_MAP`, `init` doesn't need an app at all).
// `createCliContext` deliberately does NOT pre-boot one — see the
// "Why no shared Application" rationale on {@link CliContext}.

import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import type {ErrorObject, ValidateFunction} from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser';
import {buildLoopbackConfigMetaSchema} from '../engine/meta-schema-generator';
import {
  ContractsError,
  ContractsValidationError,
  offsetToLineCol,
} from '../helpers';
import type {LoopbackConfigJson} from '../types';

/**
 * Name of the per-project configuration file the CLI walks up the
 * directory tree to find. Same name across every command.
 *
 * @public
 */
export const PROJECT_CONFIG_FILENAME = 'loopback.config.json';

/**
 * Options accepted by {@link createCliContext}.
 *
 * @public
 */
export interface CliContextOptions {
  /** Directory to start project-root discovery from. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * When `true`, throw `CONTRACTS_CLI_NO_PROJECT` if no
   * `loopback.config.json` is discovered — and narrow the return type to
   * {@link CliContextWithConfig} so call sites get `config` typed as
   * present with no follow-up assertion.
   *
   * Defaults to `false`: returns the {@link CliContext} discriminated
   * union so commands like `init` (which writes the file) can run from a
   * project root that doesn't yet have one.
   */
  requireConfig?: boolean;
}

/**
 * Per-invocation context every command file receives. Bundles the
 * discovered project root and the parsed config (when present).
 *
 * Discriminated on `kind` so commands that require a config (every
 * subcommand except `init`) can assert the right variant and reach
 * `config` / `configPath` without `!`-asserting non-null values.
 *
 * Why no shared `Application`: every command's binding graph differs
 * (some need `PROJECT_PATHS`, some only need the component, `init`
 * needs nothing). A v1.0 pre-boot would either over-bind for the
 * lightweight commands or under-bind for the heavyweight ones. The
 * per-command bootstrap costs nothing measurable and keeps each
 * command's DI surface auditable in one place.
 *
 * @public
 */
export type CliContext = CliContextWithConfig | CliContextInit;

/** Variant returned when `loopback.config.json` was located and parsed. */
export interface CliContextWithConfig {
  readonly kind: 'with-config';
  /** Absolute path to the directory containing `loopback.config.json`. */
  readonly projectRoot: string;
  /** Parsed `loopback.config.json`. */
  readonly config: LoopbackConfigJson;
  /** Absolute path to `loopback.config.json`. */
  readonly configPath: string;
}

/**
 * Variant returned when no config was discovered AND the caller did NOT
 * pass `requireConfig: true` (only `init` should take this path).
 * `config` / `configPath` are typed `undefined` here so the discriminated
 * union narrows symmetrically — branches that need them must first assert
 * `ctx.kind === 'with-config'`.
 */
export interface CliContextInit {
  readonly kind: 'init';
  readonly projectRoot: string;
  readonly config?: undefined;
  readonly configPath?: undefined;
}

/**
 * Type guard: narrow a {@link CliContext} to the with-config variant,
 * throwing `CONTRACTS_CLI_NO_PROJECT` when the context is the `init`
 * variant. Most callers should prefer
 * `createCliContext({requireConfig: true})` which returns the narrowed
 * variant directly; this helper stays
 * exported for edge cases (e.g., commands that branch on config presence
 * mid-flow).
 *
 * @public
 */
export function assertCliContextHasConfig(
  ctx: CliContext,
): asserts ctx is CliContextWithConfig {
  if (ctx.kind !== 'with-config') {
    throw new ContractsError(
      'CONTRACTS_CLI_NO_PROJECT',
      `No ${PROJECT_CONFIG_FILENAME} found. Run \`lb-contracts init\` first.`,
    );
  }
}

/**
 * Walk up from `start` looking for `loopback.config.json`. Returns the
 * directory holding the file, or `undefined` when no ancestor has one.
 *
 * @internal
 */
function findProjectRoot(start: string): string | undefined {
  let dir = resolve(start);
  // Stop when `dirname` returns the same path — we've hit the FS root.
  for (;;) {
    if (existsSync(resolve(dir, PROJECT_CONFIG_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Lazily-compiled validator for `loopback.config.json` shape. The
 * meta-schema is identical across calls (it does not depend on the
 * caller's project state), so compiling it once per process keeps
 * subcommand startup fast.
 *
 * Real emitter-kind discovery in the CLI bootstrap is out of scope for
 * this fix — passing `[]` keeps the `emit.*` enum permissive, matching
 * the existing engine fallback when no installed-kinds list is supplied.
 *
 * @internal
 */
let cachedConfigValidator: ValidateFunction | undefined;
function getConfigValidator(): ValidateFunction {
  if (cachedConfigValidator === undefined) {
    const ajv = new Ajv2020({strict: false, allErrors: true});
    cachedConfigValidator = ajv.compile(buildLoopbackConfigMetaSchema([]));
  }
  return cachedConfigValidator;
}

/**
 * Render Ajv `ErrorObject`s as a multi-line bullet list naming each
 * offending field. Mirrors the format used elsewhere in the engine so
 * config-shape diagnostics read identically whether they surface from
 * the pipeline or from the CLI bootstrap.
 *
 * @internal
 */
function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return '  (no error details)';
  return errors
    .map(e => {
      const path = e.instancePath.length === 0 ? '<root>' : e.instancePath;
      return `  - ${path} ${e.message ?? ''} [keyword=${e.keyword}]`;
    })
    .join('\n');
}

/**
 * Read and JSONC-parse `loopback.config.json` at the given path, then
 * meta-schema-validate the result. The Ajv pass catches misspelled
 * emitter keys (`emit.zodd`), invalid `validator` values, malformed
 * `schemas` arrays, and bad import settings at the CLI boundary —
 * before any downstream consumer can act on the bad shape.
 *
 * @internal
 */
function readConfig(path: string): LoopbackConfigJson {
  const raw = readFileSync(path, 'utf8');
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as LoopbackConfigJson;
  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    const {line, column} = offsetToLineCol(raw, first.offset);
    const kind = printParseErrorCode(first.error);
    const suffix =
      errors.length > 1 ? ` (+${errors.length - 1} more error(s))` : '';
    throw new ContractsError(
      'CONTRACTS_CLI_CONFIG_INVALID',
      `JSONC parse error at line ${line}, col ${column}: ${kind} ` +
        `(${path})${suffix}`,
    );
  }
  const validate = getConfigValidator();
  if (!validate(parsed)) {
    const first = validate.errors?.[0];
    const instancePath = first?.instancePath ?? '';
    const field = instancePath.length === 0 ? '<root>' : instancePath;
    throw new ContractsValidationError(
      `loopback.config.json at ${path} failed meta-schema validation ` +
        `(first invalid field: ${field}):\n${formatErrors(validate.errors)}`,
      {sourcePath: path, instancePath},
    );
  }
  return parsed;
}

/**
 * Build a {@link CliContext} for a single CLI invocation. Lightweight
 * (no I/O beyond reading the discovered config file).
 *
 * Two call shapes:
 *
 * - `createCliContext({requireConfig: true})` — throws
 *   `CONTRACTS_CLI_NO_PROJECT` if no `loopback.config.json` is found, and
 *   returns the narrowed {@link CliContextWithConfig}. Use this from
 *   every command that needs to read project state (gen, contract, ds,
 *   override, validate).
 *
 * - `createCliContext()` / `createCliContext({requireConfig: false})` —
 *   returns the {@link CliContext} discriminated union; the `init`
 *   command takes this path so it can run from a directory that doesn't
 *   yet have a config file.
 *
 * @param opts - Discovery flags.
 * @returns A ready-to-use context, narrowed when `requireConfig: true`.
 *
 * @public
 */
export async function createCliContext(
  opts: CliContextOptions & {requireConfig: true},
): Promise<CliContextWithConfig>;
export async function createCliContext(
  opts?: CliContextOptions & {requireConfig?: false},
): Promise<CliContext>;
export async function createCliContext(
  opts: CliContextOptions = {},
): Promise<CliContext> {
  const cwd = opts.cwd ?? process.cwd();
  const discovered = findProjectRoot(cwd);

  if (discovered === undefined && opts.requireConfig === true) {
    throw new ContractsError(
      'CONTRACTS_CLI_NO_PROJECT',
      `No ${PROJECT_CONFIG_FILENAME} found in ${cwd} or any parent directory. Run \`lb-contracts init\` first.`,
    );
  }

  const projectRoot = discovered ?? cwd;
  if (discovered !== undefined) {
    const configPath = resolve(discovered, PROJECT_CONFIG_FILENAME);
    const config = readConfig(configPath);
    return {
      kind: 'with-config',
      projectRoot,
      config,
      configPath,
    };
  }
  return {
    kind: 'init',
    projectRoot,
  };
}
