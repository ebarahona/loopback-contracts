// Runtime integration tests for the `lb-contracts` CLI command surface.
//
// Existing unit tests type-check every command file in isolation, and
// `pipeline-end-to-end.spec.ts` exercises the engine pipeline against a
// hand-wired `Application`. None of those paths boot the LB4 container the
// way the shipped command files do — `runOverride` and `runContract` each
// instantiate a transient `Application`, mount `ContractsComponent`, and
// resolve bindings (e.g. `FileWriter`, the four generators,
// `SourceExtension`s tagged with `SOURCE_EXTENSION_TAG`) through the DI
// graph. A wrong binding key (`classes.FileWriter` vs
// `ContractsEngineBindings.FILE_WRITER`) or a broken `findByTag` filter
// type-checks fine but throws at runtime.
//
// These tests close that gap:
//
//   1. `lb4 override <kind> <contract>` resolves every DI binding the
//      command depends on, for each of the four supported `kind` values.
//      Catches Critical #1 from the 5th review (wrong `FileWriter` key).
//
//   2. `lb4 contract <name>` discovers `SourceExtension`s contributed
//      under `SOURCE_EXTENSION_TAG` and invokes the selected one.
//      Catches Critical #2 from the 5th review (broken `findByTag(filterByTag)`).
//
//   3. `lb4 gen` happy path against a seeded fixture — exercises the
//      CONTRACTS_COMPONENT -> runtime bindings -> pipeline invocation
//      boot order via the shipped `runGen` adapter (not via a hand-wired
//      bootstrap as in `pipeline-end-to-end.spec.ts`).

import {randomBytes} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import type * as ContractsComponentModule from '../../contracts.component';

// ---------------------------------------------------------------------------
// Prompt stubs — installed BEFORE the command modules are imported so the
// `vi.mock` factory replaces the real `@clack/prompts` facade. Each test
// queues deterministic answers; `select`/`confirm`/`text`/`multiselect`
// shift off the head of the queue, matching the contract command's prompt
// order documented in `cli/commands/contract.ts`.
// ---------------------------------------------------------------------------

type Answer = string | boolean | string[] | number;
const answers: Answer[] = [];

function popAnswer(label: string): Answer {
  if (answers.length === 0) {
    throw new Error(`prompts.${label}: no queued answer (queue exhausted)`);
  }
  return answers.shift() as Answer;
}

vi.mock('../../cli/prompts', () => {
  return {
    text: vi.fn(async () => {
      const v = popAnswer('text');
      return typeof v === 'string' ? v : String(v);
    }),
    select: vi.fn(async () => popAnswer('select')),
    multiselect: vi.fn(async () => {
      const v = popAnswer('multiselect');
      return Array.isArray(v) ? v : [];
    }),
    confirm: vi.fn(async () => Boolean(popAnswer('confirm'))),
    spinner: () => ({
      start: () => undefined,
      stop: () => undefined,
      message: () => undefined,
    }),
    intro: () => undefined,
    outro: () => undefined,
    note: () => undefined,
    cancel: () => undefined,
    isCancel: () => false,
  };
});

// ---------------------------------------------------------------------------
// Stub `SourceExtension` injected into the discovery path for test case 2.
//
// `runContract` instantiates its own `Application` inside
// `discoverSourceExtensions`, mounts `ContractsComponent`, and calls
// `app.find(filterByTag(SOURCE_EXTENSION_TAG))`. The test cannot reach
// into that internal Application from the outside, so we mock the
// component module to return a subclass that also binds the stub
// extension under `SOURCE_EXTENSION_TAG`. Production `ContractsComponent`
// bindings (emitters, sources, engine singletons, generators) remain
// intact — `actual` is the real export, the subclass only appends.
// ---------------------------------------------------------------------------

const stubInvoke = vi.fn(async () => ({
  schemaFile: '/tmp/stub.schema.json',
  configFile: '/tmp/stub.config.json',
}));

