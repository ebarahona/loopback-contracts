import {BindingScope, injectable} from '@loopback/core';
import {
  ContractsPeerDepMissingError,
  ContractsValidationError,
  resolveJsonPointer,
  resolveSchemaRef,
  schemaNameStems,
  toKebab,
  toPascal,
} from '../../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReport,
  ProjectionEmitter,
  SchemaRegistry,
} from '../../interfaces';
import {ContractsBindings} from '../../keys';

// Lossy-feature labels this emitter reports for `$ref` translation. Each
// one is also listed in `STRICT_LOSSY_FEATURES`, so `--strict` turns it
// into a hard error.
const UNRESOLVED_REF = 'unresolved-$ref';
const CYCLIC_REF = 'cyclic-$ref';
const RECURSIVE_FRAGMENT_REF = 'recursive-fragment-$ref';
// Reported when a `oneOf` has a branch the upstream library would render as
// `z.any()` although it asserts something (e.g. `{required: [...]}` mixed
// with other branch shapes). The `oneOf` is dropped rather than emitted as
// a refinement that can never pass.
const UNSUPPORTED_ONE_OF = 'unsupported-oneOf';

/**
 * Lossy features the emitter promotes to hard errors in `--strict` mode.
 * The conversion library does the detection; this list is the policy gate.
 *
 * Keep entries here aligned with the feature labels the upstream library
 * reports so a new lossy translation gets caught the first time it appears
 * in a CI run rather than silently shipping.
 *
 * @see https://github.com/StefanTerdell/json-schema-to-zod
 */
const STRICT_LOSSY_FEATURES: ReadonlySet<string> = new Set([
  'z.brand',
  'z.lazy without explicit type',
  'oneOf without discriminator',
  'multipleOf precision loss',
  UNRESOLVED_REF,
  CYCLIC_REF,
  RECURSIVE_FRAGMENT_REF,
  UNSUPPORTED_ONE_OF,
]);

const PEER_DEP = 'json-schema-to-zod';

