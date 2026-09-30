import Ajv2020 from 'ajv/dist/2020';
import {describe, expect, it} from 'vitest';
import {
  classifySchemaChange,
  ownEntry,
  schemaDigest,
  serialiseBaseline,
} from '../../engine/schema-baseline';

const BASE = {
  $id: 'order',
  type: 'object',
  properties: {
    id: {type: 'string', maxLength: 10},
    status: {type: 'string', enum: ['open', 'paid']},
    tags: {type: 'array', items: {type: 'string'}},
  },
  required: ['id'],
};

function withProp(name: string, schema: unknown): unknown {
  return {...BASE, properties: {...BASE.properties, [name]: schema}};
}

describe('classifySchemaChange', () => {
  it('ignores annotation-only edits', () => {
    expect(
      classifySchemaChange(BASE, {
        ...BASE,
        title: 'Order',
        description: 'x',
        'x-avro': {namespace: 'a'},
      }),
    ).toBe('unchanged');
  });

  it.each([
    ['a new optional property', withProp('note', {type: 'string'})],
    [
      'a new enum value',
      withProp('status', {type: 'string', enum: ['open', 'paid', 'void']}),
    ],
    ['a loosened bound', withProp('id', {type: 'string', maxLength: 20})],
    ['a removed bound', withProp('id', {type: 'string'})],
    ['a required property made optional', {...BASE, required: []}],
    [
      'a widened type',
      withProp('id', {type: ['string', 'null'], maxLength: 10}),
    ],
    ['a new $defs entry', {...BASE, $defs: {x: {type: 'string'}}}],
  ])('classifies %s as additive', (_label, next) => {
    expect(classifySchemaChange(BASE, next)).toBe('additive');
  });

  it.each([
    ['a removed property', {...BASE, properties: {id: BASE.properties.id}}],
    ['a newly required property', {...BASE, required: ['id', 'status']}],
    [
      'an enum value removed',
      withProp('status', {type: 'string', enum: ['open']}),
    ],
    ['a type tightened', withProp('id', {type: 'integer'})],
    [
      'a nested bound tightened',
      withProp('id', {type: 'string', maxLength: 5}),
    ],
    [
      'a bound added',
      withProp('id', {type: 'string', maxLength: 10, minLength: 1}),
    ],
    [
      'a pattern added',
      withProp('id', {type: 'string', maxLength: 10, pattern: '^a'}),
    ],
    [
      'items tightened',
      withProp('tags', {type: 'array', items: {type: 'string', minLength: 1}}),
    ],
    ['additionalProperties closed', {...BASE, additionalProperties: false}],
    ['an unmodelled keyword changed', {...BASE, oneOf: [{required: ['id']}]}],
  ])('classifies %s as breaking', (_label, next) => {
    expect(classifySchemaChange(BASE, next)).toBe('breaking');
  });

  it('catches a removed property named after an Object.prototype member', () => {
    const prev = {
      type: 'object',
      properties: {constructor: {type: 'string'}, toString: {type: 'string'}},
    };
    expect(
      classifySchemaChange(prev, {
        type: 'object',
        properties: {toString: {type: 'string'}},
      }),
    ).toBe('breaking');
    expect(
      classifySchemaChange(
        {type: 'object', properties: {}},
        {type: 'object', properties: {constructor: {type: 'string'}}},
      ),
    ).toBe('additive');
  });

  it('accepts number widening an integer', () => {
    expect(classifySchemaChange({type: 'integer'}, {type: 'number'})).toBe(
      'additive',
    );
  });
});

