import type {JSONSchema} from './emitter-context.interface';

/**
 * Plugin-contributed handler for a custom JSON Schema extension keyword
 * (e.g., `x-platform.*`, `x-graphql`, `x-myorg-event`).
 *
 * The engine invokes every registered handler against every authored schema
 * during pipeline stage 5 ("custom keyword validation"). Handlers throw on
 * invalid usage; the engine catches the throw and emits a uniform validation
 * error pointing at the offending file and instance path.
 *
 * @remarks
 * Per-schema options consumed by an emitter (`x-<emitter-kind>`) belong on
 * the emitter itself via {@link ProjectionEmitter.perSchemaOptionsSchema}.
 * Use this extension point only for keywords that need cross-cutting
 * validation independent of any single emitter.
 *
 * Note: as of v1.0, registered `ExtensionKeywordHandler` contributions are
 * NOT invoked by the pipeline. The interface is published as a
 * forward-compatibility hook; the schema-traversal phase that would consume
 * it will land in a v1.x minor. Plugins implementing this interface today
 * should expect their handlers to be registered but unused; track
 * [INSERT ISSUE NUMBER OR TODO] for status.
 *
 * @experimental
 */
export interface ExtensionKeywordHandler {
  /**
   * The keyword the handler claims. Must be unique across the registry;
   * collisions cause the engine to refuse to start with a diagnostic.
   */
  readonly keyword: string;

  /**
   * Validate one occurrence of the keyword. Throw any `Error` (preferably
   * a `ContractsValidationError`) to fail the pipeline with a pointer to
   * the offending location.
   */
  validate(value: unknown, ctx: KeywordContext): void;
}

/**
 * Location information passed to {@link ExtensionKeywordHandler.validate}.
 *
 * @experimental
 */
export interface KeywordContext {
  /** The schema document containing the keyword occurrence. */
  readonly schema: JSONSchema;
  /** `$id` of `schema` (resolved by the engine before handler dispatch). */
  readonly schemaId: string;
  /**
   * Dot-separated property path to the keyword, relative to the schema root.
   * Omitted when the keyword appears at the schema root.
   */
  readonly propertyPath?: string;
}
