import type * as tsMorphTypes from 'ts-morph';
import {ContractsCodegenError, ContractsPeerDepMissingError} from '../helpers';
import type {EmittedFile} from '../interfaces';

// ts-morph's public API is narrow but its symbol / reference graph types
// are not all exported in friendly form. We pull the package namespace as
// a type-only import and pin only the surface we actually call. The value
// side of the dependency is loaded lazily via `require('ts-morph')` inside
// `loadTsMorph()` so projects that never enable `--esm` do not pay for
// the install. Anything outside the pinned surface is treated as
// `unknown` and discriminated at the call site via `getKind()` /
// `getKindName()` checks — the same discipline used elsewhere in this
// engine when touching driver-shaped internals.
type TsMorph = typeof tsMorphTypes;
type TsMorphSourceFile = tsMorphTypes.SourceFile;
type TsMorphImportDeclaration = tsMorphTypes.ImportDeclaration;
type TsMorphExportDeclaration = tsMorphTypes.ExportDeclaration;
type TsMorphImportSpecifier = tsMorphTypes.ImportSpecifier;
type TsMorphExportSpecifier = tsMorphTypes.ExportSpecifier;
type TsMorphNode = tsMorphTypes.Node;

/**
 * Options that drive the engine's module-format normalisation pass.
 *
 * @internal
 */
export interface ModuleFormatTransformerOptions {
  /**
   * When `false`, the transformer is a pure pass-through and never loads
   * `ts-morph`. When `true`, every `.ts` descriptor is rewritten for
   * strict-ESM emission per the rules in `loopback-contracts.md`
   * (relative-path extension, type-only `import` / `export` discipline,
   * CJS-syntax refusal).
   */
  readonly esm: boolean;

  /**
   * Extension appended to relative `import` / `export` module specifiers
   * when `esm` is `true`. `'.js'` for Node native ESM + TS `NodeNext`
   * (the documented default), `'.ts'` for Deno or
   * `allowImportingTsExtensions`, `''` for bundler-only flows where the
   * resolver fills in the extension.
   */
  readonly importExtension: '.js' | '.ts' | '';
}

/**
 * Module specifier extensions the rewriter must leave alone. Includes
 * non-source assets emitters routinely import (`*.json`, `*.css`,
 * `*.graphql`, `*.yaml`, etc.) plus `.js` / `.ts` themselves so an
 * already-extensioned path is never double-suffixed.
 */
const ALREADY_EXTENSIONED: ReadonlySet<string> = new Set([
  '.json',
  '.css',
  '.graphql',
  '.gql',
  '.yaml',
  '.yml',
  '.proto',
  '.avsc',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.jsx',
]);

/**
 * CJS-only syntax that must never appear in `--esm` output. Emitters are
 * free to produce these constructs in default mode; the transformer
 * refuses them only when ESM emit is enabled. The match is intentionally
 * a word-boundary regex rather than a full TypeScript parse — false
 * positives in string literals are vanishingly rare in generated code and
 * the early refusal keeps the failure mode actionable (it names the exact
 * forbidden token).
 */
const CJS_FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  {pattern: /\brequire\s*\(/, label: 'require('},
  {pattern: /\bmodule\.exports\b/, label: 'module.exports'},
  {pattern: /\bexports\./, label: 'exports.'},
  {pattern: /\b__dirname\b/, label: '__dirname'},
  {pattern: /\b__filename\b/, label: '__filename'},
];