/**
 * Sidecar emitter that compiles a JSON Schema into a runtime-validated Zod
 * schema plus the inferred TS type. Used to share validators with TS
 * frontends or tRPC services without duplicating the source-of-truth schema.
 *
 * `$ref` translation (resolved the same way pipeline stage 4 validates it):
 *
 * - A ref to another registered schema imports that schema's generated
 *   export (`import {AddressSchema} from './address.zod';`). The engine's
 *   module-format pass appends the `--esm` import extension.
 * - A ref with a JSON Pointer fragment (`#/$defs/tag`, `other#/$defs/x`) is
 *   inlined from the target document.
 * - A ref that closes a cycle (self-reference, or a target that refers
 *   back to this schema) becomes `z.lazy((): z.ZodType => XSchema)`. Runtime
 *   validation is exact; the explicit annotation breaks the TypeScript
 *   inference cycle, so the inferred type of that field widens. Reported
 *   as the lossy feature `cyclic-$ref`.
 * - A fragment ref that recurses into itself cannot be inlined and becomes
 *   `z.any()` (`recursive-fragment-$ref`).
 * - A ref no loaded schema satisfies becomes `z.any()` (`unresolved-$ref`).
 *
 * `oneOf` translation:
 *
 * - "Exactly one of these keys" (every branch carries only `required`,
 *   e.g. `oneOf: [{required: ['a']}, {required: ['b']}]` next to
 *   `properties`) renders the schema without `oneOf` plus a `.superRefine`
 *   that counts the satisfied branches and requires exactly one. The
 *   inferred type keeps every property optional.
 * - A `discriminator` `oneOf` whose branches are full object schemas is
 *   left to the upstream library (`z.discriminatedUnion`), as is any
 *   `oneOf` whose branches each render to a real Zod schema.
 * - Any other `oneOf` with a branch that asserts something but has no
 *   Zod rendering (a bare `{required: [...]}` mixed with other shapes,
 *   `{minProperties: 2}`, ...) is dropped: the rest of the schema is
 *   emitted and the lossy feature `unsupported-oneOf` is reported.
 *
 * All four lossy features are warnings by default and hard errors under
 * `--strict`.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'zod',
  },
})
export class ZodEmitter implements ProjectionEmitter {
  readonly kind = 'zod';
  readonly outputSuffix = '.zod.ts';
  readonly tier = 'real-translation' as const;
  readonly description =
    'Zod sidecar (runtime validation, share with TS frontends / tRPC)';
  readonly peerDeps: string[] = [PEER_DEP];
  // Zod has no per-schema options today, but declaring the closed-object
  // shape keeps the emitter list uniform with siblings that DO take options
  // and gives a future contributor a single place to add fields without
  // re-typing the surrounding scaffolding. No `validateOptions` call here —
  // there is nothing to validate against an `additionalProperties: false`
  // schema when `options` is also empty.
  readonly perSchemaOptionsSchema = Object.freeze({
    type: 'object',
    additionalProperties: false,
  } as const);

  emit(ctx: EmitterContext): EmittedFile[] {
    const {typeStem, fileStem} = schemaNameStems(
      ctx.schema,
      'full',
      '<no-$id>',
      ctx.registry.list(),
    );
    const pascalName = toPascal(typeStem);
    const fileBase = toKebab(fileStem);

    const jsonSchemaToZod = loadJsonSchemaToZod();
    const compiler = new ZodRefCompiler(ctx, jsonSchemaToZod, pascalName);
    const zodSrc = compiler.compile(ctx.schema, ctx.schema, []);

    const content =
      `import {z} from 'zod';\n` +
      compiler.renderImports() +
      `\n` +
      `export const ${pascalName}Schema = ${zodSrc};\n` +
      `export type ${pascalName} = z.infer<typeof ${pascalName}Schema>;\n`;

    return [
      {
        path: `models/${fileBase}.zod.ts`,
        content,
        policy: 'regen',
        producer: 'zod-emitter',
      },
    ];
  }

  validate(input: {schema: JSONSchema; lossy: LossyReport}): void {
    if (!STRICT_LOSSY_FEATURES.has(input.lossy.feature)) return;
    const schemaId =
      typeof input.schema.$id === 'string' ? input.schema.$id : '<unknown>';
    throw new ContractsValidationError(
      `Zod emitter rejected lossy translation '${input.lossy.feature}' ` +
        `on schema '${schemaId}': ${input.lossy.message}`,
      {
        sourcePath: schemaId,
        instancePath: input.lossy.source.propertyPath ?? '',
        ...(typeof input.schema.$id === 'string'
          ? {schemaId: input.schema.$id}
          : {}),
      },
    );
  }
}

// Keywords that only annotate; a `$ref` carrying nothing else is a pure
// reference. `description` is re-applied with `.describe()`.
const REF_ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$ref',
  '$id',
  '$schema',
  '$anchor',
  '$comment',
  '$defs',
  'definitions',
  'title',
  'description',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

/**
 * Per-emit `$ref` translator. Drives `json-schema-to-zod` through its
 * `parserOverride` hook so every `$ref` node, at any depth, is rendered by
 * {@link ZodRefCompiler.renderRef} instead of the upstream `z.any()`
 * fallback, and collects the cross-file imports the output needs.
 */
class ZodRefCompiler {
  private readonly root: JSONSchema;
  private readonly registry: SchemaRegistry;
  private readonly ownExport: string;
  // module specifier -> (exported name -> local name)
  private readonly imports = new Map<string, Map<string, string>>();
  private readonly usedLocals = new Set<string>();
  // `<doc id>#<pointer>` of fragments currently being inlined.
  private readonly inlining = new Set<string>();
  private readonly reachesRootCache = new Map<JSONSchema, boolean>();

  constructor(
    private readonly ctx: EmitterContext,
    private readonly jsonSchemaToZod: JsonSchemaToZodFn,
    pascalName: string,
  ) {
    this.root = ctx.schema;
    this.registry = ctx.registry;
    this.ownExport = `${pascalName}Schema`;
    this.usedLocals.add('z');
    this.usedLocals.add(this.ownExport);
  }

