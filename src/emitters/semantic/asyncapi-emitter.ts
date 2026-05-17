import {BindingScope, injectable} from '@loopback/core';
import Ajv2020 from 'ajv/dist/2020';
import {resolve} from 'node:path';
import {ContractsValidationError, toKebab, toPascal} from '../../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReporter,
  ProjectionEmitter,
} from '../../interfaces';
import {ContractsBindings} from '../../keys';

/**
 * Per-schema options block the AsyncAPI emitter reads from `x-asyncapi` on
 * the source schema. Both fields are advisory metadata downstream AsyncAPI
 * consumers may consult; the emitter always produces the fragment.
 *
 * @experimental
 */
export interface AsyncAPIPerSchemaOptions {
  /** Logical channel name downstream tooling may bind this message to. */
  channelName?: string;
  /** Whether this message is produced (`send`) or consumed (`receive`). */
  operationKind?: 'send' | 'receive';
}

const TEMPLATE_PATH = resolve(
  __dirname,
  '..',
  '..',
  'templates',
  'asyncapi.yaml.ejs',
);

/**
 * `@experimental` projection emitter producing AsyncAPI 3.0 message-catalog
 * fragments (one per schema) intended to be mounted under a top-level spec's
 * `components.schemas` / `components.messages` sections.
 *
 * Owns its YAML serialisation — no peer-dep — so the fragment is a pure
 * function of the input schema and a small set of opt-in options.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'asyncapi',
  },
})
export class AsyncAPIEmitter implements ProjectionEmitter<AsyncAPIPerSchemaOptions> {
  readonly kind = 'asyncapi';
  readonly outputSuffix = '.asyncapi.yaml';
  readonly tier = 'real-translation' as const;
  readonly description =
    'AsyncAPI 3.0 message catalog fragment (event-driven endpoints)';
  readonly peerDeps: string[] = [];
  readonly templatePaths = [TEMPLATE_PATH];
  readonly perSchemaOptionsSchema: JSONSchema = {
    type: 'object',
    properties: {
      channelName: {type: 'string'},
      operationKind: {enum: ['send', 'receive']},
    },
    additionalProperties: false,
  };

  emit(ctx: EmitterContext<AsyncAPIPerSchemaOptions>): EmittedFile[] {
    const {schema, templates} = ctx;
    const options = validateOptions<AsyncAPIPerSchemaOptions>(
      this.kind,
      this.perSchemaOptionsSchema,
      ctx.options,
    );
    const id = typeof schema.$id === 'string' ? schema.$id : 'anonymous';
    const baseName = id.replace(/\.v\d+$/, '');
    const Name = toPascal(baseName);
    const kebab = toKebab(baseName);
    const title =
      typeof schema.description === 'string' ? schema.description : Name;

    const renderCtx: RenderContext = {
      schemaId: typeof schema.$id === 'string' ? schema.$id : '',
      lossy: ctx.lossy,
    };
    const schemaYaml = renderSchemaYaml(Name, schema, 4, renderCtx);

    const content = templates.render(TEMPLATE_PATH, {
      Name,
      title,
      schemaYaml,
      channelName: options.channelName ?? '',
      operationKind: options.operationKind ?? '',
    });

    return [
      {
        path: `models/${kebab}.asyncapi.yaml`,
        content,
        policy: 'regen',
        producer: 'asyncapi-emitter',
      },
    ];
  }
}

function isObjectSchema(s: unknown): s is JSONSchema {
  return typeof s === 'object' && s !== null;
}

/**
 * Internal state threaded through the YAML walker so feature drops (boolean
 * `items`, dropped array branches, etc.) can be reported once per emit
 * against a single `schemaId` anchor.
 */
interface RenderContext {
  readonly schemaId: string;
  readonly lossy: LossyReporter;
}

function renderSchemaYaml(
  name: string,
  schema: JSONSchema,
  baseIndent: number,
  renderCtx: RenderContext,
): string {
  const pad = ' '.repeat(baseIndent);
  const lines: string[] = [];
  lines.push(`${pad}${name}:`);
  emitSchemaBody(schema, lines, baseIndent + 2, renderCtx);
  return lines.join('\n') + '\n';
}

