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
// Datasource validation fixtures: cover the three cases the pipeline must
// reject at stage 5 instead of silently dropping the user into a confusing
// stage-8 tsc error.
//   1. Config references a datasource but datasources.json doesn't exist.
//   2. Config references a typo'd datasource name (e.g. 'primry') when
//      a real one ('primary') is declared.
//   3. datasources.json uses the keyed-map layout (the preferred form
//      `lb4 ds` writes); the loader must populate the meta-schema enum
//      from this layout, not just the array form.
const ROOT_DS_MISSING = join(
  tmpdir(),
  `lb4-idiom-ds-missing-${randomBytes(8).toString('hex')}`,
);
const ROOT_DS_TYPO = join(
  tmpdir(),
  `lb4-idiom-ds-typo-${randomBytes(8).toString('hex')}`,
);
const ROOT_DS_KEYED_MAP = join(
  tmpdir(),
  `lb4-idiom-ds-keyed-map-${randomBytes(8).toString('hex')}`,
);
// PR-C follow-up fixtures: a datasources-only project (no schemas) and a
// 5-schema project (no configs) for the per-project single-fire check.
const ROOT_DATASOURCES_ONLY = join(
  tmpdir(),
  `lb4-idiom-datasources-only-${randomBytes(8).toString('hex')}`,
);
const ROOT_FIVE_SCHEMAS = join(
  tmpdir(),
  `lb4-idiom-five-schemas-${randomBytes(8).toString('hex')}`,
);
// Cycle-3 fix fixture: schema + inline `config-bindings` entry in
// `loopback.config.json`, NO `configs/<name>.config.json` on disk. Proves
// the inline branch of stage 5 populates `ConfigRegistry` so the
// lb4-idiom emitters fire end-to-end through `pipeline.run()`.
const ROOT_INLINE_BINDINGS = join(
  tmpdir(),
  `lb4-idiom-inline-bindings-${randomBytes(8).toString('hex')}`,
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

// Seeder for the datasources-only fixture: no schemas, no configs, just a
// valid `datasources.json`. Verifies the per-project synthetic-schema
// fallback in `EmitterRunner` (the `EMPTY_PROJECT_SCHEMA` guard at
// `emitter-runner.ts`) is wired end-to-end through the pipeline.
function seedDatasourcesOnlyFixture(root: string): void {
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});

  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify(CONFIG, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify(DATASOURCES, null, 2),
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

// Seeder for the 5-schema fixture: five distinct schemas + valid
// `datasources.json`, but no `configs/` entries. The per-project
// `DatasourceGenerator` must fire exactly once across the five schemas
// (it would have fired five times under the pre-PR-C per-schema scope and
// tripped `FileWriter`'s same-path collision check).
function seedFiveSchemasFixture(root: string): void {
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});

  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify(CONFIG, null, 2),
    'utf8',
  );
  for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
    writeFileSync(
      join(root, 'schemas', `${name}.schema.json`),
      JSON.stringify(
        {
          $id: `${name}.v1`,
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {id: {type: 'string'}},
          required: ['id'],
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify(DATASOURCES, null, 2),
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

// Seeder for the inline-bindings fixture: a schema + inline
// `config-bindings` entry inside `loopback.config.json` instead of a
// `configs/person.config.json` sidecar. The inline entry mirrors the
// same `ModelConfigJson` shape stage 5 validates from disk, so this
// fixture exercises the cycle-3 fix that ALSO routes inline entries into
// `ConfigRegistry`. `datasources.json` is still on disk so the
// `dataSource: 'mem'` reference passes meta-schema validation.
function seedInlineBindingsFixture(root: string): void {
  mkdirSync(join(root, 'schemas'), {recursive: true});

  const inlineConfig: LoopbackConfigJson = {
    ...CONFIG,
    'config-bindings': [PERSON_CONFIG],
  };

  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify(inlineConfig, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'schemas', 'person.schema.json'),
    JSON.stringify(PERSON_SCHEMA, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify(DATASOURCES, null, 2),
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
  seedDatasourcesOnlyFixture(ROOT_DATASOURCES_ONLY);
  seedFiveSchemasFixture(ROOT_FIVE_SCHEMAS);
  seedInlineBindingsFixture(ROOT_INLINE_BINDINGS);
  seedDsMissingFixture(ROOT_DS_MISSING);
  seedDsTypoFixture(ROOT_DS_TYPO);
  seedDsKeyedMapFixture(ROOT_DS_KEYED_MAP);
});

afterAll(() => {
  rmSync(ROOT_WITH_CONFIG, {recursive: true, force: true});
  rmSync(ROOT_NO_CONFIG, {recursive: true, force: true});
  rmSync(ROOT_DATASOURCES_ONLY, {recursive: true, force: true});
  rmSync(ROOT_FIVE_SCHEMAS, {recursive: true, force: true});
  rmSync(ROOT_INLINE_BINDINGS, {recursive: true, force: true});
  rmSync(ROOT_DS_MISSING, {recursive: true, force: true});
  rmSync(ROOT_DS_TYPO, {recursive: true, force: true});
  rmSync(ROOT_DS_KEYED_MAP, {recursive: true, force: true});
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

describe('LB4-idiom emitter path — edge cases (PR-C follow-up)', () => {
  // Scenario (a): a project with NO schemas and NO configs, but a valid
  // `datasources.json`. The per-project `DatasourceGenerator` must still
  // fire — the runner falls back to `EMPTY_PROJECT_SCHEMA` when the
  // registry is empty (`emitter-runner.ts`) so `outputScope:
  // 'per-project'` emitters get exactly one invocation.
  it('emits datasource files for a datasources-only project (no schemas)', async () => {
    const app = await bootstrap(ROOT_DATASOURCES_ONLY, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      const result = await pipeline.run({
        projectRoot: ROOT_DATASOURCES_ONLY,
        config: {
          ...CONFIG,
          schemas: [join(ROOT_DATASOURCES_ONLY, 'schemas')],
        },
        emitFlags: {datasource: true},
        skipTsc: true,
      });

      const written = result.filesWritten.map(p => p.replace(/\\/g, '/'));

      expect(
        written.some(p => p.endsWith('datasources/mem.base.datasource.ts')),
      ).toBe(true);
    } finally {
      await app.stop();
    }
  });

  // Scenario (c): per-project emitter fires exactly once on a 5-schema
  // project. Under the pre-PR-C per-schema scope this would have produced
  // 5 copies of `mem.base.datasource.ts` and tripped `FileWriter`'s
  // collision guard; under the current scope exactly one descriptor
  // lands.
  it('per-project DatasourceGenerator emits exactly one datasource file on a 5-schema project', async () => {
    const app = await bootstrap(ROOT_FIVE_SCHEMAS, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      const result = await pipeline.run({
        projectRoot: ROOT_FIVE_SCHEMAS,
        config: {...CONFIG, schemas: [join(ROOT_FIVE_SCHEMAS, 'schemas')]},
        emitFlags: {datasource: true},
        skipTsc: true,
      });

      const written = result.filesWritten.map(p => p.replace(/\\/g, '/'));
      const datasourceBases = written.filter(p =>
        p.endsWith('datasources/mem.base.datasource.ts'),
      );

      expect(datasourceBases).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });

  // Cycle-3 regression: inline `config-bindings` entries in
  // `loopback.config.json` must populate `ConfigRegistry` so the
  // lb4-idiom emitters (model/repository/controller) fire — the same as
  // the on-disk `configs/<name>.config.json` path. Before the cycle-3
  // fix, stage 5 only loaded disk-config files into the registry, so a
  // project that authored its bindings inline saw zero lb4-idiom output.
  // This scenario writes NO `configs/` directory; the lb4-idiom files
  // appearing in `result.filesWritten` prove the inline path is wired
  // end-to-end through `pipeline.run()`.
  it('routes lb4-idiom emitters through inline config-bindings (no configs/ directory)', async () => {
    const inlineConfig: LoopbackConfigJson = {
      ...CONFIG,
      'config-bindings': [PERSON_CONFIG],
    };
    const app = await bootstrap(ROOT_INLINE_BINDINGS, inlineConfig);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      const result = await pipeline.run({
        projectRoot: ROOT_INLINE_BINDINGS,
        config: {
          ...inlineConfig,
          schemas: [join(ROOT_INLINE_BINDINGS, 'schemas')],
        },
        emitFlags: {model: true, repository: true, controller: true},
        skipTsc: true,
      });

      const written = result.filesWritten.map(p => p.replace(/\\/g, '/'));

      expect(written.some(p => p.endsWith('models/person.base.model.ts'))).toBe(
        true,
      );
      expect(
        written.some(p => p.endsWith('repositories/person.base.repository.ts')),
      ).toBe(true);
      expect(
        written.some(p => p.endsWith('controllers/person.base.controller.ts')),
      ).toBe(true);
    } finally {
      await app.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Datasource cross-validation: stage 5 must catch "config references a
// datasource that isn't declared in datasources.json" with a clear error,
// rather than silently passing and dumping the user into a confusing
// stage-8 tsc error pointing at a generated repository import. Covers
// both layouts of datasources.json so a future loader regression on the
// keyed-map form is also caught here.
// ---------------------------------------------------------------------------

function seedDsMissingFixture(root: string): void {
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
  writeFileSync(
    join(root, 'configs', 'person.config.json'),
    JSON.stringify(PERSON_CONFIG, null, 2),
    'utf8',
  );
  // Deliberately NO datasources.json — the cross-validation must reject
  // PERSON_CONFIG's `dataSource: 'mem'` reference and the hint must
  // suggest `lb-contracts ds mem --adapter <kind>`.
}

function seedDsTypoFixture(root: string): void {
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
  // Config references 'primry' (typo of 'primary'); datasources.json
  // declares only 'primary'. The error message must name the typo AND
  // list the available alternatives.
  writeFileSync(
    join(root, 'configs', 'person.config.json'),
    JSON.stringify({...PERSON_CONFIG, dataSource: 'primry'}, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify([{name: 'primary', adapter: 'memory', config: {}}], null, 2),
    'utf8',
  );
}

function seedDsKeyedMapFixture(root: string): void {
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
  writeFileSync(
    join(root, 'configs', 'person.config.json'),
    JSON.stringify(PERSON_CONFIG, null, 2),
    'utf8',
  );
  // Keyed-map layout (preferred form `lb4 ds` writes). The loader must
  // recognise this AND populate the meta-schema enum from it; the array
  // form is already covered by the other fixtures.
  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify(
      {
        $schema: '../_meta/datasources.schema.json',
        mem: {adapter: 'memory', config: {}},
      },
      null,
      2,
    ),
    'utf8',
  );
}

describe('LB4-idiom emitter path — datasource cross-validation', () => {
  it('rejects a config that references a datasource missing from datasources.json', async () => {
    const app = await bootstrap(ROOT_DS_MISSING, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      await expect(
        pipeline.run({
          projectRoot: ROOT_DS_MISSING,
          config: {...CONFIG, schemas: [join(ROOT_DS_MISSING, 'schemas')]},
          emitFlags: {model: true, repository: true},
          skipTsc: true,
        }),
      ).rejects.toThrow(/datasource 'mem' which is not declared/);

      // Hint must guide the user to the actual fix.
      await expect(
        pipeline.run({
          projectRoot: ROOT_DS_MISSING,
          config: {...CONFIG, schemas: [join(ROOT_DS_MISSING, 'schemas')]},
          emitFlags: {model: true, repository: true},
          skipTsc: true,
        }),
      ).rejects.toThrow(/lb-contracts ds mem/);
    } finally {
      await app.stop();
    }
  });

  it("rejects a typo'd datasource name at the meta-schema enum step", async () => {
    const app = await bootstrap(ROOT_DS_TYPO, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      // When `datasources.json` IS present and non-empty,
      // `buildModelConfigMetaSchema()` populates the `dataSource` enum
      // with the declared names. Ajv rejects the typo at meta-schema
      // validation, BEFORE the cross-validation cross-check fires.
      // The cross-check is the safety net for the "no datasources.json
      // at all" path tested separately above.
      await expect(
        pipeline.run({
          projectRoot: ROOT_DS_TYPO,
          config: {...CONFIG, schemas: [join(ROOT_DS_TYPO, 'schemas')]},
          emitFlags: {model: true, repository: true},
          skipTsc: true,
        }),
      ).rejects.toThrow(/failed meta-schema validation/);

      await expect(
        pipeline.run({
          projectRoot: ROOT_DS_TYPO,
          config: {...CONFIG, schemas: [join(ROOT_DS_TYPO, 'schemas')]},
          emitFlags: {model: true, repository: true},
          skipTsc: true,
        }),
      ).rejects.toThrow(/\/dataSource must be equal to one of the allowed/);
    } finally {
      await app.stop();
    }
  });

  it('accepts a config when datasources.json uses the keyed-map layout', async () => {
    const app = await bootstrap(ROOT_DS_KEYED_MAP, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      // Should NOT throw — the keyed-map loader must surface 'mem' in
      // the cross-validation set so PERSON_CONFIG's reference resolves.
      const result = await pipeline.run({
        projectRoot: ROOT_DS_KEYED_MAP,
        config: {...CONFIG, schemas: [join(ROOT_DS_KEYED_MAP, 'schemas')]},
        emitFlags: {model: true, repository: true, datasource: true},
        skipTsc: true,
      });

      const written = result.filesWritten.map(p => p.replace(/\\/g, '/'));
      expect(
        written.some(p => p.endsWith('datasources/mem.base.datasource.ts')),
      ).toBe(true);
      expect(written.some(p => p.endsWith('models/person.base.model.ts'))).toBe(
        true,
      );
    } finally {
      await app.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Structural validation of `datasources.json` itself — duplicate names,
// empty keys, malformed-but-valid-JSON top-level shapes. The pipeline must
// reject these at stage 5 with a clear error rather than silently dropping
// (or worse, deterministically picking the last duplicate) and surprising
// the user downstream.
// ---------------------------------------------------------------------------

const ROOT_DS_DUPLICATE = join(
  tmpdir(),
  `lb4-idiom-ds-duplicate-${randomBytes(8).toString('hex')}`,
);
const ROOT_DS_EMPTY_KEY = join(
  tmpdir(),
  `lb4-idiom-ds-empty-key-${randomBytes(8).toString('hex')}`,
);
const ROOT_DS_ALL_FILTERED = join(
  tmpdir(),
  `lb4-idiom-ds-all-filtered-${randomBytes(8).toString('hex')}`,
);

function seedDsDuplicateFixture(root: string): void {
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
  writeFileSync(
    join(root, 'configs', 'person.config.json'),
    JSON.stringify(PERSON_CONFIG, null, 2),
    'utf8',
  );
  // Two entries with the same `name` — must be rejected, not silently
  // de-duped to the last writer.
  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify(
      [
        {name: 'mem', adapter: 'memory', config: {}},
        {name: 'mem', adapter: 'mongodb', config: {url: 'mongodb://x'}},
      ],
      null,
      2,
    ),
    'utf8',
  );
}

function seedDsEmptyKeyFixture(root: string): void {
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
  writeFileSync(
    join(root, 'configs', 'person.config.json'),
    JSON.stringify(PERSON_CONFIG, null, 2),
    'utf8',
  );
  // Whitespace-only map key — would generate a file named `   .base
  // .datasource.ts` if accepted. Loader must reject.
  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify({'   ': {adapter: 'memory', config: {}}}, null, 2),
    'utf8',
  );
}

function seedDsAllFilteredFixture(root: string): void {
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
  writeFileSync(
    join(root, 'configs', 'person.config.json'),
    JSON.stringify(PERSON_CONFIG, null, 2),
    'utf8',
  );
  // Array entry missing the required `name` field — loader rejects
  // the malformed entry with a typed error, not a silent skip that
  // would leave the user wondering why their datasource was ignored.
  writeFileSync(
    join(root, 'datasources.json'),
    JSON.stringify([{adapter: 'memory', config: {}}], null, 2),
    'utf8',
  );
}

describe('LB4-idiom emitter path — datasources.json structural validation', () => {
  beforeAll(() => {
    seedDsDuplicateFixture(ROOT_DS_DUPLICATE);
    seedDsEmptyKeyFixture(ROOT_DS_EMPTY_KEY);
    seedDsAllFilteredFixture(ROOT_DS_ALL_FILTERED);
  });

  afterAll(() => {
    rmSync(ROOT_DS_DUPLICATE, {recursive: true, force: true});
    rmSync(ROOT_DS_EMPTY_KEY, {recursive: true, force: true});
    rmSync(ROOT_DS_ALL_FILTERED, {recursive: true, force: true});
  });

  it('rejects datasources.json with a duplicate name (was silently de-duped before)', async () => {
    const app = await bootstrap(ROOT_DS_DUPLICATE, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      await expect(
        pipeline.run({
          projectRoot: ROOT_DS_DUPLICATE,
          config: {...CONFIG, schemas: [join(ROOT_DS_DUPLICATE, 'schemas')]},
          emitFlags: {model: true},
          skipTsc: true,
        }),
      ).rejects.toThrow(/duplicate datasource name 'mem'/);
    } finally {
      await app.stop();
    }
  });

  it('rejects a keyed-map datasources.json with a whitespace-only key', async () => {
    const app = await bootstrap(ROOT_DS_EMPTY_KEY, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      await expect(
        pipeline.run({
          projectRoot: ROOT_DS_EMPTY_KEY,
          config: {...CONFIG, schemas: [join(ROOT_DS_EMPTY_KEY, 'schemas')]},
          emitFlags: {model: true},
          skipTsc: true,
        }),
      ).rejects.toThrow(/keyed-map contains an empty key/);
    } finally {
      await app.stop();
    }
  });

  it("rejects an array entry missing the required 'name' field (no silent drop)", async () => {
    const app = await bootstrap(ROOT_DS_ALL_FILTERED, CONFIG);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );

      await expect(
        pipeline.run({
          projectRoot: ROOT_DS_ALL_FILTERED,
          config: {
            ...CONFIG,
            schemas: [join(ROOT_DS_ALL_FILTERED, 'schemas')],
          },
          emitFlags: {model: true},
          skipTsc: true,
        }),
        // Post-Wave-2: the new datasources.json meta-schema validation
        // (buildDatasourcesMetaSchema with oneOf array+keyed-map) catches
        // the missing `name` field BEFORE the parser-level normalisation
        // runs. The error message now comes from Ajv via formatAjvErrors
        // instead of the parser's hand-written "missing required string
        // field" diagnostic — both reject the same input, the wording
        // just shifted to the canonical layer.
      ).rejects.toThrow(/required property 'name'/);
    } finally {
      await app.stop();
    }
  });
});
