import {BindingScope, inject, injectable} from '@loopback/core';
import {ContractsCodegenError, ContractsPeerDepMissingError} from '../helpers';

// `json-schema-traverse` is a CommonJS module published with `export =`.
// With `esModuleInterop` enabled, the default-import shape lands the
// callable on `traverse` directly.
import traverse from 'json-schema-traverse';
import type {
  ConfigRegistry,
  EmittedFile,
  EmitterContext,
  ImportMap,
  JSONSchema,
  LossyReport,
  ProjectionEmitter,
  ProjectPaths,
  SchemaRegistry,
  TemplateEngine,
} from '../interfaces';
import {ContractsBindings} from '../keys';
import type {LossyReporter} from '../types';
import {EmitterRegistry} from './emitter-registry';
import {ContractsEngineBindings} from './tokens';

/**
 * Options accepted by {@link EmitterRunner.run}.
 *
 * @internal
 */
export interface EmitterRunnerOptions {
  /**
   * Promote emitter-reported lossy translations to hard failures via the
   * emitter's optional `validate()` hook. When unset, lossy reports are
   * surfaced through the {@link LossyReporter} but never block emission.
   */
  readonly strict?: boolean;
}

// Tier ordering: lb4-idiom files land first (downstream emitters may reference
// them in import maps), real translations next, convenience wrappers last.
const TIER_ORDER: Readonly<Record<ProjectionEmitter['tier'], number>> = {
  'lb4-idiom': 0,
  'real-translation': 1,
  convenience: 2,
};

/**
 * Synthetic placeholder schema handed to per-project emitters when the
 * registered schema set is empty (e.g. a datasources-only project that
 * only ships a `DatasourceGenerator` output). Per-project emitters that
 * inspect schemas already iterate `ctx.registry.list()` rather than
 * `ctx.schema`, so a frozen empty stand-in keeps the `EmitterContext`
 * shape uniform without leaking a misleading `$id` into emitter logic.
 *
 * The `$id` uses URN syntax (`urn:loopback-contracts:internal:...`) to
 * signal an engine-synthetic placeholder no real user schema could
 * plausibly author. If an emitter logs `ctx.schema.$id`, the URN format
 * makes the synthetic origin obvious.
 *
 * Frozen at module scope so a misbehaving emitter cannot mutate it and
 * corrupt later runs sharing the same module instance.
 */
const EMPTY_PROJECT_SCHEMA: Readonly<JSONSchema> = Object.freeze({
  $id: 'urn:loopback-contracts:internal:empty-project-schema',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
});