/**
 * Engine-owned transformer that applies ESM module-format normalisation
 * to emitted TypeScript output before it reaches the {@link FileWriter}.
 *
 * Runs uniformly across every emitter (built-in or third-party). Emitters
 * continue returning ordinary ES-module-style TypeScript content — this is
 * NOT an emitter concern. See `contracts-extensibility.md` §"Module-format
 * choice" and `loopback-contracts.md` §"ESM emit (`--esm` flag, default
 * off)" for the full design.
 *
 * Default mode (`esm: false`) is pass-through and never loads `ts-morph`.
 * ESM mode (`esm: true`):
 *
 * - Rewrites relative `import` / `export` module specifiers to append
 *   {@link ModuleFormatTransformerOptions.importExtension}, with the
 *   already-extensioned guard preventing double-suffixing for assets the
 *   emitter named with their real extension.
 * - Narrows mixed runtime/type imports via inline `type` modifiers
 *   (TS 4.5+), and hoists to declaration-level `import type` when every
 *   named import is type-only.
 * - Converts `export { Foo } from './bar'` re-exports to
 *   `export type { Foo } from './bar'` when every named export resolves
 *   to a type-only declaration.
 * - Refuses any output that contains CJS-only syntax
 *   (`require(`, `module.exports`, `exports.`, `__dirname`, `__filename`)
 *   with a {@link ContractsCodegenError} that names the offending token.
 *
 * `ts-morph` is loaded lazily on first ESM transform; absence surfaces as
 * {@link ContractsPeerDepMissingError} with a precise `npm install` hint.
 *
 * @internal
 */
export class ModuleFormatTransformer {
  constructor(private readonly opts: ModuleFormatTransformerOptions) {}

  /**
   * Apply the transformer to every descriptor in the batch. Returns a new
   * array — callers (the engine pipeline) treat the result as the
   * canonical input to {@link FileWriter.writeAll}.
   *
   * In default mode this is a `slice()` clone and never touches the
   * `ts-morph` dependency. In ESM mode every `.ts` descriptor is reparsed
   * and rewritten; non-`.ts` descriptors pass through verbatim because
   * they cannot contain TypeScript import syntax.
   *
   * @internal
   */
  transform(files: readonly EmittedFile[]): EmittedFile[] {
    if (!this.opts.esm) return files.slice();
    const tsMorph = loadTsMorph();
    return files.map(f => this.transformOne(f, tsMorph));
  }

  private transformOne(file: EmittedFile, tsMorph: TsMorph): EmittedFile {
    if (!file.path.endsWith('.ts')) return file;

    // Fast textual refusal of CJS-only syntax. We do this before
    // touching `ts-morph` so the error path stays cheap and the message
    // names the specific token rather than an AST node label.
    for (const {pattern, label} of CJS_FORBIDDEN_PATTERNS) {
      if (pattern.test(file.content)) {
        throw new ContractsCodegenError(
          `ESM emit refused: file '${file.path}' contains forbidden ` +
            `CJS syntax '${label}'`,
          {
            emitterKind: file.producer ?? 'module-format-transformer',
            schemaId: '',
            outputPath: file.path,
          },
        );
      }
    }

    const project = new tsMorph.Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        target: tsMorph.ScriptTarget.ES2022,
        module: tsMorph.ModuleKind.ESNext,
        moduleResolution: tsMorph.ModuleResolutionKind.NodeNext,
        allowImportingTsExtensions: this.opts.importExtension === '.ts',
        noEmit: true,
        strict: false,
        skipLibCheck: true,
      },
    });

    const sourceFile = project.createSourceFile('input.ts', file.content);

    rewriteTypeOnlyImports(sourceFile, tsMorph);
    rewriteTypeOnlyReExports(sourceFile, tsMorph);
    rewriteRelativePaths(sourceFile, this.opts.importExtension);

    return {...file, content: sourceFile.getFullText()};
  }
}

/**
 * Lazy-load `ts-morph`. The dependency is declared as an optional peer so
 * projects that never enable `--esm` do not pay for the install. A
 * missing peer surfaces as a typed
 * {@link ContractsPeerDepMissingError} carrying the precise package name
 * the user must `npm install`; every other failure (a corrupt install,
 * an unexpected Node module-resolution error) is re-thrown unchanged so
 * the original stack trace is preserved for diagnosis.
 */
