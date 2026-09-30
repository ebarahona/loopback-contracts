import {BindingScope, injectable} from '@loopback/core';
import {
  ContractsPeerDepMissingError,
  ContractsValidationError,
  resolveSchemaRef,
  schemaNameStems,
  toKebab,
  toPascal,
  walkJsonPointer,
} from '../../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  LossyReport,
  ProjectionEmitter,
} from '../../interfaces';
import {ContractsBindings} from '../../keys';

const PEER_DEP = 'json-schema-to-typescript';

// Lossy-feature labels this emitter reports for `$ref` translation. They
// match the Zod emitter's labels and both become hard errors under
// `--strict`.
const UNRESOLVED_REF = 'unresolved-$ref';
const RECURSIVE_FRAGMENT_REF = 'recursive-fragment-$ref';
const STRICT_LOSSY_FEATURES: ReadonlySet<string> = new Set([
  UNRESOLVED_REF,
  RECURSIVE_FRAGMENT_REF,
]);

/**
 * Sidecar emitter that compiles a JSON Schema into pure TypeScript
 * interfaces (no runtime). Used to share types with monorepo workers,
 * background jobs, or CLI tools that should not pull the LB4 runtime.
 *
 * Returns a `Promise` from `emit()` because the upstream `compile()` call
 * is async-only; the engine runner `await`s the result.
 *
 * Every file exports its root type under the schema's canonical name
 * (`toPascal` of {@link schemaNameStems}' `typeStem`, the same name the Zod
 * emitter uses); when the upstream compiler derives a different name (from
 * `title`), a `export type <Canonical> = <Derived>;` alias is appended.
 *
 * `$ref` translation (resolved the same way pipeline stage 4 validates it,
 * mirroring the Zod emitter):
 *
 * - A ref to another registered schema imports that schema's root type
 *   (`import type {Money} from './money.types';`). The engine's
 *   module-format pass appends the `--esm` import extension.
 * - A ref to this schema itself names the root type (TypeScript allows the
 *   recursion).
 * - A ref with a JSON Pointer fragment (`#/$defs/tag`, `money#/$defs/x`) is
 *   inlined from the target document. A titled fragment still becomes a
 *   named declaration in this file.
 * - A fragment ref that recurses into itself becomes `unknown`
 *   (`recursive-fragment-$ref`).
 * - A ref no loaded schema satisfies, or a pointer that does not exist,
 *   becomes `unknown` (`unresolved-$ref`).
 *
 * Both lossy features are warnings by default and hard errors under
 * `--strict`.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'types',
  },
})
export class TypesEmitter implements ProjectionEmitter {
  readonly kind = 'types';
  readonly outputSuffix = '.types.ts';
  readonly tier = 'real-translation' as const;
  readonly description =
    'Pure TS interfaces (share types with monorepo workers without LB4 weight)';
  readonly peerDeps: string[] = [PEER_DEP];
  // The types emitter accepts no per-schema options today; declaring the
  // closed-object shape (`additionalProperties: false`) keeps the emitter
  // list uniform with siblings that DO take options and gives a future
  // contributor a single place to add fields. No `validateOptions` call is
  // needed — there's nothing to validate against an empty closed object
  // when `options` is also empty.
  readonly perSchemaOptionsSchema = Object.freeze({
    type: 'object',
    additionalProperties: false,
  } as const);

  async emit(ctx: EmitterContext): Promise<EmittedFile[]> {
    const schemaId = ctx.schema.$id ?? '<no-$id>';
    const {typeStem, fileStem} = schemaNameStems(
      ctx.schema,
      'full',
      schemaId,
      ctx.registry.list(),
    );
    const pascalName = toPascal(typeStem);
    const fileBase = toKebab(fileStem);

    // Rewrite every `$ref` before compiling (see the class docs). Without
    // this step `json-schema-to-typescript` hands $id-style refs to
    // `@apidevtools/json-schema-ref-parser`, which treats them as relative
    // filesystem paths and crashes on `ENOENT` (or on a dangling pointer).
    const preparer = new TypesRefPreparer(ctx, pascalName);
    const prepared = preparer.prepare();

    const {compile} = loadJsonSchemaToTypescript();
    // `bannerComment: ''` suppresses the upstream "DO NOT MODIFY" header so
    // the engine's FileWriter can prepend its own canonical banner without a
    // duplicate.
    //
    // `additionalProperties` honors the source schema's value when present;
    // when the key is omitted we default to `true` (open type — TypeScript's
    // own convention for unsealed interfaces). Authors who want a sealed type
    // declare `additionalProperties: false` on the schema explicitly.
    //
    // `$refOptions.resolve.{file,http}: false` disables the upstream
    // ref-parser's filesystem and HTTP loaders; no `$ref` survives
    // preparation, so this is a guard only.
    // `ignoreMinAndMaxItems: true` keeps `minItems` / `maxItems` arrays as
    // `T[]`; the upstream default renders them as tuples (`[T, ...T[]]`),
    // which are awkward to build and assign. The bounds stay in the JSDoc
    // and are enforced by the Zod / Ajv validators, not the static type.
    // `declareExternallyReferenced: true` declares every titled subschema
    // (including inlined `$defs` fragments) the root type names; cross-
    // schema types are imported rather than declared here.
    // `json-schema-to-typescript`'s `compile()` option only accepts
    // `boolean | 'preserve'`. The source schema may legally carry a full
    // sub-schema in `additionalProperties` (e.g., `{type: 'string'}`); we
    // can't pass that downstream without breaking the compiler, so we
    // coerce to the closest legal value (`true` — open type, matches our
    // default for omitted keys) and surface a lossy report so the operator
    // sees the dropped detail.
    const sourceAdditional = ctx.schema['additionalProperties'];
    let additionalProperties: boolean | 'preserve';
    if (typeof sourceAdditional === 'boolean') {
      additionalProperties = sourceAdditional;
    } else if (sourceAdditional === 'preserve') {
      additionalProperties = 'preserve';
    } else if (sourceAdditional === undefined) {
      additionalProperties = true;
    } else {
      additionalProperties = true;
      ctx.lossy.report({
        feature: 'types-additional-properties-flattened',
        source: {
          schemaId: String(schemaId),
          propertyPath: '/additionalProperties',
        },
        severity: 'warn',
        message:
          `Source schema declares 'additionalProperties' as an object ` +
          `shape; 'json-schema-to-typescript' only accepts boolean | ` +
          `'preserve'. Defaulted to 'true' (open type); the inner shape is ` +
          `not enforced in the emitted .types.ts.`,
      });
    }
    const compiled = await compile(
      prepared as Parameters<typeof compile>[0],
      pascalName,
      {
        bannerComment: '',
        additionalProperties,
        declareExternallyReferenced: true,
        ignoreMinAndMaxItems: true,
        $refOptions: {resolve: {file: false, http: false}},
      },
    );
    // The upstream compiler emits the root declaration first.
    const rootName = /^export (?:interface|type) (\w+)/m.exec(compiled)?.[1];
    const alias =
      rootName !== undefined && rootName !== pascalName
        ? `export type ${pascalName} = ${rootName};\n`
        : '';
    const imports = preparer.renderImports();
    const content = (imports === '' ? '' : `${imports}\n`) + compiled + alias;

    return [
      {
        path: `models/${fileBase}.types.ts`,
        content,
        policy: 'regen',
        producer: 'types-emitter',
      },
    ];
  }

  validate(input: {schema: JSONSchema; lossy: LossyReport}): void {
    if (!STRICT_LOSSY_FEATURES.has(input.lossy.feature)) return;
    const schemaId =
      typeof input.schema.$id === 'string' ? input.schema.$id : '<unknown>';
    throw new ContractsValidationError(
      `Types emitter rejected lossy translation '${input.lossy.feature}' ` +
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

// Subset of the `json-schema-to-typescript` surface the emitter consumes.
// Declared structurally so the public `.d.ts` does not require an optional
// peer-dep type import.
interface JsonSchemaToTypescriptModule {
  compile(
    schema: unknown,
    name: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
}

/**
 * Load the optional `json-schema-to-typescript` peer-dep lazily so engine
 * startup does not require it; convert a missing module into the typed
 * {@link ContractsPeerDepMissingError} so the CLI can render the precise
 * `npm install` hint.
 */
