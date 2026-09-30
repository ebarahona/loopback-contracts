// End-to-end tests for the experimental MongoDB `$jsonSchema` emitter,
// driven through the BUILT `bin/lb-contracts.js` so the `EMITTER_TAG`
// binding, the `--emit-mongodb` flag, the `emit.mongodb` config key and the
// file writer are all exercised.
//
// The last test loads the emitted validator into a real `mongo:7` container
// and checks a valid document is accepted and invalid ones rejected. It is
// skipped when no Docker daemon is reachable.

import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const PLUGIN_ROOT = resolve(__dirname, '..', '..', '..');
const BIN = join(PLUGIN_ROOT, 'bin', 'lb-contracts.js');
const DIST_ENTRY = join(PLUGIN_ROOT, 'dist', 'cli', 'index.js');
const SUITE_ROOT = join(
  tmpdir(),
  `lb-contracts-mongodb-${randomBytes(6).toString('hex')}`,
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

const ORDER = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'order',
  type: 'object',
  properties: {
    orderId: {type: 'string', minLength: 3},
    status: {$ref: '#/$defs/status'},
    quantity: {type: 'integer', minimum: 1},
    total: {$ref: 'money'},
  },
  required: ['orderId', 'status', 'quantity', 'total'],
  additionalProperties: false,
  $defs: {status: {type: 'string', enum: ['open', 'paid']}},
};

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

function seedProject(label: string, emit: Record<string, boolean>): string {
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
        model: false,
        repository: false,
        controller: false,
        datasource: false,
        ...emit,
      },
      security: {codegen: {runTsc: false}},
    }),
  );
  writeFileSync(
    join(root, 'schemas', 'money.schema.json'),
    JSON.stringify(MONEY),
  );
  writeFileSync(
    join(root, 'schemas', 'order.schema.json'),
    JSON.stringify(ORDER),
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

function readValidator(root: string): {$jsonSchema: Record<string, unknown>} {
  return JSON.parse(
    readFileSync(join(root, 'src', 'models', 'order.mongodb.json'), 'utf8'),
  ) as {$jsonSchema: Record<string, unknown>};
}

describe('lb-contracts gen --emit-mongodb', () => {
  it('is off by default', () => {
    const root = seedProject('off', {});
    expect(runGen(root).status).toBe(0);
    expect(existsSync(join(root, 'src', 'models', 'order.mongodb.json'))).toBe(
      false,
    );
  });

  it('emits <slug>.mongodb.json with refs inlined and _id injected', () => {
    const root = seedProject('flag', {});
    const result = runGen(root, ['--emit-mongodb']);
    expect(result.output).not.toContain('Pipeline failed');
    expect(result.status).toBe(0);
    const {$jsonSchema} = readValidator(root);
    expect($jsonSchema).toEqual({
      bsonType: 'object',
      properties: {
        _id: {bsonType: 'objectId'},
        orderId: {bsonType: 'string', minLength: 3},
        status: {bsonType: 'string', enum: ['open', 'paid']},
        quantity: {bsonType: ['int', 'long'], minimum: 1},
        total: {
          bsonType: 'object',
          properties: {
            amount: {bsonType: 'number', minimum: 0},
            currency: {bsonType: 'string', enum: ['USD', 'EUR']},
          },
          required: ['amount', 'currency'],
        },
      },
      required: ['orderId', 'status', 'quantity', 'total'],
      additionalProperties: false,
    });
    expect(existsSync(join(root, 'src', 'models', 'money.mongodb.json'))).toBe(
      true,
    );
  });

  it('is enabled by emit.mongodb and fails --strict on a dropped keyword', () => {
    const root = seedProject('config', {mongodb: true});
    expect(runGen(root).status).toBe(0);
    expect(existsSync(join(root, 'src', 'models', 'order.mongodb.json'))).toBe(
      true,
    );

    writeFileSync(
      join(root, 'schemas', 'order.schema.json'),
      JSON.stringify({
        ...ORDER,
        properties: {
          ...ORDER.properties,
          placedAt: {type: 'string', format: 'date-time'},
        },
      }),
    );
    const lenient = runGen(root);
    expect(lenient.status).toBe(0);
    expect(lenient.output).toContain('Lossy warnings: 1');
    const strict = runGen(root, ['--strict']);
    expect(strict.status).not.toBe(0);
    expect(strict.output).toContain('MongoDB emitter rejected');
  });
});

function dockerAvailable(): boolean {
  const r = spawnSync(
    'docker',
    ['version', '--format', '{{.Server.Version}}'],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  return r.status === 0;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe.skipIf(!dockerAvailable())('MongoDB validator in mongo:7', () => {
  it('accepts a valid document and rejects invalid ones', () => {
    const root = seedProject('docker', {mongodb: true});
    expect(runGen(root).status).toBe(0);
    const validator = readFileSync(
      join(root, 'src', 'models', 'order.mongodb.json'),
      'utf8',
    );

    const started = spawnSync('docker', ['run', '-d', '--rm', 'mongo:7'], {
      encoding: 'utf8',
      timeout: 300_000,
    });
    expect(started.status).toBe(0);
    const container = started.stdout.trim();
    const mongosh = (script: string) =>
      spawnSync(
        'docker',
        ['exec', container, 'mongosh', '--quiet', '--eval', script],
        {encoding: 'utf8', timeout: 60_000},
      );
    try {
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        ready = mongosh('db.runCommand({ping: 1}).ok').stdout.trim() === '1';
        if (!ready) sleep(1000);
      }
      expect(ready).toBe(true);

      const script = `
        db.createCollection('orders', {validator: ${validator}});
        const valid = {orderId: 'o-1', status: 'open', quantity: NumberInt(2),
          total: {amount: 9.5, currency: 'USD'}};
        const cases = {
          valid,
          missingRequired: {orderId: 'o-2', status: 'open', quantity: NumberInt(1)},
          badEnum: {...valid, status: 'shipped'},
          belowMinimum: {...valid, quantity: NumberInt(0)},
          wrongType: {...valid, quantity: 'two'},
          extraField: {...valid, extra: true},
          nestedBad: {...valid, total: {amount: -1, currency: 'USD'}},
        };
        const out = {};
        for (const [name, doc] of Object.entries(cases)) {
          try { db.orders.insertOne(doc); out[name] = 'accepted'; }
          catch (e) { out[name] = e.code === 121 ? 'rejected' : 'error:' + e.message; }
        }
        print(JSON.stringify(out));
      `;
      const result = mongosh(script);
      expect(result.stderr).toBe('');
      const lines = result.stdout.trim().split('\n');
      expect(JSON.parse(lines[lines.length - 1] ?? '{}')).toEqual({
        valid: 'accepted',
        missingRequired: 'rejected',
        badEnum: 'rejected',
        belowMinimum: 'rejected',
        wrongType: 'rejected',
        extraField: 'rejected',
        nestedBad: 'rejected',
      });
    } finally {
      spawnSync('docker', ['rm', '-f', container], {timeout: 60_000});
    }
  }, 600_000);
});
