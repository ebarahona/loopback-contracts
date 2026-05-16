import {ContractsCodegenError} from '../helpers';
import type {ImportMap, JSONSchema, SchemaRegistry} from '../interfaces';
import type {LossyReporter} from '../types';

/**
 * Options accepted by {@link jsonSchemaToTsType}.
 *
 * @internal
 */
export interface JsonSchemaToTsTypeOptions {
  /** Append ` | null` to the produced type literal. */
  nullable?: boolean;
  /** Schema `$id` the fragment belongs to (used for lossy-report sourcing). */
  schemaId?: string;
  /** JSON Pointer-style path into the owning schema (for lossy reports). */
  propertyPath?: string;
  /**
   * Resolver invoked when the fragment is an external (non-`#`) `$ref`. The
   * resolver returns the PascalCase class name of the referenced model —
   * generators wire this from the in-memory registry + import map so the
   * utility stays IO-free.
   */
  resolveRef?: (ref: string) => string | undefined;
  /**
   * The owning schema document, used to resolve internal pointers of the
   * form `#/$defs/<name>`. Optional — when absent (and the fragment
   * contains internal refs) the utility degrades to `unknown` and reports
   * the gap through {@link lossy}.
   */
  owningSchema?: JSONSchema;
  /** Optional sink for lossy-translation reports. */
  lossy?: LossyReporter;
}

/**
 * Translate a JSON Schema 2020-12 fragment to a TypeScript type expression.
 *
 * Mechanical-only. Anything the LB4 `@property()` decorator can carry (formats,
 * regex patterns, `multipleOf`) survives at the decorator level — the type
 * literal only encodes the structural shape.
 *
 * Unsupported constructs degrade to `unknown` and emit a `severity: 'info'`
 * lossy report so the engine's run summary lists the lossy spots without
 * failing the build.
 *
 * @internal
 * @param schema - Schema fragment to translate. Top-level `$ref`, `enum`,
 *   `const`, `oneOf`/`anyOf` unions, primitives, arrays, and objects are
 *   handled.
 * @param opts - Optional resolver + lossy sink (see {@link JsonSchemaToTsTypeOptions}).
 * @returns A TypeScript type literal (e.g., `'string'`, `'Customer'`,
 *   `'Array<string | number>'`, `'unknown'`).
 */
export function jsonSchemaToTsType(
  schema: JSONSchema,
  opts: JsonSchemaToTsTypeOptions = {},
): string {
  const base = toTsTypeBase(schema, opts, new Set());
  return opts.nullable ? `${base} | null` : base;
}

/**
 * Build a {@link JsonSchemaToTsTypeOptions.resolveRef} from a registry + the
 * caller's chosen class-name producer. Centralises the `$id`→class-name
 * mapping so the model and repository generators stay consistent.
 *
 * @internal
 */
export function buildRefResolver(
  registry: SchemaRegistry,
  _importMap: ImportMap,
  toClassName: (id: string) => string,
): (ref: string) => string | undefined {
  return (ref: string): string | undefined => {
    // Internal `#/$defs/<name>` pointers are resolved by
    // {@link jsonSchemaToTsType} against the owning schema's `$defs` table
    // and never reach the cross-schema resolver — short-circuit here so we
    // don't accidentally fall through to a registry lookup with `#/...`.
    if (ref.startsWith('#')) return undefined;
    const target = registry.get(ref);
    if (!target?.$id) return undefined;
    return toClassName(target.$id);
  };
}

/**
 * Recursive worker for {@link jsonSchemaToTsType}.
 *
 * `visited` tracks the chain of internal `$defs` refs currently being
 * resolved on the call stack, keyed by the absolute pointer
 * (`#/$defs/<name>`). A self-referential `$defs` entry (e.g.,
 * `Tree → children: Tree[]`) would otherwise recurse forever; on re-entry
 * we emit `unknown` and surface a `cyclic-$ref-flattened` lossy report.
 *
 * External `$ref`s short-circuit to a class-name lookup before any further
 * recursion happens, so they never enter `visited` — the class name itself
 * carries the cycle at the TS type level via lazy `() => Type` accessors
 * the model emits at the relation layer.
 */
