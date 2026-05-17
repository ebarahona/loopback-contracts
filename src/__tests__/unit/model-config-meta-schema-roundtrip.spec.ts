// Regression test pinning the contract between `ModelConfigJson` (the
// TypeScript shape stage 5 of the pipeline casts validated JSON to) and
// `buildModelConfigMetaSchema()` (the Ajv meta-schema stage 5 actually
// drives validation against). The pipeline casts `as unknown as
// ModelConfigJson` once Ajv signs off — the cast is sound today, but if
// someone widens `ModelConfigJson` without updating the meta-schema
// generator, the cast silently lies. This spec compiles the meta-schema
// with the same Ajv options stage 5 uses (`strict: false`,
// `allErrors: true`, draft 2020-12) and asserts a representative literal
// validates green while an obvious bad literal validates red.
//
// Mirrors the fixture shape used by the integration suite — see
// `src/__tests__/integration/lb4-idiom-emitter-path.spec.ts` for the same
// `$contractId: 'person.v1'` config block.
import Ajv2020 from 'ajv/dist/2020';
import {describe, expect, it} from 'vitest';
import {buildModelConfigMetaSchema} from '../../engine';
import type {JSONSchema} from '../../interfaces';
import type {DatasourceConfigJson, ModelConfigJson} from '../../types';

const SCHEMAS: readonly JSONSchema[] = [
  {
    $id: 'person.v1',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {id: {type: 'string'}, name: {type: 'string'}},
    required: ['id', 'name'],
  },
];

const DATASOURCES: readonly DatasourceConfigJson[] = [
  {name: 'mem', adapter: 'memory', config: {}},
];

describe('ModelConfigJson <-> buildModelConfigMetaSchema round-trip', () => {
  it('accepts a representative ModelConfigJson literal', () => {
    const ajv = new Ajv2020({strict: false, allErrors: true});
    const validate = ajv.compile(
      buildModelConfigMetaSchema(SCHEMAS, DATASOURCES) as object,
    );

    const literal: ModelConfigJson = {
      $schema: '../_meta/model-config.schema.json',
      $contractId: 'person.v1',
      dataSource: 'mem',
      public: true,
      model: {base: 'Entity', strict: true, idProperty: 'id'},
    };

    const ok = validate(literal);
    // `validate.errors` is `null` on success — surface it on failure so
    // a meta-schema regression reports the offending instancePath instead
    // of an opaque `false`.
    expect(validate.errors ?? null).toBeNull();
    expect(ok).toBe(true);
  });

  it('rejects a literal that violates the meta-schema (dataSource: 123)', () => {
    const ajv = new Ajv2020({strict: false, allErrors: true});
    const validate = ajv.compile(
      buildModelConfigMetaSchema(SCHEMAS, DATASOURCES) as object,
    );

    // Deliberately wrong shape: `dataSource` is typed `string` on
    // `ModelConfigJson` but we pass a number. Cast through `unknown` so
    // the spec compiles under `no any` while still feeding Ajv invalid
    // input.
    const bad = {
      $schema: '../_meta/model-config.schema.json',
      $contractId: 'person.v1',
      dataSource: 123,
      public: true,
    } as unknown as ModelConfigJson;

    const ok = validate(bad);
    expect(ok).toBe(false);
    expect(validate.errors).not.toBeNull();
    expect(validate.errors?.length ?? 0).toBeGreaterThan(0);
  });
});
