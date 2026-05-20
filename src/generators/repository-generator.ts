import {BindingScope, injectable} from '@loopback/core';
import {join, posix} from 'node:path';
import {
  ContractsCodegenError,
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
import type {ModelConfigJson, ModelRelationConfig} from '../types';
import type {GeneratorContext} from './types';

/** Producer labels. */
const PRODUCER_BASE = 'repository-generator/base';
const PRODUCER_EXT = 'repository-generator/extension';

/** Absolute path to the packaged EJS templates directory. */
const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const TPL_BASE = join(TEMPLATES_DIR, 'repository.base.ts.ejs');
const TPL_EXT = join(TEMPLATES_DIR, 'repository.ts.ejs');

interface RelationRepoView {
  name: string;
  accessorName: string;
  factoryFnName: string;
  factoryReturnType: string;
  factoryTypeImport: string;
  targetClass: string;
  targetWithRelations: string;
  /**
   * Base-repository class name used for the TYPE annotation only (e.g.
   * `CustomerBaseRepository`). Imported from the always-regenerated base
   * file so the type resolves on the first `lb-contracts gen` run.
   */
  targetRepoClass: string;
  /**
   * Extension-repository class NAME used as the string binding key for
   * `@repository.getter(...)` (e.g. `'CustomerRepository'`). LB4's
   * repository booter auto-discovers `<name>.repository.ts` files and
   * binds them at `repositories.<ExtName>` — the base file is never
   * auto-bound, so binding by the base class name would resolve a key
   * that doesn't exist and silently bypass every user override.
   */
  targetRepoBindingName: string;
  targetImportPath: string;
  targetRepoImportPath: string;
  getterName: string;
  relationName: string;
}

/**
 * LB4-idiom projection emitter for `src/repositories/<name>.base.repository.ts`
 * (regen) and the user-editable `<name>.repository.ts` extension stub
 * (skipIfExists).
 *
 * Registered under `ContractsBindings.EMITTER_TAG` with `kind: 'repository'`
 * so the engine discovers it via `@extensions.list({tag: EMITTER_TAG})`
 * alongside sidecar emitters (zod, types, graphql, ...). Skips emission for
 * any schema lacking a registered `ModelConfigJson` in
 * {@link EmitterContext.configs} — repositories are an LB4-idiom projection
 * and have nothing to emit for contracts-only schemas.
 *
 * @internal
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'repository',
  },
})
export class RepositoryGenerator implements ProjectionEmitter {
  readonly kind = 'repository';
  readonly tier = 'lb4-idiom' as const;
  readonly outputSuffix = '.base.repository.ts';
  readonly description =
    'LB4 DefaultCrudRepository — regen-always base + skipIfExists extension stub';
  readonly peerDeps: string[] = [];
  readonly templatePaths = [TPL_BASE, TPL_EXT];

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
   * Back-compat entry point used by `lb-contracts override repository` (see
   * `src/cli/commands/override.ts`). New callers should register the
   * generator as a {@link ProjectionEmitter} and let the engine invoke
   * {@link emit} per the standard discovery flow.
   *
   * @deprecated Use {@link emit} via the emitter extension point. Retained
   * for the `override` CLI command which drives a single-contract render
   * out-of-band from the main pipeline.
   */
  generate(
    schema: JSONSchema,
    config: ModelConfigJson,
    ctx: GeneratorContext,
  ): EmittedFile[] {
    return this.generateInternal(schema, config, ctx);
  }

  private generateInternal(
    schema: JSONSchema,
    config: ModelConfigJson,
    ctx: GeneratorContext,
  ): EmittedFile[] {
    assertIdPropertyDeclared(schema, config, ctx);

    const className = classNameFromSchema(schema);
    const kebab = toKebab(className);
    const relPath = posix.join('repositories', `${kebab}.base.repository.ts`);
    assertNoTraversal(relPath, PRODUCER_BASE);
    const absPath = posix.join(ctx.paths.outputDir, relPath);

    const view = this.buildBaseView(schema, config, ctx, className, absPath);
    const content = ctx.templates.render(TPL_BASE, view as unknown as object);

    const out: EmittedFile[] = [
      {
        path: relPath,
        content,
        policy: 'regen',
        producer: PRODUCER_BASE,
      },
    ];

    if (ctx.includeExtension) {
      const extRel = posix.join('repositories', `${kebab}.repository.ts`);
      assertNoTraversal(extRel, PRODUCER_EXT);
      const extContent = ctx.templates.render(TPL_EXT, {
        className,
        baseImportPath: `./${kebab}.base.repository`,
      });
      out.push({
        path: extRel,
        content: extContent,
        policy: 'skipIfExists',
        producer: PRODUCER_EXT,
      });
    }
    return out;
  }

  private buildBaseView(
    schema: JSONSchema,
    config: ModelConfigJson,
    ctx: GeneratorContext,
    className: string,
    selfPath: string,
  ): Record<string, unknown> {
    const baseClassName = `${className}Base`;
    const relationsTypeName = `${className}BaseRelations`;
    const idType = pickIdType(schema, config);
    const dataSourceName = config.dataSource;
    // Base files must only import from sibling base files (extensions are
    // skipIfExists and may not exist on first `lb-contracts gen`). The DI tag
    // `datasources.<name>` still routes to the user-extended class at
    // runtime via LB4's binding-key resolution.
    const dataSourceClass = `${toPascal(dataSourceName)}BaseDataSource`;

    const kebab = toKebab(className);
    const modelImportPath = `../models/${kebab}.base.model`;
    const dataSourceImportPath = `../datasources/${toKebab(dataSourceName)}.base.datasource`;

    const relations = this.buildRelations(
      schema,
      config,
      ctx,
      baseClassName,
      idType,
      selfPath,
    );

    // The factory **functions** (e.g. `createBelongsToAccessor`) are exported
    // from `@loopback/repository` and take metadata + a target-repo getter.
    // The factory **methods** the generated repo actually calls
    // (`this.createBelongsToAccessorFor('relationName', getter)`) live on
    // `DefaultCrudRepository` itself — same names with a `For` suffix — and
    // do NOT need a separate import. Emitting the `*For` names into the
    // `@loopback/repository` import list yields a `TS2724: no exported
    // member 'createBelongsToAccessorFor'` because those identifiers are
    // protected methods, not package-level exports. Keep this array empty
    // and only import the relation factory **return types**.
    const factoryImports: readonly string[] = [];
    const factoryTypeImports = [
      ...new Set(relations.map(r => r.factoryTypeImport)),
    ].sort();

    return {
      className,
      baseClassName,
      relationsTypeName,
      idType,
      dataSourceName,
      dataSourceClass,
      modelImportPath,
      dataSourceImportPath,
      relations,
      factoryImports,
      factoryTypeImports,
    };
  }

  private buildRelations(
    _schema: JSONSchema,
    config: ModelConfigJson,
    ctx: GeneratorContext,
    baseClassName: string,
    idType: string,
    _selfPath: string,
  ): RelationRepoView[] {
    const out: RelationRepoView[] = [];
    const relations = Object.entries(config.relations ?? {});

    for (const [name, rel] of relations) {
      const target = ctx.registry.get(rel.schema);
      if (!target?.$id) continue;
      const targetClass = classNameFromId(target.$id);
      const targetBaseClass = `${targetClass}Base`;
      const targetKebab = toKebab(targetClass);

      // Base repositories must only import sibling *Base* symbols from
      // `.base.*` files. The extension files (`<name>.model.ts` /
      // `<name>.repository.ts`) are `skipIfExists` and may not exist on
      // the first `lb-contracts gen` run, so resolving via `ctx.importMap` (which
      // points at the extension) would emit a dangling import. Pin both
      // paths and class names to the always-regenerated base files.
      const targetImportPath = `../models/${targetKebab}.base.model`;
      const targetRepoImportPath = relRepoImport(targetKebab);

      const {factoryFnName, factoryTypeImport, factoryReturnType} =
        relationFactoryShape(rel, baseClassName, idType, targetBaseClass);

      out.push({
        name,
        accessorName: name,
        factoryFnName,
        factoryTypeImport,
        factoryReturnType,
        targetClass: targetBaseClass,
        targetWithRelations: `${targetBaseClass}WithRelations`,
        targetRepoClass: `${targetClass}BaseRepository`,
        targetRepoBindingName: `${targetClass}Repository`,
        targetImportPath,
        targetRepoImportPath,
        getterName: `${name}RepositoryGetter`,
        relationName: name,
      });
    }
    return out;
  }
}

