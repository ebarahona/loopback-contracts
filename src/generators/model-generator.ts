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
import type {EmittedFile, JSONSchema} from '../interfaces';
import type {ModelConfigJson, ModelRelationConfig} from '../types';
import {buildRefResolver, jsonSchemaToTsType} from './json-schema-to-ts-type';
import type {GeneratorContext} from './types';

/** Producer label written into every {@link EmittedFile.producer}. */
const PRODUCER_BASE = 'model-generator/base';
const PRODUCER_EXT = 'model-generator/extension';

/** Default model-class base when `config.model.base` is omitted. */
const DEFAULT_BASE = 'Entity' as const;

/** Absolute path to the packaged EJS templates directory. */
const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const TPL_BASE = join(TEMPLATES_DIR, 'model.base.ts.ejs');
const TPL_EXT = join(TEMPLATES_DIR, 'model.ts.ejs');

interface PropertyView {
  name: string;
  tsType: string;
  required: boolean;
  optionsLiteral: string;
}

interface RelationView {
  name: string;
  kind: ModelRelationConfig['type'];
  targetClass: string;
  relationsType: string;
  optionsArg: string;
  fieldDecl: string;
}

interface ImportView {
  specifier: string;
  names: string[];
  typeOnly: boolean;
}

/**
 * Engine-internal generator for `src/models/<name>.base.model.ts` (regen) and
 * the optional `src/models/<name>.model.ts` extension stub (skipIfExists).
 *
 * Always runs — not registered under `EMITTER_TAG`. Consumes the schema +
 * model-config and renders via the injected {@link GeneratorContext.templates}
 * engine.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class ModelGenerator {
  generate(
    schema: JSONSchema,
    config: ModelConfigJson,
    ctx: GeneratorContext,
  ): EmittedFile[] {
    assertIdPropertyDeclared(schema, config, ctx);

    const className = classNameFromSchema(schema);
    const kebab = toKebab(className);
    const relPath = posix.join('models', `${kebab}.base.model.ts`);
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
      const extRel = posix.join('models', `${kebab}.model.ts`);
      assertNoTraversal(extRel, PRODUCER_EXT);
      const extContent = ctx.templates.render(TPL_EXT, {
        className,
        baseImportPath: `./${kebab}.base.model`,
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
    const baseClass = pickBaseClass(config);
    const modelSettings = stringifyLiteral(
      buildModelSettings(schema, config),
      2,
    );

    // Cross-schema refs must resolve to the BASE class name (`OrderBase`,
    // not `Order`). Base files only re-export the `Base` suffix; the bare
    // class lives in the extension stub which is `skipIfExists` and may
    // not exist at compile time.
    const resolveRef = buildRefResolver(
      ctx.registry,
      ctx.importMap,
      id => `${classNameFromId(id)}Base`,
    );

    const properties = buildProperties(schema, config, ctx, resolveRef);
    const {relations, imports: relationImports} = buildRelations(
      config,
      ctx,
      selfPath,
    );

    const refImports = collectRefImports(schema, ctx, selfPath);
    const imports = mergeImports([...refImports, ...relationImports]);

    return {
      className,
      baseClass,
      modelSettings,
      imports,
      properties,
      relations,
    };
  }
}

/**
 * Choose `Entity` (the default — required by `DefaultCrudRepository`) or the
 * lighter `Model` (no id) based on `config.model.base`. Anything other than
 * the two values supported by the meta-schema falls back to `Entity` so a
 * malformed config still yields a compilable file.
 */
function pickBaseClass(config: ModelConfigJson): 'Entity' | 'Model' {
  const base = (config.model?.base as string | undefined) ?? DEFAULT_BASE;
  return base === 'Model' ? 'Model' : 'Entity';
}

/** Build the literal passed to `@model({settings: {...}})`. */
function buildModelSettings(
  _schema: JSONSchema,
  config: ModelConfigJson,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  const model = config.model ?? {};
  if (typeof model['strict'] === 'boolean')
    settings['strict'] = model['strict'];
  else settings['strict'] = true;
  if (typeof model['idProperty'] === 'string') {
    settings['idProperty'] = model['idProperty'];
  }
  if (Array.isArray(model['hiddenProperties'])) {
    settings['hiddenProperties'] = model['hiddenProperties'];
  }
  return {settings};
}

