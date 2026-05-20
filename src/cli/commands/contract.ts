// `lb4 contract <name>` — scaffold the two authored JSON files
// (`schemas/<name>.schema.json` + `configs/<name>.config.json`) for a new
// contract. One-shot scaffolder: refuses to overwrite, runs an interactive
// wizard via the local `../prompts` facade, optionally delegates to a
// `SourceExtension` contributed by sibling plugins such as
// `loopback-contracts-import`.
//
// See `loopback-contracts.md` §"CLI command reference" for behaviour rules.
//
// Discovery of registered source extensions runs through a throwaway LB4
// `Application` that registers `ContractsComponent` — same pattern as
// `init.ts` uses for emitter discovery. The application is constructed,
// queried, and discarded inside `discoverSourceExtensions()`; no resources
// outlive the function call. Plugins that contribute their own
// `SourceExtension` (e.g. `loopback-contracts-import`) must be mounted by
// the dispatcher before invoking this command — their bindings then surface
// alongside the built-ins via `findByTag(SOURCE_EXTENSION_TAG)`.

import {
  Application,
  filterByTag,
  type Component,
  type Constructor,
} from '@loopback/core';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {
  applyEdits,
  format as jsoncFormat,
  modify as jsoncModify,
  type FormattingOptions,
} from 'jsonc-parser';
import {createCliContext} from '../cli-context';
import {ContractsComponent} from '../../contracts.component';
import {ContractsEngineBindings} from '../../engine';
import {
  ContractsError,
  ContractsValidationError,
  readDatasourcesDoc,
} from '../../helpers';
import {SOURCE_EXTENSION_TAG} from '../../keys';
import type {SourceExtension} from '../../interfaces';
import type {LoopbackConfigJson} from '../../types';
import {cancel, confirm, note, select, text} from '../prompts';

/** Arguments accepted by {@link runContract}. */
export interface RunContractOptions {
  readonly projectRoot: string;
  readonly config: LoopbackConfigJson;
  readonly argv: readonly string[];
}

/**
 * One property entered through the wizard, pre-translated to the JSON Schema
 * fragment the writer drops into `properties[<name>]`.
 */
interface AuthoredProperty {
  name: string;
  required: boolean;
  schema: Record<string, unknown>;
}

/** Type options the wizard offers for each property. */
type PropertyKind =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'array<string>'
  | 'array<object>'
  | 'object'
  | 'ref';

/** String format hints accepted at the optional `format` prompt. */
type StringFormat = '' | 'date-time' | 'uuid' | 'email' | 'uri';

/** Result returned by the source-selection prompt. */
type SourcePick =
  | {kind: 'manual'}
  | {kind: 'extension'; extension: SourceExtension};

/** Shape returned by the manual-authoring wizard. */
interface WizardAnswers {
  id: string;
  description: string;
  properties: AuthoredProperty[];
  dataSource: string;
  public: boolean;
  idProperty: string;
}

const FORMATTING: FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: '\n',
};

const CANCEL_CODE = 'CONTRACTS_CLI_CANCELLED';

/**
 * Run the interactive `lb4 contract <name>` command.
 *
 * Returns `0` on success, `2` on refusal-to-overwrite / missing
 * arguments, `1` on runtime failure, and `130` on user cancel
 * (SIGINT-equivalent per UNIX convention). The function never throws
 * past its own boundary — every failure surfaces through the exit code
 * so the CLI dispatcher can render a uniform error frame.
 *
 * @internal
 */
