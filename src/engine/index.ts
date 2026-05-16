// Engine-internal barrel. Nothing here is part of the public API surface;
// `src/index.ts` deliberately does NOT re-export from this folder.

export {EjsTemplateEngine} from './template-engine';
export type {TemplateHelpers} from './template-engine';
export {InMemoryLossyReporter} from './lossy-reporter';
export {FileWriter} from './file-writer';
export type {ChangeReport, WriteResult} from './file-writer';
export {InMemorySchemaRegistry} from './schema-registry';
export {RelativeImportMap} from './import-map';
export type {GetTargetPath} from './import-map';
export {DefaultProjectPaths} from './project-paths';
export {EmitterRegistry} from './emitter-registry';
export type {EmitterMetadata} from './emitter-registry';
export {EmitterRunner} from './emitter-runner';
export type {EmitterRunnerOptions} from './emitter-runner';
export {ManifestBackedEmitter} from './manifest-backed-emitter';
export {ManifestEmitterBooter} from './manifest-emitter-booter';
export {validateManifest} from './emitter-manifest';
export type {EmitterManifest, EmitterManifestTier} from './emitter-manifest';
export {SourceResolverRegistry} from './source-resolver-registry';
export {
  buildDatasourcesMetaSchema,
  buildEmitterManifestMetaSchema,
  buildLoopbackConfigMetaSchema,
  buildModelConfigMetaSchema,
} from './meta-schema-generator';
export {Pipeline} from './pipeline';
export type {PipelineResult, PipelineRunOptions, StageNumber} from './pipeline';
export {ContractsEngineBindings} from './tokens';
export {ModuleFormatTransformer} from './module-format-transformer';
export type {ModuleFormatTransformerOptions} from './module-format-transformer';
