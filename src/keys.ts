// Bare tag constants (`EMITTER_TAG`, `SOURCE_TAG`, …) below are intentionally
// module-internal — they are not re-exported from `src/index.ts`. They exist
// only so this package's own emitters and sources can write
// `@injectable({tags: {[EMITTER_TAG]: …}})` without importing the namespaced
// form (which would create a cyclic import: keys -> namespace -> tag literal).
//
// External consumers must use the namespaced form
// (`ContractsBindings.EMITTER_TAG`, etc.) — the bare names are *not* part of
// the published API and may be removed or renamed without a major bump.
// API-extractor flags these as un-exported `@internal` symbols; that's
// expected and documents the same intent.
import {BindingKey} from '@loopback/core';
import type {
  ConfigRegistry,
  ImportMap,
  LoopbackConfigJson,
  LossyReporter,
  ProjectPaths,
  SchemaRegistry,
  TemplateEngine,
} from './interfaces';

/**
 * Binding tag that marks a `ProjectionEmitter` contribution. Engine-internal
 * — public consumers must use {@link ContractsBindings.EMITTER_TAG}.
 *
 * @internal
 */
export const EMITTER_TAG = 'platform.contracts.emitter';

/**
 * Binding tag for `SchemaSource` contributions. Engine-internal — public
 * consumers must use {@link ContractsBindings.SOURCE_TAG}.
 *
 * @internal
 */
export const SOURCE_TAG = 'platform.contracts.source';

/**
 * Binding tag for `SourceExtension` contributions. Engine-internal —
 * public consumers must use {@link ContractsBindings.SOURCE_EXTENSION_TAG}.
 *
 * @internal
 */
export const SOURCE_EXTENSION_TAG = 'platform.contracts.source-extension';

/**
 * Binding tag for `ExtensionKeywordHandler` contributions. Engine-internal
 * — public consumers must use {@link ContractsBindings.EXTENSION_KEYWORD_TAG}.
 *
 * @internal
 */
export const EXTENSION_KEYWORD_TAG = 'platform.contracts.extension-keyword';

/**
 * Binding tag for `MetaSchemaContributor` contributions. Engine-internal
 * — public consumers must use
 * {@link ContractsBindings.META_SCHEMA_CONTRIBUTOR_TAG}.
 *
 * @internal
 */
export const META_SCHEMA_CONTRIBUTOR_TAG =
  'platform.contracts.meta-schema-contributor';

/**
 * Binding tag for `ContractsValidator` contributions. Engine-internal —
 * public consumers must use {@link ContractsBindings.VALIDATOR_TAG}.
 *
 * @internal
 */
export const VALIDATOR_TAG = 'platform.contracts.validator';

/**
 * Namespace grouping every binding key and tag the plugin publishes.
 *
 * Use the namespaced form (e.g., `ContractsBindings.EMITTER_TAG`) in every
 * public consumer. The bare top-level exports (`EMITTER_TAG`, `SOURCE_TAG`,
 * …) were removed from the public barrel pre-v1.0 to keep one canonical
 * channel per LB4 Style Guide §4 ("one namespace per plugin"); they remain
 * inside `keys.ts` only for engine-internal use.
 *
 * @public
 */
export namespace ContractsBindings {
  /**
   * Binding tag that marks a {@link ProjectionEmitter} contribution. The
   * engine discovers emitters via `@extensions.list({tag: EMITTER_TAG})`.
   *
   * @public
   */
  export const EMITTER_TAG = 'platform.contracts.emitter';

  /**
   * Binding tag for {@link SchemaSource} contributions.
   *
   * @public
   */
  export const SOURCE_TAG = 'platform.contracts.source';

  /**
   * Binding tag for {@link SourceExtension} contributions consumed by the
   * `lb4 contract` prompt.
   *
   * @public
   */
  export const SOURCE_EXTENSION_TAG = 'platform.contracts.source-extension';

  /**
   * Binding tag for {@link ExtensionKeywordHandler} contributions.
   *
   * @public
   */
  export const EXTENSION_KEYWORD_TAG = 'platform.contracts.extension-keyword';

  /**
   * Binding tag for {@link MetaSchemaContributor} contributions.
   *
   * @public
   */
  export const META_SCHEMA_CONTRIBUTOR_TAG =
    'platform.contracts.meta-schema-contributor';

  /**
   * Binding tag for {@link ContractsValidator} contributions.
   *
   * @public
   */
  export const VALIDATOR_TAG = 'platform.contracts.validator';

  /**
   * Resolved filesystem layout for the current `lb4 gen` run.
   *
   * @public
   */
  export const PROJECT_PATHS = BindingKey.create<ProjectPaths>(
    'platform.contracts.project-paths',
  );

  /**
   * Loaded schema registry — populated by the engine before any emitter runs.
   *
   * @public
   */
  export const SCHEMA_REGISTRY = BindingKey.create<SchemaRegistry>(
    'platform.contracts.schema-registry',
  );

  /**
   * Cross-schema TS import resolver.
   *
   * @public
   */
  export const IMPORT_MAP = BindingKey.create<ImportMap>(
    'platform.contracts.import-map',
  );

  /**
   * EJS template engine shared by all emitters.
   *
   * @public
   */
  export const TEMPLATE_ENGINE = BindingKey.create<TemplateEngine>(
    'platform.contracts.template-engine',
  );

  /**
   * Per-run lossy-translation reporter.
   *
   * @public
   */
  export const LOSSY_REPORTER = BindingKey.create<LossyReporter>(
    'platform.contracts.lossy-reporter',
  );

  /**
   * Per-contract LB4 metadata registry, populated by the engine at stage 5
   * from `configs/*.config.json`. Surfaced on
   * {@link EmitterContext.configs} for lb4-idiom-tier emitters.
   *
   * @public
   */
  export const CONFIG_REGISTRY = BindingKey.create<ConfigRegistry>(
    'platform.contracts.config-registry',
  );

  /**
   * The parsed `loopback.config.json` document.
   *
   * @public
   */
  export const CONFIG = BindingKey.create<LoopbackConfigJson>(
    'platform.contracts.config',
  );
}
