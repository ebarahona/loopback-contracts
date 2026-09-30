import type * as NodePath from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  modelsImportPrefix,
  placeModelOutputs,
  resolveModelsDir,
} from '../../helpers/output-layout';

// Run the layout helpers against Windows path semantics on any host
// (`vi.mock` is hoisted above the import).
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof NodePath>('node:path');
  return {...actual.win32, default: actual.win32};
});

const ROOT = 'C:\\work\\app';
const AUTHORED = {
  schemasDir: 'C:\\work\\app\\schemas',
  configsDir: 'C:\\work\\app\\configs',
};
const FILES = [
  {path: 'models/money.zod.ts', content: ''},
  {path: 'repositories/money.base.repository.ts', content: ''},
];

function layout(modelsDir: string): {
  root: string;
  outputDir: string;
  modelsDir: string;
} {
  return {root: ROOT, outputDir: `${ROOT}\\src`, modelsDir};
}

describe('outputDir layout (win32)', () => {
  it('emits POSIX import prefixes and paths', () => {
    const p = layout('C:\\work\\app\\lib\\contracts');
    expect(modelsImportPrefix(p, 'repositories')).toBe('../../lib/contracts');
    const placed = placeModelOutputs(FILES, p);
    expect(placed.files.map(f => f.path)).toEqual([
      'lib/contracts/money.zod.ts',
      'repositories/money.base.repository.ts',
    ]);
    expect(placed.perFileRoots.get('lib/contracts/money.zod.ts')).toBe(ROOT);
  });

  it('keeps a `..`-prefixed directory inside outputDir', () => {
    const placed = placeModelOutputs(FILES, layout(`${ROOT}\\src\\..gen`));
    expect(placed.files.map(f => f.path)[0]).toBe('..gen/money.zod.ts');
    expect(placed.perFileRoots.size).toBe(0);
  });

  it('rejects another drive and reserved directories', () => {
    expect(resolveModelsDir(ROOT, 'D:\\other', AUTHORED).ok).toBe(false);
    expect(resolveModelsDir(ROOT, '..\\elsewhere', AUTHORED).ok).toBe(false);
    expect(resolveModelsDir(ROOT, 'node_modules\\x', AUTHORED)).toEqual({
      ok: false,
      problem: "must not be inside 'node_modules'",
    });
    expect(resolveModelsDir(ROOT, '..foo', AUTHORED)).toEqual({
      ok: true,
      modelsDir: 'C:\\work\\app\\..foo',
    });
  });
});
