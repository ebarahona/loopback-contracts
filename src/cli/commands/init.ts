// `lb-contracts init` — one-shot project scaffolder for `@ebarahona/loopback-contracts`.
//
// Writes `loopback.config.json`, creates the empty schemas/ and configs/
// directories, and ensures a `.gitignore` entry for the engine cache. Refuses
// to overwrite an existing `loopback.config.json`: hand-edits own the file
// from then on, per the "Why scaffold-only" section of the design doc.
//
// Discovery of available sidecar emitters runs through a throwaway LB4
// `Application` instance that registers `ContractsComponent` and resolves the
// `EmitterRegistry`. Spinning a full app (rather than constructing the
// registry class ourselves) keeps third-party emitter contributions in scope:
// any plugin the host project loads alongside `loopback-contracts` is picked
// up at init time too. The app is constructed, queried, and discarded inside
// `discoverEmitterKinds()` — no resources outlive the function call.

import {Application} from '@loopback/core';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {
  applyEdits,
  format as jsoncFormat,
  modify as jsoncModify,
  type FormattingOptions,
} from 'jsonc-parser';
import {createCliContext} from '../cli-context';
import {ContractsComponent} from '../../contracts.component';
import {
  ContractsEngineBindings,
  type EmitterMetadata,
  type EmitterRegistry,
} from '../../engine';
import {ContractsError} from '../../helpers';
import {multiselect, outro, select, spinner, text} from '../prompts';

/**
 * Arguments accepted by {@link runInit}. `argv` is currently unused (the
 * command is fully interactive) but is reserved for future `--non-interactive`
 * / `--yes` flag parsing without changing the signature.
 *
 * @internal
 */
export interface RunInitOptions {
  readonly projectRoot: string;
  readonly argv: readonly string[];
}

/** Selected source kind from the "Add a remote schema source now?" prompt. */
type SourceKind = 'none' | 'git' | 'npm' | 'http';

/** Git auth flavour when the user picks a git source. */
type GitAuth = 'ssh' | 'token' | 'public';

/** Validator chosen for `loopback-config` consumption. */
type ValidatorKind = 'ajv' | 'zod';

/**
 * Value type for entries in the `emit` map. Sidecar-emitter toggles are
 * booleans; reserved keys carry typed string values (e.g. `importExtension`
 * is `.js` / `.ts` / `''`). Mirrors the widened shape landing in a parallel
 * wave — kept local so this file type-checks independently.
 */
type EmitValue = boolean | '.js' | '.ts' | '';

/**
 * Canonical multi-select labels for the nine built-in sidecar emitters, in
 * the exact wording shown in the doc's "Project initialization (lb-contracts init)"
 * section. Third-party emitter contributions discovered through the registry
 * fall back to a synthesised label.
 */
const BUILTIN_EMIT_LABELS: Readonly<Record<string, string>> = {
  zod: 'Zod (*.zod.ts) — runtime validation, sharing with TS frontends / tRPC',
  types:
    'Pure TS interfaces (*.types.ts) — share types with monorepo workers without LB4 weight',
  graphql:
    'GraphQL (*.graphql.ts + *.graphql SDL) — feed any GraphQL server; `loopback-graphql` will consume natively',
  cloudevents:
    'CloudEvents (*.cloudevents.ts) — typed CloudEvent<T> wrappers using the official `cloudevents` package',
  asyncapi:
    'AsyncAPI (*.asyncapi.yaml) — message catalog for event-driven endpoints',
  proto: 'Protocol Buffers (*.proto) — for gRPC consumers in any language',
  avro: 'Avro (*.avsc) — for Kafka schema-registry workflows',
  'openapi-components':
    'OpenAPI components (*.openapi-components.yaml) — mountable fragments for OAS documents',
  'mock-data':
    'Mock fixtures (*.mock.json) — `json-schema-faker` sample data per schema',
};

