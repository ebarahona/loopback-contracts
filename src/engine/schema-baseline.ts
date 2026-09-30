import {createHash, randomBytes} from 'node:crypto';
import {open, readFile, rename, unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import createDebug from 'debug';

import {ContractsCodegenError, ContractsPipelineError} from '../helpers';
import type {JSONSchema} from '../interfaces';

const debug = createDebug('loopback:contracts:baseline');

/**
 * File name of the committed schema baseline, relative to the project
 * root. Holds the last accepted form of every loaded schema; stage 6
 * compares each run against it.
 *
 * @internal
 */
export const BASELINE_FILENAME = 'contracts.lock.json';

/**
 * On-disk shape of {@link BASELINE_FILENAME}.
 *
 * @internal
 */
export interface SchemaBaseline {
  readonly version: 1;
  /**
   * Last accepted schema per `$id`, keys sorted, schema keys sorted. Holds
   * local-source schemas, plus remote ones when `baseline.includeRemote`
   * is set.
   */
  readonly schemas: Readonly<Record<string, JSONSchema>>;
  /**
   * `sha256-<hex>` digest of the canonical JSON of every accepted schema
   * whose body is not stored: remote (`npm:`, `git+`, `https:`, plugin)
   * sources unless `baseline.includeRemote` is set. Omitted when empty.
   */
  readonly digests?: Readonly<Record<string, string>>;
}

/**
 * A baseline read from disk together with its raw text, which
 * {@link writeBaseline} uses to detect a concurrent modification.
 *
 * @internal
 */
export interface LoadedBaseline {
  readonly baseline: SchemaBaseline;
  readonly raw: string;
}

/**
 * Stage-6 classification verdict.
 *
 * @internal
 */
export type SchemaChange = 'unchanged' | 'additive' | 'breaking';

/**
 * Absolute path of the baseline file for a project.
 *
 * @internal
 */
export function baselinePath(projectRoot: string): string {
  return resolve(projectRoot, BASELINE_FILENAME);
}

/**
 * `sha256-<hex>` digest of a schema's canonical JSON, the form stage 6
 * records for a schema whose body the baseline does not store.
 *
 * @internal
 */
export function schemaDigest(schema: unknown): string {
  return `sha256-${createHash('sha256')
    .update(canonicalJsonStringify(schema))
    .digest('hex')}`;
}

/**
 * Look up an own entry of a baseline map. Never walks the prototype chain,
 * so a `$id` such as `constructor` or `__proto__` is an ordinary key.
 *
 * @internal
 */
export function ownEntry<T>(
  map: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * Read the project's baseline. A missing file is an empty baseline (every
 * schema is new). A file that cannot be read, is not valid JSON, or is not
 * a version-1 baseline fails the run: the file is committed, so silently
 * treating it as empty would disable the gate.
 *
 * @internal
 * @throws ContractsPipelineError When the file exists but is unreadable.
 */
export async function loadBaseline(
  projectRoot: string,
): Promise<LoadedBaseline | undefined> {
  const raw = await readBaselineText(baselinePath(projectRoot));
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ContractsPipelineError(
      `stage 6: ${BASELINE_FILENAME} is not valid JSON ` +
        `(${(err as Error).message}); restore it from version control or ` +
        `delete it to re-establish the baseline`,
      {stage: 'backward-compat-diff'},
    );
  }
  const rec = parsed as {
    version?: unknown;
    schemas?: unknown;
    digests?: unknown;
  } | null;
  if (
    rec === null ||
    typeof rec !== 'object' ||
    rec.version !== 1 ||
    !isRecord(rec.schemas) ||
    (rec.digests !== undefined &&
      (!isRecord(rec.digests) ||
        Object.values(rec.digests).some(d => typeof d !== 'string')))
  ) {
    throw new ContractsPipelineError(
      `stage 6: ${BASELINE_FILENAME} is not a version-1 baseline ` +
        `({"version": 1, "schemas": {...}, "digests"?: {...}}); restore it ` +
        `from version control or delete it to re-establish the baseline`,
      {stage: 'backward-compat-diff'},
    );
  }
  const baseline: SchemaBaseline = {
    version: 1,
    schemas: nullProto(rec.schemas as Record<string, JSONSchema>),
    ...(rec.digests !== undefined
      ? {digests: nullProto(rec.digests as Record<string, string>)}
      : {}),
  };
  return {baseline, raw};
}

