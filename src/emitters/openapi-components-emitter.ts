import {BindingScope, injectable} from '@loopback/core';
import {resolve} from 'node:path';
import {toKebab, toPascal} from '../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  ProjectionEmitter,
} from '../interfaces';
import {ContractsBindings} from '../keys';

// Absolute path to the bundled EJS template. `__dirname` resolves to
// `dist/emitters/` at runtime and `src/emitters/` during tests — both
// reach the same `templates/` sibling.
const TEMPLATE_PATH = resolve(
  __dirname,
  '..',
  'templates',
  'openapi-components.yaml.ejs',
);

/**
 * Sidecar emitter that projects a JSON Schema to an OpenAPI 3.x
 * `components.schemas` YAML fragment. Consumers mount the fragment into an
 * OpenAPI document with their tool of choice (Redocly, openapi-merge, etc.)
 * so the source-of-truth schema stays the contract.
 *
 * @experimental
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'openapi-components',
  },
})
export class OpenAPIComponentsEmitter implements ProjectionEmitter {
  readonly kind = 'openapi-components';
  readonly outputSuffix = '.openapi-components.yaml';
  readonly tier = 'convenience' as const;
  readonly description =
    'OAS 3.x components fragment (mount into OpenAPI documents)';
  readonly peerDeps: string[] = [];
  readonly templatePaths = [TEMPLATE_PATH];

  emit(ctx: EmitterContext): EmittedFile[] {
    const schemaId = ctx.schema.$id ?? '<no-$id>';
    // OAS components are keyed by the bare contract name without the version
    // tag — `user.v1` -> `User`. The `.vN` suffix lives in the file path so
    // mounted documents don't collide when a new major lands.
    //
    // NOTE: stripping only a trailing `.v\d+` (rather than everything after
    // the first dot) keeps dotted ids like `acme.user.v1` from collapsing
    // to `acme`. Cross-version collisions (`user.v1` + `user.v2` in the
    // same OAS document) are still possible by design — the file path
    // carries the version, mounted document authors pick which major to
    // expose.
    const headId = stripVersionSuffix(schemaId);
    const pascalName = toPascal(headId);
    const fileBase = toKebab(schemaId);

    const projected = toOpenAPISchema(ctx.schema);
    const content = ctx.templates.render(TEMPLATE_PATH, {
      schema: projected,
      name: pascalName,
    });

    return [
      {
        path: `models/${fileBase}.openapi-components.yaml`,
        content,
        headerComment: '#',
        policy: 'regen',
        producer: 'openapi-components-emitter',
      },
    ];
  }
}

/**
 * Convert a JSON Schema 2020-12 document into the OAS 3.1-friendly subset:
 *
 * - Strip the top-level `$id` / `$schema` keys (OAS controls component
 *   identity via the map key).
 * - Default `type` to `'object'` when properties are declared without one.
 * - Rewrite cross-document `$ref` strings (`'customer.v1'`) into the
 *   `'#/components/schemas/Customer'` form OAS resolvers expect.
 * - Carry `examples` through unchanged (OAS 3.1 accepts the JSON-Schema array).
 *
 * Recurses through `properties`, `items`, `additionalProperties`, and the
 * `oneOf` / `anyOf` / `allOf` arrays. Non-schema branches are returned as-is.
 */
function toOpenAPISchema(schema: JSONSchema): Record<string, unknown> {
  return rewrite(schema, true) as Record<string, unknown>;
}

function rewrite(node: unknown, isTopLevel: boolean): unknown {
  if (Array.isArray(node)) return node.map(child => rewrite(child, false));
  if (node === null || typeof node !== 'object') return node;

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(src)) {
    if (isTopLevel && (key === '$id' || key === '$schema')) continue;
    if (key === '$ref' && typeof value === 'string') {
      out[key] = rewriteRef(value);
      continue;
    }
    out[key] = rewrite(value, false);
  }

  // Inject an explicit `type: 'object'` only when the source schema omits
  // `type` but declares `properties`. Runs AFTER the iteration so a real
  // `type` from `src` (mirrored into `out` above) is never clobbered.
  if (src['type'] === undefined && src['properties'] !== undefined) {
    out['type'] = 'object';
  }
  return out;
}

/**
 * Translate a cross-document `$ref` from the engine's `<schemaId>` form into
 * the OAS `'#/components/schemas/<Name>'` reference syntax. Intra-document
 * JSON Pointer refs (already starting with `#`) and absolute URLs pass
 * through unchanged.
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
  const headId = stripVersionSuffix(id);
  return `#/components/schemas/${toPascal(headId)}${fragment}`;
}

/**
 * Strip a trailing `.v\d+` segment from a schema id.
 *
 * Splitting on `.` and taking the first segment used to clobber dotted ids
 * such as `acme.user.v1` (collapsing to `acme`); this regex-based strip
 * only removes the version suffix, preserving the rest of the qualified
 * name. Cross-version collisions remain possible by design — mounted OAS
 * documents pick a single major; the file path keeps the `.vN` so the
 * fragment files don't overwrite each other on disk.
 */
function stripVersionSuffix(id: string): string {
  return id.replace(/\.v\d+$/, '');
}