function loadTsMorph(): TsMorph {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ts-morph') as TsMorph;
  } catch (err) {
    const code = (err as {code?: unknown} | null)?.code;
    if (
      code === 'MODULE_NOT_FOUND' ||
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ) {
      throw new ContractsPeerDepMissingError({
        emitterKind: 'module-format-transformer',
        packageName: 'ts-morph',
      });
    }
    throw err;
  }
}

/**
 * Walk every `import` declaration and either:
 *
 * - Hoist to declaration-level `import type` when every named import is
 *   used exclusively in type positions, or
 * - Mark individual named imports inline with the `type` modifier when
 *   they alone are type-only inside a mixed declaration.
 *
 * Default-only or namespace-only imports (`import x from 'm'`,
 * `import * as ns from 'm'`) are left alone — TS does not let those use
 * `import type` granularly and the runtime cost is zero.
 */
function rewriteTypeOnlyImports(
  sourceFile: TsMorphSourceFile,
  tsMorph: TsMorph,
): void {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.isTypeOnly()) continue;

    const namedImports = importDecl.getNamedImports();
    if (namedImports.length === 0) continue;

    // Per-named classification. We collect the verdicts first and only
    // mutate after; mutating mid-iteration confuses ts-morph's
    // reference tracking.
    const verdicts: boolean[] = [];
    let allTypeOnly = true;
    for (const named of namedImports) {
      const isTypeOnly = isNamedImportTypeOnly(named, tsMorph);
      verdicts.push(isTypeOnly);
      if (!isTypeOnly) allTypeOnly = false;
    }

    if (allTypeOnly) {
      importDecl.setIsTypeOnly(true);
      // Belt-and-braces: clear any pre-existing inline modifiers so the
      // declaration-level modifier is the single source of truth.
      for (const named of namedImports) {
        if (named.isTypeOnly()) named.setIsTypeOnly(false);
      }
      continue;
    }

    // Mixed declaration — only the type-only entries get the inline
    // `type` modifier. Runtime imports stay bare.
    for (let i = 0; i < namedImports.length; i++) {
      if (verdicts[i] === true) {
        const named = namedImports[i];
        if (named !== undefined && !named.isTypeOnly()) {
          named.setIsTypeOnly(true);
        }
      }
    }
  }
}

/**
 * Decide whether a single `import { X }` specifier is referenced
 * exclusively in type positions inside the same source file.
 *
 * Strategy: walk every reference to the imported symbol via
 * `getNameNode().findReferencesAsNodes()`. Skip the
 * declaration site itself (`ImportSpecifier` parent). Every remaining
 * reference must sit in a recognised type-syntax position. A single
 * value-position reference makes the whole binding runtime-relevant.
 *
 * If the symbol cannot be resolved (orphan, parse error, etc.) we
 * conservatively report "not type-only" so we never strip a runtime
 * import the resolver could not classify.
 */
function isNamedImportTypeOnly(
  named: TsMorphImportSpecifier,
  tsMorph: TsMorph,
): boolean {
  // The local binding is the alias when present (`{Foo as F}`), otherwise
  // the name itself. String-literal names (`{'foo bar' as F}`) can only
  // appear with an alias, so a missing alias guarantees the name is an
  // Identifier — but we still type-narrow defensively.
  const aliasNode = named.getAliasNode();
  const localBinding = aliasNode ?? named.getNameNode();
  if (localBinding.getKind() !== tsMorph.SyntaxKind.Identifier) {
    return false;
  }
  // The Identifier branch carries `findReferencesAsNodes`; cast through
  // a structural type because ts-morph's union type doesn't expose it on
  // StringLiteral and the `getKind()` check above already proved we're
  // on the Identifier branch.
  const refs = (
    localBinding as unknown as {findReferencesAsNodes: () => TsMorphNode[]}
  ).findReferencesAsNodes();
  if (refs.length === 0) return false;

  let sawNonDeclarationRef = false;
  for (const ref of refs) {
    const parent = ref.getParent();
    if (parent === undefined) return false;
    const parentKind = parent.getKind();
    // Skip the declaration site — it's not a "use".
    if (parentKind === tsMorph.SyntaxKind.ImportSpecifier) continue;
    sawNonDeclarationRef = true;
    if (!isReferenceInTypePosition(ref, tsMorph)) return false;
  }
  // An import with no non-declaration references is treated as not
  // type-only — leaving it alone is the safer default since the symbol
  // might be referenced in a way ts-morph could not trace.
  return sawNonDeclarationRef;
}

