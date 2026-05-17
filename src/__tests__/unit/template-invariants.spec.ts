import {resolve} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {EjsTemplateEngine} from '../../engine/template-engine';

/**
 * Architectural invariant pinned by this spec:
 *
 *   Base files (`*.base.model.ts`, `*.base.repository.ts`,
 *   `*.base.controller.ts`, `*.base.datasource.ts`) must only import from
 *   sibling base files or external packages — never from extension files.
 *
 * Why: extensions are written `skipIfExists`. On the first `lb4 gen` run
 * (and forever, when the user opted out of extensions) they don't exist.
 * Any base-to-extension import would yield an uncompilable project.
 *
 * The test renders each base template against a fixture view-model that
 * exercises every conditional branch (loops over `properties`, `relations`,
 * `factoryImports`, `factoryTypeImports`, ref-imports, `isPublic`), then
 * inspects every `import ... from '<path>'` line:
 *
 *   1. If `<path>` is relative (`./` or `../`), it must contain `.base.`.
 *   2. The imported symbol(s) must belong to the target base file's known
 *      export set (`KNOWN_BASE_EXPORTS`, keyed by the base-file suffix).
 *
 * Limitations of the regex-based parser:
 *   - Only single-line `import {Foo, Bar} from '...';` and
 *     `import type {Foo} from '...';` forms are recognised. Multi-line
 *     destructured imports (a `{` followed by a newline) are scanned by a
 *     dedicated multi-line pass.
 *   - Side-effect imports (`import './foo';`) and namespace imports
 *     (`import * as ns from '...'`) are not produced by any current
 *     template; they are not asserted on. Add coverage here if a future
 *     template starts emitting them.
 *   - Dynamic `import('./x')` calls are not inspected. Templates do not
 *     emit them today.
 */

/** Symbol sets the model/repository/datasource generators are known to emit. */
const KNOWN_BASE_EXPORTS = {
  model: (name: string): ReadonlySet<string> =>
    new Set([
      `${name}Base`,
      `${name}BaseRelations`,
      `${name}BaseWithRelations`,
    ]),
  repository: (name: string): ReadonlySet<string> =>
    new Set([`${name}BaseRepository`]),
  datasource: (name: string): ReadonlySet<string> =>
    new Set([`${name}BaseDataSource`]),
  /** Controllers expose nothing the base templates import from each other. */
  controller: (_name: string): ReadonlySet<string> => new Set(),
};

interface ImportLine {
  readonly raw: string;
  readonly lineNumber: number;
  readonly typeOnly: boolean;
  readonly names: readonly string[];
  readonly specifier: string;
}

/** Matches a single-line `import [type] {A, B} from '...';` declaration. */
const SINGLE_LINE_IMPORT =
  /^\s*import\s+(type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;

/** Matches the opening of a multi-line `import [type] {` form. */
const MULTI_LINE_IMPORT_OPEN = /^\s*import\s+(type\s+)?\{\s*$/;
/** Matches the closing `} from '...';` line of a multi-line import. */
const MULTI_LINE_IMPORT_CLOSE = /^\s*\}\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/;

/**
 * Extract every `import ... from '...'` declaration from a rendered template
 * source. Handles both single-line destructured imports and multi-line
 * destructured imports (the latter is the form the repository template emits
 * when `factoryImports` or `factoryTypeImports` is non-empty).
 */
function parseImports(source: string): readonly ImportLine[] {
  const lines = source.split('\n');
  const out: ImportLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const single = SINGLE_LINE_IMPORT.exec(line);
    if (single) {
      const [, typeKw, names, specifier] = single;
      out.push({
        raw: line,
        lineNumber: i + 1,
        typeOnly: Boolean(typeKw),
        names: splitNames(names ?? ''),
        specifier: specifier ?? '',
      });
      continue;
    }
    const openMatch = MULTI_LINE_IMPORT_OPEN.exec(line);
    if (openMatch) {
      const [, typeKw] = openMatch;
      const collected: string[] = [];
      let j = i + 1;
      let closeMatch: RegExpExecArray | null = null;
      for (; j < lines.length; j++) {
        const inner = lines[j] ?? '';
        const close = MULTI_LINE_IMPORT_CLOSE.exec(inner);
        if (close) {
          closeMatch = close;
          break;
        }
        collected.push(inner);
      }
      if (closeMatch) {
        const namesBlob = collected.join(',');
        const specifier = closeMatch[1] ?? '';
        out.push({
          raw: lines.slice(i, j + 1).join('\n'),
          lineNumber: i + 1,
          typeOnly: Boolean(typeKw),
          names: splitNames(namesBlob),
          specifier,
        });
        i = j;
      }
    }
  }
  return out;
}

