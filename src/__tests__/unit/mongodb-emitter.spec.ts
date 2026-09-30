import {describe, expect, it} from 'vitest';
import {MongoDbEmitter} from '../../emitters/semantic/mongodb-emitter';
import type {MongoDbPerSchemaOptions} from '../../emitters/semantic/mongodb-emitter';
import type {EmitterContext, JSONSchema, LossyReport} from '../../interfaces';

function build(
  schema: JSONSchema,
  options?: MongoDbPerSchemaOptions,
  others: readonly JSONSchema[] = [],
): {ctx: EmitterContext<MongoDbPerSchemaOptions>; reports: LossyReport[]} {
  const reports: LossyReport[] = [];
  const all = [schema, ...others];
  const byId = (id: string) => all.find(s => s.$id === id);
  const ctx: EmitterContext<MongoDbPerSchemaOptions> = {
    schema,
    registry: {
      get: byId,
      list: () => all,
      has: id => byId(id) !== undefined,
    },
    importMap: {resolve: id => './' + id},
    templates: {preload: async () => {}, render: () => ''},
    paths: {
      root: '/tmp/p',
      outputDir: '/tmp/p/src',
      schemasDir: '/tmp/p/schemas',
      configsDir: '/tmp/p/configs',
    },
    lossy: {report: r => reports.push(r), entries: () => reports},
    ...(options === undefined ? {} : {options}),
  };
  return {ctx, reports};
}

function translate(
  schema: JSONSchema,
  options?: MongoDbPerSchemaOptions,
  others: readonly JSONSchema[] = [],
): {out: Record<string, unknown>; reports: LossyReport[]} {
  const {ctx, reports} = build(schema, options, others);
  const [file] = new MongoDbEmitter().emit(ctx);
  const parsed = JSON.parse(file?.content ?? '{}') as {
    $jsonSchema: Record<string, unknown>;
  };
  return {out: parsed.$jsonSchema, reports};
}

/** Translate `{type: object, properties: {p: prop}}` and return `p`. */
function prop(
  schema: Record<string, unknown>,
  options?: MongoDbPerSchemaOptions,
): {out: unknown; reports: LossyReport[]} {
  const r = translate(
    {$id: 't', type: 'object', properties: {p: schema}},
    options,
  );
  return {
    out: (r.out['properties'] as Record<string, unknown>)['p'],
    reports: r.reports,
  };
}

