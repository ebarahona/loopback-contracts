import {Application, BindingScope} from '@loopback/core';
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
import type {EmittedFile, ImportMap, SchemaRegistry} from '../../interfaces';
import {ContractsBindings} from '../../keys';
import {
  GitSchemaSource,
  HttpSchemaSource,
  LocalSchemaSource,
  NpmSchemaSource,
} from '../../sources';
import type {LoopbackConfigJson} from '../../types';

// Fresh tmpdir per describe block keeps this suite from racing the
// `pipeline-end-to-end.spec.ts` E2E fixtures (which share an `lb-contracts-e2e-`
// prefix). The `multi-output-` prefix is the cross-wave fingerprint.
const ROOT = join(tmpdir(), `multi-output-${randomBytes(8).toString('hex')}`);

const ROOT_DISABLED = join(
  tmpdir(),
  `multi-output-disabled-${randomBytes(8).toString('hex')}`,
);

const CONFIG: LoopbackConfigJson = {
  name: 'multi-output-test',
  schemasDir: './schemas',
  configsDir: './configs',
  validator: 'ajv',
  schemas: ['./schemas'],
  emit: {dto: true},
};

const CONFIG_DISABLED: LoopbackConfigJson = {
  name: 'multi-output-disabled-test',
  schemasDir: './schemas',
  configsDir: './configs',
  validator: 'ajv',
  schemas: ['./schemas'],
  // No `emit.dto` — manifest is discovered but stays disabled.
  emit: {},
};

const CUSTOMER_SCHEMA = {
  $id: 'customer.v1',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: {type: 'string'},
    name: {type: 'string'},
    email: {type: 'string', format: 'email'},
  },
  required: ['id', 'name'],
};

const CUSTOMER_CONFIG = {
  $schema: '../_meta/model-config.schema.json',
  $contractId: 'customer.v1',
  dataSource: 'mem',
  public: true,
  model: {base: 'Entity', strict: true, idProperty: 'id'},
};

const DATASOURCES = [{name: 'mem', adapter: 'memory', config: {}}];

const TSCONFIG = {
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
};

const DTO_MANIFEST = {
  kind: 'dto',
  tier: 'convenience',
  description: 'Create/Update/Read DTO projections',
  outputs: [
    {
      template: './templates/dto/create.dto.ts.ejs',
      path: 'models/{{kebabName}}.create.dto.ts',
    },
    {
      template: './templates/dto/update.dto.ts.ejs',
      path: 'models/{{kebabName}}.update.dto.ts',
    },
    {
      template: './templates/dto/read.dto.ts.ejs',
      path: 'models/{{kebabName}}.read.dto.ts',
    },
  ],
};

const CREATE_TEMPLATE =
  'export interface <%= className %>CreateDTO { /* create */ }\n';
const UPDATE_TEMPLATE =
  'export interface <%= className %>UpdateDTO { /* update */ }\n';
const READ_TEMPLATE =
  'export interface <%= className %>ReadDTO { /* read */ }\n';

function seedFixture(root: string, config: LoopbackConfigJson): void {
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});
  mkdirSync(join(root, 'emitters'), {recursive: true});
  mkdirSync(join(root, 'templates', 'dto'), {recursive: true});

  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'schemas', 'customer.schema.json'),
    JSON.stringify(CUSTOMER_SCHEMA, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'configs', 'customer.config.json'),
    JSON.stringify(CUSTOMER_CONFIG, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify(DATASOURCES, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify(TSCONFIG, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'emitters', 'dto.emitter.json'),
    JSON.stringify(DTO_MANIFEST, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'templates', 'dto', 'create.dto.ts.ejs'),
    CREATE_TEMPLATE,
    'utf8',
  );
  writeFileSync(
    join(root, 'templates', 'dto', 'update.dto.ts.ejs'),
    UPDATE_TEMPLATE,
    'utf8',
  );
  writeFileSync(
    join(root, 'templates', 'dto', 'read.dto.ts.ejs'),
    READ_TEMPLATE,
    'utf8',
  );
}

beforeAll(() => {
  seedFixture(ROOT, CONFIG);
  seedFixture(ROOT_DISABLED, CONFIG_DISABLED);
});

