// Filesystem behaviour of the `contracts.lock.json` reader and writer:
// typed errors for unreadable files, own-property lookups on load, and the
// single-writer check that refuses to overwrite a concurrent change.

import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  BASELINE_FILENAME,
  loadBaseline,
  ownEntry,
  writeBaseline,
} from '../../engine/schema-baseline';
import {ContractsPipelineError} from '../../helpers';

const SUITE_ROOT = join(
  tmpdir(),
  `lb-contracts-baseline-io-${randomBytes(6).toString('hex')}`,
);

beforeAll(() => mkdirSync(SUITE_ROOT, {recursive: true}));
afterAll(() => rmSync(SUITE_ROOT, {recursive: true, force: true}));

function project(label: string): string {
  const root = join(SUITE_ROOT, label);
  mkdirSync(root, {recursive: true});
  return root;
}

describe('schema baseline I/O', () => {
  it('wraps a non-ENOENT read failure in ContractsPipelineError', async () => {
    const root = project('eisdir');
    mkdirSync(join(root, BASELINE_FILENAME)); // reading a directory: EISDIR
    const err = await loadBaseline(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractsPipelineError);
    expect((err as Error).message).toContain(
      `cannot read ${BASELINE_FILENAME}`,
    );
  });

  it('loads prototype-named $ids as own entries only', async () => {
    const root = project('proto');
    writeFileSync(
      join(root, BASELINE_FILENAME),
      '{"version": 1, "schemas": {"__proto__": {"type": "string"}}}',
    );
    const loaded = await loadBaseline(root);
    const schemas = loaded?.baseline.schemas;
    expect(ownEntry(schemas, '__proto__')).toEqual({type: 'string'});
    expect(ownEntry(schemas, 'constructor')).toBeUndefined();
    expect(Object.keys(schemas ?? {})).toEqual(['__proto__']);
  });

  it('refuses to overwrite a baseline changed since it was read', async () => {
    const root = project('concurrent');
    const path = join(root, BASELINE_FILENAME);
    const next = {version: 1 as const, schemas: {a: {type: 'string'}}};

    // First writer: no file when stage 6 read, none now.
    expect(await writeBaseline(root, next, undefined)).toBe(true);
    const accepted = readFileSync(path, 'utf8');

    // Another run rewrote the file after this run read `accepted`.
    writeFileSync(path, '{"version": 1, "schemas": {}}\n');
    const err = await writeBaseline(
      root,
      {version: 1, schemas: {a: {type: 'number'}}},
      accepted,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractsPipelineError);
    expect((err as Error).message).toContain('changed on disk during this run');
    expect(readFileSync(path, 'utf8')).toBe('{"version": 1, "schemas": {}}\n');

    // Writing exactly what is already there is a no-op, whatever was read.
    writeFileSync(path, '{\n  "schemas": {},\n  "version": 1\n}\n');
    expect(await writeBaseline(root, {version: 1, schemas: {}}, 'stale')).toBe(
      false,
    );
  });
});
