import {BindingScope, injectable} from '@loopback/core';
import {join, posix} from 'node:path';
import {assertNoTraversal, readDatasourcesDoc, toKebab} from '../helpers';
import type {
  EmittedFile,
  EmitterContext,
  ProjectionEmitter,
} from '../interfaces';
import {ContractsBindings} from '../keys';
import type {DatasourceConfigJson} from '../types';
import type {GeneratorContext} from './types';

const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const TPL_BASE = join(TEMPLATES_DIR, 'datasource.base.ts.ejs');
const TPL_EXT = join(TEMPLATES_DIR, 'datasource.ts.ejs');
const PRODUCER = 'datasource-generator';

/**
 * Matches a whole-string `${VAR}` placeholder. Accepts the JavaScript
 * identifier grammar (lowercase + uppercase + digits + underscore) rather
 * than the SCREAMING_CASE-only subset, because connectors commonly read
 * lowercase env-vars (e.g. `NODE_ENV`, `database_url`).
 */
const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Matches one occurrence of `${VAR}` anywhere inside a larger string,
 * used by {@link rewriteAsTemplateLiteral} when the input is a partial
 * substitution like `"mongodb://${HOST}:${PORT}/db"`.
 */
const ENV_INTERIOR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;

/**
 * Shape of `<projectRoot>/datasources.json`. Two layouts are accepted, in
 * lock-step with `findDatasourceEntry()` in `src/cli/commands/override.ts`:
 *
 *   - Keyed map: `{"primary": {"adapter": "mongodb", ...}}` (preferred;
 *     `lb4 ds` writes this form). The optional `$schema` string key is
 *     allowed; the emitter skips it.
 *   - Legacy array: `[{"name": "primary", "adapter": "mongodb", ...}]`.
 *     Tolerated for fixtures and pre-existing projects that haven't yet
 *     migrated; entries are normalised to the keyed-map form before
 *     rendering.
 */
type DatasourcesFile =
  | Record<string, DatasourceConfigJson | string>
  | readonly DatasourceConfigJson[];

