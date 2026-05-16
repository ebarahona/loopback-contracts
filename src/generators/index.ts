// Internal barrel for engine-owned generators. Nothing here is re-exported
// from the package's public `src/index.ts` — generators are pipeline-stage
// implementation details, not part of the projection-emitter surface.

export type {GeneratorContext, JsonSchemaToTsType} from './types';

export {
  buildRefResolver,
  jsonSchemaToTsType,
  type JsonSchemaToTsTypeOptions,
} from './json-schema-to-ts-type';

export {ModelGenerator} from './model-generator';
export {RepositoryGenerator} from './repository-generator';
export {ControllerGenerator} from './controller-generator';
export {DatasourceGenerator} from './datasource-generator';
export {BarrelGenerator, type BarrelInput} from './barrel-generator';
export {
  MetaSchemaWriter,
  type MetaSchemaWriterInput,
} from './meta-schema-writer';
