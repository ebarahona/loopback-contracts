// End-to-end regressions driven through the BUILT `bin/lb-contracts.js`:
//
//   1. The models directory is configurable (`loopback.config.json`
//      `outputDir`, `gen --out-dir`) instead of hard-coded to `src/models`.
//   2. `gen` is idempotent from the filesystem's point of view: a deleted or
//      edited generated file is rewritten on the next run even though
//      `contracts.lock.json` already holds a baseline for the unchanged
//      schemas.
//   3. The openapi-components fragments of a `$defs`-using schema set mount
//      into one OpenAPI document with every `$ref` resolving.

import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {parse as parseYaml} from 'yaml';

const PLUGIN_ROOT = resolve(__dirname, '..', '..', '..');
const BIN = join(PLUGIN_ROOT, 'bin', 'lb-contracts.js');
const DIST_ENTRY = join(PLUGIN_ROOT, 'dist', 'cli', 'index.js');
const SUITE_ROOT = join(
  tmpdir(),
  `lb-contracts-out-dir-${randomBytes(6).toString('hex')}`,
);

const MONEY = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'money',
  type: 'object',
  properties: {
    amount: {$ref: '#/$defs/amount'},
    currency: {type: 'string', enum: ['USD', 'EUR']},
  },
  required: ['amount', 'currency'],
  $defs: {amount: {type: 'number', minimum: 0}},
};

const INTAKE = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'appraisal-intake',
  type: 'object',
  properties: {
    insuredAge: {type: 'integer', minimum: 0},
    dateOfBirth: {type: 'string', format: 'date'},
    faceValue: {$ref: 'money#/$defs/amount'},
    premiums: {type: 'array', items: {$ref: 'money'}, minItems: 1},
    status: {$ref: '#/$defs/status'},
  },
  required: ['faceValue', 'premiums', 'status'],
  oneOf: [{required: ['insuredAge']}, {required: ['dateOfBirth']}],
  $defs: {status: {type: 'string', enum: ['draft', 'submitted']}},
};

const SIDECARS = [
  'appraisal-intake.openapi-components.yaml',
  'appraisal-intake.types.ts',
  'appraisal-intake.zod.ts',
  'money.openapi-components.yaml',
  'money.types.ts',
  'money.zod.ts',
];

beforeAll(() => {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `dist/cli/index.js missing — run \`npm run build\` before \`npm test\`. ` +
        `Missing: ${DIST_ENTRY}`,
    );
  }
  mkdirSync(SUITE_ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(SUITE_ROOT, {recursive: true, force: true});
});

function seedProject(label: string, extra: object = {}): string {
  const root = join(SUITE_ROOT, label);
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});
  symlinkSync(join(PLUGIN_ROOT, 'node_modules'), join(root, 'node_modules'));
  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify({
      name: 't',
      schemasDir: './schemas',
      configsDir: './configs',
      validator: 'zod',
      schemas: ['./schemas'],
      emit: {
        zod: true,
        types: true,
        'openapi-components': true,
        model: false,
        repository: false,
        controller: false,
        datasource: false,
      },
      security: {codegen: {runTsc: false}},
      ...extra,
    }),
  );
  writeFileSync(
    join(root, 'schemas', 'money.schema.json'),
    JSON.stringify(MONEY),
  );
  writeFileSync(
    join(root, 'schemas', 'appraisal-intake.schema.json'),
    JSON.stringify(INTAKE),
  );
  return root;
}