/**
 * Classify a single reference site.
 *
 * Cases we treat as type-only:
 *
 * - Parent is a type-syntax node: `TypeReference`, `TypeQuery`,
 *   `TypeAliasDeclaration`, `InterfaceDeclaration`, `TypeOperator`,
 *   `TypePredicate`, `TypeLiteral`, `MappedType`, `IndexedAccessType`,
 *   `ConditionalType`, `RestType`, `TupleType`.
 * - Parent is `ExpressionWithTypeArguments` whose grandparent is an
 *   `InterfaceDeclaration`'s heritage clause OR a class's `implements`
 *   clause. A class's `extends` clause is a runtime reference.
 *
 * Everything else (CallExpression, NewExpression, VariableDeclaration,
 * PropertyAccessExpression, ReturnStatement, BinaryExpression, etc.)
 * is a value position.
 */
function isReferenceInTypePosition(
  ref: TsMorphNode,
  tsMorph: TsMorph,
): boolean {
  const parent = ref.getParent();
  if (parent === undefined) return false;
  const kind = parent.getKind();

  if (
    kind === tsMorph.SyntaxKind.TypeReference ||
    kind === tsMorph.SyntaxKind.TypeQuery ||
    kind === tsMorph.SyntaxKind.TypeAliasDeclaration ||
    kind === tsMorph.SyntaxKind.InterfaceDeclaration ||
    kind === tsMorph.SyntaxKind.TypeOperator ||
    kind === tsMorph.SyntaxKind.TypePredicate ||
    kind === tsMorph.SyntaxKind.TypeLiteral ||
    kind === tsMorph.SyntaxKind.MappedType ||
    kind === tsMorph.SyntaxKind.IndexedAccessType ||
    kind === tsMorph.SyntaxKind.ConditionalType ||
    kind === tsMorph.SyntaxKind.RestType ||
    kind === tsMorph.SyntaxKind.TupleType ||
    kind === tsMorph.SyntaxKind.ArrayType
  ) {
    return true;
  }

  if (kind === tsMorph.SyntaxKind.ExpressionWithTypeArguments) {
    // Look at the heritage clause / declaration container to decide.
    const grandparent = parent.getParent();
    if (grandparent === undefined) return false;
    if (grandparent.getKind() !== tsMorph.SyntaxKind.HeritageClause) {
      return false;
    }
    // ts-morph exposes the heritage token on HeritageClause; the
    // implements clause is always type-only, and an interface's
    // extends clause is type-only. A class's extends clause is a
    // runtime reference (the base class is a value).
    const heritage = grandparent;
    const heritageToken = (
      heritage as unknown as {getToken: () => number}
    ).getToken();
    if (heritageToken === tsMorph.SyntaxKind.ImplementsKeyword) {
      return true;
    }
    if (heritageToken === tsMorph.SyntaxKind.ExtendsKeyword) {
      const container = heritage.getParent();
      if (container === undefined) return false;
      return container.getKind() === tsMorph.SyntaxKind.InterfaceDeclaration;
    }
    return false;
  }

  return false;
}

/**
 * Walk every `export … from './x'` re-export and convert to
 * `export type` when every named export resolves to a type-only
 * declaration (`TypeAliasDeclaration` or `InterfaceDeclaration`). Bare
 * `export {x}` without a `from` clause is also handled — local type-only
 * re-exports get the same treatment.
 *
 * A re-export of a runtime value (`class`, `function`, `const`, `enum`)
 * is left alone — making it `export type` would strip the runtime
 * binding from the consumer.
 */
