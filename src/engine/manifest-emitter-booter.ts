import {
  BindingScope,
  CoreBindings,
  inject,
  injectable,
  lifeCycleObserver,
  type Application,
  type LifeCycleObserver,
} from '@loopback/core';
import Ajv2020 from 'ajv/dist/2020';
import createDebug from 'debug';
import {readFile, readdir, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {ContractsValidationError} from '../helpers';
import {EMITTER_TAG} from '../keys';
import {validateManifest, type EmitterManifest} from './emitter-manifest';
import {ManifestBackedEmitter} from './manifest-backed-emitter';
import {buildEmitterManifestMetaSchema} from './meta-schema-generator';

const debug = createDebug('loopback:contracts:manifest-emitter-booter');

/**
 * Lifecycle observer that discovers project-local manifest emitters at engine
 * startup and binds each into the host {@link Application} context under
 * {@link EMITTER_TAG}.
 *
 * On `start()`:
 *
 * 1. Globs `<projectRoot>/emitters/*.emitter.json`.
 * 2. Parses each file and validates it against the engine's emitter
 *    meta-schema using Ajv.
 * 3. Resolves each manifest's `template` field to an absolute filesystem
 *    path (relative paths anchor to the manifest's own directory).
 * 4. Constructs a {@link ManifestBackedEmitter} per valid manifest.
 * 5. Binds each adapter via `app.bind(...).toDynamicValue(...).tag(...)` so
 *    `EmitterRegistry`'s `@extensions.view({tag: EMITTER_TAG})` picks it up
 *    alongside built-in and plugin-contributed emitters.
 *
 * On `stop()`: unbinds every key the booter added.
 *
 * The booter is plugin-internal; consumers never instantiate it directly.
 * The class is intentionally tolerant of a missing `emitters/` directory so
 * projects that ship no manifests pay no startup cost beyond one `readdir`.
 *
 * @internal
 */
@lifeCycleObserver('contracts')
@injectable({scope: BindingScope.SINGLETON})
export class ManifestEmitterBooter implements LifeCycleObserver {
  /** Keys this booter added to the application context, for stop() cleanup. */
  private readonly boundKeys: string[] = [];

  /** True once `start()` has completed successfully. Reset by `stop()`. */
  private started = false;

  /**
   * In-flight promise for the active `start()` call. Concurrent callers await
   * this same promise rather than re-entering the discovery + bind loop,
   * which would double-bind every manifest under the same key.
   */
  private startInFlight?: Promise<void>;

  /**
   * @param app - Host application context used to register manifest-backed
   *   emitter bindings.
   * @param projectRoot - Absolute filesystem path containing the project's
   *   `emitters/` directory. Defaults to `process.cwd()`; the engine
   *   overrides this in tests and in monorepo setups.
   */
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly app: Application,
    @inject('platform.contracts.project-root', {optional: true})
    private readonly projectRoot: string = process.cwd(),
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startInFlight !== undefined) {
      await this.startInFlight;
      return;
    }
    const inFlight = this.runStart();
    this.startInFlight = inFlight;
    try {
      await inFlight;
      this.started = true;
    } finally {
      delete this.startInFlight;
    }
  }

  private async runStart(): Promise<void> {
    // Two manifest sources, in priority order:
    //   1. Built-in manifests shipped with the plugin (under <plugin-dist>/
    //      emitters/manifest/<kind>/emitter.json). Discovered via __dirname
    //      so the lookup tracks the compiled location at runtime.
    //   2. Project-local manifests authored by the consumer (under
    //      <projectRoot>/emitters/*.emitter.json).
    // Both register under EMITTER_TAG; project-local manifests can override
    // a built-in by declaring the same `kind` (last-write-wins by binding
    // order — see EmitterRegistry.validateUniqueness for the conflict
    // diagnostic).
    const builtinDir = join(__dirname, '..', 'emitters', 'manifest');
    const builtinFiles = await listBuiltinManifestFiles(builtinDir);
    const projectDir = join(this.projectRoot, 'emitters');
    const projectFiles = await listManifestFiles(projectDir);
    const manifestFiles: {file: string; origin: 'builtin' | 'project'}[] = [
      ...builtinFiles.map(f => ({file: f, origin: 'builtin' as const})),
      ...projectFiles.map(f => ({file: f, origin: 'project' as const})),
    ];
    if (manifestFiles.length === 0) return;

    const ajv = new Ajv2020({allErrors: true, strict: false});
    const validateMeta = ajv.compile(buildEmitterManifestMetaSchema());

    for (const {file, origin} of manifestFiles) {
      const raw = await readJson(file);
      if (!validateMeta(raw)) {
        const first = validateMeta.errors?.[0];
        throw new ContractsValidationError(
          `Emitter manifest at ${file} failed meta-schema validation: ` +
            `${first?.message ?? 'unknown error'}`,
          {
            sourcePath: file,
            instancePath: first?.instancePath ?? '',
          },
        );
      }
      const manifest = validateManifest(raw);
      const templatePath = resolveTemplatePath(file, manifest);
      // Per-output template paths in plural-form manifests:
      //   - Absolute paths pass through unchanged.
      //   - Built-in manifests (shipped under <plugin-dist>/emitters/manifest/
      //     <kind>/) resolve relative paths against the manifest's own
      //     directory, so `templates/foo.ejs` points to a sibling file the
      //     plugin's copy-templates script lifted into dist.
      //   - Project-local manifests resolve against the project root by
      //     convention (the doc's `templates/<name>/*.ejs` layout), so
      //     consumer authors can keep templates outside `emitters/`.
      // The booter pre-resolves so ManifestBackedEmitter only deals with
      // absolute paths.
      const manifestDir = dirname(file);
      const outputTemplatePaths = (manifest.outputs ?? []).map(o => {
        if (isAbsolute(o.template)) return o.template;
        const anchor = origin === 'builtin' ? manifestDir : this.projectRoot;
        return resolve(anchor, o.template);
      });

      const bindingKey = `platform.contracts.emitters.manifest.${manifest.kind}`;
      this.app
        .bind<ManifestBackedEmitter>(bindingKey)
        .toDynamicValue(
          () =>
            new ManifestBackedEmitter(
              manifest,
              templatePath,
              outputTemplatePaths,
            ),
        )
        .tag({
          [EMITTER_TAG]: EMITTER_TAG,
          kind: manifest.kind,
          source: 'manifest',
        })
        .inScope(BindingScope.SINGLETON);
      this.boundKeys.push(bindingKey);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    while (this.boundKeys.length > 0) {
      const key = this.boundKeys.pop();
      if (key === undefined) continue;
      try {
        this.app.unbind(key);
      } catch (err) {
        // Keep going so partial cleanup still runs; surface via `debug` so
        // genuine cleanup bugs are visible under DEBUG= rather than silent.
        debug('unbind failed for %s: %O', key, err);
      }
    }
    this.started = false;
  }
}

