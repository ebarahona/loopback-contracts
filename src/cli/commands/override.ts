// `lb-contracts override <kind> <contract>` — emit a single user-editable extension
// stub for an existing contract or datasource.
//
// One-shot scaffolder: refuses to overwrite an existing extension file
// (delegates the existence check to `FileWriter`'s `skipIfExists` policy).
// Boots a transient LB4 `Application`, mounts `ContractsComponent`, binds
// the four engine generators, resolves the requested one by class binding,
// runs `generate()` with `includeExtension: true`, drops the regenerated
// base descriptor, and hands the extension descriptor to `FileWriter`.
//
// See `loopback-contracts.md` §"CLI command reference" — entry for
// `lb-contracts override`.

import {Application} from '@loopback/core';
import {
  ContractsCodegenError,
  readDatasourcesDoc,
  readJsoncStrict,
} from '../../helpers';
import type {DatasourcesDoc} from '../../helpers';
import {existsSync} from 'node:fs';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {createCliContext} from '../cli-context';
import {note} from '../prompts';
import {ContractsComponent} from '../../contracts.component';
import {
  ContractsEngineBindings,
  DefaultProjectPaths,
  EjsTemplateEngine,
  InMemoryLossyReporter,
  InMemorySchemaRegistry,
  RelativeImportMap,
} from '../../engine';
import type {FileWriter} from '../../engine';
import {ContractsBindings} from '../../keys';
import type {GeneratorContext} from '../../generators/types';
import {
  ControllerGenerator,
  DatasourceGenerator,
  ModelGenerator,
  RepositoryGenerator,
} from '../../generators';
import type {EmittedFile, JSONSchema, ProjectPaths} from '../../interfaces';
import type {
  DatasourceConfigJson,
  LoopbackConfigJson,
  ModelConfigJson,
} from '../../types';

/** The four kinds `lb-contracts override` accepts as its first positional arg. */
const VALID_KINDS = [
  'model',
  'repository',
  'controller',
  'datasource',
] as const;

type OverrideKind = (typeof VALID_KINDS)[number];

/**
 * Run `lb-contracts override <kind> <contract>`. Returns `0` on success, non-zero on
 * any user-visible failure. Never throws past its own boundary.
 *
 * @public
 */
