// Engine-internal helper types.
//
// Anything bound under a `@public` `BindingKey<T>` (LossyReporter,
// LoopbackConfigJson and its transitive types) lives under
// `src/interfaces/` and is re-exported here as a typed re-export so
// existing internal imports keep compiling.

export type {
  EmitValue,
  LoopbackConfigJson,
  MigrationStrategy,
  SchemaSourceDescriptor,
  SecurityConfig,
} from './interfaces/loopback-config.interface';

export {
  getEmitEsm,
  getEmitImportExtension,
  isEmitterEnabled,
} from './interfaces/loopback-config.interface';

export type {LossyReporter} from './interfaces/lossy-reporter.interface';

/**
 * Per-model config file — one per contract, sibling to the schema file.
 *
 * @internal
 */
export interface ModelConfigJson {
  $schema: string;
  $contractId: string;
  dataSource: string;
  public: boolean;
  model?: Record<string, unknown>;
  relations?: Record<string, ModelRelationConfig>;
  acls?: ModelAclConfig[];
}

/**
 * Single relation entry inside {@link ModelConfigJson.relations}.
 *
 * @internal
 */
export interface ModelRelationConfig {
  type:
    | 'belongsTo'
    | 'hasOne'
    | 'hasMany'
    | 'hasManyThrough'
    | 'referencesMany';
  schema: string;
  through?: string;
  keyFrom?: string;
  keyTo?: string;
}

/**
 * Single ACL entry inside {@link ModelConfigJson.acls}.
 *
 * @internal
 */
export interface ModelAclConfig {
  principalType: 'ROLE' | 'USER' | 'APP';
  principalId: string;
  permission: 'ALLOW' | 'DENY';
  accessType: 'READ' | 'WRITE' | 'EXECUTE' | '*';
  property?: string;
}

/**
 * One entry in the per-project `datasources.json` file.
 *
 * @internal
 */
export interface DatasourceConfigJson {
  $schema?: string;
  name: string;
  adapter: string;
  config?: Record<string, unknown>;
}