function relRepoImport(targetKebab: string): string {
  // Repository files live under `src/repositories/`; cross-references resolve
  // to the always-regenerated base file so the first `lb-contracts gen` run compiles
  // even before any `lb-contracts override repository` extension stubs exist.
  return `./${targetKebab}.base.repository`;
}

function relationFactoryShape(
  rel: ModelRelationConfig,
  baseClassName: string,
  idType: string,
  targetClass: string,
): {
  factoryFnName: string;
  factoryTypeImport: string;
  factoryReturnType: string;
} {
  switch (rel.type) {
    case 'belongsTo':
      return {
        factoryFnName: 'createBelongsToAccessorFor',
        factoryTypeImport: 'BelongsToAccessor',
        factoryReturnType: `BelongsToAccessor<${targetClass}, ${idType}>`,
      };
    case 'hasOne':
      return {
        factoryFnName: 'createHasOneRepositoryFactoryFor',
        factoryTypeImport: 'HasOneRepositoryFactory',
        factoryReturnType: `HasOneRepositoryFactory<${targetClass}, typeof ${baseClassName}.prototype.id>`,
      };
    case 'hasManyThrough':
      return {
        factoryFnName: 'createHasManyThroughRepositoryFactoryFor',
        factoryTypeImport: 'HasManyThroughRepositoryFactory',
        factoryReturnType: `HasManyThroughRepositoryFactory<${targetClass}, ${idType}, never, typeof ${baseClassName}.prototype.id>`,
      };
    case 'referencesMany':
      return {
        factoryFnName: 'createReferencesManyAccessorFor',
        factoryTypeImport: 'ReferencesManyAccessor',
        factoryReturnType: `ReferencesManyAccessor<${targetClass}, typeof ${baseClassName}.prototype.id>`,
      };
    case 'hasMany':
    default:
      return {
        factoryFnName: 'createHasManyRepositoryFactoryFor',
        factoryTypeImport: 'HasManyRepositoryFactory',
        factoryReturnType: `HasManyRepositoryFactory<${targetClass}, typeof ${baseClassName}.prototype.id>`,
      };
  }
}

