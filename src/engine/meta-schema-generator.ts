// Pure functions that build the project-specific meta-schemas the engine
// writes to `_meta/` on every `lb4 gen`. The output of every function here
// is a plain JSON Schema 2020-12 document — no DI, no I/O, no Ajv. The
// pipeline (stage 5) handles persistence and validation.
//
// Each generator takes the current project state and returns a *fresh*
// document; callers are free to layer plugin-contributed
// `MetaSchemaContributor` mutations on top before persisting.

import type {DatasourceConfigJson} from '../types';
import type {JSONSchema} from '../interfaces';

/** Relation kinds the model-config meta-schema accepts at v1.0. */
const RELATION_TYPES = [
  'hasMany',
  'belongsTo',
  'hasOne',
  'hasManyThrough',
] as const;

/** Model base classes the model-config meta-schema accepts at v1.0. */
const MODEL_BASES = ['Entity', 'Model'] as const;

/**
 * Extract `$id` values from a list of loaded schemas, skipping anonymous
 * ones (which would never round-trip through the model-config enums).
 */
function collectSchemaIds(schemas: readonly JSONSchema[]): string[] {
  const out: string[] = [];
  for (const s of schemas) {
    if (typeof s.$id === 'string' && s.$id.length > 0) out.push(s.$id);
  }
  return [...new Set(out)].sort();
}

/**
 * Build `_meta/model-config.schema.json` — the per-project meta-schema that
 * `configs/*.config.json` files are validated against in stage 5.
 *
 * The enums are baked from project state: `$contractId` only accepts an
 * `$id` declared by some loaded schema, `dataSource` only accepts a key
 * present in the project's `datasources.json`, and `relations.*.schema`
 * follows the same enum as `$contractId`.
 *
 * @internal
 */
export function buildModelConfigMetaSchema(
  schemas: readonly JSONSchema[],
  datasources: readonly DatasourceConfigJson[],
): JSONSchema {
  const schemaIds = collectSchemaIds(schemas);
  const datasourceNames = [...new Set(datasources.map(d => d.name))].sort();

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ebarahona.dev/loopback-contracts/_meta/model-config.schema.json',
    title: 'LoopBack 4 model-config (generated)',
    type: 'object',
    additionalProperties: false,
    required: ['$contractId', 'dataSource', 'public'],
    properties: {
      $schema: {type: 'string'},
      $contractId: {
        type: 'string',
        ...(schemaIds.length > 0 ? {enum: schemaIds} : {}),
      },
      dataSource: {
        type: 'string',
        minLength: 1,
        ...(datasourceNames.length > 0 ? {enum: datasourceNames} : {}),
      },
      public: {type: 'boolean'},
      model: {
        type: 'object',
        additionalProperties: true,
        properties: {
          base: {type: 'string', enum: [...MODEL_BASES]},
          hiddenProperties: {type: 'array', items: {type: 'string'}},
        },
      },
      relations: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'schema'],
          properties: {
            type: {type: 'string', enum: [...RELATION_TYPES]},
            schema: {
              type: 'string',
              ...(schemaIds.length > 0 ? {enum: schemaIds} : {}),
            },
            through: {type: 'string'},
            keyFrom: {type: 'string'},
            keyTo: {type: 'string'},
          },
        },
      },
      acls: {type: 'array', items: {$ref: '#/$defs/acl'}},
    },
    $defs: {
      acl: {
        type: 'object',
        additionalProperties: false,
        required: ['principalType', 'principalId', 'permission', 'accessType'],
        properties: {
          principalType: {type: 'string', enum: ['ROLE', 'USER', 'APP']},
          principalId: {type: 'string'},
          permission: {type: 'string', enum: ['ALLOW', 'DENY']},
          accessType: {
            type: 'string',
            enum: ['READ', 'WRITE', 'EXECUTE', '*'],
          },
          property: {type: 'string'},
        },
      },
    },
  };
}

/**
 * Build `_meta/datasources.schema.json` — the meta-schema validating the
 * project's `datasources.json`. The `adapter` enum is populated from the
 * `installedAdapters` list passed in by the caller (which the engine reads
 * from `node_modules` for LB4 connectors). When the list is empty, the
 * enum is omitted so authoring still works on a fresh project.
 *
 * @internal
 */
export function buildDatasourcesMetaSchema(
  installedAdapters: readonly string[] = [],
): JSONSchema {
  const adapters = [...new Set(installedAdapters)].sort();
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ebarahona.dev/loopback-contracts/_meta/datasources.schema.json',
    title: 'LoopBack 4 datasources.json (generated)',
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'adapter'],
      properties: {
        $schema: {type: 'string'},
        name: {type: 'string', minLength: 1},
        adapter: {
          type: 'string',
          ...(adapters.length > 0 ? {enum: adapters} : {}),
        },
        config: {type: 'object', additionalProperties: true},
      },
    },
  };
}

/**
 * Build `_meta/loopback-config.schema.json` — the meta-schema validating
 * the per-project `loopback.config.json`. The `emit` property mixes
 * boolean per-emitter toggles (one slot per registered `kind`) with two
 * reserved string-valued module-format keys (`esm`, `importExtension`)
 * documented on {@link LoopbackConfigJson.emit}.
 *
 * Representation note — the natural shape
 * `additionalProperties\: \{type\: boolean\}` would conflict with the
 * string-typed `importExtension` reserved key. We resolve the conflict
 * the JSON Schema 2020-12 way: list the two reserved keys explicitly
 * under `properties` (with their narrow string/boolean schemas), then
 * leave `additionalProperties` on `emit` constrained to boolean to
 * govern the open-ended per-emitter slots. Per spec §10.3.2.3
 * `additionalProperties` only applies to keys NOT present in
 * `properties` (and not matching `patternProperties`), so the reserved
 * string slot is exempt and keeps its narrow type.
 *
 * The `emitterKinds` enum (when non-empty) constrains the unknown
 * boolean slots so a typo like `emit.zodd` fails meta-schema
 * validation instead of silently disabling the intended emitter.
 *
 * @internal
 */