/**
 * List `*.emitter.json` files in `dir`, sorted for deterministic registration
 * order. Returns `[]` (without throwing) when the directory does not exist —
 * projects without a `emitters/` folder are a supported configuration.
 */
/**
 * List built-in manifest files shipped with the plugin. Layout convention:
 * `<plugin-dist>/emitters/manifest/<kind>/emitter.json` (one subdirectory
 * per built-in kind, with `emitter.json` + a sibling templates directory).
 * Returns `[]` when the dir doesn't exist (no built-in manifests shipped
 * yet — fine).
 */
async function listBuiltinManifestFiles(dir: string): Promise<string[]> {
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) return [];
  } catch {
    return [];
  }
  const subdirs = await readdir(dir, {withFileTypes: true});
  const out: string[] = [];
  for (const sub of subdirs) {
    if (!sub.isDirectory()) continue;
    const manifestPath = join(dir, sub.name, 'emitter.json');
    try {
      await stat(manifestPath);
      out.push(manifestPath);
    } catch {
      // Skip kinds that don't have an emitter.json — author error or
      // partial migration. Validated at boot if present.
    }
  }
  return out.sort();
}

async function listManifestFiles(dir: string): Promise<string[]> {
  try {
    const stats = await stat(dir);
    if (!stats.isDirectory()) return [];
  } catch {
    return [];
  }
  const entries = await readdir(dir, {withFileTypes: true});
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.emitter.json')) continue;
    out.push(join(dir, entry.name));
  }
  return out.sort();
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ContractsValidationError(
      `Emitter manifest at ${path} is not valid JSON: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      {sourcePath: path, instancePath: ''},
      {cause},
    );
  }
}

/**
 * Absolutise the manifest's `template` field. Relative paths resolve
 * against the manifest's own directory so authors can keep templates
 * beside the manifest (`./templates/foo.ts.ejs`); absolute paths pass
 * through unchanged.
 *
 * Plural form: when the manifest declares `outputs[]` instead of the
 * legacy singular `template`, this helper returns an empty string —
 * {@link ManifestBackedEmitter} only consumes the booter-supplied
 * absolute path for legacy-form manifests and ignores it for plural-form
 * ones (whose `outputs[].template` paths are author-supplied).
 */
function resolveTemplatePath(
  manifestPath: string,
  manifest: EmitterManifest,
): string {
  if (typeof manifest.template !== 'string') return '';
  if (isAbsolute(manifest.template)) return manifest.template;
  return resolve(dirname(manifestPath), manifest.template);
}
