import {BindingScope, injectable} from '@loopback/core';
import Ajv2020 from 'ajv/dist/2020';
import {resolve} from 'node:path';
import {ContractsValidationError, toKebab, toPascal} from '../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReporter,
  ProjectionEmitter,
} from '../interfaces';
import {ContractsBindings} from '../keys';

/**
 * Per-schema options block the GraphQL emitter reads from `x-graphql` on the
 * source schema.
 *
 * @experimental
 */
export interface GraphQLPerSchemaOptions {
  /** Emit a sibling `.graphql` SDL file alongside the code-first TS output. */
  sdl?: boolean;
  /** Map JSON Schema `format` hints to GraphQL scalar names (e.g. `date-time` → `DateTime`). */
  scalars?: Record<string, string>;
}

interface FieldView {
  readonly name: string;
  readonly tsType: string;
  readonly gqlType: string;
  readonly required: boolean;
  readonly description?: string;
}

const TEMPLATE_PATH = resolve(__dirname, '..', 'templates', 'graphql.ts.ejs');

/**
 * Built-in GraphQL scalar names this emitter is allowed to project to.
 * `DateTime` and `Date` are conventional custom scalars (graphql-scalars,
 * Apollo, type-graphql) that we emit by name; the runtime is expected to
 * register them or pull `graphql-scalars` alongside.
 *
 * Any `format` not on this list AND not present in the user-supplied
 * `scalars` map triggers a lossy report so the operator sees the dropped
 * detail before the schema ships.
 */
const KNOWN_SCALARS: ReadonlySet<string> = new Set([
  'String',
  'Int',
  'Float',
  'Boolean',
  'ID',
  'DateTime',
  'Date',
]);

const FORMAT_TO_SCALAR: Readonly<Record<string, string>> = {
  'date-time': 'DateTime',
  date: 'Date',
};

function isObjectSchema(s: unknown): s is JSONSchema {
  return typeof s === 'object' && s !== null;
}

function singleType(schema: JSONSchema): string | undefined {
  const t = schema.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    const nonNull = t.filter(x => x !== 'null');
    return nonNull[0];
  }
  return undefined;
}

/**
 * Minimal JSON-Schema → TypeScript type translator scoped to this emitter.
 * The shared `generators/json-schema-to-ts-type.ts` helper will replace this
 * when Wave E1 lands; reconciliation is a mechanical swap.
 */
function jsonSchemaToTsType(schema: JSONSchema): string {
  const t = singleType(schema);
  switch (t) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array': {
      const items = isObjectSchema(schema.items) ? schema.items : {};
      return `${jsonSchemaToTsType(items)}[]`;
    }
    case 'object':
      return 'Record<string, unknown>';
    default:
      return 'unknown';
  }
}

interface GqlMapContext {
  readonly scalars: Record<string, string> | undefined;
  readonly schemaId: string;
  readonly lossy: LossyReporter;
}

