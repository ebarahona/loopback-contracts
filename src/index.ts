// Public barrel for `@ebarahona/loopback-contracts`.
//
// Everything re-exported here is committed v1.0 public surface (or
// `@experimental` where the doc explicitly marks it). Engine internals
// stay behind subpath imports and are not re-exported.

export type {
  ContractsValidator,
  EmittedFile,
  EmitterContext,
  ExtensionKeywordHandler,
  ImportMap,
  JSONSchema,
  KeywordContext,
  KnownEmitterKind,
  LoopbackConfigJson,
  LossyReport,
  LossyReporter,
  MetaSchemaContributor,
  MigrationStrategy,
  ProjectPaths,
  ProjectionEmitter,
  SchemaRegistry,
  SchemaSource,
  SchemaSourceDescriptor,
  SchemaSourceResult,
  SourceExtension,
  SourceExtensionResult,
  TemplateEngine,
  ValidationResult,
  ValidatorContext,
} from './interfaces';

export {ContractsBindings} from './keys';

export type {ContractsErrorCode} from './helpers';

export {
  ContractsCodegenError,
  ContractsEmitterConflictError,
  ContractsError,
  ContractsPeerDepMissingError,
  ContractsPipelineError,
  ContractsSourceError,
  ContractsValidationError,
} from './helpers';

export {ContractsComponent} from './contracts.component';
