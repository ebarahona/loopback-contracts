import {randomBytes} from 'node:crypto';
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ContractsSourceError} from '../../helpers';
import {LocalSchemaSource} from '../../sources/local-source';

let SANDBOX: string;
let PROJECT: string;
let SCHEMAS_DIR: string;
let EXTERNAL: string;

beforeEach(() => {
  SANDBOX = realpathSync(
    (() => {
      const dir = join(
        tmpdir(),
        `lb-contracts-local-symlink-${randomBytes(6).toString('hex')}`,
      );
      mkdirSync(dir, {recursive: true});
      return dir;
    })(),
  );
  PROJECT = join(SANDBOX, 'project');
  SCHEMAS_DIR = join(PROJECT, 'schemas');
  EXTERNAL = join(SANDBOX, 'external');
  mkdirSync(SCHEMAS_DIR, {recursive: true});
  mkdirSync(EXTERNAL, {recursive: true});
  writeFileSync(
    join(SCHEMAS_DIR, 'good.schema.json'),
    JSON.stringify({$id: 'good', type: 'object'}),
  );
  writeFileSync(
    join(EXTERNAL, 'hostile.schema.json'),
    JSON.stringify({$id: 'hostile', type: 'object'}),
  );
});

afterEach(() => {
  rmSync(SANDBOX, {recursive: true, force: true});
});

describe('LocalSchemaSource symlink-escape protection', () => {
  it('reads schemas that live entirely inside the project root', async () => {
    const source = new LocalSchemaSource(PROJECT);
    const results = await source.fetch(SCHEMAS_DIR);
    expect(results).toHaveLength(1);
    expect(results[0]?.path.endsWith('good.schema.json')).toBe(true);
  });

  it('rejects a symlinked subdirectory pointing outside the project root', async () => {
    symlinkSync(EXTERNAL, join(SCHEMAS_DIR, 'escape'), 'dir');
    const source = new LocalSchemaSource(PROJECT);
    await expect(source.fetch(SCHEMAS_DIR)).rejects.toBeInstanceOf(
      ContractsSourceError,
    );
    await expect(source.fetch(SCHEMAS_DIR)).rejects.toMatchObject({
      scheme: 'local',
      code: 'CONTRACTS_SOURCE',
      message: expect.stringContaining('symlink escape detected'),
    });
  });

  it('rejects a symlinked schema file pointing outside the project root', async () => {
    symlinkSync(
      join(EXTERNAL, 'hostile.schema.json'),
      join(SCHEMAS_DIR, 'hostile.schema.json'),
      'file',
    );
    const source = new LocalSchemaSource(PROJECT);
    await expect(source.fetch(SCHEMAS_DIR)).rejects.toBeInstanceOf(
      ContractsSourceError,
    );
  });

  it('rejects when the requested URI itself resolves outside the project root', async () => {
    const source = new LocalSchemaSource(PROJECT);
    await expect(source.fetch(EXTERNAL)).rejects.toMatchObject({
      scheme: 'local',
      message: expect.stringContaining('symlink escape detected'),
    });
  });

  it('allows a symlink whose target stays within the project root', async () => {
    const inner = join(PROJECT, 'inner');
    mkdirSync(inner, {recursive: true});
    writeFileSync(
      join(inner, 'nested.schema.json'),
      JSON.stringify({$id: 'nested', type: 'object'}),
    );
    symlinkSync(inner, join(SCHEMAS_DIR, 'mirror'), 'dir');
    const source = new LocalSchemaSource(PROJECT);
    const results = await source.fetch(SCHEMAS_DIR);
    const names = results.map(r => r.path).sort();
    expect(names.some(n => n.endsWith('good.schema.json'))).toBe(true);
    expect(names.some(n => n.endsWith('nested.schema.json'))).toBe(true);
  });
});
