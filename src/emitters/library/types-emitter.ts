import {BindingScope, injectable} from '@loopback/core';
import {ContractsPeerDepMissingError, toKebab, toPascal} from '../../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  ProjectionEmitter,
  SchemaRegistry,
} from '../../interfaces';
import {ContractsBindings} from '../../keys';

const PEER_DEP = 'json-schema-to-typescript';

/**
 * Sidecar emitter that compiles a JSON Schema into pure TypeScript
 * interfaces (no runtime). Used to share types with monorepo workers,
 * background jobs, or CLI tools that should not pull the LB4 runtime.
 *
 * Returns a `Promise` from `emit()` because the upstream `compile()` call
 * is async-only; the engine runner `await`s the result.
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
    const pascalName = toPascal(schemaId);
    const fileBase = toKebab(schemaId);

    // Pre-resolve all `$ref`s against the registry into an injected `$defs`
    // block and rewrite refs to JSON Pointer form. Without this step
    // `json-schema-to-typescript` hands $id-style refs to
    // `@apidevtools/json-schema-ref-parser`, which treats them as relative
    // filesystem paths and crashes on `ENOENT`.
    const prepared = prepareSchemaForCompile(ctx.schema, ctx.registry);

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
    // ref-parser's filesystem and HTTP loaders so unresolved refs surface
    // as inline `unknown`s instead of process-crashing `ENOENT`s.
    // `declareExternallyReferenced: false` keeps the output focused on the
    // root schema; cross-schema types live in their own `.types.ts` files
    // and are re-imported by name.
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
    const content = await compile(
      prepared as Parameters<typeof compile>[0],
      pascalName,
      {
        bannerComment: '',
        additionalProperties,
        declareExternallyReferenced: false,
        $refOptions: {resolve: {file: false, http: false}},
      },
    );

    return [
      {
        path: `models/${fileBase}.types.ts`,
        content,
        policy: 'regen',
        producer: 'types-emitter',
      },
    ];
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
 * Clone the root schema, walk every `$ref`, and rewrite cross-document
 * `$id`-style refs (`"customer.v1"`) into intra-document JSON Pointer refs
 * (`"#/$defs/customer.v1"`). Each referenced target is copied under a
 * synthetic top-level `$defs` block keyed by `$id`, with transitive refs
 * resolved breadth-first so the final document is closed under reachability.
 *
 * Intra-document refs (`#/...`) and absolute URLs (`http://...`) pass
 * through untouched — those are the two shapes the upstream compiler
 * already handles correctly.
 */
function prepareSchemaForCompile(
  root: JSONSchema,
  registry: SchemaRegistry,
): JSONSchema {
  const visited = new Set<string>();
  const defs: Record<string, JSONSchema> = {};
  // Don't re-inject the root schema into its own `$defs`. Skip the empty
  // string explicitly: `$id === ''` would seed `visited` with `''` and
  // any subsequent registry lookup keyed on `''` would falsely report a
  // cycle and drop the target.
  if (root.$id !== undefined && root.$id !== '') visited.add(root.$id);

  const queue: JSONSchema[] = [];
  const cloned = cloneAndCollect(root, registry, defs, visited, queue);

  // Drain the queue: every cloned referenced schema may itself contain
  // refs to other schemas. Process them one at a time so cycles terminate
  // via the visited set.
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const id = next.$id;
    if (id === undefined) continue;
    defs[id] = cloneAndCollect(next, registry, defs, visited, queue);
  }

  // Only inject `$defs` when we actually rewrote at least one ref; an
  // empty block changes nothing for the compiler but pollutes the
  // generated output with a stray `Defs` interface.
  if (Object.keys(defs).length === 0) return cloned;
  const out = cloned as Record<string, unknown>;
  const existingDefs = out['$defs'];
  if (existingDefs !== undefined && typeof existingDefs === 'object') {
    out['$defs'] = {...(existingDefs as Record<string, unknown>), ...defs};
  } else {
    out['$defs'] = defs;
  }
  return out as JSONSchema;
}

function cloneAndCollect(
  node: JSONSchema,
  registry: SchemaRegistry,
  defs: Record<string, JSONSchema>,
  visited: Set<string>,
  queue: JSONSchema[],
): JSONSchema {
  return walk(node, registry, defs, visited, queue) as JSONSchema;
}

function walk(
  node: unknown,
  registry: SchemaRegistry,
  defs: Record<string, JSONSchema>,
  visited: Set<string>,
  queue: JSONSchema[],
): unknown {
  if (Array.isArray(node)) {
    return node.map(child => walk(child, registry, defs, visited, queue));
  }
  if (node === null || typeof node !== 'object') return node;

  const src = node as Record<string, unknown>;
  // Object-level handling for `$ref`: the upstream `ref-parser` errors out
  // on any unresolved `$ref` regardless of `resolve.file/http: false`, so
  // we must rewrite the whole node (not just the string value) when we
  // can't satisfy it from the registry.
  const refValue = src['$ref'];
  if (typeof refValue === 'string') {
    const resolved = resolveRef(refValue, registry, defs, visited, queue);
    if (resolved === undefined) {
      // Drop the ref entirely; the rest of the node's siblings (if any)
      // carry through so co-located JSON-Schema annotations like
      // `description` aren't lost. An empty schema compiles to `unknown`
      // (with `unknownAny: true`) or `any`.
      const fallback: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(src)) {
        if (key === '$ref') continue;
        fallback[key] = walk(value, registry, defs, visited, queue);
      }
      return fallback;
    }
    // Successful rewrite: emit only the rewritten `$ref` so the upstream
    // compiler treats this as a pure reference (mixing `$ref` with sibling
    // keys is undefined behaviour in JSON Schema draft-07, the dialect
    // `json-schema-to-typescript` targets).
    return {$ref: resolved};
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    out[key] = walk(value, registry, defs, visited, queue);
  }
  return out;
}

/**
 * Rewrite one `$ref` value. Intra-document refs and absolute URLs pass
 * through as-is; bare `$id`-style refs are looked up in the registry,
 * queued for inclusion under `$defs`, and replaced with a JSON Pointer
 * ref. Returns `undefined` when the ref cannot be satisfied so the
 * caller can drop the whole node — the upstream compiler crashes on any
 * unresolved external `$ref` even with filesystem resolvers disabled.
 */
function resolveRef(
  ref: string,
  registry: SchemaRegistry,
  defs: Record<string, JSONSchema>,
  visited: Set<string>,
  queue: JSONSchema[],
): string | undefined {
  if (ref.startsWith('#')) return ref;
  if (/^[a-z]+:\/\//i.test(ref)) return ref;

  const hashIdx = ref.indexOf('#');
  const id = hashIdx === -1 ? ref : ref.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? '' : ref.slice(hashIdx);

  const target = registry.get(id);
  if (target === undefined) return undefined;

  if (!visited.has(id)) {
    visited.add(id);
    queue.push(target);
  }
  // Slash and tilde have special meaning in JSON Pointer (RFC 6901); the
  // typical `$id` (`customer.v1`) contains neither, but encode defensively
  // so a `foo/bar` id can't slip past as two path segments.
  const pointerKey = id.replace(/~/g, '~0').replace(/\//g, '~1');
  return `#/$defs/${pointerKey}${fragment}`;
}
