import {BindingScope, injectable} from '@loopback/core';
import * as ejs from 'ejs';
import {readFile} from 'node:fs/promises';
import {dirname, isAbsolute, posix, relative, resolve, sep} from 'node:path';
import {ContractsCodegenError} from '../helpers';
import type {TemplateEngine} from '../interfaces';

/**
 * Helper functions exposed to every EJS template under the `h` namespace.
 *
 * The shape is invented here (the public `TemplateEngine` interface deliberately
 * leaves the view-model open) so emitter templates have a single, predictable
 * vocabulary for case conversion, import-path resolution, and string escaping
 * — the things every code-gen template ends up needing.
 *
 * @internal
 */
export interface TemplateHelpers {
  pascal(s: string): string;
  camel(s: string): string;
  kebab(s: string): string;
  snake(s: string): string;
  plural(s: string): string;
  singular(s: string): string;
  importPath(fromFile: string, toFile: string): string;
  escapeStr(s: string): string;
  escapeComment(s: string): string;
}

/**
 * Split an identifier-ish string into lowercase word parts. Handles
 * camelCase, PascalCase, kebab-case, snake_case, and dot.separated input.
 */
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

function pascal(s: string): string {
  return words(s)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function camel(s: string): string {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function kebab(s: string): string {
  return words(s).join('-');
}

function snake(s: string): string {
  return words(s).join('_');
}

/**
 * Naive English pluraliser — enough for identifier-shaped tokens (model
 * names, route segments). Templates needing linguistic correctness should
 * pass a pre-pluralised view-model field instead.
 */
function plural(s: string): string {
  if (!s) return s;
  if (/(?:s|x|z|ch|sh)$/i.test(s)) return s + 'es';
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + 'ies';
  return s + 's';
}

function singular(s: string): string {
  if (!s) return s;
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y';
  if (/(?:s|x|z|ch|sh)es$/i.test(s)) return s.slice(0, -2);
  if (/s$/i.test(s) && !/ss$/i.test(s)) return s.slice(0, -1);
  return s;
}

/**
 * Compute the relative POSIX-style import path from one TS file to another.
 * Strips a trailing `.ts` / `.tsx` extension and guarantees a leading
 * `./` or `../` so the result is always a relative specifier.
 */
function importPath(fromFile: string, toFile: string): string {
  const fromDir = dirname(fromFile);
  let rel = relative(fromDir, toFile);
  if (sep !== '/') rel = rel.split(sep).join('/');
  rel = rel.replace(/\.tsx?$/, '');
  if (!rel.startsWith('./') && !rel.startsWith('../')) rel = './' + rel;
  return rel;
}

/**
 * Escape a string for inclusion inside a single-quoted TypeScript literal.
 * Mirrors `JSON.stringify` semantics for the dangerous characters then
 * peels the surrounding double quotes off so the caller can wrap the result
 * in `'...'` themselves.
 */
function escapeStr(s: string): string {
  const json = JSON.stringify(s);
  // JSON.stringify always returns a double-quoted string; convert the
  // double-quote escapes back to literals and escape single quotes.
  return json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'");
}

/**
 * Make a string safe inside a `/* ... *\/` block comment by breaking the
 * only terminator sequence (`*\/`) with a single space. No reversible escape
 * exists inside a block comment, so this is a one-way sanitisation.
 */
function escapeComment(s: string): string {
  return s.replace(/\*\//g, '* /');
}

const HELPERS: TemplateHelpers = {
  pascal,
  camel,
  kebab,
  snake,
  plural,
  singular,
  importPath,
  escapeStr,
  escapeComment,
};

/**
 * EJS-backed template engine shared by all built-in and contributed emitters.
 *
 * Hot path is filesystem-free: every template the pipeline will render is
 * preloaded once by the runner via {@link preload}, then `render()` reads
 * from the in-memory cache only. Cache miss = `ContractsCodegenError` with
 * a hint to add the template to the emitter's `templatePaths`.
 */
@injectable({scope: BindingScope.SINGLETON})
export class EjsTemplateEngine implements TemplateEngine {
  private readonly cache = new Map<string, ejs.TemplateFunction>();
  // In-flight read+compile promises keyed by absolute template path.
  // Coalesces concurrent `preload` calls for the same path so the
  // filesystem read and EJS compile each happen exactly once per path
  // even when two `run()` invocations race (e.g. a long-lived host that
  // shares a Pipeline between `validate` and `gen`). Entries are removed
  // on settle — the cached `TemplateFunction` lives in `cache` instead.
  private readonly inFlight = new Map<string, Promise<ejs.TemplateFunction>>();

  /**
   * @param templateRoot - Directory relative paths in `preload`/`render`
   *   resolve against. Each emitter typically passes its own packaged
   *   templates dir.
   */
  constructor(private readonly templateRoot: string = process.cwd()) {}

  /**
   * Read + compile every supplied template path in parallel and warm the
   * cache. Idempotent — paths already in the cache are skipped. Called
   * once per pipeline run by `EmitterRunner` (with the union of every
   * enabled emitter's `templatePaths`) and by `Pipeline` (with the
   * generator templates) before any per-schema emit fires.
   *
   * Concurrent callers for the same path share a single in-flight
   * read+compile via `inFlight`; the first caller starts the work,
   * subsequent callers `await` the same promise, and the compiled
   * function lands in `cache` on settle.
   */
  async preload(paths: readonly string[]): Promise<void> {
    const work: Promise<ejs.TemplateFunction>[] = [];
    for (const p of paths) {
      const abs = this.toAbsolute(p);
      if (this.cache.has(abs)) continue;
      const existing = this.inFlight.get(abs);
      if (existing !== undefined) {
        work.push(existing);
        continue;
      }
      // Wrap the read+compile so the `inFlight` entry is dropped on
      // settle (success OR failure) — a later `clear()` + retry must not
      // see a stale promise. `cache.set` happens inside `readAndCompile`
      // on success; we only own the in-flight bookkeeping here.
      const promise = this.readAndCompile(abs).finally(() => {
        this.inFlight.delete(abs);
      });
      this.inFlight.set(abs, promise);
      work.push(promise);
    }
    if (work.length === 0) return;
    await Promise.all(work);
  }

  /**
   * Drop every cached compiled template. Intended for long-lived hosts
   * that re-run the pipeline against different template sets (watch
   * mode, the planned `loopback-contracts-import` runtime); not needed
   * for one-shot CLI runs.
   */
  clear(): void {
    this.cache.clear();
  }

  // Read + compile a single template. Used by `preload` under the
  // `inFlight` coalescing guard. On success, populates `cache` so
  // subsequent `render()` calls hit the synchronous in-memory path.
  private async readAndCompile(abs: string): Promise<ejs.TemplateFunction> {
    let source: string;
    try {
      source = await readFile(abs, 'utf8');
    } catch (cause) {
      throw new ContractsCodegenError(
        `EJS template not readable: ${abs}`,
        {emitterKind: 'template-engine', schemaId: '', outputPath: abs},
        {cause},
      );
    }
    let fn: ejs.TemplateFunction;
    try {
      fn = ejs.compile(source, {filename: abs, cache: false, async: false});
    } catch (cause) {
      throw new ContractsCodegenError(
        `EJS template compile failed: ${abs}`,
        {emitterKind: 'template-engine', schemaId: '', outputPath: abs},
        {cause},
      );
    }
    this.cache.set(abs, fn);
    return fn;
  }

  render(templatePath: string, viewModel: object): string {
    const absPath = this.toAbsolute(templatePath);
    const fn = this.cache.get(absPath);
    if (fn === undefined) {
      throw new ContractsCodegenError(
        `Template not preloaded: ${absPath}. ` +
          `Add it to the emitter's \`templatePaths\` array.`,
        {emitterKind: 'template-engine', schemaId: '', outputPath: absPath},
      );
    }
    const data: Record<string, unknown> = {
      ...(viewModel as Record<string, unknown>),
      h: HELPERS,
    };
    try {
      return fn(data);
    } catch (cause) {
      throw new ContractsCodegenError(
        `EJS template render failed: ${posix.normalize(absPath)}`,
        {emitterKind: 'template-engine', schemaId: '', outputPath: absPath},
        {cause},
      );
    }
  }

  private toAbsolute(templatePath: string): string {
    return isAbsolute(templatePath)
      ? templatePath
      : resolve(this.templateRoot, templatePath);
  }
}