describe('serialiseBaseline', () => {
  it('is key-sorted and byte-stable', () => {
    const a = serialiseBaseline({
      version: 1,
      schemas: {b: {type: 'string', $id: 'b'}, a: {$id: 'a'}},
    });
    const b = serialiseBaseline({
      version: 1,
      schemas: {a: {$id: 'a'}, b: {$id: 'b', type: 'string'}},
    });
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
    expect(Object.keys((JSON.parse(a) as {schemas: object}).schemas)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('ownEntry', () => {
  it('never returns Object.prototype members', () => {
    const map: Record<string, number> = {a: 1};
    expect(ownEntry(map, 'a')).toBe(1);
    expect(ownEntry(map, 'constructor')).toBeUndefined();
    expect(ownEntry(map, 'toString')).toBeUndefined();
    expect(ownEntry(map, '__proto__')).toBeUndefined();
    const parsed = JSON.parse('{"__proto__": 2}') as Record<string, number>;
    expect(ownEntry(parsed, '__proto__')).toBe(2);
  });
});

describe('serialiseBaseline digests', () => {
  it('omits an empty digests map and sorts a non-empty one', () => {
    expect(serialiseBaseline({version: 1, schemas: {}, digests: {}})).toBe(
      '{\n  "schemas": {},\n  "version": 1\n}\n',
    );
    const out = JSON.parse(
      serialiseBaseline({
        version: 1,
        schemas: {},
        digests: {b: schemaDigest({}), a: schemaDigest({type: 'string'})},
      }),
    ) as {digests: Record<string, string>};
    expect(Object.keys(out.digests)).toEqual(['a', 'b']);
    expect(out.digests['b']).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('digests key-order-independently', () => {
    expect(schemaDigest({a: 1, b: [1, {c: 2, d: 3}]})).toBe(
      schemaDigest({b: [1, {d: 3, c: 2}], a: 1}),
    );
  });
});

// Property-style soundness check of the hand-rolled classifier: for random
// schema pairs it calls `unchanged` or `additive`, every sample instance
// the old schema accepts must still be accepted by the new one (Ajv is the
// oracle). A `breaking` verdict may be conservative, so it is not checked.
// Per the classifier's contract, instances carry only the properties the
// old schema declares: a new optional property is additive even though an
// open old schema accepted any value under that name.
describe('classifySchemaChange soundness vs Ajv', () => {
  type S = Record<string, unknown>;

  // Deterministic PRNG (mulberry32) so failures reproduce.
  function prng(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = prng(0x5eed);
  const pick = <T>(xs: readonly T[]): T =>
    xs[Math.floor(rand() * xs.length)] as T;
  const chance = (p: number): boolean => rand() < p;
  const clone = <T>(v: T): T => structuredClone(v);

  const KEYS = ['a', 'b', 'c', 'd'] as const;
  const WORDS = ['x', 'yy', 'zzz', 'xyzw'];
  const VALUES: readonly unknown[] = [
    '',
    'x',
    'yy',
    'zzz',
    'xyzw',
    'xylophone',
    0,
    1,
    2.5,
    -3,
    10,
    true,
    null,
    [],
    ['x'],
    [1, 2],
    [1, 2, 3, 4, 5, 6],
    {},
  ];

  function someWords(): string[] {
    const words = WORDS.filter(() => chance(0.6));
    return words.length > 0 ? words : [pick(WORDS)];
  }

  function randomProp(): S {
    const type = pick(['string', 'number', 'integer', 'boolean', 'array']);
    const s: S = {type: chance(0.2) ? [type, 'null'] : type};
    if (type === 'string') {
      if (chance(0.5)) s['maxLength'] = 1 + Math.floor(rand() * 5);
      if (chance(0.3)) s['minLength'] = Math.floor(rand() * 3);
      if (chance(0.3)) s['enum'] = someWords();
      if (chance(0.2)) s['pattern'] = '^x';
    } else if (type === 'number' || type === 'integer') {
      if (chance(0.5)) s['minimum'] = Math.floor(rand() * 4) - 2;
      if (chance(0.5)) s['maximum'] = 2 + Math.floor(rand() * 8);
    } else if (type === 'array') {
      s['items'] = {type: pick(['string', 'number'])};
      if (chance(0.4)) s['maxItems'] = 1 + Math.floor(rand() * 4);
    }
    return s;
  }

  function randomSchema(): S {
    const properties: Record<string, S> = {};
    for (const k of KEYS) if (chance(0.7)) properties[k] = randomProp();
    const names = Object.keys(properties);
    const s: S = {
      type: 'object',
      properties,
      required: names.filter(() => chance(0.4)),
    };
    if (chance(0.3)) s['additionalProperties'] = false;
    return s;
  }

  const MUTATIONS: ReadonlyArray<(s: S) => void> = [
    s => {
      (s['properties'] as Record<string, S>)[pick(KEYS)] = randomProp();
    },
    s => {
      delete (s['properties'] as Record<string, S>)[pick(KEYS)];
    },
    s => {
      s['required'] = KEYS.filter(() => chance(0.4));
    },
    s => {
      if (chance(0.5)) delete s['additionalProperties'];
      else s['additionalProperties'] = false;
    },
    s => {
      const prop = (s['properties'] as Record<string, S>)[pick(KEYS)];
      if (prop === undefined) return;
      const key = pick([
        'maxLength',
        'minLength',
        'minimum',
        'maximum',
        'maxItems',
      ]);
      if (chance(0.3)) delete prop[key];
      else prop[key] = Math.floor(rand() * 6);
    },
    s => {
      const prop = (s['properties'] as Record<string, S>)[pick(KEYS)];
      if (prop === undefined) return;
      if (chance(0.3)) delete prop['enum'];
      else prop['enum'] = someWords();
    },
    s => {
      const prop = (s['properties'] as Record<string, S>)[pick(KEYS)];
      if (prop === undefined) return;
      prop['type'] = chance(0.5)
        ? pick(['string', 'number', 'integer', 'boolean', 'array'])
        : [pick(['string', 'number', 'integer']), 'null'];
    },
  ];

  function randomInstance(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of KEYS) if (chance(0.6)) out[k] = clone(pick(VALUES));
    return out;
  }

  it('never calls a change non-breaking when Ajv rejects an old instance', () => {
    const ajv = new Ajv2020({strict: false, allErrors: false});
    const instances = Array.from({length: 400}, randomInstance);
    let checked = 0;
    for (let i = 0; i < 600; i++) {
      const prev = randomSchema();
      const next = clone(prev);
      const n = 1 + Math.floor(rand() * 3);
      for (let m = 0; m < n; m++) pick(MUTATIONS)(next);
      const verdict = classifySchemaChange(prev, next);
      if (verdict === 'breaking') continue;
      checked++;
      const accepts = {prev: ajv.compile(prev), next: ajv.compile(next)};
      const declared = Object.keys(prev['properties'] as object);
      for (const inst of instances) {
        if (!Object.keys(inst).every(k => declared.includes(k))) continue;
        if (accepts.prev(inst) && !accepts.next(inst)) {
          throw new Error(
            `classified '${verdict}' but rejects an old instance:\n` +
              JSON.stringify({prev, next, inst}),
          );
        }
      }
    }
    // Enough non-breaking pairs were generated to make the check count.
    expect(checked).toBeGreaterThan(50);
  });
});