export async function runOverride(opts: {
  projectRoot: string;
  config: LoopbackConfigJson;
  argv: readonly string[];
}): Promise<number> {
  const kindArg = opts.argv[0];
  const contractArg = opts.argv[1];

  if (kindArg === undefined || kindArg === '') {
    process.stderr.write(
      'lb-contracts override: missing required <kind> argument.\n' +
        `Valid kinds: ${VALID_KINDS.join(', ')}.\n` +
        'Usage: lb-contracts override <kind> <contract>\n',
    );
    return 1;
  }
  if (!isValidKind(kindArg)) {
    process.stderr.write(
      `lb-contracts override: unknown kind '${kindArg}'. ` +
        `Valid kinds: ${VALID_KINDS.join(', ')}.\n`,
    );
    return 1;
  }
  if (contractArg === undefined || contractArg.trim() === '') {
    process.stderr.write(
      'lb-contracts override: missing required <contract> argument.\n' +
        'Usage: lb-contracts override <kind> <contract>\n',
    );
    return 1;
  }

  const kind: OverrideKind = kindArg;
  const contractName = contractArg.trim();
  const kebab = toKebab(contractName);
  const paths = resolveProjectPaths(opts.projectRoot, opts.config);

  // Validate the source artefact exists. For `model` / `repository` /
  // `controller` that means matching schema + config files; for
  // `datasource` it means an entry in `datasources.json`.
  if (kind === 'datasource') {
    const dsEntry = findDatasourceEntry(opts.projectRoot, contractName);
    if (dsEntry === undefined) {
      process.stderr.write(
        `lb-contracts override: datasource '${contractName}' not found in ` +
          `datasources.json. Run \`lb-contracts ds ${contractName} ` +
          `--adapter <kind>\` first.\n`,
      );
      return 1;
    }
  } else {
    const schemaFile = resolve(paths.schemasDir, `${kebab}.schema.json`);
    const configFile = resolve(paths.configsDir, `${kebab}.config.json`);
    if (!existsSync(schemaFile) || !existsSync(configFile)) {
      const missing = [
        existsSync(schemaFile) ? null : schemaFile,
        existsSync(configFile) ? null : configFile,
      ].filter((p): p is string => p !== null);
      process.stderr.write(
        `lb-contracts override: contract '${contractName}' not found ` +
          `(missing ${missing.join(', ')}). ` +
          `Run \`lb-contracts contract ${contractName}\` first.\n`,
      );
      return 1;
    }
  }

  // Boot a transient application so the generators can be resolved through
  // the LB4 DI graph — keeps the override command honest about using the
  // same constructor injection path the engine itself uses. The four
  // generators and `FileWriter` are already contributed by
  // `ContractsComponent` via `createBindingFromClass`, which lands them
  // under the LB4 default `classes.<Name>` namespace (see
  // `DEFAULT_TYPE_NAMESPACES` in `@loopback/context`'s `binding-inspector`).
  // Re-binding here would shadow `FileWriter`'s singleton instance with a
  // second instance on a sibling key and risks divergent state in any
  // future component-level wiring.
  const app = new Application();
  app.component(ContractsComponent);

  // Bind the project root BEFORE `app.start()` so `ManifestEmitterBooter`
  // (in the `'contracts'` lifecycle group) walks the *caller's* project
  // tree for `emitters/*.emitter.json` instead of falling back to
  // `process.cwd()` — which would silently miss project-local manifests
  // when `lb-contracts override` is invoked from a subdirectory. Mirrors
  // `gen.ts` / `validate.ts`. `PROJECT_PATHS` is bound for the same
  // reason: any future lifecycle observer that injects it during start
  // would otherwise resolve against a cwd-anchored default.
  const projectPathsForBoot = new DefaultProjectPaths(
    opts.projectRoot,
    opts.config,
  );
  app.bind(ContractsEngineBindings.PROJECT_ROOT_TAG).to(opts.projectRoot);
  app.bind(ContractsBindings.PROJECT_PATHS).to(projectPathsForBoot);

  try {
    await app.start();

    // `FileWriter` is bound at `ContractsEngineBindings.FILE_WRITER` via
    // `.toClass()` (see `contracts.component.ts`) — the engine pins it at
    // that canonical token rather than the default `classes.<Name>` key
    // `createBindingFromClass` would synthesise. Resolving through the
    // explicit token keeps the override flow in lock-step with the
    // component's wiring and avoids `BindingError: 'classes.FileWriter'`.
    const writer = await app.get<FileWriter>(
      ContractsEngineBindings.FILE_WRITER,
    );
    const emitted = await produceExtension(app, {
      kind,
      contractName,
      kebab,
      projectRoot: opts.projectRoot,
      paths,
    });

    // All generators emit `EmittedFile.path` relative to `outputDir`;
    // anchor them via `DefaultProjectPaths.outputDir` so any future config
    // override (e.g. an `outputDir` field) is honoured instead of being
    // silently bypassed by a hardcoded `'src'` segment. Mirrors the
    // `validate.ts` / `gen.ts` wiring.
    const projectPaths = new DefaultProjectPaths(opts.projectRoot, opts.config);
    const result = await writer.writeAll(projectPaths.outputDir, emitted);

    if (result.skipped.length > 0) {
      const skipped = result.skipped[0] ?? '<unknown>';
      process.stderr.write(
        `Already overridden. Delete ${skipped} and re-run if you want to ` +
          'start fresh.\n',
      );
      // Refusal-to-overwrite: per the CLI exit-code policy, an existing
      // user-edited extension file is owned by the developer from then on.
      return 2;
    }

    const created = [...result.created, ...result.updated];
    if (created.length === 0) {
      // Defensive — the generators always return one descriptor when
      // `includeExtension` is true.
      process.stderr.write(
        'lb-contracts override: no extension file was produced (engine returned ' +
          'an empty descriptor list).\n',
      );
      return 1;
    }

    const writtenPath = created[0] ?? '<unknown>';
    note(
      [
        `Scaffolded ${kind} extension for '${contractName}':`,
        '',
        `  ${formatRelative(opts.projectRoot, writtenPath)}`,
        '',
        'Edit this file by hand; `lb-contracts gen` will never overwrite it. ' +
          'The matching `.base.*.ts` file regenerates on every run.',
      ].join('\n'),
      'Override created',
    );
    return 0;
  } finally {
    try {
      await app.stop();
    } catch {
      // Best-effort shutdown — failure here doesn't affect the exit code.
    }
  }
}

