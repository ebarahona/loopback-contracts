import {BindingScope, injectable} from '@loopback/core';
import Ajv2020 from 'ajv/dist/2020';
import {ContractsValidationError, toKebab, toPascal} from '../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReport,
  LossyReporter,
  ProjectionEmitter,
  SchemaRegistry,
} from '../interfaces';
import {ContractsBindings} from '../keys';

const DEFAULT_NAMESPACE = 'com.example.contracts';

/**
 * Per-schema options block read from the source schema's `x-avro` keyword.
 */
interface AvroPerSchemaOptions {
  namespace?: string;
  doc?: string;
  aliases?: string[];
}

/**
 * One Avro field descriptor. Open-ended `[k: string]: unknown` covers the
 * keywords the converter emits (`doc`, `default`, `aliases`).
 */
interface AvroField {
  name: string;
  type: AvroType;
  [k: string]: unknown;
}

type AvroPrimitive =
  | 'null'
  | 'boolean'
  | 'int'
  | 'long'
  | 'float'
  | 'double'
  | 'bytes'
  | 'string';

type AvroType =
  | AvroPrimitive
  | AvroPrimitive[]
  | AvroComplexType
  | AvroComplexType[]
  | Array<AvroPrimitive | AvroComplexType>;

interface AvroComplexType {
  type: 'record' | 'enum' | 'array' | 'map' | 'fixed';
  name?: string;
  namespace?: string;
  fields?: AvroField[];
  symbols?: string[];
  items?: AvroType;
  values?: AvroType;
  size?: number;
  [k: string]: unknown;
}

/**
 * Sidecar emitter that projects a JSON Schema to an Avro `.avsc` file for
 * Kafka schema-registry workflows.
 *
 * Avro is hand-rolled end-to-end: `quicktype-core` does not ship an Avro
 * renderer in any release we target, so there is no peer-dep and no lazy
 * loader. The walker, `$ref` resolver, and cycle-handling all live in this
 * file — see {@link jsonSchemaToAvroType} and {@link resolveRef}.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'avro',
  },
})
export class AvroEmitter implements ProjectionEmitter<AvroPerSchemaOptions> {
  readonly kind = 'avro';
  readonly outputSuffix = '.avsc';
  readonly tier = 'real-translation' as const;
  readonly description = 'Avro schema (for Kafka schema-registry workflows)';
  readonly peerDeps: string[] = [];
  readonly perSchemaOptionsSchema: JSONSchema = {
    type: 'object',
    properties: {
      namespace: {type: 'string'},
      doc: {type: 'string'},
      aliases: {type: 'array', items: {type: 'string'}},
    },
    additionalProperties: false,
  };

  emit(ctx: EmitterContext<AvroPerSchemaOptions>): EmittedFile[] {
    const options = validateOptions<AvroPerSchemaOptions>(
      this.kind,
      this.perSchemaOptionsSchema,
      ctx.options,
    );
    const schemaId = typeof ctx.schema.$id === 'string' ? ctx.schema.$id : '';
    const recordName = toPascal(schemaId || 'Record');
    const fileBase = toKebab(schemaId || 'record');
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;

    const convertCtx: ConvertContext = {
      registry: ctx.registry,
      namespace,
      lossy: ctx.lossy,
      schemaId,
      // Seed the visited stack with this record so a self-reference on a
      // property collapses to the lazy name-ref pattern instead of recursing.
      visited: new Map<string, string>([[schemaId || recordName, recordName]]),
    };

    const record: AvroComplexType = {
      type: 'record',
      name: recordName,
      namespace,
      fields: buildFields(ctx.schema, convertCtx),
    };
    if (options.doc !== undefined) record['doc'] = options.doc;
    if (options.aliases !== undefined) {
      record['aliases'] = options.aliases;
    }

    return [
      {
        path: `models/${fileBase}.avsc`,
        content: `${JSON.stringify(record, null, 2)}\n`,
        policy: 'regen',
        producer: 'avro-emitter',
      },
    ];
  }
}

/**
 * Internal state threaded through {@link jsonSchemaToAvroType} so a single
 * `emit()` call can resolve `$ref`s, detect cycles, and surface lossy
 * translations through one consistent path.
 */
