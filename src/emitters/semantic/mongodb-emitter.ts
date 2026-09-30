import {BindingScope, injectable} from '@loopback/core';
import {
  ContractsValidationError,
  resolveSchemaRef,
  schemaNameStems,
  toKebab,
  walkJsonPointer,
} from '../../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReport,
  LossyReporter,
  ProjectionEmitter,
  SchemaRegistry,
} from '../../interfaces';
import {ContractsBindings} from '../../keys';

/**
 * Per-schema options read from the source schema's `x-mongodb` keyword.
 *
 * @experimental
 */
export interface MongoDbPerSchemaOptions {
  /**
   * BSON type(s) for JSON Schema `integer`. `int-or-long` (default) emits
   * `["int", "long"]`; `number` accepts any numeric BSON type, including a
   * `double` the Node.js driver writes for integers beyond 32 bits.
   */
  readonly integer?: 'int' | 'long' | 'int-or-long' | 'number';
  /**
   * BSON type for JSON Schema `number`. `number` (default) is MongoDB's
   * alias for `int`, `long`, `double` and `decimal`.
   */
  readonly number?: 'double' | 'decimal' | 'number';
  /**
   * How `{"type": "string", "format": "date-time"}` is validated. `string`
   * (default) keeps an ISO string (the `format` is dropped, as MongoDB has
   * no `format`); `date` validates a BSON `date`, for collections that
   * store native dates.
   */
  readonly dateTime?: 'string' | 'date';
  /**
   * BSON type(s) of the `_id` property injected when the root schema sets
   * `additionalProperties: false` without declaring `_id`. Default
   * `objectId`; `any` injects an unconstrained `_id`.
   */
  readonly idBsonType?: string | readonly string[];
}

/** Keywords MongoDB accepts verbatim. */
const PASSTHROUGH: ReadonlySet<string> = new Set([
  'title',
  'description',
  'enum',
  'minimum',
  'maximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

/**
 * Keywords dropped without a report: annotations with no validation
 * effect, identifiers, and `$defs` (whose entries are inlined at every
 * `$ref`). MongoDB rejects unknown keywords, so none of them can stay.
 */
const SILENT_DROP: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$comment',
  '$defs',
  'definitions',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'discriminator',
]);

/** Lossy-report features this emitter raises. */
const UNSUPPORTED_KEYWORD = 'mongodb-unsupported-keyword';
const UNRESOLVED_REF = 'unresolved-$ref';
const RECURSIVE_REF = 'recursive-$ref';