vi.mock('../../contracts.component', async () => {
  const actual = await vi.importActual<typeof ContractsComponentModule>(
    '../../contracts.component',
  );
  const {Binding} = await import('@loopback/core');
  const {SOURCE_EXTENSION_TAG} = await import('../../keys');

  class TestContractsComponent extends actual.ContractsComponent {
    constructor() {
      super();
      this.bindings.push(
        Binding.bind<unknown>('platform.contracts.test.stub-source-extension')
          .to({
            name: 'stub',
            label: 'Stub source extension',
            description: 'Test-only source extension',
            invoke: stubInvoke,
          })
          .tag(SOURCE_EXTENSION_TAG),
      );
    }
  }

  return {ContractsComponent: TestContractsComponent};
});

// Imports MUST come after `vi.mock` so the mocked modules are picked up by
// the command files at load time.
import {runContract} from '../../cli/commands/contract';
import {runGen} from '../../cli/commands/gen';
import {runOverride} from '../../cli/commands/override';
import type {LoopbackConfigJson} from '../../types';

// ---------------------------------------------------------------------------
// Filesystem layout — one tmpdir per describe block so the lifecycle is
// independent of `pipeline-end-to-end.spec.ts`'s own `ROOT` / `ROOT_TSC`
// (different random suffixes; no shared writes).
// ---------------------------------------------------------------------------

const OVERRIDE_ROOT = join(
  tmpdir(),
  `lb-contracts-cli-runtime-override-${randomBytes(6).toString('hex')}`,
);
const CONTRACT_ROOT = join(
  tmpdir(),
  `lb-contracts-cli-runtime-contract-${randomBytes(6).toString('hex')}`,
);
const GEN_ROOT = join(
  tmpdir(),
  `lb-contracts-cli-runtime-gen-${randomBytes(6).toString('hex')}`,
);

const PLUGIN_ROOT = resolve(__dirname, '..', '..', '..');

const BASE_CONFIG: LoopbackConfigJson = {
  name: 'cli-runtime-test',
  schemasDir: './schemas',
  configsDir: './configs',
  validator: 'ajv',
  schemas: ['./schemas'],
  emit: {zod: true, types: true},
};

