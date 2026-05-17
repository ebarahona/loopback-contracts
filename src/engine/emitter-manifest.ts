import {ContractsValidationError} from '../helpers';
import type {JSONSchema} from '../interfaces';

/**
 * Allowed values for {@link EmitterManifest.tier}. Mirrors the same triad on
 * {@link ProjectionEmitter.tier} so manifest emitters slot into the same
 * registry ordering as code emitters.
 *
 * @internal
 */
export type EmitterManifestTier =
  | 'lb4-idiom'
  | 'real-translation'
  | 'convenience';

/**
 * Write policy for one rendered output. Mirrors {@link EmittedFile.policy}.
 *
 * @internal
 */
export type EmitterManifestOutputPolicy = 'regen' | 'skipIfExists';

/**
 * One rendered output produced by a manifest emitter. A manifest may declare
 * any number of outputs; each entry renders one EJS template to one path per
 * source schema.
 *
 * @internal
 */
export interface EmitterManifestOutput {
  /**
   * Absolute path to the EJS template the booter resolved (for the legacy
   * singular form) or the manifest-author-supplied template path (for the
   * plural form). Path resolution for the plural form is the manifest
   * author's responsibility for now — see the JSDoc on
   * {@link EmitterManifest.outputs}.
   */
  readonly template: string;
  /**
   * Output path template. Relative to `paths.outputDir`. Supports
   * `{{kebabName}}`, `{{pascalName}}`, `{{camelName}}`, `{{snakeName}}`,
   * `{{kind}}` interpolation against the active schema — see
   * {@link interpolatePath} for the grammar.
   *
   * @example `"models/{{kebabName}}.create.dto.ts"`
   */
  readonly path: string;
  /** Write policy. Default `'regen'`. */
  readonly policy?: EmitterManifestOutputPolicy;
}

/**
 * Parsed shape of a project-local `emitters/*.emitter.json` document.
 *
 * The manifest is the declarative half of Path (b) — "project-local manifest
 * plus EJS template" — described in `contracts-extensibility.md`. A
 * companion {@link ManifestBackedEmitter} reads this interface and adapts it
 * to the {@link ProjectionEmitter} contract so the engine cannot tell
 * manifest emitters apart from code emitters.
 *
 * Two authoring forms are supported:
 *
 * - **Plural** (preferred): set {@link outputs} to a non-empty array. Each
 *   entry renders one template to one path per schema.
 * - **Singular legacy**: set {@link template} and {@link outputSuffix}
 *   (optionally {@link outputDir}). The validator normalises this form to a
 *   single-entry {@link outputs} array so downstream code only ever consumes
 *   the plural shape.
 *
 * Setting both forms at once is a validation error.
 *
 * @internal
 */
export interface EmitterManifest {
  /** Optional JSON-Schema pointer; ignored at runtime, kept for IDE support. */
  readonly $schema?: string;
  /** Unique identifier — drives `--emit-<kind>`, config key, meta-schema enum. */
  readonly kind: string;
  /** Tier for prompts/docs/output ordering. */
  readonly tier: EmitterManifestTier;
  /** Shown in `lb4 init` prompts and `lb4 emitters list` output. */
  readonly description: string;
  /** Optional peer-deps the template's rendered output expects at runtime. */
  readonly peerDeps?: readonly string[];
  /** Optional JSON Schema for the per-schema `x-<kind>` options block. */
  readonly perSchemaOptionsSchema?: JSONSchema;

  /**
   * When `true`, the emitter is opt-in per schema: it emits nothing for
   * schemas that don't declare an `x-<kind>` block. Useful for projection
   * kinds where the schema author has to explicitly tag a contract before
   * it makes sense to project — e.g., CloudEvents wrappers need a
   * deliberate `x-cloudevents.type` value, not every contract is an event.
   *
   * Defaults to `false`: the emitter fires per schema whenever the global
   * `--emit-<kind>` flag is on.
   */
  readonly optIn?: boolean;

  /**
   * Mirrors {@link ProjectionEmitter.outputScope}. When set to
   * `'per-project'` the engine invokes the emitter once per pipeline run
   * (rather than once per schema), which is what manifest-backed emitters
   * that aggregate every schema into a single output document need —
   * e.g. a project-level `swagger.json` that lists every contract under
   * `components.schemas`. Omit or set to `'per-schema'` (default) for the
   * conventional per-schema fan-out.
   *
   * @experimental
   */
  readonly outputScope?: 'per-schema' | 'per-project';

  /**
   * Plural outputs. Each entry renders one EJS template to one path per
   * schema. Path templates use `{{name}}` interpolation against a small
   * fixed context — see {@link interpolatePath} for the available
   * variables.
   *
   * After {@link validateManifest} runs this field is always populated: the
   * validator normalises the legacy singular form into a single-entry array
   * so downstream code consumes one shape only.
   *
   * At authoring time, at least one of `outputs` or the singular legacy
   * `template`/`outputSuffix` fields must be set; setting both at once is
   * an error.
   */
  readonly outputs?: readonly EmitterManifestOutput[];

