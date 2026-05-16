import {BindingScope, injectable} from '@loopback/core';
import {join, posix} from 'node:path';
import {assertNoTraversal, toKebab} from '../helpers';
import type {EmittedFile} from '../interfaces';
import type {DatasourceConfigJson} from '../types';
import type {GeneratorContext} from './types';

const TEMPLATES_DIR = join(__dirname, '..', 'templates');
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
 * Engine-internal generator for `src/datasources/<name>.base.datasource.ts`
 * (regenerated every run) and, when `ctx.includeExtension` is `true`, the
 * matching `<name>.datasource.ts` extension stub (written once).
 *
 * Environment-variable interpolation: any string value of the form
 * `"${VAR}"` is rewritten into a `process.env.VAR` reference in the emitted
 * config literal. Whole-string match only — partial substitution like
 * `"prefix-${VAR}"` is preserved as-is because the runtime substitution
 * pattern there belongs to the connector, not the engine.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class DatasourceGenerator {
  /**
   * Build the descriptors the engine writes for one datasource entry.
   *
   * @param name - The datasource name (key in `datasources.json`).
   * @param dsConfig - Parsed `datasources.json` entry for this datasource.
   * @param ctx - Per-run generator context.
   */
  generate(
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

    const baseContent = ctx.templates.render(
      join(TEMPLATES_DIR, 'datasource.base.ts.ejs'),
      {name, configLiteral: literal},
    );

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
      const extContent = ctx.templates.render(
        join(TEMPLATES_DIR, 'datasource.ts.ejs'),
        {name},
      );
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
 *   `` `mongodb://${process.env['HOST']}:${process.env['PORT']}/db` ``
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