function seedProject(root: string): void {
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});

  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify(BASE_CONFIG, null, 2),
    'utf8',
  );

  writeFileSync(
    join(root, 'schemas', 'customer.schema.json'),
    JSON.stringify(
      {
        $id: 'customer.v1',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          id: {type: 'string'},
          name: {type: 'string'},
        },
        required: ['id', 'name'],
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(root, 'configs', 'customer.config.json'),
    JSON.stringify(
      {
        $schema: '../_meta/model-config.schema.json',
        $contractId: 'customer.v1',
        dataSource: 'customer',
        public: true,
        model: {base: 'Entity', strict: true, idProperty: 'id'},
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify(
      [{name: 'customer', adapter: 'memory', config: {}}],
      null,
      2,
    ),
    'utf8',
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
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Test case 1 — `lb4 override <kind> <contract>` for every supported kind
//
// Each iteration boots a transient `Application`, mounts `ContractsComponent`,
// resolves `FileWriter` + the requested generator through the DI graph, runs
// `generate()` with `includeExtension: true`, and writes the extension stub
// to disk. A wrong binding key throws `BindingError` at `app.get(...)` —
// that's the runtime symptom Critical #1 produced.
// ---------------------------------------------------------------------------

describe('lb4 override — DI binding resolution', () => {
  beforeAll(() => {
    seedProject(OVERRIDE_ROOT);
    // Symlink the plugin's own node_modules so any transitive `@loopback/*`
    // resolution inside the override command sees the same package set the
    // plugin develops against. Mirrors the pattern in
    // `pipeline-end-to-end.spec.ts`'s stage-8 setup.
    symlinkSync(
      join(PLUGIN_ROOT, 'node_modules'),
      join(OVERRIDE_ROOT, 'node_modules'),
      'dir',
    );
  });

  afterAll(() => {
    rmSync(OVERRIDE_ROOT, {recursive: true, force: true});
  });

  it.each([
    {
      kind: 'model',
      expected: ['src', 'models', 'customer.model.ts'],
    },
    {
      kind: 'repository',
      expected: ['src', 'repositories', 'customer.repository.ts'],
    },
    {
      kind: 'controller',
      expected: ['src', 'controllers', 'customer.controller.ts'],
    },
    {
      kind: 'datasource',
      expected: ['src', 'datasources', 'customer.datasource.ts'],
    },
  ] as const)(
    'resolves bindings and writes the extension for kind=$kind',
    async ({kind, expected}) => {
      const exit = await runOverride({
        projectRoot: OVERRIDE_ROOT,
        config: BASE_CONFIG,
        argv: [kind, 'customer'],
      });
      expect(exit).toBe(0);
      expect(existsSync(join(OVERRIDE_ROOT, ...expected))).toBe(true);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Test case 2 — `lb4 contract <name>` source-extension discovery
//
// Prompts are auto-answered by the `vi.mock('../../cli/prompts', ...)`
// stack above. The first `select` call inside `pickSource` chooses the
// stub extension by name; `runExtensionSource` then awaits
// `extension.invoke({name: 'user'})`. Asserting `stubInvoke` was called
// proves the discovery filter actually enumerated the tagged binding —
// Critical #2 caused the same call to return an empty list, so the
// stub's `invoke()` never fired.
// ---------------------------------------------------------------------------

describe('lb4 contract — SourceExtension discovery', () => {
  beforeAll(() => {
    seedProject(CONTRACT_ROOT);
  });

  afterAll(() => {
    rmSync(CONTRACT_ROOT, {recursive: true, force: true});
    stubInvoke.mockClear();
  });

  it('enumerates SOURCE_EXTENSION_TAG bindings and invokes the picked one', async () => {
    // The contract being scaffolded is `user` — not seeded by
    // `seedProject`, so the overwrite-guard at the top of `runContract`
    // does not bail. The source picker's `select` prompt returns the
    // stub extension's `name`, routing to `runExtensionSource`.
    answers.push('stub');
    stubInvoke.mockClear();

    const exit = await runContract({
      projectRoot: CONTRACT_ROOT,
      config: BASE_CONFIG,
      argv: ['user'],
    });

    expect(exit).toBe(0);
    expect(stubInvoke).toHaveBeenCalledTimes(1);
    expect(stubInvoke).toHaveBeenCalledWith({name: 'user'});
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Test case 3 — `lb4 gen` happy path through the CLI surface
//
// `runGen` mounts `ContractsComponent`, binds `PROJECT_PATHS`,
// `TEMPLATE_ENGINE`, and `IMPORT_MAP` at runtime, aliases the pipeline
// under the public token, and invokes the 8-stage pipeline. Exercising
// it through the CLI adapter (rather than through a hand-wired Application
// as in `pipeline-end-to-end.spec.ts`) adds regression coverage for the
// boot order Criticals #1/#2 hide behind.
// ---------------------------------------------------------------------------

describe('lb4 gen — CLI surface boot order', () => {
  beforeAll(() => {
    seedProject(GEN_ROOT);
  });

  afterAll(() => {
    rmSync(GEN_ROOT, {recursive: true, force: true});
  });

  it('boots ContractsComponent and runs the full pipeline', async () => {
    const config: LoopbackConfigJson = {
      ...BASE_CONFIG,
      schemas: [join(GEN_ROOT, 'schemas')],
    };
    const exit = await runGen({
      projectRoot: GEN_ROOT,
      config,
      argv: ['--skip-tsc'],
    });
    expect(exit).toBe(0);

    // Sidecar projections (zod + types) land under `src/models/`.
    expect(
      existsSync(join(GEN_ROOT, 'src', 'models', 'customer-v1.zod.ts')),
    ).toBe(true);
    expect(
      existsSync(join(GEN_ROOT, 'src', 'models', 'customer-v1.types.ts')),
    ).toBe(true);

    // Stage 5 meta-schemas land under `_meta/`.
    expect(
      existsSync(join(GEN_ROOT, '_meta', 'model-config.schema.json')),
    ).toBe(true);
    expect(existsSync(join(GEN_ROOT, '_meta', 'datasources.schema.json'))).toBe(
      true,
    );
    expect(existsSync(join(GEN_ROOT, '_meta', 'emitter.schema.json'))).toBe(
      true,
    );
  }, 60_000);
});