export function buildLoopbackConfigMetaSchema(
  emitterKinds: readonly string[] = [],
): JSONSchema {
  const knownKinds = [...new Set(emitterKinds)].sort();
  const emitProperties: Record<string, JSONSchema> = {
    esm: {
      type: 'boolean',
      default: false,
      description:
        'Opt the project into ESM-strict output. Emitters that branch on module format read this via getEmitEsm().',
    },
    importExtension: {
      type: 'string',
      enum: ['.js', '.ts', ''],
      default: '.js',
      description:
        "Suffix appended to relative imports in emitted code when ESM mode is on. '.js' is Node's canonical ESM form; '.ts' targets tools that resolve TypeScript suffixes at runtime; '' targets non-Node ESM hosts.",
    },
  };
  // One explicit boolean slot per known emitter kind keeps the meta-
  // schema's diagnostic precise: a typo on a known kind is rejected
  // by the property-level type, not just the open additionalProperties
  // catch-all.
  for (const kind of knownKinds) {
    emitProperties[kind] = {type: 'boolean'};
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ebarahona.dev/loopback-contracts/_meta/loopback-config.schema.json',
    title: 'LoopBack 4 contracts loopback.config.json (generated)',
    type: 'object',
    additionalProperties: true,
    required: [
      'name',
      'schemasDir',
      'configsDir',
      'validator',
      'schemas',
      'emit',
    ],
    properties: {
      $schema: {type: 'string'},
      name: {type: 'string', minLength: 1},
      schemasDir: {type: 'string', minLength: 1},
      configsDir: {type: 'string', minLength: 1},
      validator: {type: 'string', enum: ['ajv', 'zod']},
      schemas: {type: 'array', items: {type: 'string'}},
      emit: {
        type: 'object',
        // Per JSON Schema 2020-12 §10.3.2.3 `additionalProperties`
        // applies only to keys NOT covered by `properties` /
        // `patternProperties`, so the reserved string-valued
        // `importExtension` slot listed in `properties` is exempt
        // from this boolean constraint while every other key (a
        // per-emitter `kind` toggle) must be a boolean.
        additionalProperties: {type: 'boolean'},
        properties: emitProperties,
      },
      'config-bindings': {type: 'array'},
      'migration-strategy': {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: false,
          required: ['mode'],
          properties: {
            mode: {type: 'string', enum: ['allow', 'fail']},
            note: {type: 'string'},
          },
        },
      },
    },
  };
}

/**
 * Build `_meta/emitter.schema.json` — the meta-schema validating manifest-
 * based emitters declared inside the project (the `kinds` enum is empty
 * because manifest emitters declare their own `kind`; the engine validates
 * uniqueness across the registry at registration time).
 *
 * Two authoring forms are accepted via `oneOf`:
 *
 * - **Plural**: an `outputs` array of `{template, path, policy?}` entries.
 * - **Legacy**: top-level `template` + `outputSuffix` (and optional
 *   `outputDir`).
 *
 * Exactly one form must be present per manifest; the `oneOf` branch
 * required-set enforces that without leaking the validator into the
 * runtime `validateManifest` helper.
 *
 * @internal
 */
export function buildEmitterManifestMetaSchema(): JSONSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ebarahona.dev/loopback-contracts/_meta/emitter.schema.json',
    title: 'LoopBack 4 contracts emitter manifest',
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'tier', 'description'],
    properties: {
      $schema: {type: 'string'},
      kind: {type: 'string', minLength: 1},
      tier: {
        type: 'string',
        enum: ['lb4-idiom', 'real-translation', 'convenience'],
      },
      description: {type: 'string'},
      peerDeps: {type: 'array', items: {type: 'string'}},
      perSchemaOptionsSchema: {type: 'object'},
      optIn: {type: 'boolean'},
      // Mirrors ProjectionEmitter.outputScope. When set to 'per-project'
      // the engine invokes the emitter once per pipeline run instead of
      // once per schema — needed for manifest emitters that aggregate
      // every contract into a single output file (e.g. project-level
      // `swagger.json`). Absent or 'per-schema' = conventional fan-out.
      outputScope: {type: 'string', enum: ['per-schema', 'per-project']},
      // Plural form — preferred.
      outputs: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['template', 'path'],
          properties: {
            template: {type: 'string', minLength: 1},
            path: {type: 'string', minLength: 1},
            policy: {type: 'string', enum: ['regen', 'skipIfExists']},
          },
        },
      },
      // Legacy singular form — kept for back-compat.
      template: {type: 'string', minLength: 1},
      outputSuffix: {type: 'string', minLength: 1},
      outputDir: {type: 'string', minLength: 1},
    },
    // Exactly one form: plural `outputs`, or the legacy
    // `template`+`outputSuffix` pair. The two branches deliberately list
    // the OTHER form's required keys under `not.required` so a manifest
    // mixing both fails meta-schema validation up front.
    oneOf: [
      {
        required: ['outputs'],
        not: {
          anyOf: [
            {required: ['template']},
            {required: ['outputSuffix']},
            {required: ['outputDir']},
          ],
        },
      },
      {
        required: ['template', 'outputSuffix'],
        not: {required: ['outputs']},
      },
    ],
  };
}
