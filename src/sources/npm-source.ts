import {BindingScope, inject, injectable} from '@loopback/core';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {collectSchemaFiles, ContractsSourceError} from '../helpers';
import type {SchemaSource, SchemaSourceResult} from '../interfaces';
import {SOURCE_TAG} from '../keys';

/**
 * Built-in {@link SchemaSource} for `npm:<package>` descriptors. Resolves
 * the package from the *consumer project's* root (not the plugin's own
 * `require` context) so that hoisted and nested installs both work, then
 * globs `**\/*.schema.json` under the package's root directory.
 *
 * Returns each file as-is; bundled schemas (with `$defs`) are split by the
 * pipeline downstream.
 *
 * @internal
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[SOURCE_TAG]: SOURCE_TAG, scheme: 'npm'},
})
export class NpmSchemaSource implements SchemaSource {
  readonly scheme = 'npm';

  constructor(
    @inject('platform.contracts.project-root', {optional: true})
    private readonly projectRoot: string = process.cwd(),
  ) {}

  /**
   * Resolve the package named after the `npm:` prefix and read every
   * `*.schema.json` file under its install root.
   *
   * @throws ContractsSourceError When the URI is malformed, the package
   *   cannot be resolved from the project root, or the resolved directory
   *   cannot be read.
   */
  async fetch(uri: string): Promise<SchemaSourceResult> {
    const pkg = parseNpmUri(uri, this.scheme);
    const pkgRoot = resolvePackageRoot(pkg, this.projectRoot, uri, this.scheme);
    const files = await collectSchemaFiles(pkgRoot);
    const results = await Promise.all(
      files.map(async absPath => {
        const content = await readFile(absPath, 'utf8');
        return {source: uri, path: absPath, content};
      }),
    );
    return results;
  }
}

/**
 * Pull `<package>` out of an `npm:<package>` descriptor. Accepts scoped
 * (`@scope/name`) and bare (`name`) package identifiers.
 */
function parseNpmUri(uri: string, scheme: string): string {
  const m = /^npm:(.+)$/i.exec(uri.trim());
  const name = m?.[1]?.trim();
  if (!name) {
    throw new ContractsSourceError(
      `Malformed npm source URI '${uri}'; expected 'npm:<package>'`,
      {scheme, uri},
    );
  }
  return name;
}

/**
 * Single-entry memo of `createRequire(projectRoot)`. In practice only one
 * project root is active per engine instance, but the map shape lets us
 * survive a hypothetical future where the descriptor list is processed
 * across multiple roots without paying the `createRequire` cost on every
 * `npm:` lookup.
 */
const requireCache = new Map<string, NodeRequire>();

function requireFor(projectRoot: string): NodeRequire {
  const key = resolve(projectRoot, 'package.json');
  const cached = requireCache.get(key);
  if (cached !== undefined) return cached;
  const req = createRequire(key);
  requireCache.set(key, req);
  return req;
}

/**
 * Resolve the package's install root by walking `require.resolve` from the
 * consumer project. We resolve `<pkg>/package.json` (always present) rather
 * than `<pkg>` itself because the latter relies on the package's `main`
 * field and fails for type-only or schema-only packages.
 */
function resolvePackageRoot(
  pkg: string,
  projectRoot: string,
  uri: string,
  scheme: string,
): string {
  const req = requireFor(projectRoot);
  try {
    const pkgJsonPath = req.resolve(`${pkg}/package.json`);
    return dirname(pkgJsonPath);
  } catch (cause) {
    throw new ContractsSourceError(
      `npm package '${pkg}' is not installed in project '${projectRoot}'; ` +
        `run \`npm install ${pkg}\``,
      {scheme, uri},
      {cause},
    );
  }
}
