import {Application, BindingScope} from '@loopback/core';
import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
import {ContractsPipelineError, ContractsValidationError} from '../../helpers';
import type {ImportMap, SchemaRegistry} from '../../interfaces';
import {ContractsBindings} from '../../keys';
import {
  GitSchemaSource,
  HttpSchemaSource,
  LocalSchemaSource,
  NpmSchemaSource,
} from '../../sources';
import type {LoopbackConfigJson} from '../../types';

const TMP_ROOT = join(
  tmpdir(),
  `lb-contracts-pipeline-${randomBytes(6).toString('hex')}`,
);

beforeAll(() => {
  mkdirSync(TMP_ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(TMP_ROOT, {recursive: true, force: true});
});

function makeProject(name: string): string {
  const root = join(TMP_ROOT, name);
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});
  return root;
}

function defaultConfig(
  overrides: Partial<LoopbackConfigJson> = {},
): LoopbackConfigJson {
  return {
    name: 'test',
    schemasDir: './schemas',
    configsDir: './configs',
    validator: 'ajv',
    schemas: ['./schemas'],
    emit: {},
    ...overrides,
  };
}

async function bootstrap(
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

describe('Pipeline stage gates', () => {
  it('stage 2 fails on a schema missing $id', async () => {
    const root = makeProject('stage2-missing-id');
    writeFileSync(
      join(root, 'schemas', 'bad.schema.json'),
      JSON.stringify({type: 'object', properties: {}}),
      'utf8',
    );
    const config = defaultConfig({schemas: [join(root, 'schemas')]});
    const app = await bootstrap(root, config);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );
      await expect(
        pipeline.run({
          projectRoot: root,
          config,
          emitFlags: {},
          validateOnly: true,
          maxStage: 2,
        }),
      ).rejects.toBeInstanceOf(ContractsValidationError);
    } finally {
      await app.stop();
    }
  });

  it('stage 2 fails on malformed JSON', async () => {
    const root = makeProject('stage2-malformed-json');
    writeFileSync(
      join(root, 'schemas', 'bad.schema.json'),
      '{not json}',
      'utf8',
    );
    const config = defaultConfig({schemas: [join(root, 'schemas')]});
    const app = await bootstrap(root, config);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );
      await expect(
        pipeline.run({
          projectRoot: root,
          config,
          emitFlags: {},
          validateOnly: true,
          maxStage: 2,
        }),
      ).rejects.toBeInstanceOf(ContractsValidationError);
    } finally {
      await app.stop();
    }
  });

  it('stage 3 fails on duplicate $id with different content', async () => {
    const root = makeProject('stage3-dup');
    writeFileSync(
      join(root, 'schemas', 'a.schema.json'),
      JSON.stringify({
        $id: 'dup.v1',
        type: 'object',
        properties: {a: {type: 'string'}},
      }),
      'utf8',
    );
    writeFileSync(
      join(root, 'schemas', 'b.schema.json'),
      JSON.stringify({
        $id: 'dup.v1',
        type: 'object',
        properties: {a: {type: 'integer'}},
      }),
      'utf8',
    );
    const config = defaultConfig({schemas: [join(root, 'schemas')]});
    const app = await bootstrap(root, config);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );
      await expect(
        pipeline.run({
          projectRoot: root,
          config,
          emitFlags: {},
          validateOnly: true,
          maxStage: 3,
        }),
      ).rejects.toBeInstanceOf(ContractsValidationError);
    } finally {
      await app.stop();
    }
  });

  it('stage 4 fails on a dangling cross-schema $ref', async () => {
    const root = makeProject('stage4-dangling');
    writeFileSync(
      join(root, 'schemas', 'order.schema.json'),
      JSON.stringify({
        $id: 'order.v1',
        type: 'object',
        properties: {customer: {$ref: 'customer.v1'}},
      }),
      'utf8',
    );
    const config = defaultConfig({schemas: [join(root, 'schemas')]});
    const app = await bootstrap(root, config);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );
      await expect(
        pipeline.run({
          projectRoot: root,
          config,
          emitFlags: {},
          validateOnly: true,
          maxStage: 4,
        }),
      ).rejects.toBeInstanceOf(ContractsValidationError);
    } finally {
      await app.stop();
    }
  });

  it('stage 5 fails when a config references an unknown datasource', async () => {
    const root = makeProject('stage5-unknown-ds');
    writeFileSync(
      join(root, 'schemas', 'customer.schema.json'),
      JSON.stringify({
        $id: 'customer.v1',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {id: {type: 'string'}},
        required: ['id'],
      }),
      'utf8',
    );
    writeFileSync(
      join(root, 'configs', 'customer.config.json'),
      JSON.stringify({
        $schema: '../_meta/model-config.schema.json',
        $contractId: 'customer.v1',
        dataSource: 'nonexistent-datasource',
        public: true,
        model: {base: 'Entity', strict: true, idProperty: 'id'},
      }),
      'utf8',
    );
    // Populate datasources.json with one known datasource so the model-
    // config meta-schema bakes a `dataSource` enum. The config above
    // references a name that is NOT in the enum, so meta-schema
    // validation must reject it in stage 5.
    writeFileSync(
      join(root, 'datasources.json'),
      JSON.stringify([{name: 'mem', adapter: 'memory', config: {}}]),
      'utf8',
    );
    const config = defaultConfig({schemas: [join(root, 'schemas')]});
    const app = await bootstrap(root, config);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );
      await expect(
        pipeline.run({
          projectRoot: root,
          config,
          emitFlags: {},
          validateOnly: true,
          skipMetaSchemaWrite: true,
          maxStage: 5,
        }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ContractsValidationError ||
          err instanceof ContractsPipelineError,
      );
    } finally {
      await app.stop();
    }
  });

  // Stage 8 invokes `npx --no-install tsc --noEmit` against the project. In
  // a tmpdir we cannot guarantee a resolvable `tsc` binary, so we skip rather
  // than introduce a flaky environment dependency. The stage-8 success path
  // is already exercised in the integration test via `skipTsc: true`.
  it.skip('stage 8 returns tscOk: false for code with a type error', () => {
    // Intentionally left blank — see comment above.
  });
});