/**
 * Orchestrates the per-schema x per-emitter emission pass that turns the
 * registered schema set into a flat {@link EmittedFile} list ready for the
 * {@link FileWriter}.
 *
 * Execution order is deterministic:
 *
 * 1. Emitters are sorted by `tier` (`lb4-idiom` -> `real-translation` ->
 *    `convenience`), then by `kind` to break ties.
 * 2. Schemas are sorted topologically by their `$ref` edges. Cycles are
 *    permitted — when one is detected, every member is emitted once in the
 *    order it was first entered, mirroring the LB4 lazy `() => Type`
 *    convention that defers resolution rather than refusing the graph.
 * 3. For each `(emitter, schema)` pair, an {@link EmitterContext} is built,
 *    `emit()` is invoked, and any returned files are tagged with the
 *    emitter's `kind` as the producer label for collision diagnostics.
 *
 * In strict mode (`opts.strict === true`) every {@link LossyReport} the
 * emitter contributed for the current schema is replayed through the
 * emitter's optional `validate()` hook; a thrown error converts the report
 * into a {@link ContractsCodegenError}, dropping the emitted files for that
 * `(emitter, schema)` pair.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class EmitterRunner {
  constructor(
    @inject(ContractsEngineBindings.EMITTER_REGISTRY)
    private readonly registry: EmitterRegistry,
    @inject(ContractsBindings.SCHEMA_REGISTRY)
    private readonly schemas: SchemaRegistry,
    @inject(ContractsBindings.TEMPLATE_ENGINE)
    private readonly templates: TemplateEngine,
    @inject(ContractsBindings.IMPORT_MAP)
    private readonly importMap: ImportMap,
    @inject(ContractsBindings.PROJECT_PATHS)
    private readonly paths: ProjectPaths,
    @inject(ContractsBindings.LOSSY_REPORTER)
    private readonly reporter: LossyReporter,
    @inject(ContractsBindings.CONFIG_REGISTRY)
    private readonly configs: ConfigRegistry,
  ) {}

  /**
   * Emit every enabled emitter against every supplied schema and return the
   * flat list of file descriptors. Does not write to disk — that is the
   * {@link FileWriter}'s job.
   *
   * @internal
   * @param schemas - Input schema set; the runner reorders this list
   *   topologically before emission.
   * @param emitFlags - `loopback.config.json#/emit` map, keyed by emitter
   *   `kind`. Only emitters whose flag is `true` participate.
   * @param opts - Runner options (see {@link EmitterRunnerOptions}).
   * @returns Concatenated {@link EmittedFile} descriptors in
   *   `(tier, kind, schema)` order.
   * @throws ContractsEmitterConflictError When two registered emitters share
   *   the same `kind`.
   * @throws ContractsPeerDepMissingError When an emitter throws a missing-
   *   module error for one of its declared `peerDeps`.
   * @throws ContractsCodegenError When an emitter throws during `emit()` or
   *   when a strict-mode `validate()` call rejects a lossy report.
   */
  async run(
    schemas: readonly JSONSchema[],
    emitFlags: Record<string, boolean>,
    opts: EmitterRunnerOptions = {},
  ): Promise<readonly EmittedFile[]> {
    await this.registry.validateUniqueness();
    const enabled = await this.registry.findEnabled(emitFlags);
    if (enabled.length === 0) return Object.freeze([]);

    const orderedEmitters = sortEmitters(enabled);
    const orderedSchemas = topologicalSort(schemas);

    // Preload every template every enabled emitter may render — once per
    // run, ahead of the per-schema loop. Keeps `templates.render()` in the
    // synchronous hot path with zero filesystem I/O.
    const allTemplatePaths = orderedEmitters.flatMap(
      e => e.templatePaths ?? [],
    );
    if (allTemplatePaths.length > 0) {
      await this.templates.preload(allTemplatePaths);
    }

    const output: EmittedFile[] = [];

    for (const emitter of orderedEmitters) {
      // Per-project emitters (e.g. `datasource`) declare their output as
      // a project-level resource that has no `$contractId` linkage to any
      // one schema. Invoke them once per run with the first schema in
      // topological order so the `EmitterContext` shape stays uniform —
      // `ctx.schema` still references a real schema, and emitters that
      // care about the full schema set can iterate `ctx.registry.list()`.
      //
      // When the registry is empty (datasources-only project), fall back
      // to the {@link EMPTY_PROJECT_SCHEMA} placeholder so the emitter
      // still fires exactly once instead of being silently skipped by an
      // empty `slice(0, 1)`.
      //
      // The default `'per-schema'` scope keeps the existing fan-out: one
      // `emit()` call per `(emitter, schema)` pair, matching how sidecars
      // and model/repository/controller project.
      const schemasForEmitter =
        emitter.outputScope === 'per-project'
          ? orderedSchemas.length === 0
            ? [EMPTY_PROJECT_SCHEMA]
            : orderedSchemas.slice(0, 1)
          : orderedSchemas;

      for (const schema of schemasForEmitter) {
        const before = this.reporter.entries().length;
        const context = this.buildContext(emitter, schema);

        let produced: EmittedFile[];
        try {
          // Emitters may return either `EmittedFile[]` or `Promise<EmittedFile[]>`
          // (e.g., `TypesEmitter` wraps the async-only `json-schema-to-typescript`
          // `compile()` call). `await` is a no-op on a non-thenable, so this
          // keeps synchronous emitters working unchanged.
          produced = await emitter.emit(context);
        } catch (err) {
          throw this.wrapEmitError(err, emitter, schema);
        }

        if (opts.strict === true && typeof emitter.validate === 'function') {
          const fresh = this.reporter.entries().slice(before);
          this.enforceStrict(emitter, schema, fresh);
        }

        for (const file of produced) {
          output.push(stampProducer(file, emitter.kind));
        }
      }
    }

    return Object.freeze(output);
  }

  // Build the per-call EmitterContext. Pulled per (emitter, schema) so each
  // emitter sees the same registry / import map / paths but a fresh `options`
  // block lifted from the schema's `x-<kind>` keyword (if present).
  private buildContext(
    emitter: ProjectionEmitter,
    schema: JSONSchema,
  ): EmitterContext {
    const optionsKey = `x-${emitter.kind}`;
    const options = (schema as Record<string, unknown>)[optionsKey];
    // Shallow-freeze: blocks `schema.foo = X` but not nested writes like
    // `schema.properties.bar = X`. The interface contract still says
    // "treat every field as read-only" — emitters must not write through
    // any reference reachable from the schema, frozen or not. Deep freeze
    // would O(n) traverse on every (emitter, schema) pair and the
    // realistic mutation surface (`json-schema-to-typescript`'s consumer
    // in types-emitter) already deep-clones. Freezing an already-frozen
    // object (e.g. the synthetic empty schema) is a no-op.
    Object.freeze(schema);
    const ctx: EmitterContext = {
      schema,
      registry: this.schemas,
      importMap: this.importMap,
      templates: this.templates,
      paths: this.paths,
      lossy: this.reporter,
      configs: this.configs,
    };
    return options === undefined ? ctx : {...ctx, options};
  }

  // Translate a peer-dep MODULE_NOT_FOUND into ContractsPeerDepMissingError
  // when the missing package name matches one the emitter declared up front.
  // Anything else becomes a ContractsCodegenError so the CLI can surface the
  // emitter kind + schema id without losing the original cause.
  private wrapEmitError(
    err: unknown,
    emitter: ProjectionEmitter,
    schema: JSONSchema,
  ): Error {
    const missing = detectMissingPeerDep(err, emitter.peerDeps);
    if (missing !== undefined) {
      return new ContractsPeerDepMissingError({
        emitterKind: emitter.kind,
        packageName: missing,
      });
    }
    const schemaId = typeof schema.$id === 'string' ? schema.$id : '<unknown>';
    const message = err instanceof Error ? err.message : String(err);
    return new ContractsCodegenError(
      `Emitter '${emitter.kind}' failed on schema '${schemaId}': ${message}`,
      {emitterKind: emitter.kind, schemaId},
      {cause: err},
    );
  }

  // Replay each fresh lossy report through validate(). A thrown error in
  // strict mode is fatal for this (emitter, schema) pair — the runner stops
  // immediately so the user sees the first violation, not a cascade.
  private enforceStrict(
    emitter: ProjectionEmitter,
    schema: JSONSchema,
    fresh: readonly LossyReport[],
  ): void {
    const validate = emitter.validate;
    if (validate === undefined) return;
    for (const lossy of fresh) {
      try {
        validate.call(emitter, {schema, lossy});
      } catch (err) {
        const schemaId =
          typeof schema.$id === 'string' ? schema.$id : '<unknown>';
        const cause = err instanceof Error ? err.message : String(err);
        throw new ContractsCodegenError(
          `Emitter '${emitter.kind}' rejected lossy translation ` +
            `'${lossy.feature}' on schema '${schemaId}' in --strict mode: ${cause}`,
          {emitterKind: emitter.kind, schemaId},
          {cause: err},
        );
      }
    }
  }
}

