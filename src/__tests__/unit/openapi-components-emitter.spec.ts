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

describe('openapi-components naming for URL-style $id', () => {
  const ADDRESS: JSONSchema = {
    $id: 'https://schemas.example.com/address/1.0.0',
    title: 'Address',
    type: 'object',
    properties: {zip: {type: 'string'}},
  };
  const INTAKE: JSONSchema = {
    $id: 'https://schemas.example.com/intake/1.0.0',
    title: 'AppraisalIntake',
    type: 'object',
    properties: {
      home: {$ref: 'https://schemas.example.com/address/1.0.0'},
      work: {$ref: '../address/1.0.0'},
      other: {$ref: 'https://elsewhere.example.com/x'},
    },
  };

  it('writes a slug file name and keys the component by title', async () => {
    const byId = new Map([ADDRESS, INTAKE].map(s => [s.$id as string, s]));
    const ctx: EmitterContext = {
      ...buildContext(INTAKE),
      registry: {
        get: id => byId.get(id),
        list: () => [...byId.values()],
        has: id => byId.has(id),
      },
    };
    const [file] = await emitter.emit(ctx);
    expect(file?.path).toBe('models/intake-1-0-0.openapi-components.yaml');

    const doc = parseYaml(file?.content ?? '') as {
      components: {schemas: Record<string, JSONSchema>};
    };
    const component = doc.components.schemas['AppraisalIntake'];
    expect(component).toBeDefined();
    // Loaded targets key on their component name, whichever way they are
    // referenced; refs outside the run pass through.
    expect(component?.properties?.['home']?.['$ref']).toBe(
      '#/components/schemas/Address',
    );
    expect(component?.properties?.['work']?.['$ref']).toBe(
      '#/components/schemas/Address',
    );
    expect(component?.properties?.['other']?.['$ref']).toBe(
      'https://elsewhere.example.com/x',
    );
  });
});

describe('openapi-components $ref and $defs projection', () => {
  const MONEY: JSONSchema = {
    $id: 'money',
    type: 'object',
    properties: {
      amount: {$ref: '#/$defs/amount'},
      currency: {$ref: '#/$defs/currency'},
    },
    required: ['amount', 'currency'],
    $defs: {
      amount: {type: 'number', minimum: 0},
      currency: {type: 'string', enum: ['USD', 'EUR']},
      // Only reachable through a fragment ref from another schema; its own
      // local ref must resolve against `money`, not the referrer.
      price: {
        type: 'object',
        properties: {value: {$ref: '#/$defs/amount'}},
      },
    },
  };
  const INTAKE: JSONSchema = {
    $id: 'appraisal-intake',
    type: 'object',
    properties: {
      faceValue: {$ref: 'money#/$defs/amount'},
      price: {$ref: 'money#/$defs/price'},
      premiums: {type: 'array', items: {$ref: 'money'}, minItems: 1},
      status: {$ref: '#/$defs/status', description: 'Lifecycle state'},
      parent: {$ref: '#'},
    },
    required: ['faceValue', 'status'],
    $defs: {status: {type: 'string', enum: ['draft', 'submitted']}},
  };

  async function emitAll(schemas: JSONSchema[]): Promise<{
    doc: {components: {schemas: Record<string, JSONSchema>}};
    lossy: string[];
  }> {
    const byId = new Map(schemas.map(s => [s.$id as string, s]));
    const registry = {
      get: (id: string) => byId.get(id),
      list: () => [...byId.values()],
      has: (id: string) => byId.has(id),
    };
    const lossy: string[] = [];
    const merged: Record<string, JSONSchema> = {};
    for (const schema of schemas) {
      const [file] = await emitter.emit({
        ...buildContext(schema),
        registry,
        lossy: {report: r => lossy.push(r.feature), entries: () => []},
      });
      const part = parseYaml(file?.content ?? '') as {
        components: {schemas: Record<string, JSONSchema>};
      };
      Object.assign(merged, part.components.schemas);
    }
    return {doc: {components: {schemas: merged}}, lossy};
  }

  // Every `$ref` in the mounted document, and whether it resolves.
  function collectRefs(doc: object): {ref: string; ok: boolean}[] {
    const out: {ref: string; ok: boolean}[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') {
          let cur: unknown = doc;
          const ok =
            value.startsWith('#/') &&
            value
              .slice(2)
              .split('/')
              .every(seg => {
                cur = (cur as Record<string, unknown> | undefined)?.[seg];
                return cur !== undefined;
              });
          out.push({ref: value, ok});
        } else {
          walk(value);
        }
      }
    };
    walk(doc);
    return out;
  }

  it('emits only refs that resolve inside the mounted components', async () => {
    const {doc, lossy} = await emitAll([MONEY, INTAKE]);
    expect(lossy).toEqual([]);
    const refs = collectRefs(doc);
    expect(refs.filter(r => !r.ok)).toEqual([]);
    expect(refs.map(r => r.ref).sort()).toEqual([
      '#/components/schemas/AppraisalIntake',
      '#/components/schemas/Money',
    ]);
    expect(JSON.stringify(doc)).not.toContain('$defs');
  });

  it('inlines $defs fragments, local and cross-schema', async () => {
    const {doc} = await emitAll([MONEY, INTAKE]);
    const intake = doc.components.schemas['AppraisalIntake'];
    const props = intake?.properties ?? {};
    expect(props['faceValue']).toEqual({type: 'number', minimum: 0});
    // A ref inside an inlined fragment resolves against its own document.
    expect(props['price']).toEqual({
      type: 'object',
      properties: {value: {type: 'number', minimum: 0}},
    });
    // Annotation siblings survive next to the inlined target.
    expect(props['status']).toEqual({
      description: 'Lifecycle state',
      allOf: [{type: 'string', enum: ['draft', 'submitted']}],
    });
    expect(props['premiums']?.items).toEqual({
      $ref: '#/components/schemas/Money',
    });
    expect(props['parent']).toEqual({
      $ref: '#/components/schemas/AppraisalIntake',
    });
    expect(doc.components.schemas['Money']?.properties?.['currency']).toEqual({
      type: 'string',
      enum: ['USD', 'EUR'],
    });
  });

  it('reports a self-recursive fragment instead of looping', async () => {
    const tree: JSONSchema = {
      $id: 'tree',
      type: 'object',
      properties: {root: {$ref: '#/$defs/node'}},
      $defs: {
        node: {type: 'object', properties: {child: {$ref: '#/$defs/node'}}},
      },
    };
    const {doc, lossy} = await emitAll([tree]);
    expect(lossy).toEqual(['recursive-fragment-$ref']);
    expect(doc.components.schemas['Tree']?.properties?.['root']).toEqual({
      type: 'object',
      properties: {child: {}},
    });
  });
});
