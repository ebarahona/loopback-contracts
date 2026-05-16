import {describe, expect, it} from 'vitest';
import {AvroEmitter} from '../../emitters/avro-emitter';
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

interface AvroRecord {
  type: string;
  name: string;
  namespace: string;
  fields: Array<{name: string; type: unknown}>;
}

describe('AvroEmitter.emit', () => {
  it('emits a parseable .avsc record with a field per property', () => {
    const emitter = new AvroEmitter();
    const files = emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user-v1.avsc');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('avro-emitter');

    const parsed = JSON.parse(file.content) as AvroRecord;
    expect(parsed.type).toBe('record');
    expect(parsed.name).toBe('UserV1');
    expect(parsed.namespace).toBe('com.example.contracts');
    expect(parsed.fields).toHaveLength(3);
    const fieldNames = parsed.fields.map(f => f.name);
    expect(fieldNames).toEqual(['name', 'age', 'active']);
    const nameField = parsed.fields.find(f => f.name === 'name');
    expect(nameField?.type).toBe('string');
  });

  it('honors per-schema namespace option', () => {
    const emitter = new AvroEmitter();
    const files = emitter.emit(
      buildContext(FIXTURE, {namespace: 'acme.users'}),
    );
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;
    const parsed = JSON.parse(file.content) as AvroRecord;
    expect(parsed.namespace).toBe('acme.users');
  });
});
