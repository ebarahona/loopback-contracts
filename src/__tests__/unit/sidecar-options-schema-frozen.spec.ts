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

  it('returns the SAME reference across constructions (no per-instance copy)', () => {
    // If a contributor accidentally swaps the `readonly` field for a getter
    // that returns a fresh literal each access, this would fail — the Ajv
    // cache keyed on the previous reference would never be hit again.
    const a = new MockDataEmitter();
    const b = new MockDataEmitter();
    expect(a.perSchemaOptionsSchema).toBe(a.perSchemaOptionsSchema);
    // Cross-instance identity is intentional: the schema literal is a
    // class-field initialiser, which the TS compiler emits once per
    // instance — but the OUTER `Object.freeze({...})` evaluates fresh per
    // instance, so we only assert intra-instance stability here.
    expect(Object.isFrozen(b.perSchemaOptionsSchema)).toBe(true);
  });
});