function toTsTypeBase(
  schema: JSONSchema,
  opts: JsonSchemaToTsTypeOptions,
  visited: Set<string>,
): string {
  // $ref short-circuits everything else.
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    if (ref.startsWith('#')) {
      if (visited.has(ref)) {
        report(
          opts,
          'cyclic-$ref-flattened',
          `internal $ref '${ref}' cycles back to a parent in the resolution chain; emitting \`unknown\``,
        );
        return 'unknown';
      }
      const resolved = resolveInternalRef(ref, opts);
      if (resolved !== undefined) {
        const next = new Set(visited);
        next.add(ref);
        return toTsTypeBase(resolved, opts, next);
      }
      return 'unknown';
    }
    const cls = opts.resolveRef?.(ref);
    if (cls !== undefined) return cls;
    report(opts, 'unresolvable-$ref', `$ref '${ref}' did not resolve`);
    return 'unknown';
  }

  // `const` pins to a literal type.
  if ('const' in schema) {
    return tsLiteral(schema['const']);
  }

  // `enum` becomes a union of literals.
  if (Array.isArray(schema.enum)) {
    const parts = schema.enum.map(v => tsLiteral(v));
    return parts.length === 0 ? 'never' : parts.join(' | ');
  }

  // `oneOf` / `anyOf` becomes a union; `allOf` is unsupported (we cannot
  // mechanically intersect arbitrary JSON-Schema fragments).
  const oneOf = schema['oneOf'] as JSONSchema[] | undefined;
  const anyOf = schema['anyOf'] as JSONSchema[] | undefined;
  const allOf = schema['allOf'] as JSONSchema[] | undefined;
  if (oneOf && oneOf.length > 0) return unionOf(oneOf, opts, visited);
  if (anyOf && anyOf.length > 0) return unionOf(anyOf, opts, visited);
  if (allOf && allOf.length > 0) {
    report(
      opts,
      'allOf',
      'allOf is not mechanically derivable; emitting `unknown`',
    );
    return 'unknown';
  }

  // Handle OAS 3.0 `nullable: true` (idiomatic in imported OpenAPI schemas)
  // by widening the declared type to `[..., 'null']`. JSON Schema 2020-12
  // expresses the same shape with `type: [..., 'null']`, which the array
  // branch below already covers.
  const nullable = schema['nullable'] === true;

  // `type` may be a string or an array of strings (`["string","null"]`).
  const rawType = schema.type;
  const types: readonly string[] | undefined = Array.isArray(rawType)
    ? rawType
    : typeof rawType === 'string'
      ? [rawType]
      : undefined;

  if (types !== undefined) {
    const widened =
      nullable && !types.includes('null') ? [...types, 'null'] : types;
    if (widened.length === 1) {
      const onlyType = widened[0];
      if (onlyType !== undefined)
        return primitiveTs(onlyType, schema, opts, visited);
    }
    return widened.map(t => primitiveTs(t, schema, opts, visited)).join(' | ');
  }

  // No type / no $ref / no enum → genuinely opaque.
  return 'unknown';
}

/**
 * Resolve a `#/$defs/<name>` pointer against the owning schema's `$defs`
 * table. Returns `undefined` (and emits a lossy report) when the table or
 * the named entry is missing.
 */
function resolveInternalRef(
  ref: string,
  opts: JsonSchemaToTsTypeOptions,
): JSONSchema | undefined {
  const match = /^#\/\$defs\/([^/]+)$/.exec(ref);
  if (!match) {
    report(
      opts,
      'unresolved-internal-ref',
      `internal $ref '${ref}' is not a '#/$defs/<name>' pointer`,
    );
    return undefined;
  }
  // `match[1]` is structurally guaranteed by the capturing group above —
  // the regex would not match without at least one `[^/]` char. The `??`
  // fallback was load-bearing only to satisfy `noUncheckedIndexedAccess`;
  // surface the impossible case as a typed codegen error for symmetry with
  // every other guard in this file (rather than silently degrading to an
  // empty `$defs` name and an unhelpful "not found" lossy report).
  const captured = match[1];
  if (captured === undefined) {
    throw new ContractsCodegenError(
      `internal $ref '${ref}' matched the '#/$defs/<name>' pattern but produced no capture group`,
      {emitterKind: 'json-schema-to-ts-type', schemaId: opts.schemaId ?? ''},
    );
  }
  const name = decodeURIComponent(captured);
  const defs = opts.owningSchema?.['$defs'] as
    | Record<string, JSONSchema>
    | undefined;
  const found = defs?.[name];
  if (!found) {
    report(opts, 'unresolved-$defs-ref', `#/$defs/${name} not found`);
    return undefined;
  }
  return found;
}

function unionOf(
  list: JSONSchema[],
  opts: JsonSchemaToTsTypeOptions,
  visited: Set<string>,
): string {
  const parts = list.map(s => toTsTypeBase(s, opts, visited));
  return parts.join(' | ');
}

function primitiveTs(
  type: string,
  schema: JSONSchema,
  opts: JsonSchemaToTsTypeOptions,
  visited: Set<string>,
): string {
  switch (type) {
    case 'string':
      // `format: 'date-time'` and friends do not change the runtime type.
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = schema['items'];
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        return `Array<${toTsTypeBase(items as JSONSchema, opts, visited)}>`;
      }
      // Tuple-shaped or missing items — degrade.
      if (Array.isArray(items)) {
        report(
          opts,
          'tuple-items',
          'tuple-shaped `items` is not supported; emitting `Array<unknown>`',
        );
      }
      return 'Array<unknown>';
    }
    case 'object': {
      const properties = schema.properties;
      if (!properties) return 'Record<string, unknown>';
      const required = new Set(schema.required ?? []);
      const entries = Object.entries(properties).map(([k, v]) => {
        const opt = required.has(k) ? '' : '?';
        const ts = toTsTypeBase(v, opts, visited);
        return `${safeKey(k)}${opt}: ${ts}`;
      });
      return `{${entries.join('; ')}}`;
    }
    default:
      report(
        opts,
        `unsupported-type-${type}`,
        `unsupported JSON Schema type '${type}'; emitting \`unknown\``,
      );
      return 'unknown';
  }
}

function tsLiteral(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  // Object / array literals are not first-class TS types — fall back.
  return 'unknown';
}

function safeKey(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

function report(
  opts: JsonSchemaToTsTypeOptions,
  feature: string,
  message: string,
): void {
  if (!opts.lossy) return;
  opts.lossy.report({
    feature,
    source: {
      schemaId: opts.schemaId ?? '',
      ...(opts.propertyPath !== undefined
        ? {propertyPath: opts.propertyPath}
        : {}),
    },
    severity: 'info',
    message,
  });
}
