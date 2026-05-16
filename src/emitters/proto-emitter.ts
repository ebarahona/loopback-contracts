import {BindingScope, injectable} from '@loopback/core';
import Ajv2020 from 'ajv/dist/2020';
import {
  ContractsCodegenError,
  ContractsPeerDepMissingError,
  ContractsValidationError,
  splitWords,
  toKebab,
  toPascal,
} from '../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReporter,
  ProjectionEmitter,
} from '../interfaces';
import {ContractsBindings} from '../keys';

const PEER_DEP = 'quicktype-core';

/**
 * Per-schema options block read from the source schema's `x-proto` keyword.
 */
interface ProtoPerSchemaOptions {
  package?: string;
  javaPackage?: string;
  goPackage?: string;
}

/**
 * Catalog of quicktype-core failure shapes the emitter treats as "soft" —
 * known unsupported keywords / draft mismatches / missing language targets
 * that warrant the hand-rolled fallback. Anything else is surfaced as a hard
 * {@link ContractsCodegenError} so misconfigured schemas don't silently
 * degrade to a likely-wrong file.
 *
 * - `unsupported` / `not implemented` — quicktype refused a keyword.
 * - `cannot convert` — quicktype hit a draft mismatch it couldn't translate.
 * - `unknown language name` — newer quicktype-core releases dropped the
 *   bundled `protobuf` renderer; treat as a hint that the upstream library
 *   no longer ships the target and rely on the hand-rolled walker.
 */
const SOFT_QUICKTYPE_ERROR_FRAGMENTS: ReadonlyArray<string> = [
  'unsupported',
  'not implemented',
  'cannot convert',
  'unknown language name',
];

/**
 * Sidecar emitter that projects a JSON Schema to a `.proto` (proto3) file
 * suitable for gRPC consumers in any language.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'proto',
  },
})
export class ProtoEmitter implements ProjectionEmitter<ProtoPerSchemaOptions> {
  readonly kind = 'proto';
  readonly outputSuffix = '.proto';
  readonly tier = 'real-translation' as const;
  readonly description =
    'Protocol Buffers schema (for gRPC consumers in any language)';
  readonly peerDeps: string[] = [PEER_DEP];
  readonly perSchemaOptionsSchema: JSONSchema = {
    type: 'object',
    properties: {
      package: {type: 'string'},
      javaPackage: {type: 'string'},
      goPackage: {type: 'string'},
    },
    additionalProperties: false,
  };

  async emit(
    ctx: EmitterContext<ProtoPerSchemaOptions>,
  ): Promise<EmittedFile[]> {
    const options = validateOptions<ProtoPerSchemaOptions>(
      this.kind,
      this.perSchemaOptionsSchema,
      ctx.options,
    );

    const quicktype = loadQuicktypeCore();
    const schemaId = typeof ctx.schema.$id === 'string' ? ctx.schema.$id : '';
    const messageName = toPascal(schemaId || 'Message');
    const fileBase = toKebab(schemaId || 'message');
    const pkg = options.package ?? toSnake(schemaId || 'contracts');

    let proto: string;
    try {
      proto = await renderWithQuicktype(quicktype, ctx.schema, messageName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isSoftQuicktypeFailure(message)) {
        throw new ContractsCodegenError(
          `quicktype failed unexpectedly: ${message}`,
          {emitterKind: 'proto', schemaId},
          {cause: err},
        );
      }
      // Soft failure: quicktype refused a keyword it doesn't model — fall back
      // to the hand-rolled walker so the pipeline still produces a useful file.
      ctx.lossy.report({
        feature: 'proto-quicktype-fallback',
        severity: 'warn',
        source: {schemaId, propertyPath: ''},
        message: `quicktype could not project schema '${schemaId}' to protobuf (${message}); using hand-rolled fallback (no $ref resolution, no cycle detection — see proto-emitter.ts:283-293 for parity gap).`,
      });
      proto = renderHandRolled(ctx.schema, messageName, schemaId, ctx.lossy);
    }

    const normalized = ensureProto3Header(proto, pkg, options);
    return [
      {
        path: `models/${fileBase}.proto`,
        content: normalized,
        headerComment: '//',
        policy: 'regen',
        producer: 'proto-emitter',
      },
    ];
  }
}

/**
 * Well-known proto3 import paths. `google.protobuf.Struct` requires
 * `import "google/protobuf/struct.proto";` to compile under `protoc`; the
 * header normaliser uses this map (rather than a string-search) so future
 * well-known types (e.g. `Timestamp`, `Duration`) can be added without
 * coupling header generation to the body walker.
 */
