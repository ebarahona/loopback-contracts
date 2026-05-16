import {describe, expect, it} from 'vitest';
import {TypesEmitter} from '../../emitters/types-emitter';
import type {
  EmitterContext,
  JSONSchema,
  SchemaRegistry,
} from '../../interfaces';

const FIXTURE: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    name: {type: 'string'},
    age: {type: 'integer'},
  },
  required: ['name'],
};

const ADDRESS: JSONSchema = {
  $id: 'address.v1',
  type: 'object',
  properties: {
    street: {type: 'string'},
    city: {type: 'string'},
  },
  required: ['street'],
};

const CUSTOMER: JSONSchema = {
  $id: 'customer.v1',
  type: 'object',
  properties: {
    name: {type: 'string'},
    address: {$ref: 'address.v1'},
  },
  required: ['name'],
};

function makeRegistry(entries: JSONSchema[]): SchemaRegistry {
  const byId = new Map<string, JSONSchema>();
  for (const entry of entries) {
    if (entry.$id !== undefined) byId.set(entry.$id, entry);
  }
  return {
    get: id => byId.get(id),
    list: () => Array.from(byId.values()),
    has: id => byId.has(id),
  };
}

function buildContext(
  schema: JSONSchema,
  registry: SchemaRegistry = {
    get: () => undefined,
    list: () => [],
    has: () => false,
  },
): EmitterContext {
  return {
    schema,
    registry,
    importMap: {resolve: id => './' + id},
    templates: {preload: async () => {}, render: () => ''},
    paths: {
      root: '/tmp/contracts-test',
      outputDir: '/tmp/contracts-test/src',
      schemasDir: '/tmp/contracts-test/schemas',
      configsDir: '/tmp/contracts-test/configs',
    },
    lossy: {report: () => {}, entries: () => []},
  };
}

describe('TypesEmitter.emit', () => {
  it('compiles a minimal user schema into a TS interfaces file', async () => {
    const emitter = new TypesEmitter();
    const files = await emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user-v1.types.ts');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('types-emitter');
    expect(file.content.length).toBeGreaterThan(0);
    expect(file.content).toContain('export interface UserV1');
    expect(file.content).toContain('name: string');
  });

  it('resolves a cross-schema $ref via the registry without touching disk', async () => {
    const emitter = new TypesEmitter();
    const ctx = buildContext(CUSTOMER, makeRegistry([CUSTOMER, ADDRESS]));
    const files = await emitter.emit(ctx);

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/customer-v1.types.ts');
    expect(file.content).toContain('export interface CustomerV1');
    // The referenced schema must surface as a named type in the output —
    // not as a filesystem-resolved blob and not as a bare `unknown`.
    expect(file.content).toContain('AddressV1');
    expect(file.content).toMatch(/address\??:\s*AddressV1/);
  });

  it('emits `unknown` for an unresolved $ref instead of crashing', async () => {
    const emitter = new TypesEmitter();
    const schema: JSONSchema = {
      $id: 'order.v1',
      type: 'object',
      properties: {
        customer: {$ref: 'customer.v1'},
      },
    };
    const files = await emitter.emit(buildContext(schema));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(file.content).toContain('export interface OrderV1');
    // Unresolved refs must not throw, and must not bleed a filesystem error
    // into the generated TypeScript.
    expect(file.content).not.toContain('ENOENT');
  });
});
