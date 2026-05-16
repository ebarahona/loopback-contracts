import {Application, BindingScope} from '@loopback/core';
import {watch, type FSWatcher} from 'chokidar';
import {join, relative, resolve} from 'node:path';

import {createCliContext} from '../cli-context';
import {intro, outro, spinner} from '../prompts';
import {renderError} from '../render-error';
import {ContractsComponent} from '../../contracts.component';
import {
  DefaultProjectPaths,
  EjsTemplateEngine,
  RelativeImportMap,
} from '../../engine';
import type {Pipeline, PipelineResult, PipelineRunOptions} from '../../engine';
import {ContractsEngineBindings} from '../../engine/tokens';
import {
  getEmitEsm,
  getEmitImportExtension,
  type ImportMap,
  type SchemaRegistry,
} from '../../interfaces';
import {ContractsBindings} from '../../keys';
import type {EmitValue, LoopbackConfigJson} from '../../types';

/** Valid values for `--import-extension`. */
const VALID_IMPORT_EXTENSIONS = ['.js', '.ts', ''] as const;
type ImportExtension = (typeof VALID_IMPORT_EXTENSIONS)[number];

/* eslint-disable no-console */

/**
 * Total stages the engine pipeline runs through end-to-end. Mirrors the
 * literal stage-count `Pipeline.run` walks (see `engine/pipeline.ts`).
 * Centralising it keeps the user-facing "running N-stage pipeline" and
 * "stages M/N" strings in lock-step with the engine.
 */
const PIPELINE_STAGES = 8;

/**
 * Thin CLI wrapper around {@link Pipeline.run}.
 *
 * Bootstraps a one-off LB4 {@link Application} wired with
 * {@link ContractsComponent}, parses the gen-specific flags (including the
 * nine `--emit-<kind>` and matching `--no-emit-<kind>` overrides, the ESM
 * trio `--esm` / `--no-esm` / `--import-extension=<.js|.ts|>`, plus
 * `--watch` / `dev`-mode), invokes the pipeline once, and either exits or
 * keeps a debounced chokidar watcher running on every authored source file.
 *
 * @param opts - Project root, parsed `loopback.config.json`, and the raw
 *   argv slice (the dispatcher strips the leading subcommand name).
 * @returns Process exit code — `0` on success, non-zero on any pipeline or
 *   validation failure.
 *
 * @internal
 */
export async function runGen(opts: {
  projectRoot: string;
  config: LoopbackConfigJson;
  argv: readonly string[];
}): Promise<number> {
  const flags = parseFlags(opts.argv);
  const isWatch = flags.watch;

  const app = await bootstrap(opts.projectRoot, opts.config);

  try {
    if (isWatch) {
      return await runWatchMode(app, opts, flags);
    }
    return await runOnce(app, opts, flags);
  } finally {
    try {
      await app.stop();
    } catch {
      // Best-effort: a stop failure during teardown should not mask the
      // original exit code.
    }
  }
}

// ---------------------------------------------------------------------------
// One-shot mode
// ---------------------------------------------------------------------------

