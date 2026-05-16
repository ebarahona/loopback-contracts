import {injectable} from '@loopback/core';
import {isAbsolute, resolve} from 'node:path';
import {ContractsValidationError} from '../helpers';
import type {ProjectPaths} from '../interfaces';
import type {LoopbackConfigJson} from '../types';

/**
 * Default {@link ProjectPaths} implementation. Resolves every directory to an
 * absolute path against the supplied project root so downstream emitters never
 * have to worry about the current working directory.
 *
 * Config defaults mirror `lb4 init`: `schemasDir` falls back to `./schemas`
 * and `configsDir` falls back to `./configs`.
 *
 * @internal
 */
@injectable()
export class DefaultProjectPaths implements ProjectPaths {
  readonly root: string;
  readonly outputDir: string;
  readonly schemasDir: string;
  readonly configsDir: string;

  constructor(root: string, config: LoopbackConfigJson) {
    if (!isAbsolute(root)) {
      throw new ContractsValidationError(
        `DefaultProjectPaths requires an absolute project root; got '${root}'`,
        {sourcePath: root, instancePath: '/projectRoot'},
      );
    }
    this.root = resolve(root);
    this.outputDir = resolve(this.root, 'src');
    this.schemasDir = resolve(this.root, config.schemasDir ?? './schemas');
    this.configsDir = resolve(this.root, config.configsDir ?? './configs');
  }

  /** Directory for engine-emitted metadata (run report, lossy log, lockfile). */
  get metaDir(): string {
    return resolve(this.root, '_meta');
  }

  /** Cache directory for fetched remote schemas and compiled meta-schemas. */
  get cacheDir(): string {
    return resolve(this.root, '.loopback', 'cache');
  }

  /** Absolute path to the project's `loopback.config.json`. */
  get loopbackConfigPath(): string {
    return resolve(this.root, 'loopback.config.json');
  }

  /** Absolute path to the project's `datasources.json`. */
  get datasourcesPath(): string {
    return resolve(this.root, 'datasources.json');
  }
}