function loadJsonSchemaToTypescript(): JsonSchemaToTypescriptModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(PEER_DEP) as JsonSchemaToTypescriptModule;
  } catch (err) {
    const code = (err as {code?: unknown} | null)?.code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new ContractsPeerDepMissingError({
        emitterKind: 'types',
        packageName: PEER_DEP,
      });
    }
    throw err;
  }
}

/**
 * Per-emit `$ref` rewriter. Clones the root schema with every `$ref`
 * replaced (see {@link TypesEmitter}) so the upstream compiler never
 * dereferences anything, and collects the `import type` lines the output
 * needs.
 */
class TypesRefPreparer {
  private readonly root: JSONSchema;
  // module specifier -> (exported name -> local name)
  private readonly imports = new Map<string, Map<string, string>>();
  private readonly usedLocals = new Set<string>();
  // `<doc id>#<pointer>` of fragments currently being inlined.
  private readonly inlining = new Set<string>();
  // Inlined fragments, reused by identity so the upstream compiler declares
  // a titled fragment once however often it is referenced.
  private readonly inlined = new Map<string, unknown>();

  constructor(
    private readonly ctx: EmitterContext,
    private readonly rootName: string,
  ) {
    this.root = ctx.schema;
    this.usedLocals.add(rootName);
  }

