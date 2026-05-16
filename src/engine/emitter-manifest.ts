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
 * Parsed shape of a project-local `emitters/*.emitter.json` document.
 *
 * The manifest is the declarative half of Path (b) — "project-local manifest
 * plus EJS template" — described in `contracts-extensibility.md`. A
 * companion {@link ManifestBackedEmitter} reads this interface and adapts it
 * to the {@link ProjectionEmitter} contract so the engine cannot tell
 * manifest emitters apart from code emitters.
 *
 * @internal
 */
export interface EmitterManifest {
  /** Optional JSON-Schema pointer; ignored at runtime, kept for IDE support. */
  $schema?: string;
  /** Unique identifier — drives `--emit-<kind>`, config key, meta-schema enum. */
  kind: string;
  /** Output file suffix appended to the derived basename (e.g. `.myevent.ts`). */
  outputSuffix: string;
  /** Tier for prompts/docs/output ordering. */
  tier: EmitterManifestTier;
  /** Shown in `lb4 init` prompts and `lb4 emitters list` output. */
  description: string;
  /** Path to the EJS template; relative paths resolve against the manifest. */
  template: string;
  /** Optional peer-deps the template's rendered output expects at runtime. */
  peerDeps?: string[];
  /** Optional JSON Schema for the per-schema `x-<kind>` options block. */
  perSchemaOptionsSchema?: JSONSchema;
  /**
   * Optional output sub-directory beneath `paths.outputDir`. Defaults to
   * `'models'` so manifest emitters land in `<outputDir>/models/<base><suffix>`
   * — matching where built-in sidecar emitters write their artefacts.
   */
  outputDir?: string;
}

/**
 * Validate a raw JSON value against the manifest shape and return it as a
 * typed {@link EmitterManifest}.
 *
 * Performs only shape-level checks (presence and type of required fields,
 * union narrowing of `tier`). Deep validation of `perSchemaOptionsSchema`
 * itself is left to Ajv via the `_meta/emitter.schema.json` meta-schema; this
 * helper exists so callers without an Ajv instance — early bootstrap code,
 * fixtures, error reporters — can still parse manifests defensively.
 *
 * @internal
 * @param raw - Parsed JSON document, typically the result of
 *   `JSON.parse(readFileSync(...))`.
 * @returns The same value, narrowed to {@link EmitterManifest}.
 * @throws ContractsValidationError When a required field is missing or
 *   carries the wrong primitive type.
 */
export function validateManifest(raw: unknown): EmitterManifest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw shapeError('manifest must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  requireString(obj, 'kind');
  requireString(obj, 'outputSuffix');
  requireString(obj, 'description');
  requireString(obj, 'template');

  const tier = obj['tier'];
  if (
    tier !== 'lb4-idiom' &&
    tier !== 'real-translation' &&
    tier !== 'convenience'
  ) {
    throw shapeError(
      `manifest 'tier' must be one of 'lb4-idiom' | 'real-translation' | ` +
        `'convenience', got ${JSON.stringify(tier)}`,
    );
  }

  if (obj['peerDeps'] !== undefined) {
    const peers = obj['peerDeps'];
    if (
      !Array.isArray(peers) ||
      !peers.every((p): p is string => typeof p === 'string')
    ) {
      throw shapeError("manifest 'peerDeps' must be a string[] when present");
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
    );
  }

  if (obj['outputDir'] !== undefined && typeof obj['outputDir'] !== 'string') {
    throw shapeError("manifest 'outputDir' must be a string when present");
  }

  if (obj['$schema'] !== undefined && typeof obj['$schema'] !== 'string') {
    throw shapeError("manifest '$schema' must be a string when present");
  }

  // Building the typed object explicitly avoids leaking unknown fields and
  // satisfies `exactOptionalPropertyTypes` (no `key: undefined` slots).
  const manifest: EmitterManifest = {
    kind: obj['kind'] as string,
    outputSuffix: obj['outputSuffix'] as string,
    tier: tier,
    description: obj['description'] as string,
    template: obj['template'] as string,
  };
  if (obj['$schema'] !== undefined) manifest.$schema = obj['$schema'] as string;
  if (obj['peerDeps'] !== undefined)
    manifest.peerDeps = obj['peerDeps'] as string[];
  if (obj['perSchemaOptionsSchema'] !== undefined)
    manifest.perSchemaOptionsSchema = obj[
      'perSchemaOptionsSchema'
    ] as JSONSchema;
  if (obj['outputDir'] !== undefined)
    manifest.outputDir = obj['outputDir'] as string;

  return manifest;
}

function requireString(obj: Record<string, unknown>, key: string): void {
  if (typeof obj[key] !== 'string' || (obj[key] as string).length === 0) {
    throw shapeError(`manifest '${key}' must be a non-empty string`);
  }
}

function shapeError(message: string): ContractsValidationError {
  return new ContractsValidationError(message, {
    sourcePath: '<manifest>',
    instancePath: '',
  });
}