  /**
   * Render `node` (a subschema of `document`) as a Zod expression.
   * `module: 'none'` makes the upstream renderer return a bare expression
   * with no `import` / `module.exports` wrapper; the emitter writes its own
   * imports.
   */
  compile(node: JSONSchema, document: JSONSchema, path: string[]): string {
    return this.jsonSchemaToZod(node, {
      module: 'none',
      path,
      parserOverride: (schema: unknown, refs: {path?: unknown}) => {
        if (schema === null || typeof schema !== 'object') return undefined;
        const at = Array.isArray(refs.path) ? refs.path.map(String) : path;
        const ref = (schema as {$ref?: unknown}).$ref;
        if (typeof ref === 'string') {
          return this.renderRefNode(schema as JSONSchema, ref, document, at);
        }
        const oneOf = (schema as {oneOf?: unknown}).oneOf;
        if (Array.isArray(oneOf) && oneOf.length > 1) {
          return this.renderOneOf(schema as JSONSchema, oneOf, document, at);
        }
        return undefined;
      },
    });
  }

  /** `import` lines for every referenced schema, sorted by specifier. */
  renderImports(): string {
    return [...this.imports.keys()]
      .sort()
      .map(specifier => {
        const names = [...(this.imports.get(specifier) ?? new Map())]
          .map(([exported, local]) =>
            exported === local ? exported : `${exported} as ${local}`,
          )
          .sort()
          .join(', ');
        return `import {${names}} from '${specifier}';\n`;
      })
      .join('');
  }

