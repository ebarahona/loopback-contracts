import {BindingScope, injectable} from '@loopback/core';
import type {ValidateFunction} from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import {
  ContractsCodegenError,
  ContractsPeerDepMissingError,
  ContractsValidationError,
  toKebab,
} from '../../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReporter,
  ProjectionEmitter,
  SchemaRegistry,
} from '../../interfaces';
import {ContractsBindings} from '../../keys';

const PEER_DEP = 'json-schema-faker';
const DEFAULT_COUNT = 1;

/**
 * Per-schema options block read from the source schema's `x-mock-data` keyword.
 */
interface MockDataPerSchemaOptions {
  seed?: number;
  count?: number;
}

/**
 * Synchronous signature of `JSONSchemaFaker.generate(schema)` from
 * `json-schema-faker@0.5.x` (the CJS-compatible series).
 */
type GenerateFn = (schema: unknown) => unknown;

/**
 * Setter for the per-instance `option({...})` bag exposed by
 * `json-schema-faker@0.5.x`.
 */
type OptionFn = (opts: Record<string, unknown>) => void;

/**
 * Sidecar emitter that produces a fixture file (one or more JSON examples
 * that validate against the source schema) via `json-schema-faker`.
 *
 * Tier rationale: classified `'convenience'` (not `'real-translation'`)
 * because the output is a test fixture, not a faithful projection of the
 * contract into another serialization format. The values are randomly
 * generated samples that satisfy the schema's constraints; they carry no
 * semantic guarantee beyond "validates against the schema at generation
 * time". Consumers should treat the output as seed data for tests / local
 * dev environments, never as a normative artifact.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'mock-data',
  },
})
export class MockDataEmitter implements ProjectionEmitter<MockDataPerSchemaOptions> {
  readonly kind = 'mock-data';
  readonly outputSuffix = '.mock.json';
  readonly tier = 'convenience' as const;
  readonly description =
    'Sample fixture (json-schema-faker, one valid example per schema)';
  readonly peerDeps: string[] = [PEER_DEP];
  readonly perSchemaOptionsSchema: JSONSchema = Object.freeze({
    type: 'object',
    properties: {
      seed: {type: 'integer'},
      count: {type: 'integer', default: 1},
    },
    additionalProperties: false,
  }) as JSONSchema;

  // Cached: Ajv compilation is the documented hot-path cost
  // (https://ajv.js.org/guide/managing-schemas.html). The emitter is a
  // SINGLETON binding, so this cache lives for the process lifetime —
  // safe because the per-schema options schema is immutable.
  private cachedOptionsValidator: ValidateFunction | undefined;
  private cachedAjv: Ajv2020 | undefined;

  private getOptionsValidator(): ValidateFunction {
    if (this.cachedOptionsValidator !== undefined) {
      return this.cachedOptionsValidator;
    }
    this.cachedAjv = new Ajv2020({strict: false});
    this.cachedOptionsValidator = this.cachedAjv.compile(
      this.perSchemaOptionsSchema,
    );
    return this.cachedOptionsValidator;
  }

  emit(ctx: EmitterContext<MockDataPerSchemaOptions>): EmittedFile[] {
    const options = this.validateOptions(ctx.options);
    const faker = loadJsonSchemaFaker();
    const schemaId = typeof ctx.schema.$id === 'string' ? ctx.schema.$id : '';
    const fileBase = toKebab(schemaId || 'fixture');
    const count = Math.max(1, options.count ?? DEFAULT_COUNT);
    const seed = typeof options.seed === 'number' ? options.seed : undefined;

    const samples: unknown[] = [];
    for (let i = 0; i < count; i++) {
      // json-schema-faker@0.5.x uses a stateful per-instance option setter
      // followed by a sync generate() call. When a single seed is supplied
      // and we need multiple outputs, vary it by index so each example
      // differs while the run remains deterministic.
      const fakerOptions: Record<string, unknown> = {
        alwaysFakeOptionals: false,
        useDefaultValue: true,
        useExamplesValue: true,
      };
      if (seed !== undefined) {
        fakerOptions['random'] = seedToRandom(seed + i);
      }
      faker.option(fakerOptions);
      // Pre-resolve every `$ref` in a CLONED schema before handing it to
      // `json-schema-faker`. Without this, the faker treats unknown refs as
      // URLs and attempts to fetch them (the `0.5.x` series degrades to a
      // file/HTTP resolver), which produces flaky behaviour and can hang the
      // pipeline on offline runs. Resolution uses {@link SchemaRegistry} so
      // the result mirrors what other emitters see.
      const prepared = prepareSchemaForFaker(
        ctx.schema,
        ctx.registry,
        schemaId,
        ctx.lossy,
      );
      samples.push(faker.generate(prepared as unknown));
    }

    const payload: unknown = count === 1 ? samples[0] : samples;

    return [
      {
        path: `models/${fileBase}.mock.json`,
        content: `${JSON.stringify(payload, null, 2)}\n`,
        policy: 'regen',
        producer: 'mock-data-emitter',
      },
    ];
  }

  /**
   * Validate `options` against the emitter's declared
   * `perSchemaOptionsSchema` with Ajv 2020 via the cached compiled
   * validator. Empty / missing options pass through; structural violations
   * raise a typed {@link ContractsValidationError} so the CLI can render a
   * precise pointer.
   */
  private validateOptions(options: unknown): MockDataPerSchemaOptions {
    const validate = this.getOptionsValidator();
    const candidate = options ?? {};
    if (!validate(candidate)) {
      // `cachedAjv` is set in lock-step with `cachedOptionsValidator` by
      // `getOptionsValidator`; the non-null assertion is sound on the
      // failure branch.
      const ajv = this.cachedAjv as Ajv2020;
      throw new ContractsValidationError(
        `Invalid options for ${this.kind} emitter: ${ajv.errorsText(
          validate.errors,
        )}`,
        {
          sourcePath: `<schema x-${this.kind}>`,
          instancePath: validate.errors?.[0]?.instancePath ?? '',
        },
      );
    }
    return candidate as MockDataPerSchemaOptions;
  }
}