interface ConvertContext {
  registry: SchemaRegistry;
  namespace: string;
  /** Optional — `EmitterContext.lossy` is wired in a later wave. */
  lossy: LossyReporter;
  /** `$id` of the top-level schema being emitted, for lossy reports. */
  schemaId: string;
  /**
   * Map of currently-recursing `$ref` lookup keys to the Avro record name
   * the cycle should reuse. Avro identifies records by name, so on a cycle
   * we emit the bare name string (`"UserV1"`) instead of re-expanding the
   * record body.
   */
  visited: Map<string, string>;
}

// ---------- JSON Schema -> Avro converter -------------------------------

const VALID_AVRO_SYMBOL = /^[A-Za-z_][A-Za-z0-9_]*$/;

function buildFields(
  schema: JSONSchema,
  convertCtx: ConvertContext,
): AvroField[] {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const fields: AvroField[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const baseType = jsonSchemaToAvroType(prop, name, convertCtx);
    const field: AvroField = required.has(name)
      ? {name, type: baseType}
      : {name, type: wrapOptional(baseType), default: null};
    fields.push(field);
  }
  return fields;
}

/**
 * Wrap an Avro type as a `['null', <type>]` union without producing a
 * nested union — Avro forbids unions of unions (`['null', ['null', X]]` is
 * invalid). When the inner type is already a union (e.g., from a mixed
 * JSON-Schema `type: ['string', 'null']`), flatten its branches into the
 * outer union with `'null'` first and duplicates removed.
 */
function wrapOptional(baseType: AvroType): AvroType {
  if (!Array.isArray(baseType)) {
    return ['null', baseType] as AvroType;
  }
  const branches: Array<AvroPrimitive | AvroComplexType> = [];
  const seen = new Set<string>();
  branches.push('null');
  seen.add('null');
  for (const branch of baseType) {
    const flat = branch as AvroPrimitive | AvroComplexType;
    const key = typeof flat === 'string' ? flat : JSON.stringify(flat);
    if (seen.has(key)) continue;
    seen.add(key);
    branches.push(flat);
  }
  return branches as AvroType;
}

function jsonSchemaToAvroType(
  prop: JSONSchema,
  fieldName: string,
  convertCtx: ConvertContext,
): AvroType {
  reportCompositionIfPresent(prop, fieldName, convertCtx);
  // `$ref` MUST be handled before `type` — JSON Schema lets a node carry
  // both keywords, but in practice `$ref` wins and other keywords are
  // ignored at validation time. Mirror that here so a referenced record
  // isn't silently flattened to an empty `{}`.
  if (typeof prop['$ref'] === 'string') {
    return resolveRef(prop['$ref'], fieldName, convertCtx);
  }

  // Mixed-type arrays (`{type: ['string', 'null']}`) project to an Avro
  // union. Avro convention puts `"null"` first when present so the default
  // can be `null`.
  if (Array.isArray(prop.type) && prop.type.length > 1) {
    return buildUnion(prop, fieldName, convertCtx);
  }

  const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) {
    // Avro `enum` symbols MUST be strings. If the source enum mixes types
    // (e.g., `['a', 1, true]`), `String()`-coerce each value and surface a
    // single lossy report so the operator sees the cross-type collapse —
    // `sanitizeEnumSymbol` only reports invalid-symbol rewrites, not type
    // coercion of legal-but-non-string values.
    const hasNonString = prop.enum.some(v => typeof v !== 'string');
    if (hasNonString) {
      reportLossy(convertCtx, {
        feature: 'avro-enum-mixed-type-coerced',
        severity: 'warn',
        source: {schemaId: convertCtx.schemaId, propertyPath: fieldName},
        message:
          'Avro enum requires uniform string symbols; non-string values ' +
          'were String()-coerced.',
      });
    }
    return {
      type: 'enum',
      name: `${toPascal(fieldName)}Enum`,
      symbols: prop.enum.map(v => sanitizeEnumSymbol(v, convertCtx)),
    };
  }
  switch (t) {
    case 'string':
      return 'string';
    case 'integer':
      return prop['format'] === 'int32' ? 'int' : 'long';
    case 'number':
      return prop['format'] === 'float' ? 'float' : 'double';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const items = (prop.items as JSONSchema | undefined) ?? {type: 'string'};
      return {
        type: 'array',
        items: jsonSchemaToAvroType(items, `${fieldName}Item`, convertCtx),
      };
    }
    case 'object':
      return buildInlineRecord(prop, fieldName, convertCtx);
    case 'null':
      return 'null';
    default:
      return 'string';
  }
}