  // A `$ref` node may carry sibling keywords; 2020-12 applies them
  // alongside the reference, so anything beyond annotations is intersected.
  private renderRefNode(
    node: JSONSchema,
    ref: string,
    document: JSONSchema,
    path: string[],
  ): string {
    let out = this.renderRef(ref, document, path);
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (!REF_ANNOTATION_KEYWORDS.has(key)) rest[key] = value;
    }
    if (Object.keys(rest).length > 0) {
      out = `${out}.and(${this.compile(rest as JSONSchema, document, path)})`;
    }
    if (typeof node.description === 'string') {
      out = `${out}.describe(${JSON.stringify(node.description)})`;
    }
    return out;
  }

  /**
   * Handle the `oneOf` shapes the upstream renderer gets wrong (see the
   * class docs); `undefined` leaves the node to the upstream renderer.
   */
  private renderOneOf(
    node: JSONSchema,
    branches: readonly unknown[],
    document: JSONSchema,
    path: string[],
  ): string | undefined {
    const requiredSets = branches.map(requiredOnlyBranch);
    const unsupported = branches.some(isUnrenderableBranch);
    if (!unsupported) return undefined;

    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'oneOf' && key !== 'discriminator') rest[key] = value;
    }
    const base = this.compile(rest as JSONSchema, document, path);

    if (requiredSets.every(set => set !== undefined)) {
      const sets = JSON.stringify(requiredSets);
      const label = requiredSets.map(set => (set ?? []).join(' + ')).join(', ');
      const message = JSON.stringify(
        `Exactly one of the following must be provided: ${label}`,
      );
      return (
        `${base}.superRefine((value, ctx) => {\n` +
        // A non-object (possible when the rest of the schema is untyped)
        // satisfies no branch here; JSON Schema would have it satisfy every
        // `required` branch. Both fail an exactly-one check with 2+ branches.
        `    const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;\n` +
        `    const matched = (${sets} as string[][]).filter(keys =>\n` +
        `      keys.every(k => v[k] !== undefined),\n` +
        `    ).length;\n` +
        `    if (matched !== 1) {\n` +
        `      ctx.addIssue({code: 'custom', message: ${message}});\n` +
        `    }\n` +
        `  })`
      );
    }

    this.lossy(
      UNSUPPORTED_ONE_OF,
      [...path, 'oneOf'],
      `oneOf has a branch with no Zod rendering (only keywords such as ` +
        `'required' / 'minProperties'); the oneOf constraint was dropped ` +
        `from the emitted schema.`,
      'Give every oneOf branch a full shape (type + properties), or use ' +
        'the exactly-one-of pattern: every branch only `{required: [...]}`.',
    );
    return base;
  }

  private renderRef(ref: string, document: JSONSchema, path: string[]): string {
    const resolved = resolveSchemaRef(ref, document, this.registry);
    if (resolved === undefined) {
      return this.lossy(
        UNRESOLVED_REF,
        path,
        `$ref '${ref}' does not match any loaded schema; emitted z.any().`,
        'Load the referenced schema, or fix the $ref / $id.',
      );
    }
    const {document: target, id, pointer} = resolved;

    if (pointer === '' || pointer === '/') {
      if (this.isRoot(target, id)) {
        this.lossy(
          CYCLIC_REF,
          path,
          `$ref '${ref}' refers to this schema; emitted z.lazy() typed as ` +
            `z.ZodType, so the inferred TypeScript type of this field widens.`,
        );
        return `z.lazy((): z.ZodType => ${this.ownExport})`;
      }
      const local = this.importFor(target);
      if (this.reachesRoot(target)) {
        this.lossy(
          CYCLIC_REF,
          path,
          `$ref '${ref}' closes a cycle back to this schema; emitted ` +
            `z.lazy() typed as z.ZodType, so the inferred TypeScript type ` +
            `of this field widens.`,
        );
        return `z.lazy((): z.ZodType => ${local})`;
      }
      return local;
    }

    const key = `${id}#${pointer}`;
    const sub = resolveJsonPointer(target, pointer);
    if (sub === undefined) {
      return this.lossy(
        UNRESOLVED_REF,
        path,
        `$ref '${ref}' does not resolve: '${id || '<root>'}' has no ` +
          `'#${pointer}'; emitted z.any().`,
        'Fix the JSON Pointer or add the missing $defs entry.',
      );
    }
    if (this.inlining.has(key)) {
      return this.lossy(
        RECURSIVE_FRAGMENT_REF,
        path,
        `$ref '${ref}' recurses into itself; fragment refs are inlined, so ` +
          `the recursive occurrence is emitted as z.any().`,
        'Move the recursive shape into its own schema file and $ref it by $id.',
      );
    }
    this.inlining.add(key);
    try {
      return this.compile(sub, target, path);
    } finally {
      this.inlining.delete(key);
    }
  }

  private isRoot(target: JSONSchema, id: string): boolean {
    return target === this.root || (id !== '' && id === this.root.$id);
  }

  // Register (once) the import of `target`'s generated export and return
  // the local binding name, aliasing when two targets share a name.
  private importFor(target: JSONSchema): string {
    const {typeStem, fileStem} = schemaNameStems(
      target,
      'full',
      '<no-$id>',
      this.ctx.registry.list(),
    );
    const exported = `${toPascal(typeStem)}Schema`;
    const specifier = `./${toKebab(fileStem)}.zod`;
    let names = this.imports.get(specifier);
    const existing = names?.get(exported);
    if (existing !== undefined) return existing;
    let local = exported;
    if (this.usedLocals.has(local)) {
      const base = `${toPascal(fileStem)}Schema`;
      local = base;
      for (let n = 2; this.usedLocals.has(local); n++) local = `${base}${n}`;
    }
    this.usedLocals.add(local);
    if (names === undefined) {
      names = new Map();
      this.imports.set(specifier, names);
    }
    names.set(exported, local);
    return local;
  }

  // Whether `start` refers (transitively, across documents) back to the
  // schema being emitted.
  private reachesRoot(start: JSONSchema): boolean {
    const cached = this.reachesRootCache.get(start);
    if (cached !== undefined) return cached;
    const seen = new Set<JSONSchema>([start]);
    const queue: JSONSchema[] = [start];
    let found = false;
    while (queue.length > 0 && !found) {
      const doc = queue.shift() as JSONSchema;
      for (const ref of collectRefs(doc)) {
        const hit = resolveSchemaRef(ref, doc, this.registry);
        if (hit === undefined) continue;
        if (this.isRoot(hit.document, hit.id)) {
          found = true;
          break;
        }
        if (!seen.has(hit.document)) {
          seen.add(hit.document);
          queue.push(hit.document);
        }
      }
    }
    this.reachesRootCache.set(start, found);
    return found;
  }

  private lossy(
    feature: string,
    path: string[],
    message: string,
    workaround?: string,
  ): string {
    this.ctx.lossy.report({
      feature,
      source: {
        schemaId: typeof this.root.$id === 'string' ? this.root.$id : '',
        propertyPath: path
          .map(seg => '/' + seg.replace(/~/g, '~0').replace(/\//g, '~1'))
          .join(''),
      },
      severity: 'warn',
      message,
      ...(workaround !== undefined ? {workaround} : {}),
    });
    return 'z.any()';
  }
}

// Keywords a `oneOf` branch may carry without changing what it asserts.
const BRANCH_ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  '$comment',
  'title',
  'description',
  'examples',
  'deprecated',
]);