function jsonSchemaToGqlType(
  schema: JSONSchema,
  propertyName: string,
  mapCtx: GqlMapContext,
): string {
  const format = typeof schema.format === 'string' ? schema.format : undefined;
  if (format && mapCtx.scalars && mapCtx.scalars[format]) {
    return mapCtx.scalars[format] as string;
  }
  // Detect a truly-mixed type union (more than one non-null branch) — GraphQL
  // has no algebraic union over scalars, so we'd silently flatten to whichever
  // type appears first. Report it as lossy (`warn`) so the operator sees the
  // dropped detail; the rendered field stays the flattened scalar. The
  // single-non-null + null shape (`['string', 'null']`) is GraphQL-legal as
  // an unwrapped nullable scalar and is NOT reported.
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter(x => x !== 'null');
    if (nonNull.length > 1) {
      mapCtx.lossy.report({
        feature: 'graphql-mixed-type-flattened',
        source: {
          schemaId: mapCtx.schemaId,
          propertyPath: `/properties/${propertyName}`,
        },
        severity: 'warn',
        message:
          `JSON Schema 'type: [${nonNull.join(', ')}]' on property ` +
          `'${propertyName}' has no GraphQL equivalent (GraphQL lacks scalar ` +
          `unions); flattened to '${String(nonNull[0])}'.`,
      });
    } else if (nonNull.length === 0) {
      // `type: ['null']` (or only `null` types) — GraphQL has no `null`
      // scalar, so the field would otherwise fall through to the default
      // (`String` / `ID`). Surface the drop.
      mapCtx.lossy.report({
        feature: 'graphql-mixed-type-flattened',
        source: {
          schemaId: mapCtx.schemaId,
          propertyPath: `/properties/${propertyName}`,
        },
        severity: 'warn',
        message:
          `JSON Schema 'type: null' on property '${propertyName}' has no ` +
          `GraphQL equivalent; flattened to scalar 'String'.`,
      });
    }
  } else if (schema.type === 'null') {
    mapCtx.lossy.report({
      feature: 'graphql-mixed-type-flattened',
      source: {
        schemaId: mapCtx.schemaId,
        propertyPath: `/properties/${propertyName}`,
      },
      severity: 'warn',
      message:
        `JSON Schema 'type: null' on property '${propertyName}' has no ` +
        `GraphQL equivalent; flattened to scalar 'String'.`,
    });
  }
  const t = singleType(schema);
  switch (t) {
    case 'string':
      if (format !== undefined) {
        const mapped = FORMAT_TO_SCALAR[format];
        if (mapped !== undefined) return mapped;
        // Unknown format on a string — emit a lossy report so the operator
        // sees the dropped detail and can either add a `scalars` override or
        // accept the flatten-to-String fallback.
        mapCtx.lossy.report({
          feature: 'graphql-unknown-format',
          source: {
            schemaId: mapCtx.schemaId,
            propertyPath: `/properties/${propertyName}`,
          },
          severity: 'warn',
          message:
            `JSON Schema 'format: ${format}' on property '${propertyName}' ` +
            `has no built-in GraphQL scalar mapping; flattened to 'String'. ` +
            `Add an override via 'x-graphql.scalars' to project a custom scalar.`,
        });
      }
      return 'String';
    case 'integer':
      return 'Int';
    case 'number':
      return 'Float';
    case 'boolean':
      return 'Boolean';
    case 'array': {
      const items = isObjectSchema(schema.items) ? schema.items : {};
      return `[${jsonSchemaToGqlType(items, propertyName, mapCtx)}]`;
    }
    default:
      return propertyName === 'id' ? 'ID' : 'String';
  }
}

function deriveName(schema: JSONSchema): string {
  const id = typeof schema.$id === 'string' ? schema.$id : 'Anonymous';
  return id.replace(/\.v\d+$/, '');
}

