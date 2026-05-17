import {Application} from '@loopback/core';
import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {parse as parseYaml} from 'yaml';
import {
  EjsTemplateEngine,
  ManifestBackedEmitter,
  ManifestEmitterBooter,
} from '../../engine';
import {EMITTER_TAG} from '../../keys';
import type {
  EmitterContext,
  JSONSchema,
  ProjectionEmitter,
} from '../../interfaces';

const FIXTURE: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    name: {type: 'string'},
    age: {type: 'integer'},
  },
  required: ['name'],
};

// Throw-away project root. The booter scans `<projectRoot>/emitters/` for
// project-local manifests; we leave that empty so only the plugin's
// built-in manifests (discovered under `<plugin-dist>/emitters/manifest/`)
// register — which is the path under test.
const PROJECT_ROOT = resolve(
  tmpdir(),
  `lb-contracts-oas-${randomBytes(6).toString('hex')}`,
);

// Template engine roots at `src/` so the EJS templates resolved by the
// booter (absolute paths under `src/emitters/manifest/openapi-components/
// templates/`) are reachable by the engine's relative-path resolution.
// `EjsTemplateEngine` accepts an absolute template path verbatim, so the
// root only matters for `render(relativePath, ...)` callers — here we hand
// it the path the booter resolved.
const TEMPLATE_ROOT = resolve(__dirname, '..', '..');
const REAL_ENGINE = new EjsTemplateEngine(TEMPLATE_ROOT);

let app: Application;
let booter: ManifestEmitterBooter;
let emitter: ProjectionEmitter;

beforeAll(async () => {
  mkdirSync(PROJECT_ROOT, {recursive: true});

  // Construct the booter directly rather than booting the full
  // ContractsComponent, so this spec stays independent of unrelated
  // built-in emitter bindings that may be in flux in sibling waves.
  app = new Application();
  booter = new ManifestEmitterBooter(app, PROJECT_ROOT);
  await booter.start();

  // The booter binds every discovered manifest under EMITTER_TAG with a
  // `kind` tag. Look up the openapi-components binding by tag and resolve
  // it through the LB4 context so the dynamicValue factory runs.
  const bindings = app.findByTag({
    [EMITTER_TAG]: EMITTER_TAG,
    kind: 'openapi-components',
  });
  if (bindings.length === 0) {
    throw new Error(
      'openapi-components manifest emitter did not register; ' +
        'check ManifestEmitterBooter discovery of built-ins',
    );
  }
  const first = bindings[0];
  if (first === undefined) {
    throw new Error('unreachable: bindings array empty after length check');
  }
  emitter = await app.get<ProjectionEmitter>(first.key);
  await REAL_ENGINE.preload(emitter.templatePaths ?? []);
});

afterAll(async () => {
  await booter.stop();
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

describe('openapi-components manifest emitter', () => {
  it('is discovered as a built-in manifest emitter via ManifestEmitterBooter', () => {
    // The registry-resolved emitter is a ManifestBackedEmitter — proves the
    // built-in went through the manifest path, not a code-emitter class.
    expect(emitter).toBeInstanceOf(ManifestBackedEmitter);
    expect(emitter.kind).toBe('openapi-components');
    expect(emitter.tier).toBe('convenience');
    expect(emitter.description).toContain('OAS 3.x');
  });

  it('projects a minimal user schema into an OAS components fragment', async () => {
    const files = await emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    // The manifest path interpolates `{{kebabName}}` against the schema
    // `$id` stem (`user.v1` -> stem `user` -> kebab `user`), so the file
    // name differs from the old code-emitter's `user-v1.*.yaml`. The
    // YAML body still keys the component as `User` (stripping the
    // trailing `.vN` happens inside the EJS projection step).
    expect(file.path).toBe('models/user.openapi-components.yaml');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('manifest:openapi-components');
    expect(file.content.length).toBeGreaterThan(0);

    const doc = parseYaml(file.content) as {
      components?: {schemas?: Record<string, JSONSchema>};
    };
    expect(doc.components?.schemas?.['User']?.properties?.['name']?.type).toBe(
      'string',
    );
    expect(doc.components?.schemas?.['User']?.required).toEqual(['name']);
    // OAS projection strips top-level `$id` and `$schema` so the fragment
    // is mountable without leaking JSON-Schema metadata into the
    // OpenAPI document.
    expect(doc.components?.schemas?.['User']?.['$id' as keyof JSONSchema]).toBe(
      undefined,
    );
  });
});
