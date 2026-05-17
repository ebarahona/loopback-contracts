import {BindingScope, injectable} from '@loopback/core';
import {join, posix} from 'node:path';
import {
  ContractsValidationError,
  assertNoTraversal,
  resolveIdProperty,
  toKebab,
  toPascal,
} from '../helpers';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  ProjectionEmitter,
} from '../interfaces';
import {ContractsBindings} from '../keys';
import type {ModelConfigJson} from '../types';
import type {GeneratorContext} from './types';

const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const TPL_BASE = join(TEMPLATES_DIR, 'controller.base.ts.ejs');
const TPL_EXT = join(TEMPLATES_DIR, 'controller.ts.ejs');
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
 * Projection emitter for `src/controllers/<name>.base.controller.ts`
 * (regenerated every run) and the matching `<name>.controller.ts` extension
 * stub (written once — `skipIfExists`).
 *
 * Registered under {@link ContractsBindings.EMITTER_TAG} with
 * `kind: 'controller'`; tier `'lb4-idiom'` — always-on, opt-OUT via
 * `--no-emit-controller`. The engine routes contracts that declare a
 * matching `configs/<name>.config.json` into `emit()`; contracts without
 * a config are skipped entirely (controllers are an LB4 surface and have
 * no meaning without an LB4 config).
 *
 * When `config.public === false` the base class is still emitted, but with an
 * empty body: the model is repository-only and intentionally exposes no
 * external CRUD surface. The extension stub still inherits from the empty
 * base so a downstream override can add its own routes when needed.
 *
 * @internal
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'controller',
  },
})
export class ControllerGenerator implements ProjectionEmitter {
  readonly kind = 'controller';
  readonly tier = 'lb4-idiom' as const;
  readonly outputSuffix = '.base.controller.ts';
  readonly description =
    'LB4 REST controller — regen-always base + skipIfExists extension stub';
  readonly peerDeps: string[] = [];
  readonly templatePaths = [TPL_BASE, TPL_EXT];

  /**
   * Engine entry point. Adapts the public {@link EmitterContext} to the
   * internal {@link GeneratorContext} the existing view-model builder
   * consumes and always emits both the regen base and the skipIfExists
   * extension stub. Returns `[]` when the schema has no associated LB4
   * config — controllers are an LB4-idiom projection and have no meaning
   * for a contract that opted out of LB4 metadata.
   */
  emit(ctx: EmitterContext): EmittedFile[] {
    const schemaId = ctx.schema.$id;
    if (typeof schemaId !== 'string') return [];
    const config = ctx.configs?.get(schemaId) as ModelConfigJson | undefined;
    if (config === undefined) return [];

    const genCtx: GeneratorContext = {
      registry: ctx.registry,
      importMap: ctx.importMap,
      templates: ctx.templates,
      paths: ctx.paths,
      lossy: ctx.lossy,
      includeExtension: true,
    };

    return this.generateInternal(ctx.schema, config, genCtx);
  }

  /**
   * Back-compat shim retained for `cli/commands/override.ts`, which still
   * drives a single-contract override flow through the generator directly
   * (it has no `EmitterContext` to hand off). Delegates to the same internal
   * implementation `emit()` uses.
   *
   * @deprecated Use {@link emit} when wiring through the engine pipeline.
   * This shim exists only for the CLI `override` command and will be removed
   * once that command migrates to {@link EmitterContext}.
   */
  generate(
    schema: JSONSchema,
    config: ModelConfigJson,
    ctx: GeneratorContext,
  ): EmittedFile[] {
    return this.generateInternal(schema, config, ctx);
  }

  /**
   * Build the descriptors the engine writes for the controller projection of
   * a single contract. Shared by {@link emit} and the deprecated
   * {@link generate} shim so the view-model and template wiring stays in one
   * place.
   *
   * @param schema - The authored JSON Schema (`schemas/<name>.schema.json`).
   * @param config - The matching `configs/<name>.config.json` document.
   * @param ctx - Per-run generator context.
   */
  private generateInternal(
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

    const baseContent = ctx.templates.render(TPL_BASE, {
      name: `${controllerName}Base`,
      controllerName,
      isPublic: config.public === true,
      idProperty,
      idType_: idType,
    });

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
      const extContent = ctx.templates.render(TPL_EXT, {name: controllerName});
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
 * Extract the raw `$id` stem (e.g. `customer.v1` -\> `customer`) so callers
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
