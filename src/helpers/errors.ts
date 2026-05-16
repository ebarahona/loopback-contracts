/**
 * Closed union of every machine-readable code a {@link ContractsError}
 * subclass can carry. Tools that branch on `err.code` get exhaustive-check
 * coverage; new codes added in a minor bump widen the union and surface as
 * `switch`-statement compile errors in downstream consumers.
 *
 * @public
 */
export type ContractsErrorCode =
  | 'CONTRACTS_VALIDATION'
  | 'CONTRACTS_CODEGEN'
  | 'CONTRACTS_SOURCE'
  | 'CONTRACTS_PIPELINE'
  | 'CONTRACTS_EMITTER_CONFLICT'
  | 'CONTRACTS_PEER_DEP_MISSING'
  | 'CONTRACTS_CLI_CANCELLED'
  | 'CONTRACTS_CLI_CONFIG_INVALID'
  | 'CONTRACTS_CLI_NO_PROJECT'
  | 'CONTRACTS_CLI_BAD_COMMAND_MODULE';

/**
 * Base class for every error the contracts engine surfaces. Subclasses carry
 * structured fields so the CLI can render uniform messages with file:line
 * pointers without having to parse a free-form `.message` string.
 *
 * @public
 */
export class ContractsError extends Error {
  /**
   * Short machine-readable code — e.g., `'CONTRACTS_VALIDATION'`.
   *
   * Typed as the closed {@link ContractsErrorCode} union so downstream
   * consumers can write exhaustive `switch (e.code)` blocks and the
   * compiler flags any new code added in a minor bump.
   */
  readonly code: ContractsErrorCode;

  constructor(
    code: ContractsErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ContractsError';
    this.code = code;
  }
}

/**
 * Thrown when an authored JSON document (schema, model-config, datasource)
 * fails Ajv validation against its meta-schema, or when an
 * {@link ExtensionKeywordHandler} rejects a keyword usage.
 *
 * @public
 */
export class ContractsValidationError extends ContractsError {
  readonly code = 'CONTRACTS_VALIDATION' as const;
  /** Absolute path to the offending source file. */
  readonly sourcePath: string;
  /**
   * Ajv-style JSON Pointer into `sourcePath` identifying the offending
   * node (e.g., `'/properties/email/format'`).
   */
  readonly instancePath: string;
  /** Optional schema `$id` the violation belongs to. */
  readonly schemaId?: string;

  constructor(
    message: string,
    fields: {sourcePath: string; instancePath: string; schemaId?: string},
    options?: ErrorOptions,
  ) {
    super('CONTRACTS_VALIDATION', message, options);
    this.name = 'ContractsValidationError';
    this.sourcePath = fields.sourcePath;
    this.instancePath = fields.instancePath;
    if (fields.schemaId !== undefined) this.schemaId = fields.schemaId;
  }
}

/**
 * Thrown when an emitter throws while rendering, when its output fails
 * `tsc --noEmit`, or when its declared `outputSuffix` collides with another
 * emitter's output for the same schema.
 *
 * @public
 */
export class ContractsCodegenError extends ContractsError {
  readonly code = 'CONTRACTS_CODEGEN' as const;
  /** Emitter `kind` that produced the failure. */
  readonly emitterKind: string;
  /** `$id` of the schema being projected when the failure occurred. */
  readonly schemaId: string;
  /** Output path the emitter was about to write (when known). */
  readonly outputPath?: string;

  constructor(
    message: string,
    fields: {emitterKind: string; schemaId: string; outputPath?: string},
    options?: ErrorOptions,
  ) {
    super('CONTRACTS_CODEGEN', message, options);
    this.name = 'ContractsCodegenError';
    this.emitterKind = fields.emitterKind;
    this.schemaId = fields.schemaId;
    if (fields.outputPath !== undefined) this.outputPath = fields.outputPath;
  }
}

/**
 * Thrown when a registered {@link SchemaSource} fails to fetch a URI — bad
 * credentials, network failure, missing pin, malformed URI.
 *
 * @public
 */
export class ContractsSourceError extends ContractsError {
  readonly code = 'CONTRACTS_SOURCE' as const;
  /** URI scheme of the failing source. */
  readonly scheme: string;
  /** The user-supplied URI that failed to resolve. */
  readonly uri: string;

  constructor(
    message: string,
    fields: {scheme: string; uri: string},
    options?: ErrorOptions,
  ) {
    super('CONTRACTS_SOURCE', message, options);
    this.name = 'ContractsSourceError';
    this.scheme = fields.scheme;
    this.uri = fields.uri;
  }
}

/**
 * Thrown when the engine pipeline aborts at a named stage — exposes the
 * stage label so the CLI can hint at the right next action.
 *
 * @public
 */
export class ContractsPipelineError extends ContractsError {
  readonly code = 'CONTRACTS_PIPELINE' as const;
  /** Named stage where the pipeline aborted. */
  readonly stage: string;

  constructor(
    message: string,
    fields: {stage: string},
    options?: ErrorOptions,
  ) {
    super('CONTRACTS_PIPELINE', message, options);
    this.name = 'ContractsPipelineError';
    this.stage = fields.stage;
  }
}

/**
 * Thrown when two emitters claim the same `kind`. By design the engine
 * refuses to silently override a built-in emitter; the conflict must be
 * resolved by renaming one of the contributions.
 *
 * @public
 */
export class ContractsEmitterConflictError extends ContractsError {
  readonly code = 'CONTRACTS_EMITTER_CONFLICT' as const;
  /** The `kind` both emitters tried to claim. */
  readonly kind: string;
  /** Origin labels of the two conflicting emitters. */
  readonly origins: readonly [string, string];

  constructor(fields: {kind: string; origins: readonly [string, string]}) {
    super(
      'CONTRACTS_EMITTER_CONFLICT',
      `Two emitters claim kind '${fields.kind}' (from ${fields.origins[0]} and ${fields.origins[1]}); rename one`,
    );
    this.name = 'ContractsEmitterConflictError';
    this.kind = fields.kind;
    this.origins = fields.origins;
  }
}

/**
 * Thrown when an emitter's declared `peerDeps` are missing at first emit.
 * The engine surfaces the precise package name so users can `npm install`
 * without digging through stack traces.
 *
 * @public
 */
export class ContractsPeerDepMissingError extends ContractsError {
  readonly code = 'CONTRACTS_PEER_DEP_MISSING' as const;
  /** Emitter `kind` whose peer-dep is missing. */
  readonly emitterKind: string;
  /** Package name that failed to load. */
  readonly packageName: string;

  constructor(fields: {emitterKind: string; packageName: string}) {
    super(
      'CONTRACTS_PEER_DEP_MISSING',
      `Emitter '${fields.emitterKind}' requires peer-dep '${fields.packageName}'; run \`npm install ${fields.packageName}\``,
    );
    this.name = 'ContractsPeerDepMissingError';
    this.emitterKind = fields.emitterKind;
    this.packageName = fields.packageName;
  }
}
