import {BindingScope, injectable} from '@loopback/core';
import {join, posix} from 'node:path';
import {
  ContractsValidationError,
  assertNoTraversal,
  resolveIdProperty,
  toKebab,
  toPascal,
} from '../helpers';
import type {EmittedFile, JSONSchema} from '../interfaces';
import type {ModelConfigJson} from '../types';
import type {GeneratorContext} from './types';

const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const PRODUCER = 'controller-generator';

/**
 * JavaScript identifier shape — used to fence `idProperty` before it lands
 * inline (and unquoted) inside generated TypeScript source via the template's
 * `<%- idProperty %>` interpolations (`exclude: ['<%- idProperty %>']`,
 * `'<%- route %>/{<%- idProperty %>}'`, etc). Anything outside this grammar
 * would template-inject — escaping a quote could close a string literal and
 * inject arbitrary TS. Matches the LB4 property-name constraint so legitimate
 * configs always pass.
 */
const ID_PROPERTY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Engine-internal generator for `src/controllers/<name>.base.controller.ts`
 * (regenerated every run) and, when `ctx.includeExtension` is `true`, the
 * matching `<name>.controller.ts` extension stub (written once).
 *
 * Not registered under `EMITTER_TAG` — controllers are an LB4-idiom core
 * projection emitted directly by the engine, not a contributed sidecar.
 *
 * When `config.public === false` the base class is still emitted, but with an
 * empty body: the model is repository-only and intentionally exposes no
 * external CRUD surface. The extension stub still inherits from the empty
 * base so a downstream override can add its own routes when needed.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class ControllerGenerator {
  /**
   * Build the descriptors the engine writes for the controller projection of
   * a single contract.
   *
   * @param schema - The authored JSON Schema (`schemas/<name>.schema.json`).
   * @param config - The matching `configs/<name>.config.json` document.
   * @param ctx - Per-run generator context.
   */
  generate(
    schema: JSONSchema,
    config: ModelConfigJson,
    ctx: GeneratorContext,
  ): EmittedFile[] {
    // Derive PascalCase and kebab-case from the same `$id` stem in parallel,
    // rather than PascalCasing first and then kebab-casing the PascalCase
    // (which round-trips through `splitWords` for no benefit).
    const stem = idStem(schema);
    const controllerName = toPascal(stem);
    const kebab = toKebab(stem);
    // `Name` (the EJS view-model field) is bound to the *base* model class so
    // every type reference (`getModelSchemaRef(Name)`, `Filter<Name>`, etc.)
    // resolves against the always-emitted `<kebab>.base.model.ts`. The bare
    // `controllerName` stem is forwarded for the controller class
    // declaration, the URL prefix, and local variable / repo field names.
    const idProperty = resolveIdProperty(config);
    assertIdPropertyShape(idProperty, schema, ctx);
    const idType = resolveIdType(schema, idProperty);

    const baseContent = ctx.templates.render(
      join(TEMPLATES_DIR, 'controller.base.ts.ejs'),
      {
        name: `${controllerName}Base`,
        controllerName,
        isPublic: config.public === true,
        idProperty,
        idType_: idType,
      },
    );

    const basePath = posix.join('controllers', `${kebab}.base.controller.ts`);
    assertNoTraversal(basePath, PRODUCER);
    const files: EmittedFile[] = [
      {
        path: basePath,
        content: baseContent,
        policy: 'regen',
        producer: PRODUCER,
      },
    ];

    if (ctx.includeExtension) {
      const extContent = ctx.templates.render(
        join(TEMPLATES_DIR, 'controller.ts.ejs'),
        {name: controllerName},
      );
      const extPath = posix.join('controllers', `${kebab}.controller.ts`);
      assertNoTraversal(extPath, PRODUCER);
      files.push({
        path: extPath,
        content: extContent,
        policy: 'skipIfExists',
        producer: PRODUCER,
      });
    }

    return files;
  }
}

/**
 * Extract the raw `$id` stem (e.g. `customer.v1` -> `customer`) so callers
 * can derive both the PascalCase class name and the kebab-case file slug
 * from the same source. Falls back to a generic `model` placeholder when no
 * `$id` is present; upstream validation rejects that case before reaching
 * this generator.
 */
function idStem(schema: JSONSchema): string {
  const id = typeof schema.$id === 'string' ? schema.$id : '';
  const base = id.split('.')[0] ?? '';
  return base || 'model';
}

function resolveIdType(
  schema: JSONSchema,
  idProperty: string,
): 'string' | 'number' {
  const prop = schema.properties?.[idProperty];
  const raw = prop?.type;
  const type = Array.isArray(raw) ? raw[0] : raw;
  return type === 'integer' || type === 'number' ? 'number' : 'string';
}

/**
 * Reject `idProperty` values that don't match {@link ID_PROPERTY_PATTERN}.
 *
 * `idProperty` is interpolated inline (and unquoted) into the generated
 * controller — both as a single-quoted string literal
 * (`exclude: ['<%- idProperty %>']`) and as a path-template segment
 * (`'/{<%- idProperty %>}'`). A name containing a quote, backslash, or
 * newline could break out of the literal and template-inject arbitrary
 * TypeScript. Constraining to the JS identifier grammar matches the LB4
 * property-name constraint (legitimate configs always pass) and removes
 * the injection surface entirely.
 */
function assertIdPropertyShape(
  idProperty: string,
  schema: JSONSchema,
  ctx: GeneratorContext,
): void {
  if (ID_PROPERTY_PATTERN.test(idProperty)) return;
  const sourcePath = ctx.importMap.resolve(
    schema.$id ?? '',
    ctx.paths.configsDir,
  );
  throw new ContractsValidationError(
    `idProperty '${idProperty}' is not a valid JavaScript identifier`,
    {
      sourcePath,
      instancePath: '/model/idProperty',
      ...(schema.$id !== undefined ? {schemaId: schema.$id} : {}),
    },
  );
}
