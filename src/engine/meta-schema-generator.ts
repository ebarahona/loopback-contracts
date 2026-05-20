// Pure functions that build the project-specific meta-schemas the engine
// writes to `_meta/` on every `lb-contracts gen`. The output of every function here
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
 * Shared model-config item shape consumed by both
 * {@link buildModelConfigMetaSchema} (where it forms the top-level
 * document) AND {@link buildLoopbackConfigMetaSchema} (where it's
 * embedded under `$defs.modelConfig` so the strict-kinds pass's
 * `config-bindings.items` slot validates inline entries with the same
 * rigour as the standalone per-file pass).
 *
 * Returns the inner fragment: `additionalProperties` / `required` /
 * `properties`. Callers layer on their own `$schema` / `$id` / `title`
 * and either keep `$defs` at the document root (the standalone schema)
 * or nest the fragment under their own `$defs` (the loopback-config
 * schema). The `acl` sub-definition lives at whichever document root
 * embeds this shape — both callers ship an `$defs.acl` that the
 * `acls: {items: {$ref: '#/$defs/acl'}}` slot resolves against
 * because `$ref` inside `$defs.modelConfig` resolves against the
 * EMBEDDING document's root, not this fragment.
 */
function buildModelConfigItemShape(
  schemaIds: readonly string[],
  datasourceNames: readonly string[],
): JSONSchema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['$contractId', 'dataSource', 'public'],
    properties: {
      $schema: {type: 'string'},
      $contractId: {
        type: 'string',
        ...(schemaIds.length > 0 ? {enum: [...schemaIds]} : {}),
      },
      dataSource: {
        type: 'string',
        minLength: 1,
        ...(datasourceNames.length > 0 ? {enum: [...datasourceNames]} : {}),
      },
      public: {type: 'boolean'},
      model: {
        type: 'object',
        // Tightened in review finding 7 — typos like `idPropertty` now
        // fail stage-5 validation instead of silently being ignored by
        // the generator. The four keys listed below are the exact set
        // read by `ModelGenerator.buildModelSettings` (see
        // `src/generators/model-generator.ts`): `base` chooses the LB4
        // base class, `strict`/`idProperty`/`hiddenProperties` are
        // forwarded into the `@model({settings: {...}})` literal.
        additionalProperties: false,
        properties: {
          base: {type: 'string', enum: [...MODEL_BASES]},
          strict: {type: 'boolean'},
          // `resolveIdProperty()` in `src/helpers/identifiers.ts` only
          // requires a non-empty string; the generator does not enforce
          // a JS-identifier regex, so the meta-schema doesn't either.
          idProperty: {type: 'string', minLength: 1},
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
              ...(schemaIds.length > 0 ? {enum: [...schemaIds]} : {}),
            },
            through: {type: 'string'},
            keyFrom: {type: 'string'},
            keyTo: {type: 'string'},
          },
        },
      },
      acls: {type: 'array', items: {$ref: '#/$defs/acl'}},
    },
  };
}

/**
 * The shared `acl` sub-definition referenced by every model-config
 * `acls[i]` slot — extracted alongside {@link buildModelConfigItemShape}
 * so both embedding sites (the standalone model-config schema AND the
 * loopback-config schema's `$defs.modelConfig`) can publish an
 * `$defs.acl` at their document root that the `{$ref: '#/$defs/acl'}`
 * inside `acls` resolves against.
 */