const WELL_KNOWN_PROTO_IMPORTS: ReadonlyArray<{
  symbol: string;
  importPath: string;
}> = [
  {
    symbol: 'google.protobuf.Struct',
    importPath: 'google/protobuf/struct.proto',
  },
];

/**
 * Detect a "soft" quicktype-core failure — one whose message indicates the
 * library refused an unsupported keyword. Anything else is propagated as an
 * unexpected error so users hear about real bugs instead of silently getting
 * a degraded `.proto`.
 */
function isSoftQuicktypeFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return SOFT_QUICKTYPE_ERROR_FRAGMENTS.some(fragment =>
    lower.includes(fragment),
  );
}

/**
 * Validate `ctx.options` against the emitter's declared
 * `perSchemaOptionsSchema` with Ajv 2020. Empty / missing options pass
 * through; structural violations raise a typed
 * {@link ContractsValidationError} so the CLI can render a precise pointer.
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

// ---------- quicktype-core driver ---------------------------------------

interface QuicktypeCoreModule {
  quicktype: (opts: {
    inputData: unknown;
    lang: string;
    rendererOptions?: Record<string, string>;
  }) => Promise<{lines: string[]}>;
  InputData: new () => {
    addInput(input: unknown): Promise<void> | void;
  };
  JSONSchemaInput: new (
    store: unknown,
    additionalSchemaAddresses?: ReadonlyArray<string>,
  ) => {
    addSource(src: {name: string; schema: string}): Promise<void>;
  };
}

function loadQuicktypeCore(): QuicktypeCoreModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(PEER_DEP) as QuicktypeCoreModule;
  } catch (err) {
    const code = (err as {code?: unknown} | null)?.code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new ContractsPeerDepMissingError({
        emitterKind: 'proto',
        packageName: PEER_DEP,
      });
    }
    throw err;
  }
}

async function renderWithQuicktype(
  qt: QuicktypeCoreModule,
  schema: JSONSchema,
  messageName: string,
): Promise<string> {
  // `JSONSchemaInput` accepts `undefined` for the store argument (per the
  // upstream typings); passing `null` triggers a runtime "Cannot read
  // properties of null" inside quicktype-core's ref-store lookup path.
  const input = new qt.JSONSchemaInput(undefined);
  await input.addSource({
    name: messageName,
    schema: JSON.stringify(schema),
  });
  const inputData = new qt.InputData();
  await inputData.addInput(input);
  const result = await qt.quicktype({inputData, lang: 'protobuf'});
  return result.lines.join('\n');
}

// quicktype-core does not ship protobuf in every release, and the renderer
// is documented as best-effort. `ensureProto3Header` and `renderHandRolled`
// guarantee a deterministic, syntactically-valid proto3 file even when the
// upstream renderer omits the syntax line or refuses the schema entirely.

function ensureProto3Header(
  proto: string,
  pkg: string,
  options?: ProtoPerSchemaOptions,
): string {
  const lines: string[] = [];
  const hasSyntax = /^\s*syntax\s*=\s*"proto3"/m.test(proto);
  if (!hasSyntax) lines.push('syntax = "proto3";');
  const hasPackage = /^\s*package\s+/m.test(proto);
  if (!hasPackage) lines.push(`package ${pkg};`);
  // Scan the body for well-known proto types and synthesize the matching
  // `import "..."` statements when the upstream renderer (quicktype or the
  // hand-rolled walker) omitted them. Without this the generated `.proto`
  // won't compile under `protoc` for any schema with an anonymous nested
  // object (collapsed to `google.protobuf.Struct` by the hand-rolled
  // walker).
  for (const {symbol, importPath} of WELL_KNOWN_PROTO_IMPORTS) {
    const usesSymbol = proto.includes(symbol);
    const alreadyImported = new RegExp(
      `import\\s+"${importPath.replace(/\./g, '\\.').replace(/\//g, '\\/')}"`,
    ).test(proto);
    if (usesSymbol && !alreadyImported) {
      lines.push(`import "${importPath}";`);
    }
  }
  if (
    options?.javaPackage !== undefined &&
    !/option\s+java_package/.test(proto)
  ) {
    lines.push(`option java_package = "${options.javaPackage}";`);
  }
  if (options?.goPackage !== undefined && !/option\s+go_package/.test(proto)) {
    lines.push(`option go_package = "${options.goPackage}";`);
  }
  if (lines.length === 0) return proto;
  const sep = proto.startsWith('\n') ? '' : '\n';
  return `${lines.join('\n')}${sep}${sep}${proto}`;
}

// ---------- hand-rolled fallback ----------------------------------------

// TODO(parity-gap): this fallback has no `$ref` resolution and no cycle
// detection — unlike `avro-emitter`'s walker which threads a visited-stack
// {@link import('./avro-emitter')#ConvertContext} through every recursion.
// We deliberately do NOT implement it here: the fallback only fires when
// quicktype emits a "soft" failure (the `SOFT_QUICKTYPE_ERROR_FRAGMENTS`
// list above), which in practice means the schema is too simple for refs
// to matter, AND the avro implementation is non-trivial enough that we'd
// rather wait for a real proto-with-refs report from a user than build it
// speculatively. When that report lands, port `avro-emitter::resolveRef`
// + `buildInlineRecord` + the `visited: Map` plumbing into a
// `ConvertContext` here.
function renderHandRolled(
  schema: JSONSchema,
  messageName: string,
  schemaId: string,
  lossy: LossyReporter,
): string {
  reportProtoCompositionIfPresent(schema, '', schemaId, lossy);
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const lines: string[] = [`message ${messageName} {`];
  let fieldNum = 1;
  for (const [name, prop] of Object.entries(props)) {
    reportProtoCompositionIfPresent(prop, name, schemaId, lossy);
    const protoType = jsonSchemaToProtoType(prop);
    const repeated = prop.type === 'array' ? 'repeated ' : '';
    const optionalMarker = required.has(name) || repeated ? '' : 'optional ';
    lines.push(
      `  ${optionalMarker}${repeated}${protoType} ${name} = ${fieldNum};`,
    );
    fieldNum++;
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * Surface JSON Schema composition keywords (`oneOf` / `anyOf` / `allOf`) that
 * the hand-rolled proto walker silently drops. proto3 lacks a generic
 * sum-type encoding (`oneof` only covers field-level alternation, not
 * arbitrary schema composition), so the rendered `.proto` would otherwise
 * reflect only base `properties`/`type`/`items` with no operator signal.
 */
