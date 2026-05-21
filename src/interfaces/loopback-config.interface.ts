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
 * the `lb-contracts init` command writes and `lb-contracts gen` reads on every run.
 *
 * Bound under {@link ContractsBindings.CONFIG} — exposed as `@public`
 * because the binding key is `@public` and the generic on the
 * `BindingKey` is part of the public contract.
 *
 * @public
 */
export interface LoopbackConfigJson {
  /** Project name (from the `lb-contracts init` prompt). */
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
  /**
   * Optional security-posture configuration — see {@link SecurityConfig}.
   * Absent or partial entries fall back to back-compat defaults documented
   * on each field. Validated against the generated `loopback-config`
   * meta-schema at stage 5 so typos under `security.*` fail loud.
   */
  readonly security?: SecurityConfig;
}

/**
 * Security-posture configuration block under
 * {@link LoopbackConfigJson.security}. Every field is optional and ships
 * with a documented default that preserves pre-existing behaviour, so
 * adding the block to an existing project is a no-op until at least one
 * sub-key is set. Field-level JSDoc names the default AND the threat
 * model the flag mitigates.
 *
 * The block is new pre-v1.0 surface — the shape may evolve in a minor
 * before promotion to `@public`. Every `security.http.*` field is honored
 * at runtime by `HttpSchemaSource`. A small set of operator escape hatches
 * also have env-var fallbacks in the `LOOPBACK_CONTRACTS_*` namespace; fields
 * without an env var are controlled solely by config + default.
 *
 * @experimental
 */
export interface SecurityConfig {
  /**
   * HTTP-source guardrails. Mitigates SSRF, memory exhaustion, and
   * DNS-rebinding attacks against the engine's HTTP/HTTPS schema fetcher.
   * Every field below is honored at runtime by `HttpSchemaSource`. For fields
   * with an env fallback, precedence is config \> env \> default. Otherwise
   * precedence is config \> default.
   */
  readonly http?: {
    /**
     * Per-request timeout in ms. Mitigates slowloris. Honored at runtime
     * by `HttpSchemaSource`. Precedence: config \>
     * `LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS` env \> default `30000`.
     */
    readonly timeoutMs?: number;
    /**
     * Maximum response body size in bytes. Mitigates memory exhaustion
     * from a hostile or runaway remote. Honored at runtime by
     * `HttpSchemaSource`. Precedence: config \>
     * `LOOPBACK_CONTRACTS_HTTP_MAX_BYTES` env \> default `5242880` (5 MB).
     */
    readonly maxBodyBytes?: number;
    /**
     * Permit fetches whose resolved IP is in private / link-local /
     * loopback ranges. Mitigates SSRF against internal services
     * (metadata endpoints, intranet hosts). Honored at runtime by
     * `HttpSchemaSource`. Precedence: config \>
     * `LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS` env \> default `false`.
     */
    readonly allowPrivateHosts?: boolean;
    /**
     * Re-resolve the host and re-check the IP after redirect chains.
     * Mitigates DNS rebinding where the first lookup resolves a public
     * IP and a follow-up resolves an internal one. Honored at runtime by
     * `HttpSchemaSource`. Precedence: config \> default `true`.
     */
    readonly verifyResolvedIps?: boolean;
    /**
     * Optional explicit allowlist of hostnames. When set, fetches against
     * any other host fail loud. Mitigates exfil/SSRF by narrowing the
     * egress surface to known partners. Honored at runtime by
     * `HttpSchemaSource`. Precedence: config \> default unset (no allowlist;
     * any public host permitted subject to other guards).
     */
    readonly allowedHosts?: readonly string[];
    /**
     * Follow 3xx redirects. Honored at runtime by `HttpSchemaSource`.
     * Precedence: config \> default `true`.
     */
    readonly allowRedirects?: boolean;
    /**
     * Maximum redirect-chain length. Mitigates redirect-loop DoS and
     * limits the number of DNS lookups per fetch. Honored at runtime by
     * `HttpSchemaSource`. Precedence: config \> default `10`.
     */
    readonly maxRedirects?: number;
    /**
     * Permit a redirect chain to downgrade the transport from `https://`
     * to `http://`. The source only accepts `https://` descriptors
     * initially, so an attacker controlling a redirect could otherwise
     * downgrade to plaintext HTTP (MITM-able, no certificate validation,
     * no encryption). Set to `true` only when integrating with a known
     * legacy partner — not recommended. Honored at runtime by
     * `HttpSchemaSource`. Precedence: config \>
     * `LOOPBACK_CONTRACTS_ALLOW_INSECURE_REDIRECTS` env \> default `false`.
     */
    readonly allowInsecureRedirects?: boolean;
  };
  /**
   * Manifest-emitter discovery guardrails — see
   * {@link ManifestEmitterBooter}. Mitigates an attacker who can drop a
   * `*.emitter.json` into the project tree (via a malicious PR or compromised
   * dependency) from registering a code-execution path through the template
   * engine.
   */
  readonly emitters?: {
    /**
     * Discover and register `<projectRoot>/emitters/*.emitter.json` at
     * boot. Default: `true` (back-compat — existing projects rely on the
     * discovery path). Set `false` in hardened CI to pin emitters to the
     * built-in / plugin set only.
     */
    readonly allowProjectManifests?: boolean;
    /**
     * Optional allowlist of emitter `kind` values. When set, every
     * discovered manifest whose `kind` is not in the list is dropped at
     * boot (logged). Default: unset (every discovered kind registers).
     */
    readonly allowedKinds?: readonly string[];
  };
  /**
   * Codegen-stage guardrails. Mitigates a hostile schema-source from
   * forcing arbitrary disk writes or compilation cost during a CI run.
   */
  readonly codegen?: {
    /**
     * Invoke `tsc --noEmit` at stage 8. Default: `true`. Set `false` for
     * faster local rerolls when the project already runs `tsc` separately.
     * The CLI's `--skip-tsc` flag is equivalent.
     */
    readonly runTsc?: boolean;
    /**
     * Trust the project root to receive engine-generated files under
     * `src/`. Default: `true` (back-compat). Reserved for a future wave
     * that gates file writes on this flag — declared today so consumer
     * configs can opt in early without a schema bump later.
     */
    readonly trustedProject?: boolean;
  };
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
