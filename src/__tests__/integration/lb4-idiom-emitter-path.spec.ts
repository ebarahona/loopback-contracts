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
import type {ImportMap, SchemaRegistry} from '../../interfaces';
import {ContractsBindings} from '../../keys';
import {
  GitSchemaSource,
  HttpSchemaSource,
  LocalSchemaSource,
  NpmSchemaSource,
} from '../../sources';
import type {LoopbackConfigJson} from '../../types';

// Two fixture trees: one with model configs (lb4-idiom emitters fire), one
// without (sidecar-only project — lb4-idiom emitters must NOT fire even
// when their flags are enabled by default).
const ROOT_WITH_CONFIG = join(
  tmpdir(),
  `lb4-idiom-with-config-${randomBytes(8).toString('hex')}`,
);
const ROOT_NO_CONFIG = join(
  tmpdir(),
  `lb4-idiom-no-config-${randomBytes(8).toString('hex')}`,
);

const CONFIG: LoopbackConfigJson = {
  name: 'lb4-idiom-emitter-path',
  schemasDir: './schemas',
  configsDir: './configs',
  validator: 'ajv',
  schemas: ['./schemas'],
  emit: {},
};

const PERSON_SCHEMA = {
  $id: 'person.v1',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: {type: 'string'},
    name: {type: 'string'},
  },
  required: ['id', 'name'],
};

const PERSON_CONFIG = {
  $schema: '../_meta/model-config.schema.json',
  $contractId: 'person.v1',
  dataSource: 'mem',
  public: true,
  model: {base: 'Entity', strict: true, idProperty: 'id'},
};

const DATASOURCES = [{name: 'mem', adapter: 'memory', config: {}}];

function seedFixture(root: string, includeConfig: boolean): void {
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});

  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify(CONFIG, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'schemas', 'person.schema.json'),
    JSON.stringify(PERSON_SCHEMA, null, 2),
    'utf8',
  );
  if (includeConfig) {
    writeFileSync(
      join(root, 'configs', 'person.config.json'),
      JSON.stringify(PERSON_CONFIG, null, 2),
      'utf8',
    );
    writeFileSync(
      join(root, 'datasources.json'),
      JSON.stringify(DATASOURCES, null, 2),
      'utf8',
    );
  }
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
}

beforeAll(() => {
  seedFixture(ROOT_WITH_CONFIG, true);
  seedFixture(ROOT_NO_CONFIG, false);
});

afterAll(() => {
  rmSync(ROOT_WITH_CONFIG, {recursive: true, force: true});
  rmSync(ROOT_NO_CONFIG, {recursive: true, force: true});
});

async function bootstrap(
  root: string,
  config: LoopbackConfigJson,
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

describe('LB4-idiom emitter path (PR-C)', () => {
  it('routes model/repository/controller/datasource through EmitterRunner when a config exists', async () => {
    const app = await bootstrap(ROOT_WITH_CONFIG, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      const result = await pipeline.run({
        projectRoot: ROOT_WITH_CONFIG,
        config: {...CONFIG, schemas: [join(ROOT_WITH_CONFIG, 'schemas')]},
        emitFlags: {
          model: true,
          repository: true,
          controller: true,
          datasource: true,
        },
        skipTsc: true,
      });

      const written = result.filesWritten.map(p => p.replace(/\\/g, '/'));

      // Base files for the single schema (`person.v1`) — the regen
      // half of each generator's two-file output.
      expect(written.some(p => p.endsWith('models/person.base.model.ts'))).toBe(
        true,
      );
      expect(
        written.some(p => p.endsWith('repositories/person.base.repository.ts')),
      ).toBe(true);
      expect(
        written.some(p => p.endsWith('controllers/person.base.controller.ts')),
      ).toBe(true);
      expect(
        written.some(p => p.endsWith('datasources/mem.base.datasource.ts')),
      ).toBe(true);

      // Extension stubs are emitted as `skipIfExists` — on a fresh run
      // they appear in filesWritten too (writer only skips them on the
      // second run, after the user has had a chance to edit).
      expect(written.some(p => p.endsWith('models/person.model.ts'))).toBe(
        true,
      );
    } finally {
      await app.stop();
    }
  });

  it('emits no LB4-idiom files for a sidecar-only project (no configs)', async () => {
    const app = await bootstrap(ROOT_NO_CONFIG, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      const result = await pipeline.run({
        projectRoot: ROOT_NO_CONFIG,
        config: {...CONFIG, schemas: [join(ROOT_NO_CONFIG, 'schemas')]},
        emitFlags: {
          model: true,
          repository: true,
          controller: true,
          datasource: true,
        },
        skipTsc: true,
      });

      const written = result.filesWritten.map(p => p.replace(/\\/g, '/'));

      // No config registered for `person.v1` -> the four lb4-idiom
      // emitters all return `[]`. Pipeline still writes meta-schemas,
      // but nothing under models/repositories/controllers/datasources.
      expect(written.some(p => p.includes('/models/person.'))).toBe(false);
      expect(written.some(p => p.includes('/repositories/'))).toBe(false);
      expect(written.some(p => p.includes('/controllers/'))).toBe(false);
      expect(written.some(p => p.includes('/datasources/'))).toBe(false);
    } finally {
      await app.stop();
    }
  });
});