function runGen(root: string, args: readonly string[] = []) {
  const r = spawnSync('node', [BIN, 'gen', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  return {status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`};
}

describe('lb-contracts gen: output directory', () => {
  it('writes to --out-dir instead of src/models', () => {
    const root = seedProject('flag');
    const result = runGen(root, ['--out-dir', 'src/generated']);
    expect(result.output).not.toContain('Pipeline failed');
    expect(result.status).toBe(0);
    expect(readdirSync(join(root, 'src', 'generated')).sort()).toEqual(
      SIDECARS,
    );
    expect(existsSync(join(root, 'src', 'models'))).toBe(false);
  });

  it('honours the outputDir config key, and --out-dir= overrides it', () => {
    const root = seedProject('config', {outputDir: 'lib/contracts'});
    expect(runGen(root).status).toBe(0);
    expect(readdirSync(join(root, 'lib', 'contracts')).sort()).toEqual(
      SIDECARS,
    );
    expect(existsSync(join(root, 'src'))).toBe(false);

    expect(runGen(root, ['--out-dir=src/other']).status).toBe(0);
    expect(readdirSync(join(root, 'src', 'other')).sort()).toEqual(SIDECARS);

    const meta = JSON.parse(
      readFileSync(join(root, '_meta', 'loopback-config.schema.json'), 'utf8'),
    ) as {properties: Record<string, {default?: unknown}>};
    expect(meta.properties['outputDir']?.default).toBe('src/models');
  });

  it('rejects an outputDir outside the project root', () => {
    const root = seedProject('escape', {outputDir: '../elsewhere'});
    const result = runGen(root);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("'outputDir' must be a directory inside");
    expect(existsSync(join(SUITE_ROOT, 'elsewhere'))).toBe(false);
  });

  it('rejects --out-dir inside node_modules or the schemas dir, naming the flag', () => {
    const root = seedProject('reserved');
    for (const [dir, problem] of [
      ['node_modules/lbc-out-dir-probe', "must not be inside 'node_modules'"],
      ['schemas', "must not be inside the schemas directory 'schemas'"],
      ['_meta/models', "must not be inside '_meta'"],
    ] as const) {
      const result = runGen(root, [`--out-dir=${dir}`]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain(`--out-dir ${problem}; got '${dir}'`);
      expect(result.output).not.toContain("loopback.config.json 'outputDir'");
    }
    // `node_modules` is a symlink to the plugin's own; nothing lands there.
    expect(existsSync(join(root, 'node_modules', 'lbc-out-dir-probe'))).toBe(
      false,
    );
  });
});

describe('lb-contracts gen: filesystem idempotency', () => {
  it('rewrites deleted and edited outputs despite an existing baseline', () => {
    const root = seedProject('idempotent');
    const models = join(root, 'src', 'models');
    expect(runGen(root).status).toBe(0);
    expect(existsSync(join(root, 'contracts.lock.json'))).toBe(true);
    const zodPath = join(models, 'money.zod.ts');
    const typesPath = join(models, 'money.types.ts');
    const metaPath = join(root, '_meta', 'loopback-config.schema.json');
    const zod = readFileSync(zodPath, 'utf8');
    const types = readFileSync(typesPath, 'utf8');
    const meta = readFileSync(metaPath, 'utf8');

    // Unchanged tree: nothing is rewritten.
    expect(runGen(root).output).toContain('Wrote 0 files');

    unlinkSync(zodPath);
    unlinkSync(metaPath);
    writeFileSync(typesPath, '// edited by hand\n');
    const result = runGen(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain('Wrote 3 files');
    expect(readFileSync(zodPath, 'utf8')).toBe(zod);
    expect(readFileSync(typesPath, 'utf8')).toBe(types);
    expect(readFileSync(metaPath, 'utf8')).toBe(meta);
  });
});

describe('lb-contracts gen: openapi-components refs', () => {
  it('mounts into one document with every $ref resolving', () => {
    const root = seedProject('oas');
    expect(runGen(root).status).toBe(0);
    const models = join(root, 'src', 'models');
    const schemas: Record<string, unknown> = {};
    for (const file of readdirSync(models)) {
      if (!file.endsWith('.openapi-components.yaml')) continue;
      const doc = parseYaml(readFileSync(join(models, file), 'utf8')) as {
        components: {schemas: Record<string, unknown>};
      };
      Object.assign(schemas, doc.components.schemas);
    }
    const doc = {openapi: '3.1.0', components: {schemas}};

    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.push(value);
        else walk(value);
      }
    };
    walk(doc);
    expect(refs).toEqual(['#/components/schemas/Money']);
    for (const ref of refs) {
      let cur: unknown = doc;
      for (const seg of ref.slice(2).split('/')) {
        cur = (cur as Record<string, unknown>)[seg];
      }
      expect(cur).toBeDefined();
    }
    expect(JSON.stringify(doc)).not.toContain('$defs');
  });
});
