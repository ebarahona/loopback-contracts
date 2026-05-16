import {BindingScope, injectable} from '@loopback/core';
import {posix} from 'node:path';
import {
  buildDatasourcesMetaSchema,
  buildEmitterManifestMetaSchema,
  buildModelConfigMetaSchema,
} from '../engine/meta-schema-generator';
import {assertNoTraversal} from '../helpers';
import type {EmittedFile, JSONSchema} from '../interfaces';
import type {DatasourceConfigJson} from '../types';

const PRODUCER = 'meta-schema-writer';

/**
 * Input handed to {@link MetaSchemaWriter.generate}. Both lists are project
 * state read by upstream pipeline stages; the writer is pure given them.
 *
 * @internal
 */
export interface MetaSchemaWriterInput {
  schemas: readonly JSONSchema[];
  datasources: readonly DatasourceConfigJson[];
  /**
   * Optional list of installed connector adapters used by the datasource
   * meta-schema's `adapter` enum. Empty means the enum is omitted so a fresh
   * project still authors successfully.
   */
  installedAdapters?: readonly string[];
}

/**
 * Engine-internal writer that renders the three project meta-schemas to
 * `_meta/`. Wraps the pure builders in `engine/meta-schema-generator.ts` and
 * adapts them into the engine's {@link EmittedFile} pipeline so the same
 * `FileWriter` handles atomic writes and the per-run change report.
 *
 * Not registered under `EMITTER_TAG` — meta-schemas are engine-owned, not a
 * contributed projection.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class MetaSchemaWriter {
  /** Build three `EmittedFile` descriptors, one per meta-schema. */
  generate(opts: MetaSchemaWriterInput): EmittedFile[] {
    const adapters = opts.installedAdapters ?? [];
    return [
      this.toFile(
        'model-config.schema.json',
        buildModelConfigMetaSchema(opts.schemas, opts.datasources),
      ),
      this.toFile(
        'datasources.schema.json',
        buildDatasourcesMetaSchema(adapters),
      ),
      this.toFile('emitter.schema.json', buildEmitterManifestMetaSchema()),
    ];
  }

  private toFile(filename: string, doc: JSONSchema): EmittedFile {
    const path = posix.join('_meta', filename);
    assertNoTraversal(path, PRODUCER);
    return {
      path,
      content: JSON.stringify(doc, null, 2) + '\n',
      policy: 'regen',
      producer: PRODUCER,
    };
  }
}