// ---------------------------------------------------------------------------
// Generator orchestration
// ---------------------------------------------------------------------------

interface ProducerOpts {
  kind: OverrideKind;
  contractName: string;
  kebab: string;
  projectRoot: string;
  paths: {schemasDir: string; configsDir: string};
}

/**
 * Resolve the requested generator from the booted application, build a
 * minimal {@link GeneratorContext}, and return the extension descriptor
 * (the regenerated base is dropped — the user already has it from the
 * last `lb-contracts gen` run).
 */
async function produceExtension(
  app: Application,
  opts: ProducerOpts,
): Promise<EmittedFile[]> {
  const projectPaths: ProjectPaths = {
    root: opts.projectRoot,
    outputDir: resolve(opts.projectRoot, 'src'),
    schemasDir: opts.paths.schemasDir,
    configsDir: opts.paths.configsDir,
  };
  const registry = new InMemorySchemaRegistry();
  const lossy = new InMemoryLossyReporter();
  // Anchor template lookups at the plugin's own `templates/` directory
  // (shipped under `dist/templates/` after build; the same physical files
  // live at `src/templates/` during local `tsx` runs). `__dirname` here
  // resolves to `src/cli/commands/` in source and `dist/cli/commands/`
  // in build, so `..` `..` `templates` lands on the right tree in both
  // configurations. The previous default of `process.cwd()` only worked
  // because the engine's built-in generators pass *absolute* template
  // paths (see `TEMPLATES_DIR` in `generators/model-generator.ts`); any
  // future call site that hands the engine a relative template (e.g. a
  // user-contributed sidecar emitter under-rule from the override flow)
  // would resolve against the user's shell `cwd` instead of the plugin.
  const templates = new EjsTemplateEngine(
    join(__dirname, '..', '..', 'templates'),
  );
  // Preload every generator template up-front. `EjsTemplateEngine.render()`
  // is synchronous and reads from the in-memory cache only — any miss
  // throws. The override flow doesn't know which generator will fire until
  // the switch below, so preload all eight relevant templates once.
  const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates');
  await templates.preload([
    join(TEMPLATES_DIR, 'model.base.ts.ejs'),
    join(TEMPLATES_DIR, 'model.ts.ejs'),
    join(TEMPLATES_DIR, 'repository.base.ts.ejs'),
    join(TEMPLATES_DIR, 'repository.ts.ejs'),
    join(TEMPLATES_DIR, 'controller.base.ts.ejs'),
    join(TEMPLATES_DIR, 'controller.ts.ejs'),
    join(TEMPLATES_DIR, 'datasource.base.ts.ejs'),
    join(TEMPLATES_DIR, 'datasource.ts.ejs'),
  ]);

  // The import map's `getTargetPath` is only invoked when the registry
  // already knows the id (call sites in model/repo generators gate on
  // `registry.has(...)`). A throw here would surface a registry bug, not a
  // user-visible failure, so the strategy stays defensive.
  const importMap = new RelativeImportMap(registry, id => {
    return resolve(
      projectPaths.outputDir,
      'models',
      `${toKebab(id)}.base.model.ts`,
    );
  });

  const ctx: GeneratorContext = {
    registry,
    importMap,
    templates,
    paths: projectPaths,
    lossy,
    includeExtension: true,
  };

  switch (opts.kind) {
    case 'model': {
      const {schema, config} = loadContractFiles(opts);
      registry.add(schema);
      const gen = await app.get<ModelGenerator>(
        generatorBindingKey(ModelGenerator),
      );
      return filterExtension(
        gen.generate(schema, config, ctx),
        opts.kebab,
        'model',
      );
    }
    case 'repository': {
      const {schema, config} = loadContractFiles(opts);
      registry.add(schema);
      const gen = await app.get<RepositoryGenerator>(
        generatorBindingKey(RepositoryGenerator),
      );
      return filterExtension(
        gen.generate(schema, config, ctx),
        opts.kebab,
        'repository',
      );
    }
    case 'controller': {
      const {schema, config} = loadContractFiles(opts);
      registry.add(schema);
      const gen = await app.get<ControllerGenerator>(
        generatorBindingKey(ControllerGenerator),
      );
      return filterExtension(
        gen.generate(schema, config, ctx),
        opts.kebab,
        'controller',
      );
    }
    case 'datasource': {
      const dsEntry = findDatasourceEntry(opts.projectRoot, opts.contractName);
      if (dsEntry === undefined) {
        // Pre-checked by the caller; defensive guard.
        return [];
      }
      const gen = await app.get<DatasourceGenerator>(
        generatorBindingKey(DatasourceGenerator),
      );
      return filterExtension(
        gen.generate(opts.contractName, dsEntry, ctx),
        opts.kebab,
        'datasource',
      );
    }
    default:
      // `kind` is typed as `OverrideKind`; the union is exhausted above. A
      // future kind added to the union without a case branch is caught
      // here so the omission surfaces as a runtime error rather than a
      // silently-empty extension.
      throw new ContractsCodegenError(
        `unhandled override kind: ${String(opts.kind)}`,
        {emitterKind: 'override', schemaId: opts.contractName},
      );
  }
}

