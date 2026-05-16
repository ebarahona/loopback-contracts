import {Application} from '@loopback/core';
import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ManifestEmitterBooter} from '../../engine/manifest-emitter-booter';
import {EMITTER_TAG} from '../../keys';

interface ManifestFixture {
  kind: string;
  outputSuffix: string;
  tier: 'lb4-idiom' | 'real-translation' | 'convenience';
  description: string;
  template: string;
}

function writeFixture(root: string, manifest: ManifestFixture): void {
  const dir = join(root, 'emitters');
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, `${manifest.kind}.emitter.json`),
    JSON.stringify(manifest),
    'utf8',
  );
  writeFileSync(join(dir, manifest.template), '// fixture template', 'utf8');
}

function makeBooter(root: string): {
  app: Application;
  booter: ManifestEmitterBooter;
} {
  const app = new Application();
  const booter = new ManifestEmitterBooter(app, root);
  return {app, booter};
}

function listManifestBindings(app: Application): string[] {
  return app
    .findByTag(EMITTER_TAG)
    .map(b => b.key)
    .filter(k => k.startsWith('platform.contracts.emitters.manifest.'));
}

describe('ManifestEmitterBooter idempotency', () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `lb-contracts-booter-${randomBytes(6).toString('hex')}`,
    );
    mkdirSync(root, {recursive: true});
    writeFixture(root, {
      kind: 'fixture-one',
      outputSuffix: '.fixture-one.ts',
      tier: 'convenience',
      description: 'fixture one',
      template: './fixture-one.ejs',
    });
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
  });

  it('binds each manifest exactly once when start() is called twice', async () => {
    const {app, booter} = makeBooter(root);
    await booter.start();
    await booter.start();
    const bindings = listManifestBindings(app);
    expect(bindings).toEqual([
      'platform.contracts.emitters.manifest.fixture-one',
    ]);
  });

  it('coalesces concurrent start() calls into a single bind pass', async () => {
    const {app, booter} = makeBooter(root);
    await Promise.all([booter.start(), booter.start(), booter.start()]);
    const bindings = listManifestBindings(app);
    expect(bindings).toEqual([
      'platform.contracts.emitters.manifest.fixture-one',
    ]);
  });

  it('stop() unbinds every key the booter added and is itself idempotent', async () => {
    const {app, booter} = makeBooter(root);
    await booter.start();
    expect(listManifestBindings(app)).toHaveLength(1);
    await booter.stop();
    expect(listManifestBindings(app)).toHaveLength(0);
    // Second stop is a no-op (idempotent) — does not throw.
    await booter.stop();
    expect(listManifestBindings(app)).toHaveLength(0);
  });

  it('supports restart after stop without double-binding', async () => {
    const {app, booter} = makeBooter(root);
    await booter.start();
    await booter.stop();
    await booter.start();
    const bindings = listManifestBindings(app);
    expect(bindings).toEqual([
      'platform.contracts.emitters.manifest.fixture-one',
    ]);
  });

  it('does not throw when stop() runs without a prior start()', async () => {
    const {booter} = makeBooter(root);
    await expect(booter.stop()).resolves.toBeUndefined();
  });
});
