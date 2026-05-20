import {BindingScope, injectable} from '@loopback/core';
import {posix} from 'node:path';
import {assertNoTraversal, toKebab} from '../helpers';
import type {EmittedFile} from '../interfaces';

const PRODUCER = 'barrel-generator';

/**
 * Per-directory barrel input. Each list contains contract or datasource names
 * (any case — normalised to kebab-case for filenames). `config` is optional
 * because not every project ships `@configClass` schemas.
 *
 * @internal
 */
export interface BarrelInput {
  models: readonly string[];
  repositories: readonly string[];
  controllers: readonly string[];
  datasources: readonly string[];
  config?: readonly string[];
  /**
   * Pure predicate the engine wires up against `paths.outputDir` so the
   * generator itself does no filesystem I/O. Returns `true` when a
   * `<name>.<kind>.ts` extension file already exists on disk — in that case
   * the barrel re-exports both the `.base.<kind>` and the bare extension so
   * downstream `import {Customer} from '../models'` works regardless of
   * which file owns the symbol.
   *
   * When omitted, only the base file is re-exported. Engines that don't yet
   * know which extensions exist can pass an always-`false` callback and let
   * `lb-contracts override` regenerate the barrel later.
   */
  hasExtension?: (
    name: string,
    kind: 'model' | 'repository' | 'controller' | 'datasource',
  ) => boolean;
}

/**
 * Engine-internal generator for the four per-directory barrels
 * (`src/models/index.ts`, `src/repositories/index.ts`,
 * `src/controllers/index.ts`, `src/datasources/index.ts`).
 *
 * Each barrel re-exports the always-regenerated `.base.<kind>` file plus, when
 * the `hasExtension` callback reports an extension file on disk, the matching
 * bare `<name>.<kind>` file. Keeps the generator pure — the filesystem probe
 * is decided once by the engine and handed in via the callback.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class BarrelGenerator {
  /** Build one barrel per non-empty directory under `src/`. */
  generate(opts: BarrelInput): EmittedFile[] {
    const has = opts.hasExtension ?? (() => false);
    const files: EmittedFile[] = [];

    if (opts.models.length > 0) {
      files.push(
        this.buildBarrel('models', opts.models, 'model', 'base.model', has),
      );
    }
    if (opts.repositories.length > 0) {
      files.push(
        this.buildBarrel(
          'repositories',
          opts.repositories,
          'repository',
          'base.repository',
          has,
        ),
      );
    }
    if (opts.controllers.length > 0) {
      files.push(
        this.buildBarrel(
          'controllers',
          opts.controllers,
          'controller',
          'base.controller',
          has,
        ),
      );
    }
    if (opts.datasources.length > 0) {
      files.push(
        this.buildBarrel(
          'datasources',
          opts.datasources,
          'datasource',
          'base.datasource',
          has,
        ),
      );
    }
    return files;
  }

  private buildBarrel(
    dir: 'models' | 'repositories' | 'controllers' | 'datasources',
    names: readonly string[],
    kind: 'model' | 'repository' | 'controller' | 'datasource',
    baseSuffix: string,
    hasExtension: (
      name: string,
      kind: 'model' | 'repository' | 'controller' | 'datasource',
    ) => boolean,
  ): EmittedFile {
    const lines: string[] = [];
    const sorted = [...new Set(names.map(toKebab))].sort();
    for (const kebab of sorted) {
      lines.push(`export * from './${kebab}.${baseSuffix}';`);
      if (hasExtension(kebab, kind)) {
        lines.push(`export * from './${kebab}.${kind}';`);
      }
    }
    const path = posix.join(dir, 'index.ts');
    assertNoTraversal(path, PRODUCER);
    return {
      path,
      content: lines.join('\n') + '\n',
      policy: 'regen',
      producer: PRODUCER,
    };
  }
}
