import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {parse as parseYaml} from 'yaml';
import {EjsTemplateEngine} from '../../engine/template-engine';
import {OpenAPIComponentsEmitter} from '../../emitters/openapi-components-emitter';
import type {EmitterContext, JSONSchema} from '../../interfaces';

const FIXTURE: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    name: {type: 'string'},
    age: {type: 'integer'},
  },
  required: ['name'],
};

// Shared engine so a single `preload` call warms the cache for every test.
const REAL_ENGINE = new EjsTemplateEngine(resolve(__dirname, '..', '..'));

function buildContext(schema: JSONSchema): EmitterContext {
  // Use the real EJS engine rooted at the source tree so the emitter's
  // absolute template path resolves against the same tree the build copies
  // into `dist/templates/`. This is the same wiring the runner uses in prod.
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

describe('OpenAPIComponentsEmitter.emit', () => {
  it('projects a minimal user schema into an OAS components fragment', async () => {
    const emitter = new OpenAPIComponentsEmitter();
    await REAL_ENGINE.preload(emitter.templatePaths);
    const files = emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user-v1.openapi-components.yaml');
    expect(file.headerComment).toBe('#');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('openapi-components-emitter');
    expect(file.content.length).toBeGreaterThan(0);

    const doc = parseYaml(file.content) as {
      components?: {schemas?: Record<string, JSONSchema>};
    };
    expect(doc.components?.schemas?.['User']?.properties?.['name']?.type).toBe(
      'string',
    );
    expect(doc.components?.schemas?.['User']?.required).toEqual(['name']);
  });
});
