// Public interface barrel for `@ebarahona/loopback-contracts`.
//
// JSONSchema strategy: we declare a local structural alias rather than
// re-exporting Ajv's `AnySchema`. Rationale:
//   1. Emitters must not transitively depend on a specific validator
//      implementation through the public type surface — the engine is
//      free to swap Ajv for an alternative without a major bump.
//   2. The structural alias (open index signature plus the keywords
//      emitters care about) lets emitter authors read `x-<kind>` blocks
//      and `$contractId` annotations without `as` casts.
//   3. Keeps the published `.d.ts` self-contained — no `ajv` import
//      appears in the public types, so consumers don't pull Ajv types
//      into their build graph.
// Engine internals may use Ajv types freely; this rule only governs
// what crosses the public boundary.

export type {
  EmittedFile,
  EmitterContext,
  ImportMap,
  JSONSchema,
  LossyReport,
  ProjectPaths,
  SchemaRegistry,
  TemplateEngine,
} from './emitter-context.interface';

export type {
  EmitValue,
  LoopbackConfigJson,
  MigrationStrategy,
  SchemaSourceDescriptor,
} from './loopback-config.interface';

export {
  getEmitEsm,
  getEmitImportExtension,
  isEmitterEnabled,
} from './loopback-config.interface';

export type {LossyReporter} from './lossy-reporter.interface';

export type {
  KnownEmitterKind,
  ProjectionEmitter,
} from './projection-emitter.interface';

export type {SchemaSource, SchemaSourceResult} from './schema-source.interface';

export type {
  ExtensionKeywordHandler,
  KeywordContext,
} from './extension-keyword-handler.interface';

export type {MetaSchemaContributor} from './meta-schema-contributor.interface';

export type {
  ContractsValidator,
  ValidationResult,
  ValidatorContext,
} from './contracts-validator.interface';

export type {
  SourceExtension,
  SourceExtensionResult,
} from './source-extension.interface';
