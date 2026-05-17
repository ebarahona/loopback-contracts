import {isAbsolute} from 'node:path';
import {ContractsCodegenError} from './errors';

/**
 * Identifier-casing utilities shared by the engine-internal generators.
 *
 * Centralised so every generator agrees on how `customer.v1` becomes
 * `Customer` / `customer` / `customer-v1` and `lb4 override` stays in sync
 * with `lb4 gen`. Also home to {@link assertNoTraversal}, the defensive
 * guard every generator runs against the relative `EmittedFile.path` it
 * builds from schema-derived names.
 *
 * @internal
 */

/**
 * Split an arbitrary identifier-shaped string into lower-case word tokens.
 * Accepts camelCase, PascalCase, kebab-case, snake_case, and `.`-separated
 * input.
 *
 * @internal
 */
export function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

/**
 * Convert any identifier-shaped string to PascalCase.
 *
 * @internal
 */
export function toPascal(s: string): string {
  return splitWords(s)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/**
 * Convert any identifier-shaped string to kebab-case.
 *
 * @internal
 */
export function toKebab(s: string): string {
  return splitWords(s).join('-');
}

/**
 * Convert any identifier-shaped string to camelCase.
 *
 * @internal
 */
export function toCamel(s: string): string {
  const parts = splitWords(s);
  if (parts.length === 0) return '';
  return [
    parts[0],
    ...parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)),
  ].join('');
}

/**
 * Convert any identifier-shaped string to snake_case.
 *
 * @internal
 */
export function toSnake(s: string): string {
  return splitWords(s).join('_');
}

/**
 * Read the `idProperty` declared on a model config. Defaults to `'id'` when
 * the config omits `model.idProperty` or supplies a non-string value.
 *
 * Accepts a structural shape rather than the full {@link ModelConfigJson}
 * to keep the helpers layer free of upward imports from the public
 * {@link ModelConfigJson} type.
 *
 * @internal
 */
export function resolveIdProperty(config: {
  readonly model?: {readonly [k: string]: unknown} | undefined;
}): string {
  const model = config.model;
  if (model && typeof model['idProperty'] === 'string') {
    return model['idProperty'];
  }
  return 'id';
}

/**
 * Reject obviously-unsafe relative paths before the engine hands them to
 * its {@link EmittedFile} pipeline.
 *
 * Generators build `EmittedFile.path` from schema-derived names; while
 * {@link splitWords} collapses `.` separators inside identifiers (so
 * `customer.v1` cannot smuggle a `..` segment through), a defensive guard
 * still rejects absolute paths, Windows drive-letter prefixes, and any
 * `..` traversal segment that survived a future code change.
 *
 * @param relPath - Relative path the generator is about to attach to its
 *   emitted file descriptor.
 * @param emitterKind - Label written into the thrown
 *   {@link ContractsCodegenError} so the engine's reporter can name the
 *   offending generator.
 * @throws `ContractsCodegenError` When the path escapes the project root.
 * @internal
 */
export function assertNoTraversal(relPath: string, emitterKind: string): void {
  if (isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath)) {
    throw new ContractsCodegenError(
      `Generator '${emitterKind}' produced an absolute output path '${relPath}'`,
      {emitterKind, schemaId: '', outputPath: relPath},
    );
  }
  const segments = relPath.split(/[\\/]+/);
  for (const seg of segments) {
    if (seg === '..') {
      throw new ContractsCodegenError(
        `Generator '${emitterKind}' produced a path with a '..' traversal segment ('${relPath}')`,
        {emitterKind, schemaId: '', outputPath: relPath},
      );
    }
  }
}