/**
 * Derive the TS literal for the model's id property from its JSON Schema
 * `type`. Defaults to `string` when `config.model.idProperty` is missing or
 * the property isn't typed.
 */
function pickIdType(schema: JSONSchema, config: ModelConfigJson): string {
  const idProp = resolveIdProperty(config);
  const propSchema = schema.properties?.[idProp];
  if (!propSchema) return 'string';
  const t = propSchema.type;
  if (typeof t === 'string') {
    switch (t) {
      case 'string':
        return 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      default:
        return 'string';
    }
  }
  return 'string';
}

function classNameFromSchema(schema: JSONSchema): string {
  const id = schema.$id;
  if (typeof id === 'string' && id.length > 0) return classNameFromId(id);
  throw new ContractsCodegenError(
    'Schema is missing a `$id`; cannot derive a class name',
    {emitterKind: 'repository-generator', schemaId: ''},
  );
}

function classNameFromId(id: string): string {
  const stem = id.replace(/\.v\d+$/i, '');
  return toPascal(stem);
}

/**
 * Mirrors the model generator's idProperty validation so the repository
 * stage doesn't silently emit a `DefaultCrudRepository<Model, string>`
 * against a model whose schema never declared the configured id property.
 */
function assertIdPropertyDeclared(
  schema: JSONSchema,
  config: ModelConfigJson,
  ctx: GeneratorContext,
): void {
  const idProp = resolveIdProperty(config);
  const props = schema.properties ?? {};
  if (props[idProp] === undefined) {
    const sourcePath = ctx.importMap.resolve(
      schema.$id ?? '',
      ctx.paths.configsDir,
    );
    throw new ContractsValidationError(
      `idProperty '${idProp}' is not declared in schema.properties`,
      {
        sourcePath,
        instancePath: '/model/idProperty',
        ...(schema.$id !== undefined ? {schemaId: schema.$id} : {}),
      },
    );
  }
}
