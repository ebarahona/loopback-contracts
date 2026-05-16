/**
 * Top-level shape of `loopback.config.json` — the per-project entry point
 * the `lb4 init` command writes and `lb4 gen` reads on every run.
 *
 * Bound under {@link ContractsBindings.CONFIG} — exposed as `@public`
 * because the binding key is `@public` and the generic on the
 * `BindingKey` is part of the public contract.
 *
 * @public
 */
export interface LoopbackConfigJson {
  /** Project name (from the `lb4 init` prompt). */
  readonly name: string;
  /** Directory containing authored `*.schema.json` files. */
  readonly schemasDir: string;
  /** Directory containing authored `*.config.json` files. */
  readonly configsDir: string;
  /** Default runtime validator — drives `loopback-config` and sidecar emission. */
  readonly validator: 'ajv' | 'zod';
  /** Schema-source URIs the engine fetches on every run. */
  readonly schemas: readonly SchemaSourceDescriptor[];
  /**
   * Per-emitter enable flags. Keys match `ProjectionEmitter.kind` of
   * registered emitters; unknown keys fail meta-schema validation.
   */
  readonly emit: Readonly<Record<string, boolean>>;
  /**
   * Optional `loopback-config` integration — additional `@configClass`
   * bindings to register alongside generated artefacts.
   */
  readonly 'config-bindings'?: readonly unknown[];
  /**
   * Optional per-emitter migration strategy when a schema change would
   * produce a breaking output (kebab-case key matches emitter `kind`).
   */
  readonly 'migration-strategy'?: Readonly<Record<string, MigrationStrategy>>;
}

/**
 * One entry in `LoopbackConfigJson.schemas` — a URI naming a fetch source.
 *
 * Recognised prefixes at v1.0:
 *   - bare path (e.g., `./schemas`) — local directory
 *   - `npm:<package>` — npm package containing schemas
 *   - `git+<url>` — git repository (branch/tag/sha pinned)
 *   - `https://...` — HTTP directory listing
 *
 * Plugin-registered `SchemaSource` implementations widen the
 * recognised prefix set without changing this string type.
 *
 * @public
 */
export type SchemaSourceDescriptor = string;

/**
 * Migration strategy declared per emitter when a breaking schema change is
 * detected. Drives stage-7 "compatibility check" in the pipeline.
 *
 * @public
 */
export interface MigrationStrategy {
  /** `'allow'` skips the gate; `'fail'` keeps the default refusal. */
  readonly mode: 'allow' | 'fail';
  /** Free-form note recorded in the run report for auditing. */
  readonly note?: string;
}