/**
 * LB4-idiom projection emitter for `src/datasources/<name>.base.datasource.ts`
 * (regenerated every run) and the sibling `<name>.datasource.ts` extension
 * stub (skipIfExists), produced once per entry in
 * `<projectRoot>/datasources.json`.
 *
 * Registered under {@link ContractsBindings.EMITTER_TAG} with
 * `kind: 'datasource'` so the engine discovers it through the same
 * `@extensions.list({tag: EMITTER_TAG})` path as every sidecar emitter.
 *
 * Unlike the model / repository / controller emitters, datasource output is
 * project-level, not per-schema — `datasources.json` is keyed by datasource
 * name and carries no `$id`/`$contractId` linkage. Declares
 * {@link ProjectionEmitter.outputScope} as `'per-project'` so the engine
 * invokes {@link emit} exactly once per pipeline run rather than fanning
 * out per schema; the single invocation reads `datasources.json` once and
 * returns one descriptor per entry. (Without the per-project scope, a
 * project with N schemas would produce N copies of every datasource
 * descriptor and trip FileWriter's same-path collision check at codegen
 * time.)
 *
 * Environment-variable interpolation: any string value of the form
 * `"${VAR}"` is rewritten into a `process.env.VAR` reference in the emitted
 * config literal. Whole-string match only — partial substitution like
 * `"prefix-${VAR}"` is preserved as-is because the runtime substitution
 * pattern there belongs to the connector, not the engine.
 *
 * @internal
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {
    [ContractsBindings.EMITTER_TAG]: ContractsBindings.EMITTER_TAG,
    kind: 'datasource',
  },
})
export class DatasourceGenerator implements ProjectionEmitter {
  readonly kind = 'datasource';
  readonly tier = 'lb4-idiom' as const;
  readonly outputScope = 'per-project' as const;
  readonly outputSuffix = '.base.datasource.ts';
  readonly description =
    'LB4 juggler datasource — regen-always base + skipIfExists extension stub (one per entry in datasources.json)';
  readonly peerDeps: string[] = [];
  readonly templatePaths: readonly string[] = [TPL_BASE, TPL_EXT];

  /**
   * Engine entry point. Datasources are project-level, not per-schema:
   * the EmitterRunner honours `outputScope: 'per-project'` and invokes
   * `emit()` exactly once per pipeline run with the first schema in
   * topological order as `ctx.schema`. This method reads
   * `<projectRoot>/datasources.json` once, iterates every entry, and
   * returns the full descriptor set in a single pass.
   *
   * Missing `datasources.json` is not an error: a contracts-only project
   * legitimately ships no datasources. The shared `readDatasourcesDoc`
   * helper returns `undefined` for that benign case; malformed or
   * unreadable files throw `ContractsValidationError`, which we let
   * propagate so the pipeline's stage-7 error path surfaces the uniform
   * diagnostic block instead of swallowing it as "no datasources".
   */
  emit(ctx: EmitterContext): EmittedFile[] {
    const datasourcesPath = join(ctx.paths.root, 'datasources.json');
    const doc = readDatasourcesDoc(datasourcesPath);
    if (doc === undefined) return [];
    const datasources = doc as DatasourcesFile;

    const genCtx: GeneratorContext = {
      registry: ctx.registry,
      importMap: ctx.importMap,
      templates: ctx.templates,
      paths: ctx.paths,
      lossy: ctx.lossy,
      // Always emit the extension stub; FileWriter's `skipIfExists` policy
      // preserves any hand edits across subsequent regenerations.
      includeExtension: true,
    };

    const entries = normaliseDatasources(datasources);
    const out: EmittedFile[] = [];
    for (const [name, dsConfig] of entries) {
      out.push(...this.generateInternal(name, dsConfig, genCtx));
    }
    return out;
  }

  /**
   * Back-compat shim used by `lb4 override datasource <name>`, which boots
   * a transient application and invokes the generator directly with a
   * caller-supplied entry — bypassing `datasources.json` lookup. New code
   * should reach the generator through the {@link ProjectionEmitter} path
   * (i.e. `lb4 gen`) instead; this entry point exists only for the
   * override command's direct-invocation bootstrap.
   *
   * @deprecated Use the ProjectionEmitter path (`lb4 gen`) instead; this
   *   method is kept for backward compat with the override command's
   *   direct-invocation bootstrap.
   */
  generate(
    name: string,
    dsConfig: DatasourceConfigJson,
    ctx: GeneratorContext,
  ): EmittedFile[] {
    return this.generateInternal(name, dsConfig, ctx);
  }

  /**
   * Build the descriptors the engine writes for one datasource entry.
   *
   * @param name - The datasource name (key in `datasources.json`).
   * @param dsConfig - Parsed `datasources.json` entry for this datasource.
   * @param ctx - Per-run generator context.
   */
  private generateInternal(
    name: string,
    dsConfig: DatasourceConfigJson,
    ctx: GeneratorContext,
  ): EmittedFile[] {
    const kebab = toKebab(name);
    // Spread the user-supplied `config` *first* so the engine-injected
    // `name` / `connector` always win — otherwise a config that accidentally
    // redeclares either key would silently override the values the engine
    // resolved from the datasource entry.
    const literal = renderConfigLiteral({
      ...(dsConfig.config ?? {}),
      name: dsConfig.name ?? name,
      connector: dsConfig.adapter,
    });

    const baseContent = ctx.templates.render(TPL_BASE, {
      name,
      configLiteral: literal,
    });

    const basePath = posix.join('datasources', `${kebab}.base.datasource.ts`);
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
      const extContent = ctx.templates.render(TPL_EXT, {name});
      const extPath = posix.join('datasources', `${kebab}.datasource.ts`);
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
 * Render a TypeScript object-literal source string from a JSON-style record,
 * substituting whole-string `${VAR}` values with `process.env.VAR` reads.
 */
function renderConfigLiteral(value: unknown, indent = 0): string {
  return renderValue(value, indent);
}

function renderValue(value: unknown, indent: number): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return renderString(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return renderArray(value, indent);
  if (typeof value === 'object') {
    return renderObject(value as Record<string, unknown>, indent);
  }
  return 'undefined';
}

function renderString(s: string): string {
  const m = ENV_PLACEHOLDER.exec(s);
  if (m) return `process.env[${JSON.stringify(m[1])}]`;
  if (ENV_INTERIOR.test(s)) return rewriteAsTemplateLiteral(s);
  // Use the JSON encoding for escape correctness, then convert the outer
  // double quotes to single quotes (project style). Interior `"` characters
  // get unescaped; interior `'` characters get backslash-escaped.
  const json = JSON.stringify(s);
  const inner = json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'");
  return `'${inner}'`;
}

/**
 * Convert a partial-substitution string like `"mongodb://${HOST}:${PORT}/db"`
 * into a template-literal expression:
 *   `mongodb://${process.env['HOST']}:${process.env['PORT']}/db`
 *
 * Uses bracket-notation env access so the generated file stays
 * `noUncheckedIndexedAccess` compliant under the consumer's tsconfig.
 */
function rewriteAsTemplateLiteral(s: string): string {
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let out = '';
  let cursor = 0;
  for (const match of s.matchAll(re)) {
    const start = match.index;
    out += escapeForTemplateLiteral(s.slice(cursor, start));
    out += `\${process.env[${JSON.stringify(match[1])}]}`;
    cursor = start + match[0].length;
  }
  out += escapeForTemplateLiteral(s.slice(cursor));
  return `\`${out}\``;
}

/**
 * Escape characters that have meaning inside a template literal — backticks,
 * backslashes, and `${` interpolation openers.
 */
function escapeForTemplateLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function renderArray(arr: readonly unknown[], indent: number): string {
  if (arr.length === 0) return '[]';
  const pad = ' '.repeat((indent + 1) * 2);
  const close = ' '.repeat(indent * 2);
  const inner = arr.map(v => pad + renderValue(v, indent + 1)).join(',\n');
  return `[\n${inner},\n${close}]`;
}

function renderObject(obj: Record<string, unknown>, indent: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const pad = ' '.repeat((indent + 1) * 2);
  const close = ' '.repeat(indent * 2);
  const lines = keys.map(k => {
    const key = isSafeKey(k) ? k : JSON.stringify(k);
    return `${pad}${key}: ${renderValue(obj[k], indent + 1)}`;
  });
  return `{\n${lines.join(',\n')},\n${close}}`;
}

function isSafeKey(k: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
}

/**
 * Normalise the two accepted `datasources.json` layouts into a uniform
 * `[name, config]` tuple list. Mirrors `findDatasourceEntry()`'s tolerance
 * in `src/cli/commands/override.ts` AND `parseDatasourcesJson()` in
 * `src/engine/pipeline.ts` — keep all three in lock-step.
 *
 * Silently drops entries that can't be parsed (string values like
 * `$schema`, malformed array members, anonymous entries, whitespace-only
 * names) so the generator stays robust. The pipeline's stage-5
 * `parseDatasourcesJson` is the authoritative validator and rejects the
 * same shapes with a typed error — this generator runs AFTER stage 5
 * succeeded, so the leniency here is belt-and-suspenders.
 *
 * Precedence in keyed-map form: the map key wins over any `name` field
 * declared inside the value. Same rule the pipeline applies; the tuple
 * returned uses the map key as `[0]` regardless of what `value.name`
 * says.
 */
function normaliseDatasources(
  datasources: DatasourcesFile,
): readonly [string, DatasourceConfigJson][] {
  const out: [string, DatasourceConfigJson][] = [];
  if (Array.isArray(datasources)) {
    for (const entry of datasources) {
      if (entry === null || typeof entry !== 'object') continue;
      const name = (entry as {name?: unknown}).name;
      if (typeof name !== 'string' || name.trim().length === 0) continue;
      out.push([name, entry]);
    }
    return out;
  }
  for (const [name, dsConfig] of Object.entries(datasources)) {
    if (name === '$schema') continue;
    if (name.trim().length === 0) continue;
    if (typeof dsConfig === 'string') continue;
    out.push([name, dsConfig]);
  }
  return out;
}