async function runOnce(
  app: Application,
  opts: {projectRoot: string; config: LoopbackConfigJson},
  flags: ParsedFlags,
): Promise<number> {
  intro('lb4 gen');
  const spin = spinner();
  spin.start(`Running ${PIPELINE_STAGES}-stage pipeline`);

  const pipeline = await app.get<Pipeline>(ContractsEngineBindings.PIPELINE);

  try {
    const result = await pipeline.run(buildRunOptions(opts, flags));
    spin.stop(
      `Pipeline complete (${result.stagesRun}/${PIPELINE_STAGES} stages)`,
    );
    printRunSummary(result, opts.projectRoot);
    outro(
      `Generated ${result.filesWritten.length} files. ` +
        'Run again with `lb4 gen --watch` for continuous regen.',
    );
    return 0;
  } catch (err) {
    spin.stop('Pipeline failed', 1);
    // Use the shared formatter and write to stderr so consumers piping
    // stdout to a file still see the error block.
    process.stderr.write(renderError(err));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

async function runWatchMode(
  app: Application,
  opts: {projectRoot: string; config: LoopbackConfigJson},
  flags: ParsedFlags,
): Promise<number> {
  const pipeline = await app.get<Pipeline>(ContractsEngineBindings.PIPELINE);

  // Construct the watcher and install signal handlers BEFORE the first
  // iteration runs. A long initial pipeline (e.g. a large schema set on a
  // cold cache) used to swallow SIGINT entirely; the user would have to
  // wait for it to finish before Ctrl+C took effect. Setting up the
  // shutdown path first means the very first ^C cleanly cancels the
  // watcher even if the initial run is still in flight.
  const watcher = createWatcher(opts.projectRoot, opts.config);

  let pending: NodeJS.Timeout | undefined;
  let queued: string | undefined;
  let firstQueuedAt: number | undefined;
  const debounceMs = 250;
  /**
   * Hard ceiling on how long a flurry of `change` events can keep
   * resetting the debounce window. Without it, a tool that writes a
   * file every ~200ms (`tsc --watch`, some IDE save-on-blur paths)
   * could starve the regen indefinitely.
   */
  const maxWaitMs = 5000;

  const fire = (): void => {
    pending = undefined;
    firstQueuedAt = undefined;
    const trigger = queued ?? '<unknown>';
    queued = undefined;
    void (async (): Promise<void> => {
      printDivider();
      const rel = relative(opts.projectRoot, trigger) || trigger;
      console.log(`[${stamp()}] Changed: ${rel} — regenerating...`);
      await runWatchIteration(pipeline, opts, flags, trigger);
    })();
  };

  const scheduleRerun = (changedPath: string): void => {
    queued = changedPath;
    const now = Date.now();
    if (firstQueuedAt === undefined) firstQueuedAt = now;
    if (pending !== undefined) clearTimeout(pending);
    const remaining = maxWaitMs - (now - firstQueuedAt);
    const wait = remaining <= 0 ? 0 : Math.min(debounceMs, remaining);
    pending = setTimeout(fire, wait);
  };

  return await new Promise<number>(res => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      printDivider();
      console.log(`[${stamp()}] Stopping watcher...`);
      if (pending !== undefined) {
        clearTimeout(pending);
        pending = undefined;
      }
      // Always await the watcher's own teardown before resolving so the
      // caller's `finally { await app.stop(); }` in `runGen` doesn't race
      // an in-flight chokidar `close()` (and therefore leak file
      // descriptors / inotify watches on Linux).
      void watcher.close().then(
        () => res(0),
        () => res(0),
      );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    watcher.on('add', scheduleRerun);
    watcher.on('change', scheduleRerun);
    watcher.on('unlink', scheduleRerun);
    watcher.on('error', err => {
      console.log(`[${stamp()}] watcher error: ${(err as Error).message}`);
    });

    // Kick off the initial run only after handlers are wired. If it
    // throws, `runWatchIteration` already prints the error; we keep the
    // watcher alive so the user can save a fix and trigger a re-run.
    printDivider();
    console.log(`[${stamp()}] lb4 gen --watch — initial run`);
    void runWatchIteration(pipeline, opts, flags, '<initial>');
  });
}

async function runWatchIteration(
  pipeline: Pipeline,
  opts: {projectRoot: string; config: LoopbackConfigJson},
  flags: ParsedFlags,
  trigger: string,
): Promise<void> {
  try {
    // `Pipeline.run` clears its bound `LossyReporter` at stage 0 and
    // returns a per-run snapshot on `result.lossy`. Reading directly off
    // the returned summary (instead of the long-lived reporter binding)
    // guarantees we render only the current iteration's lossy entries
    // without depending on private engine reset semantics or holding a
    // reporter reference whose interface does not expose a `clear()`.
    const result = await pipeline.run(buildRunOptions(opts, flags));
    console.log(
      `[${stamp()}] OK: wrote ${result.filesWritten.length} files ` +
        `(stages ${result.stagesRun}/${PIPELINE_STAGES}, ` +
        `trigger: ${shortTrigger(trigger, opts.projectRoot)})`,
    );
    for (const lossy of result.lossy) {
      console.log(
        `  [${lossy.severity}] ${lossy.feature} @ ${lossy.source.schemaId}` +
          (lossy.source.propertyPath ? `:${lossy.source.propertyPath}` : '') +
          ` — ${lossy.message}`,
      );
    }
  } catch (err) {
    console.log(`[${stamp()}] FAIL`);
    process.stderr.write(renderError(err));
  }
}

function createWatcher(
  projectRoot: string,
  config: LoopbackConfigJson,
): FSWatcher {
  const schemasDir = resolve(projectRoot, config.schemasDir);
  const configsDir = resolve(projectRoot, config.configsDir);
  const paths: string[] = [
    join(schemasDir, '**/*.schema.json'),
    join(configsDir, '**/*.config.json'),
    resolve(projectRoot, 'datasources.json'),
    resolve(projectRoot, 'loopback.config.json'),
    join(projectRoot, 'emitters', '*.emitter.json'),
  ];
  return watch(paths, {
    ignoreInitial: true,
    persistent: true,
    // Editor saves (especially atomic writes from VS Code/IntelliJ) often
    // fire several rapid `change` events as the file is renamed into
    // place. `awaitWriteFinish` debounces by polling size+mtime and only
    // emits once the file has been stable for `stabilityThreshold` ms.
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 50,
    },
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(
  projectRoot: string,
  config: LoopbackConfigJson,
): Promise<Application> {
  const app = new Application();

  // Mount the component first so its emitter / source / engine bindings
  // are in place; runtime-valued singletons are then bound below where the
  // CLI knows the project root + parsed config. The component is
  // deliberately silent on `PROJECT_PATHS`, `TEMPLATE_ENGINE`, and
  // `IMPORT_MAP` because their backing classes need constructor args the
  // container cannot provide — see `contracts.component.ts`.
  app.component(ContractsComponent);

  // Config + project-paths next — engine pieces read them via inject().
  app.bind(ContractsBindings.CONFIG).to(config);
  app.bind(ContractsEngineBindings.PROJECT_ROOT_TAG).to(projectRoot);

  const paths = new DefaultProjectPaths(projectRoot, config);
  app.bind(ContractsBindings.PROJECT_PATHS).to(paths);

  // EjsTemplateEngine and RelativeImportMap take constructor args, so they
  // can't go through `app.service()`. Wire them via `toDynamicValue`.
  app
    .bind(ContractsBindings.TEMPLATE_ENGINE)
    .toDynamicValue(() => new EjsTemplateEngine(paths.outputDir))
    .inScope(BindingScope.SINGLETON);

  app
    .bind(ContractsBindings.IMPORT_MAP)
    .toDynamicValue(resolutionCtx => {
      const registry = resolutionCtx.context.getSync<SchemaRegistry>(
        ContractsBindings.SCHEMA_REGISTRY,
      );
      const map: ImportMap = new RelativeImportMap(registry, schemaId =>
        defaultTargetPath(paths.outputDir, schemaId),
      );
      return map;
    })
    .inScope(BindingScope.SINGLETON);

  // `ManifestEmitterBooter`'s lifecycle is owned by `ContractsComponent`
  // (added via `createBindingFromClass(...)` with `lifeCycleObserver`
  // metadata). A second `app.lifeCycleObserver(ManifestEmitterBooter)`
  // call here would register the booter twice and run its `start()` hook
  // twice on every CLI invocation — once from the component-side class
  // binding, once from the duplicate observer slot.

  await app.start();
  return app;
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

/** Nine sidecar emitter kinds the `--emit-*` / `--no-emit-*` flags target. */
const EMITTER_KINDS = [
  'zod',
  'types',
  'graphql',
  'cloudevents',
  'asyncapi',
  'proto',
  'avro',
  'openapi-components',
  'mock-data',
] as const;

/**
 * Every literal flag `lb4 gen` recognises (excluding the dynamic
 * `--[no-]emit-<kind>` family which is matched separately). Maintained
 * by hand so a typo like `--emit-zog` falls through to the warning path
 * rather than landing silently in an `emitOverrides` slot the engine
 * never reads.
 */
const KNOWN_LITERAL_FLAGS: ReadonlySet<string> = new Set([
  '--watch',
  '--strict',
  '--allow-breaking',
  '--skip-tsc',
  '--verbose',
  '--emit-graphql-sdl',
  '--esm',
  '--no-esm',
  '--import-extension',
]);

interface ParsedFlags {
  readonly watch: boolean;
  readonly strict: boolean;
  readonly allowBreaking: boolean;
  readonly skipTsc: boolean;
  readonly verbose: boolean;
  readonly graphqlSdl: boolean;
  /** Map of emitter kind to override (`true` enable, `false` disable). */
  readonly emitOverrides: Readonly<Record<string, boolean>>;
  /**
   * Tri-state ESM mode override:
   *   - `true`  → `--esm` was passed (force ESM on, overrides config)
   *   - `false` → `--no-esm` was passed (force ESM off, overrides config)
   *   - `undefined` → neither flag was passed (fall through to config / default)
   */
  readonly esm: boolean | undefined;
  /**
   * `--import-extension=<value>` override, or `undefined` when the flag
   * wasn't passed. Empty string is a valid value (bundler resolution).
   */
  readonly importExtension: ImportExtension | undefined;
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  let watchMode = false;
  let strict = false;
  let allowBreaking = false;
  let skipTsc = false;
  let verbose = false;
  let graphqlSdl = false;
  let esm: boolean | undefined;
  let importExtension: ImportExtension | undefined;
  const emitOverrides: Record<string, boolean> = {};

  // The dispatcher invokes us with either `gen [...args]` or `dev [...args]`;
  // either form may forward the leading subcommand verbatim. Treat a leading
  // `dev` as the watch alias.
  const args = argv.slice();
  if (args[0] === 'dev') {
    watchMode = true;
    args.shift();
  } else if (args[0] === 'gen') {
    args.shift();
  }

  // Index loop (not `for…of`) so `--import-extension <value>` can consume
  // the next argv slot when used in space-separated form.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--watch') {
      watchMode = true;
      continue;
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--allow-breaking') {
      allowBreaking = true;
      continue;
    }
    if (arg === '--skip-tsc') {
      skipTsc = true;
      continue;
    }
    if (arg === '--verbose') {
      verbose = true;
      continue;
    }
    if (arg === '--emit-graphql-sdl') {
      graphqlSdl = true;
      // SDL implies the graphql emitter itself is on.
      emitOverrides['graphql'] = true;
      continue;
    }
    if (arg === '--esm') {
      esm = true;
      continue;
    }
    if (arg === '--no-esm') {
      esm = false;
      continue;
    }
    // `--import-extension=<value>` (joined) — empty string is valid.
    if (arg.startsWith('--import-extension=')) {
      const raw = arg.slice('--import-extension='.length);
      importExtension = validateImportExtension(raw);
      continue;
    }
    // `--import-extension <value>` (space-separated). The next token is
    // the value even if it looks like another flag — explicit empty must
    // use the `=` form (`--import-extension=`).
    if (arg === '--import-extension') {
      const next = args[i + 1];
      if (next === undefined) {
        throw new TypeError(
          "--import-extension requires a value (.js, .ts, or '' for " +
            'bundler resolution). Use `--import-extension=` to pass an ' +
            'empty value.',
        );
      }
      importExtension = validateImportExtension(next);
      i++;
      continue;
    }
    const noEmit = matchEmitFlag(arg, '--no-emit-');
    if (noEmit !== undefined) {
      emitOverrides[noEmit] = false;
      continue;
    }
    const emit = matchEmitFlag(arg, '--emit-');
    if (emit !== undefined) {
      emitOverrides[emit] = true;
      continue;
    }
    // Unknown flag — warn once to stderr but keep going so a single
    // typo doesn't abort a long pipeline run. Bare positional tokens
    // (no leading `--`) are silently passed through; the dispatcher
    // already strips the subcommand name above.
    if (arg.startsWith('--') && !KNOWN_LITERAL_FLAGS.has(arg)) {
      const bare = arg.slice(2);
      const looksLikeEmit =
        bare.startsWith('emit-') || bare.startsWith('no-emit-');
      const hint = looksLikeEmit
        ? ` Valid emit kinds: ${EMITTER_KINDS.join(', ')}.`
        : '';
      process.stderr.write(
        `Unknown flag: ${arg}. Run \`lb-contracts --help\` for valid ` +
          `flags.${hint}\n`,
      );
      continue;
    }
    if (verbose) {
      console.log(`[verbose] ignoring positional token: ${arg}`);
    }
  }

  return {
    watch: watchMode,
    strict,
    allowBreaking,
    skipTsc,
    verbose,
    graphqlSdl,
    emitOverrides,
    esm,
    importExtension,
  };
}

/**
 * Validate a raw `--import-extension` value against the closed set of
 * accepted strings (`.js`, `.ts`, or empty for bundler resolution).
 * Throws a `TypeError` with a clear hint on any other input.
 */
function validateImportExtension(raw: string): ImportExtension {
  if ((VALID_IMPORT_EXTENSIONS as readonly string[]).includes(raw)) {
    return raw as ImportExtension;
  }
  throw new TypeError(
    `Unknown --import-extension value '${raw}'; valid: .js, .ts, ` +
      "'' (empty for bundler resolution).",
  );
}

function matchEmitFlag(arg: string, prefix: string): string | undefined {
  if (!arg.startsWith(prefix)) return undefined;
  const kind = arg.slice(prefix.length);
  return (EMITTER_KINDS as readonly string[]).includes(kind) ? kind : undefined;
}

function mergeEmitFlags(
  config: LoopbackConfigJson,
  flags: ParsedFlags,
): Record<string, boolean> {
  // `config.emit` carries `boolean` emitter toggles alongside the
  // string-valued `esm` / `importExtension` slots (typed as `EmitValue`).
  // Strip the string slots before merging so the pipeline's emit-flag
  // map stays a pure `Record<string, boolean>`.
  const base: Record<string, boolean> = {};
  const source: Readonly<Record<string, EmitValue>> = config.emit ?? {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === 'boolean') base[k] = v;
  }
  for (const [k, v] of Object.entries(flags.emitOverrides)) {
    base[k] = v;
  }
  return base;
}

/**
 * Apply per-run overrides that travel inside the schema, not the emit flag
 * map. Today the only one is `--emit-graphql-sdl`, which flips the GraphQL
 * emitter's `sdl` per-schema option on for every schema that opts into
 * GraphQL via `x-graphql`.
 *
 * The override travels on a `'graphql-overrides'` sibling key on the
 * cloned config — an internal CLI ↔ engine handshake, not part of
 * `LoopbackConfigJson`'s declared shape. Documented here (instead of
 * widening `LoopbackConfigJson` or extending `PipelineRunOptions`) so
 * the v1.0 public surface stays narrow; if a second per-run flag lands,
 * promote the channel to a typed `PipelineRunOptions.overrides` block.
 */
function applyPerSchemaOverrides(
  config: LoopbackConfigJson,
  flags: ParsedFlags,
): LoopbackConfigJson {
  if (!flags.graphqlSdl) return config;
  const cloned: LoopbackConfigJson & {
    'graphql-overrides'?: {sdl: true};
  } = {...config, 'graphql-overrides': {sdl: true}};
  return cloned;
}

/**
 * Build the {@link PipelineRunOptions} bag handed to `Pipeline.run`. Wraps
 * the per-schema override + emit-flag merge + (new) `moduleFormat` decision
 * so the one-shot and watch paths stay in lock-step. Also handles the
 * `--import-extension-without-esm` warning: emitted once per run when the
 * user passed `--import-extension` but the effective ESM mode is false.
 *
 * TODO(cross-wave): drop the cast on `runOpts` once `PipelineRunOptions`
 * declares the optional `moduleFormat` field (esm + importExtension)
 * in `engine/pipeline.ts`.
 */
function buildRunOptions(
  opts: {projectRoot: string; config: LoopbackConfigJson},
  flags: ParsedFlags,
): PipelineRunOptions {
  const moduleFormat = computeModuleFormat(flags, opts.config);

  // Warn if `--import-extension` was passed but ESM is not effectively on.
  // Decision precedence mirrors `computeModuleFormat`. Warning is emitted
  // unconditionally per `runGen` invocation; watch mode triggers it once
  // (warnings live on `flags`, which is built once before the watcher
  // loops). Use stderr so piped stdout consumers still see it.
  if (flags.importExtension !== undefined) {
    const esmEffective = flags.esm ?? getEmitEsm(opts.config.emit);
    if (!esmEffective) {
      process.stderr.write(
        '--import-extension has no effect without --esm; ignoring.\n',
      );
    }
  }

  const base: PipelineRunOptions = {
    projectRoot: opts.projectRoot,
    config: applyPerSchemaOverrides(opts.config, flags),
    emitFlags: mergeEmitFlags(opts.config, flags),
    strict: flags.strict,
    allowBreaking: flags.allowBreaking,
    skipTsc: flags.skipTsc,
  };
  if (moduleFormat === undefined) return base;
  // The `moduleFormat` field doesn't exist on `PipelineRunOptions` yet —
  // the API agent owns that addition (cross-wave). Build the merged
  // object as an intersection-typed local so this file compiles
  // standalone and the runtime payload is already in place when the
  // field lands. The local-typed annotation (rather than an `as` cast)
  // satisfies @typescript-eslint/consistent-type-assertions.
  const withModuleFormat: PipelineRunOptions & {
    readonly moduleFormat: {
      readonly esm: boolean;
      readonly importExtension: ImportExtension;
    };
  } = {...base, moduleFormat};
  return withModuleFormat;
}

/**
 * Resolve the effective `{esm, importExtension}` pair from CLI flags +
 * config, applying the documented precedence:
 *
 *   1. CLI flag (if present) wins
 *   2. Config `emit.esm` / `emit.importExtension`
 *   3. Defaults: `esm = false`, `importExtension = '.js'`
 *
 * Returns `undefined` when the resolved value is the default
 * (`esm: false`, `importExtension: '.js'`) so the pipeline can skip the
 * field entirely — keeping the on-the-wire options bag minimal.
 */
function computeModuleFormat(
  flags: ParsedFlags,
  config: LoopbackConfigJson,
):
  | {readonly esm: boolean; readonly importExtension: ImportExtension}
  | undefined {
  // `getEmitEsm` / `getEmitImportExtension` already collapse "missing or
  // invalid" to the project-wide defaults (`false`, `'.js'`), so the
  // precedence reduces to: CLI flag if present, else helper.
  const esm = flags.esm ?? getEmitEsm(config.emit);
  const importExtension =
    flags.importExtension ?? getEmitImportExtension(config.emit);
  if (!esm && importExtension === '.js') return undefined;
  return {esm, importExtension};
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printRunSummary(result: PipelineResult, projectRoot: string): void {
  const written = result.filesWritten;
  console.log(`Wrote ${written.length} files:`);
  for (const file of written) {
    const rel = relative(projectRoot, file) || file;
    console.log(`  ${rel}  (regen)`);
  }
  console.log('Skipped 0 files (already exist).');
  console.log(`Lossy warnings: ${result.lossy.length}.`);
}

function printDivider(): void {
  console.log(
    '---------------------------------------------------------------',
  );
}

function stamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function shortTrigger(trigger: string, projectRoot: string): string {
  if (trigger === '<initial>') return trigger;
  const rel = relative(projectRoot, trigger);
  return rel.length > 0 ? rel : trigger;
}

/**
 * Conservative default for resolving a schema `$id` to its generated base
 * model file location. Mirrors the layout the `model` emitter uses; the
 * import map only consults this for cross-schema references, so any
 * over-approximation gets corrected by the emitter's own path computation
 * when it actually writes the file.
 */
function defaultTargetPath(outputDir: string, schemaId: string): string {
  const slug = schemaId
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return join(outputDir, 'models', `${slug}.base.model.ts`);
}

/**
 * Dispatcher-facing adapter. Builds the standard {@link CliContext}
 * (which requires a discoverable `loopback.config.json`) and delegates to
 * {@link runGen}. The internal `runGen` export remains the entry point
 * for unit tests.
 *
 * @internal
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const ctx = await createCliContext({requireConfig: true});
  return runGen({
    projectRoot: ctx.projectRoot,
    config: ctx.config,
    argv,
  });
};
