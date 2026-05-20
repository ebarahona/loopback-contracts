// Shell-out integration tests for the BUILT `bin/lb-contracts.js`.
//
// Every other spec in this repo exercises `runGen` / `runValidate` /
// `runDs` IN-PROCESS via the exported functions. That bypasses the bin
// shim entirely — and missed two real ship-blockers caught only by manual
// smoke testing:
//
//   1. The bin shim's `require(distEntry)` loaded the dispatcher but
//      `if (isCliEntry())` checked `require.main === module`, which is
//      FALSE under the shim's require()-based activation path. Every
//      `lb-contracts <anything>` exited 0 with zero output.
//   2. `lb-contracts validate` threw at runtime because the validate
//      command omitted TEMPLATE_ENGINE + IMPORT_MAP bindings — the DI
//      container resolves the Pipeline → EmitterRunner graph eagerly,
//      so the omission failed before validateOnly could short-circuit.
//
// This spec spawns `node bin/lb-contracts.js <args>` as a real child
// process against a real tmpdir fixture and asserts on stdout / stderr /
// exit code. The cases here would have caught both bugs above; they
// also lock down the user-observable surface so future refactors of the
// bin shim, the dispatcher, or the engine boot order can't silently
// break the published CLI.

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

/** One tmpdir root for the whole spec; each test seeds a subdirectory. */
const SUITE_ROOT = join(
  tmpdir(),
  `lb-contracts-bin-runtime-${randomBytes(6).toString('hex')}`,
);

/**
 * Run the built bin and capture its stdout / stderr / exit code.
 *
 * Uses `spawnSync` rather than `execFileSync` deliberately:
 * `execFileSync` returns stdout on success but DROPS stderr (it's only
 * surfaced when the command exits non-zero, via the thrown error).
 * `spawnSync` returns both streams regardless of exit code — the right
 * shape for testing CLI surfaces that emit warnings on stderr (e.g.
 * `lb-contracts ds --password literal` warns on stderr while still
 * exiting 0, and the test must observe the warning).
 */