/**
 * Drop the regenerated base descriptor and keep only the extension stub —
 * the `.base.<kind>.ts` file is the engine's regen target on every run, not
 * a one-shot override artefact.
 */
function filterExtension(
  files: EmittedFile[],
  kebab: string,
  kind: OverrideKind,
): EmittedFile[] {
  const suffix = `${kebab}.${kind}.ts`;
  return files.filter(f => {
    if (f.path.includes('.base.')) return false;
    return f.path.endsWith(suffix);
  });
}

// ---------------------------------------------------------------------------
// File / config IO
// ---------------------------------------------------------------------------

interface LoadedFiles {
  schema: JSONSchema;
  config: ModelConfigJson;
}

/**
 * Read and parse the authored schema + config pair for one contract. Both
 * are accepted as JSONC so a comment in either file does not break the
 * override flow.
 *
 * Read + JSONC parse is delegated to {@link readJsoncStrict} so a
 * malformed sidecar throws {@link ContractsValidationError} with the
 * uniform parse-error block (file path + JSONC error code + line/column +
 * raw offset) instead of silently scaffolding an extension stub from
 * partial data — `jsonc-parser`'s `parse()` doesn't throw on errors, it
 * records them into the passed array and returns whatever it recovered.
 */
function loadContractFiles(opts: ProducerOpts): LoadedFiles {
  const schemaFile = resolve(
    opts.paths.schemasDir,
    `${opts.kebab}.schema.json`,
  );
  const configFile = resolve(
    opts.paths.configsDir,
    `${opts.kebab}.config.json`,
  );

  const schema = readJsoncStrict(
    schemaFile,
    `schema '${opts.contractName}'`,
  ) as JSONSchema;
  const config = readJsoncStrict(
    configFile,
    `config for contract '${opts.contractName}'`,
  ) as ModelConfigJson;
  return {schema, config};
}

