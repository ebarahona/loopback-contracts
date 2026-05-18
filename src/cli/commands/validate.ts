// `lb-contracts validate` — read-only Ajv pass over every authored file
// (schemas, model configs, datasources, inline `config-bindings`) against
// the freshly-computed `_meta/*.schema.json` documents. Reports errors with
// `instancePath` pointers; never writes anything.
//
// Implementation strategy: spin up a throwaway LB4 `Application`, register
// `ContractsComponent`, bind the project's `loopback.config.json` plus a
// `DefaultProjectPaths`, resolve the `Pipeline`, and call `pipeline.run`
// with `validateOnly: true` and `skipMetaSchemaWrite: true`. The pipeline's
// validation chain (stages 1-6) does all the work; this command only
// shapes the output.
//
// The command is plugin-agnostic about which validation errors fire — any
// `ContractsValidationError` (and only that subclass) is collected and
// rendered grouped by source path. Other thrown errors propagate to the
// dispatcher's `renderError()` handler.

import {Application} from '@loopback/core';
import {relative} from 'node:path';
import {createCliContext} from '../cli-context';
import {ContractsComponent} from '../../contracts.component';
import type {Pipeline} from '../../engine';
import {
  ContractsEngineBindings,
  DefaultProjectPaths,
  InMemoryLossyReporter,
  InMemorySchemaRegistry,
} from '../../engine';
import {ContractsValidationError} from '../../helpers';
import {ContractsBindings} from '../../keys';
import type {LoopbackConfigJson} from '../../types';
import {note} from '../prompts';

/**
 * Arguments accepted by {@link runValidate}.
 *
 * @internal
 */
export interface RunValidateOptions {
  readonly projectRoot: string;
  readonly config: LoopbackConfigJson;
  readonly argv: readonly string[];
}

/**
 * Parsed shape of {@link RunValidateOptions.argv}.
 *
 * @internal
 */
interface ValidateFlags {
  readonly quiet: boolean;
  readonly json: boolean;
  readonly stage: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | undefined;
}

/** Single record in the `--json` payload. */
interface JsonReportEntry {
  readonly stage: string;
  readonly sourcePath: string;
  readonly instancePath: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
}

/**
 * Execute the validation pipeline against `<projectRoot>` and return a
 * shell exit code. `0` if every authored file passed; `1` if any
 * `ContractsValidationError` fired. Any other thrown value propagates to
 * the dispatcher (which renders it through `renderError()`).
 *
 * @internal
 * @param opts - Project root, parsed `loopback.config.json`, and the raw
 *   `argv` slice after the command name.
 * @returns Shell exit code.
 */
