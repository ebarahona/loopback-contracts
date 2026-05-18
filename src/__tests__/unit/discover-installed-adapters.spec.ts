// Direct unit coverage for the `discoverInstalledAdapters` package.json
// scanner. The helper is intentionally `@internal` (not part of the
// engine's public surface) but exported for testing because the alternative
// — covering both regex patterns through full pipeline runs — would be
// orders of magnitude slower for what's effectively pure string-matching.
//
// The two patterns under test (`loopback-connector-*` AND
// `@loopback/connector-*`) reflect the dual naming convention LB4 has
// shipped over the years; either form should surface the same adapter
// suffix in the meta-schema's `adapter` enum, and BOTH forms installed
// at once must dedupe to a single entry rather than show up twice.

import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {discoverInstalledAdapters} from '../../engine/pipeline';

const ROOT = join(
  tmpdir(),
  `discover-adapters-${randomBytes(8).toString('hex')}`,
);

// Per-case project root so each test gets a clean `package.json` without
// fighting filesystem state — the directory name is the case identifier
// for easy correlation in any failure trace.
function seed(name: string, pkgJson: string | undefined): string {
  const root = join(ROOT, name);
  mkdirSync(root, {recursive: true});
  if (pkgJson !== undefined) {
    writeFileSync(join(root, 'package.json'), pkgJson, 'utf8');
  }
  return root;
}

beforeAll(() => {
  mkdirSync(ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(ROOT, {recursive: true, force: true});
});

describe('discoverInstalledAdapters()', () => {
  it('finds legacy unscoped `loopback-connector-*` peers in dependencies', async () => {
    const root = seed(
      'legacy',
      JSON.stringify({dependencies: {'loopback-connector-mongodb': '*'}}),
    );
    expect(await discoverInstalledAdapters(root)).toEqual(['mongodb']);
  });

  it('finds scoped `@loopback/connector-*` peers in devDependencies', async () => {
    const root = seed(
      'scoped',
      JSON.stringify({devDependencies: {'@loopback/connector-mongo': '*'}}),
    );
    expect(await discoverInstalledAdapters(root)).toEqual(['mongo']);
  });

  it('unions BOTH naming forms and returns a sorted unique list', async () => {
    // Each form names a distinct adapter so the union has two entries —
    // proving the patterns run in parallel rather than the second
    // overriding the first.
    const root = seed(
      'both',
      JSON.stringify({
        dependencies: {'loopback-connector-mongodb': '*'},
        devDependencies: {'@loopback/connector-mongo': '*'},
      }),
    );
    expect(await discoverInstalledAdapters(root)).toEqual(['mongo', 'mongodb']);
  });

  it('dedupes when the same adapter is installed under both forms', async () => {
    // The README promises "exactly once" surfacing when both forms
    // resolve to the same suffix — the `Set` in the helper enforces it
    // and this case pins that contract.
    const root = seed(
      'dedupe',
      JSON.stringify({
        dependencies: {'loopback-connector-mongo': '*'},
        devDependencies: {'@loopback/connector-mongo': '*'},
      }),
    );
    expect(await discoverInstalledAdapters(root)).toEqual(['mongo']);
  });

  it('returns [] when `dependencies` is explicitly null (Low-4 edge case)', async () => {
    // A hand-edited `package.json` with `"dependencies": null` would
    // crash a naïve `Object.keys(pkg.dependencies)` call. The
    // `isPlainObject` guard skips the section silently.
    const root = seed(
      'null-deps',
      JSON.stringify({dependencies: null, devDependencies: {}}),
    );
    expect(await discoverInstalledAdapters(root)).toEqual([]);
  });

  it('returns [] when package.json is missing entirely', async () => {
    const root = seed('no-pkg', undefined);
    expect(await discoverInstalledAdapters(root)).toEqual([]);
  });

  it('returns [] when package.json is malformed JSON (silent recovery)', async () => {
    // Adapter-enum hinting is an authoring nicety, not a validation
    // gate — a broken `package.json` must never abort a gen run that
    // would otherwise succeed.
    const root = seed('malformed', '{this is not json');
    expect(await discoverInstalledAdapters(root)).toEqual([]);
  });

  it('ignores package names that do not match either connector pattern', async () => {
    // `@loopback/repository` lives under the `@loopback` scope but is
    // NOT a connector — the regex anchor on `connector-` keeps it out
    // of the adapter enum.
    const root = seed(
      'non-matching',
      JSON.stringify({
        dependencies: {
          '@loopback/repository': '*',
          '@loopback/rest': '*',
          'loopback-datasource-juggler': '*',
        },
      }),
    );
    expect(await discoverInstalledAdapters(root)).toEqual([]);
  });
});
