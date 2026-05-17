import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReport,
} from './emitter-context.interface';

/**
 * Closed union of every emitter `kind` shipped by `@ebarahona/loopback-contracts`
 * at v1.0. Surfaced so IDE completions on `ProjectionEmitter.kind` and the
 * `emit` record in `loopback.config.json` show the built-in choices first.
 *
 * Custom emitters are free to declare any other string — see
 * {@link ProjectionEmitter.kind} for the `KnownEmitterKind | (string & {})`
 * widening pattern.
 *
 * @public
 */
export type KnownEmitterKind =
  // Sidecar emitters (--emit-<kind> opt-in; tier 'real-translation' or
  // 'convenience' depending on translation depth).
  | 'zod'
  | 'types'
  | 'graphql'
  | 'cloudevents'
  | 'asyncapi'
  | 'proto'
  | 'avro'
  | 'openapi-components'
  | 'mock-data'
  // LB4-idiom emitters (tier 'lb4-idiom'). Always-on by default — every
  // `lb4 gen` regenerates the base files. Sidecars opt in; LB4 idiom
  // files opt OUT (via `--no-emit-<kind>`) when a user genuinely doesn't
  // want a category (e.g. a contracts-only project that ships no
  // datasources).
  | 'model'
  | 'repository'
  | 'controller'
  | 'datasource';

/**
 * Contract every projection emitter implements — the single stable extension
 * point of `@ebarahona/loopback-contracts`.
 *
 * Emitters are contributions; the engine discovers them via
 * `@extensions.list({tag: ContractsBindings.EMITTER_TAG})` and runs them once
 * per `(schema, enabled-emitter)` pair. Adding a new emitter never requires
 * touching engine code — the CLI flag parser, init prompts, meta-schema
 * generation, and `loopback.config.json` validation all auto-update from the
 * registry.
 *
 * Built-in, plugin-contributed, and project-local manifest emitters all
 * implement this same interface; the engine cannot tell them apart at runtime.
 *
 * @typeParam TPerSchemaOptions - Shape of the per-schema options block the
 * emitter reads from `x-<kind>` keywords on the source schema. Defaults to
 * `unknown`; emitters with a richer options vocabulary should narrow it and
 * declare {@link ProjectionEmitter.perSchemaOptionsSchema}.
 *
 * @public
 */
export interface ProjectionEmitter<TPerSchemaOptions = unknown> {
  /**
   * Identifier — drives `--emit-<kind>`, config key, meta-schema enum entry.
   *
   * Typed as `KnownEmitterKind | (string & {})` so the built-in emitter
   * names surface in IntelliSense while custom emitters that declare a
   * fresh string (e.g., `'kafka-schema'`) still satisfy the interface. The
   * `string & {}` half is the standard trick to keep autocomplete on the
   * literal union without narrowing the type to a closed enum — same
   * pattern used on {@link ContractsValidator.stage}.
   */
  readonly kind: KnownEmitterKind | (string & {});

  /** Output file suffix — e.g., '.zod.ts', '.graphql.ts', '.proto', '.avsc'. */
  readonly outputSuffix: string;

  /** Classification for documentation / prompts / output ordering. */
  readonly tier: 'lb4-idiom' | 'real-translation' | 'convenience';

  /** Shown in `lb4 init` prompts and `lb4 emitters list` output. */
  readonly description: string;

  /** Optional peer-deps declared up front; engine loads them lazily on first emit. */
  readonly peerDeps?: string[];

  /**
   * How often the engine invokes {@link emit} per pipeline run.
   *
   *   - `'per-schema'` (default) — `emit()` runs once per `(emitter, schema)`
   *     pair, mirroring the per-schema projection model that sidecar
   *     emitters and `model`/`repository`/`controller` use.
   *   - `'per-project'` — `emit()` runs **once per pipeline run**, called
   *     with the first schema in topological order as context. Pick this
   *     when the emitter's output is a project-level resource (no
   *     `$contractId` linkage to any one schema) — e.g. the
   *     `datasource` emitter, which iterates
   *     `<projectRoot>/datasources.json` regardless of which schemas are loaded.
   *
   * Omitting the field is equivalent to declaring `'per-schema'`; the
   * engine treats `undefined` and `'per-schema'` identically.
   *
   * Per-project emitters that depend on the schema registry (rather than
   * a single `ctx.schema`) should read from `ctx.registry.list()` — the
   * `ctx.schema` slot still references a real schema (the first in
   * topological order) so `EmitterContext` shape stays uniform across
   * both scopes.
   *
   * @experimental
   */
  readonly outputScope?: 'per-schema' | 'per-project';

  /**
   * Absolute paths of every EJS template `emit()` may render. Declared up
   * front so the engine preloads them once per pipeline run and the
   * synchronous `render()` hot path touches no filesystem.
   *
   * Emitters that render no templates (e.g., emitters that hand-build their
   * output string) may omit this field.
   */
  readonly templatePaths?: readonly string[];

  /**
   * Optional — declare the JSON Schema for per-schema options
   * (e.g., x-graphql, x-cloudevents on the source schema).
   * Engine validates source schemas against this when the emitter is active.
   */
  readonly perSchemaOptionsSchema?: JSONSchema;

  /**
   * The one method emitters must implement.
   *
   * Returning a `Promise` is supported so an emitter can call an async-only
   * peer-dep (e.g., `json-schema-to-typescript`'s `compile()`). The engine
   * `await`s the result before tagging files; synchronous emitters that
   * return a bare `EmittedFile[]` keep working unchanged.
   */
  emit(
    input: EmitterContext<TPerSchemaOptions>,
  ): EmittedFile[] | Promise<EmittedFile[]>;

  /** Optional — called in `--strict` mode; throw on lossy translation. */
  validate?(input: {schema: JSONSchema; lossy: LossyReport}): void;
}
