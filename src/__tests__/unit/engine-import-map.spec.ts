import {describe, expect, it} from 'vitest';
import {RelativeImportMap} from '../../engine/import-map';
import {InMemorySchemaRegistry} from '../../engine/schema-registry';
import {ContractsCodegenError} from '../../helpers';
import type {JSONSchema} from '../../interfaces';

function schema(id: string): JSONSchema {
  return {$id: id, type: 'object'};
}

function buildRegistry(ids: readonly string[]): InMemorySchemaRegistry {
  const reg = new InMemorySchemaRegistry();
  for (const id of ids) reg.add(schema(id));
  return reg;
}

describe('RelativeImportMap.resolve', () => {
  it('resolves a known $id to a relative path with leading "./"', () => {
    const reg = buildRegistry(['user.v1']);
    const map = new RelativeImportMap(reg, id => `/proj/src/models/${id}.ts`);
    const out = map.resolve('user.v1', '/proj/src/models/order.v1.ts');
    expect(out).toBe('./user.v1');
  });

  it('throws on unknown $id', () => {
    const reg = buildRegistry([]);
    const map = new RelativeImportMap(reg, id => `/proj/src/models/${id}.ts`);
    expect(() => map.resolve('missing.v1', '/proj/src/models/from.ts')).toThrow(
      ContractsCodegenError,
    );
  });

  it('strips a trailing .ts extension on the resolved import', () => {
    const reg = buildRegistry(['user.v1']);
    const map = new RelativeImportMap(reg, id => `/proj/src/models/${id}.ts`);
    const out = map.resolve('user.v1', '/proj/src/models/order.v1.ts');
    expect(out.endsWith('.ts')).toBe(false);
  });

  it('emits forward-slash separators regardless of platform sep', () => {
    const reg = buildRegistry(['user.v1']);
    const map = new RelativeImportMap(reg, id => `/proj/src/models/${id}.ts`);
    const out = map.resolve('user.v1', '/proj/src/repositories/order.v1.ts');
    expect(out).not.toContain('\\');
    expect(out).toContain('/');
  });

  it('uses ../ for up-directory references', () => {
    const reg = buildRegistry(['user.v1']);
    const map = new RelativeImportMap(reg, id => `/proj/src/models/${id}.ts`);
    const out = map.resolve(
      'user.v1',
      '/proj/src/repositories/order.repository.ts',
    );
    expect(out).toBe('../models/user.v1');
  });
});