afterAll(() => {
  rmSync(ROOT, {recursive: true, force: true});
  rmSync(ROOT_DISABLED, {recursive: true, force: true});
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

describe('Manifest emitter with plural outputs[]', () => {
  it('writes one file per outputs[] entry for each matched schema in one pipeline run', async () => {
    const app = await bootstrap(ROOT, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      const result = await pipeline.run({
        projectRoot: ROOT,
        config: {...CONFIG, schemas: [join(ROOT, 'schemas')]},
        emitFlags: {dto: true},
        skipTsc: true,
      });

      // Three outputs[] entries x one schema = three files, plus whatever
      // the engine writes from validation stages (meta-schemas). The
      // manifest path is the only contributor of DTO files.
      const written = result.filesWritten.map(p => p.replace(/\\/g, '/'));
      expect(
        written.some(p => p.endsWith('models/customer.create.dto.ts')),
      ).toBe(true);
      expect(
        written.some(p => p.endsWith('models/customer.update.dto.ts')),
      ).toBe(true);
      expect(written.some(p => p.endsWith('models/customer.read.dto.ts'))).toBe(
        true,
      );

      // File contents carry the expected interface stubs — one line per
      // template, the EJS view-model resolved `className` to `Customer`.
      const createDto = readFileSync(
        join(ROOT, 'src', 'models', 'customer.create.dto.ts'),
        'utf8',
      );
      expect(createDto).toContain(
        'export interface CustomerCreateDTO { /* create */ }',
      );

      const updateDto = readFileSync(
        join(ROOT, 'src', 'models', 'customer.update.dto.ts'),
        'utf8',
      );
      expect(updateDto).toContain(
        'export interface CustomerUpdateDTO { /* update */ }',
      );

      const readDto = readFileSync(
        join(ROOT, 'src', 'models', 'customer.read.dto.ts'),
        'utf8',
      );
      expect(readDto).toContain(
        'export interface CustomerReadDTO { /* read */ }',
      );

      // All three files share `producer: 'manifest:dto'`. The pipeline
      // result does not expose producer metadata, so re-run the
      // EmitterRunner directly against the same registry to inspect the
      // raw EmittedFile[] before FileWriter strips the field.
      const runner = await app.get<EmitterRunner>(
        ContractsEngineBindings.EMITTER_RUNNER,
      );
      const registry = await app.get<SchemaRegistry>(
        ContractsBindings.SCHEMA_REGISTRY,
      );
      const emitted: readonly EmittedFile[] = await runner.run(
        registry.list(),
        {dto: true},
      );
      const dtoFiles = emitted.filter(f => f.path.endsWith('.dto.ts'));
      expect(dtoFiles).toHaveLength(3);
      for (const file of dtoFiles) {
        expect(file.producer).toBe('manifest:dto');
      }

      // Manifest path is meant to skip lossy reporting. Filter to just
      // the DTO contributor so a stray validation-stage warning from an
      // unrelated subsystem does not flake this assertion.
      const dtoLossy = result.lossy.filter(
        r => r.feature === 'dto' || r.feature === 'manifest:dto',
      );
      expect(dtoLossy).toHaveLength(0);
    } finally {
      await app.stop();
    }
  }, 60_000);

  it('writes nothing when emit.dto is unset, even though the manifest is discovered', async () => {
    const app = await bootstrap(ROOT_DISABLED, CONFIG_DISABLED);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      const result = await pipeline.run({
        projectRoot: ROOT_DISABLED,
        config: {
          ...CONFIG_DISABLED,
          schemas: [join(ROOT_DISABLED, 'schemas')],
        },
        emitFlags: {},
        skipTsc: true,
      });

      // The booter still binds the manifest emitter (validation passes,
      // meta-schemas are written) — but `findEnabled({})` excludes every
      // emitter whose `kind` flag is not true. No DTO files land on disk.
      const written = result.filesWritten.map(p => p.replace(/\\/g, '/'));
      expect(written.some(p => p.includes('.create.dto.ts'))).toBe(false);
      expect(written.some(p => p.includes('.update.dto.ts'))).toBe(false);
      expect(written.some(p => p.includes('.read.dto.ts'))).toBe(false);

      expect(
        existsSync(
          join(ROOT_DISABLED, 'src', 'models', 'customer.create.dto.ts'),
        ),
      ).toBe(false);
      expect(
        existsSync(
          join(ROOT_DISABLED, 'src', 'models', 'customer.update.dto.ts'),
        ),
      ).toBe(false);
      expect(
        existsSync(
          join(ROOT_DISABLED, 'src', 'models', 'customer.read.dto.ts'),
        ),
      ).toBe(false);
    } finally {
      await app.stop();
    }
  }, 60_000);
});
