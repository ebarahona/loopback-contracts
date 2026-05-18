import {randomBytes} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

// `vi.mock` is hoisted; this stack-of-answers pattern lets each `it()` queue
// a deterministic answer sequence before invoking the command. The mock
// preserves the public surface of `../../cli/prompts` so the command files
// import the same symbols they always did.
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
    text: vi.fn(async (_opts: {defaultValue?: string}) => {
      const v = popAnswer('text');
      if (typeof v === 'string') return v;
      return String(v);
    }),
    select: vi.fn(async () => popAnswer('select')),
    multiselect: vi.fn(async () => {
      const v = popAnswer('multiselect');
      return Array.isArray(v) ? v : [];
    }),
    confirm: vi.fn(async () => {
      const v = popAnswer('confirm');
      return Boolean(v);
    }),
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

// Imports MUST come after `vi.mock` so the command files pick up the mock.
import {Application, BindingScope} from '@loopback/core';
import {runContract} from '../../cli/commands/contract';
import {runInit} from '../../cli/commands/init';
import {ContractsComponent} from '../../contracts.component';
import {
  DefaultProjectPaths,
  EjsTemplateEngine,
  EmitterRegistry,
  EmitterRunner,
  FileWriter,
  InMemoryLossyReporter,
  InMemorySchemaRegistry,
  Pipeline,
  RelativeImportMap,
  SourceResolverRegistry,
} from '../../engine';
import {ContractsEngineBindings} from '../../engine/tokens';
import type {ImportMap, SchemaRegistry} from '../../interfaces';
import {ContractsBindings} from '../../keys';
import {
  GitSchemaSource,
  HttpSchemaSource,
  LocalSchemaSource,
  NpmSchemaSource,
} from '../../sources';
import type {LoopbackConfigJson} from '../../types';

const ROOT = join(
  tmpdir(),
  `lb-contracts-cli-${randomBytes(6).toString('hex')}`,
);

beforeAll(() => {
  mkdirSync(ROOT, {recursive: true});
  // Seed a tsconfig so stage 8 has a project to introspect (it's skipped
  // via skipTsc anyway, but keeps the layout realistic).
  writeFileSync(
    join(ROOT, 'tsconfig.json'),
    JSON.stringify({compilerOptions: {target: 'ES2022'}}, null, 2),
    'utf8',
  );
});

afterAll(() => {
  rmSync(ROOT, {recursive: true, force: true});
});

afterEach(() => {
  answers.length = 0;
});

describe('CLI end-to-end (init -> contract -> gen)', () => {
  it('scaffolds, authors, and generates artefacts via mocked prompts', async () => {
    // ---- init ----
    // Queue answers in the exact order init.ts consumes them:
    //   text(projectName), text(schemasDir), text(configsDir),
    //   select(sourceKind), select(validator), select(moduleFormat),
    //   multiselect(emits)
    //
    // Note: select(importExtension) only fires when moduleFormat === 'esm';
    // 'default' bypasses it.
    answers.push(
      'cli-test', // projectName
      './schemas', // schemasDir
      './configs', // configsDir
      'none', // sourceKind
      'ajv', // validator
      'default', // moduleFormat (CJS — skips importExtension prompt)
      ['zod', 'types'], // multiselect emits
    );
    const initExit = await runInit({projectRoot: ROOT, argv: []});
    expect(initExit).toBe(0);
    expect(existsSync(join(ROOT, 'loopback.config.json'))).toBe(true);
    expect(existsSync(join(ROOT, 'schemas'))).toBe(true);
    expect(existsSync(join(ROOT, 'configs'))).toBe(true);

    // The init writer rewrites the file as formatted JSONC; reload the
    // canonical form to feed `runContract` and `runGen`.
    const config = JSON.parse(
      readFileSync(join(ROOT, 'loopback.config.json'), 'utf8'),
    ) as LoopbackConfigJson;
    expect(config.name).toBe('cli-test');
    expect(config.emit['zod']).toBe(true);
    expect(config.emit['types']).toBe(true);

    // Seed `datasources.json` before scaffolding any contract. The wizard
    // requires at least one declared datasource to bind to — without this
    // step `runContract` exits non-zero with a "no datasources declared"
    // error (which is the intended behaviour: a `dataSource: null` config
    // would fail stage-5 validation at gen-time anyway). This mirrors what
    // `lb-contracts ds primary --adapter memory` would have written.
    writeFileSync(
      join(ROOT, 'datasources.json'),
      JSON.stringify({mem: {adapter: 'memory', config: {}}}, null, 2),
      'utf8',
    );

    // ---- contract customer ----
    // Sequence consumed by `runContract`/`runManualWizard`:
    //   text(id) -> text(description) -> confirm('Add a property?') yes
    //   text(name), select(kind), confirm(required), [select(format)]
    //   confirm(more?) no -> select(dataSource) -> confirm(public)
    //   -> text(idProperty)
    answers.push(
      'customer.v1', // id
      '', // description
      true, // confirm: add property?
      'id', // property name
      'string', // property kind
      true, // required?
      '', // string format (none)
      true, // confirm: add another?
      'name', // property name
      'string', // kind
      true, // required
      '', // format
      false, // confirm: add another? no
      'mem', // select(dataSource)
      true, // confirm: public?
      'id', // idProperty
    );
    const customerExit = await runContract({
      projectRoot: ROOT,
      config,
      argv: ['customer'],
    });
    expect(customerExit).toBe(0);
    expect(existsSync(join(ROOT, 'schemas', 'customer.schema.json'))).toBe(
      true,
    );
    expect(existsSync(join(ROOT, 'configs', 'customer.config.json'))).toBe(
      true,
    );

    // ---- contract order ----
    answers.push(
      'order.v1', // id
      '', // description
      true, // add property
      'id', // name
      'string', // kind
      true, // required
      '', // format
      true, // add another
      'total', // name
      'number', // kind
      false, // required
      false, // add another -> stop
      'mem', // select(dataSource)
      true, // public
      'id', // idProperty
    );
    const orderExit = await runContract({
      projectRoot: ROOT,
      config,
      argv: ['order'],
    });
    expect(orderExit).toBe(0);
    expect(existsSync(join(ROOT, 'schemas', 'order.schema.json'))).toBe(true);
    expect(existsSync(join(ROOT, 'configs', 'order.config.json'))).toBe(true);

    // Sanity-check: the wizard wrote `dataSource: 'mem'` directly — no
    // post-hoc rewriting needed. Stage 5 will validate against
    // `datasources.json` and pass.
    for (const name of ['customer', 'order']) {
      const raw = JSON.parse(
        readFileSync(join(ROOT, 'configs', `${name}.config.json`), 'utf8'),
      );
      expect(raw.dataSource).toBe('mem');
    }

    // ---- gen ----
    // Drive the pipeline through a local bootstrap that mirrors the
    // shipped `runGen`: mount `ContractsComponent`, then bind the
    // runtime-valued keys (`PROJECT_PATHS`, `TEMPLATE_ENGINE`,
    // `IMPORT_MAP`) the component intentionally omits. The exercised
    // path (Pipeline -> EmitterRunner -> ZodEmitter/TypesEmitter ->
    // FileWriter) is identical to what `lb-contracts gen` runs.
    const genConfig: LoopbackConfigJson = {
      ...config,
      schemas: [join(ROOT, 'schemas')],
    };
    const app = await bootstrapPipeline(ROOT, genConfig);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );
      const result = await pipeline.run({
        projectRoot: ROOT,
        config: genConfig,
        emitFlags: {zod: true, types: true},
        skipTsc: true,
      });
      expect(result.filesWritten.length).toBeGreaterThan(0);
    } finally {
      await app.stop();
    }

    // Sidecar artefacts under src/models/. Two schemas × two emitters.
    expect(existsSync(join(ROOT, 'src', 'models', 'customer-v1.zod.ts'))).toBe(
      true,
    );
    expect(
      existsSync(join(ROOT, 'src', 'models', 'customer-v1.types.ts')),
    ).toBe(true);
    expect(existsSync(join(ROOT, 'src', 'models', 'order-v1.zod.ts'))).toBe(
      true,
    );
    expect(existsSync(join(ROOT, 'src', 'models', 'order-v1.types.ts'))).toBe(
      true,
    );

    const customerZod = readFileSync(
      join(ROOT, 'src', 'models', 'customer-v1.zod.ts'),
      'utf8',
    );
    expect(customerZod).toContain('export const CustomerV1Schema =');

    // Stage 5 meta-schemas land under _meta/.
    expect(existsSync(join(ROOT, '_meta', 'model-config.schema.json'))).toBe(
      true,
    );
    expect(existsSync(join(ROOT, '_meta', 'datasources.schema.json'))).toBe(
      true,
    );
  });
});