// Stable sort: tier first, then kind alphabetically. Two emitters at the
// same tier produce a deterministic file ordering, which keeps the dry-run
// diff stable across runs.
function sortEmitters(
  emitters: readonly ProjectionEmitter[],
): readonly ProjectionEmitter[] {
  return emitters.slice().sort((a, b) => {
    // `noUncheckedIndexedAccess` widens the lookup to `number | undefined`
    // even though `tier` is a closed literal union; coalesce to the
    // convenience bucket so an unknown tier sorts last instead of NaN-ing.
    const aTier = TIER_ORDER[a.tier] ?? TIER_ORDER['convenience'];
    const bTier = TIER_ORDER[b.tier] ?? TIER_ORDER['convenience'];
    const tierDelta = aTier - bTier;
    if (tierDelta !== 0) return tierDelta;
    return a.kind.localeCompare(b.kind);
  });
}

// Tag each EmittedFile with the producing emitter's kind so the FileWriter
// can name both sides of a collision in its diagnostic. Honor the emitter's
// own `producer` value if it explicitly set one.
function stampProducer(file: EmittedFile, kind: string): EmittedFile {
  if (file.producer !== undefined) return file;
  return {...file, producer: kind};
}

/**
 * Topological sort over the `$ref` edge set, exported for unit-test access.
 *
 * Implements a three-state DFS (`unvisited` -> `onStack` -> `done`). When the
 * walk encounters a back-edge (target is currently `onStack`) we acknowledge
 * the cycle and continue without recursing — the LB4 lazy `() => Type`
 * convention is enforced by the GENERATED code, so the sort just needs to
 * surface every cycle member exactly once in a deterministic order. The
 * outer loop iterates schemas sorted by `$id` so cycle members are entered
 * in a stable order regardless of input order; schemas without a `$id` keep
 * their input position and fall to the end.
 *
 * When the DFS exits a node it is pushed to `ordered`, yielding a list where
 * every dependency precedes its dependent for the acyclic edges and cycle
 * members appear in the order the cycle was first entered.
 *
 * @internal
 */