function buildProperties(
  schema: JSONSchema,
  config: ModelConfigJson,
  ctx: GeneratorContext,
  resolveRef: (ref: string) => string | undefined,
): PropertyView[] {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const idProp = resolveIdProperty(config);
  const out: PropertyView[] = [];

  for (const [name, propSchema] of Object.entries(props)) {
    const tsType = jsonSchemaToTsType(propSchema, {
      schemaId: schema.$id ?? '',
      propertyPath: `/properties/${name}`,
      resolveRef,
      owningSchema: schema,
      lossy: ctx.lossy,
    });

    const opts: Record<string, unknown> = {
      type: jsonSchemaTypeToLb4(propSchema, ctx, schema.$id ?? '', name),
    };
    if (required.has(name)) opts['required'] = true;
    if (name === idProp) {
      opts['id'] = true;
      // Pin `generated: false` whenever the contract authoritatively supplies
      // the id value:
      //   - UUID strings (the contract mints them upstream).
      //   - Any other id that is `required` and has no `format` keyword.
      // Without this flag LB4 defaults to `generated: true`, which tells the
      // connector to mint the id and silently drops the caller-supplied value.
      // Leaving it `true` (the default) is correct only when the schema
      // explicitly opts into a connector-generated id (`format: 'serial'`
      // and friends — schema authors then omit the property from `required`).
      const format = propSchema['format'];
      const idType = propSchema.type;
      const isStringId =
        idType === 'string' ||
        (Array.isArray(idType) && idType.includes('string'));
      if (
        format === 'uuid' ||
        (required.has(name) && isStringId && format === undefined)
      ) {
        opts['generated'] = false;
      }
    }
    const format = propSchema['format'];
    if (typeof format === 'string') {
      opts['jsonSchema'] = {format};
    }
    if ('default' in propSchema) opts['default'] = propSchema['default'];

    flagLossyKeywords(propSchema, ctx, schema.$id ?? '', name);

    out.push({
      name,
      tsType,
      required: required.has(name),
      optionsLiteral: stringifyLiteral(opts, 4),
    });
  }
  return out;
}

/** Surface unsupported JSON-Schema keywords through the lossy reporter. */
function flagLossyKeywords(
  prop: JSONSchema,
  ctx: GeneratorContext,
  schemaId: string,
  propName: string,
): void {
  const unsupported: string[] = [];
  for (const k of ['pattern', 'multipleOf', 'allOf', 'not'] as const) {
    if (k in prop) unsupported.push(k);
  }
  if ('oneOf' in prop && !('discriminator' in prop)) {
    unsupported.push('oneOf-without-discriminator');
  }
  for (const feature of unsupported) {
    ctx.lossy.report({
      feature,
      source: {schemaId, propertyPath: `/properties/${propName}`},
      severity: 'info',
      message: `keyword '${feature}' is not represented in the generated @property() decorator`,
    });
  }
}

/** Map a JSON-Schema fragment to the LB4 `@property({type})` runtime token. */
function jsonSchemaTypeToLb4(
  prop: JSONSchema,
  ctx: GeneratorContext,
  schemaId: string,
  propName: string,
): unknown {
  const t = prop.type;
  if (typeof t === 'string') {
    switch (t) {
      case 'string':
        if (prop['format'] === 'date-time') return {__raw: 'Date'};
        return {__raw: 'String'};
      case 'integer':
      case 'number':
        return {__raw: 'Number'};
      case 'boolean':
        return {__raw: 'Boolean'};
      case 'array':
        return {__raw: 'Array'};
      case 'object':
        return {__raw: 'Object'};
      case 'null':
        return {__raw: 'Object'};
      default:
        ctx.lossy.report({
          feature: `unsupported-type-${t}`,
          source: {schemaId, propertyPath: `/properties/${propName}`},
          severity: 'info',
          message: `cannot map JSON type '${t}' to an LB4 property type`,
        });
        return {__raw: 'Object'};
    }
  }
  if (Array.isArray(t)) {
    // LB4 has no runtime union; fall back to Object. Surface the loss so
    // the run summary records that the decorator-level type erased to
    // `Object` (the TS type literal still carries the precise shape via
    // {@link jsonSchemaToTsType}).
    ctx.lossy.report({
      feature: 'array-type-union-flattened',
      source: {schemaId, propertyPath: `/properties/${propName}`},
      severity: 'warn',
      message: `JSON-Schema 'type' union [${t.join(', ')}] flattened to 'Object' for the LB4 @property() decorator`,
    });
    return {__raw: 'Object'};
  }
  return {__raw: 'Object'};
}

