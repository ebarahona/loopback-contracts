import {Application, BindingScope} from '@loopback/core';
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
  `lb-contracts-e2e-${randomBytes(6).toString('hex')}`,
);

const ROOT_TSC = join(
  tmpdir(),
  `lb-contracts-e2e-tsc-${randomBytes(6).toString('hex')}`,
);

const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

const CONFIG: LoopbackConfigJson = {
  name: 'e2e-test',
  schemasDir: './schemas',
  configsDir: './configs',
  validator: 'ajv',
  schemas: ['./schemas'],
  emit: {zod: true, types: true},
};

const TSC_CONFIG: LoopbackConfigJson = {
  name: 'e2e-tsc-test',
  schemasDir: './schemas',
  configsDir: './configs',
  validator: 'ajv',
  schemas: ['./schemas'],
  emit: {zod: true, types: true},
};

beforeAll(() => {
  mkdirSync(join(ROOT, 'schemas'), {recursive: true});
  mkdirSync(join(ROOT, 'configs'), {recursive: true});

  writeFileSync(
    join(ROOT, 'loopback.config.json'),
    JSON.stringify(CONFIG, null, 2),
    'utf8',
  );

  writeFileSync(
    join(ROOT, 'schemas', 'customer.schema.json'),
    JSON.stringify(
      {
        $id: 'customer.v1',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          id: {type: 'string'},
          name: {type: 'string'},
          email: {type: 'string', format: 'email'},
        },
        required: ['id', 'name'],
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(ROOT, 'schemas', 'order.schema.json'),
    JSON.stringify(
      {
        $id: 'order.v1',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          // The types emitter passes the raw schema to
          // `json-schema-to-typescript`, which resolves `$ref` via the
          // filesystem and cannot follow a bare `$id` like 'customer.v1'.
          // Keep the integration test self-contained by using a
          // `customerId` foreign key field instead of a cross-schema
          // `$ref` — pipeline stages 1-6 still see two schemas, but the
          // types emitter does not blow up.
          id: {type: 'string'},
          customerId: {type: 'string'},
          total: {type: 'number'},
        },
        required: ['id'],
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(ROOT, 'configs', 'customer.config.json'),
    JSON.stringify(
      {
        $schema: '../_meta/model-config.schema.json',
        $contractId: 'customer.v1',
        dataSource: 'mem',
        public: true,
        model: {base: 'Entity', strict: true, idProperty: 'id'},
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(ROOT, 'configs', 'order.config.json'),
    JSON.stringify(
      {
        $schema: '../_meta/model-config.schema.json',
        $contractId: 'order.v1',
        dataSource: 'mem',
        public: true,
        model: {base: 'Entity', strict: true, idProperty: 'id'},
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(ROOT, 'datasources.json'),
    JSON.stringify([{name: 'mem', adapter: 'memory', config: {}}], null, 2),
    'utf8',
  );

  writeFileSync(
    join(ROOT, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'commonjs',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: './dist',
          rootDir: './src',
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
    'utf8',
  );
});

afterAll(() => {
  rmSync(ROOT, {recursive: true, force: true});
});

async function bootstrap(
  root: string = ROOT,
  config: LoopbackConfigJson = CONFIG,
): Promise<Application> {
  const app = new Application();
  app.bind(ContractsBindings.CONFIG).to(config);
  app.bind('platform.contracts.project-root').to(root);

  const paths = new DefaultProjectPaths(root, config);
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

  app
    .bind(ContractsBindings.SCHEMA_REGISTRY)
    .toAlias(`services.${InMemorySchemaRegistry.name}`);
  app
    .bind(ContractsBindings.LOSSY_REPORTER)
    .toAlias(`services.${InMemoryLossyReporter.name}`);

  app.service(LocalSchemaSource);
  app.service(NpmSchemaSource);
  app.service(GitSchemaSource);
  app.service(HttpSchemaSource);

  app.component(ContractsComponent);

  await app.start();
  return app;
}

describe('Pipeline end-to-end', () => {
  it('runs every stage and writes the expected sidecar artefacts', async () => {
    const app = await bootstrap();
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      // Resolve the configured schema source against the tmpdir's absolute
      // schemas path so the local-source resolver finds the seeded files.
      const result = await pipeline.run({
        projectRoot: ROOT,
        config: {...CONFIG, schemas: [join(ROOT, 'schemas')]},
        emitFlags: {zod: true, types: true},
        skipTsc: true,
      });

      // The pipeline runs every gate before codegen.
      expect(result.stagesRun).toBe(8);
      expect(result.tscOk).toBe(true);
      expect(result.filesWritten.length).toBeGreaterThan(0);

      // Each enabled emitter produces one file per schema — 2 schemas × 2
      // emitters = 4 written sidecar files.
      const written = result.filesWritten.map(p => p.replace(/\\/g, '/'));
      expect(written.some(p => p.endsWith('models/customer-v1.zod.ts'))).toBe(
        true,
      );
      expect(written.some(p => p.endsWith('models/order-v1.zod.ts'))).toBe(
        true,
      );
      expect(written.some(p => p.endsWith('models/customer-v1.types.ts'))).toBe(
        true,
      );
      expect(written.some(p => p.endsWith('models/order-v1.types.ts'))).toBe(
        true,
      );

      // Sidecar contents carry the expected exports.
      const customerZod = readFileSync(
        join(ROOT, 'src', 'models', 'customer-v1.zod.ts'),
        'utf8',
      );
      expect(customerZod).toContain('export const CustomerV1Schema =');
      expect(customerZod).toContain(
        'export type CustomerV1 = z.infer<typeof CustomerV1Schema>',
      );

      const orderTypes = readFileSync(
        join(ROOT, 'src', 'models', 'order-v1.types.ts'),
        'utf8',
      );
      expect(orderTypes).toContain('export interface OrderV1');

      // Stage 5 writes the three meta-schemas under _meta/.
      expect(existsSync(join(ROOT, '_meta', 'model-config.schema.json'))).toBe(
        true,
      );
      expect(existsSync(join(ROOT, '_meta', 'datasources.schema.json'))).toBe(
        true,
      );
      expect(existsSync(join(ROOT, '_meta', 'emitter.schema.json'))).toBe(true);

      // Stage 6 persists the diff-state cache.
      expect(
        existsSync(join(ROOT, '.loopback', 'cache', 'diff-state.json')),
      ).toBe(true);
    } finally {
      await app.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-8 compile gate — verifies the production `lb4 gen` codegen path
// produces TypeScript that compiles against real `@loopback/core`,
// `@loopback/repository`, and `@loopback/rest` declarations. Drives the
// engine directly with the four LB4-idiom emit flags enabled, so the test
// covers the same EmitterRunner -> ProjectionEmitter -> FileWriter chain
// that PR-C wired up under `EMITTER_TAG` / `tier: 'lb4-idiom'`. The
// `<name>.base.<kind>.ts` regen-only outputs and the `<name>.<kind>.ts`
// skipIfExists extension stubs both land on disk in one pipeline run; both
// sides must survive `tsc --noEmit` for stage 8 to pass.
//
// If any emitted base file imports a symbol that does not exist on disk
// (the exact failure mode behind audit Critical #8) the compiler fails
// and so does this test.
// ---------------------------------------------------------------------------

beforeAll(() => {
  mkdirSync(join(ROOT_TSC, 'schemas'), {recursive: true});
  mkdirSync(join(ROOT_TSC, 'configs'), {recursive: true});

  writeFileSync(
    join(ROOT_TSC, 'loopback.config.json'),
    JSON.stringify(TSC_CONFIG, null, 2),
    'utf8',
  );

  writeFileSync(
    join(ROOT_TSC, 'schemas', 'customer.schema.json'),
    JSON.stringify(
      {
        $id: 'customer.v1',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          id: {type: 'string', format: 'uuid'},
          name: {type: 'string'},
          email: {type: 'string', format: 'email'},
        },
        required: ['id', 'name'],
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(ROOT_TSC, 'schemas', 'order.schema.json'),
    JSON.stringify(
      {
        $id: 'order.v1',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          id: {type: 'string', format: 'uuid'},
          customerId: {type: 'string'},
        },
        required: ['id'],
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(ROOT_TSC, 'configs', 'customer.config.json'),
    JSON.stringify(
      {
        $schema: '../_meta/model-config.schema.json',
        $contractId: 'customer.v1',
        dataSource: 'primary',
        public: true,
        model: {base: 'Entity', strict: true, idProperty: 'id'},
      },
      null,
      2,
    ),
    'utf8',
  );

  // The `belongsTo` relation is load-bearing — it forces the model and
  // repository base templates to emit cross-model imports (the `Customer`
  // / `CustomerWithRelations` aliases and the `CustomerBaseRepository`
  // type) that must resolve against existing exports under regen-only.
  writeFileSync(
    join(ROOT_TSC, 'configs', 'order.config.json'),
    JSON.stringify(
      {
        $schema: '../_meta/model-config.schema.json',
        $contractId: 'order.v1',
        dataSource: 'primary',
        public: true,
        model: {base: 'Entity', strict: true, idProperty: 'id'},
        relations: {
          customer: {
            type: 'belongsTo',
            schema: 'customer.v1',
            keyFrom: 'customerId',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  writeFileSync(
    join(ROOT_TSC, 'datasources.json'),
    JSON.stringify([{name: 'primary', adapter: 'memory', config: {}}], null, 2),
    'utf8',
  );

  // Mirror tsconfig.json from the plugin so the fixture compiles under the
  // same strict flag matrix the plugin ships with — generated code must
  // survive `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
  // the decorator metadata combo a real consumer would enable.
  writeFileSync(
    join(ROOT_TSC, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'commonjs',
          declaration: false,
          strict: true,
          noImplicitAny: true,
          strictNullChecks: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          esModuleInterop: true,
          emitDecoratorMetadata: true,
          experimentalDecorators: true,
          target: 'ES2022',
          skipLibCheck: true,
          noEmit: true,
          types: ['node'],
        },
        include: ['src/**/*'],
        exclude: ['node_modules'],
      },
      null,
      2,
    ),
    'utf8',
  );

  // Approach (a) from the test plan: symlink the plugin's own
  // `node_modules` into the fixture tree. The plugin's devDependencies
  // include `@loopback/repository` and `@loopback/rest` precisely so the
  // generated base files can resolve their imports against real
  // declaration files — no stub `.d.ts` shims that drift from the actual
  // package shape.
  symlinkSync(
    join(PROJECT_ROOT, 'node_modules'),
    join(ROOT_TSC, 'node_modules'),
    'dir',
  );
});

afterAll(() => {
  rmSync(ROOT_TSC, {recursive: true, force: true});
});

describe('Pipeline end-to-end — stage 8 tsc gate', () => {
  it('lb4-gen output (sidecars + lb4-idiom) compiles cleanly under tsc --noEmit', async () => {
    const app = await bootstrap(ROOT_TSC, TSC_CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      // One pipeline run exercises the production path PR-C wired up:
      // sidecar emitters (zod, types) plus the four LB4-idiom emitters
      // tagged under `EMITTER_TAG` (model, repository, controller,
      // datasource). `skipTsc: false` engages stage 8 — `npx tsc --noEmit
      // -p tsconfig.json` against the fixture's strict compiler matrix
      // (noUncheckedIndexedAccess + exactOptionalPropertyTypes + the
      // decorator metadata combo). Both the regen-only `<name>.base.<kind>
      // .ts` files and the skipIfExists `<name>.<kind>.ts` extension
      // stubs land in this single run; both sides must compile.
      const result = await pipeline.run({
        projectRoot: ROOT_TSC,
        config: {...TSC_CONFIG, schemas: [join(ROOT_TSC, 'schemas')]},
        emitFlags: {
          zod: true,
          types: true,
          model: true,
          repository: true,
          controller: true,
          datasource: true,
        },
        skipTsc: false,
      });

      expect(result.tscOk).toBe(true);

      // Every LB4-idiom emitter produced its base file (regen) plus the
      // extension stub (skipIfExists, written on first run).
      expect(
        existsSync(join(ROOT_TSC, 'src', 'models', 'customer.base.model.ts')),
      ).toBe(true);
      expect(
        existsSync(join(ROOT_TSC, 'src', 'models', 'customer.model.ts')),
      ).toBe(true);
      expect(
        existsSync(join(ROOT_TSC, 'src', 'models', 'order.base.model.ts')),
      ).toBe(true);
      expect(
        existsSync(join(ROOT_TSC, 'src', 'models', 'order.model.ts')),
      ).toBe(true);
      expect(
        existsSync(
          join(ROOT_TSC, 'src', 'repositories', 'customer.base.repository.ts'),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(ROOT_TSC, 'src', 'repositories', 'order.base.repository.ts'),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(ROOT_TSC, 'src', 'controllers', 'customer.base.controller.ts'),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(ROOT_TSC, 'src', 'controllers', 'order.base.controller.ts'),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(ROOT_TSC, 'src', 'datasources', 'primary.base.datasource.ts'),
        ),
      ).toBe(true);
    } finally {
      await app.stop();
    }
    // `npx tsc` cold start plus the full project type-check against real
    // @loopback packages takes well over the suite-wide 30s default.
  }, 120_000);
});