/**
 * Sidecar emitter that projects a JSON Schema 2020-12 contract to a
 * MongoDB `$jsonSchema` validator document, written as
 * `models/<slug>.mongodb.json` (`{"$jsonSchema": {...}}`) for
 * `db.createCollection(name, {validator})` or `collMod`.
 *
 * MongoDB implements a draft-4 subset with a `bsonType` extension and
 * rejects unknown keywords, so the translation:
 *
 * - inlines every `$ref` (local `#/$defs/...` and cross-schema) and drops
 *   `$defs`; a recursive `$ref` cannot be inlined and becomes `{}`;
 * - maps `type` to `bsonType` (`integer` and `number` per the
 *   `x-mongodb` options, `boolean` to `bool`);
 * - rewrites 2020-12 forms MongoDB spells differently: numeric
 *   `exclusiveMinimum`/`exclusiveMaximum` to `minimum` + boolean flag,
 *   `const` to a one-value `enum`, `prefixItems` to array `items` +
 *   `additionalItems`, `dependentRequired`/`dependentSchemas` to
 *   `dependencies`;
 * - drops `format` and every other keyword MongoDB lacks
 *   (`if`/`then`/`else`, `contains`, `propertyNames`, `unevaluated*`, ...)
 *   with a lossy warning, which `--strict` turns into an error;
 * - injects `_id` into the root `properties` when the root sets
 *   `additionalProperties: false`, since MongoDB adds `_id` to every
 *   document and would otherwise reject every insert.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'mongodb',
  },
})
export class MongoDbEmitter implements ProjectionEmitter<MongoDbPerSchemaOptions> {
  readonly kind = 'mongodb';
  readonly outputSuffix = '.mongodb.json';
  readonly tier = 'real-translation' as const;
  readonly description =
    'MongoDB $jsonSchema collection validator (experimental)';
  readonly peerDeps: string[] = [];
  readonly perSchemaOptionsSchema: JSONSchema = deepFreeze({
    type: 'object',
    properties: {
      integer: {enum: ['int', 'long', 'int-or-long', 'number']},
      number: {enum: ['double', 'decimal', 'number']},
      dateTime: {enum: ['string', 'date']},
      idBsonType: {
        oneOf: [
          {type: 'string', minLength: 1},
          {
            type: 'array',
            items: {type: 'string', minLength: 1},
            minItems: 1,
          },
        ],
      },
    },
    additionalProperties: false,
  });

  emit(ctx: EmitterContext<MongoDbPerSchemaOptions>): EmittedFile[] {
    const {fileStem} = schemaNameStems(
      ctx.schema,
      'full',
      '',
      ctx.registry.list(),
    );
    const translator = new Translator(ctx.schema, ctx.registry, ctx.lossy, {
      ...ctx.options,
    });
    const jsonSchema = translator.root();
    return [
      {
        path: `models/${toKebab(fileStem || 'schema')}.mongodb.json`,
        content: `${JSON.stringify({$jsonSchema: jsonSchema}, null, 2)}\n`,
        policy: 'regen',
        producer: 'mongodb-emitter',
      },
    ];
  }

  /** `--strict`: every warning or error this emitter reports is fatal. */
  validate(input: {schema: JSONSchema; lossy: LossyReport}): void {
    if (input.lossy.severity === 'info') return;
    const schemaId =
      typeof input.schema.$id === 'string' ? input.schema.$id : '<unknown>';
    throw new ContractsValidationError(
      `MongoDB emitter rejected lossy translation '${input.lossy.feature}' ` +
        `on schema '${schemaId}': ${input.lossy.message}`,
      {
        sourcePath: schemaId,
        instancePath: input.lossy.source.propertyPath ?? '',
        schemaId,
      },
    );
  }
}

type Out = Record<string, unknown>;

/** One `emit()` call's translation state. */
class Translator {
  /** `<id>#<pointer>` of every `$ref` currently being inlined. */
  private readonly inlining = new Set<string>();
  private readonly schemaId: string;

  constructor(
    private readonly rootSchema: JSONSchema,
    private readonly registry: SchemaRegistry,
    private readonly lossy: LossyReporter,
    private readonly options: MongoDbPerSchemaOptions,
  ) {
    this.schemaId =
      typeof rootSchema.$id === 'string' ? rootSchema.$id : '<unknown>';
  }

  root(): Out {
    // A `$ref` back to the root is recursive from the start.
    const rootId =
      typeof this.rootSchema.$id === 'string' ? this.rootSchema.$id : '';
    this.inlining.add(`${rootId}#`);
    const out = this.translate(this.rootSchema, this.rootSchema, '');
    const closed = out['additionalProperties'] === false;
    const props = (out['properties'] ?? {}) as Out;
    if (closed && !('_id' in props)) {
      const id = this.options.idBsonType ?? 'objectId';
      out['properties'] = {
        _id: id === 'any' ? {} : {bsonType: id},
        ...props,
      };
    }
    return out;
  }

