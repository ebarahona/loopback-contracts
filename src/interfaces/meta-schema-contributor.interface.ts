import type {JSONSchema} from './emitter-context.interface';

/**
 * Plugin-contributed mutator that augments one of the project's generated
 * meta-schemas before it is written to `_meta/`.
 *
 * The engine regenerates each meta-schema on every `lb4 gen` from the current
 * project state (declared `$id`s, datasource names, registered emitters).
 * Contributors are invoked after the engine's base generation; each
 * contributor receives the current document and returns a new one. The
 * engine validates the returned document and persists it.
 *
 * @remarks
 * The `target` discriminator is closed at v1.0 to the four meta-schemas the
 * engine emits. New meta-schemas added in future engine versions widen the
 * union; existing contributors are unaffected because they match by literal.
 *
 * @experimental
 */
export interface MetaSchemaContributor {
  /** Which meta-schema this contributor mutates. */
  readonly target:
    | '_meta/emitter-config.schema.json'
    | '_meta/model-config.schema.json'
    | '_meta/datasources.schema.json'
    | '_meta/emitter.schema.json';

  /**
   * Return the new meta-schema document. Implementations must not mutate
   * `current` in place — return a fresh object.
   */
  contribute(current: JSONSchema): JSONSchema;
}