function splitNames(blob: string): readonly string[] {
  return blob
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** True for `./` or `../` specifiers. External (`@scope/x`, `node:fs`) → false. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Pull the base-file kind (`model` / `repository` / `controller` /
 * `datasource`) and PascalCase stem out of a relative import specifier like
 * `'../models/order.base.model'`. Returns `null` for non-base relative
 * specifiers (which the invariant test rejects up the call stack).
 */
function classifyBaseImport(
  specifier: string,
): {kind: keyof typeof KNOWN_BASE_EXPORTS; stemPascal: string} | null {
  const match =
    /\/?([a-z0-9-]+)\.base\.(model|repository|controller|datasource)$/.exec(
      specifier,
    );
  if (!match) return null;
  const stemKebab = match[1] ?? '';
  const kind = match[2] as keyof typeof KNOWN_BASE_EXPORTS;
  const stemPascal = stemKebab
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return {kind, stemPascal};
}

/** Render a template against `viewModel` using the real EjsTemplateEngine. */
const ENGINE = new EjsTemplateEngine(resolve(__dirname, '..', '..'));
const TEMPLATES_DIR = resolve(__dirname, '..', '..', 'templates');
const ALL_BASE_TEMPLATES = [
  'model.base.ts.ejs',
  'repository.base.ts.ejs',
  'controller.base.ts.ejs',
  'datasource.base.ts.ejs',
].map(f => resolve(TEMPLATES_DIR, f));

beforeAll(async () => {
  await ENGINE.preload(ALL_BASE_TEMPLATES);
});

function renderTemplate(filename: string, viewModel: object): string {
  return ENGINE.render(resolve(TEMPLATES_DIR, filename), viewModel);
}

/**
 * Walk every parsed import and assert it satisfies the base-only invariant.
 * Returns an array of human-readable violation messages (empty on success).
 */
function findViolations(filename: string, source: string): readonly string[] {
  const violations: string[] = [];
  for (const imp of parseImports(source)) {
    if (!isRelative(imp.specifier)) continue;
    if (!imp.specifier.includes('.base.')) {
      violations.push(
        `${filename}:${imp.lineNumber} — relative import '${imp.specifier}' ` +
          `does not target a base file (must contain '.base.')`,
      );
      continue;
    }
    const classified = classifyBaseImport(imp.specifier);
    if (!classified) {
      violations.push(
        `${filename}:${imp.lineNumber} — relative import '${imp.specifier}' ` +
          `does not match the expected '<kebab>.base.<kind>' shape`,
      );
      continue;
    }
    const expected = KNOWN_BASE_EXPORTS[classified.kind](classified.stemPascal);
    if (expected.size === 0) continue;
    for (const name of imp.names) {
      if (!expected.has(name)) {
        violations.push(
          `${filename}:${imp.lineNumber} — symbol '${name}' is not a known ` +
            `export of '${imp.specifier}' (expected one of: ` +
            `${[...expected].sort().join(', ')})`,
        );
      }
    }
  }
  return violations;
}

// -- Fixture view-models ----------------------------------------------------

/** Model fixture: exercises properties, relations, and external imports. */
const MODEL_VIEW = {
  className: 'Customer',
  baseClass: 'Entity',
  modelSettings: '{settings: {strict: true}}',
  imports: [
    // Cross-model imports MUST reference the *Base symbols — the bare class
    // names live only on the (skipIfExists) extension file.
    {
      specifier: './order.base.model',
      names: ['OrderBase', 'OrderBaseWithRelations'],
      typeOnly: false,
    },
  ],
  properties: [
    {
      name: 'id',
      tsType: 'string',
      required: true,
      optionsLiteral: '{type: String, id: true, required: true}',
    },
    {
      name: 'name',
      tsType: 'string',
      required: false,
      optionsLiteral: '{type: String}',
    },
  ],
  relations: [
    {
      name: 'orders',
      kind: 'hasMany',
      targetClass: 'OrderBase',
      relationsType: 'OrderBaseWithRelations[]',
      optionsArg: '',
      fieldDecl: '?: OrderBase[]',
    },
  ],
  relationKinds: ['hasMany'],
};

/** Repository fixture: exercises relations, factoryImports, factoryTypeImports. */
const REPOSITORY_VIEW = {
  className: 'Customer',
  baseClassName: 'CustomerBase',
  relationsTypeName: 'CustomerBaseRelations',
  idType: 'string',
  dataSourceName: 'primary',
  dataSourceClass: 'PrimaryBaseDataSource',
  modelImportPath: '../models/customer.base.model',
  dataSourceImportPath: '../datasources/primary.base.datasource',
  factoryImports: ['createHasManyRepositoryFactoryFor'],
  factoryTypeImports: ['HasManyRepositoryFactory'],
  relations: [
    {
      name: 'orders',
      accessorName: 'orders',
      factoryFnName: 'createHasManyRepositoryFactoryFor',
      factoryTypeImport: 'HasManyRepositoryFactory',
      factoryReturnType:
        'HasManyRepositoryFactory<OrderBase, typeof CustomerBase.prototype.id>',
      targetClass: 'OrderBase',
      targetWithRelations: 'OrderBaseWithRelations',
      targetRepoClass: 'OrderBaseRepository',
      targetRepoBindingName: 'OrderRepository',
      targetImportPath: '../models/order.base.model',
      targetRepoImportPath: './order.base.repository',
      getterName: 'ordersRepositoryGetter',
      relationName: 'orders',
    },
  ],
};

/** Controller fixture: exercises the `isPublic` branch (full CRUD body). */
const CONTROLLER_VIEW = {
  name: 'CustomerBase',
  controllerName: 'Customer',
  isPublic: true,
  idProperty: 'id',
  idType_: 'string',
};

/** Datasource fixture: simplest of the four; no conditional import branches. */
const DATASOURCE_VIEW = {
  name: 'primary',
  configLiteral: `{
  name: 'primary',
  connector: 'memory',
}`,
};

// -- Specs ------------------------------------------------------------------

describe('model.base.ts.ejs', () => {
  it('every relative import targets a sibling base file', () => {
    const rendered = renderTemplate('model.base.ts.ejs', MODEL_VIEW);
    const violations = findViolations('model.base.ts.ejs', rendered).filter(
      v =>
        v.includes('does not target a base file') ||
        v.includes('does not match the expected'),
    );
    expect(violations).toEqual([]);
  });

  it('every imported symbol matches the target base file’s known exports', () => {
    const rendered = renderTemplate('model.base.ts.ejs', MODEL_VIEW);
    const violations = findViolations('model.base.ts.ejs', rendered).filter(v =>
      v.includes('is not a known export'),
    );
    expect(violations).toEqual([]);
  });
});

describe('repository.base.ts.ejs', () => {
  it('every relative import targets a sibling base file', () => {
    const rendered = renderTemplate('repository.base.ts.ejs', REPOSITORY_VIEW);
    const violations = findViolations(
      'repository.base.ts.ejs',
      rendered,
    ).filter(
      v =>
        v.includes('does not target a base file') ||
        v.includes('does not match the expected'),
    );
    expect(violations).toEqual([]);
  });

  it('every imported symbol matches the target base file’s known exports', () => {
    const rendered = renderTemplate('repository.base.ts.ejs', REPOSITORY_VIEW);
    const violations = findViolations(
      'repository.base.ts.ejs',
      rendered,
    ).filter(v => v.includes('is not a known export'));
    expect(violations).toEqual([]);
  });
});

describe('controller.base.ts.ejs', () => {
  it('every relative import targets a sibling base file', () => {
    const rendered = renderTemplate('controller.base.ts.ejs', CONTROLLER_VIEW);
    const violations = findViolations(
      'controller.base.ts.ejs',
      rendered,
    ).filter(
      v =>
        v.includes('does not target a base file') ||
        v.includes('does not match the expected'),
    );
    expect(violations).toEqual([]);
  });

  it('every imported symbol matches the target base file’s known exports', () => {
    const rendered = renderTemplate('controller.base.ts.ejs', CONTROLLER_VIEW);
    const violations = findViolations(
      'controller.base.ts.ejs',
      rendered,
    ).filter(v => v.includes('is not a known export'));
    expect(violations).toEqual([]);
  });
});

describe('datasource.base.ts.ejs', () => {
  it('every relative import targets a sibling base file', () => {
    const rendered = renderTemplate('datasource.base.ts.ejs', DATASOURCE_VIEW);
    const violations = findViolations(
      'datasource.base.ts.ejs',
      rendered,
    ).filter(
      v =>
        v.includes('does not target a base file') ||
        v.includes('does not match the expected'),
    );
    expect(violations).toEqual([]);
  });

  it('every imported symbol matches the target base file’s known exports', () => {
    const rendered = renderTemplate('datasource.base.ts.ejs', DATASOURCE_VIEW);
    const violations = findViolations(
      'datasource.base.ts.ejs',
      rendered,
    ).filter(v => v.includes('is not a known export'));
    expect(violations).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// Override-routing invariants — every DI decorator that resolves a
// REPOSITORY binding must use the EXTENSION class NAME as a string, not the
// base class reference. LB4's repository booter auto-discovers
// `<name>.repository.ts` (the extension) and binds it at
// `repositories.<ExtName>`; the base file is never auto-bound, so a
// decorator referencing the base class would resolve a key that doesn't
// exist and silently bypass every user override. These tests lock the
// shape down so a future template edit can't regress us back into the bug.
// --------------------------------------------------------------------------

describe('override-routing decorators in generated base files', () => {
  /** Strip `//` line comments so negative-match assertions don't trip on JSDoc that QUOTES the buggy form for context. */
  function stripLineComments(src: string): string {
    return src
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n');
  }

  it('controller.base.ts.ejs: @repository(...) uses the extension class NAME as a string', () => {
    const rendered = renderTemplate('controller.base.ts.ejs', CONTROLLER_VIEW);
    const code = stripLineComments(rendered);
    // Must bind by extension name (`CustomerRepository`) as a string,
    // never by the base class reference.
    expect(code).toContain("@repository('CustomerRepository')");
    expect(code).not.toMatch(/@repository\(\s*CustomerBaseRepository/);
  });

  it('repository.base.ts.ejs: @repository.getter(...) uses extension class NAME for relation bindings', () => {
    const rendered = renderTemplate('repository.base.ts.ejs', REPOSITORY_VIEW);
    const code = stripLineComments(rendered);
    // Relation getter must bind to `OrderRepository` (extension), not
    // `OrderBaseRepository` (base).
    expect(code).toContain("@repository.getter('OrderRepository')");
    expect(code).not.toContain("@repository.getter('OrderBaseRepository')");
  });

  it('repository.base.ts.ejs: relation getter TYPE annotation still references the base class', () => {
    // The type stays on the base — extension extends base, so the getter is
    // structurally compatible at runtime, and the import works on the first
    // `lb4 gen` run before any extension stub edits.
    const rendered = renderTemplate('repository.base.ts.ejs', REPOSITORY_VIEW);
    expect(rendered).toContain('Getter<OrderBaseRepository>');
  });
});