  // ---- Singular legacy form (sugar for one output) ----
  /**
   * @deprecated Use `outputs[].template` instead. Kept for backward
   * compatibility — internally normalised to a single-entry `outputs[]`.
   */
  readonly template?: string;
  /**
   * @deprecated Use `outputs[].path` (which carries the full filename)
   * instead. Kept for backward compatibility.
   */
  readonly outputSuffix?: string;
  /**
   * @deprecated Use the directory portion of `outputs[].path` instead.
   */
  readonly outputDir?: string;
}

/**
 * Default sub-directory under `paths.outputDir` used when a legacy-form
 * manifest omits {@link EmitterManifest.outputDir}. Mirrors the historic
 * behaviour of {@link ManifestBackedEmitter}, kept here so the validator's
 * normalisation step produces the exact same path the pre-plural code path
 * would have written.
 */
const DEFAULT_LEGACY_OUTPUT_SUBDIR = 'models';

/**
 * Validate a raw JSON value against the manifest shape and return it as a
 * typed {@link EmitterManifest}.
 *
 * Performs only shape-level checks (presence and type of required fields,
 * union narrowing of `tier`, mutual-exclusion of plural vs legacy forms).
 * Deep validation of `perSchemaOptionsSchema` itself is left to Ajv via the
 * `_meta/emitter.schema.json` meta-schema; this helper exists so callers
 * without an Ajv instance — early bootstrap code, fixtures, error reporters
 * — can still parse manifests defensively.
 *
 * The returned manifest always has {@link EmitterManifest.outputs}
 * populated: legacy singular fields are normalised into a single-entry
 * `outputs[]` array. The legacy fields are also preserved on the returned
 * object for diagnostics and serialisation round-trips.
 *
 * @internal
 * @param raw - Parsed JSON document, typically the result of
 *   `JSON.parse(readFileSync(...))`.
 * @returns The same value, narrowed to {@link EmitterManifest} with
 *   `outputs[]` always populated.
 * @throws ContractsValidationError When a required field is missing or
 *   carries the wrong primitive type, when both forms are set, when
 *   neither form is set, or when an `outputs[]` entry is malformed.
 */
