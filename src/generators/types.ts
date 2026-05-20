import type {
  ImportMap,
  JSONSchema,
  ProjectPaths,
  SchemaRegistry,
  TemplateEngine,
} from '../interfaces';
import type {LossyReporter} from '../types';

/**
 * Per-run context handed to every engine-internal generator (model, repo,
 * controller, datasource, barrel, meta-schema). Mirrors the public
 * `EmitterContext` but stays internal — generators are not registered under
 * `EMITTER_TAG` and never appear on the public projection-emitter surface.
 *
 * @internal
 */
export interface GeneratorContext {
  /** Read-only access to every schema loaded for the current run. */
  registry: SchemaRegistry;
  /** Cross-schema relative-TS import resolver. */
  importMap: ImportMap;
  /** EJS template engine shared by every generator. */
  templates: TemplateEngine;
  /** Resolved filesystem layout for the current run. */
  paths: ProjectPaths;
  /** Sink for lossy-translation reports (unsupported JSON Schema keywords). */
  lossy: LossyReporter;
  /**
   * When `true`, generators emit the user-editable extension stub alongside
   * the regenerated base file (`<name>.<kind>.ts` next to
   * `<name>.base.<kind>.ts`). When `false`, only the base file is emitted.
   * Mirrors the `lb-contracts override <kind> <name>` opt-in flow.
   */
  includeExtension: boolean;
  /**
   * Optional callback letting generators (notably the barrel generator) ask
   * whether a hand-edited extension file exists on disk without performing
   * filesystem I/O themselves. Generators stay pure; the engine wires up the
   * concrete probe via `paths.outputDir` at the call site.
   */
  hasExtension?: (
    name: string,
    kind: 'model' | 'repository' | 'controller' | 'datasource',
  ) => boolean;
}

/**
 * Helper signature: translate a JSON Schema property fragment to a
 * TypeScript type literal. Implemented in `helpers/json-schema-to-ts-type.ts`
 * by Wave E1; templates import or receive it through the view-model.
 *
 * @internal
 */
export type JsonSchemaToTsType = (schema: JSONSchema) => string;
