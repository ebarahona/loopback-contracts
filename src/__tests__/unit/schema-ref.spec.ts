import {describe, expect, it} from 'vitest';
import {
  resolveIdReference,
  resolveJsonPointer,
  resolveSchemaRef,
  walkJsonPointer,
} from '../../helpers';
import type {JSONSchema, SchemaRegistry} from '../../interfaces';

const ADDRESS: JSONSchema = {
  $id: 'https://schemas.example.com/address/1.0.0',
  type: 'object',
  $defs: {zip: {type: 'string'}},
};
const INTAKE: JSONSchema = {
  $id: 'https://schemas.example.com/intake/1.0.0',
  type: 'object',
  $defs: {'a/b': {type: 'string'}},
};
const PLAIN: JSONSchema = {$id: 'customer.v1', type: 'object'};

function makeRegistry(entries: JSONSchema[]): SchemaRegistry {
  const byId = new Map(entries.map(e => [e.$id as string, e]));
  return {
    get: id => byId.get(id),
    list: () => [...byId.values()],
    has: id => byId.has(id),
  };
}

const REGISTRY = makeRegistry([ADDRESS, INTAKE, PLAIN]);

describe('resolveSchemaRef', () => {
  it('resolves an absolute URL ref', () => {
    const hit = resolveSchemaRef(
      'https://schemas.example.com/address/1.0.0',
      INTAKE,
      REGISTRY,
    );
    expect(hit?.document).toBe(ADDRESS);
    expect(hit?.pointer).toBe('');
  });

  it('resolves a relative ref against the base $id', () => {
    const hit = resolveSchemaRef(
      '../address/1.0.0#/$defs/zip',
      INTAKE,
      REGISTRY,
    );
    expect(hit?.document).toBe(ADDRESS);
    expect(hit?.id).toBe('https://schemas.example.com/address/1.0.0');
    expect(hit?.pointer).toBe('/$defs/zip');
  });

  it('resolves a bare registry id and a local fragment', () => {
    expect(resolveSchemaRef('customer.v1', INTAKE, REGISTRY)?.document).toBe(
      PLAIN,
    );
    const local = resolveSchemaRef('#/$defs/a~1b', INTAKE, REGISTRY);
    expect(local?.document).toBe(INTAKE);
    expect(local?.pointer).toBe('/$defs/a~1b');
  });

  it('returns undefined when no loaded schema matches', () => {
    expect(resolveSchemaRef('../missing/1.0.0', INTAKE, REGISTRY)).toBe(
      undefined,
    );
    expect(resolveSchemaRef('missing', PLAIN, REGISTRY)).toBe(undefined);
  });
});

describe('resolveSchemaRef with plain $ids', () => {
  const MONEY: JSONSchema = {$id: 'money', $defs: {amount: {type: 'number'}}};
  const APPRAISAL: JSONSchema = {$id: 'appraisal-intake', type: 'object'};
  const registry = makeRegistry([MONEY, APPRAISAL]);

  it('resolves plain ids, plain-id fragments and relative forms', () => {
    const whole = resolveSchemaRef('money', APPRAISAL, registry);
    expect(whole?.document).toBe(MONEY);
    const frag = resolveSchemaRef('money#/$defs/amount', APPRAISAL, registry);
    expect(frag?.id).toBe('money');
    expect(frag?.pointer).toBe('/$defs/amount');
    expect(resolveSchemaRef('./money', APPRAISAL, registry)?.id).toBe('money');
    expect(resolveSchemaRef('#/$defs/x', APPRAISAL, registry)?.document).toBe(
      APPRAISAL,
    );
  });

  it('maps plain-id resolution back to plain keys', () => {
    expect(resolveIdReference('money#/$defs/a', 'appraisal-intake')).toBe(
      'money#/$defs/a',
    );
    expect(resolveIdReference('money', '')).toBe('money');
    expect(
      resolveIdReference('../address/1.0.0', 'https://x.test/intake/1.0.0'),
    ).toBe('https://x.test/address/1.0.0');
  });
});

describe('walkJsonPointer', () => {
  it('returns boolean schemas and undefined for missing segments', () => {
    const doc = {$defs: {any: true}};
    expect(walkJsonPointer(doc, '/$defs/any')).toBe(true);
    expect(walkJsonPointer(doc, '/$defs/toString')).toBe(undefined);
  });
});

describe('resolveJsonPointer', () => {
  it('walks escaped and percent-encoded segments', () => {
    expect(resolveJsonPointer(INTAKE, '/$defs/a~1b')).toEqual({type: 'string'});
    expect(resolveJsonPointer(INTAKE, '/%24defs/a~1b')).toEqual({
      type: 'string',
    });
    expect(resolveJsonPointer(INTAKE, '')).toBe(INTAKE);
    expect(resolveJsonPointer(INTAKE, '/$defs/nope')).toBe(undefined);
  });
});
