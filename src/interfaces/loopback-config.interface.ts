import type {ModelConfigJson} from '../types';

/**
 * Value type for entries in {@link LoopbackConfigJson.emit}. Most entries
 * are boolean toggles keyed by emitter `kind`; two reserved keys carry
 * module-format metadata:
 *
 *   - `emit.esm` — boolean, opts the project into ESM-strict output.
 *   - `emit.importExtension` — string, one of `.js` | `.ts` | `''`, sets
 *     the suffix appended to relative imports in emitted code.
 *
 * The widened union keeps the meta-schema and the runtime helpers in
 * lock-step: any consumer reading `emit[kind]` as a boolean must first
 * narrow via {@link isEmitterEnabled} (or an explicit `=== true` check)
 * so the reserved string slot never leaks into a boolean branch.
 *
 * @public
 */
export type EmitValue = boolean | '.js' | '.ts' | '';

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
   * Per-emitter enable flags plus two reserved module-format slots
   * (`esm`, `importExtension`). Boolean entries are keyed by
   * `ProjectionEmitter.kind`; the reserved string-valued
   * `importExtension` slot must be read with
   * {@link getEmitImportExtension}. Unknown keys fail meta-schema
   * validation.
   */
  readonly emit: Readonly<Record<string, EmitValue>>;
  /**
   * Optional `loopback-config` integration — additional `@configClass`
   * bindings to register alongside generated artefacts. Each entry is
   * validated against the engine-generated model-config meta-schema at
   * pipeline stage 5 (same shape as a standalone `*.config.json` file),
   * so the array element type is {@link ModelConfigJson}.
   */
  readonly 'config-bindings'?: readonly ModelConfigJson[];
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

/**
 * Read whether an emitter `kind` is enabled. Returns false for missing
 * keys and for any non-boolean value (e.g. the reserved
 * `emit.importExtension` slot), so callers can iterate the map freely
 * without having to filter the reserved string-valued entries first.
 *
 * @public
 */
export function isEmitterEnabled(
  emit: Readonly<Record<string, EmitValue>>,
  kind: string,
): boolean {
  return emit[kind] === true;
}

/**
 * Read the ESM mode flag. Defaults to `false` when missing or invalid —
 * projects opt in explicitly; an absent or malformed entry is treated as
 * the CommonJS default.
 *
 * @public
 */
export function getEmitEsm(emit: Readonly<Record<string, EmitValue>>): boolean {
  return emit['esm'] === true;
}

/**
 * Read the import-extension setting for ESM mode. Defaults to `'.js'`
 * when missing or invalid; valid values are `'.js'` (the Node ESM
 * canonical form), `'.ts'` (for tools that resolve TypeScript suffixes
 * at runtime), and `''` (extensionless, for non-Node ESM hosts).
 *
 * @public
 */
export function getEmitImportExtension(
  emit: Readonly<Record<string, EmitValue>>,
): '.js' | '.ts' | '' {
  const v = emit['importExtension'];
  if (v === '.js' || v === '.ts' || v === '') return v;
  return '.js';
}