  private translate(node: unknown, document: JSONSchema, path: string): Out {
    if (node === true || node === undefined) return {};
    if (node === false) return {not: {}};
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      return {};
    }
    const src = node as Record<string, unknown>;
    if (typeof src['$ref'] === 'string') {
      return this.translateRef(src, src['$ref'], document, path);
    }
    return this.translateKeywords(src, document, path);
  }

  private translateRef(
    src: Record<string, unknown>,
    ref: string,
    document: JSONSchema,
    path: string,
  ): Out {
    const resolved = resolveSchemaRef(ref, document, this.registry);
    const pointer = resolved?.pointer ?? '';
    const target =
      resolved === undefined
        ? undefined
        : pointer === '' || pointer.startsWith('/')
          ? walkJsonPointer(resolved.document, pointer)
          : undefined;
    let inlined: Out;
    if (resolved === undefined || target === undefined) {
      this.report(
        UNRESOLVED_REF,
        `${path}/$ref`,
        'error',
        `$ref '${ref}' does not resolve to a loaded schema or JSON Pointer ` +
          `(anchors are not supported); emitted an unconstrained schema.`,
      );
      inlined = {};
    } else {
      const key = `${resolved.id}#${pointer}`;
      if (this.inlining.has(key)) {
        this.report(
          RECURSIVE_REF,
          `${path}/$ref`,
          'error',
          `$ref '${ref}' recurses into itself; MongoDB has no $ref, so the ` +
            `recursive occurrence is emitted as an unconstrained schema.`,
        );
        inlined = {};
      } else {
        this.inlining.add(key);
        inlined = this.translate(target, resolved.document, path);
        this.inlining.delete(key);
      }
    }

    // 2020-12 applies `$ref` siblings too; keep them via `allOf`.
    const siblings = Object.fromEntries(
      Object.entries(src).filter(([k]) => k !== '$ref'),
    );
    const rest = this.translateKeywords(siblings, document, path);
    const {title, description, ...constraints} = rest;
    let out: Out =
      Object.keys(constraints).length === 0
        ? inlined
        : {allOf: [inlined, constraints]};
    if (title !== undefined || description !== undefined) {
      out = {...out};
      if (title !== undefined) out['title'] = title;
      if (description !== undefined) out['description'] = description;
    }
    return out;
  }

  private translateKeywords(
    src: Record<string, unknown>,
    document: JSONSchema,
    path: string,
  ): Out {
    // A nested `$id` rebases the refs beneath it.
    const doc =
      src !== document && typeof src['$id'] === 'string'
        ? (src as JSONSchema)
        : document;
    const out: Out = {};
    const asDate = this.isDateTime(src);
    const dependencies: Out = {};

    for (const [key, value] of Object.entries(src)) {
      const at = `${path}/${escapePointer(key)}`;
      if (PASSTHROUGH.has(key)) {
        if (asDate && isStringKeyword(key)) continue;
        out[key] = value;
        continue;
      }
      if (SILENT_DROP.has(key) || key.startsWith('x-')) continue;
      switch (key) {
        case 'type':
          out['bsonType'] = this.bsonType(value, asDate);
          break;
        case 'required':
          // Draft 4 (MongoDB) rejects an empty `required` array.
          if (Array.isArray(value) && value.length > 0) out[key] = value;
          break;
        case 'const':
          break; // applied after the loop, intersected with any `enum`
        case 'exclusiveMinimum':
        case 'exclusiveMaximum':
          break; // applied after the loop, over `minimum` / `maximum`
        case 'properties':
        case 'patternProperties':
          out[key] = this.translateMap(value, doc, at);
          break;
        case 'additionalProperties':
          out[key] =
            typeof value === 'boolean' ? value : this.translate(value, doc, at);
          break;
        case 'items':
          if (Array.isArray(src['prefixItems'])) {
            out['additionalItems'] =
              typeof value === 'boolean'
                ? value
                : this.translate(value, doc, at);
          } else {
            out[key] = this.translate(value, doc, at);
          }
          break;
        case 'prefixItems':
          if (Array.isArray(value)) {
            out['items'] = value.map((v, i) =>
              this.translate(v, doc, `${at}/${i}`),
            );
          }
          break;
        case 'allOf':
        case 'anyOf':
        case 'oneOf':
          if (Array.isArray(value)) {
            out[key] = value.map((v, i) =>
              this.translate(v, doc, `${at}/${i}`),
            );
          }
          break;
        case 'not':
          out[key] = this.translate(value, doc, at);
          break;
        case 'dependentRequired':
          Object.assign(dependencies, value);
          break;
        case 'dependentSchemas':
          Object.assign(dependencies, this.translateMap(value, doc, at));
          break;
        case 'format':
          if (asDate) break;
          this.report(
            UNSUPPORTED_KEYWORD,
            at,
            'warn',
            `MongoDB $jsonSchema has no 'format'; dropped format ` +
              `'${String(value)}'.`,
          );
          break;
        default:
          this.report(
            UNSUPPORTED_KEYWORD,
            at,
            'warn',
            `MongoDB $jsonSchema does not support '${key}'; dropped.`,
          );
      }
    }
    this.exclusiveBound(src, 'exclusiveMinimum', out);
    this.exclusiveBound(src, 'exclusiveMaximum', out);
    if (Object.hasOwn(src, 'const')) constAsEnum(src, out);
    if (Object.keys(dependencies).length > 0) {
      out['dependencies'] = dependencies;
    }
    return out;
  }

  private translateMap(
    value: unknown,
    document: JSONSchema,
    path: string,
  ): Out {
    if (value === null || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        this.translate(v, document, `${path}/${escapePointer(k)}`),
      ]),
    );
  }

  /** `true` when a `string` + `format: date-time` node maps to BSON `date`. */
  private isDateTime(src: Record<string, unknown>): boolean {
    if (this.options.dateTime !== 'date') return false;
    if (src['format'] !== 'date-time') return false;
    const types = typeof src['type'] === 'string' ? [src['type']] : src['type'];
    return Array.isArray(types) && types.includes('string');
  }

  private bsonType(value: unknown, asDate: boolean): string | string[] {
    const types = (Array.isArray(value) ? value : [value]).filter(
      (t): t is string => typeof t === 'string',
    );
    const out: string[] = [];
    for (const t of types) {
      for (const b of this.mapType(t, asDate)) {
        if (!out.includes(b)) out.push(b);
      }
    }
    return out.length === 1 ? (out[0] as string) : out;
  }

  private mapType(type: string, asDate: boolean): string[] {
    switch (type) {
      case 'integer': {
        const choice = this.options.integer ?? 'int-or-long';
        return choice === 'int-or-long' ? ['int', 'long'] : [choice];
      }
      case 'number':
        return [this.options.number ?? 'number'];
      case 'boolean':
        return ['bool'];
      case 'string':
        return [asDate ? 'date' : 'string'];
      default:
        // `object`, `array`, `null` share their name with the BSON alias.
        return [type];
    }
  }

  /**
   * 2020-12 `exclusiveMinimum: n` becomes draft-4
   * `minimum: n, exclusiveMinimum: true` unless an inclusive `minimum` is already the
   * tighter bound (same for the maximum side).
   */
  private exclusiveBound(
    src: Record<string, unknown>,
    key: 'exclusiveMinimum' | 'exclusiveMaximum',
    out: Out,
  ): void {
    const bound = src[key];
    if (typeof bound !== 'number') return;
    const isMin = key === 'exclusiveMinimum';
    const inclusiveKey = isMin ? 'minimum' : 'maximum';
    const inclusive = src[inclusiveKey];
    const exclusiveWins =
      typeof inclusive !== 'number' ||
      (isMin ? bound >= inclusive : bound <= inclusive);
    if (!exclusiveWins) return;
    out[inclusiveKey] = bound;
    out[key] = true;
  }

  private report(
    feature: string,
    propertyPath: string,
    severity: LossyReport['severity'],
    message: string,
  ): void {
    this.lossy.report({
      feature,
      source: {schemaId: this.schemaId, propertyPath},
      severity,
      message,
    });
  }
}

function isStringKeyword(key: string): boolean {
  return key === 'minLength' || key === 'maxLength' || key === 'pattern';
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// MongoDB has no `const`: express it as a one-value `enum`. When the source
// also declares `enum`, both must hold: keep the one value when the enum
// allows it; otherwise keep both constraints (via `allOf`) so the
// validator, like the source schema, accepts nothing.
function constAsEnum(src: Record<string, unknown>, out: Out): void {
  const value = src['const'];
  const allowed = src['enum'];
  out['enum'] = [value];
  if (
    Array.isArray(allowed) &&
    !allowed.some(v => stableJson(v) === stableJson(value))
  ) {
    const allOf = Array.isArray(out['allOf'])
      ? (out['allOf'] as unknown[])
      : [];
    out['allOf'] = [...allOf, {enum: allowed}];
  }
}

// Key-order-independent JSON for comparing `const` / `enum` values.
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}
