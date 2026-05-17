import {describe, expect, it} from 'vitest';
import {ProtoEmitter} from '../../emitters/semantic/proto-emitter';
import type {EmitterContext, JSONSchema} from '../../interfaces';

const FIXTURE: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    name: {type: 'string'},
    age: {type: 'integer'},
    active: {type: 'boolean'},
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

describe('ProtoEmitter.emit', () => {
  it('produces a proto3 file with a User message and field declarations', async () => {
    const emitter = new ProtoEmitter();
    const files = await emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user-v1.proto');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('proto-emitter');
    expect(file.content).toContain('syntax = "proto3"');
    expect(file.content).toMatch(/message\s+UserV1\s*\{/);
    expect(file.content).toContain('name');
  });

  it('honors per-schema package option', async () => {
    const emitter = new ProtoEmitter();
    const files = await emitter.emit(
      buildContext(FIXTURE, {package: 'acme.users.v1'}),
    );
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;
    expect(file.content).toContain('package acme.users.v1;');
  });
});