/**
 * Serialise a baseline deterministically: `$id`s sorted, every object's
 * keys sorted, two-space indent, trailing newline, `digests` omitted when
 * empty. Byte-stable across runs so the committed file only changes when a
 * schema does.
 *
 * @internal
 */
export function serialiseBaseline(baseline: SchemaBaseline): string {
  const {digests, ...rest} = baseline;
  const out =
    digests !== undefined && Object.keys(digests).length > 0
      ? {...rest, digests}
      : rest;
  return `${JSON.stringify(sortKeysDeep(out), null, 2)}\n`;
}

/**
 * Write the baseline atomically (tmp file, `fsync`, `rename`) when its
 * content differs from what is on disk. Returns whether it wrote.
 *
 * The baseline has a single writer: `lb-contracts gen`. When the file on
 * disk no longer matches `expected` (the text stage 6 read, `undefined`
 * when there was no file), another run changed it in between (a watch
 * session plus a manual `gen`, say) and the write is refused rather than
 * silently discarding that run's accepted changes.
 *
 * @internal
 * @throws ContractsPipelineError When the file changed since it was read,
 *   or cannot be read or written.
 */
export async function writeBaseline(
  projectRoot: string,
  baseline: SchemaBaseline,
  expected: string | undefined,
): Promise<boolean> {
  const path = baselinePath(projectRoot);
  const json = serialiseBaseline(baseline);
  const current = await readBaselineText(path);
  if (current === json) return false;
  if (current !== expected) {
    throw new ContractsPipelineError(
      `stage 6: ${BASELINE_FILENAME} changed on disk during this run ` +
        `(another \`lb-contracts gen\` running?); it was not overwritten. ` +
        `Run one \`gen\` at a time and re-run it`,
      {stage: 'backward-compat-diff'},
    );
  }
  const tmpPath = `${path}.tmp.${randomBytes(6).toString('hex')}`;
  try {
    const handle = await open(tmpPath, 'w');
    try {
      await handle.writeFile(json);
      try {
        await handle.sync();
      } catch (err) {
        debug('fsync unsupported on %s: %s', tmpPath, (err as Error).message);
      }
    } finally {
      await handle.close();
    }
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw new ContractsPipelineError(
      `stage 6: failed to write ${BASELINE_FILENAME}: ${(err as Error).message}`,
      {stage: 'backward-compat-diff'},
      {cause: err},
    );
  }
  return true;
}

// Read the baseline file; `undefined` when it does not exist. Any other
// failure (EACCES, EISDIR, ...) becomes a typed pipeline error.
async function readBaselineText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ContractsPipelineError(
      `stage 6: cannot read ${BASELINE_FILENAME}: ${(err as Error).message}`,
      {stage: 'backward-compat-diff'},
      {cause: err},
    );
  }
}

// Copy into a prototype-less object so lookups never hit
// `Object.prototype` members.
function nullProto<T>(rec: Readonly<Record<string, T>>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, rec);
}

/**
 * Stable, key-sorted JSON serialisation. Throws on object-identity cycles
 * because cyclic schemas have no canonical encoding; JSON Schema documents
 * must be acyclic (`$ref` cycles are pointers, not object cycles).
 *
 * @internal
 * @throws ContractsCodegenError When `value` contains an object cycle.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  const stack = new Set<object>();
  const visit = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (stack.has(v)) {
      throw new ContractsCodegenError(
        'canonicalJsonStringify: refusing to serialise object cycle; ' +
          'JSON Schema documents must be acyclic by object identity',
        {emitterKind: 'pipeline', schemaId: '<canonical-json>'},
      );
    }
    stack.add(v);
    const out = Array.isArray(v)
      ? v.map(visit)
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, visit((v as Record<string, unknown>)[k])]),
        );
    stack.delete(v);
    return out;
  };
  return visit(value);
}

/**
 * Keywords that never affect which instances validate. Changes to them
 * are ignored by {@link classifySchemaChange}.
 */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$comment',
  '$anchor',
  'title',
  'description',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/** Numeric bounds: `true` when raising the value tightens the bound. */
