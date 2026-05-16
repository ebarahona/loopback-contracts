import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {GraphQLEmitter} from '../../emitters/graphql-emitter';
import {EjsTemplateEngine} from '../../engine/template-engine';
import type {EmitterContext, JSONSchema} from '../../interfaces';

const FIXTURE: JSONSchema = {
  $id: 'user.v1',
  type: 'object',
  properties: {
    id: {type: 'string'},
    name: {type: 'string'},
    age: {type: 'integer'},
  },
  required: ['id', 'name'],
};

const REAL_ENGINE = new EjsTemplateEngine(resolve(__dirname, '..', '..'));

interface Opts {
  sdl?: boolean;
  scalars?: Record<string, string>;
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

describe('GraphQLEmitter.emit', () => {
  it('renders @ObjectType + @Field decorators with the right TS types', async () => {
    const emitter = new GraphQLEmitter();
    await REAL_ENGINE.preload(emitter.templatePaths);
    const files = emitter.emit(buildContext(FIXTURE));

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file).toBeDefined();
    if (file === undefined) return;

    expect(file.path).toBe('models/user.graphql.ts');
    expect(file.policy).toBe('regen');
    expect(file.producer).toBe('graphql-emitter');
    expect(file.content).toContain("from 'type-graphql'");
    expect(file.content).toContain('@ObjectType');
    expect(file.content).toContain('@Field');
    expect(file.content).toContain('export class User');
    // Required field → no `?` and not nullable.
    expect(file.content).toMatch(/id: string;/);
    expect(file.content).toMatch(/name: string;/);
    // Optional integer → `?` and `number` TS type, GraphQL `Int`.
    expect(file.content).toMatch(/age\?: number;/);
    expect(file.content).toContain('Int');
  });

  it('opt-in SDL emission writes a second .graphql file', async () => {
    const emitter = new GraphQLEmitter();
    await REAL_ENGINE.preload(emitter.templatePaths);
    const files = emitter.emit(buildContext(FIXTURE, {sdl: true}));

    expect(files).toHaveLength(2);
    const sdl = files.find(f => f.path.endsWith('.graphql'));
    expect(sdl).toBeDefined();
    if (sdl === undefined) return;
    expect(sdl.path).toBe('models/user.graphql');
    expect(sdl.content).toContain('type User {');
    expect(sdl.content).toContain('id: String!');
  });
});
