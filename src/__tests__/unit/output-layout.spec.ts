import {describe, expect, it} from 'vitest';
import {DefaultProjectPaths} from '../../engine';
import {
  ContractsValidationError,
  modelsImportPrefix,
  placeModelOutputs,
  resolveModelsDir,
} from '../../helpers';
import type {EmittedFile} from '../../interfaces';
import type {LoopbackConfigJson} from '../../types';

const ROOT = '/work/app';
const CONFIG: LoopbackConfigJson = {
  name: 't',
  schemasDir: './schemas',
  configsDir: './configs',
  validator: 'zod',
  schemas: ['./schemas'],
  emit: {},
};

function paths(outputDir?: string): DefaultProjectPaths {
  return new DefaultProjectPaths(ROOT, {
    ...CONFIG,
    ...(outputDir !== undefined ? {outputDir} : {}),
  });
}

const AUTHORED = {
  schemasDir: '/work/app/schemas',
  configsDir: '/work/app/configs',
};

const FILES: EmittedFile[] = [
  {path: 'models/money.zod.ts', content: ''},
  {path: 'models/index.ts', content: ''},
  {path: 'repositories/money.base.repository.ts', content: ''},
];

describe('outputDir layout', () => {
  it('defaults the models directory to src/models', () => {
    expect(paths().modelsDir).toBe('/work/app/src/models');
    expect(modelsImportPrefix(paths(), 'repositories')).toBe('../models');
    const placed = placeModelOutputs(FILES, paths());
    expect(placed.files).toBe(FILES);
    expect(placed.perFileRoots.size).toBe(0);
  });

  it('relocates the models bucket inside src', () => {
    const p = paths('src/generated');
    expect(modelsImportPrefix(p, 'controllers')).toBe('../generated');
    const placed = placeModelOutputs(FILES, p);
    expect(placed.files.map(f => f.path)).toEqual([
      'generated/money.zod.ts',
      'generated/index.ts',
      'repositories/money.base.repository.ts',
    ]);
    expect(placed.perFileRoots.size).toBe(0);
  });

  it('anchors a models directory outside src at the project root', () => {
    const p = paths('lib/contracts');
    expect(modelsImportPrefix(p, 'repositories')).toBe('../../lib/contracts');
    const placed = placeModelOutputs(FILES, p);
    expect(placed.files.map(f => f.path)).toEqual([
      'lib/contracts/money.zod.ts',
      'lib/contracts/index.ts',
      'repositories/money.base.repository.ts',
    ]);
    expect([...placed.perFileRoots]).toEqual([
      ['lib/contracts/money.zod.ts', ROOT],
      ['lib/contracts/index.ts', ROOT],
    ]);
  });

  it('rejects a models directory outside the project root', () => {
    for (const bad of ['../elsewhere', '/tmp/x', '.', '..']) {
      expect(resolveModelsDir(ROOT, bad, AUTHORED)).toEqual({
        ok: false,
        problem: 'must be a directory inside the project root',
      });
      expect(() => paths(bad)).toThrow(ContractsValidationError);
    }
  });

  it('accepts a sibling directory whose name starts with two dots', () => {
    expect(resolveModelsDir(ROOT, '..foo', AUTHORED)).toEqual({
      ok: true,
      modelsDir: '/work/app/..foo',
    });
    const p = paths('..foo/models');
    expect(p.modelsDir).toBe('/work/app/..foo/models');
    const placed = placeModelOutputs(FILES, p);
    expect(placed.files.map(f => f.path)).toContain(
      '..foo/models/money.zod.ts',
    );
    expect(placed.perFileRoots.get('..foo/models/money.zod.ts')).toBe(ROOT);
  });

  it('keeps a models directory under a `..`-prefixed name inside outputDir', () => {
    const placed = placeModelOutputs(FILES, paths('src/..gen'));
    expect(placed.files.map(f => f.path)).toContain('..gen/money.zod.ts');
    expect(placed.perFileRoots.size).toBe(0);
  });

  it('rejects models directories that overlap reserved or authored ones', () => {
    const cases: Array<[string, string]> = [
      ['node_modules/x', "must not be inside 'node_modules'"],
      ['packages/a/node_modules', "must not be inside 'node_modules'"],
      ['.git/models', "must not be inside '.git'"],
      ['_meta', "must not be inside '_meta'"],
      ['.loopback/cache', "must not be inside '.loopback'"],
      ['schemas', "must not be inside the schemas directory 'schemas'"],
      [
        'schemas/generated',
        "must not be inside the schemas directory 'schemas'",
      ],
      ['configs', "must not be inside the configs directory 'configs'"],
    ];
    for (const [bad, problem] of cases) {
      expect(resolveModelsDir(ROOT, bad, AUTHORED)).toEqual({
        ok: false,
        problem,
      });
      expect(() => paths(bad)).toThrow(
        `loopback.config.json 'outputDir' ${problem}; got '${bad}'`,
      );
    }
  });
});
