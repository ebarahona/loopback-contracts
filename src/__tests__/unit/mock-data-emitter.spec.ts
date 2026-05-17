import {describe, expect, it} from 'vitest';
import {MockDataEmitter} from '../../emitters/library/mock-data-emitter';
import type {EmitterContext, JSONSchema} from '../../interfaces';

const FIXTURE: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    name: {type: 'string', minLength: 1},
    age: {type: 'integer', minimum: 0},
  },
  required: ['name'],
};

function buildContext<T = unknown>(
  schema: JSONSchema,
  options?: T,
): EmitterContext<T> {
  const ctx: EmitterContext<T> = {
    schema,
    registry: {get: () => undefined, list: () => [], has: () => false},
    importMap: {resolve: id => './' + id},
    templates: {preload: async () => {}, render: () => ''},
    paths: {
      root: '/tmp/contracts-test',
      outputDir: '/tmp/contracts-test/src',
      schemasDir: '/tmp/contracts-test/schemas',
      configsDir: '/tmp/contracts-test/configs',
    },
    lossy: {report: () => {}, entries: () => []},
  };
  return options === undefined ? ctx : {...ctx, options};
}

describe('MockDataEmitter.emit', () => {
  it('emits a single JSON fixture with required fields populated', async () => {
    const emitter = new MockDataEmitter();
    const files = await emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user-v1.mock.json');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('mock-data-emitter');

    const parsed = JSON.parse(file.content) as {name: unknown};
    expect(typeof parsed.name).toBe('string');
    expect((parsed.name as string).length).toBeGreaterThan(0);
  });

  it('emits an array of examples when count > 1', async () => {
    const emitter = new MockDataEmitter();
    const files = await emitter.emit(buildContext(FIXTURE, {count: 3}));
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;
    const parsed = JSON.parse(file.content) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
  });

  it('produces deterministic output for the same seed', async () => {
    const emitter = new MockDataEmitter();
    const first = await emitter.emit(buildContext(FIXTURE, {seed: 42}));
    const second = await emitter.emit(buildContext(FIXTURE, {seed: 42}));
    const a = first[0];
    const b = second[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;
    expect(a.content).toBe(b.content);
  });
});
