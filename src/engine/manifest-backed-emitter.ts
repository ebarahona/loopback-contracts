import Ajv2020 from 'ajv/dist/2020';
import type {ValidateFunction} from 'ajv';
import {ContractsCodegenError, ContractsValidationError} from '../helpers';
import {toCamel, toKebab, toPascal, toSnake} from '../helpers/identifiers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  ProjectionEmitter,
} from '../interfaces';
import type {
  EmitterManifest,
  EmitterManifestOutput,
  EmitterManifestTier,
} from './emitter-manifest';
import {
  interpolatePath,
  type PathInterpolationContext,
} from './manifest-path-template';

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
 * Strip directory separators and the trailing `.schema.json` suffix from a
 * schema `$id` so manifest emitters land at a filename built from the bare
 * identifier (e.g. `'customer.v1'` -\> `'customer.v1'`).
 */
function baseName(id: string): string {
  const last = id.split(/[\\/]/).pop() ?? id;
  return last.replace(/\.schema\.json$/i, '');
}

/**
 * Compute the derived per-schema synthetic identifier — the input to every
 * `{{...Name}}` placeholder. We use the dot-separated head of the schema
 * `$id` (e.g. `customer.v1` -\> `customer`) so the casing helpers do not
 * fold a version suffix into the rendered name. Manifest authors who want
 * the full id can still reach it through other template helpers if/when
 * they are added.
 */
function identifierStem(schemaId: string): string {
  const base = baseName(schemaId);
  return base.split('.')[0] ?? base;
}

/**
 * Resolved output the emitter renders once per (schema, output-entry) pair.
 * Shared between the legacy single-output path and the plural-outputs path
 * so the `emit()` loop only has to think in one shape.
 */
interface ResolvedOutput {
  readonly template: string;
  readonly pathTemplate: string;
  readonly policy: 'regen' | 'skipIfExists';
}

/**
 * Adapter that exposes a project-local {@link EmitterManifest} as the
 * engine's stable {@link ProjectionEmitter} contract.
 *
 * The class holds no behaviour the manifest itself could not declare; it
 * simply (a) extracts the per-schema options block, (b) optionally validates
 * it with Ajv when `perSchemaOptionsSchema` is supplied, (c) computes a
 * small view-model and a path-interpolation context, (d) renders every
 * `outputs[]` entry, and (e) returns one regen/skipIfExists
 * {@link EmittedFile} per output. The {@link ProjectionEmitter.validate}
 * hook is deliberately omitted — per the extensibility doc, manifest
 * emitters skip strict-mode lossy reporting.
 *
 * Plural outputs: the manifest's `outputs[]` drives the emit loop. The
 * legacy singular `template` / `outputSuffix` form is normalised to a
 * single-entry `outputs[]` by {@link validateManifest} so this class only
 * deals with the plural shape internally.
 *
 * @internal
 */
export class ManifestBackedEmitter implements ProjectionEmitter {
  readonly kind: string;
  /** Whether the emitter skips schemas with no `x-<kind>` block. */
  private readonly optIn: boolean;
  /**
   * Display suffix surfaced through {@link EmitterRegistry.listMetadata}.
   *
   * For a legacy-form manifest this is the author-declared `outputSuffix`.
   * For a plural-form manifest there is no canonical single suffix to
   * report, so we derive one from the basename of the first output's path
   * template — the conventional shape ends with `.something.ts`, which is
   * exactly the slice the registry shows in `lb-contracts emitters list`.
   */
  readonly outputSuffix: string;
  readonly tier: EmitterManifestTier;
  readonly description: string;
  readonly peerDeps?: string[];
  readonly perSchemaOptionsSchema?: JSONSchema;
  readonly templatePaths: readonly string[];
  /**
   * Mirrors {@link ProjectionEmitter.outputScope} on the manifest. Forwarded
   * verbatim from the manifest so the engine's runner honours per-project
   * fan-in for manifest-backed emitters the same way it does for TS-class
   * emitters. Left `undefined` when the manifest omits it — the runner
   * treats absent as `'per-schema'`.
   */
  readonly outputScope?: 'per-schema' | 'per-project';