export async function runValidate(opts: RunValidateOptions): Promise<number> {
  const flags = parseFlags(opts.argv);

  const app = new Application();
  // Mount the component first; everything else binds AFTER so the
  // runtime-valued instances (`PROJECT_PATHS`, the in-memory reporter and
  // schema-registry instances we own) cannot be shadowed by a later
  // component-side `.toClass()`. The component intentionally omits
  // `TEMPLATE_ENGINE` and `IMPORT_MAP`; this command never reaches the
  // emitter-runner (validateOnly = true), so neither key is required.
  app.component(ContractsComponent);

  const paths = new DefaultProjectPaths(opts.projectRoot, opts.config);
  const reporter = new InMemoryLossyReporter();
  const schemaRegistry = new InMemorySchemaRegistry();

  app.bind(ContractsBindings.CONFIG).to(opts.config);
  app.bind(ContractsBindings.PROJECT_PATHS).to(paths);
  app.bind(ContractsBindings.SCHEMA_REGISTRY).to(schemaRegistry);
  app.bind(ContractsBindings.LOSSY_REPORTER).to(reporter);
  app.bind(ContractsEngineBindings.PROJECT_ROOT_TAG).to(opts.projectRoot);

  let exitCode = 0;
  try {
    // Start lifecycle observers BEFORE resolving the pipeline. The
    // `'contracts'` group includes `ManifestEmitterBooter`, which walks
    // `<projectRoot>/emitters/*.emitter.json` and registers manifest-backed
    // emitters into the `EmitterRegistry`. Without this call, the registry
    // only contains the TS-class built-in emitters, and stage 5's strict
    // `emit.<kind>` meta-schema would reject valid `emit.cloudevents: true`
    // (and similar manifest-only slots) — `lb-contracts gen` accepts the
    // same config because it does call `app.start()`. The booter only
    // needs `PROJECT_PATHS` + `SCHEMA_REGISTRY` (both bound above), so the
    // codegen-only bindings (`TEMPLATE_ENGINE`, `IMPORT_MAP`) that the
    // validate path intentionally omits are not required here.
    await app.start();

    const pipeline = await app.get<Pipeline>(ContractsEngineBindings.PIPELINE);

    const emitFlags: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(opts.config.emit ?? {})) {
      if (typeof v === 'boolean') emitFlags[k] = v;
    }

    // `PipelineRunOptions` (`src/engine/pipeline.ts`) already declares
    // `validateOnly`, `skipMetaSchemaWrite`, and `maxStage`; we build the
    // object without casts so a future type tightening surfaces here at
    // compile time rather than silently drifting at runtime.
    const baseOpts: Parameters<Pipeline['run']>[0] = {
      projectRoot: opts.projectRoot,
      config: opts.config,
      emitFlags,
      validateOnly: true,
      skipMetaSchemaWrite: true,
      skipTsc: true,
    };
    // `maxStage` clamps validation to stages 1..N for partial runs;
    // `validateOnly` already caps the upper bound at 6.
    const runOpts: Parameters<Pipeline['run']>[0] =
      flags.stage === undefined
        ? baseOpts
        : {...baseOpts, maxStage: flags.stage};

    try {
      await pipeline.run(runOpts);
    } catch (err) {
      if (err instanceof ContractsValidationError) {
        exitCode = 1;
        emit(opts.projectRoot, [err], flags);
        return exitCode;
      }
      throw err;
    }

    emit(opts.projectRoot, [], flags);
    return exitCode;
  } finally {
    // Mirror `gen.ts`'s teardown: `app.start()` above fires the
    // `'contracts'` lifecycle group (notably `ManifestEmitterBooter`), so
    // `app.stop()` must run to release whatever those observers acquired.
    // Best-effort — a stop failure during teardown must not mask the
    // validate exit code.
    try {
      await app.stop();
    } catch {
      // Best-effort cleanup; never mask the primary outcome.
    }
  }
}

/**
 * Parse the command-line flags recognised by `validate`. Unknown flags
 * are silently ignored — the dispatcher does the up-front check.
 *
 * Note: `--verbose` is deliberately not recognised. The flag previously
 * sat in the parsed shape as a no-op (the human-mode renderer discarded
 * it via `void verbose;`); per-file `OK` output is awkward to surface
 * here because the validate path collapses every pipeline stage into a
 * single throw and the bound `SchemaRegistry` only knows about loaded
 * schema files, not authored config siblings. Dropping the flag keeps
 * the contract honest — failures already list every affected source.
 */
function parseFlags(argv: readonly string[]): ValidateFlags {
  let quiet = false;
  let json = false;
  let stage: ValidateFlags['stage'] = undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--quiet') quiet = true;
    else if (arg === '--json') json = true;
    else if (arg === '--stage') {
      const next = argv[i + 1];
      const parsed = next !== undefined ? Number.parseInt(next, 10) : NaN;
      // Stage range mirrors `Pipeline.run`'s 1..8 walk. `validateOnly`
      // still caps the effective ceiling at 6 server-side; allowing 7 / 8
      // through the parser keeps the flag in lock-step with the engine
      // surface for ad-hoc partial runs.
      if (parsed >= 1 && parsed <= 8) {
        stage = parsed as ValidateFlags['stage'];
        i += 1;
      }
    } else if (arg !== undefined && arg.startsWith('--stage=')) {
      const parsed = Number.parseInt(arg.slice('--stage='.length), 10);
      if (parsed >= 1 && parsed <= 8) stage = parsed as ValidateFlags['stage'];
    }
  }

  return {quiet, json, stage};
}