/**
 * Look up one datasource entry from `<projectRoot>/datasources.json` and
 * convert it into the {@link DatasourceConfigJson} shape the datasource
 * generator consumes. Accepts both the doc's keyed-object layout
 * (`{"primary": {"adapter": "mongodb"}}`) and the legacy array-of-objects
 * layout (`[{"name": "primary", "adapter": "mongodb"}]`).
 *
 * Read + JSONC parse is delegated to {@link readDatasourcesDoc} so a
 * malformed file produces the same diagnostic block emitted by
 * `lb-contracts ds` and `lb-contracts contract` — previously this
 * function hand-parsed with `jsonc-parser`'s `parse()`, ignored the
 * returned `ParseError[]`, and converted the partial parse into a
 * misleading "datasource not found" message that hid the real problem
 * (typo in the JSON). The helper returns `undefined` for the benign
 * missing-file case and throws {@link ContractsValidationError} for the
 * unreadable / malformed / wrong-top-level cases; we let the throw
 * propagate so `runOverride`'s `try`/`finally` shuts the app down and the
 * dispatcher renders the uniform error block.
 */
function findDatasourceEntry(
  projectRoot: string,
  name: string,
): DatasourceConfigJson | undefined {
  const path = resolve(projectRoot, 'datasources.json');
  const doc: DatasourcesDoc | undefined = readDatasourcesDoc(path);
  // Missing `datasources.json` is benign here — the caller renders the
  // "not found, run `lb-contracts ds` first" nudge for the user.
  if (doc === undefined) return undefined;

  if (Array.isArray(doc)) {
    for (const entry of doc) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        'name' in entry &&
        (entry as {name: unknown}).name === name
      ) {
        return entry as DatasourceConfigJson;
      }
    }
    return undefined;
  }

  // Keyed-map layout: the map key wins as the datasource name (matches
  // the precedence rule in `normaliseDatasources` and the engine
  // pipeline's `parseDatasourcesJson`). Strip the engine-injected fields
  // out of the per-entry block before handing them to the generator as
  // free-form `config`.
  const map = doc as Record<string, unknown>;
  const value = map[name];
  if (value === undefined || value === null || typeof value !== 'object') {
    return undefined;
  }
  const block = value as Record<string, unknown>;
  const adapter = typeof block['adapter'] === 'string' ? block['adapter'] : '';
  const config: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block)) {
    if (k === 'adapter') continue;
    config[k] = v;
  }
  return {name, adapter, config};
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Mirror `DefaultProjectPaths` for schemas/configs without booting the
 * engine's DI graph — keeps the override command self-contained.
 */
function resolveProjectPaths(
  projectRoot: string,
  config: LoopbackConfigJson,
): {schemasDir: string; configsDir: string} {
  const root = isAbsolute(projectRoot) ? projectRoot : resolve(projectRoot);
  return {
    schemasDir: resolve(root, config.schemasDir ?? './schemas'),
    configsDir: resolve(root, config.configsDir ?? './configs'),
  };
}

/** Project-root-relative path for display in the success note. */
function formatRelative(projectRoot: string, target: string): string {
  const rel = relative(projectRoot, target);
  return rel === '' ? target : rel;
}

/** Type-guard for the four accepted `<kind>` values. */
function isValidKind(value: string): value is OverrideKind {
  return (VALID_KINDS as readonly string[]).includes(value);
}

/**
 * Default binding key produced by `createBindingFromClass(SomeClass)`
 * for an `@injectable`-decorated plain class — matches the
 * `DEFAULT_TYPE_NAMESPACES.class` entry (`'classes'`) in
 * `@loopback/context`'s `binding-inspector`. Centralising the
 * construction here keeps the override command in lock-step with
 * `ContractsComponent`'s wiring without re-importing the namespace
 * constant (it isn't part of the public LB4 surface).
 */
function generatorBindingKey<T>(
  cls: {name: string} & (new (...args: never[]) => T),
): string {
  return `classes.${cls.name}`;
}

/** Lowercase-kebab name conversion mirroring `cli/commands/contract.ts`. */
function toKebab(input: string): string {
  return input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Dispatcher-facing adapter. Builds the standard {@link CliContext}
 * (which requires a discoverable `loopback.config.json`) and delegates to
 * {@link runOverride}. The internal `runOverride` export remains the
 * entry point for unit tests.
 *
 * @internal
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const ctx = await createCliContext({requireConfig: true});
  return runOverride({
    projectRoot: ctx.projectRoot,
    config: ctx.config,
    argv,
  });
};
