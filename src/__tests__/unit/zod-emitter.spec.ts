import {describe, expect, it} from 'vitest';
import {ModuleKind, ScriptTarget, transpileModule} from 'typescript';
import {z} from 'zod';
import {ZodEmitter} from '../../emitters/library/zod-emitter';
import {ContractsValidationError} from '../../helpers';
import type {EmitterContext, JSONSchema, LossyReport} from '../../interfaces';

const FIXTURE: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    name: {type: 'string'},
    age: {type: 'integer'},
  },
  required: ['name'],
};

function buildContext(schema: JSONSchema): EmitterContext {
  return {
    schema,
    registry: {get: () => undefined, list: () => [], has: () => false},
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

describe('ZodEmitter.emit', () => {
  it('compiles a minimal user schema into a Zod sidecar file', () => {
    const emitter = new ZodEmitter();
    const files = emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user-v1.zod.ts');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('zod-emitter');
    expect(file.content.length).toBeGreaterThan(0);
    expect(file.content).toContain("import {z} from 'zod';");
    expect(file.content).toContain('export const UserV1Schema =');
    expect(file.content).toContain(
      'export type UserV1 = z.infer<typeof UserV1Schema>',
    );
    // Sanity-check the upstream Zod source: object shape + string field.
    expect(file.content).toContain('z.object');
    expect(file.content).toContain('z.string()');
  });
});

// ---------------------------------------------------------------------------
// `$ref` translation and URL-style `$id` naming.
// ---------------------------------------------------------------------------

const ADDRESS: JSONSchema = {
  $id: 'https://schemas.example.com/address/1.0.0',
  title: 'Address',
  type: 'object',
  properties: {
    street: {type: 'string'},
    zip: {type: 'string', pattern: '^[0-9]{5}$'},
  },
  required: ['street', 'zip'],
};

const INTAKE: JSONSchema = {
  $id: 'https://schemas.example.com/intake/1.0.0',
  title: 'AppraisalIntake',
  type: 'object',
  properties: {
    name: {type: 'string'},
    home: {$ref: 'https://schemas.example.com/address/1.0.0'},
    work: {$ref: '../address/1.0.0'},
    tag: {$ref: '#/$defs/tag'},
  },
  required: ['name', 'home'],
  $defs: {tag: {type: 'string', minLength: 2}},
};

function makeRegistry(entries: JSONSchema[]): EmitterContext['registry'] {
  const byId = new Map<string, JSONSchema>();
  for (const entry of entries) {
    if (entry.$id !== undefined) byId.set(entry.$id, entry);
  }
  return {
    get: id => byId.get(id),
    list: () => [...byId.values()],
    has: id => byId.has(id),
  };
}

function emitWith(
  schema: JSONSchema,
  registry: JSONSchema[],
): {content: string; path: string; reports: LossyReport[]} {
  const reports: LossyReport[] = [];
  const ctx: EmitterContext = {
    ...buildContext(schema),
    registry: makeRegistry(registry),
    lossy: {report: r => reports.push(r), entries: () => reports},
  };
  const [file] = new ZodEmitter().emit(ctx);
  if (file === undefined) throw new Error('no file emitted');
  return {content: file.content, path: file.path, reports};
}

// Evaluate the emitted `export const <name> = <expr>;` against real Zod,
// binding each imported schema to an already-evaluated value.
function evaluate(
  content: string,
  exportName: string,
  bindings: Record<string, unknown> = {},
): ZodLike {
  const match = new RegExp(
    `export const ${exportName} = ([\\s\\S]*?);\\nexport type`,
  ).exec(content);
  if (match === null) throw new Error(`no export ${exportName}`);
  const names = Object.keys(bindings);
  const fn = new Function('z', ...names, `return ${match[1]};`) as (
    ...args: unknown[]
  ) => ZodLike;
  return fn(z, ...names.map(n => bindings[n]));
}

interface ZodLike {
  safeParse(value: unknown): {success: boolean};
}

describe('ZodEmitter $ref translation', () => {
  it('imports the referenced schema for absolute and relative refs', () => {
    const {content, reports} = emitWith(INTAKE, [INTAKE, ADDRESS]);
    expect(content).not.toContain('z.any()');
    expect(content).toContain(
      "import {AddressSchema} from './address-1-0-0.zod';",
    );
    expect(content).toContain('"home": AddressSchema');
    expect(content).toContain('"work": AddressSchema.optional()');
    expect(content).toContain('"tag": z.string().min(2).optional()');
    expect(reports).toEqual([]);
  });

  it('validates through the referenced schema at runtime', () => {
    const address = evaluate(
      emitWith(ADDRESS, [INTAKE, ADDRESS]).content,
      'AddressSchema',
    );
    const intake = evaluate(
      emitWith(INTAKE, [INTAKE, ADDRESS]).content,
      'AppraisalIntakeSchema',
      {AddressSchema: address},
    );
    const home = {street: '1 Main', zip: '12345'};
    expect(intake.safeParse({name: 'a', home}).success).toBe(true);
    expect(
      intake.safeParse({name: 'a', home: {street: '1 Main', zip: 'x'}}).success,
    ).toBe(false);
    expect(intake.safeParse({name: 'a', home, tag: 'x'}).success).toBe(false);
  });

  it('resolves bare-$id refs and inlines cross-document fragments', () => {
    const address: JSONSchema = {
      $id: 'address.v1',
      type: 'object',
      properties: {zip: {$ref: '#/$defs/zip'}},
      $defs: {zip: {type: 'string', maxLength: 5}},
    };
    const customer: JSONSchema = {
      $id: 'customer.v1',
      type: 'object',
      properties: {
        address: {$ref: 'address.v1', description: 'Home'},
        zip: {$ref: 'address.v1#/$defs/zip'},
      },
    };
    const {content, reports} = emitWith(customer, [customer, address]);
    expect(content).toContain(
      "import {AddressV1Schema} from './address-v1.zod';",
    );
    expect(content).toContain('AddressV1Schema.describe("Home")');
    expect(content).toContain('"zip": z.string().max(5).optional()');
    expect(reports).toEqual([]);
  });

  it('emits z.lazy for a self-reference and reports the widened type', () => {
    const node: JSONSchema = {
      $id: 'https://schemas.example.com/node/1',
      title: 'TreeNode',
      type: 'object',
      properties: {children: {type: 'array', items: {$ref: '#'}}},
    };
    const {content, reports} = emitWith(node, [node]);
    expect(content).toContain(
      'z.array(z.lazy((): z.ZodType => TreeNodeSchema))',
    );
    expect(reports.map(r => r.feature)).toEqual(['cyclic-$ref']);
    expect(reports[0]?.source.propertyPath).toBe('/properties/children/items');

    // Recursive validation works at runtime (`z.lazy` defers the lookup).
    // Strip the TS return annotation so the expression evaluates as JS.
    const holder: {TreeNodeSchema?: ZodLike} = {};
    holder.TreeNodeSchema = evaluate(
      content.replace(
        '(): z.ZodType => TreeNodeSchema',
        '() => holder.TreeNodeSchema',
      ),
      'TreeNodeSchema',
      {holder},
    );
    expect(
      holder.TreeNodeSchema.safeParse({children: [{children: []}]}).success,
    ).toBe(true);
    expect(
      holder.TreeNodeSchema.safeParse({children: [{children: 1}]}).success,
    ).toBe(false);
  });

  it('breaks a cross-schema cycle with z.lazy on both sides', () => {
    const a: JSONSchema = {
      $id: 'a',
      type: 'object',
      properties: {b: {$ref: 'b'}},
    };
    const b: JSONSchema = {
      $id: 'b',
      type: 'object',
      properties: {a: {$ref: 'a'}},
    };
    const fromA = emitWith(a, [a, b]);
    const fromB = emitWith(b, [a, b]);
    expect(fromA.content).toContain('z.lazy((): z.ZodType => BSchema)');
    expect(fromB.content).toContain('z.lazy((): z.ZodType => ASchema)');
    expect(fromA.reports.map(r => r.feature)).toEqual(['cyclic-$ref']);
  });

  it('reports an unresolved ref as a lossy warning and emits z.any()', () => {
    const schema: JSONSchema = {
      $id: 'https://schemas.example.com/order/1',
      type: 'object',
      properties: {
        customer: {$ref: '../customer/1'},
        bad: {$ref: '#/$defs/missing'},
      },
    };
    const {content, reports} = emitWith(schema, [schema]);
    expect(content).toContain('"customer": z.any()');
    expect(content).toContain('"bad": z.any()');
    expect(reports.map(r => [r.feature, r.severity])).toEqual([
      ['unresolved-$ref', 'warn'],
      ['unresolved-$ref', 'warn'],
    ]);
  });

  it('rejects $ref lossy features in --strict via validate()', () => {
    const emitter = new ZodEmitter();
    for (const feature of [
      'unresolved-$ref',
      'cyclic-$ref',
      'recursive-fragment-$ref',
    ]) {
      expect(() =>
        emitter.validate({
          schema: INTAKE,
          lossy: {
            feature,
            source: {schemaId: 'x', propertyPath: '/properties/a'},
            severity: 'warn',
            message: 'm',
          },
        }),
      ).toThrow(ContractsValidationError);
    }
  });

  it('degrades a self-recursive fragment to z.any() instead of looping', () => {
    const schema: JSONSchema = {
      $id: 'list',
      type: 'object',
      properties: {head: {$ref: '#/$defs/cell'}},
      $defs: {
        cell: {type: 'object', properties: {next: {$ref: '#/$defs/cell'}}},
      },
    };
    const {content, reports} = emitWith(schema, [schema]);
    expect(content).toContain('"next": z.any()');
    expect(reports.map(r => r.feature)).toEqual(['recursive-fragment-$ref']);
  });
});

describe('ZodEmitter naming', () => {
  it('names URL-$id output from title and a filesystem-safe slug', () => {
    const {content, path} = emitWith(INTAKE, [INTAKE, ADDRESS]);
    expect(path).toBe('models/intake-1-0-0.zod.ts');
    expect(content).toContain('export const AppraisalIntakeSchema =');
    expect(content).toContain(
      'export type AppraisalIntake = z.infer<typeof AppraisalIntakeSchema>;',
    );
  });

  it('keeps plain-$id output byte-identical (title is ignored)', () => {
    const {content, path} = emitWith(
      {
        $id: 'appraisal-intake',
        title: 'Something Else',
        type: 'object',
        properties: {name: {type: 'string'}},
        required: ['name'],
      },
      [],
    );
    expect(path).toBe('models/appraisal-intake.zod.ts');
    expect(content).toBe(
      "import {z} from 'zod';\n\n" +
        'export const AppraisalIntakeSchema = z.object({ "name": z.string() });\n' +
        'export type AppraisalIntake = z.infer<typeof AppraisalIntakeSchema>;\n',
    );
  });

  it('disambiguates same-titled versions by their path', () => {
    const other: JSONSchema = {
      $id: 'https://schemas.example.com/intake/0.9.0',
      title: 'AppraisalIntake',
      type: 'object',
    };
    const current: JSONSchema = {
      ...INTAKE,
      properties: {previous: {$ref: '../intake/0.9.0'}},
    };
    const {content, path} = emitWith(current, [current, other]);
    expect(path).toBe('models/intake-1-0-0.zod.ts');
    expect(content).toContain(
      "import {Intake090Schema} from './intake-0-9-0.zod';",
    );
    expect(content).toContain('export const Intake100Schema =');
    expect(content).toContain('"previous": Intake090Schema.optional()');
    // The target's own file uses the same disambiguated name.
    const target = emitWith(other, [current, other]);
    expect(target.path).toBe('models/intake-0-9-0.zod.ts');
    expect(target.content).toContain('export const Intake090Schema =');
  });
});

// ---------------------------------------------------------------------------
// `oneOf` translation.
// ---------------------------------------------------------------------------

// Like `evaluate`, but transpiles the expression first (the exactly-one
// refinement carries TypeScript casts).
function evaluateTs(content: string, exportName: string): ZodLike {
  const script = content.replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const js = transpileModule(script, {
    compilerOptions: {module: ModuleKind.None, target: ScriptTarget.ES2022},
  }).outputText;
  const fn = new Function('z', `${js}\nreturn ${exportName};`) as (
    zod: typeof z,
  ) => ZodLike;
  return fn(z);
}

describe('ZodEmitter oneOf', () => {
  const EXACTLY_ONE: JSONSchema = {
    $id: 'appraisal-intake',
    type: 'object',
    properties: {
      insuredAge: {type: 'integer', minimum: 0},
      dateOfBirth: {type: 'string'},
      faceValue: {type: 'number'},
    },
    required: ['faceValue'],
    oneOf: [{required: ['insuredAge']}, {required: ['dateOfBirth']}],
  };

  it('enforces the exactly-one-of-required-keys pattern', () => {
    const {content, reports} = emitWith(EXACTLY_ONE, [EXACTLY_ONE]);
    expect(reports).toEqual([]);
    // No upstream `z.any()` branches: they made the refinement always fail.
    expect(content).not.toContain('z.any()');
    expect(content).toContain('.superRefine(');

    const schema = evaluateTs(content, 'AppraisalIntakeSchema');
    const base = {faceValue: 1};
    expect(schema.safeParse({...base, insuredAge: 40}).success).toBe(true);
    expect(schema.safeParse({...base, dateOfBirth: '1980-01-02'}).success).toBe(
      true,
    );
    expect(
      schema.safeParse({...base, insuredAge: 40, dateOfBirth: '1980-01-02'})
        .success,
    ).toBe(false);
    expect(schema.safeParse(base).success).toBe(false);
    // The base properties still validate.
    expect(schema.safeParse({insuredAge: 40}).success).toBe(false);
    expect(schema.safeParse({...base, insuredAge: -1}).success).toBe(false);
  });

  it('rejects non-objects when the exactly-one schema is untyped', () => {
    const untyped: JSONSchema = {
      $id: 'either',
      oneOf: [{required: ['a']}, {required: ['b']}],
    };
    const schema = evaluateTs(
      emitWith(untyped, [untyped]).content,
      'EitherSchema',
    );
    expect(schema.safeParse({a: 1}).success).toBe(true);
    expect(schema.safeParse({a: 1, b: 2}).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse('x').success).toBe(false);
  });

  it('keeps discriminated oneOf as z.discriminatedUnion', () => {
    const event: JSONSchema = {
      $id: 'payment-event',
      oneOf: [
        {
          type: 'object',
          properties: {
            kind: {type: 'string', const: 'card'},
            last4: {type: 'string'},
          },
          required: ['kind', 'last4'],
        },
        {
          type: 'object',
          properties: {
            kind: {type: 'string', const: 'wire'},
            iban: {type: 'string'},
          },
          required: ['kind', 'iban'],
        },
      ],
      discriminator: {propertyName: 'kind'},
    };
    const {content, reports} = emitWith(event, [event]);
    expect(reports).toEqual([]);
    expect(content).toContain('z.discriminatedUnion("kind"');
    const schema = evaluate(content, 'PaymentEventSchema');
    expect(schema.safeParse({kind: 'card', last4: '4242'}).success).toBe(true);
    expect(schema.safeParse({kind: 'wire', iban: 'DE00'}).success).toBe(true);
    expect(schema.safeParse({kind: 'card', iban: 'DE00'}).success).toBe(false);
    expect(schema.safeParse({kind: 'cash'}).success).toBe(false);
  });

  it('leaves a oneOf of full branch schemas to the upstream renderer', () => {
    const value: JSONSchema = {
      $id: 'value',
      oneOf: [{type: 'string'}, {type: 'number'}],
    };
    const {content, reports} = emitWith(value, [value]);
    expect(reports).toEqual([]);
    const schema = evaluateTs(content, 'ValueSchema');
    expect(schema.safeParse('a').success).toBe(true);
    expect(schema.safeParse(1).success).toBe(true);
    expect(schema.safeParse(true).success).toBe(false);
  });

  it('drops a oneOf with an unrenderable branch and reports it', () => {
    const mixed: JSONSchema = {
      $id: 'mixed',
      type: 'object',
      properties: {a: {type: 'string'}, b: {type: 'string'}},
      oneOf: [
        {required: ['a']},
        {type: 'object', properties: {b: {const: 'x'}}, required: ['b']},
      ],
    };
    const {content, reports} = emitWith(mixed, [mixed]);
    expect(reports.map(r => [r.feature, r.source.propertyPath])).toEqual([
      ['unsupported-oneOf', '/oneOf'],
    ]);
    expect(content).not.toContain('superRefine');
    const schema = evaluate(content, 'MixedSchema');
    expect(schema.safeParse({a: 'x'}).success).toBe(true);
    expect(schema.safeParse({a: 1}).success).toBe(false);

    const [report] = reports;
    if (report === undefined) throw new Error('no report');
    expect(() =>
      new ZodEmitter().validate({schema: mixed, lossy: report}),
    ).toThrow(ContractsValidationError);
  });
});
