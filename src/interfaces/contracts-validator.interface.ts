import type {JSONSchema, ProjectPaths} from './emitter-context.interface';

/**
 * Plugin-contributed validator that the engine invokes at a named pipeline
 * stage. Currently the engine recognises `'pre'` (before any emitter runs)
 * and `'post'` (after all emitters have produced files, before
 * `tsc --noEmit`). Engine internals may add further named stages; an
 * unrecognised stage string is treated as `'post'` for forward compatibility.
 *
 * @remarks
 * The canonical extensibility doc states the eight-stage pipeline is
 * engine-owned; this extension point is provisional and lets adopters layer
 * cross-cutting checks (org-wide naming conventions, schema linting beyond
 * JSON Schema validity) without forking the engine. The contract may change
 * before v1.0 freeze.
 *
 * @experimental
 */
export interface ContractsValidator {
  /**
   * Pipeline stage to run at. Engine-defined values are `'pre'` and `'post'`;
   * the open `string` half lets contributors register custom phases that
   * future engine versions may surface (e.g., `'post-typecheck'`).
   */
  readonly stage: 'pre' | 'post' | (string & {});

  /** Inspect the run and return a verdict. */
  validate(input: ValidatorContext): ValidationResult;
}

/**
 * Per-run input passed to {@link ContractsValidator.validate}.
 *
 * @experimental
 */
export interface ValidatorContext {
  /** Resolved filesystem layout for the run. */
  readonly paths: ProjectPaths;
  /** Every schema the engine loaded for the run, keyed by `$id`. */
  readonly schemas: ReadonlyMap<string, JSONSchema>;
  /** True when the user invoked the engine with `--strict`. */
  readonly strict: boolean;
}

/**
 * Validator verdict. `ok: false` aborts the pipeline with the supplied
 * issues; `ok: true` permits the pipeline to continue (issues are surfaced
 * as warnings).
 *
 * @experimental
 */
export interface ValidationResult {
  readonly ok: boolean;
  readonly issues?: ReadonlyArray<{
    readonly severity: 'info' | 'warn' | 'error';
    readonly message: string;
    readonly schemaId?: string;
    readonly instancePath?: string;
  }>;
}