/**
 * Builds an inline `record` Avro type for an anonymous object property,
 * pushing/popping the visited stack so a property whose subtree refers
 * back to itself collapses to the bare name on the cycle.
 */
function buildInlineRecord(
  prop: JSONSchema,
  fieldName: string,
  convertCtx: ConvertContext,
): AvroComplexType {
  const recordName = toPascal(fieldName);
  // Anonymous inline records don't have an `$id`; key on the name so a
  // nested cycle through the same property path still trips the guard.
  const key = `__inline:${recordName}`;
  convertCtx.visited.set(key, recordName);
  const fields = buildFields(prop, convertCtx);
  convertCtx.visited.delete(key);
  return {
    type: 'record',
    name: recordName,
    fields,
  };
}

/**
 * Resolves a `$ref` against the schema registry.
 *
 * - On cycle (already on the visited stack): emits the bare record name so
 *   Avro's name-based resolution closes the loop without infinite expansion.
 * - On miss (registry doesn't know the ref): emits `"string"` and reports a
 *   lossy translation so the operator can see the dropped detail.
 * - On hit: pushes onto the visited stack and recurses into the target,
 *   then pops so siblings can reuse the same target without false cycles.
 */
function resolveRef(
  refId: string,
  fieldName: string,
  convertCtx: ConvertContext,
): AvroType {
  const lookupKey = refId.replace(/^#\//, '').split('/')[0] ?? refId;
  const cycleName = convertCtx.visited.get(lookupKey);
  if (cycleName !== undefined) {
    // Lazy name-ref: Avro identifies records by `name` (within `namespace`),
    // so we just emit the name string. Wrapped in a union with `null` keeps
    // the recursion terminable on the wire.
    return ['null', cycleName] as AvroType;
  }
  const target = convertCtx.registry.get(lookupKey);
  if (!target) {
    reportLossy(convertCtx, {
      feature: 'unresolved-$ref',
      source: {schemaId: convertCtx.schemaId, propertyPath: fieldName},
      severity: 'warn',
      message: `Unresolved $ref: ${refId} (no entry in registry; emitting 'string' placeholder)`,
    });
    return 'string';
  }
  const targetName = toPascal(
    typeof target.$id === 'string' && target.$id.length > 0
      ? target.$id
      : fieldName,
  );
  convertCtx.visited.set(lookupKey, targetName);
  const fields = buildFields(target, convertCtx);
  convertCtx.visited.delete(lookupKey);
  return {
    type: 'record',
    name: targetName,
    namespace: convertCtx.namespace,
    fields,
  };
}

/**
 * Translates a `type: [...]` union into an Avro union. Avro forbids
 * duplicate branches, so we de-dupe by Avro-type identity (string for
 * primitives). `"null"` is hoisted to the front when present, matching the
 * convention used by every other null-default field this emitter produces.
 */
function buildUnion(
  prop: JSONSchema,
  fieldName: string,
  convertCtx: ConvertContext,
): AvroType {
  const types = prop.type as string[];
  const branches: Array<AvroPrimitive | AvroComplexType> = [];
  const seen = new Set<string>();
  for (const single of types) {
    const singleTypeProp: JSONSchema = {...prop, type: single};
    const branch = jsonSchemaToAvroType(singleTypeProp, fieldName, convertCtx);
    // jsonSchemaToAvroType always returns a single Avro type when given a
    // scalar `type`, so the result is never itself a union here.
    const flat = branch as AvroPrimitive | AvroComplexType;
    const key = typeof flat === 'string' ? flat : JSON.stringify(flat);
    if (seen.has(key)) continue;
    seen.add(key);
    branches.push(flat);
  }
  branches.sort((a, b) => {
    if (a === 'null') return -1;
    if (b === 'null') return 1;
    return 0;
  });
  return branches as AvroType;
}

/**
 * Coerces an arbitrary JSON Schema `enum` value to a string that satisfies
 * Avro's symbol rule (`^[A-Za-z_][A-Za-z0-9_]*$`). Non-conforming chars are
 * mapped to `_`, leading digits get an `_` prefix, and the original value
 * is preserved in a lossy report so consumers can audit the renaming.
 */
function sanitizeEnumSymbol(
  value: unknown,
  convertCtx: ConvertContext,
): string {
  const raw = String(value);
  if (VALID_AVRO_SYMBOL.test(raw)) return raw;
  let sanitized = raw.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(sanitized)) sanitized = `_${sanitized}`;
  if (sanitized === '') sanitized = '_';
  reportLossy(convertCtx, {
    feature: 'avro-enum-symbol-sanitized',
    source: {schemaId: convertCtx.schemaId},
    severity: 'warn',
    message: `Enum symbol "${raw}" is not a valid Avro symbol; rewritten as "${sanitized}"`,
  });
  return sanitized;
}