/**
 * Render the validation outcome. `errors` is the (possibly empty) list of
 * `ContractsValidationError` instances harvested from the pipeline. The
 * pipeline currently surfaces one error at a time (it throws on first
 * failure); the caller may grow this list once batched reporting lands.
 */
function emit(
  projectRoot: string,
  errors: readonly ContractsValidationError[],
  flags: ValidateFlags,
): void {
  if (flags.json) {
    emitJson(errors);
    return;
  }
  if (flags.quiet) {
    emitQuiet(projectRoot, errors);
    return;
  }
  emitHuman(projectRoot, errors);
}

function emitJson(errors: readonly ContractsValidationError[]): void {
  const payload: JsonReportEntry[] = errors.map(e => ({
    stage: stageOf(e),
    sourcePath: e.sourcePath,
    instancePath: e.instancePath,
    message: e.message,
    severity: 'error',
  }));
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function emitQuiet(
  projectRoot: string,
  errors: readonly ContractsValidationError[],
): void {
  // `--quiet` is the machine-friendly mode (CI / scripts piping stdout):
  // every failure line stays on stdout so a `lb-contracts validate
  // --quiet > failures.log` keeps working unchanged. The trailing banner
  // is the literal token `FAIL` — no `(N files invalid)` denominator
  // because the pipeline throws on the first error, so the count would
  // always be `1` and mislead consumers grepping the line.
  if (errors.length === 0) return;
  const grouped = groupBySource(errors);
  for (const [source, group] of grouped) {
    process.stdout.write(`${rel(projectRoot, source)}:\n`);
    for (const e of group) {
      process.stdout.write(`  x ${e.instancePath || '/'}: ${e.message}\n`);
    }
  }
  process.stdout.write('\nValidation: FAIL\n');
}

function emitHuman(
  projectRoot: string,
  errors: readonly ContractsValidationError[],
): void {
  if (errors.length === 0) {
    note('Validation: PASS', 'lb-contracts validate');
    return;
  }
  // Human mode: failure lines belong on stderr so a developer piping
  // stdout to a file (or another tool) still sees the diagnostic. The
  // PASS/FAIL banner already routes through `note(...)` which the clack
  // facade writes to stderr.
  const grouped = groupBySource(errors);
  for (const [source, group] of grouped) {
    process.stderr.write(`${rel(projectRoot, source)}:\n`);
    for (const e of group) {
      process.stderr.write(`  x ${e.instancePath || '/'}: ${e.message}\n`);
    }
  }
  const invalid = grouped.size;
  note(
    `FAIL (${invalid} file${invalid === 1 ? '' : 's'} invalid)`,
    'lb-contracts validate',
  );
}

/**
 * Bucket errors by `sourcePath` while preserving insertion order. Iteration
 * over the returned map walks files in the order they first reported.
 */
function groupBySource(
  errors: readonly ContractsValidationError[],
): Map<string, ContractsValidationError[]> {
  const out = new Map<string, ContractsValidationError[]>();
  for (const e of errors) {
    const bucket = out.get(e.sourcePath);
    if (bucket === undefined) out.set(e.sourcePath, [e]);
    else bucket.push(e);
  }
  return out;
}

/**
 * Derive a coarse `stage` label from a validation error's message. The
 * pipeline tags every throw with a `stage N:` prefix; the JSON payload
 * surfaces that prefix verbatim so consumers can filter on it.
 */
function stageOf(e: ContractsValidationError): string {
  const match = /^stage (\d+):/.exec(e.message);
  return match && match[1] !== undefined ? `stage-${match[1]}` : 'unknown';
}

function rel(projectRoot: string, p: string): string {
  if (!p.startsWith('/')) return p;
  const r = relative(projectRoot, p);
  return r.length === 0 ? p : r;
}

/**
 * Dispatcher-facing adapter. Builds the standard {@link CliContext}
 * (which requires a discoverable `loopback.config.json`) and delegates to
 * {@link runValidate}. The internal `runValidate` export remains the
 * entry point for unit tests.
 *
 * @internal
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const ctx = await createCliContext({requireConfig: true});
  return runValidate({
    projectRoot: ctx.projectRoot,
    config: ctx.config,
    argv,
  });
};
