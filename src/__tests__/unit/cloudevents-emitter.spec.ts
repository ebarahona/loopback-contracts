import {Application, BindingScope} from '@loopback/core';
import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {ContractsComponent} from '../../contracts.component';
import {EjsTemplateEngine, ManifestBackedEmitter} from '../../engine';
import type {EmitterRegistry} from '../../engine';
import {ContractsEngineBindings} from '../../engine/tokens';
import {ContractsBindings} from '../../keys';
import type {
  EmitterContext,
  JSONSchema,
  ProjectionEmitter,
} from '../../interfaces';

const FIXTURE_WITH_X: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    id: {type: 'string'},
    name: {type: 'string'},
  },
  required: ['id'],
  'x-cloudevents': {type: 'com.example.user.created'},
};

const FIXTURE_WITHOUT_X: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    id: {type: 'string'},
    name: {type: 'string'},
  },
  required: ['id'],
};

// Throw-away project root for the booter — the cloudevents emitter is a
// built-in (under `src/emitters/manifest/cloudevents/`) so the booter
// discovers it without any project-local files. The directory exists only
// so listManifestFiles() does not short-circuit when it stat()'s the
// (absent) `<root>/emitters/` dir.
const PROJECT_ROOT = resolve(
  tmpdir(),
  `lb-contracts-ce-${randomBytes(6).toString('hex')}`,
);

// Template engine roots at `src/` so the same tree that owns the manifest
// templates is what EJS reads at runtime — mirrors the prod wiring (the
// build-time copy-templates.mjs lifts these into `dist/`).
const TEMPLATE_ROOT = resolve(__dirname, '..', '..');
const REAL_ENGINE = new EjsTemplateEngine(TEMPLATE_ROOT);

let app: Application;
let emitter: ProjectionEmitter;

beforeAll(async () => {
  mkdirSync(PROJECT_ROOT, {recursive: true});

  app = new Application();
  app.bind('platform.contracts.project-root').to(PROJECT_ROOT);
  app
    .bind(ContractsBindings.TEMPLATE_ENGINE)
    .to(REAL_ENGINE)
    .inScope(BindingScope.SINGLETON);
  app.component(ContractsComponent);
  await app.start();

  const registry = await app.get<EmitterRegistry>(
    ContractsEngineBindings.EMITTER_REGISTRY,
  );
  const found = await registry.byKind('cloudevents');
  if (found === undefined) {
    throw new Error(
      'cloudevents manifest emitter did not register; ' +
        'check ManifestEmitterBooter discovery of built-ins',
    );
  }
  emitter = found;
  await REAL_ENGINE.preload(emitter.templatePaths ?? []);
});

afterAll(async () => {
  await app.stop();
  rmSync(PROJECT_ROOT, {recursive: true, force: true});
});

function buildContext(schema: JSONSchema): EmitterContext {
  return {
    schema,
    registry: {get: () => undefined, list: () => [], has: () => false},
    importMap: {resolve: id => './' + id},
    templates: REAL_ENGINE,
    paths: {
      root: '/tmp/contracts-test',
      outputDir: '/tmp/contracts-test/src',
      schemasDir: '/tmp/contracts-test/schemas',
      configsDir: '/tmp/contracts-test/configs',
    },
    lossy: {report: () => {}, entries: () => []},
  };
}

describe('cloudevents manifest emitter', () => {
  it('is discovered as a built-in manifest emitter via ManifestEmitterBooter', () => {
    // The registry-resolved emitter is a ManifestBackedEmitter — proves the
    // built-in went through the manifest path, not a code-emitter class.
    expect(emitter).toBeInstanceOf(ManifestBackedEmitter);
    expect(emitter.kind).toBe('cloudevents');
    expect(emitter.tier).toBe('real-translation');
    expect(emitter.description).toContain('CloudEvent');
    expect(emitter.peerDeps).toEqual(['cloudevents']);
  });

  it('emits CloudEvent<User> wrapper + factory when x-cloudevents is set', async () => {
    const files = await emitter.emit(buildContext(FIXTURE_WITH_X));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user.cloudevents.ts');
    expect(file.policy).toBe('regen');
    // ManifestBackedEmitter tags every output with `manifest:<kind>` —
    // distinguishes manifest-path contributions from the old code-emitter
    // path in audit trails and pipeline reports.
    expect(file.producer).toBe('manifest:cloudevents');
    expect(file.content).toContain("import {CloudEvent} from 'cloudevents';");
    expect(file.content).toContain('CloudEvent<User>');
    expect(file.content).toContain('com.example.user.created');
    expect(file.content).toContain('export function createUserEvent');
    expect(file.content).toContain('UserEventInit');
    expect(file.content).toContain("specversion: '1.0'");
  });

  it('returns [] when the schema has no x-cloudevents block (optIn semantics)', async () => {
    // `optIn: true` in the manifest means schemas without the keyed options
    // block are silently skipped — matches the old code emitter's behaviour
    // and prevents Ajv from raising a misleading "missing required `type`"
    // error against schemas that simply opted out.
    const files = await emitter.emit(buildContext(FIXTURE_WITHOUT_X));
    expect(files).toEqual([]);
  });
});
