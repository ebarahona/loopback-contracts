// Direct unit coverage for the shared `datasources-loader` helper. Three
// CLI surfaces (`lb-contracts ds`, `lb-contracts contract`, the engine
// pipeline) all funnel through this module so a regression here surfaces
// as inconsistent diagnostics across commands — exactly the bug the helper
// was extracted to prevent. Keeping the assertions surgical (offset math,
// the error block, the missing-file branch) means the integration suites
// don't have to repeat parse-error coverage.

import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  ContractsValidationError,
  offsetToLineCol,
  readDatasourcesDoc,
} from '../../helpers';

// Single tmp tree shared by every test that needs a real file on disk —
// each test writes its own uniquely-named file so cases stay independent
// without paying the mkdir cost per `it()`.
const ROOT = join(
  tmpdir(),
  `datasources-loader-${randomBytes(8).toString('hex')}`,
);

function write(name: string, body: string): string {
  const path = join(ROOT, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

beforeAll(() => {
  mkdirSync(ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(ROOT, {recursive: true, force: true});
});

describe('offsetToLineCol()', () => {
  it('returns {line: 1, column: 1} at offset 0 (start of file, 1-based)', () => {
    expect(offsetToLineCol('anything', 0)).toEqual({line: 1, column: 1});
  });

  it("places 'b' at line 2 col 1 in 'a\\nb\\nc'", () => {
    // String: a(0) \n(1) b(2) \n(3) c(4). Offset 2 sits on 'b'.
    expect(offsetToLineCol('a\nb\nc', 2)).toEqual({line: 2, column: 1});
  });

  it("places 'c' at line 3 col 1 in 'a\\nb\\nc'", () => {
    expect(offsetToLineCol('a\nb\nc', 4)).toEqual({line: 3, column: 1});
  });

  it('clamps an offset past the end of the document to the final line/col', () => {
    // Past-end offsets must NOT throw — `jsonc-parser` occasionally
    // reports an offset at `raw.length` for EOF-token errors and the
    // pointer should still be meaningful.
    expect(offsetToLineCol('ab', 99)).toEqual({line: 1, column: 3});
  });

  it('treats negative offsets as 0 (defensive clamp)', () => {
    expect(offsetToLineCol('abc', -5)).toEqual({line: 1, column: 1});
  });
});

describe('readDatasourcesDoc()', () => {
  it('returns undefined when the file is missing (caller decides what absence means)', () => {
    const path = join(ROOT, 'definitely-not-there.json');
    expect(readDatasourcesDoc(path)).toBeUndefined();
  });

  it('returns the parsed array for the legacy top-level-array layout', () => {
    const path = write(
      'array.json',
      JSON.stringify([{name: 'mem', adapter: 'memory', config: {}}]),
    );
    const out = readDatasourcesDoc(path);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([{name: 'mem', adapter: 'memory', config: {}}]);
  });

  it('returns the parsed object for the keyed-map layout', () => {
    const path = write(
      'keyed.json',
      JSON.stringify({
        $schema: '../_meta/datasources.schema.json',
        mem: {adapter: 'memory', config: {}},
      }),
    );
    const out = readDatasourcesDoc(path);
    expect(Array.isArray(out)).toBe(false);
    expect(out).toEqual({
      $schema: '../_meta/datasources.schema.json',
      mem: {adapter: 'memory', config: {}},
    });
  });

  it('throws ContractsValidationError with path + line/column on malformed JSONC', () => {
    // Trailing comma inside an object key list with a stray quote — the
    // first parse error sits on line 2 so the message must surface
    // exactly that coordinate, not a generic "somewhere" pointer.
    const path = write('malformed.json', '{\n  "name": "mem",,\n}\n');

    let caught: unknown;
    try {
      readDatasourcesDoc(path);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ContractsValidationError);
    const err = caught as ContractsValidationError;
    expect(err.sourcePath).toBe(path);
    expect(err.message).toContain(path);
    // The diagnostic block must carry a 1-based line:column pointer the
    // user can paste straight into their editor.
    expect(err.message).toMatch(/line \d+, column \d+/);
  });

  it('throws ContractsValidationError when the document is top-level null', () => {
    const path = write('null.json', 'null');
    expect(() => readDatasourcesDoc(path)).toThrow(ContractsValidationError);
    expect(() => readDatasourcesDoc(path)).toThrow(/null/);
  });

  it('throws ContractsValidationError when the document is a top-level string', () => {
    const path = write('string.json', '"not-a-datasources-doc"');
    expect(() => readDatasourcesDoc(path)).toThrow(ContractsValidationError);
    // The error must name the actual type so the user can spot a
    // bare-value typo at a glance.
    expect(() => readDatasourcesDoc(path)).toThrow(/string/);
  });
});