  prepare(): JSONSchema {
    // Root `$defs` are only reachable through fragment refs, which are
    // inlined, so they are dropped rather than rewritten.
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.root)) {
      if (key !== '$defs' && key !== 'definitions') rest[key] = value;
    }
    return this.walk(rest, this.root, []) as JSONSchema;
  }

  /** `import type` lines for every referenced schema, sorted. */
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
        return `import type {${names}} from '${specifier}';\n`;
      })
      .join('');
  }

  private walk(node: unknown, document: JSONSchema, path: string[]): unknown {
    if (Array.isArray(node)) {
      return node.map((child, i) =>
        this.walk(child, document, [...path, `${i}`]),
      );
    }
    if (node === null || typeof node !== 'object') return node;
    const src = node as Record<string, unknown>;
    const ref = src['$ref'];
    if (typeof ref === 'string')
      return this.renderRef(src, ref, document, path);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
      out[key] = this.walk(value, document, [...path, key]);
    }
    return out;
  }

  // Keeps only `description` from the `$ref` node's siblings; the upstream
  // compiler targets draft-07, where `$ref` siblings are ignored.
  private renderRef(
    node: Record<string, unknown>,
    ref: string,
    document: JSONSchema,
    path: string[],
  ): unknown {
    const described = (schema: Record<string, unknown>): unknown =>
      typeof node['description'] === 'string'
        ? {...schema, description: node['description']}
        : schema;

    const resolved = resolveSchemaRef(ref, document, this.ctx.registry);
    if (resolved === undefined) {
      this.lossy(
        UNRESOLVED_REF,
        path,
        `$ref '${ref}' does not match any loaded schema; emitted unknown.`,
        'Load the referenced schema, or fix the $ref / $id.',
      );
      return described({});
    }
    const {document: target, id, pointer} = resolved;

    if (pointer === '') {
      const name =
        target === this.root || (id !== '' && id === this.root.$id)
          ? this.rootName
          : this.importFor(target);
      return described({tsType: name});
    }

    const key = `${id}#${pointer}`;
    const sub = walkJsonPointer(target, pointer);
    if (sub === undefined || sub === null || typeof sub !== 'object') {
      if (typeof sub === 'boolean') return sub;
      this.lossy(
        UNRESOLVED_REF,
        path,
        `$ref '${ref}' does not resolve: '${id || '<root>'}' has no ` +
          `'#${pointer}'; emitted unknown.`,
        'Fix the JSON Pointer or add the missing $defs entry.',
      );
      return described({});
    }
    if (this.inlining.has(key)) {
      this.lossy(
        RECURSIVE_FRAGMENT_REF,
        path,
        `$ref '${ref}' recurses into itself; fragment refs are inlined, so ` +
          `the recursive occurrence is emitted as unknown.`,
        'Move the recursive shape into its own schema file and $ref it by $id.',
      );
      return described({});
    }
    let out = this.inlined.get(key);
    if (out === undefined) {
      this.inlining.add(key);
      try {
        out = this.walk(sub, target, path);
      } finally {
        this.inlining.delete(key);
      }
      this.inlined.set(key, out);
    }
    return typeof out === 'object' && out !== null
      ? described(out as Record<string, unknown>)
      : out;
  }

  // Register (once) the import of `target`'s root type and return the local
  // binding name, aliasing when two targets share a name.
  private importFor(target: JSONSchema): string {
    const {typeStem, fileStem} = schemaNameStems(
      target,
      'full',
      '<no-$id>',
      this.ctx.registry.list(),
    );
    const exported = toPascal(typeStem);
    const specifier = `./${toKebab(fileStem)}.types`;
    let names = this.imports.get(specifier);
    const existing = names?.get(exported);
    if (existing !== undefined) return existing;
    let local = exported;
    if (this.usedLocals.has(local)) {
      const base = toPascal(fileStem);
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

  private lossy(
    feature: string,
    path: string[],
    message: string,
    workaround: string,
  ): void {
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
      workaround,
    });
  }
}