function emitSchemaBody(
  schema: JSONSchema,
  lines: string[],
  indent: number,
  renderCtx: RenderContext,
): void {
  const pad = ' '.repeat(indent);
  reportCompositionIfPresent(schema, renderCtx);
  // `$ref` short-circuits every other keyword in JSON Schema (siblings are
  // ignored at validation time). Mirror that by emitting a single
  // `$ref` line pointing into the AsyncAPI `components.schemas` map so a
  // cross-schema reference survives the projection instead of being
  // silently dropped by the walker. Pattern mirrors
  // `openapi-components-emitter.ts::rewriteRef`.
  const refValue = schema['$ref'];
  if (typeof refValue === 'string') {
    lines.push(`${pad}$ref: ${yamlString(rewriteRef(refValue))}`);
    return;
  }

  // Both scalar and array forms of `type` are valid JSON-Schema; emit the
  // array form as a YAML flow sequence so unions (e.g., `['string', 'null']`)
  // survive the projection instead of being silently dropped.
  const t = typeof schema.type === 'string' ? schema.type : undefined;
  if (t) {
    lines.push(`${pad}type: ${t}`);
  } else if (Array.isArray(schema.type)) {
    const flow = schema.type
      .filter(x => typeof x === 'string')
      .map(yamlString)
      .join(', ');
    if (flow.length > 0) lines.push(`${pad}type: [${flow}]`);
  }

  if (typeof schema.description === 'string') {
    lines.push(`${pad}description: ${yamlString(schema.description)}`);
  }
  if (typeof schema.format === 'string') {
    lines.push(`${pad}format: ${schema.format}`);
  }
  // `enum` is a first-class JSON Schema / AsyncAPI 3.0 keyword; without
  // explicit emission it would otherwise be silently dropped by the walker.
  // Render as a YAML block sequence of scalars; non-string values are
  // serialized via `JSON.stringify` so booleans and numbers survive the
  // round-trip without YAML-string ambiguity.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    lines.push(`${pad}enum:`);
    for (const v of schema.enum) {
      const rendered =
        typeof v === 'string' ? yamlString(v) : JSON.stringify(v);
      lines.push(`${pad}  - ${rendered}`);
    }
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length > 0) {
    lines.push(`${pad}required:`);
    for (const r of required) lines.push(`${pad}  - ${yamlString(r)}`);
  }

  const properties = schema.properties;
  if (properties && Object.keys(properties).length > 0) {
    lines.push(`${pad}properties:`);
    for (const [propName, raw] of Object.entries(properties)) {
      lines.push(`${pad}  ${propName}:`);
      const propSchema = isObjectSchema(raw) ? raw : {};
      emitSchemaBody(propSchema, lines, indent + 4, renderCtx);
    }
  }

  // Honor `items` whenever `array` appears, including the array-of-types
  // form like `type: ['array', 'null']`. JSON Schema 2020-12 lets `items`
  // be a boolean (`true` permits any element, `false` forbids elements);
  // AsyncAPI 3.0 / OAS 3.1 don't carry that form, so we drop it and report
  // the loss so the operator can see the gap.
  const isArrayType =
    t === 'array' ||
    (Array.isArray(schema.type) && schema.type.includes('array'));
  if (isArrayType) {
    if (typeof schema.items === 'boolean') {
      renderCtx.lossy.report({
        feature: 'asyncapi-boolean-items-dropped',
        source: {schemaId: renderCtx.schemaId},
        severity: 'warn',
        message:
          `JSON Schema 'items: ${String(schema.items)}' (boolean form) has ` +
          `no AsyncAPI 3.0 equivalent; dropped from the emitted fragment.`,
      });
    } else if (isObjectSchema(schema.items)) {
      lines.push(`${pad}items:`);
      emitSchemaBody(schema.items, lines, indent + 2, renderCtx);
    }
  }
}

/**
 * Translate a cross-document `$ref` from the engine's `<schemaId>` form
 * into the AsyncAPI `'#/components/schemas/<Name>'` reference syntax.
 * Intra-document JSON Pointer refs (already starting with `#`) and
 * absolute URLs pass through unchanged. Mirrors
 * `openapi-components-emitter.ts::rewriteRef`.
 */
function rewriteRef(ref: string): string {
  if (ref.startsWith('#')) return ref;
  if (/^[a-z]+:\/\//i.test(ref)) return ref;
  const hashIdx = ref.indexOf('#');
  const id = hashIdx === -1 ? ref : ref.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? '' : ref.slice(hashIdx);
  // Strip only the trailing `.vN` version segment so the ref targets the
  // same component key the emitter writes (`user.v1` -> `User`,
  // `acme.user.v1` -> `AcmeUser`).
  const headId = id.replace(/\.v\d+$/, '');
  return `#/components/schemas/${toPascal(headId)}${fragment}`;
}

/**
 * Surface JSON Schema composition keywords (`oneOf` / `anyOf` / `allOf`) that
 * the YAML walker silently drops. AsyncAPI 3.0 inherits JSON Schema 2020-12
 * composition in its schema sub-language; this emitter's hand-rolled walker
 * doesn't project them, so the rendered fragment reflects only base
 * `properties`/`type`/`items` with no operator signal.
 */
function reportCompositionIfPresent(
  schema: JSONSchema,
  renderCtx: RenderContext,
): void {
  if (
    !Array.isArray(schema.oneOf) &&
    !Array.isArray(schema.anyOf) &&
    !Array.isArray(schema.allOf)
  )
    return;
  renderCtx.lossy.report({
    feature: 'asyncapi-composition-dropped',
    severity: 'warn',
    source: {schemaId: renderCtx.schemaId},
    message:
      'JSON Schema oneOf/anyOf/allOf composition is not projected to ' +
      'AsyncAPI; the rendered output reflects only base ' +
      'properties/type/items.',
  });
}

function yamlString(s: string): string {
  // Quote when the value contains YAML-significant characters; otherwise emit
  // plain. JSON literal form is always a valid YAML scalar.
  if (/[:#&*!|>'"%@`{}[\],\n]/.test(s)) return JSON.stringify(s);
  if (/^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
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
