// End-to-end tests for the stage-6 breaking-change gate, driven through the
// BUILT `bin/lb-contracts.js`. Each `gen` compares every schema against the
// committed `contracts.lock.json` baseline: in-place edits are classified
// (no version pin involved), breaking ones fail unless `--allow-breaking`,
// and the baseline only advances on a successful run.

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
  `lb-contracts-baseline-${randomBytes(6).toString('hex')}`,
);

type Schema = Record<string, unknown>;

const ORDER: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'order',
  type: 'object',
  properties: {
    id: {type: 'string'},
    status: {type: 'string', enum: ['open', 'paid', 'void']},
    quantity: {type: 'number'},
  },
  required: ['id', 'status'],
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

function seedProject(
  label: string,
  extra: Record<string, unknown> = {},
): string {
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
        types: true,
        model: false,
        repository: false,
        controller: false,
        datasource: false,
      },
      security: {codegen: {runTsc: false}},
      ...extra,
    }),
  );
  writeSchema(root, 'order', ORDER);
  return root;
}

function writeSchema(root: string, name: string, schema: Schema): void {
  writeFileSync(
    join(root, 'schemas', `${name}.schema.json`),
    JSON.stringify(schema),
  );
}

function run(root: string, args: readonly string[]) {
  const r = spawnSync('node', [BIN, ...args], {cwd: root, encoding: 'utf8'});
  return {status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`};
}

interface Lock {
  version: number;
  schemas: Record<string, Schema>;
  digests?: Record<string, string>;
}

function lock(root: string): Lock {
  return JSON.parse(
    readFileSync(join(root, 'contracts.lock.json'), 'utf8'),
  ) as Lock;
}

/** Seed a project whose baseline holds {@link ORDER}. */
function seedAccepted(label: string): string {
  const root = seedProject(label);
  const first = run(root, ['gen']);
  expect(first.output).not.toContain('Pipeline failed');
  expect(first.status).toBe(0);
  return root;
}

function withProperty(name: string, value: Schema): Schema {
  return {
    ...ORDER,
    properties: {...(ORDER['properties'] as Schema), [name]: value},
  };
}

describe('stage 6 baseline gate', () => {
  it('establishes a baseline for a new schema', () => {
    const root = seedProject('new');
    expect(existsSync(join(root, 'contracts.lock.json'))).toBe(false);
    expect(run(root, ['gen']).status).toBe(0);
    expect(lock(root)).toEqual({version: 1, schemas: {order: ORDER}});

    // A second schema added later joins the baseline without a flag.
    const note = {$id: 'note', type: 'object', properties: {}};
    writeSchema(root, 'note', note);
    expect(run(root, ['gen']).status).toBe(0);
    expect(Object.keys(lock(root).schemas).sort()).toEqual(['note', 'order']);
  });

  it('accepts an additive edit and advances the baseline', () => {
    const root = seedAccepted('additive');
    const next = withProperty('note', {type: 'string'});
    writeSchema(root, 'order', next);
    expect(run(root, ['validate']).status).toBe(0);
    expect(lock(root).schemas['order']).toEqual(ORDER); // validate is read-only
    expect(run(root, ['gen']).status).toBe(0);
    expect(lock(root).schemas['order']).toEqual(next);
  });

  const breaking: ReadonlyArray<readonly [string, Schema]> = [
    [
      'removing a required property',
      {
        ...ORDER,
        properties: {
          status: {type: 'string', enum: ['open', 'paid', 'void']},
          quantity: {type: 'number'},
        },
        required: ['status'],
      },
    ],
    [
      'narrowing an enum',
      withProperty('status', {type: 'string', enum: ['open', 'paid']}),
    ],
    ['tightening a type', withProperty('quantity', {type: 'integer'})],
    [
      'making a property required',
      {...ORDER, required: ['id', 'status', 'quantity']},
    ],
  ];

  for (const [label, next] of breaking) {
    it(`refuses ${label} and keeps the baseline`, () => {
      const root = seedAccepted(`breaking-${label.replace(/\W+/g, '-')}`);
      const before = readFileSync(join(root, 'contracts.lock.json'), 'utf8');
      writeSchema(root, 'order', next);

      for (const cmd of ['validate', 'gen']) {
        const result = run(root, [cmd]);
        expect(result.status).not.toBe(0);
        expect(result.output).toContain("'order': breaking change");
        expect(result.output).toContain('contracts.lock.json');
      }
      expect(readFileSync(join(root, 'contracts.lock.json'), 'utf8')).toBe(
        before,
      );

      // `validate --allow-breaking` passes without touching the baseline;
      // `gen --allow-breaking` accepts the change and advances it.
      expect(run(root, ['validate', '--allow-breaking']).status).toBe(0);
      expect(readFileSync(join(root, 'contracts.lock.json'), 'utf8')).toBe(
        before,
      );
      expect(run(root, ['gen', '--allow-breaking']).status).toBe(0);
      expect(lock(root).schemas['order']).toEqual(next);
      expect(run(root, ['gen']).status).toBe(0);
    });
  }

  it('treats a removed schema as breaking', () => {
    const root = seedAccepted('removed');
    writeSchema(root, 'order', {...ORDER, $id: 'order2'});
    const result = run(root, ['gen']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("'order': schema removed");
  });

  it('never creates or updates the baseline from validate', () => {
    const root = seedProject('validate-read-only');
    expect(run(root, ['validate']).status).toBe(0);
    expect(existsSync(join(root, 'contracts.lock.json'))).toBe(false);
  });

  it('treats constructor and __proto__ $ids as ordinary schemas', () => {
    const root = seedAccepted('prototype-ids');
    const ctor = {$id: 'constructor', type: 'object', properties: {}};
    const proto = {$id: '__proto__', type: 'object', properties: {}};
    writeSchema(root, 'ctor', ctor);
    writeSchema(root, 'proto', proto);
    const first = run(root, ['gen']);
    expect(first.output).not.toContain('Pipeline failed');
    expect(first.status).toBe(0);
    const raw = readFileSync(join(root, 'contracts.lock.json'), 'utf8');
    expect(raw).toContain('"constructor"');
    expect(raw).toContain('"__proto__"');
    expect(run(root, ['gen']).status).toBe(0);

    // Both are real baseline entries: removing one is breaking.
    rmSync(join(root, 'schemas', 'proto.schema.json'));
    const removed = run(root, ['gen']);
    expect(removed.status).not.toBe(0);
    expect(removed.output).toContain("'__proto__': schema removed");
  });

  it('skips the gate and the lock file when baseline.enabled is false', () => {
    const root = seedProject('disabled', {baseline: {enabled: false}});
    expect(run(root, ['gen']).status).toBe(0);
    expect(existsSync(join(root, 'contracts.lock.json'))).toBe(false);
    writeSchema(root, 'order', {
      ...ORDER,
      required: ['id', 'status', 'quantity'],
    });
    expect(run(root, ['gen']).status).toBe(0);
    expect(existsSync(join(root, 'contracts.lock.json'))).toBe(false);
  });

  it('rejects an unknown baseline setting', () => {
    const root = seedProject('typo', {baseline: {include_remote: true}});
    const result = run(root, ['gen']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(
      '/baseline must NOT have additional properties',
    );
  });

  it('fails loudly on a corrupt baseline instead of disabling the gate', () => {
    const root = seedAccepted('corrupt');
    writeFileSync(join(root, 'contracts.lock.json'), '{not json');
    const result = run(root, ['gen']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('contracts.lock.json is not valid JSON');
  });
});

describe('stage 6 baseline gate: remote sources', () => {
  // An `npm:` source resolves from the suite root's `node_modules`, which
  // Node's resolution reaches by walking up from each project root.
  const PKG = 'acme-private-contracts';
  const REMOTE: Schema = {
    $id: 'https://contracts.acme.example/party/1.0.0',
    title: 'Party',
    type: 'object',
    properties: {name: {type: 'string'}},
    examples: [{name: 'confidential example'}],
  };

  function writeRemote(schema: Schema): void {
    const pkg = join(SUITE_ROOT, 'node_modules', PKG);
    mkdirSync(join(pkg, 'schemas'), {recursive: true});
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({name: PKG, version: '1.0.0'}),
    );
    writeFileSync(
      join(pkg, 'schemas', 'party.schema.json'),
      JSON.stringify(schema),
    );
  }

  function seedRemote(label: string, extra: Record<string, unknown> = {}) {
    writeRemote(REMOTE);
    return seedProject(label, {schemas: ['./schemas', `npm:${PKG}`], ...extra});
  }

  it('records remote schemas by digest only, never their body', () => {
    const root = seedRemote('remote-digest');
    const first = run(root, ['gen']);
    expect(first.output).not.toContain('Pipeline failed');
    expect(first.status).toBe(0);
    const l = lock(root);
    expect(Object.keys(l.schemas)).toEqual(['order']);
    expect(l.digests?.[REMOTE['$id'] as string]).toMatch(
      /^sha256-[0-9a-f]{64}$/,
    );
    const raw = readFileSync(join(root, 'contracts.lock.json'), 'utf8');
    expect(raw).not.toContain('confidential example');

    // Any change to a digest-only schema is refused until accepted.
    writeRemote({...REMOTE, properties: {name: {type: 'string'}, x: {}}});
    const changed = run(root, ['gen']);
    expect(changed.status).not.toBe(0);
    expect(changed.output).toContain(
      `'${REMOTE['$id'] as string}': changed (remote-source schema`,
    );
    expect(run(root, ['gen', '--allow-breaking']).status).toBe(0);
    expect(run(root, ['gen']).status).toBe(0);
  });

  it('stores and classifies remote bodies with baseline.includeRemote', () => {
    const root = seedRemote('remote-bodies', {
      baseline: {includeRemote: true},
    });
    expect(run(root, ['gen']).status).toBe(0);
    const l = lock(root);
    expect(l.schemas[REMOTE['$id'] as string]).toEqual(REMOTE);
    expect(l.digests).toBeUndefined();

    // An additive upstream change is classified, not refused.
    const widened = {
      ...REMOTE,
      properties: {name: {type: 'string'}, nick: {type: 'string'}},
    };
    writeRemote(widened);
    expect(run(root, ['gen']).status).toBe(0);
    expect(lock(root).schemas[REMOTE['$id'] as string]).toEqual(widened);
  });
});