function buildRelations(
  config: ModelConfigJson,
  ctx: GeneratorContext,
  _selfPath: string,
): {relations: RelationView[]; imports: ImportView[]} {
  const relations: RelationView[] = [];
  const imports: ImportView[] = [];
  const entries = Object.entries(config.relations ?? {});

  for (const [name, rel] of entries) {
    const target = ctx.registry.get(rel.schema);
    if (!target?.$id) {
      ctx.lossy.report({
        feature: 'unresolved-relation',
        source: {schemaId: config.$contractId},
        severity: 'error',
        message: `relation '${name}' references unknown schema '${rel.schema}'`,
      });
      continue;
    }
    const targetClass = classNameFromId(target.$id);
    const targetBaseClass = `${targetClass}Base`;
    // Pin to the sibling base-model file deterministically; importMap.resolve
    // can return the extension path, but base files must only import base
    // siblings (extensions are `skipIfExists` and may not exist on first gen).
    const targetImport = `../models/${toKebab(targetClass)}.base.model`;
    imports.push({
      specifier: targetImport,
      names: [targetBaseClass, `${targetBaseClass}WithRelations`],
      typeOnly: false,
    });

    let throughBaseClass: string | undefined;
    if (rel.through !== undefined) {
      const throughSchema = ctx.registry.get(rel.through);
      if (!throughSchema?.$id) {
        ctx.lossy.report({
          feature: 'unresolved-through-schema',
          source: {schemaId: config.$contractId},
          severity: 'error',
          message: `relation '${name}' references unknown through schema '${rel.through}'`,
        });
      } else {
        const throughClass = classNameFromId(throughSchema.$id);
        throughBaseClass = `${throughClass}Base`;
        const throughImport = `../models/${toKebab(throughClass)}.base.model`;
        imports.push({
          specifier: throughImport,
          names: [throughBaseClass],
          typeOnly: false,
        });
      }
    }

    const optionsArg = relationOptionsArg(rel, throughBaseClass);
    const {fieldDecl, relationsType} = relationFieldShape(rel, targetBaseClass);

    relations.push({
      name,
      kind: rel.type,
      targetClass: targetBaseClass,
      relationsType,
      optionsArg,
      fieldDecl,
    });
  }
  return {relations, imports};
}

function relationOptionsArg(
  rel: ModelRelationConfig,
  throughClass: string | undefined,
): string {
  const opts: Record<string, unknown> = {};
  if (rel.keyFrom !== undefined) opts['keyFrom'] = rel.keyFrom;
  if (rel.keyTo !== undefined) opts['keyTo'] = rel.keyTo;
  if (rel.through !== undefined && throughClass !== undefined) {
    const through: Record<string, unknown> = {
      model: {__raw: `() => ${throughClass}`},
    };
    if (rel.keyFrom !== undefined) through['keyFrom'] = rel.keyFrom;
    if (rel.keyTo !== undefined) through['keyTo'] = rel.keyTo;
    opts['through'] = through;
  }
  if (Object.keys(opts).length === 0) return '';
  return `, ${stringifyLiteral(opts, 4)}`;
}

