import {injectable} from '@loopback/core';
import {dirname, relative, sep} from 'node:path';
import {ContractsCodegenError} from '../helpers';
import type {ImportMap, SchemaRegistry} from '../interfaces';

/**
 * Strategy that maps a schema `$id` to the absolute path of the generated
 * TypeScript model file. Supplied by the engine when it wires the import map —
 * the engine knows the active emitter set and the resolved {@link ProjectPaths},
 * so it can compose `paths.outputDir + emitter.outputSuffix` without leaking
 * those concerns into the import map itself.
 *
 * @internal
 */
export type GetTargetPath = (schemaId: string) => string;

/**
 * Default {@link ImportMap} implementation. Resolves a schema `$id` to a
 * relative TypeScript import specifier, anchored at the directory of the file
 * currently being emitted.
 *
 * The strategy that maps `$id` to an absolute target path is injected — the
 * map itself stays oblivious to project layout, output suffixes, and which
 * emitter owns the destination file.
 *
 * @internal
 */
@injectable()
export class RelativeImportMap implements ImportMap {
  constructor(
    private readonly registry: SchemaRegistry,
    private readonly getTargetPath: GetTargetPath,
  ) {}

  resolve(id: string, from: string): string {
    if (!this.registry.has(id)) {
      throw new ContractsCodegenError(
        `Unknown schema \`$id\` '${id}' referenced from ${from}`,
        {emitterKind: 'import-map', schemaId: id, outputPath: from},
      );
    }
    const target = this.getTargetPath(id);
    let rel = relative(dirname(from), target);
    if (sep !== '/') rel = rel.split(sep).join('/');
    rel = rel.replace(/\.tsx?$/, '');
    if (!rel.startsWith('.')) rel = './' + rel;
    return rel;
  }
}