const BOUND_KEYWORDS: ReadonlyMap<string, boolean> = new Map([
  ['minLength', true],
  ['maxLength', false],
  ['minimum', true],
  ['maximum', false],
  ['exclusiveMinimum', true],
  ['exclusiveMaximum', false],
  ['minItems', true],
  ['maxItems', false],
  ['minProperties', true],
  ['maxProperties', false],
  ['minContains', true],
  ['maxContains', false],
]);

/** Keywords the classifier recurses into or compares structurally. */
const STRUCTURED_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  '$defs',
]);

const RANK: Readonly<Record<SchemaChange, number>> = {
  unchanged: 0,
  additive: 1,
  breaking: 2,
};

function worst(a: SchemaChange, b: SchemaChange): SchemaChange {
  return RANK[b] > RANK[a] ? b : a;
}

/**
 * Classify the change from `prev` to `next`, the last accepted and the
 * current form of one schema:
 *
 * - `unchanged`: identical, or only annotations (`title`, `description`,
 *   `examples`, `x-*`, ...) differ.
 * - `additive`: the change only widens what validates: a new optional
 *   property, a new `$defs` entry, a required property made optional, an
 *   enum value added, a bound loosened or removed, a type added.
 * - `breaking`: a property removed, a property newly required, an enum
 *   value removed or an enum added, a type removed or changed, a bound
 *   added or tightened, `pattern` / `format` / `multipleOf` added or
 *   changed, `additionalProperties` closed, a `$defs` entry removed, or any
 *   change inside keywords the classifier does not model (`oneOf`,
 *   `anyOf`, `allOf`, `not`, `$ref`, `if`/`then`/`else`, `prefixItems`,
 *   `patternProperties`, ...).
 *
 * "Existing payloads" means payloads that carry only the properties the
 * previous schema declares: a new optional property is `additive` even on
 * an open object, whose old form accepted any value under that name.
 *
 * Properties, `items`, `additionalProperties` and `$defs` are compared
 * recursively, so a tightened `maxLength` on a nested property is caught
 * at its own level. The comparison is syntactic: semantically equivalent
 * rewrites (`a|b` vs `b|a`, `oneOf` vs `if`/`then`) count as breaking.
 * Override a false positive with `--allow-breaking` or
 * `migration-strategy.<schemaId>.mode = 'allow'`.
 *
 * @internal
 */
export function classifySchemaChange(
  prev: unknown,
  next: unknown,
): SchemaChange {
  if (canonicalJsonStringify(prev) === canonicalJsonStringify(next)) {
    return 'unchanged';
  }
  // Boolean schemas: `true` accepts everything, `false` nothing.
  if (typeof prev === 'boolean' || typeof next === 'boolean') {
    if (next === true) return 'additive';
    if (prev === false) return 'additive';
    if (isEmptySchema(next)) return 'additive';
    return 'breaking';
  }
  if (!isRecord(prev) || !isRecord(next)) return 'breaking';

  let verdict: SchemaChange = 'unchanged';

  verdict = worst(verdict, compareTypes(prev['type'], next['type']));
  verdict = worst(verdict, compareEnums(prev, next));

  for (const k of ['pattern', 'format', 'multipleOf']) {
    if (!Object.hasOwn(next, k)) {
      if (Object.hasOwn(prev, k)) verdict = worst(verdict, 'additive');
      continue;
    }
    if (canonicalJsonStringify(prev[k]) !== canonicalJsonStringify(next[k])) {
      return 'breaking';
    }
  }

  for (const [k, raising] of BOUND_KEYWORDS) {
    const a = prev[k];
    const b = next[k];
    if (a === b) continue;
    if (typeof b !== 'number') {
      verdict = worst(verdict, 'additive'); // bound removed
      continue;
    }
    if (typeof a !== 'number') return 'breaking'; // bound added
    const tighter = raising ? b > a : b < a;
    if (tighter) return 'breaking';
    verdict = worst(verdict, 'additive');
  }

  // required: any newly-required name breaks existing payloads.
  const prevRequired = new Set(asStrings(prev['required']));
  const nextRequired = asStrings(next['required']);
  for (const k of nextRequired) {
    if (!prevRequired.has(k)) return 'breaking';
  }
  if (nextRequired.length < prevRequired.size) {
    verdict = worst(verdict, 'additive');
  }

  verdict = worst(
    verdict,
    compareSchemaMap(prev['properties'], next['properties']),
  );
  verdict = worst(verdict, compareSchemaMap(prev['$defs'], next['$defs']));
  verdict = worst(
    verdict,
    compareAdditionalProperties(
      prev['additionalProperties'],
      next['additionalProperties'],
    ),
  );
  verdict = worst(verdict, compareItems(prev['items'], next['items']));
  if (verdict === 'breaking') return verdict;

  // Every other keyword is compared verbatim: any change is breaking.
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const k of keys) {
    if (
      ANNOTATION_KEYWORDS.has(k) ||
      k.startsWith('x-') ||
      STRUCTURED_KEYWORDS.has(k) ||
      BOUND_KEYWORDS.has(k) ||
      k === 'pattern' ||
      k === 'format' ||
      k === 'multipleOf'
    ) {
      continue;
    }
    if (
      canonicalJsonStringify(ownEntry(prev, k)) !==
      canonicalJsonStringify(ownEntry(next, k))
    ) {
      return 'breaking';
    }
  }
  return verdict;
}