/**
 * `@experimental` projection emitter producing code-first GraphQL decorators
 * (Type-GraphQL-style `@ObjectType` / `@Field`) for every source schema, with
 * optional opt-in `.graphql` SDL emission gated by per-schema
 * `x-graphql.sdl === true`. The consumer (typically `loopback-graphql`) picks
 * the runtime GraphQL framework; we ship the decorator import contract.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'graphql',
  },
})
export class GraphQLEmitter implements ProjectionEmitter<GraphQLPerSchemaOptions> {
  readonly kind = 'graphql';
  readonly outputSuffix = '.graphql.ts';
  readonly tier = 'real-translation' as const;
  readonly description =
    'GraphQL code-first decorators (Type-GraphQL-style) + optional SDL';
  // SDL emission is hand-rolled below — no peer-dep needed for v1.0. If a
  // future iteration wires `quicktype-core`'s `graphql-schema` target as an
  // alternative path, add the dep here and resurrect the lazy `require`.
  readonly peerDeps: string[] = [];
  readonly templatePaths = [TEMPLATE_PATH];
  readonly perSchemaOptionsSchema: JSONSchema = {
    type: 'object',
    properties: {
      sdl: {type: 'boolean'},
      scalars: {type: 'object', additionalProperties: {type: 'string'}},
    },
  };

  emit(ctx: EmitterContext<GraphQLPerSchemaOptions>): EmittedFile[] {
    const {schema, templates} = ctx;
    const options = validateOptions<GraphQLPerSchemaOptions>(
      this.kind,
      this.perSchemaOptionsSchema,
      ctx.options,
    );
    const baseName = deriveName(schema);
    const Name = toPascal(baseName);
    const kebab = toKebab(baseName);

    const mapCtx: GqlMapContext = {
      scalars: options.scalars,
      schemaId: typeof schema.$id === 'string' ? schema.$id : '',
      lossy: ctx.lossy,
    };
    const fields = buildFields(schema, mapCtx);
    const description =
      typeof schema.description === 'string' ? schema.description : '';

    const content = templates.render(TEMPLATE_PATH, {
      name: Name,
      fields,
      description,
    });

    const files: EmittedFile[] = [
      {
        path: `models/${kebab}.graphql.ts`,
        content,
        policy: 'regen',
        producer: 'graphql-emitter',
      },
    ];

    if (options.sdl === true) {
      const sdl = renderSdl(Name, fields, description, options.scalars);
      files.push({
        path: `models/${kebab}.graphql`,
        content: sdl,
        policy: 'regen',
        producer: 'graphql-emitter',
      });
    }

    return files;
  }
}

function buildFields(schema: JSONSchema, mapCtx: GqlMapContext): FieldView[] {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const fields: FieldView[] = [];
  for (const [propName, raw] of Object.entries(properties)) {
    const propSchema = isObjectSchema(raw) ? raw : {};
    const tsType = jsonSchemaToTsType(propSchema);
    const gqlType = jsonSchemaToGqlType(propSchema, propName, mapCtx);
    const description =
      typeof propSchema.description === 'string'
        ? propSchema.description
        : undefined;
    fields.push({
      name: propName,
      tsType,
      gqlType,
      required: required.has(propName),
      ...(description !== undefined ? {description} : {}),
    });
  }
  return fields;
}

function renderSdl(
  Name: string,
  fields: readonly FieldView[],
  description: string,
  scalars: Record<string, string> | undefined,
): string {
  // SDL is hand-rolled here — no peer-dep gate. The output is a closed-form
  // function of the JSON Schema; if we ever route SDL through quicktype's
  // `graphql-schema` language target instead, re-add the lazy `require` and
  // the corresponding `peerDeps` entry on the emitter class.
  const header = description ? `"""${description}"""\n` : '';
  const body = fields
    .map(f => {
      const bang = f.required ? '!' : '';
      const doc = f.description ? `  """${f.description}"""\n` : '';
      return `${doc}  ${f.name}: ${f.gqlType}${bang}`;
    })
    .join('\n');

  // Custom-scalar declarations include both user-supplied overrides AND
  // built-in mapped scalars (`DateTime`, `Date`) actually used by emitted
  // fields. The GraphQL spec lists only `String|Int|Float|Boolean|ID` as
  // built-in; everything else needs a `scalar X` declaration so the
  // resulting SDL is parseable in isolation.
  const builtIns = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);
  const declared = new Set<string>();
  if (scalars) {
    for (const s of Object.values(scalars)) {
      if (!builtIns.has(s)) declared.add(s);
    }
  }
  for (const f of fields) {
    // `f.gqlType` may be wrapped (`[DateTime]`) — extract the inner name.
    const inner = f.gqlType.replace(/[[\]!]/g, '');
    if (!builtIns.has(inner) && KNOWN_SCALARS.has(inner)) declared.add(inner);
  }
  const customScalars = [...declared].map(s => `scalar ${s}`).join('\n');
  const prelude = customScalars ? customScalars + '\n\n' : '';
  return `${prelude}${header}type ${Name} {\n${body}\n}\n`;
}

/**
 * Validate `ctx.options` against the emitter's declared
 * `perSchemaOptionsSchema` with Ajv 2020 before they reach the renderer.
 * Empty / absent options pass through; structural violations raise a typed
 * {@link ContractsValidationError}.
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
