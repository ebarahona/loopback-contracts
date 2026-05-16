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
 * Build `_meta/emitter.schema.json` — the meta-schema validating manifest-
 * based emitters declared inside the project (the `kinds` enum is empty
 * because manifest emitters declare their own `kind`; the engine validates
 * uniqueness across the registry at registration time).
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
    required: ['kind', 'outputSuffix', 'tier', 'description', 'template'],
    properties: {
      kind: {type: 'string', minLength: 1},
      outputSuffix: {type: 'string', minLength: 1},
      tier: {
        type: 'string',
        enum: ['lb4-idiom', 'real-translation', 'convenience'],
      },
      description: {type: 'string'},
      template: {type: 'string', minLength: 1},
      peerDeps: {type: 'array', items: {type: 'string'}},
      perSchemaOptionsSchema: {type: 'object'},
    },
  };
}