export async function runContract(opts: RunContractOptions): Promise<number> {
  const name = opts.argv[0];
  if (name === undefined || name.trim() === '') {
    process.stderr.write(
      'lb-contracts contract: missing required <name> argument.\n' +
        'Usage: lb-contracts contract <name>\n',
    );
    return 2;
  }

  const kebabName = toKebabCase(name);
  const pascalName = toPascalCase(name);
  const paths = resolvePaths(opts.projectRoot, opts.config);
  const schemaFile = resolve(paths.schemasDir, `${kebabName}.schema.json`);
  const configFile = resolve(paths.configsDir, `${kebabName}.config.json`);

  // Check both targets independently so a partial state (one file manually
  // deleted) is recoverable on the next attempt.
  if (existsSync(schemaFile) || existsSync(configFile)) {
    process.stderr.write(
      `Contract ${kebabName} already exists. ` +
        'Run `lb-contracts override` if you need to extend the generated TS; ' +
        'hand-edit the JSON if you need to revise the model itself.\n',
    );
    return 2;
  }

  try {
    const sourcePick = await pickSource(opts.projectRoot);

    if (sourcePick.kind === 'extension') {
      return await runExtensionSource(sourcePick.extension, kebabName);
    }

    // Fail fast when the project has no datasources yet. The manual wizard
    // must produce a config with a concrete `dataSource: <name>` because
    // the model-config meta-schema requires `dataSource: string, minLength: 1`
    // AND stage 5 cross-validates the value against `datasources.json`.
    // Scaffolding `dataSource: null` would silently produce a config that
    // breaks the next `lb-contracts gen` — surface an actionable error here
    // instead of writing the invalid file.
    const datasourceOptions = readDatasourceNames(opts.projectRoot);
    if (datasourceOptions.length === 0) {
      process.stderr.write(
        'lb-contracts contract: no datasources are declared in this project.\n' +
          'Every contract config needs a `dataSource: <name>` that matches a ' +
          'datasource declared in `datasources.json`.\n' +
          'Run `lb-contracts ds <name> --adapter <kind>` first ' +
          '(e.g. `lb-contracts ds primary --adapter memory`), then re-run ' +
          '`lb-contracts contract ' +
          kebabName +
          '`.\n',
      );
      return 2;
    }

    const wizard = await runManualWizard({
      kebabName,
      projectRoot: opts.projectRoot,
      schemasDir: paths.schemasDir,
      datasourceOptions,
    });

    const schemaDoc = buildSchemaDocument({
      id: wizard.id,
      title: pascalName,
      description: wizard.description,
      properties: wizard.properties,
    });
    const configDoc = buildConfigDocument({
      contractId: wizard.id,
      dataSource: wizard.dataSource,
      public: wizard.public,
      idProperty: wizard.idProperty,
    });

    try {
      await writeJsonFile(schemaFile, schemaDoc);
      await writeJsonFile(configFile, configDoc);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      return 2;
    }

    note(
      [
        `Scaffolded contract '${kebabName}':`,
        '',
        `  ${formatRelative(opts.projectRoot, schemaFile)}`,
        `  ${formatRelative(opts.projectRoot, configFile)}`,
        '',
        'Next: run `lb-contracts gen` to emit the base TS artefacts.',
      ].join('\n'),
      'Contract created',
    );

    return 0;
  } catch (err) {
    if (err instanceof ContractsError && err.code === CANCEL_CODE) {
      cancel('Cancelled.');
      // SIGINT-equivalent exit code per UNIX convention.
      return 130;
    }
    // Typed validation errors (e.g. malformed `datasources.json` surfaced
    // by `readDatasourcesDoc`) are re-thrown so the CLI dispatcher's
    // `renderError` path formats the structured fields (sourcePath,
    // instancePath) into the standard error block. Mirrors the same
    // re-throw in `ds.ts` so identical input produces identical output
    // regardless of which command the user happened to run.
    if (err instanceof ContractsValidationError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Source-extension discovery
// ---------------------------------------------------------------------------

/**
 * Discover every `SourceExtension` bound under {@link SOURCE_EXTENSION_TAG}
 * and prompt the user to either author manually or delegate to one of them.
 *
 * Returns `{kind: 'manual'}` directly when no extensions are registered so
 * fresh projects (no `loopback-contracts-import` installed) skip the prompt
 * entirely and land on the manual-authoring wizard.
 */
async function pickSource(projectRoot: string): Promise<SourcePick> {
  const extensions = await discoverSourceExtensions(projectRoot);
  if (extensions.length === 0) return {kind: 'manual'};

  const choice = await select<string>({
    message: 'How would you like to create this contract?',
    options: [
      {label: 'Author manually', value: '__manual__'},
      ...extensions.map(ext => ({
        label: ext.label,
        value: ext.name,
        hint: ext.description,
      })),
    ],
    initialValue: '__manual__',
  });

  if (choice === '__manual__') return {kind: 'manual'};
  const picked = extensions.find(ext => ext.name === choice);
  if (picked === undefined) return {kind: 'manual'};
  return {kind: 'extension', extension: picked};
}

/**
 * Instantiate a transient `Application`, mount `ContractsComponent`, and
 * resolve every binding tagged with {@link SOURCE_EXTENSION_TAG}.
 *
 * Sibling plugin components (e.g. `ContractsImportComponent`) are expected
 * to be mounted by the dispatcher before this function runs in the
 * production flow — they contribute their own `SourceExtension` bindings
 * into the same context.
 */
async function discoverSourceExtensions(
  projectRoot: string,
): Promise<readonly SourceExtension[]> {
  const app = new Application();
  // Mount the component first so its source / engine bindings are in place
  // before any runtime-valued singletons (mirrors `gen.ts` /
  // `validate.ts`). `ContractsComponent` types its `providers` property
  // more strictly than the LB4 `Component` interface; the structural
  // mismatch is harmless for discovery (we only consume `findByTag`). Cast
  // widens the constructor signature for `app.component` without
  // weakening the runtime contract.
  app.component(ContractsComponent as unknown as Constructor<Component>);
  app.bind(ContractsEngineBindings.PROJECT_ROOT_TAG).to(projectRoot);
  try {
    await app.start();
    // `Application.findByTag` only accepts a tag string / RegExp; passing a
    // `BindingFilter` (the value returned by `filterByTag(...)`) makes the
    // lookup match nothing. `app.find()` is the overload that consumes a
    // `BindingFilter`.
    const bindings = app.find(filterByTag(SOURCE_EXTENSION_TAG));
    const resolved = await Promise.all(
      bindings.map(b => app.get<SourceExtension>(b.key)),
    );
    return resolved;
  } finally {
    try {
      await app.stop();
    } catch {
      // Best-effort shutdown — discovery already produced its result.
    }
  }
}

/**
 * Hand control to a registered `SourceExtension`. The extension is
 * responsible for producing both files (schema + optional config); we only
 * surface the paths it reports back to the user.
 */
async function runExtensionSource(
  ext: SourceExtension,
  contractName: string,
): Promise<number> {
  try {
    const result = await ext.invoke({name: contractName});
    const lines = [
      `Source extension '${ext.name}' produced:`,
      '',
      `  ${result.schemaFile}`,
    ];
    if (result.configFile !== undefined) {
      lines.push(`  ${result.configFile}`);
    }
    lines.push(
      '',
      'Next: run `lb-contracts gen` to emit the base TS artefacts.',
    );
    note(lines.join('\n'), 'Contract imported');
    return 0;
  } catch (err) {
    process.stderr.write(
      `Source extension '${ext.name}' failed: ` +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Manual-authoring wizard
// ---------------------------------------------------------------------------

/**
 * Run the manual-authoring prompts in order. The `../prompts` facade
 * throws a `CONTRACTS_CLI_CANCELLED` `ContractsError` on cancel; we let
 * it propagate up to {@link runContract}'s try/catch.
 */
async function runManualWizard(opts: {
  kebabName: string;
  projectRoot: string;
  schemasDir: string;
  datasourceOptions: readonly string[];
}): Promise<WizardAnswers> {
  const id = await text({
    message: 'ID for this contract?',
    defaultValue: `${opts.kebabName}.v1`,
    placeholder: `${opts.kebabName}.v1`,
  });

  const description = await text({
    message: 'Description?',
    placeholder: '',
    defaultValue: '',
  });

  const knownContractIds = listKnownContractIds(opts.schemasDir);
  const properties: AuthoredProperty[] = [];

  // Properties loop — the first iteration's `confirm` defaults to true so
  // users adding a single property aren't forced to type 'yes' first.
  while (true) {
    const more = await confirm({
      message: 'Add a property?',
      initialValue: true,
    });
    if (!more) break;
    const prop = await promptProperty(knownContractIds);
    properties.push(prop);
  }

  // `runContract` only invokes the wizard when at least one datasource is
  // declared, so the select prompt always has a real choice and the
  // resulting value is guaranteed non-empty — exactly what the stage-5
  // meta-schema (`dataSource: string, minLength: 1`) requires. The
  // non-null assertion mirrors that invariant for `exactOptionalPropertyTypes`,
  // which otherwise widens `datasourceOptions[0]` to `string | undefined`.
  const dataSource = await select<string>({
    message: 'Datasource binding?',
    options: opts.datasourceOptions.map(n => ({label: n, value: n})),
    initialValue: opts.datasourceOptions[0]!,
  });

  const isPublic = await confirm({
    message: 'Expose REST endpoints (public: true)?',
    initialValue: true,
  });

  const idProperty = await text({
    message: 'ID property name?',
    defaultValue: 'id',
    placeholder: 'id',
    validate(value): string | undefined {
      if (properties.length === 0) return undefined;
      const trimmed = value.trim() === '' ? 'id' : value.trim();
      const names = properties.map(p => p.name);
      if (!names.includes(trimmed)) {
        return (
          `ID property '${trimmed}' must match one of the entered ` +
          `properties: ${names.join(', ')}`
        );
      }
      return undefined;
    },
  });

  return {
    id: id.trim() === '' ? `${opts.kebabName}.v1` : id.trim(),
    description: description.trim(),
    properties,
    dataSource,
    public: isPublic,
    idProperty: idProperty.trim() === '' ? 'id' : idProperty.trim(),
  };
}

/**
 * Prompt for a single property — name, type, optional details for
 * `string` and `ref`, and `required` flag.
 */
async function promptProperty(
  knownContractIds: readonly string[],
): Promise<AuthoredProperty> {
  const name = await text({
    message: 'Property name?',
    validate(value): string | undefined {
      const v = value.trim();
      if (v === '') return 'Property name is required';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
        return 'Property name must be a valid identifier';
      }
      return undefined;
    },
  });

  const kind = await select<PropertyKind>({
    message: 'Type?',
    options: [
      {label: 'string', value: 'string'},
      {label: 'integer', value: 'integer'},
      {label: 'number', value: 'number'},
      {label: 'boolean', value: 'boolean'},
      {label: 'array of string', value: 'array<string>'},
      {label: 'array of object', value: 'array<object>'},
      {label: 'object', value: 'object'},
      {label: 'ref to another contract', value: 'ref'},
    ],
  });

  let refTarget: string | undefined;
  if (kind === 'ref') {
    if (knownContractIds.length === 0) {
      note(
        'No existing contract schemas were found to reference; the property ' +
          'will be scaffolded as an unresolved `$ref` placeholder. ' +
          'Create the target contract first, then hand-edit the `$ref`.',
        'Reference target',
      );
      refTarget = '__unresolved__';
    } else {
      refTarget = await select<string>({
        message: 'Reference which contract?',
        options: knownContractIds.map(id => ({label: id, value: id})),
      });
    }
  }

  const required = await confirm({
    message: 'Required?',
    initialValue: false,
  });

  let formatHint: StringFormat = '';
  if (kind === 'string') {
    formatHint = await select<StringFormat>({
      message: 'Format?',
      options: [
        {label: 'none', value: ''},
        {label: 'date-time', value: 'date-time'},
        {label: 'uuid', value: 'uuid'},
        {label: 'email', value: 'email'},
        {label: 'uri', value: 'uri'},
      ],
      initialValue: '',
    });
  }

  // Pass only the keys that actually carry a value — `exactOptionalPropertyTypes`
  // distinguishes "missing" from "explicit undefined".
  const extras: {refTarget?: string; formatHint?: StringFormat} = {};
  if (refTarget !== undefined) extras.refTarget = refTarget;
  if (formatHint !== '') extras.formatHint = formatHint;

  return {
    name: name.trim(),
    required,
    schema: buildPropertySchema(kind, extras),
  };
}

// ---------------------------------------------------------------------------
// JSON Schema construction
// ---------------------------------------------------------------------------

/** Build the JSON Schema fragment for one property based on prompt answers. */
function buildPropertySchema(
  kind: PropertyKind,
  extras: {refTarget?: string; formatHint?: StringFormat},
): Record<string, unknown> {
  switch (kind) {
    case 'string': {
      const node: Record<string, unknown> = {type: 'string'};
      if (extras.formatHint !== undefined && extras.formatHint !== '') {
        node.format = extras.formatHint;
      }
      return node;
    }
    case 'integer':
      return {type: 'integer'};
    case 'number':
      return {type: 'number'};
    case 'boolean':
      return {type: 'boolean'};
    case 'array<string>':
      return {type: 'array', items: {type: 'string'}};
    case 'array<object>':
      return {type: 'array', items: {type: 'object'}};
    case 'object':
      return {type: 'object'};
    case 'ref':
      return {$ref: extras.refTarget ?? '__unresolved__'};
    default:
      // PropertyKind is a closed union; this branch only fires if a future
      // edit widens the union without updating the switch.
      throw new ContractsValidationError(
        `unhandled property kind: ${String(kind)}`,
        {sourcePath: '<interactive>', instancePath: '/property/kind'},
      );
  }
}

/**
 * Assemble the top-level schema document. Pure JSON Schema 2020-12 — no
 * `x-platform` keywords, no LB-isms (those live in the config sibling).
 */
function buildSchemaDocument(opts: {
  id: string;
  title: string;
  description: string;
  properties: readonly AuthoredProperty[];
}): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of opts.properties) {
    properties[p.name] = p.schema;
    if (p.required) required.push(p.name);
  }

  return {
    $id: opts.id,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: opts.title,
    description: opts.description,
    type: 'object',
    properties,
    required,
  };
}

/** Assemble the per-model config document. */
function buildConfigDocument(opts: {
  contractId: string;
  dataSource: string;
  public: boolean;
  idProperty: string;
}): Record<string, unknown> {
  return {
    $schema: '../_meta/model-config.schema.json',
    $contractId: opts.contractId,
    dataSource: opts.dataSource,
    public: opts.public,
    model: {
      base: 'Entity',
      strict: true,
      idProperty: opts.idProperty,
    },
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute schema/config directories from the supplied config,
 * mirroring `DefaultProjectPaths` (kept private so the CLI command stays
 * independent of the engine's DI graph).
 */
function resolvePaths(
  projectRoot: string,
  config: LoopbackConfigJson,
): {schemasDir: string; configsDir: string} {
  const root = isAbsolute(projectRoot) ? projectRoot : resolve(projectRoot);
  return {
    schemasDir: resolve(root, config.schemasDir ?? './schemas'),
    configsDir: resolve(root, config.configsDir ?? './configs'),
  };
}

/**
 * Read `<projectRoot>/datasources.json` and return the list of datasource
 * names. Returns an empty array when the file is missing or contains no
 * recognised entries — `runContract` treats an empty result as a hard
 * (but actionable) error and refuses to scaffold a contract bound to
 * nothing, surfacing the "run `lb-contracts ds` first" nudge.
 *
 * Read + JSONC parse is delegated to {@link readDatasourcesDoc} so a
 * malformed file produces an identical error block to the one
 * `lb-contracts ds` emits — previously this function swallowed parse
 * errors with `return []`, which conflated "no datasources" with
 * "broken JSON" and left users staring at a misleading nudge instead of
 * a parse-error pointer. The helper throws
 * {@link ContractsValidationError} on corruption; we let it propagate to
 * `runContract`'s catch, which re-throws it for the dispatcher's
 * `renderError` to render.
 *
 * Accepts both on-disk layouts:
 *   - The canonical keyed-object shape `lb4 ds` writes today, where each
 *     top-level key is the datasource name and the value is the adapter
 *     block (with an optional `$schema` sibling we filter out).
 *   - The legacy array-of-objects shape `[{name, adapter, ...}]` that
 *     hand-authored or imported configs might still carry — kept so a
 *     user mid-migration isn't told "No datasources found" right after
 *     running `lb4 ds`.
 */
function readDatasourceNames(projectRoot: string): readonly string[] {
  const path = resolve(projectRoot, 'datasources.json');
  const doc = readDatasourcesDoc(path);
  if (doc === undefined) return [];

  if (Array.isArray(doc)) {
    const names: string[] = [];
    for (const entry of doc) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        'name' in entry &&
        typeof (entry as {name: unknown}).name === 'string'
      ) {
        names.push((entry as {name: string}).name);
      }
    }
    return names;
  }

  // `Array.isArray` ruled out the array arm; cast the keyed-map member
  // explicitly so `Object.keys` / indexed reads type-check without TS
  // treating `readonly unknown[]` as a residual possibility.
  const map = doc as Record<string, unknown>;
  const names: string[] = [];
  for (const key of Object.keys(map)) {
    // `$schema` is the only reserved sibling key — every other top-level
    // entry is a datasource name owned by the user.
    if (key === '$schema') continue;
    const value = map[key];
    if (value !== null && typeof value === 'object') names.push(key);
  }
  return names;
}

/**
 * Enumerate `$id` values from every authored schema under the project's
 * configured schemas directory so the `ref` prompt can offer real targets
 * without booting the full engine. Best-effort: a fresh project (no schemas
 * yet) yields an empty list.
 *
 * `schemasDir` is the absolute, already-resolved path produced by
 * {@link resolvePaths} — honours the user's `schemasDir` setting in
 * `loopback.config.json` rather than assuming the default `./schemas`.
 */
function listKnownContractIds(schemasDir: string): readonly string[] {
  if (!existsSync(schemasDir)) return [];
  try {
    const entries = readdirSync(schemasDir, {withFileTypes: true});
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.schema.json')) continue;
      try {
        const raw = readFileSync(resolve(schemasDir, entry.name), 'utf8');
        const doc: unknown = JSON.parse(raw);
        if (
          doc !== null &&
          typeof doc === 'object' &&
          '$id' in doc &&
          typeof (doc as {$id: unknown}).$id === 'string'
        ) {
          ids.push((doc as {$id: string}).$id);
        }
      } catch {
        // Skip unreadable / malformed sibling — best-effort listing only.
      }
    }
    return ids.sort();
  } catch {
    return [];
  }
}

/**
 * Write `value` to `path` as formatted JSON. Uses `jsonc-parser`'s
 * `modify` + `format` pipeline so the on-disk layout is stable across
 * platforms and matches the formatting any later hand-edit produces,
 * keeping diffs small.
 */
async function writeJsonFile(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(path), {recursive: true});

  // Seed an empty object, then add each top-level key in declaration order.
  // `jsonc-parser` preserves key ordering as emitted, which is what we want
  // for a deterministic on-disk layout.
  let body = '{}';
  for (const [key, child] of Object.entries(value)) {
    const edits = jsoncModify(body, [key], child, {
      formattingOptions: FORMATTING,
    });
    body = applyEdits(body, edits);
  }
  const formatted = applyEdits(body, jsoncFormat(body, undefined, FORMATTING));
  await writeFile(
    path,
    formatted.endsWith('\n') ? formatted : formatted + '\n',
    'utf8',
  );
}

/** Project-root-relative path for display in the success note. */
function formatRelative(projectRoot: string, target: string): string {
  const rel = relative(projectRoot, target);
  return rel === '' ? target : rel;
}

// ---------------------------------------------------------------------------
// Name conversions
// ---------------------------------------------------------------------------

/** Convert any reasonable identifier into `kebab-case`. */
function toKebabCase(input: string): string {
  return input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/** Convert any reasonable identifier into `PascalCase`. */
function toPascalCase(input: string): string {
  const parts = toKebabCase(input).split('-').filter(Boolean);
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * Dispatcher-facing adapter. Builds the standard {@link CliContext} (which
 * requires a discoverable `loopback.config.json`) and delegates to
 * {@link runContract}. The internal `runContract` export remains the
 * entry point for unit tests.
 *
 * @internal
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const ctx = await createCliContext({requireConfig: true});
  return runContract({
    projectRoot: ctx.projectRoot,
    config: ctx.config,
    argv,
  });
};
