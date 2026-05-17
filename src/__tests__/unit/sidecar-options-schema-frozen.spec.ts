import {describe, expect, it} from 'vitest';
import {MockDataEmitter} from '../../emitters/library/mock-data-emitter';
import {TypesEmitter} from '../../emitters/library/types-emitter';
import {ZodEmitter} from '../../emitters/library/zod-emitter';
import {AsyncAPIEmitter} from '../../emitters/semantic/asyncapi-emitter';
import {AvroEmitter} from '../../emitters/semantic/avro-emitter';
import {GraphQLEmitter} from '../../emitters/semantic/graphql-emitter';
import {ProtoEmitter} from '../../emitters/semantic/proto-emitter';

/**
 * Invariant: every sidecar emitter that declares a `perSchemaOptionsSchema`
 * MUST expose it as a frozen object.
 *
 * Why: the cycle-3 Ajv validator cache (see `getOptionsValidator()` on the
 * semantic emitters) compiles `perSchemaOptionsSchema` exactly once per
 * process lifetime and reuses the resulting `ValidateFunction` forever. The
 * cache invalidation strategy is "there is no invalidation" — it only works
 * because the schema reference is immutable.
 *
 * If a future contributor changes `perSchemaOptionsSchema` from a `readonly`
 * frozen literal to (a) a getter that returns a fresh object, (b) a mutable
 * field reassigned at runtime, or (c) a literal whose nested properties get
 * patched after construction, the cached validator would silently serve
 * stale validation — especially under `--watch` mode where the same process
 * outlives many edit cycles. Freezing the schema turns any such mutation
 * into a loud `TypeError` in strict mode, and this spec pins the freeze so
 * the invariant cannot be removed without a failing test.
 */
describe('sidecar emitter perSchemaOptionsSchema invariant', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly schema: object;
  }> = [
    {
      name: 'MockDataEmitter',
      schema: new MockDataEmitter().perSchemaOptionsSchema,
    },
    {name: 'TypesEmitter', schema: new TypesEmitter().perSchemaOptionsSchema},
    {name: 'ZodEmitter', schema: new ZodEmitter().perSchemaOptionsSchema},
    {
      name: 'AsyncAPIEmitter',
      schema: new AsyncAPIEmitter().perSchemaOptionsSchema,
    },
    {name: 'AvroEmitter', schema: new AvroEmitter().perSchemaOptionsSchema},
    {
      name: 'GraphQLEmitter',
      schema: new GraphQLEmitter().perSchemaOptionsSchema,
    },
    {name: 'ProtoEmitter', schema: new ProtoEmitter().perSchemaOptionsSchema},
  ];

  for (const {name, schema} of cases) {
    it(`${name}.perSchemaOptionsSchema is frozen at construction`, () => {
      expect(Object.isFrozen(schema)).toBe(true);
    });
  }

  it('property access returns a stable reference (not a fresh-object getter)', () => {
    // Scope of this test: it pins INTRA-instance stability — the
    // `perSchemaOptionsSchema` slot must be a plain field (or readonly
    // accessor that returns the same reference), NOT a getter that
    // computes a fresh object on every access. If a future contributor
    // swaps the class-field initialiser for `get perSchemaOptionsSchema()
    // { return {...this._schema}; }`, the two reads below would land
    // different objects and the strict-equality check fails — which
    // matters because the Ajv validator cache is keyed on the reference
    // returned by the FIRST read.
    //
    // It does NOT pin cross-instance reference equality: the schema
    // literal is a class-field initialiser, so the surrounding
    // `Object.freeze({...})` evaluates fresh per `new` call. `a.x === b.x`
    // is INTENTIONALLY not asserted. Cross-instance immutability is
    // already pinned by the for-loop above (`Object.isFrozen(b.x)`).
    const a = new MockDataEmitter();
    expect(a.perSchemaOptionsSchema).toBe(a.perSchemaOptionsSchema);
  });
});
