import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {SchemaSourceCache} from '../../sources/source-cache';

/**
 * Cache-key isolation regression. Two URIs that share a repo+ref but carry
 * different credentials MUST resolve to different cache directories — a
 * low-privilege CI run cannot otherwise read a high-privilege run's payload
 * on a shared workspace (silent privilege escalation across credential
 * boundaries on Nx/monorepo runners that reuse `.loopback/cache/`).
 */

const ROOT = join(
  tmpdir(),
  `lb-contracts-cache-key-${randomBytes(6).toString('hex')}`,
);

beforeAll(() => {
  mkdirSync(ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(ROOT, {recursive: true, force: true});
});

function projectRoot(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, {recursive: true});
  return dir;
}

describe('SchemaSourceCache.cacheDir credential isolation', () => {
  it('different credentials on the same repo+ref produce different cache dirs', () => {
    const cache = new SchemaSourceCache(projectRoot('different-creds'));
    const userA = 'git+https://user1:tok1@github.com/acme/schemas.git#v1.0.0';
    const userB = 'git+https://user2:tok2@github.com/acme/schemas.git#v1.0.0';

    const dirA = cache.cacheDir(userA);
    const dirB = cache.cacheDir(userB);

    expect(dirA).not.toBe(dirB);
  });

  it('same raw URI is stable across repeated calls (deterministic hash)', () => {
    const cache = new SchemaSourceCache(projectRoot('stable-hash'));
    const uri = 'git+https://user:tok@github.com/acme/schemas.git#main';

    expect(cache.cacheDir(uri)).toBe(cache.cacheDir(uri));
  });

  it('credential-free URI matches itself but not the credentialed form', () => {
    const cache = new SchemaSourceCache(projectRoot('cred-vs-bare'));
    const bare = 'git+https://github.com/acme/schemas.git#v1.0.0';
    const credentialed =
      'git+https://user:tok@github.com/acme/schemas.git#v1.0.0';

    expect(cache.cacheDir(bare)).toBe(cache.cacheDir(bare));
    expect(cache.cacheDir(bare)).not.toBe(cache.cacheDir(credentialed));
  });

  it('different refs on the same repo produce different cache dirs', () => {
    const cache = new SchemaSourceCache(projectRoot('different-refs'));
    const a = 'git+https://github.com/acme/schemas.git#v1.0.0';
    const b = 'git+https://github.com/acme/schemas.git#v1.0.1';

    expect(cache.cacheDir(a)).not.toBe(cache.cacheDir(b));
  });

  it('directory name embeds a human-readable hostname slug (no credentials)', () => {
    const cache = new SchemaSourceCache(projectRoot('hostname-slug'));
    const uri = 'git+https://user:tok@github.com/acme/schemas.git#v1.0.0';

    const name = basename(cache.cacheDir(uri));

    // Format: <hostname-slug>-<16 hex chars>. The slug derives from
    // `github.com` — credentials and `git+` prefix MUST NOT appear.
    expect(name).toMatch(/^[a-z0-9-]+-[0-9a-f]{16}$/);
    expect(name).toContain('github');
    expect(name).not.toContain('user');
    expect(name).not.toContain('tok');
    expect(name).not.toContain('@');
  });

  it('falls back to "unknown" slug for an unparseable URI shape', () => {
    const cache = new SchemaSourceCache(projectRoot('unparseable'));
    const uri = 'not-a-real-uri-at-all';

    const name = basename(cache.cacheDir(uri));

    expect(name).toMatch(/^unknown-[0-9a-f]{16}$/);
  });

  it('on-disk manifest stores the redacted URI, never raw credentials', async () => {
    // The directory name hashes the RAW uri (so credentials are part of the
    // cache identity) but `manifest.json` must never embed `user:tok@host`
    // — credentials should never appear on disk in any readable form.
    const project = projectRoot('redacted-manifest');
    const cache = new SchemaSourceCache(project);
    const uri =
      'git+https://user1:supersecret@github.com/acme/schemas.git#v1.0.0';

    await cache.write(uri, [
      {source: 'placeholder', path: '/tmp/x.schema.json', content: '{}'},
    ]);

    const manifestPath = join(cache.cacheDir(uri), 'manifest.json');
    const raw = readFileSync(manifestPath, 'utf8');
    expect(raw).not.toContain('supersecret');
    expect(raw).not.toContain('user1:supersecret');
    expect(raw).toContain('[REDACTED]@github.com');
  });

  it('read round-trips a write keyed by the raw URI', async () => {
    const project = projectRoot('roundtrip');
    const cache = new SchemaSourceCache(project);
    const uri = 'git+https://user:tok@github.com/acme/schemas.git#v1.0.0';

    await cache.write(uri, [
      {source: 'will-be-overwritten', path: '/tmp/a.schema.json', content: 'A'},
    ]);

    const result = await cache.read(uri);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    // The `source` field is reconstructed from the redacted manifest URI.
    expect(result![0]?.source).toBe(
      'git+https://[REDACTED]@github.com/acme/schemas.git#v1.0.0',
    );
    expect(result![0]?.content).toBe('A');
  });
});