async function bootstrapPipeline(
  projectRoot: string,
  config: LoopbackConfigJson,
): Promise<Application> {
  const app = new Application();
  app.bind(ContractsBindings.CONFIG).to(config);
  app.bind('platform.contracts.project-root').to(projectRoot);

  const paths = new DefaultProjectPaths(projectRoot, config);
  app.bind(ContractsBindings.PROJECT_PATHS).to(paths);

  app.service(InMemorySchemaRegistry);
  app.service(InMemoryLossyReporter);
  app.service(FileWriter);
  app.service(EmitterRegistry);
  app.service(EmitterRunner);
  app.service(SourceResolverRegistry);
  app.service(Pipeline);

  app
    .bind(ContractsEngineBindings.PIPELINE)
    .toAlias(`services.${Pipeline.name}`);
  app
    .bind(ContractsEngineBindings.EMITTER_REGISTRY)
    .toAlias(`services.${EmitterRegistry.name}`);
  app
    .bind(ContractsEngineBindings.EMITTER_RUNNER)
    .toAlias(`services.${EmitterRunner.name}`);
  app
    .bind(ContractsEngineBindings.FILE_WRITER)
    .toAlias(`services.${FileWriter.name}`);
  app
    .bind(ContractsEngineBindings.SOURCE_RESOLVER_REGISTRY)
    .toAlias(`services.${SourceResolverRegistry.name}`);

  app
    .bind(ContractsBindings.SCHEMA_REGISTRY)
    .toAlias(`services.${InMemorySchemaRegistry.name}`);
  app
    .bind(ContractsBindings.LOSSY_REPORTER)
    .toAlias(`services.${InMemoryLossyReporter.name}`);

  app
    .bind(ContractsBindings.TEMPLATE_ENGINE)
    .toDynamicValue(() => new EjsTemplateEngine(paths.outputDir))
    .inScope(BindingScope.SINGLETON);
  app
    .bind(ContractsBindings.IMPORT_MAP)
    .toDynamicValue(resolutionCtx => {
      const registry = resolutionCtx.context.getSync<SchemaRegistry>(
        ContractsBindings.SCHEMA_REGISTRY,
      );
      const map: ImportMap = new RelativeImportMap(registry, id =>
        join(paths.outputDir, 'models', `${id}.base.model.ts`),
      );
      return map;
    })
    .inScope(BindingScope.SINGLETON);

  app.service(LocalSchemaSource);
  app.service(NpmSchemaSource);
  app.service(GitSchemaSource);
  app.service(HttpSchemaSource);

  app.component(ContractsComponent);

  await app.start();
  return app;
}
