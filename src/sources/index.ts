// Internal barrel for the built-in `SchemaSource` implementations and the
// shared on-disk cache. These classes are registered as extensions by the
// `ContractsComponent`; they are not re-exported from the package root.

export {GitSchemaSource} from './git-source';
export {HttpSchemaSource} from './http-source';
export {LocalSchemaSource} from './local-source';
export {NpmSchemaSource} from './npm-source';
export {SchemaSourceCache} from './source-cache';