/** Canonical display order for the nine built-in emitters. */
const BUILTIN_EMIT_ORDER: readonly string[] = [
  'zod',
  'types',
  'graphql',
  'cloudevents',
  'asyncapi',
  'proto',
  'avro',
  'openapi-components',
  'mock-data',
];

const CONFIG_FILENAME = 'loopback.config.json';
const GITIGNORE_FILENAME = '.gitignore';
const CACHE_IGNORE_LINE = '.loopback/cache/';
const NODE_MODULES_IGNORE_LINE = 'node_modules/';

const FORMATTING: FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: '\n',
};

const CANCEL_CODE = 'CONTRACTS_CLI_CANCELLED';

/**
 * Run the interactive `lb-contracts init` command. Returns `0` on success, `2`
 * for refusal-to-overwrite, `1` on runtime failure, and `130` when the
 * user cancels (SIGINT-equivalent per UNIX convention) — callers should
 * propagate the value as the process exit code.
 *
 * @internal
 */
export async function runInit(opts: RunInitOptions): Promise<number> {
  const {projectRoot} = opts;
  const configPath = join(projectRoot, CONFIG_FILENAME);

  if (await pathExists(configPath)) {
    process.stderr.write(
      `Error: ${CONFIG_FILENAME} already exists. ` +
        `Hand-edit it to change settings later.\n`,
    );
    return 2;
  }

  try {
    const projectName = await text({
      message: 'Project name?',
      defaultValue: basename(projectRoot),
    });
    const schemasDir = await text({
      message: 'Schemas directory?',
      defaultValue: './schemas',
    });
    const configsDir = await text({
      message: 'Configs directory?',
      defaultValue: './configs',
    });

    const sourceKind = await select<SourceKind>({
      message: 'Add a remote schema source now?',
      options: [
        {label: "No, I'll author locally for now", value: 'none'},
        {label: 'Yes — git repo (Monday-style contracts)', value: 'git'},
        {label: 'Yes — npm package', value: 'npm'},
        {label: 'Yes — HTTP directory', value: 'http'},
      ],
    });
    const remoteEntry = await promptRemoteSource(sourceKind);

    const validator = await select<ValidatorKind>({
      message: 'Default validator (for loopback-config)?',
      options: [
        {
          label: 'Ajv (JSON Schema 2020-12, portfolio standard)',
          value: 'ajv',
        },
        {
          label: 'Zod (TypeScript-first inference, NestJS-style)',
          value: 'zod',
        },
      ],
    });

    const moduleFormat = await select<'default' | 'esm'>({
      message: 'Module format for generated code?',
      options: [
        {
          label: 'Default emit mode (recommended for CJS LB4 apps)',
          value: 'default',
        },
        {label: 'ESM-strict (for ESM-only consumers)', value: 'esm'},
      ],
    });

    let importExtension: '.js' | '.ts' | '' = '.js';
    if (moduleFormat === 'esm') {
      importExtension = await select<'.js' | '.ts' | ''>({
        message: 'Import extension?',
        options: [
          {label: '.js (Node, ts-node, tsc-emitted output)', value: '.js'},
          {
            label: '.ts (Deno / TypeScript with allowImportingTsExtensions)',
            value: '.ts',
          },
          {label: 'extensionless (bundler resolution)', value: ''},
        ],
      });
    }

    const emitterKinds = await discoverEmitterKinds();
    const emitOptions = emitterKinds.map(meta => ({
      label: BUILTIN_EMIT_LABELS[meta.kind] ?? defaultLabel(meta),
      value: meta.kind,
    }));

    const selectedEmits = await multiselect<string>({
      message: 'Enable sidecar emissions by default?',
      options: emitOptions,
      initialValues: [],
    });

    const emit: Record<string, EmitValue> = buildEmitMap(
      emitterKinds,
      selectedEmits,
    );
    if (moduleFormat === 'esm') {
      emit.esm = true;
      // Default `.js` is documented — omit the key to keep the config minimal.
      if (importExtension !== '.js') emit.importExtension = importExtension;
    }

    const config = buildConfigDocument({
      name: projectName,
      schemasDir,
      configsDir,
      validator,
      schemas:
        remoteEntry === undefined ? [schemasDir] : [schemasDir, remoteEntry],
      emit,
    });

    const spin = spinner();
    spin.start(`Writing ${CONFIG_FILENAME}`);
    try {
      await writeFile(configPath, config, 'utf8');
      await mkdir(join(projectRoot, schemasDir), {recursive: true});
      await mkdir(join(projectRoot, configsDir), {recursive: true});
      await updateGitignore(projectRoot);
      spin.stop(`Wrote ${CONFIG_FILENAME}`);
    } catch (err) {
      spin.stop(`Failed to write ${CONFIG_FILENAME}`, 1);
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      // Runtime failure (filesystem error) — distinct from the
      // refusal-to-overwrite path above which returns 2.
      return 1;
    }

    outro(`${CONFIG_FILENAME} initialized. Next: lb-contracts contract <name>`);
    return 0;
  } catch (err) {
    if (err instanceof ContractsError && err.code === CANCEL_CODE) {
      process.stderr.write('Cancelled.\n');
      // SIGINT-equivalent exit code per UNIX convention.
      return 130;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

/**
 * Drive the conditional remote-source sub-prompts. Returns `undefined` when
 * the user picked the local-only option, or the encoded source URI string
 * for `git` / `npm` / `http`. Cancellation propagates as a thrown
 * {@link ContractsError} from the underlying prompt helpers.
 */
async function promptRemoteSource(
  kind: SourceKind,
): Promise<string | undefined> {
  if (kind === 'none') return undefined;

  if (kind === 'git') {
    const url = await text({
      message: 'Source URL?',
      placeholder: 'git+https://github.com/myorg/contracts.git#v1.2.0',
    });
    // The auth choice is captured for completeness but is recorded
    // out-of-band (SSH agent / GIT_ASKPASS) per the design doc — the URI
    // itself is the only thing that lands in the config file.
    await select<GitAuth>({
      message: 'Authentication?',
      options: [
        {label: 'SSH key', value: 'ssh'},
        {label: 'HTTPS token (GIT_ASKPASS)', value: 'token'},
        {label: 'Public', value: 'public'},
      ],
    });
    return url;
  }

  if (kind === 'npm') {
    const pkg = await text({
      message: 'Package name?',
      placeholder: '@myorg/contracts',
    });
    return `npm:${pkg}`;
  }

  // kind === 'http'
  const url = await text({
    message: 'Source URL?',
    placeholder: 'https://schemas.example.com/contracts/',
  });
  return url;
}

/**
 * Spin up a throwaway LB4 application, register `ContractsComponent`, bind
 * the `EmitterRegistry`, and project the registered emitters into a metadata
 * list. The app is dropped on the floor immediately after the call returns —
 * `Application` instances are not held anywhere outside this function.
 */
async function discoverEmitterKinds(): Promise<readonly EmitterMetadata[]> {
  const app = new Application();
  app.component(ContractsComponent);
  // `ContractsComponent` already publishes the engine's `EmitterRegistry`
  // under `ContractsEngineBindings.EMITTER_REGISTRY`. Resolve it through
  // that canonical token instead of binding a second instance under the
  // legacy `services.EmitterRegistry` key — two bindings means two
  // singletons, and any plugin-contributed emitters discovered via the
  // component path would be invisible to the second copy.
  try {
    await app.start();
    const registry = await app.get<EmitterRegistry>(
      ContractsEngineBindings.EMITTER_REGISTRY,
    );
    const metadata = await registry.listMetadata();
    return orderMetadata(metadata);
  } finally {
    try {
      await app.stop();
    } catch {
      // Best-effort shutdown — failure here should never mask the
      // discovery result the caller already has.
    }
  }
}

/**
 * Sort metadata so the nine built-ins appear in the canonical doc order
 * first, followed by any third-party kinds sorted alphabetically for stable
 * output.
 */
function orderMetadata(
  metadata: readonly EmitterMetadata[],
): readonly EmitterMetadata[] {
  const byKind = new Map<string, EmitterMetadata>();
  for (const m of metadata) byKind.set(m.kind, m);

  const ordered: EmitterMetadata[] = [];
  for (const kind of BUILTIN_EMIT_ORDER) {
    const m = byKind.get(kind);
    if (m !== undefined) {
      ordered.push(m);
      byKind.delete(kind);
    }
  }
  const remaining = Array.from(byKind.values()).sort((a, b) =>
    a.kind.localeCompare(b.kind),
  );
  return [...ordered, ...remaining];
}

/** Fallback label for a third-party emitter not in the canonical map. */
function defaultLabel(meta: EmitterMetadata): string {
  return `${meta.kind} (${meta.outputSuffix}) — ${meta.description}`;
}

/**
 * Project the user's multi-select choices into the `emit` map. Every known
 * emitter kind gets an explicit boolean so the meta-schema validator can
 * enumerate the keys without relying on `additionalProperties`.
 */
function buildEmitMap(
  emitterKinds: readonly EmitterMetadata[],
  selected: readonly string[],
): Record<string, EmitValue> {
  const selectedSet = new Set(selected);
  const emit: Record<string, EmitValue> = {};
  for (const meta of emitterKinds) emit[meta.kind] = selectedSet.has(meta.kind);
  return emit;
}

/**
 * Assemble the `loopback.config.json` document text using `jsonc-parser`'s
 * `modify` and `format` so output is pretty-printed and deterministic. The
 * `$schema` reference points at the meta-schema the engine emits during
 * `lb-contracts gen`; it's optional in the runtime loader but enables VS Code
 * autocomplete the moment the file lands.
 */
function buildConfigDocument(input: {
  readonly name: string;
  readonly schemasDir: string;
  readonly configsDir: string;
  readonly validator: ValidatorKind;
  readonly schemas: readonly string[];
  readonly emit: Record<string, EmitValue>;
}): string {
  let doc = '{}';
  const apply = (path: (string | number)[], value: unknown): void => {
    const edits = jsoncModify(doc, path, value, {
      formattingOptions: FORMATTING,
    });
    doc = applyEdits(doc, edits);
  };

  apply(['$schema'], './_meta/loopback-config.schema.json');
  apply(['name'], input.name);
  apply(['schemasDir'], input.schemasDir);
  apply(['configsDir'], input.configsDir);
  apply(['validator'], input.validator);
  apply(['schemas'], input.schemas);
  apply(['emit'], input.emit);

  const formatted = applyEdits(doc, jsoncFormat(doc, undefined, FORMATTING));
  return formatted.endsWith('\n') ? formatted : `${formatted}\n`;
}

/**
 * Create `.gitignore` (or append to an existing file) so the engine cache
 * and `node_modules/` are ignored. Idempotent: existing lines are left
 * untouched, missing lines are appended.
 */
async function updateGitignore(projectRoot: string): Promise<void> {
  const path = join(projectRoot, GITIGNORE_FILENAME);
  const wantedLines = [CACHE_IGNORE_LINE, NODE_MODULES_IGNORE_LINE];

  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // File doesn't exist — fine, we'll write it from scratch below.
  }

  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0),
  );
  const missing = wantedLines.filter(line => !existingLines.has(line));
  if (missing.length === 0) return;

  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const next = `${existing}${prefix}${missing.join('\n')}\n`;
  await writeFile(path, next, 'utf8');
}

/** Probe for path existence without throwing on ENOENT. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatcher-facing adapter. `init` is the sole command that may run
 * without a `loopback.config.json` (it's the command that writes the
 * file), so it builds the union-typed {@link CliContext} via the
 * default-options overload rather than the `requireConfig: true` form.
 * The internal `runXxx` export stays the entry point for unit tests.
 *
 * @internal
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const ctx = await createCliContext();
  return runInit({projectRoot: ctx.projectRoot, argv});
};
