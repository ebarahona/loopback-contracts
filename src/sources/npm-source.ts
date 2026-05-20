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
    const extracted = parseNpmUri(uri, this.scheme);
    const pkg = parseNpmPackageName(extracted);
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
 * Maximum allowed npm package name length. The public npm registry rejects
 * new packages whose names exceed 214 characters (scope and slash included);
 * we mirror that ceiling so an unresolvable descriptor never reaches the
 * `require.resolve` call below.
 */
const NPM_NAME_MAX_LENGTH = 214;

/** Unscoped name body: lowercase letter/digit/underscore start, then `[a-z0-9._-]`. */
const UNSCOPED_NAME_RE = /^[a-z0-9_][a-z0-9._-]*$/;

/** Scope body (no leading `.` or `_`): `[a-z0-9]` start, then `[a-z0-9._-]`. */
const SCOPE_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Validate a raw npm package identifier against the npm registry's
 * package-name grammar (lowercase only, no path traversal, no URL chars, no
 * whitespace, length-bound). Returns the input unchanged when valid; throws
 * {@link ContractsSourceError} otherwise.
 *
 * Pure: no I/O, no side effects. Exported for direct unit testing.
 *
 * Hardening note: the npm registry tolerates a handful of legacy uppercase
 * package names; we reject uppercase outright. Authors of legacy packages
 * must publish a lowercase alias before they can be consumed via `npm:`.
 *
 * @internal
 */
export function parseNpmPackageName(raw: string): string {
  const scheme = 'npm';
  const reject = (rule: string): never => {
    throw new ContractsSourceError(
      `Invalid npm package name '${raw}': ${rule}`,
      {scheme, uri: `npm:${raw}`},
    );
  };

  if (typeof raw !== 'string') {
    return reject('expected a string descriptor');
  }
  // Whitespace anywhere in a package name is illegal per the npm grammar;
  // catching it here also rejects the `npm: ` (whitespace-only) descriptor.
  if (/\s/.test(raw)) {
    return reject('whitespace is not allowed');
  }
  if (raw.length === 0) {
    return reject('name is empty');
  }
  if (raw.length > NPM_NAME_MAX_LENGTH) {
    return reject(`exceeds ${NPM_NAME_MAX_LENGTH}-character limit`);
  }
  // Path traversal segments and backslashes never appear in legitimate
  // package names; block them before the grammar check so the error message
  // names the actual problem rather than a vague regex miss.
  if (raw.includes('..')) {
    return reject("contains path-traversal sequence '..'");
  }
  if (raw.includes('\\')) {
    return reject('contains backslash');
  }
  // URL-ish characters: `:` (scheme separator), `?` (query), `#` (fragment).
  if (raw.includes(':') || raw.includes('?') || raw.includes('#')) {
    return reject("contains URL character (':', '?', or '#')");
  }

  if (raw.startsWith('@')) {
    // Scoped form: `@scope/name`. Exactly one `/`, with non-empty halves.
    const slash = raw.indexOf('/');
    if (slash === -1) {
      return reject("scoped name missing '/' separator");
    }
    if (raw.indexOf('/', slash + 1) !== -1) {
      return reject("contains more than one '/'");
    }
    const scope = raw.slice(1, slash);
    const name = raw.slice(slash + 1);
    if (scope.length === 0) {
      return reject('scope is empty');
    }
    if (name.length === 0) {
      return reject('name after scope is empty');
    }
    if (!SCOPE_RE.test(scope)) {
      return reject(
        "scope must match /^[a-z0-9][a-z0-9._-]*$/ (lowercase, no leading '.' or '_')",
      );
    }
    if (!UNSCOPED_NAME_RE.test(name)) {
      return reject(
        'name after scope must match /^[a-z0-9_][a-z0-9._-]*$/ (lowercase only)',
      );
    }
    return raw;
  }

  // Unscoped form: a leading `/` is path-traversal/absolute-path bait.
  if (raw.startsWith('/')) {
    return reject("starts with '/'");
  }
  if (raw.includes('/')) {
    return reject("unscoped name may not contain '/'");
  }
  if (raw.startsWith('.')) {
    return reject("unscoped name may not start with '.'");
  }
  if (!UNSCOPED_NAME_RE.test(raw)) {
    return reject('must match /^[a-z0-9_][a-z0-9._-]*$/ (lowercase only)');
  }
  return raw;
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