function runBin(args: readonly string[], cwd: string): RunResult {
  const r = spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {...process.env},
  });
  return {
    status: typeof r.status === 'number' ? r.status : -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Make a fresh fixture project rooted at a per-test subdirectory. */
function makeFixture(label: string): string {
  const root = join(SUITE_ROOT, `${label}-${randomBytes(4).toString('hex')}`);
  mkdirSync(root, {recursive: true});
  // Symlink the plugin's node_modules so any `tsc` invocation from the
  // pipeline resolves @loopback/* packages against the same versions the
  // engine was built against. Mirrors the pattern in
  // pipeline-end-to-end.spec.ts's stage-8 gate test.
  symlinkSync(join(PLUGIN_ROOT, 'node_modules'), join(root, 'node_modules'));
  return root;
}

function seedMinimalProject(root: string): void {
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});

  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify(
      {
        name: 'bin-runtime-test',
        schemasDir: './schemas',
        configsDir: './configs',
        validator: 'ajv',
        schemas: ['./schemas'],
        emit: {},
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify({mem: {adapter: 'memory', config: {}}}, null, 2),
  );

  writeFileSync(
    join(root, 'schemas', 'person.schema.json'),
    JSON.stringify(
      {
        $id: 'person.v1',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {id: {type: 'string'}, name: {type: 'string'}},
        required: ['id', 'name'],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(root, 'configs', 'person.config.json'),
    JSON.stringify(
      {
        $contractId: 'person.v1',
        dataSource: 'mem',
        public: true,
        model: {base: 'Entity', strict: true, idProperty: 'id'},
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'commonjs',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          emitDecoratorMetadata: true,
          experimentalDecorators: true,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  );
}

beforeAll(() => {
  // The built bin loads `dist/cli/index.js`. Surface a clear error if
  // someone ran `npm test` without `npm run build` first — the cryptic
  // "compiled CLI not found" otherwise propagates from the bin shim.
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `dist/cli/index.js missing — run \`npm run build\` before \`npm test\` ` +
        `to exercise the CLI bin tests. Missing: ${DIST_ENTRY}`,
    );
  }
  mkdirSync(SUITE_ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(SUITE_ROOT, {recursive: true, force: true});
});

describe('lb-contracts bin (built) — runtime activation', () => {
  it('--version prints a non-empty semver and exits 0', () => {
    const res = runBin(['--version'], PLUGIN_ROOT);
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help prints USAGE + COMMANDS and exits 0', () => {
    const res = runBin(['--help'], PLUGIN_ROOT);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('USAGE');
    expect(res.stdout).toContain('lb-contracts <command>');
    expect(res.stdout).toContain('COMMANDS');
    expect(res.stdout).toContain('gen');
    expect(res.stdout).toContain('validate');
  });

  it('unknown command exits non-zero with the help screen', () => {
    const res = runBin(['this-command-does-not-exist'], PLUGIN_ROOT);
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/Unknown command/i);
  });
});

describe('lb-contracts gen (built bin against real fixture)', () => {
  it('runs all 8 stages, emits expected files, generated TS compiles', () => {
    const fixture = makeFixture('gen-happy');
    seedMinimalProject(fixture);

    const res = runBin(['gen'], fixture);
    expect(res.status).toBe(0);

    // Every lb4-idiom emitter wrote both halves: base (regen) + extension stub.
    expect(existsSync(join(fixture, 'src/models/person.base.model.ts'))).toBe(
      true,
    );
    expect(existsSync(join(fixture, 'src/models/person.model.ts'))).toBe(true);
    expect(
      existsSync(join(fixture, 'src/repositories/person.base.repository.ts')),
    ).toBe(true);
    expect(
      existsSync(join(fixture, 'src/controllers/person.base.controller.ts')),
    ).toBe(true);
    expect(
      existsSync(join(fixture, 'src/datasources/mem.base.datasource.ts')),
    ).toBe(true);
    // Barrels regenerated per directory.
    expect(existsSync(join(fixture, 'src/models/index.ts'))).toBe(true);
    expect(existsSync(join(fixture, 'src/repositories/index.ts'))).toBe(true);
    // Meta-schemas including the loopback-config one Loop 1 added.
    expect(existsSync(join(fixture, '_meta/loopback-config.schema.json'))).toBe(
      true,
    );
  }, 60_000); // tsc cold-start + generation can exceed the default 5s timeout
});

describe('lb-contracts validate (built bin)', () => {
  it('PASS case exits 0 against a valid project', () => {
    const fixture = makeFixture('validate-pass');
    seedMinimalProject(fixture);

    const res = runBin(['validate'], fixture);
    expect(res.status).toBe(0);
    // Renderer prints a PASS banner; assert on the load-bearing token.
    expect(res.stdout + res.stderr).toMatch(/PASS|Validation: PASS|valid/i);
  }, 30_000);

  it('FAIL case exits 1 and names the offending field on a typo', () => {
    const fixture = makeFixture('validate-fail');
    seedMinimalProject(fixture);
    // Re-write with a deliberately typo'd dataSource the meta-schema enum
    // will reject (the loaded datasources.json declares 'mem').
    writeFileSync(
      join(fixture, 'configs/person.config.json'),
      JSON.stringify(
        {
          $contractId: 'person.v1',
          dataSource: 'memry',
          public: true,
          model: {base: 'Entity', strict: true, idProperty: 'id'},
        },
        null,
        2,
      ),
    );

    const res = runBin(['validate'], fixture);
    expect(res.status).toBe(1);
    // Error must surface the rejected field + the allowed value.
    const out = res.stdout + res.stderr;
    expect(out).toMatch(/dataSource/);
    expect(out).toMatch(/mem/);
  }, 30_000);
});

describe('lb-contracts ds (built bin)', () => {
  it('adds a fresh datasource entry and exits 0', () => {
    const fixture = makeFixture('ds-add');
    // ds doesn't need schemas/ or configs/, just loopback.config.json.
    mkdirSync(fixture, {recursive: true});
    writeFileSync(
      join(fixture, 'loopback.config.json'),
      JSON.stringify(
        {
          name: 'ds-add-test',
          schemasDir: './schemas',
          configsDir: './configs',
          validator: 'ajv',
          schemas: ['./schemas'],
          emit: {},
        },
        null,
        2,
      ),
    );

    const res = runBin(['ds', 'primary', '--adapter', 'memory'], fixture);
    expect(res.status).toBe(0);
    expect(existsSync(join(fixture, 'datasources.json'))).toBe(true);

    // File contains the expected entry under the keyed-map shape.
    const onDisk = JSON.parse(
      readFileSync(join(fixture, 'datasources.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk['primary']).toMatchObject({adapter: 'memory'});
  }, 30_000);

  it('refuses a duplicate entry with exit 2 and a clear stderr message', () => {
    const fixture = makeFixture('ds-dup');
    mkdirSync(fixture, {recursive: true});
    writeFileSync(
      join(fixture, 'loopback.config.json'),
      JSON.stringify(
        {
          name: 'ds-dup-test',
          schemasDir: './schemas',
          configsDir: './configs',
          validator: 'ajv',
          schemas: ['./schemas'],
          emit: {},
        },
        null,
        2,
      ),
    );

    // First add succeeds.
    const first = runBin(['ds', 'primary', '--adapter', 'memory'], fixture);
    expect(first.status).toBe(0);

    // Second add refuses with exit 2 (project's "already exists" convention).
    const dup = runBin(['ds', 'primary', '--adapter', 'memory'], fixture);
    expect(dup.status).toBe(2);
    expect(dup.stderr).toMatch(/already exists/i);
  }, 30_000);

  it('--password-env writes a `${VAR}` placeholder instead of the literal', () => {
    const fixture = makeFixture('ds-password-env');
    mkdirSync(fixture, {recursive: true});
    writeFileSync(
      join(fixture, 'loopback.config.json'),
      JSON.stringify(
        {
          name: 'ds-env-test',
          schemasDir: './schemas',
          configsDir: './configs',
          validator: 'ajv',
          schemas: ['./schemas'],
          emit: {},
        },
        null,
        2,
      ),
    );

    const res = runBin(
      [
        'ds',
        'pgx',
        '--adapter',
        'postgres',
        '--password-env',
        'POSTGRES_PASSWORD',
      ],
      fixture,
    );
    expect(res.status).toBe(0);

    const onDisk = JSON.parse(
      readFileSync(join(fixture, 'datasources.json'), 'utf8'),
    ) as Record<string, {password?: string}>;
    expect(onDisk['pgx']?.password).toBe('${POSTGRES_PASSWORD}');
  }, 30_000);

  it('literal --password emits a stderr warning recommending --password-env', () => {
    const fixture = makeFixture('ds-password-warn');
    mkdirSync(fixture, {recursive: true});
    writeFileSync(
      join(fixture, 'loopback.config.json'),
      JSON.stringify(
        {
          name: 'ds-warn-test',
          schemasDir: './schemas',
          configsDir: './configs',
          validator: 'ajv',
          schemas: ['./schemas'],
          emit: {},
        },
        null,
        2,
      ),
    );

    const res = runBin(
      ['ds', 'pgx', '--adapter', 'postgres', '--password', 'literally-secret'],
      fixture,
    );
    // Write still succeeds (the user is allowed to do this) but stderr
    // must carry the warning so CI logs surface the leak.
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/literal value/i);
    expect(res.stderr).toMatch(/--password-env/);
  }, 30_000);
});
