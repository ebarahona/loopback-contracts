import {describe, expect, it} from 'vitest';
import {InMemorySchemaRegistry} from '../../engine/schema-registry';
import {ContractsCodegenError} from '../../helpers';
import type {JSONSchema} from '../../interfaces';

function schema(
  id: string,
  properties: JSONSchema['properties'] = {},
): JSONSchema {
  return {$id: id, type: 'object', properties};
}

describe('InMemorySchemaRegistry', () => {
  it('add()/has()/get()/list() reflect a single insertion', () => {
    const reg = new InMemorySchemaRegistry();
    const a = schema('user.v1', {name: {type: 'string'}});
    reg.add(a);
    expect(reg.has('user.v1')).toBe(true);
    expect(reg.get('user.v1')).toEqual(a);
    expect(reg.list()).toHaveLength(1);
  });

  it('re-adds the same content as a no-op (canonical fingerprint)', () => {
    const reg = new InMemorySchemaRegistry();
    reg.add(schema('user.v1', {a: {type: 'string'}, b: {type: 'integer'}}));
    // Key order intentionally reversed to exercise canonicalisation.
    expect(() =>
      reg.add(schema('user.v1', {b: {type: 'integer'}, a: {type: 'string'}})),
    ).not.toThrow();
    expect(reg.list()).toHaveLength(1);
  });

  it('throws on duplicate $id with differing content', () => {
    const reg = new InMemorySchemaRegistry();
    reg.add(schema('user.v1', {a: {type: 'string'}}));
    expect(() => reg.add(schema('user.v1', {a: {type: 'integer'}}))).toThrow(
      ContractsCodegenError,
    );
  });

  it('throws when a schema is missing $id', () => {
    const reg = new InMemorySchemaRegistry();
    const noId: JSONSchema = {type: 'object', properties: {}};
    expect(() => reg.add(noId)).toThrow(ContractsCodegenError);
  });

  it('clear() empties the registry', () => {
    const reg = new InMemorySchemaRegistry();
    reg.add(schema('user.v1'));
    reg.add(schema('order.v1'));
    expect(reg.list()).toHaveLength(2);
    reg.clear();
    expect(reg.list()).toHaveLength(0);
    expect(reg.has('user.v1')).toBe(false);
    expect(reg.get('order.v1')).toBeUndefined();
  });

  it('list() returns a frozen array', () => {
    const reg = new InMemorySchemaRegistry();
    reg.add(schema('user.v1'));
    const list = reg.list();
    expect(Object.isFrozen(list)).toBe(true);
  });
});