// ---------- $ref pre-resolution -----------------------------------------

/**
 * Walks `schema`, replacing every `$ref` with a deep clone of its registered
 * target so `json-schema-faker` never sees an unresolved reference.
 *
 * Why pre-resolve at all? The 0.5.x series resolves unknown refs by URL/file
 * fetch, which is unsafe in offline pipelines and gives non-deterministic
 * results when a target isn't on disk. The engine has already loaded every
 * schema into {@link SchemaRegistry}, so we substitute the in-memory copy.
 *
 * Cycles are broken by tracking the active `$ref` set: a self-reference (or
 * `A -> B -> A` loop) collapses to an open shape `{}` once the cycle is
 * detected, which the faker happily fills with arbitrary data.
 *
 * Unknown refs (not in the registry) also collapse to `{}` rather than
 * throwing — the validator stage upstream would have already caught a
 * truly-broken contract.
 */
function prepareSchemaForFaker(
  schema: JSONSchema,
  registry: SchemaRegistry,
  schemaId: string,
  lossy: LossyReporter,
): JSONSchema {
  const seen = new Set<string>();
  function resolve(node: unknown): unknown {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(resolve);
    const obj = node as Record<string, unknown>;
    reportMockCompositionIfPresent(obj, schemaId, lossy);
    if (typeof obj['$ref'] === 'string') {
      const refId = obj['$ref'];
      if (seen.has(refId)) return {};
      const target = resolveRefTarget(refId, schema, registry);
      if (target === undefined) return {};
      seen.add(refId);
      const cloned = resolve(target);
      seen.delete(refId);
      return cloned;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolve(v);
    return out;
  }
  return resolve(schema) as JSONSchema;
}

/**
 * Surface JSON Schema composition keywords (`oneOf` / `anyOf` / `allOf`)
 * encountered while walking the schema. `json-schema-faker` accepts them in
 * principle, but the engine's pre-resolution walker collapses to base
 * properties/type/items, so any composition branches are dropped from the
 * fixture without operator signal. The report names the source schema; the
 * exact in-document path is not tracked (the walker has no path-stack).
 */
function reportMockCompositionIfPresent(
  obj: Record<string, unknown>,
  schemaId: string,
  lossy: LossyReporter,
): void {
  if (
    !Array.isArray(obj['oneOf']) &&
    !Array.isArray(obj['anyOf']) &&
    !Array.isArray(obj['allOf'])
  )
    return;
  lossy.report({
    feature: 'mock-data-composition-dropped',
    severity: 'warn',
    source: {schemaId},
    message:
      'JSON Schema oneOf/anyOf/allOf composition is not projected to ' +
      'mock-data fixtures; the rendered output reflects only base ' +
      'properties/type/items.',
  });
}

/**
 * Resolve a JSON Schema `$ref` against the root document and the registry.
 *
 * Two ref shapes are supported:
 *
 * - Intra-document JSON Pointer (`#/$defs/foo`, `#/properties/x/items`) —
 *   walked segment-by-segment through the root schema with RFC 6901
 *   tilde-escapes honoured. The first segment is NOT used as a registry
 *   lookup key (a prior implementation collapsed `#/$defs/foo` to the
 *   registry entry for `$defs`, which never matched).
 * - Bare `$id`-style (`customer.v1`) or `<id>#/<pointer>` — looked up in
 *   the cross-document registry; the optional pointer tail walks into the
 *   target the same way as the local form.
 */
function resolveRefTarget(
  ref: string,
  root: JSONSchema,
  registry: SchemaRegistry,
): JSONSchema | undefined {
  if (ref.startsWith('#')) {
    const pointer = ref.slice(1).replace(/^\//, '');
    return walkPointer(root, pointer);
  }
  const hashIdx = ref.indexOf('#');
  const id = hashIdx === -1 ? ref : ref.slice(0, hashIdx);
  const pointer =
    hashIdx === -1 ? '' : ref.slice(hashIdx + 1).replace(/^\//, '');
  const target = registry.get(id);
  if (target === undefined) return undefined;
  return pointer === '' ? target : walkPointer(target, pointer);
}

function walkPointer(
  start: JSONSchema,
  pointer: string,
): JSONSchema | undefined {
  if (pointer === '') return start;
  let cur: unknown = start;
  for (const rawSegment of pointer.split('/')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    // RFC 6901: `~1` decodes to `/`, `~0` decodes to `~` (in that order).
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = (cur as Record<string, unknown>)[segment];
    if (cur === undefined) return undefined;
  }
  if (cur === null || typeof cur !== 'object') return undefined;
  return cur as JSONSchema;
}

// ---------- json-schema-faker loader ------------------------------------

interface JsonSchemaFakerInstance {
  generate: GenerateFn;
  option: OptionFn;
}

interface JsonSchemaFakerModule {
  JSONSchemaFaker?: JsonSchemaFakerInstance;
  generate?: GenerateFn;
  option?: OptionFn;
  default?: Partial<JsonSchemaFakerInstance> & Record<string, unknown>;
}

/**
 * Synchronously loads `json-schema-faker@0.5.x` via CJS `require()` and
 * normalises across the several shapes the package has shipped (named
 * `JSONSchemaFaker`, default export, or top-level `generate`/`option`).
 *
 * Pinned to `^0.5.6` — the 0.6 series dropped CJS support and the package
 * became ESM-only, which is incompatible with the CommonJS consumers of
 * this plugin. Module-resolution failures are mapped to
 * `ContractsPeerDepMissingError` so users get a clean install hint.
 */
function loadJsonSchemaFaker(): JsonSchemaFakerInstance {
  let mod: JsonSchemaFakerModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(PEER_DEP) as JsonSchemaFakerModule;
  } catch (err) {
    const code = (err as {code?: unknown} | null)?.code;
    if (
      code === 'MODULE_NOT_FOUND' ||
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ) {
      throw new ContractsPeerDepMissingError({
        emitterKind: 'mock-data',
        packageName: PEER_DEP,
      });
    }
    throw err;
  }

  const instance = pickInstance(mod);
  if (!instance) {
    throw new ContractsCodegenError(
      `json-schema-faker did not expose a 'generate' function in any of its known export shapes`,
      {emitterKind: 'mock-data', schemaId: ''},
    );
  }
  return instance;
}

function pickInstance(
  mod: JsonSchemaFakerModule,
): JsonSchemaFakerInstance | undefined {
  const candidates: Array<Record<string, unknown> | undefined> = [
    mod.JSONSchemaFaker as Record<string, unknown> | undefined,
    mod.default as Record<string, unknown> | undefined,
    mod as unknown as Record<string, unknown>,
  ];
  for (const c of candidates) {
    if (
      c &&
      typeof c['generate'] === 'function' &&
      typeof c['option'] === 'function'
    ) {
      return {
        generate: c['generate'] as GenerateFn,
        option: c['option'] as OptionFn,
      };
    }
  }
  return undefined;
}

/**
 * Returns a deterministic `() => number` PRNG (Mulberry32) for the given
 * seed. `json-schema-faker@0.5.x` accepts `option({random: fn})` where
 * `fn` is a uniform `[0, 1)` generator.
 */
function seedToRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
