import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {ContractsCodegenError} from './errors';

/**
 * Identifier-casing utilities shared by the engine-internal generators.
 *
 * Centralised so every generator agrees on how `customer.v1` becomes
 * `Customer` / `customer` / `customer-v1` and `lb-contracts override` stays in sync
 * with `lb-contracts gen`. Also home to {@link assertNoTraversal}, the defensive
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
 * Identifier-shaped `$id`s (`customer`, `appraisal-intake`, `user.v1`) that
 * the casing helpers above already turn into valid TypeScript identifiers
 * and filesystem-safe basenames. Anything else (URLs, URNs, path-shaped
 * ids, ids starting with a digit) goes through {@link schemaNameStems}'
 * sanitising branch.
 */
const PLAIN_SCHEMA_ID = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** Path segments that carry a version rather than a name (`1.0.0`, `v2`). */
const VERSION_SEGMENT = /^v?\d+(?:[._-][0-9A-Za-z]+)*$/i;

/**
 * Report whether a schema `$id` is identifier-shaped (letters, digits, `.`,
 * `-`, `_`, starting with a letter). Plain ids keep their historical naming
 * verbatim; see {@link schemaNameStems}.
 *
 * @internal
 */
export function isPlainSchemaId(id: string): boolean {
  return PLAIN_SCHEMA_ID.test(id);
}

/**
 * How much of a plain `$id` an emitter folds into its names. Each built-in
 * emitter historically picked one; the choice is preserved so plain ids
 * produce byte-identical output.
 *
 * - `full`: the whole id (`user.v1` -\> `UserV1`, `user-v1`).
 * - `strip-version`: drop a trailing `.vN` (`user.v1` -\> `User`, `user`).
 * - `head`: keep the first dot-separated segment (`user.v1` -\> `user`).
 *
 * @internal
 */
export type SchemaStemStyle = 'full' | 'strip-version' | 'head';

/**
 * Word sources an emitter feeds to {@link toPascal} / {@link toKebab} (and
 * friends) to name the artefacts it derives from one schema.
 *
 * @internal
 */
export interface SchemaNameStems {
  /** Source for type / class / export names. */
  readonly typeStem: string;
  /** Source for file basenames and other path segments. */
  readonly fileStem: string;
}

/**
 * The fields {@link schemaNameStems} reads from a schema.
 *
 * @internal
 */
export interface NameableSchema {
  readonly $id?: unknown;
  readonly title?: unknown;
}

/**
 * Derive the naming stems for a schema from its `$id` (and `title`).
 *
 * Plain ids ({@link isPlainSchemaId}) return the styled id for both stems,
 * so existing projects see no output churn. Every other id (for example
 * `https://schemas.example.com/intake/1.0.0` or `urn:acme:intake:v2`) is
 * sanitised:
 *
 * - `typeStem` comes from `title` when it has any alphanumeric content,
 *   else from the last path segment that is not a version
 *   (`intake`). It always starts with a letter, so `toPascal(typeStem)` is
 *   a valid identifier.
 * - `fileStem` is a kebab slug of every path segment, versions included
 *   (`intake-1-0-0`), so two versions of one contract never share a file.
 *   The scheme, authority (unless the path is empty), query, fragment and
 *   `.schema.json` / `.json` suffixes are dropped; the result contains only
 *   `[a-z0-9-]`.
 *
 * When `peers` (every schema loaded for the run, `ctx.registry.list()`) is
 * given, names that would collide are disambiguated deterministically. A
 * plain id always keeps its name; a non-plain id whose name clashes with a
 * plain id or another non-plain id is qualified, and every member of a
 * clashing group is qualified, so the result does not depend on load order:
 *
 * - a clashing `fileStem` gains the authority
 *   (`https://a.example.com/x/address` -\> `a-example-com-x-address`);
 * - a clashing `typeStem` becomes the words of the final `fileStem`
 *   (`intake/1.0.0` and `intake/2.0.0`, both titled `Intake`, name
 *   `Intake100` and `Intake200`);
 * - a stem that still clashes gains the first 8 hex digits of the
 *   SHA-256 of the full `$id`.
 *
 * Every emitter that names a schema, or a `$ref` target, must pass the same
 * `peers` so imports and component refs agree with the target's own
 * output.
 *
 * @internal
 * @param schema - The schema, or any object carrying `$id` / `title`.
 * @param style - Which part of a plain id feeds the names.
 * @param fallback - Stem used when the schema has no usable `$id`.
 * @param peers - Every schema of the run; enables collision handling.
 * @returns The type and file stems.
 */
export function schemaNameStems(
  schema: NameableSchema,
  style: SchemaStemStyle,
  fallback: string,
  peers?: readonly NameableSchema[],
): SchemaNameStems {
  const id = typeof schema.$id === 'string' ? schema.$id : '';
  if (peers === undefined || id === '' || isPlainSchemaId(id)) {
    return baseStems(schema, style, fallback);
  }
  return (
    disambiguatedStems(peers, style, fallback).get(id) ??
    baseStems(schema, style, fallback)
  );
}