// Keywords the upstream renderer turns into a real Zod schema even without
// a `type` (anything else, untyped, renders as `z.any()`).
const RENDERABLE_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  '$ref',
  'properties',
  'additionalProperties',
  'patternProperties',
  'items',
  'prefixItems',
  'const',
  'enum',
  'anyOf',
  'allOf',
  'oneOf',
  'not',
  'if',
]);

// The `required` list of a branch that asserts nothing else, or `undefined`.
function requiredOnlyBranch(branch: unknown): string[] | undefined {
  if (branch === null || typeof branch !== 'object' || Array.isArray(branch)) {
    return undefined;
  }
  const {required, ...rest} = branch as Record<string, unknown>;
  if (
    !Array.isArray(required) ||
    required.length === 0 ||
    !required.every(k => typeof k === 'string')
  ) {
    return undefined;
  }
  if (Object.keys(rest).some(k => !BRANCH_ANNOTATION_KEYWORDS.has(k))) {
    return undefined;
  }
  return required as string[];
}

// A branch that asserts something the upstream renderer drops (it would
// render as `z.any()`, so the generated exactly-one check could never pass).
function isUnrenderableBranch(branch: unknown): boolean {
  if (branch === null || typeof branch !== 'object' || Array.isArray(branch)) {
    return false;
  }
  const keys = Object.keys(branch).filter(
    k => !BRANCH_ANNOTATION_KEYWORDS.has(k),
  );
  return keys.length > 0 && !keys.some(k => RENDERABLE_KEYWORDS.has(k));
}

// Every `$ref` string anywhere in a document.
function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

// Signature of the relevant export from `json-schema-to-zod`. Declared
// locally so the public `.d.ts` surface stays free of an optional peer-dep
// type import (the peer is only required at emit time).
type JsonSchemaToZodFn = (
  schema: unknown,
  opts?: Record<string, unknown>,
) => string;

interface JsonSchemaToZodModule {
  jsonSchemaToZod: JsonSchemaToZodFn;
  default?: JsonSchemaToZodFn;
}

/**
 * Load the optional `json-schema-to-zod` peer-dep lazily and surface a
 * typed {@link ContractsPeerDepMissingError} when it is absent so the CLI
 * can prompt the user to `npm install` the right package.
 */
function loadJsonSchemaToZod(): JsonSchemaToZodFn {
  let mod: JsonSchemaToZodModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(PEER_DEP) as JsonSchemaToZodModule;
  } catch (err) {
    const code = (err as {code?: unknown} | null)?.code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new ContractsPeerDepMissingError({
        emitterKind: 'zod',
        packageName: PEER_DEP,
      });
    }
    throw err;
  }
  return (
    mod.jsonSchemaToZod ?? mod.default ?? (mod as unknown as JsonSchemaToZodFn)
  );
}