function buildAclDef(): JSONSchema {
  return {
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
  };
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
  const shape = buildModelConfigItemShape(schemaIds, datasourceNames);

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ebarahona.dev/loopback-contracts/_meta/model-config.schema.json',
    title: 'LoopBack 4 model-config (generated)',
    ...shape,
    $defs: {
      acl: buildAclDef(),
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
 * Two on-disk layouts are accepted via `oneOf`, mirroring
 * `parseDatasourcesJson` in `src/engine/pipeline.ts`:
 *
 *   - **Array**: explicit `name` per entry — kept for back-compat and
 *     hand-authored fixtures.
 *   - **Keyed map** (preferred — what `lb-contracts ds` writes): each
 *     map key is the canonical datasource name, the value carries
 *     `adapter` and an optional `config`. A redundant `name` field on
 *     the entry value is tolerated (the loader drops it in favour of
 *     the map key) but the entry itself does NOT require `name`.
 *
 * Without the `oneOf` the editor flagged the keyed-map layout — the
 * preferred form — as invalid. The `$id` is preserved so existing
 * editor caches keep matching.
 *
 * @internal
 */
export function buildDatasourcesMetaSchema(
  installedAdapters: readonly string[] = [],
): JSONSchema {
  const adapters = [...new Set(installedAdapters)].sort();
  const adapterSchema: JSONSchema = {
    type: 'string',
    ...(adapters.length > 0 ? {enum: adapters} : {}),
  };
  // Shared per-entry property bag. The array branch requires `name`
  // (entries have no enclosing key); the keyed-map branch reuses the
  // SAME property shape so a redundant `name` is allowed but never
  // required.
  const entryProperties: Record<string, JSONSchema> = {
    $schema: {type: 'string'},
    name: {type: 'string', minLength: 1},
    adapter: adapterSchema,
    config: {type: 'object', additionalProperties: true},
  };
  const arrayItemSchema: JSONSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'adapter'],
    properties: entryProperties,
  };
  const keyedEntrySchema: JSONSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['adapter'],
    properties: entryProperties,
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://ebarahona.dev/loopback-contracts/_meta/datasources.schema.json',
    title: 'LoopBack 4 datasources.json (generated)',
    oneOf: [
      // Array layout — original shape, kept for back-compat.
      {type: 'array', items: arrayItemSchema},
      // Keyed-map layout — what `lb-contracts ds` writes. `$schema` is allowed
      // as a top-level sibling key (typed as string); every other key
      // is a datasource name whose value follows the entry schema.
      {
        type: 'object',
        properties: {$schema: {type: 'string'}},
        additionalProperties: keyedEntrySchema,
      },
    ],
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
  schemas: readonly JSONSchema[] = [],
  datasources: readonly DatasourceConfigJson[] = [],
): JSONSchema {
  const knownKinds = [...new Set(emitterKinds)].sort();
  const schemaIds = collectSchemaIds(schemas);
  const datasourceNames = [...new Set(datasources.map(d => d.name))].sort();
  const modelConfigShape = buildModelConfigItemShape(
    schemaIds,
    datasourceNames,
  );
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
        // When the caller passes a non-empty `emitterKinds` list (the
        // pipeline does, via `this.emitters.all()`), every legitimate
        // boolean slot is enumerated under `properties` AND
        // `additionalProperties: false` rejects anything else — closing
        // the `emit.zodd` typo path Finding 3 originally surfaced.
        //
        // When `emitterKinds` is empty (CLI-side `readConfig()` which
        // runs before the component boots and can't discover kinds),
        // fall back to the documented "any boolean slot is allowed"
        // shape so the CLI's loose pre-boot pass doesn't reject valid
        // configs. The pipeline's STRICT-kinds second pass
        // (stage 5, with the actual registry contents) then catches
        // typos that slipped through. The reserved string-valued
        // `importExtension` slot listed in `properties` is exempt
        // from this constraint per JSON Schema 2020-12 §10.3.2.3.
        additionalProperties: knownKinds.length > 0 ? false : {type: 'boolean'},
        properties: emitProperties,
      },
      // Q5 fix — `items` is constrained to the shared model-config
      // shape via `$defs.modelConfig` so a typo INSIDE an inline
      // `config-bindings[i]` entry (e.g. `'$contractIdd'`) fails THIS
      // root-config strict pass too, not only the separate per-file
      // `buildModelConfigMetaSchema` pass. The `$ref` resolves against
      // THIS document's root, so we ship `$defs.acl` here as well to
      // satisfy `acls[i]`'s `{$ref: '#/$defs/acl'}` lookup.
      'config-bindings': {
        type: 'array',
        items: {$ref: '#/$defs/modelConfig'},
      },
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
      // Security-posture configuration — see `SecurityConfig` in
      // `loopback-config.interface.ts`. Each sub-object is closed
      // (`additionalProperties: false`) so a typo like `securtiy.http.timeoutMs`
      // OR `security.http.timeOutMs` fails the stage-5 strict-kinds pass
      // instead of silently being ignored. Numeric fields require a
      // positive integer; zero/negative are rejected to keep the
      // back-compat defaults the only "no-op" option.
      security: {
        type: 'object',
        additionalProperties: false,
        properties: {
          http: {
            type: 'object',
            additionalProperties: false,
            properties: {
              timeoutMs: {type: 'integer', minimum: 1},
              maxBodyBytes: {type: 'integer', minimum: 1},
              allowPrivateHosts: {type: 'boolean'},
              verifyResolvedIps: {type: 'boolean'},
              allowedHosts: {type: 'array', items: {type: 'string'}},
              allowRedirects: {type: 'boolean'},
              maxRedirects: {type: 'integer', minimum: 1},
            },
          },
          emitters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              allowProjectManifests: {type: 'boolean'},
              allowedKinds: {type: 'array', items: {type: 'string'}},
            },
          },
          codegen: {
            type: 'object',
            additionalProperties: false,
            properties: {
              runTsc: {type: 'boolean'},
              trustedProject: {type: 'boolean'},
            },
          },
        },
      },
    },
    $defs: {
      modelConfig: modelConfigShape,
      acl: buildAclDef(),
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
