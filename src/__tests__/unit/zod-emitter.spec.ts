import {describe, expect, it} from 'vitest';
import {ZodEmitter} from '../../emitters/zod-emitter';
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

function buildContext(schema: JSONSchema): EmitterContext {
  return {
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
}

describe('ZodEmitter.emit', () => {
  it('compiles a minimal user schema into a Zod sidecar file', () => {
    const emitter = new ZodEmitter();
    const files = emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user-v1.zod.ts');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('zod-emitter');
    expect(file.content.length).toBeGreaterThan(0);
    expect(file.content).toContain("import {z} from 'zod';");
    expect(file.content).toContain('export const UserV1Schema =');
    expect(file.content).toContain(
      'export type UserV1 = z.infer<typeof UserV1Schema>',
    );
    // Sanity-check the upstream Zod source: object shape + string field.
    expect(file.content).toContain('z.object');
    expect(file.content).toContain('z.string()');
  });
});