export function topologicalSort(
  schemas: readonly JSONSchema[],
): readonly JSONSchema[] {
  if (schemas.length <= 1) return schemas;

  const byId = new Map<string, JSONSchema>();
  const inputOrder = new Map<JSONSchema, number>();
  schemas.forEach((s, i) => {
    inputOrder.set(s, i);
    if (typeof s.$id === 'string') byId.set(s.$id, s);
  });

  const deps = new Map<JSONSchema, Set<JSONSchema>>();
  for (const schema of schemas) {
    const refs = collectRefs(schema, byId);
    refs.delete(schema); // self-refs are not edges
    deps.set(schema, refs);
  }

  // Stable child ordering: `$id` sort first (deterministic across runs),
  // input order as the tiebreaker for `$id`-less schemas.
  const childOrderKey = (s: JSONSchema): string => {
    const id = typeof s.$id === 'string' ? s.$id : '';
    const idx = inputOrder.get(s) ?? Number.MAX_SAFE_INTEGER;
    return `${id} ${String(idx).padStart(10, '0')}`;
  };

  type DfsState = 'unvisited' | 'onStack' | 'done';
  const state = new Map<JSONSchema, DfsState>();
  for (const schema of schemas) state.set(schema, 'unvisited');

  const ordered: JSONSchema[] = [];

  const visit = (node: JSONSchema): void => {
    const current = state.get(node);
    // `done`: already emitted, skip.
    // `onStack`: back-edge -> cycle; emitter code handles via `() => Type`,
    //   so we acknowledge by returning without recursing or re-pushing.
    if (current === 'done' || current === 'onStack') return;

    state.set(node, 'onStack');
    const children = deps.get(node);
    if (children !== undefined) {
      const sortedChildren = Array.from(children).sort((a, b) =>
        childOrderKey(a).localeCompare(childOrderKey(b)),
      );
      for (const child of sortedChildren) visit(child);
    }
    state.set(node, 'done');
    ordered.push(node);
  };

  // Outer loop walks schemas in a deterministic `$id` order so cycle members
  // are entered (and thus emitted) in the same order across runs.
  const rootOrder = schemas
    .slice()
    .sort((a, b) => childOrderKey(a).localeCompare(childOrderKey(b)));
  for (const schema of rootOrder) visit(schema);
  return ordered;
}

// Walk every `$ref` in a schema and resolve it to a sibling in `byId`. Only
// cross-schema edges count for ordering — JSON Pointer fragments inside the
// same document, external URLs, and refs to unknown ids are ignored.
function collectRefs(
  schema: JSONSchema,
  byId: ReadonlyMap<string, JSONSchema>,
): Set<JSONSchema> {
  const out = new Set<JSONSchema>();
  traverse(schema as Parameters<typeof traverse>[0], {
    cb: subschema => {
      const ref = (subschema as {$ref?: unknown}).$ref;
      if (typeof ref !== 'string' || ref.length === 0) return;
      // Strip an optional JSON Pointer fragment; the id portion is what
      // identifies the target document.
      const hashIdx = ref.indexOf('#');
      const id = hashIdx === -1 ? ref : ref.slice(0, hashIdx);
      if (id.length === 0) return; // intra-document fragment
      const target = byId.get(id);
      if (target !== undefined) out.add(target);
    },
  });
  return out;
}

// Detect a Node `MODULE_NOT_FOUND` error and extract the missing package
// name when it matches one of the emitter's declared peerDeps. Returning
// `undefined` means "this isn't a peer-dep miss; let the caller wrap it
// as a generic codegen error".
function detectMissingPeerDep(
  err: unknown,
  peerDeps: readonly string[] | undefined,
): string | undefined {
  if (peerDeps === undefined || peerDeps.length === 0) return undefined;
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as {code?: unknown; message?: unknown};
  if (e.code !== 'MODULE_NOT_FOUND' && e.code !== 'ERR_MODULE_NOT_FOUND') {
    return undefined;
  }
  const message = typeof e.message === 'string' ? e.message : '';
  // Match the package name as a whole token, anchored either by quote
  // characters (Node's canonical `Cannot find module 'pkg'` framing) or by
  // whitespace / line boundaries. A bare `.includes()` fallback would
  // wrongly match short peer-deps like `fs` or `path` against unrelated
  // `MODULE_NOT_FOUND` text.
  for (const dep of peerDeps) {
    const token = escapeRegExp(dep);
    const tokenRe = new RegExp(`(?:^|[\\s'"\`])${token}(?:[\\s'"\`/]|$)`);
    if (tokenRe.test(message)) return dep;
  }
  return undefined;
}

// Inline `escapeRegExp` — keeps the runner free of an extra peer-dep just
// for one regex helper. Escapes every character that carries special meaning
// inside a `RegExp` source so package names like `@scope/pkg` or
// `pkg.with.dots` match literally.
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
