import {describe, expect, it} from 'vitest';
import {ModuleFormatTransformer} from '../../engine/module-format-transformer';
import {ContractsCodegenError} from '../../helpers';
import type {EmittedFile} from '../../interfaces';

function file(
  path: string,
  content: string,
  producer = 'test-emitter',
): EmittedFile {
  return {path, content, producer};
}

describe('ModuleFormatTransformer', () => {
  describe('default mode (esm: false)', () => {
    it('passes files through unchanged', () => {
      const t = new ModuleFormatTransformer({
        esm: false,
        importExtension: '.js',
      });
      const input: EmittedFile[] = [
        file('a.ts', "import {x} from './b';\n"),
        file('c.json', '{"a":1}\n'),
      ];
      const out = t.transform(input);
      expect(out).toHaveLength(2);
      // Pass-through preserves content verbatim — no rewrites at all.
      expect(out[0]?.content).toBe("import {x} from './b';\n");
      expect(out[1]?.content).toBe('{"a":1}\n');
    });

    it('returns a fresh array (not the same reference)', () => {
      const t = new ModuleFormatTransformer({
        esm: false,
        importExtension: '.js',
      });
      const input: EmittedFile[] = [file('a.ts', '')];
      const out = t.transform(input);
      expect(out).not.toBe(input);
    });

    it('ignores files even when they would otherwise be rewritten', () => {
      // require( exists, but default mode never inspects content.
      const t = new ModuleFormatTransformer({
        esm: false,
        importExtension: '.js',
      });
      const input = [file('a.ts', "const x = require('y');\n")];
      const out = t.transform(input);
      expect(out[0]?.content).toContain("require('y')");
    });
  });

  describe('ESM with .js extension', () => {
    const t = new ModuleFormatTransformer({esm: true, importExtension: '.js'});

    it("appends .js to './foo' relative imports", () => {
      const [out] = t.transform([
        file('m.ts', "import {x} from './foo';\nx();\n"),
      ]);
      expect(out?.content).toContain("from './foo.js'");
    });

    it("appends .js to '../foo' relative imports", () => {
      const [out] = t.transform([
        file('m.ts', "import {x} from '../foo';\nx();\n"),
      ]);
      expect(out?.content).toContain("from '../foo.js'");
    });

    it('does NOT touch bare-module imports', () => {
      const [out] = t.transform([
        file(
          'm.ts',
          "import {Context} from '@loopback/core';\nnew Context();\n",
        ),
      ]);
      expect(out?.content).toContain("from '@loopback/core'");
      expect(out?.content).not.toContain('@loopback/core.js');
    });

    it('does NOT touch scoped subpath imports', () => {
      const [out] = t.transform([
        file('m.ts', "import {x} from '@scope/pkg/foo';\nx();\n"),
      ]);
      expect(out?.content).toContain("from '@scope/pkg/foo'");
      expect(out?.content).not.toContain('@scope/pkg/foo.js');
    });

    it('does NOT touch node: scheme imports', () => {
      const [out] = t.transform([
        file('m.ts', "import fs from 'node:fs';\nfs.readFileSync('x');\n"),
      ]);
      expect(out?.content).toContain("from 'node:fs'");
    });

    it('does NOT double-extension .json imports', () => {
      const [out] = t.transform([
        file('m.ts', "import pkg from './pkg.json';\nconsole.log(pkg);\n"),
      ]);
      expect(out?.content).toContain("from './pkg.json'");
      expect(out?.content).not.toContain('.json.js');
    });

    it.each([
      ['css', "import './styles.css';"],
      ['graphql', "import './schema.graphql';"],
      ['yaml', "import './doc.yaml';"],
      ['yml', "import './doc.yml';"],
      ['proto', "import './rpc.proto';"],
      ['avsc', "import './rec.avsc';"],
      ['js', "import './already.js';"],
      ['ts', "import './already.ts';"],
    ])('does NOT double-extension %s imports', (ext, source) => {
      const [out] = t.transform([file('m.ts', source + '\n')]);
      // The original specifier survives verbatim — no second extension.
      const before = source.split("'")[1];
      expect(out?.content).toContain(`'${before}'`);
      expect(out?.content).not.toMatch(new RegExp(`\\.${ext}\\.js`));
    });

    it('converts a single-use type-only named import to import type', () => {
      const src = "import {Foo} from './m';\nconst x: Foo = {} as Foo;\n";
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain("import type {Foo} from './m.js'");
    });

    it('adds inline type modifier when one named import is type-only and another is runtime', () => {
      const src =
        "import {Foo, bar} from './m';\nconst x: Foo = {} as Foo;\nbar();\n";
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain('type Foo');
      // The declaration itself stays a runtime import (bar is a value).
      expect(out?.content).not.toContain('import type {Foo, bar}');
      expect(out?.content).toContain("from './m.js'");
    });

    it('hoists to declaration-level import type when every named import is type-only', () => {
      const src =
        "import {Foo, Bar} from './m';\nconst x: Foo = {} as Foo;\nconst y: Bar = {} as Bar;\n";
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain("import type {Foo, Bar} from './m.js'");
      // No inline type modifiers when the whole declaration is type-only.
      expect(out?.content).not.toContain('{type Foo');
    });

    it('leaves a runtime-only named import alone (no type modifier added)', () => {
      const src = "import {bar} from './m';\nbar();\n";
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain("import {bar} from './m.js'");
      expect(out?.content).not.toContain('import type');
    });

    it('treats class extends as a runtime reference (no type-only conversion)', () => {
      const src = "import {Base} from './m';\nclass K extends Base {}\n";
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain("import {Base} from './m.js'");
      expect(out?.content).not.toContain('import type');
    });

    it('treats interface extends as a type reference (converts to import type)', () => {
      const src = "import {Base} from './m';\ninterface I extends Base {}\n";
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain("import type {Base} from './m.js'");
    });

    it('treats class implements as a type reference (converts to import type)', () => {
      const src = "import {Iface} from './m';\nclass K implements Iface {}\n";
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain("import type {Iface} from './m.js'");
    });

    it('converts a re-export of a type-only declaration to export type', () => {
      const src = 'interface Local { a: number }\nexport {Local};\n';
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain('export type {Local}');
    });

    it('leaves a runtime re-export (const/function/class) alone', () => {
      const src = 'export const value = 1;\n';
      const [out] = t.transform([file('a.ts', src)]);
      // Untouched — no module specifier, no named export rewrite needed.
      expect(out?.content).toContain('export const value = 1');
      expect(out?.content).not.toContain('export type');
    });

    it('rewrites relative export … from paths too', () => {
      const src = "export {Foo} from './m';\n";
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain("from './m.js'");
    });

    it('leaves non-.ts files untouched (e.g. .json, .yaml)', () => {
      const out = t.transform([
        file('out.json', '{"x":1}\n'),
        file('out.yaml', 'a: 1\n'),
      ]);
      expect(out[0]?.content).toBe('{"x":1}\n');
      expect(out[1]?.content).toBe('a: 1\n');
    });

    it('preserves the EmittedFile metadata (producer, policy, encoding)', () => {
      const input: EmittedFile = {
        path: 'a.ts',
        content: "import {x} from './m';\nx();\n",
        producer: 'sample-emitter',
        policy: 'skipIfExists',
        encoding: 'utf-8',
      };
      const [out] = t.transform([input]);
      expect(out?.producer).toBe('sample-emitter');
      expect(out?.policy).toBe('skipIfExists');
      expect(out?.encoding).toBe('utf-8');
      expect(out?.content).toContain("from './m.js'");
    });
  });

  describe('ESM with .ts extension', () => {
    const t = new ModuleFormatTransformer({esm: true, importExtension: '.ts'});

    it("appends .ts to './foo' relative imports (Deno / allowImportingTsExtensions)", () => {
      const [out] = t.transform([
        file('m.ts', "import {x} from './foo';\nx();\n"),
      ]);
      expect(out?.content).toContain("from './foo.ts'");
    });

    it('does NOT double-extension already-.ts imports', () => {
      const [out] = t.transform([
        file('m.ts', "import {x} from './foo.ts';\nx();\n"),
      ]);
      expect(out?.content).toContain("from './foo.ts'");
      expect(out?.content).not.toContain('.ts.ts');
    });
  });

  describe('ESM with extensionless mode', () => {
    const t = new ModuleFormatTransformer({esm: true, importExtension: ''});

    it("leaves relative paths unchanged when importExtension is ''", () => {
      const [out] = t.transform([
        file('m.ts', "import {x} from './foo';\nx();\n"),
      ]);
      expect(out?.content).toContain("from './foo'");
      // No .js, .ts, or trailing dot suffix.
      expect(out?.content).not.toMatch(/from '\.\/foo\.[a-z]/);
    });

    it('still applies type-only narrowing even with no extension rewrite', () => {
      const src = "import {Foo} from './m';\nconst x: Foo = {} as Foo;\n";
      const [out] = t.transform([file('a.ts', src)]);
      expect(out?.content).toContain("import type {Foo} from './m'");
    });
  });

  describe('forbidden CJS syntax', () => {
    const t = new ModuleFormatTransformer({esm: true, importExtension: '.js'});

    it.each([
      ['require(', "const x = require('y');\n"],
      ['module.exports', 'module.exports = {};\n'],
      ['exports.', 'exports.foo = 1;\n'],
      ['__dirname', 'console.log(__dirname);\n'],
      ['__filename', 'console.log(__filename);\n'],
    ])('throws ContractsCodegenError on %s', (label, source) => {
      expect(() =>
        t.transform([file('bad.ts', source, 'bad-emitter')]),
      ).toThrow(ContractsCodegenError);
      try {
        t.transform([file('bad.ts', source, 'bad-emitter')]);
        expect.unreachable('expected throw');
      } catch (err) {
        if (err instanceof ContractsCodegenError) {
          expect(err.message).toContain(label);
          expect(err.message).toContain('bad.ts');
          expect(err.emitterKind).toBe('bad-emitter');
          expect(err.outputPath).toBe('bad.ts');
          expect(err.code).toBe('CONTRACTS_CODEGEN');
        } else {
          throw err;
        }
      }
    });

    it('falls back to module-format-transformer kind when producer is missing', () => {
      const noProducer: EmittedFile = {
        path: 'bad.ts',
        content: "const x = require('y');\n",
      };
      try {
        t.transform([noProducer]);
        expect.unreachable('expected throw');
      } catch (err) {
        if (err instanceof ContractsCodegenError) {
          expect(err.emitterKind).toBe('module-format-transformer');
        } else {
          throw err;
        }
      }
    });

    it('only checks .ts files (a .json with the word require is fine)', () => {
      const out = t.transform([
        file('out.json', '{"note": "use require()"}\n'),
      ]);
      expect(out[0]?.content).toContain('require()');
    });
  });

  describe('idempotence', () => {
    const t = new ModuleFormatTransformer({esm: true, importExtension: '.js'});

    it('running the transformer twice produces the same output', () => {
      const src =
        "import {Foo, bar} from './m';\nconst x: Foo = {} as Foo;\nbar();\n";
      const once = t.transform([file('a.ts', src)]);
      const twice = t.transform(once);
      expect(twice[0]?.content).toBe(once[0]?.content);
    });
  });
});
