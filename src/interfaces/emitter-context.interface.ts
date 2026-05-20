import type {LossyReporter} from './lossy-reporter.interface';

/**
 * Structural JSON Schema 2020-12 document.
 *
 * Intentionally permissive (open `[k: string]: unknown` index signature) so
 * emitters can read `x-<kind>` extension keywords, draft-specific keywords,
 * and `$contractId`-style portfolio annotations without fighting the type
 * system. Authored schemas in `schemas/*.schema.json` are validated by Ajv
 * against the project's meta-schema before they reach an emitter; emitters
 * therefore receive already-valid input and can treat this type as a
 * structural read-only view.
 *
 * @remarks
 * We deliberately do not re-export Ajv's `AnySchema` here — the emitter
 * public surface must not depend on a particular validator implementation.
 * Engine internals are free to use Ajv types; the public contract stays
 * structural.
 *
 * @public
 */
export type JSONSchema = {
  $id?: string;
  $schema?: string;
  $defs?: Record<string, JSONSchema>;
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema | JSONSchema[];
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  not?: JSONSchema;
  /**
   * JSON Schema 2020-12 allows `boolean | JSONSchema`. The contracts engine
   * additionally honours the non-standard string literal `'preserve'`,
   * which the built-in types emitter forwards to
   * `json-schema-to-typescript`'s `compile()` (its `additionalProperties`
   * option is typed `boolean | 'preserve'`). Subschema values are accepted
   * for spec compliance but are flattened to `true` by the types emitter
   * with a lossy report — see
   * `src/emitters/library/types-emitter.ts` for the coercion path.
   */
  additionalProperties?: boolean | 'preserve' | JSONSchema;
  [k: string]: unknown;
};

/**
 * Per-call input handed to {@link ProjectionEmitter.emit}.
 *
 * The engine constructs a fresh `EmitterContext` per `(schema, emitter)` pair.
 * Emitters must treat every field as read-only — mutating the schema, the
 * registry, or the import map corrupts other emitters running in the same
 * pipeline.
 *
 * @typeParam TPerSchemaOptions - Shape of `options`. Matches the type
 * parameter declared on the implementing {@link ProjectionEmitter}.
 *
 * @public
 */
export interface EmitterContext<TPerSchemaOptions = unknown> {
  /** The schema being projected. */
  readonly schema: JSONSchema;

  /** Per-schema options extracted from the source schema's x-<kind> block. */
  readonly options?: TPerSchemaOptions;

  /** Read-only access to all registered schemas — for $ref resolution. */
  readonly registry: SchemaRegistry;

  /** Resolved import paths — emitters use this for cross-schema references. */
  readonly importMap: ImportMap;

  /** The engine's EJS template engine — emitters use this to render. */
  readonly templates: TemplateEngine;

  /** Project paths — output dir, schemas dir, project root. */
  readonly paths: ProjectPaths;

  /**
   * Sink for translation losses the emitter wants to surface. Call
   * `lossy.report({...})` whenever the projection drops information the
   * source schema declared (e.g., `oneOf` without discriminator collapsing
   * to a union, `format` keywords not representable in the target). The
   * engine aggregates reports across the run; `--strict` mode promotes any
   * `severity: 'warn'` to an error.
   */
  readonly lossy: LossyReporter;

  /**
   * Per-contract LB4 metadata loaded from `configs/*.config.json` files,
   * keyed by the contract's `$id`. Schemas under `schemas/` stay pure
   * JSON Schema (portable, language-agnostic); LB4-isms like `dataSource`
   * bindings, relations, ACLs, and `idProperty` live in the sibling
   * config files this registry surfaces.
   *
   * Optional because most sidecar emitters (zod, types, graphql, etc.)
   * have no business reading LB4 config — it would tightly couple them
   * to LB4 conventions. Consumed primarily by lb4-idiom-tier emitters
   * (model, repository, controller, datasource), which use it to project
   * the LB4-specific output (`@model()` settings, `@hasMany()` decorators,
   * datasource bindings, etc.).
   *
   * @experimental
   */
  readonly configs?: ConfigRegistry;
}

/**
 * Read-only view of every per-contract LB4 config the engine has loaded.
 *
 * Configs come from `configs/*.config.json` files validated against the
 * engine-generated `_meta/model-config.schema.json` at pipeline stage 5.
 * The registry surfaces them keyed by `$contractId` (which matches the
 * referenced schema's `$id`).
 *
 * Marked optional on {@link EmitterContext.configs} so emitters that don't
 * touch LB4 config (most sidecar emitters) don't need to care it exists.
 *
 * @experimental
 */
export interface ConfigRegistry {
  /**
   * Look up the LB4 config for a given contract by its `$contractId`.
   *
   * @param contractId - The contract's `$id` (mirrored in the config's
   *   `$contractId` field).
   * @returns The parsed config object, or `undefined` when no config
   *   file declared `$contractId` matching `contractId`. `unknown` already
   *   subsumes `undefined`; the JSDoc spells it out for emitter authors
   *   even though the type system folds it into the single `unknown`.
   */
  readonly get: (contractId: string) => unknown;

  /** Live snapshot of every loaded config. */
  readonly list: () => readonly unknown[];

  /** Membership check by `$contractId`. */
  readonly has: (contractId: string) => boolean;
}

/**
 * One file the emitter wants the engine to write.
 *
 * Emitters never touch the filesystem directly. They return descriptors; the
 * engine handles directory creation, header comment injection, base-vs-
 * extension overwrite policy, and atomic writes.
 *
 * @public
 */
