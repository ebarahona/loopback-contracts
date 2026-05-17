import {Application} from '@loopback/core';
import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ManifestEmitterBooter} from '../../engine/manifest-emitter-booter';
import {EMITTER_TAG} from '../../keys';

interface LegacyManifestFixture {
  kind: string;
  outputSuffix: string;
  tier: 'lb4-idiom' | 'real-translation' | 'convenience';
  description: string;
  template: string;
}

interface PluralManifestFixture {
  kind: string;
  tier: 'lb4-idiom' | 'real-translation' | 'convenience';
  description: string;
  outputs: ReadonlyArray<{
    template: string;
    path: string;
    policy?: 'regen' | 'skipIfExists';
  }>;
}

function writeFixture(root: string, manifest: LegacyManifestFixture): void {
  const dir = join(root, 'emitters');
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, `${manifest.kind}.emitter.json`),
    JSON.stringify(manifest),
    'utf8',
  );
  writeFileSync(join(dir, manifest.template), '// fixture template', 'utf8');
}

function writePluralFixture(
  root: string,
  manifest: PluralManifestFixture,
): void {
  const dir = join(root, 'emitters');
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    join(dir, `${manifest.kind}.emitter.json`),
    JSON.stringify(manifest),
    'utf8',
  );
  // Plural-form outputs[].template paths are author-supplied absolute paths,
  // so create the template files at those exact locations.
  for (const out of manifest.outputs) {
    writeFileSync(out.template, '// fixture template', 'utf8');
  }
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

/**
 * Subset of {@link listManifestBindings} that excludes built-in manifest
 * emitters the booter discovers under `<plugin-dist>/emitters/manifest/`.
 * These tests only assert about the fixture-authored project-local
 * manifests; built-ins are covered by their own per-emitter specs.
 */
function listProjectManifestBindings(
  app: Application,
  fixtureKinds: readonly string[],
): string[] {
  const allowed = new Set(
    fixtureKinds.map(k => `platform.contracts.emitters.manifest.${k}`),
  );
  return listManifestBindings(app).filter(k => allowed.has(k));
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
    const bindings = listProjectManifestBindings(app, ['fixture-one']);
    expect(bindings).toEqual([
      'platform.contracts.emitters.manifest.fixture-one',
    ]);
  });

  it('coalesces concurrent start() calls into a single bind pass', async () => {
    const {app, booter} = makeBooter(root);
    await Promise.all([booter.start(), booter.start(), booter.start()]);
    const bindings = listProjectManifestBindings(app, ['fixture-one']);
    expect(bindings).toEqual([
      'platform.contracts.emitters.manifest.fixture-one',
    ]);
  });

  it('stop() unbinds every key the booter added and is itself idempotent', async () => {
    const {app, booter} = makeBooter(root);
    await booter.start();
    expect(listProjectManifestBindings(app, ['fixture-one'])).toHaveLength(1);
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
    const bindings = listProjectManifestBindings(app, ['fixture-one']);
    expect(bindings).toEqual([
      'platform.contracts.emitters.manifest.fixture-one',
    ]);
  });

  it('does not throw when stop() runs without a prior start()', async () => {
    const {booter} = makeBooter(root);
    await expect(booter.stop()).resolves.toBeUndefined();
  });
});

describe('ManifestEmitterBooter plural outputs[]', () => {
  let root: string;

  beforeEach(() => {
    root = join(
      tmpdir(),
      `lb-contracts-booter-plural-${randomBytes(6).toString('hex')}`,
    );
    mkdirSync(join(root, 'emitters', 'templates'), {recursive: true});
    writePluralFixture(root, {
      kind: 'plural-fixture',
      tier: 'convenience',
      description: 'plural fixture',
      outputs: [
        {
          template: join(root, 'emitters', 'templates', 'a.ejs'),
          path: 'models/{{kebabName}}.a.ts',
        },
        {
          template: join(root, 'emitters', 'templates', 'b.ejs'),
          path: 'models/{{kebabName}}.b.ts',
          policy: 'skipIfExists',
        },
      ],
    });
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
  });

  it('binds the plural-form manifest exactly once across repeated starts', async () => {
    const {app, booter} = makeBooter(root);
    await booter.start();
    await booter.start();
    const bindings = listProjectManifestBindings(app, ['plural-fixture']);
    expect(bindings).toEqual([
      'platform.contracts.emitters.manifest.plural-fixture',
    ]);
  });

  it('cleans up the plural-form binding on stop()', async () => {
    const {app, booter} = makeBooter(root);
    await booter.start();
    expect(listProjectManifestBindings(app, ['plural-fixture'])).toHaveLength(
      1,
    );
    await booter.stop();
    expect(listManifestBindings(app)).toHaveLength(0);
  });
});