function rewriteTypeOnlyReExports(
  sourceFile: TsMorphSourceFile,
  tsMorph: TsMorph,
): void {
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    if (exportDecl.isTypeOnly()) continue;
    const namedExports = exportDecl.getNamedExports();
    if (namedExports.length === 0) continue;

    let allTypeOnly = true;
    for (const named of namedExports) {
      if (!isExportSpecifierTypeOnly(named, tsMorph)) {
        allTypeOnly = false;
        break;
      }
    }
    if (allTypeOnly) exportDecl.setIsTypeOnly(true);
  }
}

/**
 * Walk the symbol's declaration list and report whether every
 * declaration is a type-only construct. We follow alias chains via
 * `getAliasedSymbol()` so a re-exported `ExportSpecifier` resolves to
 * its original declaration in the imported module.
 *
 * Conservative on resolution failure (returns `false`): if the symbol
 * cannot be classified, keep the runtime form.
 */
function isExportSpecifierTypeOnly(
  named: TsMorphExportSpecifier,
  tsMorph: TsMorph,
): boolean {
  const sym = named.getSymbol();
  if (sym === undefined) return false;

  // Follow alias chains — `export {Foo} from './m'` makes Foo an
  // ExportSpecifier alias for the original declaration in './m'.
  let resolved = sym;
  const aliased = (
    resolved as unknown as {
      getAliasedSymbol?: () => typeof resolved | undefined;
    }
  ).getAliasedSymbol?.();
  if (aliased !== undefined) resolved = aliased;

  const decls = resolved.getDeclarations();
  if (decls.length === 0) return false;

  for (const decl of decls) {
    const kind = decl.getKind();
    if (
      kind !== tsMorph.SyntaxKind.TypeAliasDeclaration &&
      kind !== tsMorph.SyntaxKind.InterfaceDeclaration
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Rewrite every relative `import` / `export` module specifier to append
 * the configured extension. Bare-module specifiers (`@scope/pkg`,
 * `node:fs`, `lodash`) and already-extensioned paths are left alone.
 *
 * `importExtension === ''` (bundler-only mode) short-circuits the entire
 * pass — extensionless specifiers are what bundler resolvers expect.
 */
function rewriteRelativePaths(
  sourceFile: TsMorphSourceFile,
  extension: '.js' | '.ts' | '',
): void {
  if (extension === '') return;

  const rewrite = (current: string): string => {
    if (!current.startsWith('./') && !current.startsWith('../')) {
      return current;
    }
    const lastSegment = current.split('/').pop() ?? '';
    const dotIdx = lastSegment.lastIndexOf('.');
    if (dotIdx > 0) {
      const ext = lastSegment.slice(dotIdx).toLowerCase();
      if (ALREADY_EXTENSIONED.has(ext)) return current;
    }
    return current + extension;
  };

  for (const importDecl of sourceFile.getImportDeclarations()) {
    rewriteImportModuleSpecifier(importDecl, rewrite);
  }
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    rewriteExportModuleSpecifier(exportDecl, rewrite);
  }
}

function rewriteImportModuleSpecifier(
  importDecl: TsMorphImportDeclaration,
  rewrite: (s: string) => string,
): void {
  const current = importDecl.getModuleSpecifierValue();
  const next = rewrite(current);
  if (next !== current) importDecl.setModuleSpecifier(next);
}

function rewriteExportModuleSpecifier(
  exportDecl: TsMorphExportDeclaration,
  rewrite: (s: string) => string,
): void {
  const current = exportDecl.getModuleSpecifierValue();
  if (current === undefined) return;
  const next = rewrite(current);
  if (next !== current) exportDecl.setModuleSpecifier(next);
}
