import type {JSONSchema, SchemaRegistry} from '../interfaces';

/**
 * A `$ref` resolved to the registered document that owns its target.
 *
 * @internal
 */
export interface ResolvedSchemaRef {
  /** The registered document (or the base document for local refs). */
  readonly document: JSONSchema;
  /** The document's `$id`; `''` when the base document has none. */
  readonly id: string;
  /**
   * JSON Pointer (RFC 6901, still escaped) into `document`; `''` when the
   * ref targets the whole document.
   */
  readonly pointer: string;
}

/**
 * Synthetic base URI that non-URL `$id`s (`money`, `appraisal-intake`,
 * `customer.v1`) are resolved against, so RFC 3986 reference resolution
 * also works for plain ids: `money` against `appraisal-intake` resolves to
 * `lb-contracts:///money`, and the prefix is stripped again to yield the
 * registry key `money`. The prefix never reaches emitted names or files.
 */
const PLAIN_ID_BASE = 'lb-contracts:///';

/**
 * Resolve a URI reference (a `$ref` or a nested `$id`) against the `$id`
 * in scope, per RFC 3986 §5. Absolute URL bases resolve as usual; plain
 * (non-URL) bases resolve against a synthetic base, so the result for a
 * plain-id schema is again a plain id (`money#/$defs/amount`).
 *
 * @internal
 * @param reference - The reference to resolve; any fragment is kept.
 * @param baseId - The `$id` in scope; `''` when the document has none.
 * @returns The resolved reference, or `undefined` when it is not a valid
 *   URI reference.
 */
export function resolveIdReference(
  reference: string,
  baseId: string,
): string | undefined {
  let base = baseId;
  try {
    new URL(baseId);
  } catch {
    base = PLAIN_ID_BASE + baseId;
  }
  let resolved: string;
  try {
    resolved = new URL(reference, base).href;
  } catch {
    return undefined;
  }
  return resolved.startsWith(PLAIN_ID_BASE)
    ? resolved.slice(PLAIN_ID_BASE.length)
    : resolved;
}

/**
 * Resolve a `$ref` to the registry key of the document that owns its
 * target, plus the fragment. Shared by pipeline stage 4 and the emitters so
 * both agree on what a ref points at.
 *
 * - `#...` refs are local to `baseId`.
 * - Otherwise the id part is looked up in the registry verbatim (plain ids
 *   such as `money` or `customer.v1`), then resolved against `baseId` per
 *   RFC 3986 via {@link resolveIdReference} (absolute URLs, refs relative
 *   to a URL `$id` such as `../address/1.0.0`, and refs relative to a plain
 *   `$id`).
 *
 * Precedence: the verbatim registry lookup wins. A relative ref such as
 * `address` inside `https://x.example.com/a/b` therefore resolves to a
 * loaded plain-id schema named `address` when one exists, and only
 * otherwise to the RFC 3986 target `https://x.example.com/a/address`. This
 * keeps plain-id projects working unchanged; a URL-id project that also
 * loads a plain id of the same name should write the ref as an absolute
 * URL.
 *
 * @internal
 * @param ref - The `$ref` value.
 * @param baseId - The `$id` in scope where the ref appears.
 * @param registry - Every schema loaded for the run.
 * @returns The owning id (`baseId` for same-document refs) and the raw
 *   fragment (`''` when absent), or `undefined` when no loaded schema
 *   matches.
 */
export function resolveRefTarget(
  ref: string,
  baseId: string,
  registry: Pick<SchemaRegistry, 'has'>,
): {readonly id: string; readonly fragment: string} | undefined {
  const hashAt = ref.indexOf('#');
  const idPart = hashAt === -1 ? ref : ref.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : ref.slice(hashAt + 1);
  if (idPart === '') return {id: baseId, fragment};
  if (registry.has(idPart)) return {id: idPart, fragment};

  const resolved = resolveIdReference(idPart, baseId);
  if (resolved === undefined) return undefined;
  const id = resolved.replace(/#.*$/, '');
  if (id === baseId || registry.has(id)) return {id, fragment};
  return undefined;
}

/**
 * Resolve a `$ref` the way pipeline stage 4 validates it, so emitters agree
 * with the engine on what a ref points at. See {@link resolveRefTarget}.
 *
 * The pointer is not walked here; use {@link resolveJsonPointer}.
 *
 * @internal
 * @param ref - The `$ref` value.
 * @param base - The document the ref appears in.
 * @param registry - Every schema loaded for the run.
 * @returns The owning document and pointer, or `undefined` when no loaded
 *   schema matches.
 */
export function resolveSchemaRef(
  ref: string,
  base: JSONSchema,
  registry: SchemaRegistry,
): ResolvedSchemaRef | undefined {
  const baseId = typeof base.$id === 'string' ? base.$id : '';
  const hit = resolveRefTarget(ref, baseId, registry);
  if (hit === undefined) return undefined;
  const document = hit.id === baseId ? base : registry.get(hit.id);
  if (document === undefined) return undefined;
  return {document, id: hit.id, pointer: hit.fragment};
}

/**
 * Walk an RFC 6901 JSON Pointer (`/$defs/tag`, optionally percent-encoded as
 * it appears in a URI fragment) through a document.
 *
 * @internal
 * @param document - The document to walk.
 * @param pointer - The pointer; `''` returns the root.
 * @returns The target value (any JSON value, including boolean schemas), or
 *   `undefined` when the pointer is not `/`-prefixed or a segment is
 *   missing.
 */
export function walkJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let cur: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      segment = raw;
    }
    segment = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!Object.prototype.hasOwnProperty.call(cur, segment)) return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/**
 * Walk an RFC 6901 JSON Pointer through a schema document and return the
 * target when it is an object schema.
 *
 * @internal
 * @param document - The document to walk.
 * @param pointer - The pointer; `''` returns the root.
 * @returns The target subschema, or `undefined` when a segment is missing
 *   or the target is not an object.
 */
export function resolveJsonPointer(
  document: JSONSchema,
  pointer: string,
): JSONSchema | undefined {
  const cur = walkJsonPointer(document, pointer);
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
    return undefined;
  }
  return cur as JSONSchema;
}
