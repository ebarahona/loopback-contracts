import {describe, expect, it} from 'vitest';
import {TypesEmitter} from '../../emitters/library/types-emitter';
import type {
  EmitterContext,
  JSONSchema,
  LossyReport,
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

describe('TypesEmitter URL-style $id', () => {
  const ADDRESS_URL: JSONSchema = {
    $id: 'https://schemas.example.com/address/1.0.0',
    title: 'Address',
    type: 'object',
    properties: {street: {type: 'string'}},
    required: ['street'],
  };
  const INTAKE_URL: JSONSchema = {
    $id: 'https://schemas.example.com/intake/1.0.0',
    title: 'AppraisalIntake',
    type: 'object',
    properties: {
      home: {$ref: 'https://schemas.example.com/address/1.0.0'},
      work: {$ref: '../address/1.0.0'},
    },
    required: ['home'],
  };

  it('names the file from a slug and the interface from title', async () => {
    const files = await new TypesEmitter().emit(
      buildContext(INTAKE_URL, makeRegistry([INTAKE_URL, ADDRESS_URL])),
    );
    const [file] = files;
    expect(file?.path).toBe('models/intake-1-0-0.types.ts');
    expect(file?.content).toContain('export interface AppraisalIntake');
    // Absolute and relative URL refs resolve through the registry instead
    // of crashing the upstream ref-parser.
    expect(file?.content).toMatch(/home:\s*Address;/);
    expect(file?.content).toMatch(/work\?:\s*Address;/);
  });
});

describe('TypesEmitter $ref translation with plain $ids', () => {
  const MONEY: JSONSchema = {
    $id: 'money',
    type: 'object',
    properties: {amount: {$ref: '#/$defs/amount'}},
    required: ['amount'],
    $defs: {amount: {type: 'number', minimum: 0}},
  };
  const INTAKE: JSONSchema = {
    $id: 'appraisal-intake',
    title: 'Intake Form',
    type: 'object',
    properties: {
      price: {$ref: 'money'},
      face: {$ref: 'money#/$defs/amount'},
      status: {$ref: '#/$defs/status'},
      tags: {type: 'array', items: {$ref: '#/$defs/tag'}},
      parent: {$ref: '#'},
    },
    required: ['price', 'face', 'status'],
    $defs: {
      status: {enum: ['open', 'closed']},
      tag: {title: 'Tag', type: 'object', properties: {k: {type: 'string'}}},
    },
  };

  function emitWithLossy(
    schema: JSONSchema,
    entries: JSONSchema[],
  ): Promise<{content: string; lossy: LossyReport[]}> {
    const lossy: LossyReport[] = [];
    const ctx = buildContext(schema, makeRegistry(entries));
    ctx.lossy.report = entry => lossy.push(entry);
    return new TypesEmitter()
      .emit(ctx)
      .then(([file]) => ({content: file?.content ?? '', lossy}));
  }

  it('imports cross-schema types and inlines $defs fragments', async () => {
    const {content, lossy} = await emitWithLossy(INTAKE, [INTAKE, MONEY]);
    expect(content).toContain("import type {Money} from './money.types';");
    expect(content).toMatch(/price:\s*Money;/);
    expect(content).toMatch(/face:\s*number;/);
    expect(content).toMatch(/status:\s*"open" \| "closed";/);
    // A titled fragment becomes a declared, exported type.
    expect(content).toMatch(/tags\?:\s*Tag\[\];/);
    expect(content).toContain('export interface Tag');
    // The root is exported under the canonical (Zod-matching) name too.
    expect(content).toContain('export interface IntakeForm');
    expect(content).toContain('export type AppraisalIntake = IntakeForm;');
    expect(content).toMatch(/parent\?:\s*AppraisalIntake;/);
    expect(content).not.toContain('$defs');
    expect(lossy).toEqual([]);
  });

  it('reports a dangling local pointer instead of crashing', async () => {
    const schema: JSONSchema = {
      $id: 'broken',
      type: 'object',
      properties: {x: {$ref: '#/$defs/missing'}},
    };
    const {content, lossy} = await emitWithLossy(schema, [schema]);
    expect(content).toMatch(/x\?:\s*unknown;/);
    expect(lossy).toHaveLength(1);
    expect(lossy[0]?.feature).toBe('unresolved-$ref');
    expect(lossy[0]?.source.propertyPath).toBe('/properties/x');
    // `--strict` turns the report into a hard error.
    expect(() =>
      new TypesEmitter().validate({schema, lossy: lossy[0] as LossyReport}),
    ).toThrow(/rejected lossy translation 'unresolved-\$ref'/);
  });

  it('reports a recursive fragment and emits unknown', async () => {
    const schema: JSONSchema = {
      $id: 'tree',
      type: 'object',
      properties: {root: {$ref: '#/$defs/node'}},
      $defs: {
        node: {type: 'object', properties: {child: {$ref: '#/$defs/node'}}},
      },
    };
    const {lossy} = await emitWithLossy(schema, [schema]);
    expect(lossy.map(l => l.feature)).toEqual(['recursive-fragment-$ref']);
  });

  it('emits minItems / maxItems arrays as T[], not tuples', async () => {
    const money: JSONSchema = {
      $id: 'money',
      type: 'object',
      properties: {amount: {type: 'number'}},
    };
    const schema: JSONSchema = {
      $id: 'intake',
      type: 'object',
      properties: {
        premiums: {type: 'array', items: {$ref: 'money'}, minItems: 1},
        tags: {
          type: 'array',
          items: {type: 'string'},
          minItems: 2,
          maxItems: 3,
        },
      },
      required: ['premiums'],
    };
    const {content} = await emitWithLossy(schema, [schema, money]);
    expect(content).toMatch(/premiums: Money\[\];/);
    expect(content).toMatch(/tags\?: string\[\];/);
    expect(content).not.toContain('...Money[]');
    expect(content).not.toMatch(/\[string, string/);
  });
});