function relationFieldShape(
  rel: ModelRelationConfig,
  targetClass: string,
): {fieldDecl: string; relationsType: string} {
  switch (rel.type) {
    case 'hasMany':
    case 'hasManyThrough':
    case 'referencesMany':
      return {
        fieldDecl: `?: ${targetClass}[]`,
        relationsType: `${targetClass}WithRelations[]`,
      };
    case 'belongsTo':
    case 'hasOne':
    default:
      return {
        fieldDecl: `?: ${targetClass}`,
        relationsType: `${targetClass}WithRelations`,
      };
  }
}

/**
 * Gather imports for any property-level `$ref` target.
 *
 * Base files may only import from other base files (extension files are
 * `skipIfExists` and may not exist on first gen). The specifier is pinned to
 * the sibling `*.base.model` path and the imported symbol names use the
 * `Base`/`BaseRelations`/`BaseWithRelations` suffixes that the model
 * generator actually exports.
 */
function collectRefImports(
  schema: JSONSchema,
  ctx: GeneratorContext,
  _selfPath: string,
): ImportView[] {
  const out: ImportView[] = [];
  const props = schema.properties ?? {};
  for (const propSchema of Object.values(props)) {
    const ref = propSchema['$ref'];
    if (typeof ref === 'string' && ctx.registry.has(ref)) {
      const target = ctx.registry.get(ref);
      if (!target?.$id) continue;
      const cls = classNameFromId(target.$id);
      const specifier = `../models/${toKebab(cls)}.base.model`;
      out.push({
        specifier,
        names: [`${cls}Base`, `${cls}BaseRelations`, `${cls}BaseWithRelations`],
        typeOnly: false,
      });
    }
  }
  return out;
}

function mergeImports(list: ImportView[]): ImportView[] {
  const byKey = new Map<string, ImportView>();
  for (const imp of list) {
    const key = `${imp.typeOnly ? 'type:' : 'val:'}${imp.specifier}`;
    const existing = byKey.get(key);
    if (existing) {
      const names = new Set([...existing.names, ...imp.names]);
      byKey.set(key, {...existing, names: [...names].sort()});
    } else {
      byKey.set(key, {...imp, names: [...new Set(imp.names)].sort()});
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.specifier.localeCompare(b.specifier),
  );
}

/**
 * Stable JSON-ish stringification that preserves `__raw` escape hatches so
 * generated code can carry identifiers (e.g., `String`, `Date`) inside an
 * options literal without being quoted.
 */
function stringifyLiteral(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  const inner = renderValue(value, indent, indent + 2);
  return inner.startsWith('{') ? inner : `${pad}${inner}`;
}

function renderValue(value: unknown, base: number, deeper: number): string {
  if (value === null || value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(v => renderValue(v, base, deeper));
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('__raw' in obj && typeof obj['__raw'] === 'string') return obj['__raw'];
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const padDeep = ' '.repeat(deeper);
    const padBase = ' '.repeat(base);
    const lines = entries.map(
      ([k, v]) =>
        `${padDeep}${safePropKey(k)}: ${renderValue(v, base, deeper + 2)},`,
    );
    return `{\n${lines.join('\n')}\n${padBase}}`;
  }
  return 'undefined';
}

function safePropKey(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

function classNameFromSchema(schema: JSONSchema): string {
  const id = schema.$id;
  if (typeof id === 'string' && id.length > 0) return classNameFromId(id);
  throw new ContractsCodegenError(
    'Schema is missing a `$id`; cannot derive a class name',
    {emitterKind: 'model-generator', schemaId: ''},
  );
}

/** `customer.v1` → `Customer`; `address-book.v2` → `AddressBook`. */
function classNameFromId(id: string): string {
  const stem = id.replace(/\.v\d+$/i, '');
  return toPascal(stem);
}

/**
 * Reject configs whose declared `idProperty` is not present in
 * `schema.properties`. Without this guard the generator silently emits a
 * model with no `@property({id: true})` decorator and the downstream
 * repository ends up typed `Repository<Model, string>` against a model
 * that has no id field at all — a runtime failure waiting to happen.
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