  /** Resolved, plural-shape outputs the `emit()` loop iterates. */
  private readonly resolvedOutputs: readonly ResolvedOutput[];
  /** Compiled-once Ajv validator for the per-schema options block. */
  private readonly compiledOptionsValidator?: ValidateFunction;

  /**
   * @param manifest - Validated manifest document. The validator guarantees
   *   `manifest.outputs` is populated (legacy singular fields are
   *   normalised to a single-entry array).
   * @param templatePath - Absolute filesystem path to the EJS template the
   *   manifest's legacy `template` field resolves to. The booter does the
   *   resolution so this class never has to know where on disk the manifest
   *   itself lived. For a plural-form manifest the booter does not have a
   *   single template to resolve; the manifest's `outputs[].template`
   *   paths are used as-authored and are expected to be absolute.
   */
  constructor(
    manifest: EmitterManifest,
    private readonly templatePath: string,
    private readonly outputTemplatePaths: readonly string[] = [],
  ) {
    this.kind = manifest.kind;
    this.tier = manifest.tier;
    this.description = manifest.description;
    this.optIn = manifest.optIn === true;
    // Forward `outputScope` only when the manifest set it — the
    // `exactOptionalPropertyTypes` compiler flag rejects writing
    // `undefined` to an optional slot, and the runner treats absent and
    // `'per-schema'` as equivalent so leaving the field unset is the right
    // default-per-schema behaviour.
    if (manifest.outputScope !== undefined) {
      this.outputScope = manifest.outputScope;
    }
    if (manifest.peerDeps !== undefined) {
      // ProjectionEmitter declares `peerDeps` as a mutable `string[]`; copy
      // out of the readonly manifest array to satisfy the interface without
      // exposing the manifest's frozen slice.
      this.peerDeps = manifest.peerDeps.slice();
    }
    if (manifest.perSchemaOptionsSchema !== undefined) {
      // Shallow-freeze a STRUCTURAL COPY of the manifest's per-schema
      // options schema. Matches the contract every first-party sidecar
      // emitter honours (see sidecar-options-schema-frozen.spec.ts): the
      // engine's options-validator cache compiles once at construction
      // and relies on the schema literal being immutable thereafter. A
      // manifest author who kept a reference to the parsed JSON and
      // mutated it post-construction would otherwise feed a stale
      // validator on subsequent runs.
      this.perSchemaOptionsSchema = Object.freeze({
        ...manifest.perSchemaOptionsSchema,
      });
      this.compiledOptionsValidator = getManifestAjv().compile(
        this.perSchemaOptionsSchema as object,
      );
    }

    // The validator always populates `outputs[]`. Defensive check anyway —
    // a caller constructing this class directly without going through the
    // validator (e.g. a test) gets a precise error instead of a
    // `Cannot read properties of undefined` later in `emit()`.
    if (manifest.outputs === undefined || manifest.outputs.length === 0) {
      throw new ContractsCodegenError(
        `Manifest emitter '${manifest.kind}' has no outputs declared; ` +
          `validateManifest() guarantees this never happens — did you ` +
          `construct ManifestBackedEmitter without going through the ` +
          `validator?`,
        {emitterKind: `manifest:${manifest.kind}`, schemaId: '<unknown>'},
      );
    }

    // For the legacy form the booter resolved the singular template to an
    // absolute path; swap that resolved path in for `outputs[0].template`
    // so the emit loop sees one consistent shape. The plural form keeps
    // the author-supplied template paths verbatim.
    const isLegacy = manifest.template !== undefined;
    this.resolvedOutputs = manifest.outputs.map((entry, idx) =>
      resolveOutput(
        entry,
        idx,
        isLegacy,
        templatePath,
        this.outputTemplatePaths,
      ),
    );

    this.templatePaths = Object.freeze(
      this.resolvedOutputs.map(o => o.template),
    );

    this.outputSuffix = deriveDisplaySuffix(manifest, this.resolvedOutputs);
  }