export function validateManifest(raw: unknown): EmitterManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw shapeError('manifest must be a JSON object', '');
  }
  const obj = raw as Record<string, unknown>;

  requireString(obj, 'kind', '/kind');
  requireString(obj, 'description', '/description');

  const tier = obj['tier'];
  if (
    tier !== 'lb4-idiom' &&
    tier !== 'real-translation' &&
    tier !== 'convenience'
  ) {
    throw shapeError(
      `manifest 'tier' must be one of 'lb4-idiom' | 'real-translation' | ` +
        `'convenience', got ${JSON.stringify(tier)}`,
      '/tier',
    );
  }

  if (obj['peerDeps'] !== undefined) {
    const peers = obj['peerDeps'];
    if (
      !Array.isArray(peers) ||
      !peers.every((p): p is string => typeof p === 'string')
    ) {
      throw shapeError(
        "manifest 'peerDeps' must be a string[] when present",
        '/peerDeps',
      );
    }
  }

  if (
    obj['perSchemaOptionsSchema'] !== undefined &&
    (typeof obj['perSchemaOptionsSchema'] !== 'object' ||
      obj['perSchemaOptionsSchema'] === null ||
      Array.isArray(obj['perSchemaOptionsSchema']))
  ) {
    throw shapeError(
      "manifest 'perSchemaOptionsSchema' must be a JSON Schema object",
      '/perSchemaOptionsSchema',
    );
  }

  if (obj['optIn'] !== undefined && typeof obj['optIn'] !== 'boolean') {
    throw shapeError(
      "manifest 'optIn' must be a boolean when present",
      '/optIn',
    );
  }

  if (
    obj['outputScope'] !== undefined &&
    obj['outputScope'] !== 'per-schema' &&
    obj['outputScope'] !== 'per-project'
  ) {
    throw shapeError(
      "manifest 'outputScope' must be 'per-schema' | 'per-project' when " +
        `present, got ${JSON.stringify(obj['outputScope'])}`,
      '/outputScope',
    );
  }

  if (obj['outputDir'] !== undefined && typeof obj['outputDir'] !== 'string') {
    throw shapeError(
      "manifest 'outputDir' must be a string when present",
      '/outputDir',
    );
  }

  if (obj['$schema'] !== undefined && typeof obj['$schema'] !== 'string') {
    throw shapeError(
      "manifest '$schema' must be a string when present",
      '/$schema',
    );
  }

  const hasPlural = obj['outputs'] !== undefined;
  const hasLegacyTemplate = obj['template'] !== undefined;
  const hasLegacySuffix = obj['outputSuffix'] !== undefined;
  const hasLegacy = hasLegacyTemplate || hasLegacySuffix;

  if (hasPlural && hasLegacy) {
    throw shapeError(
      "manifest must use either the plural 'outputs' form or the legacy " +
        "'template'/'outputSuffix' form, not both",
      '/outputs',
    );
  }
  if (!hasPlural && !hasLegacy) {
    throw shapeError(
      "manifest must declare either 'outputs' (plural form) or " +
        "'template' + 'outputSuffix' (legacy form)",
      '',
    );
  }

  let plural: readonly EmitterManifestOutput[];
  if (hasPlural) {
    plural = validatePluralOutputs(obj['outputs']);
  } else {
    requireString(obj, 'template', '/template');
    requireString(obj, 'outputSuffix', '/outputSuffix');
    const subdir =
      typeof obj['outputDir'] === 'string' && obj['outputDir'].length > 0
        ? obj['outputDir']
        : DEFAULT_LEGACY_OUTPUT_SUBDIR;
    plural = [
      {
        // The legacy `template` is still a relative path here; the booter
        // absolutises it before constructing the emitter, and
        // ManifestBackedEmitter swaps the booter-resolved absolute path in
        // when it builds its own output list. The same shape is mirrored
        // on the normalised value so downstream code consumes one form.
        template: obj['template'] as string,
        path: `${subdir}/{{kebabName}}${obj['outputSuffix'] as string}`,
        policy: 'regen',
      },
    ];
  }

  // Building the typed object explicitly avoids leaking unknown fields and
  // satisfies `exactOptionalPropertyTypes` (no `key: undefined` slots).
  const manifest: EmitterManifest = {
    kind: obj['kind'] as string,
    tier: tier,
    description: obj['description'] as string,
    outputs: plural,
  };
  if (obj['$schema'] !== undefined) {
    Object.assign(manifest, {$schema: obj['$schema'] as string});
  }
  if (obj['peerDeps'] !== undefined) {
    Object.assign(manifest, {peerDeps: obj['peerDeps'] as readonly string[]});
  }
  if (obj['perSchemaOptionsSchema'] !== undefined) {
    Object.assign(manifest, {
      perSchemaOptionsSchema: obj['perSchemaOptionsSchema'] as JSONSchema,
    });
  }
  if (obj['optIn'] !== undefined) {
    Object.assign(manifest, {optIn: obj['optIn'] as boolean});
  }
  if (obj['outputScope'] !== undefined) {
    Object.assign(manifest, {
      outputScope: obj['outputScope'] as 'per-schema' | 'per-project',
    });
  }
  // Preserve the legacy fields on the returned object too, for diagnostics
  // and serialisation round-trips. Only fields the author actually wrote
  // get carried; the validator never invents legacy fields for a manifest
  // authored in plural form.
  if (hasLegacyTemplate) {
    Object.assign(manifest, {template: obj['template'] as string});
  }
  if (hasLegacySuffix) {
    Object.assign(manifest, {outputSuffix: obj['outputSuffix'] as string});
  }
  if (obj['outputDir'] !== undefined) {
    Object.assign(manifest, {outputDir: obj['outputDir'] as string});
  }

  return manifest;
}

/**
 * Validate the plural `outputs` field. Returns a frozen, typed view of the
 * entries; throws {@link ContractsValidationError} with a precise
 * `instancePath` on the first malformed entry.
 */
function validatePluralOutputs(raw: unknown): readonly EmitterManifestOutput[] {
  if (!Array.isArray(raw)) {
    throw shapeError("manifest 'outputs' must be an array", '/outputs');
  }
  if (raw.length === 0) {
    throw shapeError(
      "manifest 'outputs' must contain at least one entry",
      '/outputs',
    );
  }
  const out: EmitterManifestOutput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    const base = `/outputs/${i}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw shapeError(`manifest 'outputs[${i}]' must be an object`, base);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e['template'] !== 'string' || e['template'].length === 0) {
      throw shapeError(
        `manifest 'outputs[${i}].template' must be a non-empty string`,
        `${base}/template`,
      );
    }
    if (typeof e['path'] !== 'string' || e['path'].length === 0) {
      throw shapeError(
        `manifest 'outputs[${i}].path' must be a non-empty string`,
        `${base}/path`,
      );
    }
    const policyRaw = e['policy'];
    if (
      policyRaw !== undefined &&
      policyRaw !== 'regen' &&
      policyRaw !== 'skipIfExists'
    ) {
      throw shapeError(
        `manifest 'outputs[${i}].policy' must be 'regen' | 'skipIfExists' ` +
          `when present, got ${JSON.stringify(policyRaw)}`,
        `${base}/policy`,
      );
    }
    const normalised: EmitterManifestOutput =
      policyRaw === undefined
        ? {template: e['template'], path: e['path']}
        : {
            template: e['template'],
            path: e['path'],
            policy: policyRaw as EmitterManifestOutputPolicy,
          };
    out.push(normalised);
  }
  return out;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  instancePath: string,
): void {
  if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
    throw shapeError(
      `manifest '${key}' must be a non-empty string`,
      instancePath,
    );
  }
}

function shapeError(
  message: string,
  instancePath: string,
): ContractsValidationError {
  return new ContractsValidationError(message, {
    sourcePath: '<manifest>',
    instancePath,
  });
}
