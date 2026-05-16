import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {CloudEventsEmitter} from '../../emitters/cloudevents-emitter';
import {EjsTemplateEngine} from '../../engine/template-engine';
import type {EmitterContext, JSONSchema} from '../../interfaces';

const FIXTURE: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    id: {type: 'string'},
    name: {type: 'string'},
  },
  required: ['id'],
  'x-cloudevents': {type: 'com.example.user.created'},
};

const REAL_ENGINE = new EjsTemplateEngine(resolve(__dirname, '..', '..'));

interface Opts {
  type: string;
  source?: string;
  subject?: string;
}

function buildContext(
  schema: JSONSchema,
  options?: Opts,
): EmitterContext<Opts> {
  return {
    schema,
    ...(options !== undefined ? {options} : {}),
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

describe('CloudEventsEmitter.emit', () => {
  it('emits CloudEvent<User> wrapper + factory when x-cloudevents is set', async () => {
    const emitter = new CloudEventsEmitter();
    await REAL_ENGINE.preload(emitter.templatePaths);
    const files = emitter.emit(
      buildContext(FIXTURE, {type: 'com.example.user.created'}),
    );

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user.cloudevents.ts');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('cloudevents-emitter');
    expect(file.content).toContain("import {CloudEvent} from 'cloudevents';");
    expect(file.content).toContain('CloudEvent<User>');
    expect(file.content).toContain('com.example.user.created');
    expect(file.content).toContain('export function createUserEvent');
    expect(file.content).toContain('UserEventInit');
    expect(file.content).toContain("specversion: '1.0'");
  });

  it('returns [] when the schema has neither x-cloudevents nor options', () => {
    const emitter = new CloudEventsEmitter();
    const {['x-cloudevents']: _unused, ...stripped} = FIXTURE;
    void _unused;
    const files = emitter.emit(buildContext(stripped as JSONSchema));
    expect(files).toEqual([]);
  });
});
