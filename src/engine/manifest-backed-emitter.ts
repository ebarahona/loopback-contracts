import Ajv2020 from 'ajv/dist/2020';
import type {ValidateFunction} from 'ajv';
import {ContractsCodegenError, ContractsValidationError} from '../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  ProjectionEmitter,
} from '../interfaces';
import type {EmitterManifest, EmitterManifestTier} from './emitter-manifest';

/**
 * Module-level lazy singleton Ajv2020 used by every {@link ManifestBackedEmitter}
 * instance to compile its `perSchemaOptionsSchema`. Constructing an Ajv
 * instance compiles the draft-2020-12 meta-schema, which is non-trivial;
 * sharing a single instance across all manifests amortises that cost
 * (manifests can number in the dozens at scale). Each `compile()` call
 * still returns a fresh validator closure, so there is no per-manifest
 * state cross-talk through the shared instance.
 */
let sharedManifestAjv: Ajv2020 | undefined;

function getManifestAjv(): Ajv2020 {
  if (sharedManifestAjv === undefined) {
    sharedManifestAjv = new Ajv2020({allErrors: true, strict: false});
  }
  return sharedManifestAjv;
}

/**
 * Word splitter shared with the template engine's `h.pascal`. Kept local so
 * this emitter does not reach across engine modules for a single helper.
 */
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

function pascalCase(s: string): string {
  return words(s)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Strip directory separators and the trailing `.schema.json` suffix from a
 * schema `$id` so manifest emitters land at a filename built from the bare
 * identifier (e.g. `'customer.v1'` -> `'customer.v1'`).
 */
function baseName(id: string): string {
  const last = id.split(/[\\/]/).pop() ?? id;
  return last.replace(/\.schema\.json$/i, '');
}

/**
 * Default sub-directory under `paths.outputDir` for manifest emitters. Mirrors
 * where the built-in sidecar emitters write so a project's `src/models/` tree
 * holds every per-schema artefact regardless of which path produced it.
 */
const DEFAULT_OUTPUT_SUBDIR = 'models';

/**
 * Adapter that exposes a project-local {@link EmitterManifest} as the
 * engine's stable {@link ProjectionEmitter} contract.
 *
 * The class holds no behaviour the manifest itself could not declare; it
 * simply (a) extracts the per-schema options block, (b) optionally validates
 * it with Ajv when `perSchemaOptionsSchema` is supplied, (c) computes a small
 * view-model, (d) renders the manifest's EJS template, and (e) returns a
 * single regen-policy {@link EmittedFile}. The {@link ProjectionEmitter.validate}
 * hook is deliberately omitted — per the extensibility doc, manifest emitters
 * skip strict-mode lossy reporting.
 *
 * @internal
 */
export class ManifestBackedEmitter implements ProjectionEmitter {
  readonly kind: string;
  readonly outputSuffix: string;
  readonly tier: EmitterManifestTier;
  readonly description: string;
  readonly peerDeps?: string[];
  readonly perSchemaOptionsSchema?: JSONSchema;
  readonly templatePaths: readonly string[];

  /** Sub-directory under `paths.outputDir` files are written to. */
  private readonly outputSubdir: string;
  /** Compiled-once Ajv validator for the per-schema options block. */
  private readonly compiledOptionsValidator?: ValidateFunction;

  /**
   * @param manifest - Validated manifest document.
   * @param templatePath - Absolute filesystem path to the EJS template the
   *   manifest's `template` field resolves to. The booter does the
   *   resolution so this class never has to know where on disk the manifest
   *   itself lived.
   */
  constructor(
    private readonly manifest: EmitterManifest,
    private readonly templatePath: string,
  ) {
    this.kind = manifest.kind;
    this.outputSuffix = manifest.outputSuffix;
    this.tier = manifest.tier;
    this.description = manifest.description;
    this.templatePaths = [templatePath];
    if (manifest.peerDeps !== undefined) this.peerDeps = manifest.peerDeps;
    if (manifest.perSchemaOptionsSchema !== undefined) {
      this.perSchemaOptionsSchema = manifest.perSchemaOptionsSchema;
      this.compiledOptionsValidator = getManifestAjv().compile(
        manifest.perSchemaOptionsSchema as object,
      );
    }
    this.outputSubdir = manifest.outputDir ?? DEFAULT_OUTPUT_SUBDIR;
  }

  emit(ctx: EmitterContext): EmittedFile[] {
    const optionsKey = `x-${this.kind}`;
    const options: unknown = ctx.schema[optionsKey];

    if (
      this.compiledOptionsValidator !== undefined &&
      options !== undefined &&
      !this.compiledOptionsValidator(options)
    ) {
      const errors = this.compiledOptionsValidator.errors ?? [];
      const first = errors[0];
      throw new ContractsValidationError(
        `Per-schema options '${optionsKey}' on '${ctx.schema.$id ?? '<no-$id>'}' ` +
          `failed manifest 'perSchemaOptionsSchema': ${first?.message ?? 'invalid'}`,
        {
          sourcePath: ctx.schema.$id ?? '<unknown>',
          instancePath: first?.instancePath ?? '',
          ...(ctx.schema.$id !== undefined ? {schemaId: ctx.schema.$id} : {}),
        },
      );
    }

    const schemaId = ctx.schema.$id;
    if (schemaId === undefined) {
      throw new ContractsCodegenError(
        `Manifest emitter '${this.kind}' requires the source schema to declare a top-level \`$id\``,
        {emitterKind: `manifest:${this.kind}`, schemaId: '<unknown>'},
      );
    }
    const idHead = schemaId.split('.')[0] ?? schemaId;
    const className = pascalCase(idHead);

    const viewModel = {
      schema: ctx.schema,
      options,
      className,
      schemaId,
      registry: ctx.registry,
      importMap: ctx.importMap,
      paths: ctx.paths,
    };

    let content: string;
    try {
      content = ctx.templates.render(this.templatePath, viewModel);
    } catch (cause) {
      // Re-raise with the manifest's emitter kind so the engine's error
      // reporter attributes the failure to the right contribution.
      throw new ContractsCodegenError(
        `Manifest emitter '${this.kind}' failed to render template ${this.templatePath}`,
        {
          emitterKind: `manifest:${this.kind}`,
          schemaId,
          outputPath: this.templatePath,
        },
        {cause},
      );
    }

    const path = `${this.outputSubdir}/${baseName(schemaId)}${this.outputSuffix}`;
    return [
      {
        path,
        content,
        policy: 'regen',
        producer: `manifest:${this.kind}`,
      },
    ];
  }
}
