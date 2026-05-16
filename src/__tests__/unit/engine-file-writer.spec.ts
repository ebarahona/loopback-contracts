import {randomBytes} from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {FileWriter} from '../../engine/file-writer';
import {ContractsCodegenError} from '../../helpers';
import type {EmittedFile} from '../../interfaces';

const ROOT = join(
  tmpdir(),
  `lb-contracts-writer-${randomBytes(6).toString('hex')}`,
);

beforeAll(() => {
  mkdirSync(ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(ROOT, {recursive: true, force: true});
});

function subdir(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, {recursive: true});
  return dir;
}

describe('FileWriter.writeAll', () => {
  it('writes a new file under the output directory', async () => {
    const out = subdir('new-file');
    const writer = new FileWriter();
    const file: EmittedFile = {
      path: 'hello.ts',
      content: 'export const value = 1;\n',
      producer: 'test-producer',
    };
    const res = await writer.writeAll(out, [file]);
    expect(res.created).toHaveLength(1);
    expect(res.updated).toHaveLength(0);
    const written = readFileSync(join(out, 'hello.ts'), 'utf8');
    expect(written).toContain('export const value = 1;');
    expect(written).toMatch(/^\/\/ AUTO-GENERATED/);
  });

  it('overwrites an existing file with policy "regen"', async () => {
    const out = subdir('regen');
    const writer = new FileWriter();
    const first: EmittedFile = {
      path: 'sample.ts',
      content: 'export const value = 1;\n',
      producer: 't',
      policy: 'regen',
    };
    await writer.writeAll(out, [first]);

    const second: EmittedFile = {
      path: 'sample.ts',
      content: 'export const value = 2;\n',
      producer: 't',
      policy: 'regen',
    };
    const res = await writer.writeAll(out, [second]);
    expect(res.updated).toHaveLength(1);
    const written = readFileSync(join(out, 'sample.ts'), 'utf8');
    expect(written).toContain('export const value = 2;');
  });

  it('skips an existing file with policy "skipIfExists"', async () => {
    const out = subdir('skip');
    const writer = new FileWriter();
    const first: EmittedFile = {
      path: 'stub.ts',
      content: 'export const value = 1;\n',
      producer: 't',
      policy: 'skipIfExists',
    };
    await writer.writeAll(out, [first]);

    const second: EmittedFile = {
      path: 'stub.ts',
      content: 'export const value = 999;\n',
      producer: 't',
      policy: 'skipIfExists',
    };
    const res = await writer.writeAll(out, [second]);
    expect(res.skipped).toHaveLength(1);
    expect(res.updated).toHaveLength(0);
    const written = readFileSync(join(out, 'stub.ts'), 'utf8');
    expect(written).toContain('export const value = 1;');
  });

  it('is a no-op (unchanged) when content matches and mtime stays', async () => {
    const out = subdir('unchanged');
    const writer = new FileWriter();
    const file: EmittedFile = {
      path: 'pinned.ts',
      content: 'export const value = 1;\n',
      producer: 't',
      policy: 'regen',
    };
    await writer.writeAll(out, [file]);
    const before = statSync(join(out, 'pinned.ts'));
    // Small wait would matter for mtime; but the byte-compare path doesn't
    // touch the filesystem, so mtimeMs must equal between calls.
    const res = await writer.writeAll(out, [file]);
    const after = statSync(join(out, 'pinned.ts'));
    expect(res.unchanged).toHaveLength(1);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('prepends the right header comment per file extension', async () => {
    const out = subdir('headers');
    const writer = new FileWriter();
    const files: EmittedFile[] = [
      {path: 'a.ts', content: 'x\n', producer: 't'},
      {path: 'b.yaml', content: 'x: 1\n', producer: 't'},
      {path: 'c.json', content: '{"a":1}\n', producer: 't'},
      {path: 'd.proto', content: 'syntax = "proto3";\n', producer: 't'},
    ];
    await writer.writeAll(out, files);
    const ts = readFileSync(join(out, 'a.ts'), 'utf8');
    const yaml = readFileSync(join(out, 'b.yaml'), 'utf8');
    const json = readFileSync(join(out, 'c.json'), 'utf8');
    const proto = readFileSync(join(out, 'd.proto'), 'utf8');
    expect(ts.startsWith('// AUTO-GENERATED')).toBe(true);
    expect(yaml.startsWith('# AUTO-GENERATED')).toBe(true);
    // JSON has no comment grammar — no header should be prepended.
    expect(json.startsWith('{')).toBe(true);
    expect(proto.startsWith('# AUTO-GENERATED')).toBe(true);
  });

  it('errors on duplicate path and names both producers', async () => {
    const out = subdir('dup');
    const writer = new FileWriter();
    const files: EmittedFile[] = [
      {path: 'dup.ts', content: 'a\n', producer: 'one-emitter'},
      {path: 'dup.ts', content: 'b\n', producer: 'two-emitter'},
    ];
    let captured: unknown;
    try {
      await writer.writeAll(out, files);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ContractsCodegenError);
    const msg = (captured as Error).message;
    expect(msg).toContain('one-emitter');
    expect(msg).toContain('two-emitter');
  });
});

describe('FileWriter.detectChanges', () => {
  it('returns correct buckets without touching disk', async () => {
    const out = subdir('detect');
    const writer = new FileWriter();
    // Seed an existing file we will not modify.
    writeFileSync(
      join(out, 'untouched.ts'),
      '// AUTO-GENERATED — do not edit. Regenerate with: lb4 gen\nexport const value = 1;\n',
      'utf8',
    );
    // Seed a file with stale content (header + body).
    writeFileSync(
      join(out, 'stale.ts'),
      '// AUTO-GENERATED — do not edit. Regenerate with: lb4 gen\nstale\n',
      'utf8',
    );
    // Seed a file that exists and is targeted with skipIfExists.
    writeFileSync(join(out, 'frozen.ts'), 'frozen\n', 'utf8');

    const files: EmittedFile[] = [
      // identical contents -> unchanged
      {
        path: 'untouched.ts',
        content: 'export const value = 1;\n',
        producer: 't',
      },
      // different contents -> updated
      {path: 'stale.ts', content: 'fresh\n', producer: 't'},
      // does not exist -> created
      {path: 'brand-new.ts', content: 'x\n', producer: 't'},
      // exists + skipIfExists -> skipped
      {
        path: 'frozen.ts',
        content: 'different\n',
        producer: 't',
        policy: 'skipIfExists',
      },
    ];

    const report = await writer.detectChanges(out, files);
    expect(report.created.map(p => p.split(/[\\/]/).pop())).toEqual([
      'brand-new.ts',
    ]);
    expect(report.updated.map(p => p.split(/[\\/]/).pop())).toEqual([
      'stale.ts',
    ]);
    expect(report.unchanged.map(p => p.split(/[\\/]/).pop())).toEqual([
      'untouched.ts',
    ]);
    expect(report.skipped.map(p => p.split(/[\\/]/).pop())).toEqual([
      'frozen.ts',
    ]);
  });
});