  emit(ctx: EmitterContext): EmittedFile[] {
    const optionsKey = `x-${this.kind}`;
    const options: unknown = ctx.schema[optionsKey];

    // Opt-in emitters skip schemas that don't declare an x-<kind> block at
    // all — the schema author has to explicitly tag a contract before
    // emission makes sense (CloudEvents wrappers, for instance, only
    // belong on contracts the author has marked as events).
    if (this.optIn && options === undefined) return [];

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
    const stem = identifierStem(schemaId);
    const pathCtx: PathInterpolationContext = {
      kebabName: toKebab(stem),
      pascalName: toPascal(stem),
      camelName: toCamel(stem),
      snakeName: toSnake(stem),
      kind: this.kind,
    };
    const className = toPascal(stem);

    const viewModel = {
      schema: ctx.schema,
      options,
      className,
      schemaId,
      registry: ctx.registry,
      importMap: ctx.importMap,
      paths: ctx.paths,
    };

    const files: EmittedFile[] = [];
    for (const output of this.resolvedOutputs) {
      let content: string;
      try {
        content = ctx.templates.render(output.template, viewModel);
      } catch (cause) {
        // Re-raise with the manifest's emitter kind so the engine's error
        // reporter attributes the failure to the right contribution.
        throw new ContractsCodegenError(
          `Manifest emitter '${this.kind}' failed to render template ${output.template}`,
          {
            emitterKind: `manifest:${this.kind}`,
            schemaId,
            outputPath: output.template,
          },
          {cause},
        );
      }
      const path = interpolatePath(output.pathTemplate, pathCtx);
      files.push({
        path,
        content,
        policy: output.policy,
        producer: `manifest:${this.kind}`,
      });
    }
    return files;
  }
}

/**
 * Resolve one {@link EmitterManifestOutput} entry to its runtime
 * {@link ResolvedOutput} form. For the legacy form the booter-supplied
 * absolute `templatePath` replaces the (still-relative) `template` field
 * on the single normalised entry. For the plural form the
 * author-supplied template path is used as-is.
 */
function resolveOutput(
  entry: EmitterManifestOutput,
  idx: number,
  isLegacy: boolean,
  templatePath: string,
  outputTemplatePaths: readonly string[],
): ResolvedOutput {
  // For legacy form the validator normalises into exactly one entry, so
  // the booter-resolved absolute path always corresponds to index 0. For
  // plural form the booter pre-resolved each output's template against the
  // project root (per the doc layout convention) and passes them in via
  // `outputTemplatePaths` in declaration order — use that when present,
  // otherwise fall back to the author-supplied path (absolute or relative
  // — only used by tests that construct ManifestBackedEmitter directly).
  let resolvedTemplate: string;
  if (isLegacy && idx === 0) {
    resolvedTemplate = templatePath;
  } else if (outputTemplatePaths[idx] !== undefined) {
    resolvedTemplate = outputTemplatePaths[idx];
  } else {
    resolvedTemplate = entry.template;
  }
  return {
    template: resolvedTemplate,
    pathTemplate: entry.path,
    policy: entry.policy ?? 'regen',
  };
}

/**
 * Best-effort display suffix for {@link EmitterRegistry.listMetadata}.
 *
 * Legacy form preserves the author-declared `outputSuffix` exactly. Plural
 * form falls back to the basename slice of the first output's path
 * template starting at the first `.` — for `models/{{kebabName}}.dto.ts`
 * that yields `.dto.ts`, which is what users expect to see in the
 * `lb-contracts emitters list` column.
 */
function deriveDisplaySuffix(
  manifest: EmitterManifest,
  outputs: readonly ResolvedOutput[],
): string {
  if (typeof manifest.outputSuffix === 'string') return manifest.outputSuffix;
  const first = outputs[0];
  if (first === undefined) return '';
  const tail = first.pathTemplate.split(/[\\/]/).pop() ?? first.pathTemplate;
  const dot = tail.indexOf('.');
  return dot >= 0 ? tail.slice(dot) : tail;
}