function reportLossy(convertCtx: ConvertContext, report: LossyReport): void {
  convertCtx.lossy.report(report);
}

/**
 * Surface JSON Schema composition keywords (`oneOf` / `anyOf` / `allOf`) that
 * Avro can't represent. The hand-rolled walker collapses to base
 * `type`/`properties`/`items`; without this hook the dropped composition is
 * silent. Reports once per node so a deep tree doesn't spam the operator.
 */
function reportCompositionIfPresent(
  prop: JSONSchema,
  fieldName: string,
  convertCtx: ConvertContext,
): void {
  if (
    !Array.isArray(prop.oneOf) &&
    !Array.isArray(prop.anyOf) &&
    !Array.isArray(prop.allOf)
  )
    return;
  reportLossy(convertCtx, {
    feature: 'avro-composition-dropped',
    severity: 'warn',
    source: {schemaId: convertCtx.schemaId, propertyPath: fieldName},
    message:
      'JSON Schema oneOf/anyOf/allOf composition is not projected to Avro; ' +
      'the rendered output reflects only base properties/type/items.',
  });
}

/**
 * Validate `ctx.options` against the emitter's declared
 * `perSchemaOptionsSchema` with Ajv 2020. Empty / missing options pass
 * through; structural violations raise a typed
 * {@link ContractsValidationError} so the CLI can render a precise pointer
 * (e.g., `aliases: must be array`).
 */
function validateOptions<T>(
  kind: string,
  schema: JSONSchema | undefined,
  options: unknown,
): T {
  if (schema === undefined) return (options ?? {}) as T;
  const ajv = new Ajv2020({strict: false});
  const validate = ajv.compile(schema);
  const candidate = options ?? {};
  if (!validate(candidate)) {
    throw new ContractsValidationError(
      `Invalid options for ${kind} emitter: ${ajv.errorsText(validate.errors)}`,
      {
        sourcePath: `<schema x-${kind}>`,
        instancePath: validate.errors?.[0]?.instancePath ?? '',
      },
    );
  }
  return candidate as T;
}