export interface EmittedFile {
  /** Path relative to outputDir; emitter doesn't write directly — engine does. */
  readonly path: string;
  /** File body as the emitter rendered it; engine writes it verbatim after header injection. */
  readonly content: string;
  /** Optional encoding hint. Defaults to `'utf-8'`; set `'binary'` for non-text payloads. */
  readonly encoding?: 'utf-8' | 'binary';
  /**
   * Optional comment marker; engine prepends
   * `// AUTO-GENERATED — do not edit` automatically.
   */
  readonly headerComment?: string;
  /**
   * Optional overwrite policy. Defaults to `'regen'` (engine overwrites every
   * run). Set to `'skipIfExists'` for extension stubs the user is expected to
   * edit by hand — the engine will write the file once and leave it alone on
   * subsequent runs. Mirrors the `.base.*.ts` / `.*.ts` split documented in
   * the file-layout matrix.
   */
  readonly policy?: 'regen' | 'skipIfExists';
  /**
   * Optional label identifying the emitter that produced this descriptor —
   * typically the emitter's `kind` (e.g., `'zod'`, `'model'`). Consumed by
   * the engine's file writer for collision diagnostics: when two emitters
   * target the same output path, the error message names both producers so
   * the conflict is actionable without grepping. Emitters should populate
   * this field; the engine treats a missing value as `'<unknown>'`.
   */
  readonly producer?: string;
}

/**
 * Read-only view of every schema the engine has loaded for the current run.
 *
 * Lets emitters resolve `$ref` targets across files (e.g., `customer.v1`
 * referencing `address.v1`). The engine populates the registry before any
 * emitter runs; emitters never add entries.
 *
 * @public
 */
export interface SchemaRegistry {
  readonly get: (id: string) => JSONSchema | undefined;
  readonly list: () => readonly JSONSchema[];
  readonly has: (id: string) => boolean;
  /**
   * Optional `$defs`-aware lookup. Resolves a fragment URI of the form
   * `<schemaId>#/$defs/<name>` (or deeper JSON Pointer fragments) against
   * the registered schemas, returning the referenced subschema when found.
   *
   * The fragment portion is parsed as a JSON Pointer per RFC 6901 — `/`
   * and `~` in path segments must be escaped as `~1` and `~0` respectively
   * (e.g., `#/$defs/a~1b` resolves the `$defs` entry literally named
   * `a/b`). Unescaped `/` is interpreted as a pointer separator.
   *
   * Marked optional so existing {@link SchemaRegistry} implementations
   * remain compatible; engines that don't ship a fragment resolver simply
   * omit it and callers fall back to manual traversal of {@link get}'s
   * result.
   *
   * @param uri - The fragment URI to resolve.
   * @returns The referenced subschema, or `undefined` when the host
   *   schema is unknown or the pointer doesn't resolve.
   */
  readonly getFragment?: (uri: string) => JSONSchema | undefined;
}

/**
 * Resolver for cross-schema TypeScript imports.
 *
 * Given a source schema `$id` and the path of the file currently being
 * emitted, returns the relative import path the emitter should write into
 * `import` statements. Hides the project's directory layout from emitters.
 *
 * @public
 */
export interface ImportMap {
  /**
   * Resolve a cross-schema TypeScript import.
   *
   * @param id - The target schema's `$id` as registered in
   *   {@link SchemaRegistry}.
   * @param from - Absolute path of the file currently being emitted.
   * @returns The relative TS import path the emitter should write into its
   *   `import` statement, without an extension and without a leading `./`
   *   for sibling files (engine normalises both forms).
   */
  readonly resolve: (id: string, from: string) => string;
}

/**
 * The engine's EJS template renderer, exposed to emitters.
 *
 * All built-in and plugin emitters render via the same engine so projects
 * get one consistent template grammar.
 *
 * @public
 */
export interface TemplateEngine {
  /**
   * Warm the in-memory cache with every template path that will be rendered
   * later. Idempotent — calling with already-cached paths is a no-op.
   *
   * The engine calls this once per pipeline run, ahead of the per-schema
   * emit loop, so {@link render} can stay synchronous and the hot path
   * touches no filesystem.
   */
  readonly preload: (paths: readonly string[]) => Promise<void>;

  /**
   * Render a previously-{@link preload}ed template against a view-model.
   * Throws {@link ContractsCodegenError} if the path was not preloaded;
   * declare every template the emitter touches in
   * {@link ProjectionEmitter.templatePaths}.
   */
  readonly render: (templatePath: string, viewModel: object) => string;
}

/**
 * Resolved filesystem layout for the current `lb-contracts gen` run.
 *
 * @public
 */
export interface ProjectPaths {
  readonly root: string;
  readonly outputDir: string;
  readonly schemasDir: string;
  readonly configsDir: string;
}

/**
 * One entry in the lossy-translation report.
 *
 * Emitters surface lossy translations through the engine's reporter; the
 * engine renders them with uniform formatting and, in `--strict` mode,
 * promotes `severity: 'error'` entries to pipeline failures via the
 * optional {@link ProjectionEmitter.validate} hook.
 *
 * @public
 */
export interface LossyReport {
  /** e.g., 'z.brand', 'oneOf without discriminator' */
  readonly feature: string;
  readonly source: {
    readonly schemaId: string;
    /**
     * JSON Pointer (RFC 6901) into the schema; `/` and `~` are escaped as
     * `~1` and `~0`.
     */
    readonly propertyPath?: string;
  };
  readonly severity: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly workaround?: string;
}