function reportProtoCompositionIfPresent(
  prop: JSONSchema,
  propertyPath: string,
  schemaId: string,
  lossy: LossyReporter,
): void {
  if (
    !Array.isArray(prop.oneOf) &&
    !Array.isArray(prop.anyOf) &&
    !Array.isArray(prop.allOf)
  )
    return;
  lossy.report({
    feature: 'proto-composition-dropped',
    severity: 'warn',
    source: {schemaId, propertyPath},
    message:
      'JSON Schema oneOf/anyOf/allOf composition is not projected to proto; ' +
      'the rendered output reflects only base properties/type/items.',
  });
}

function jsonSchemaToProtoType(prop: JSONSchema): string {
  const t = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  switch (t) {
    case 'string':
      return 'string';
    case 'integer':
      return mapIntegerFormat(prop['format']);
    case 'number':
      return prop['format'] === 'float' ? 'float' : 'double';
    case 'boolean':
      return 'bool';
    case 'array': {
      const items = (prop.items as JSONSchema | undefined) ?? {type: 'string'};
      return jsonSchemaToProtoType(items);
    }
    case 'object':
      return 'google.protobuf.Struct';
    default:
      return 'string';
  }
}

/**
 * Map an OpenAPI / JSON-Schema integer `format` hint to the matching proto3
 * scalar type. Defaults to `int64` when `format` is absent or unknown
 * (largest signed range, the safest "I don't know" projection).
 */
function mapIntegerFormat(format: unknown): string {
  switch (format) {
    case 'int32':
      return 'int32';
    case 'int64':
      return 'int64';
    case 'uint32':
      return 'uint32';
    case 'uint64':
      return 'uint64';
    case 'sint32':
      return 'sint32';
    case 'sint64':
      return 'sint64';
    case 'fixed32':
      return 'fixed32';
    case 'fixed64':
      return 'fixed64';
    case 'sfixed32':
      return 'sfixed32';
    case 'sfixed64':
      return 'sfixed64';
    default:
      return 'int64';
  }
}

// ---------- casing helpers ----------------------------------------------

// `toPascal` / `toKebab` come from `../helpers/identifiers` (shared with
// every other emitter). `toSnake` stays local — proto-specific helper for
// the `package` directive, no demand for it elsewhere yet.
function toSnake(s: string): string {
  return splitWords(s).join('_');
}