function compareTypes(prev: unknown, next: unknown): SchemaChange {
  if (canonicalJsonStringify(prev) === canonicalJsonStringify(next)) {
    return 'unchanged';
  }
  if (next === undefined) return 'additive'; // type constraint removed
  if (prev === undefined) return 'breaking'; // type constraint added
  const nextTypes = new Set(asStrings(next));
  for (const t of asStrings(prev)) {
    const covered =
      nextTypes.has(t) || (t === 'integer' && nextTypes.has('number'));
    if (!covered) return 'breaking';
  }
  return 'additive';
}

function compareEnums(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): SchemaChange {
  const prevValues = enumValues(prev);
  const nextValues = enumValues(next);
  if (prevValues === undefined && nextValues === undefined) return 'unchanged';
  if (nextValues === undefined) return 'additive'; // enum dropped
  if (prevValues === undefined) return 'breaking'; // enum added
  const nextSet = new Set(nextValues.map(v => canonicalJsonStringify(v)));
  const prevSet = new Set(prevValues.map(v => canonicalJsonStringify(v)));
  for (const v of prevSet) if (!nextSet.has(v)) return 'breaking';
  return nextSet.size > prevSet.size ? 'additive' : 'unchanged';
}

function enumValues(schema: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(schema['enum'])) return schema['enum'] as unknown[];
  if (Object.hasOwn(schema, 'const')) return [schema['const']];
  return undefined;
}

function compareSchemaMap(prev: unknown, next: unknown): SchemaChange {
  const a = isRecord(prev) ? prev : {};
  const b = isRecord(next) ? next : {};
  let verdict: SchemaChange = 'unchanged';
  for (const k of Object.keys(a)) {
    if (!Object.hasOwn(b, k)) return 'breaking';
    verdict = worst(verdict, classifySchemaChange(a[k], b[k]));
    if (verdict === 'breaking') return verdict;
  }
  for (const k of Object.keys(b)) {
    if (!Object.hasOwn(a, k)) verdict = worst(verdict, 'additive');
  }
  return verdict;
}

function compareAdditionalProperties(
  prev: unknown,
  next: unknown,
): SchemaChange {
  const a = prev === undefined ? true : prev;
  const b = next === undefined ? true : next;
  return classifySchemaChange(a, b);
}

function compareItems(prev: unknown, next: unknown): SchemaChange {
  if (Array.isArray(prev) || Array.isArray(next)) {
    return canonicalJsonStringify(prev) === canonicalJsonStringify(next)
      ? 'unchanged'
      : 'breaking';
  }
  const a = prev === undefined ? true : prev;
  const b = next === undefined ? true : next;
  return classifySchemaChange(a, b);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isEmptySchema(v: unknown): boolean {
  return isRecord(v) && Object.keys(v).length === 0;
}

function asStrings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v))
    return v.filter((x): x is string => typeof x === 'string');
  return [];
}
