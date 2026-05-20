// Integration coverage for the two `security.*` gates wired through the
// pipeline in this wave:
//
//   1. `security.codegen.runTsc = false` — stage 8 (`tsc --noEmit`) is
//      skipped without touching the CLI's `--skip-tsc` flag, even when a
//      real `tsconfig.json` is present in the project root.
//   2. `security.emitters.allowProjectManifests = false` — the
//      `ManifestEmitterBooter` does NOT register any project-local
//      `<projectRoot>/emitters/*.emitter.json` (built-in manifests still
//      load — they're part of the plugin's trusted surface).
//
// Both gates are no-ops when the `security` block is absent (back-compat).
// The existing pipeline-end-to-end spec already covers the default path;
// this spec exercises the explicit opt-out side.

import {Application, BindingScope} from '@loopback/core';
import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ContractsComponent} from '../../contracts.component';
import {
  DefaultProjectPaths,
  EjsTemplateEngine,
  EmitterRegistry,
  EmitterRunner,
  FileWriter,
  InMemoryLossyReporter,
  InMemorySchemaRegistry,
  ManifestEmitterBooter,
  Pipeline,
  RelativeImportMap,
  SourceResolverRegistry,
} from '../../engine';
import {ContractsEngineBindings} from '../../engine/tokens';
import type {ImportMap, SchemaRegistry} from '../../interfaces';
import {ContractsBindings, EMITTER_TAG} from '../../keys';
import {
  GitSchemaSource,
  HttpSchemaSource,
  LocalSchemaSource,
  NpmSchemaSource,
} from '../../sources';
import type {LoopbackConfigJson} from '../../types';

function makeRoot(label: string): string {
  const root = join(
    tmpdir(),
    `lb-contracts-security-${label}-${randomBytes(6).toString('hex')}`,
  );
  mkdirSync(root, {recursive: true});
  return root;
}

function seedMinimalProject(root: string, config: LoopbackConfigJson): void {
  mkdirSync(join(root, 'schemas'), {recursive: true});
  mkdirSync(join(root, 'configs'), {recursive: true});
  writeFileSync(
    join(root, 'loopback.config.json'),
    JSON.stringify(config, null, 2),
    'utf8',
  );
  writeFileSync(
    join(root, 'schemas', 'widget.schema.json'),
    JSON.stringify(
      {
        $id: 'widget.v1',
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          id: {type: 'string'},
          name: {type: 'string'},
        },
        required: ['id'],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(root, 'configs', 'widget.config.json'),
    JSON.stringify(
      {
        $schema: '../_meta/model-config.schema.json',
        $contractId: 'widget.v1',
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
    join(root, 'datasources.json'),
    JSON.stringify([{name: 'mem', adapter: 'memory', config: {}}], null, 2),
    'utf8',
  );
  // A `tsconfig.json` is intentionally present so the test proves the
  // gate fires irrespective of `existsSync(tsconfig)` — without the gate,
  // stage 8 would attempt to spawn `npx tsc` against the fixture root.
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

async function bootstrapPipeline(
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

describe('security.codegen.runTsc = false skips stage 8', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('runtsc');
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
  });

  it('reports tscOk=true without spawning tsc when runTsc is false', async () => {
    const config: LoopbackConfigJson = {
      name: 'security-runtsc-test',
      schemasDir: './schemas',
      configsDir: './configs',
      validator: 'ajv',
      schemas: [],
      emit: {},
      security: {codegen: {runTsc: false}},
    };
    seedMinimalProject(root, config);

    const app = await bootstrapPipeline(root, config);
    try {
      const pipeline = await app.get<Pipeline>(
        ContractsEngineBindings.PIPELINE,
      );
      // `skipTsc` deliberately omitted — proves the config-side gate
      // works on its own. Without the gate, stage 8 would invoke
      // `npx tsc --noEmit` against the fixture root (the test bootstrap
      // does not seed `node_modules`, so a non-gated run would fail
      // loud with a `tsc not found` style error from execFile).
      const result = await pipeline.run({
        projectRoot: root,
        config: {...config, schemas: [join(root, 'schemas')]},
        emitFlags: {},
      });

      expect(result.stagesRun).toBe(8);
      expect(result.tscOk).toBe(true);
    } finally {
      await app.stop();
    }
  });
});

describe('security.emitters.allowProjectManifests = false skips project scan', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('manifests');
    // Seed a project-local emitter manifest the booter would normally
    // register on start(). The `kind` is intentionally distinctive so
    // the test can prove its absence rather than just count bindings.
    const emittersDir = join(root, 'emitters');
    mkdirSync(emittersDir, {recursive: true});
    writeFileSync(
      join(emittersDir, 'audit.emitter.json'),
      JSON.stringify({
        kind: 'project-audit-fixture',
        tier: 'convenience',
        description: 'fixture for security gate test',
        template: './audit.ejs',
        outputSuffix: '.audit.ts',
      }),
      'utf8',
    );
    writeFileSync(
      join(emittersDir, 'audit.ejs'),
      '// fixture audit template',
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
  });

  it('does not register the project-local manifest when the gate is off', async () => {
    const app = new Application();
    app.bind(ContractsBindings.CONFIG).to({
      name: 'manifest-gate-test',
      schemasDir: './schemas',
      configsDir: './configs',
      validator: 'ajv',
      schemas: [],
      emit: {},
      security: {emitters: {allowProjectManifests: false}},
    } satisfies LoopbackConfigJson);
    const booter = new ManifestEmitterBooter(
      app,
      root,
      await app.get<LoopbackConfigJson>(ContractsBindings.CONFIG),
    );
    await booter.start();
    try {
      const projectManifestKey =
        'platform.contracts.emitters.manifest.project-audit-fixture';
      const bindings = app
        .findByTag(EMITTER_TAG)
        .map(b => b.key)
        .filter(k => k === projectManifestKey);
      expect(bindings).toEqual([]);
    } finally {
      await booter.stop();
    }
  });

  it('registers the project-local manifest when the gate is on (default)', async () => {
    // Mirror the inverse: same fixture, no `security` block in the
    // config — the booter falls back to its back-compat default and the
    // manifest registers as it would for any existing project.
    const app = new Application();
    app.bind(ContractsBindings.CONFIG).to({
      name: 'manifest-gate-default-test',
      schemasDir: './schemas',
      configsDir: './configs',
      validator: 'ajv',
      schemas: [],
      emit: {},
    } satisfies LoopbackConfigJson);
    const booter = new ManifestEmitterBooter(
      app,
      root,
      await app.get<LoopbackConfigJson>(ContractsBindings.CONFIG),
    );
    await booter.start();
    try {
      const projectManifestKey =
        'platform.contracts.emitters.manifest.project-audit-fixture';
      const bindings = app
        .findByTag(EMITTER_TAG)
        .map(b => b.key)
        .filter(k => k === projectManifestKey);
      expect(bindings).toEqual([projectManifestKey]);
    } finally {
      await booter.stop();
    }
  });
});