function baseStems(
  schema: NameableSchema,
  style: SchemaStemStyle,
  fallback: string,
): SchemaNameStems {
  const id = typeof schema.$id === 'string' ? schema.$id : '';
  if (id === '') return {typeStem: fallback, fileStem: fallback};
  if (isPlainSchemaId(id)) {
    const styled =
      style === 'strip-version'
        ? id.replace(/\.v\d+$/, '')
        : style === 'head'
          ? (id.split('.')[0] ?? id)
          : id;
    return {typeStem: styled, fileStem: styled};
  }

  const {segments} = idSegments(id);
  const fileStem = slug(segments) || fallback;
  const titleWords =
    typeof schema.title === 'string' ? sanitizeWords(schema.title) : '';
  const nameSegment =
    [...segments].reverse().find(seg => !VERSION_SEGMENT.test(seg)) ??
    segments[segments.length - 1] ??
    '';
  const words = titleWords || sanitizeWords(nameSegment);
  return {typeStem: letterLed(words, fallback), fileStem};
}

// Words usable as a type stem: `fallback` when empty, prefixed with
// `Schema` when they would start with a digit.
function letterLed(words: string, fallback: string): string {
  if (words === '') return fallback;
  return /^[A-Za-z]/.test(words) ? words : `Schema ${words}`;
}

function slug(segments: readonly string[]): string {
  return segments
    .map(seg => toKebab(seg))
    .join('-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

function shortHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 8);
}

// One memoised table per (style, fallback): the peer list of the current
// run is the same for every schema an emitter names, so the table is built
// once per emitter pass instead of once per schema. Peers are compared by
// element identity (`registry.list()` returns a fresh array per call).
const stemTables = new Map<
  string,
  {
    readonly peers: readonly NameableSchema[];
    readonly table: ReadonlyMap<string, SchemaNameStems>;
  }
>();

function disambiguatedStems(
  peers: readonly NameableSchema[],
  style: SchemaStemStyle,
  fallback: string,
): ReadonlyMap<string, SchemaNameStems> {
  const key = `${style}\u0000${fallback}`;
  const memo = stemTables.get(key);
  if (
    memo !== undefined &&
    memo.peers.length === peers.length &&
    memo.peers.every((p, i) => p === peers[i])
  ) {
    return memo.table;
  }
  const table = buildStemTable(peers, style, fallback);
  stemTables.set(key, {peers: [...peers], table});
  return table;
}

interface StemEntry {
  readonly id: string;
  fileStem: string;
  typeStem: string;
}

function buildStemTable(
  peers: readonly NameableSchema[],
  style: SchemaStemStyle,
  fallback: string,
): ReadonlyMap<string, SchemaNameStems> {
  const plainFiles = new Set<string>();
  const plainTypes = new Set<string>();
  const entries: StemEntry[] = [];
  const seen = new Set<string>();
  for (const peer of peers) {
    const id = typeof peer.$id === 'string' ? peer.$id : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const base = baseStems(peer, style, fallback);
    if (isPlainSchemaId(id)) {
      plainFiles.add(toKebab(base.fileStem));
      plainTypes.add(toPascal(base.typeStem));
      continue;
    }
    entries.push({id, fileStem: base.fileStem, typeStem: base.typeStem});
  }

  // Report whether `name(entry)` is shared with a plain id or another entry.
  const clashes = (
    name: (e: StemEntry) => string,
    reserved: ReadonlySet<string>,
  ): ((e: StemEntry) => boolean) => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      const n = name(e);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return e => reserved.has(name(e)) || (counts.get(name(e)) ?? 0) > 1;
  };

  const fileName = (e: StemEntry): string => toKebab(e.fileStem);
  let clash = clashes(fileName, plainFiles);
  for (const e of entries.filter(clash)) {
    const {host, segments} = idSegments(e.id);
    e.fileStem = slug(host === '' ? segments : [host, ...segments]) || fallback;
  }
  clash = clashes(fileName, plainFiles);
  for (const e of entries.filter(clash)) {
    e.fileStem = `${e.fileStem}-${shortHash(e.id)}`;
  }

  const typeName = (e: StemEntry): string => toPascal(e.typeStem);
  clash = clashes(typeName, plainTypes);
  for (const e of entries.filter(clash)) {
    e.typeStem = letterLed(sanitizeWords(e.fileStem), fallback);
  }
  clash = clashes(typeName, plainTypes);
  for (const e of entries.filter(clash)) {
    e.typeStem = `${e.typeStem} ${shortHash(e.id)}`;
  }

  return new Map(
    entries.map(e => [e.id, {typeStem: e.typeStem, fileStem: e.fileStem}]),
  );
}

// Split a non-plain `$id` into its meaningful segments: drop the scheme,
// the authority (returned separately as `host`, and used as the only
// segment when there is no path), query and fragment, then split on `/`,
// `\` and `:` (URN separators).
function idSegments(id: string): {host: string; segments: string[]} {
  let rest = id.replace(/[?#].*$/, '');
  rest = rest.replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, '');
  let host = '';
  const authority = /^\/\/([^/]*)/.exec(rest);
  if (authority !== null) {
    host = (authority[1] ?? '').replace(/^.*@/, '').replace(/:\d+$/, '');
    rest = rest.slice(authority[0].length);
  }
  const segments = rest
    .split(/[\\/:]+/)
    .map(seg => seg.replace(/\.schema\.json$|\.json$/i, ''))
    .filter(seg => /[A-Za-z0-9]/.test(seg));
  if (segments.length === 0 && host !== '') return {host: '', segments: [host]};
  return {host, segments};
}

// Fold accents, then replace every non-alphanumeric run with a space so
// `splitWords` sees clean word boundaries.
function sanitizeWords(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
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