describe('MongoDbEmitter', () => {
  it('writes models/<slug>.mongodb.json wrapping $jsonSchema', () => {
    const {ctx} = build({$id: 'customer.v1', type: 'object'});
    const [file] = new MongoDbEmitter().emit(ctx);
    expect(file?.path).toBe('models/customer-v1.mongodb.json');
    expect(file?.policy).toBe('regen');
    expect(JSON.parse(file?.content ?? '')).toEqual({
      $jsonSchema: {bsonType: 'object'},
    });
  });

  describe('type -> bsonType', () => {
    it.each([
      ['string', 'string'],
      ['boolean', 'bool'],
      ['object', 'object'],
      ['array', 'array'],
      ['null', 'null'],
      ['number', 'number'],
      ['integer', ['int', 'long']],
    ])('%s', (type, bsonType) => {
      expect(prop({type}).out).toEqual({bsonType});
    });

    it('maps a type union and de-duplicates', () => {
      expect(prop({type: ['integer', 'number', 'null']}).out).toEqual({
        bsonType: ['int', 'long', 'number', 'null'],
      });
    });

    it('honours the integer and number options', () => {
      expect(prop({type: 'integer'}, {integer: 'long'}).out).toEqual({
        bsonType: 'long',
      });
      expect(prop({type: 'integer'}, {integer: 'number'}).out).toEqual({
        bsonType: 'number',
      });
      expect(prop({type: 'number'}, {number: 'decimal'}).out).toEqual({
        bsonType: 'decimal',
      });
    });

    it('keeps date-time a string (format dropped) unless dateTime is date', () => {
      const asString = prop({type: 'string', format: 'date-time'});
      expect(asString.out).toEqual({bsonType: 'string'});
      expect(asString.reports.map(r => r.feature)).toEqual([
        'mongodb-unsupported-keyword',
      ]);

      const asDate = prop(
        {type: 'string', format: 'date-time', minLength: 1},
        {dateTime: 'date'},
      );
      expect(asDate.out).toEqual({bsonType: 'date'});
      expect(asDate.reports).toEqual([]);
      // Only date-time is mapped.
      expect(
        prop({type: 'string', format: 'date'}, {dateTime: 'date'}).out,
      ).toEqual({bsonType: 'string'});
    });
  });

  it.each([
    ['enum', {enum: ['a', 'b']}],
    ['minimum/maximum', {minimum: 1, maximum: 5}],
    [
      'minLength/maxLength/pattern',
      {minLength: 1, maxLength: 3, pattern: '^a'},
    ],
    [
      'minItems/maxItems/uniqueItems',
      {minItems: 1, maxItems: 2, uniqueItems: true},
    ],
    ['multipleOf', {multipleOf: 2}],
    ['minProperties/maxProperties', {minProperties: 1, maxProperties: 2}],
    ['title/description', {title: 'T', description: 'D'}],
  ])('keeps %s verbatim', (_label, keywords) => {
    const {out, reports} = prop(keywords);
    expect(out).toEqual(keywords);
    expect(reports).toEqual([]);
  });

  it('keeps required, drops an empty required', () => {
    expect(
      translate({$id: 't', required: ['a'], properties: {a: {}}}).out,
    ).toEqual({required: ['a'], properties: {a: {}}});
    expect(translate({$id: 't', required: []}).out).toEqual({});
  });

  it('translates additionalProperties and items recursively', () => {
    expect(
      prop({
        type: 'object',
        additionalProperties: {type: 'integer'},
      }).out,
    ).toEqual({
      bsonType: 'object',
      additionalProperties: {bsonType: ['int', 'long']},
    });
    expect(prop({type: 'array', items: {type: 'boolean'}}).out).toEqual({
      bsonType: 'array',
      items: {bsonType: 'bool'},
    });
  });

  it('rewrites 2020-12 forms MongoDB spells differently', () => {
    expect(prop({const: 'x'}).out).toEqual({enum: ['x']});
    expect(prop({exclusiveMinimum: 0, exclusiveMaximum: 10}).out).toEqual({
      minimum: 0,
      exclusiveMinimum: true,
      maximum: 10,
      exclusiveMaximum: true,
    });
    // An inclusive bound that is tighter wins.
    expect(prop({minimum: 5, exclusiveMinimum: 0}).out).toEqual({minimum: 5});
    expect(prop({prefixItems: [{type: 'string'}], items: false}).out).toEqual({
      items: [{bsonType: 'string'}],
      additionalItems: false,
    });
    expect(
      prop({
        dependentRequired: {a: ['b']},
        dependentSchemas: {c: {required: ['d']}},
      }).out,
    ).toEqual({dependencies: {a: ['b'], c: {required: ['d']}}});
    expect(prop({not: false}).out).toEqual({not: {not: {}}});
  });

  it('intersects const with enum regardless of key order', () => {
    expect(prop({enum: ['a', 'b'], const: 'a'}).out).toEqual({enum: ['a']});
    expect(prop({const: 'a', enum: ['a', 'b']}).out).toEqual({enum: ['a']});
    expect(prop({const: {x: 1, y: 2}, enum: [{y: 2, x: 1}]}).out).toEqual({
      enum: [{x: 1, y: 2}],
    });
    // An empty intersection keeps both constraints: nothing validates.
    expect(prop({enum: ['a', 'b'], const: 'c'}).out).toEqual({
      enum: ['c'],
      allOf: [{enum: ['a', 'b']}],
    });
  });

  it('drops annotations silently and unsupported keywords with a warning', () => {
    const {out, reports} = prop({
      type: 'string',
      default: 'a',
      examples: ['a'],
      $comment: 'c',
      'x-graphql': {},
      if: {minLength: 1},
      then: {maxLength: 2},
      contains: {},
    });
    expect(out).toEqual({bsonType: 'string'});
    expect(reports.map(r => [r.severity, r.source.propertyPath])).toEqual([
      ['warn', '/properties/p/if'],
      ['warn', '/properties/p/then'],
      ['warn', '/properties/p/contains'],
    ]);
  });

  it('inlines local and cross-schema $refs and drops $defs', () => {
    const money: JSONSchema = {
      $id: 'money',
      type: 'object',
      properties: {amount: {$ref: '#/$defs/amount'}},
      $defs: {amount: {type: 'number', minimum: 0}},
    };
    const {out, reports} = translate(
      {
        $id: 'order',
        type: 'object',
        properties: {
          total: {$ref: 'money'},
          fee: {$ref: 'money#/$defs/amount', description: 'fee'},
          status: {$ref: '#/$defs/status', maxLength: 5},
        },
        $defs: {status: {type: 'string'}},
      },
      undefined,
      [money],
    );
    expect(reports).toEqual([]);
    expect(out).toEqual({
      bsonType: 'object',
      properties: {
        total: {
          bsonType: 'object',
          properties: {amount: {bsonType: 'number', minimum: 0}},
        },
        fee: {bsonType: 'number', minimum: 0, description: 'fee'},
        status: {allOf: [{bsonType: 'string'}, {maxLength: 5}]},
      },
    });
  });

  it('reports recursive and unresolved $refs as errors', () => {
    const {out, reports} = translate({
      $id: 'node',
      type: 'object',
      properties: {next: {$ref: '#'}, x: {$ref: 'nope'}},
    });
    expect(out['properties']).toEqual({next: {}, x: {}});
    expect(reports.map(r => [r.feature, r.severity])).toEqual([
      ['recursive-$ref', 'error'],
      ['unresolved-$ref', 'error'],
    ]);
  });

  describe('_id with additionalProperties: false', () => {
    it('injects _id as objectId by default', () => {
      expect(
        translate({
          $id: 't',
          type: 'object',
          properties: {a: {type: 'string'}},
          additionalProperties: false,
        }).out,
      ).toEqual({
        bsonType: 'object',
        properties: {_id: {bsonType: 'objectId'}, a: {bsonType: 'string'}},
        additionalProperties: false,
      });
    });

    it('honours idBsonType, including any', () => {
      const closed = {$id: 't', additionalProperties: false};
      expect(
        translate(closed, {idBsonType: ['string', 'objectId']}).out[
          'properties'
        ],
      ).toEqual({_id: {bsonType: ['string', 'objectId']}});
      expect(translate(closed, {idBsonType: 'any'}).out['properties']).toEqual({
        _id: {},
      });
    });

    it('keeps a declared _id and leaves open schemas alone', () => {
      expect(
        translate({
          $id: 't',
          properties: {_id: {type: 'string'}},
          additionalProperties: false,
        }).out['properties'],
      ).toEqual({_id: {bsonType: 'string'}});
      expect(translate({$id: 't', properties: {}}).out).toEqual({
        properties: {},
      });
    });
  });

  it('fails warnings and errors under --strict, not info', () => {
    const emitter = new MongoDbEmitter();
    const schema: JSONSchema = {$id: 't'};
    const lossy = (severity: LossyReport['severity']): LossyReport => ({
      feature: 'mongodb-unsupported-keyword',
      source: {schemaId: 't', propertyPath: '/if'},
      severity,
      message: 'm',
    });
    expect(() => emitter.validate({schema, lossy: lossy('warn')})).toThrow(
      /MongoDB emitter rejected lossy translation/,
    );
    expect(() => emitter.validate({schema, lossy: lossy('error')})).toThrow();
    expect(() =>
      emitter.validate({schema, lossy: lossy('info')}),
    ).not.toThrow();
  });

  it('matches the golden validator', async () => {
    const money: JSONSchema = {
      $id: 'money',
      type: 'object',
      properties: {
        amount: {$ref: '#/$defs/amount'},
        currency: {type: 'string', enum: ['USD', 'EUR']},
      },
      required: ['amount', 'currency'],
      additionalProperties: false,
      $defs: {amount: {type: 'number', exclusiveMinimum: 0}},
    };
    const order: JSONSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://schemas.example.com/order/1.0.0',
      title: 'Order',
      type: 'object',
      properties: {
        orderId: {type: 'string', pattern: '^ord_[a-z0-9]+$'},
        status: {$ref: '#/$defs/status'},
        quantity: {type: 'integer', minimum: 1, maximum: 100},
        total: {$ref: 'money'},
        placedAt: {type: 'string', format: 'date-time'},
        tags: {
          type: 'array',
          items: {type: 'string', minLength: 1},
          maxItems: 10,
          uniqueItems: true,
        },
        note: {type: ['string', 'null'], maxLength: 500},
      },
      required: ['orderId', 'status', 'quantity', 'total', 'placedAt'],
      additionalProperties: false,
      $defs: {status: {type: 'string', enum: ['open', 'paid', 'void']}},
      'x-mongodb': {dateTime: 'date'},
    };
    const {ctx, reports} = build(order, {dateTime: 'date'}, [money]);
    const [file] = new MongoDbEmitter().emit(ctx);
    expect(reports).toEqual([]);
    await expect(file?.content).toMatchFileSnapshot(
      './__golden__/order.mongodb.json',
    );
  });
});
