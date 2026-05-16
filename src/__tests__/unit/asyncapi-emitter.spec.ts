import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {AsyncAPIEmitter} from '../../emitters/asyncapi-emitter';
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
};

const REAL_ENGINE = new EjsTemplateEngine(resolve(__dirname, '..', '..'));

interface Opts {
  channelName?: string;
  operationKind?: 'send' | 'receive';
}

function buildContext(schema: JSONSchema): EmitterContext<Opts> {
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

describe('AsyncAPIEmitter.emit', () => {
  it('emits a valid AsyncAPI 3.0 fragment with schema mounted under components', async () => {
    const emitter = new AsyncAPIEmitter();
    await REAL_ENGINE.preload(emitter.templatePaths);
    const files = emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user.asyncapi.yaml');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('asyncapi-emitter');
    expect(file.content).toContain('asyncapi: 3.0.0');
    expect(file.content).toContain('components:');
    expect(file.content).toContain('schemas:');
    expect(file.content).toContain('User:');
    expect(file.content).toContain('properties:');
    expect(file.content).toContain('id:');
    expect(file.content).toContain('messages:');
    expect(file.content).toContain('UserMessage:');
    expect(file.content).toContain("$ref: '#/components/schemas/User'");
  });
});
