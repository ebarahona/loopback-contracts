import {
  Application,
  BindingScope,
  createBindingFromClass,
  injectable,
} from '@loopback/core';
import {describe, expect, it} from 'vitest';
import {ContractsComponent} from '../../contracts.component';
import {EmitterRegistry} from '../../engine/emitter-registry';
import {ContractsEngineBindings} from '../../engine/tokens';
import {ContractsEmitterConflictError} from '../../helpers';
import type {
  EmittedFile,
  EmitterContext,
  ProjectionEmitter,
} from '../../interfaces';
import {EMITTER_TAG} from '../../keys';

async function buildApp(): Promise<Application> {
  const app = new Application();
  app.component(ContractsComponent);
  app
    .bind(ContractsEngineBindings.EMITTER_REGISTRY)
    .toClass(EmitterRegistry)
    .inScope(BindingScope.SINGLETON);
  // Start the app so ManifestEmitterBooter discovers the built-in manifest
  // emitters (cloudevents, openapi-components) shipped under
  // `src/emitters/manifest/<kind>/`. Without `start()` the booter never
  // fires and the registry only sees the TS-code emitters.
  await app.start();
  return app;
}

/** Minimal stub emitter that does nothing but declare a kind. */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[EMITTER_TAG]: EMITTER_TAG, kind: 'zod'},
})
class DuplicateZodEmitter implements ProjectionEmitter {
  readonly kind = 'zod';
  readonly outputSuffix = '.dup.zod.ts';
  readonly tier = 'convenience' as const;
  readonly description = 'duplicate stub';

  emit(_ctx: EmitterContext): EmittedFile[] {
    return [];
  }
}

describe('EmitterRegistry', () => {
  it('lists every built-in emitter (9 sidecars)', async () => {
    const app = await buildApp();
    const reg = await app.get<EmitterRegistry>(
      ContractsEngineBindings.EMITTER_REGISTRY,
    );
    const all = await reg.all();
    const kinds = all.map(e => e.kind).sort();
    expect(kinds).toEqual(
      [
        'asyncapi',
        'avro',
        'cloudevents',
        'graphql',
        'mock-data',
        'openapi-components',
        'proto',
        'types',
        'zod',
      ].sort(),
    );
    expect(all).toHaveLength(9);
  });

  it('byKind() returns the matching emitter or undefined', async () => {
    const app = await buildApp();
    const reg = await app.get<EmitterRegistry>(
      ContractsEngineBindings.EMITTER_REGISTRY,
    );
    const zod = await reg.byKind('zod');
    expect(zod).toBeDefined();
    expect(zod?.kind).toBe('zod');
    const missing = await reg.byKind('does-not-exist');
    expect(missing).toBeUndefined();
  });

  it('findEnabled() filters by emit-flag map', async () => {
    const app = await buildApp();
    const reg = await app.get<EmitterRegistry>(
      ContractsEngineBindings.EMITTER_REGISTRY,
    );
    const flags: Record<string, boolean> = {
      zod: true,
      types: false,
      graphql: true,
      cloudevents: false,
      asyncapi: false,
      proto: false,
      avro: false,
      'openapi-components': false,
      'mock-data': false,
    };
    const enabled = await reg.findEnabled(flags);
    const kinds = enabled.map(e => e.kind).sort();
    expect(kinds).toEqual(['graphql', 'zod']);
  });

  it('validateUniqueness() does not throw on built-ins', async () => {
    const app = await buildApp();
    const reg = await app.get<EmitterRegistry>(
      ContractsEngineBindings.EMITTER_REGISTRY,
    );
    await expect(reg.validateUniqueness()).resolves.toBeUndefined();
  });

  it('validateUniqueness() throws when two emitters share a kind', async () => {
    const app = await buildApp();
    app.add(createBindingFromClass(DuplicateZodEmitter));
    const reg = await app.get<EmitterRegistry>(
      ContractsEngineBindings.EMITTER_REGISTRY,
    );
    await expect(reg.validateUniqueness()).rejects.toBeInstanceOf(
      ContractsEmitterConflictError,
    );
  });

  it('listMetadata() returns kind/outputSuffix/tier/description per emitter', async () => {
    const app = await buildApp();
    const reg = await app.get<EmitterRegistry>(
      ContractsEngineBindings.EMITTER_REGISTRY,
    );
    const meta = await reg.listMetadata();
    expect(meta).toHaveLength(9);
    for (const m of meta) {
      expect(typeof m.kind).toBe('string');
      expect(typeof m.outputSuffix).toBe('string');
      expect(typeof m.description).toBe('string');
      expect(['lb4-idiom', 'real-translation', 'convenience']).toContain(
        m.tier,
      );
    }
  });
});
