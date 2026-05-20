import type {JSONSchema} from './emitter-context.interface';

/**
 * Plugin-contributed entry for the `lb-contracts contract` source-selection prompt.
 *
 * `loopback-contracts-import` is the canonical consumer: each importer
 * (`zod`, `openapi`, `wsdl`, `avro`, `proto`, `graphql-sdl`, `asyncapi`,
 * `live-db`, …) registers a `SourceExtension` so the `lb-contracts contract`
 * interactive wizard can offer "Import from <format>" alongside the
 * built-in "Author from scratch" path. Selecting an entry runs the
 * importer's {@link SourceExtension.invoke}, which writes the new
 * `schemas/*.schema.json` (and optional `configs/*.config.json`) the
 * contracts engine then picks up on the next `lb-contracts gen`.
 *
 * @experimental
 */
export interface SourceExtension {
  /** Stable identifier — must be unique across registered source extensions. */
  readonly name: string;

  /** Human-readable label shown in the prompt list. */
  readonly label: string;

  /** One-line explanation shown beneath the label. */
  readonly description: string;

  /**
   * Optional JSON Schema describing the arguments {@link invoke} expects.
   * When present, the engine drives a follow-up prompt against this schema
   * and passes the validated answers to `invoke`.
   */
  readonly promptSchema?: JSONSchema;

  /**
   * Materialise the source — fetch / import / convert — and return the
   * paths of the files written. Paths are relative to the project root.
   */
  invoke(args: unknown): Promise<SourceExtensionResult>;
}

/**
 * Files written by {@link SourceExtension.invoke}. Paths are relative to
 * the project root.
 *
 * @experimental
 */
export interface SourceExtensionResult {
  /** Path of the authored `*.schema.json` written by the importer. */
  readonly schemaFile: string;
  /**
   * Optional path of the companion `*.config.json` when the importer
   * generates one (e.g., model bindings / datasource hints).
   */
  readonly configFile?: string;
}
