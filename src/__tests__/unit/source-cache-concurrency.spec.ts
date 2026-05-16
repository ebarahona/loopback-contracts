import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {SchemaSourceCache} from '../../sources/source-cache';

const ROOT = join(
  tmpdir(),
  `lb-contracts-source-cache-${randomBytes(6).toString('hex')}`,
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

function etagsPath(project: string): string {
  return join(project, '.loopback', 'cache', 'schemas', 'etags.json');
}

describe('SchemaSourceCache.setEtag concurrency', () => {
  it('preserves every entry under concurrent writes for distinct URIs', async () => {
    const project = projectRoot('concurrent-setetag');
    const cache = new SchemaSourceCache(project);

    const uris = Array.from(
      {length: 50},
      (_, i) => `https://example.com/schema-${i}.json`,
    );
    const expected: Record<string, string> = {};
    for (const uri of uris) expected[uri] = `etag-${uri}`;

    await Promise.all(uris.map(uri => cache.setEtag(uri, `etag-${uri}`)));

    const onDisk = JSON.parse(
      readFileSync(etagsPath(project), 'utf8'),
    ) as Record<string, string>;
    expect(onDisk).toEqual(expected);
    expect(Object.keys(onDisk)).toHaveLength(uris.length);
  });

  it('serializes repeated writes against the same URI without dropping the latest value', async () => {
    const project = projectRoot('repeated-setetag');
    const cache = new SchemaSourceCache(project);
    const uri = 'https://example.com/same.json';

    await Promise.all(
      Array.from({length: 25}, (_, i) => cache.setEtag(uri, `etag-${i}`)),
    );

    const onDisk = JSON.parse(
      readFileSync(etagsPath(project), 'utf8'),
    ) as Record<string, string>;
    expect(Object.keys(onDisk)).toEqual([uri]);
    // The winning value must be one of the writes — never undefined / missing.
    expect(onDisk[uri]).toMatch(/^etag-\d+$/);
    expect(await cache.etag(uri)).toBe(onDisk[uri]);
  });

  it('invalidate races with setEtag without corrupting the file', async () => {
    const project = projectRoot('invalidate-vs-setetag');
    const cache = new SchemaSourceCache(project);
    const keep = 'https://example.com/keep.json';
    const drop = 'https://example.com/drop.json';

    await cache.setEtag(keep, 'keep-etag');
    await cache.setEtag(drop, 'drop-etag');

    await Promise.all([
      cache.setEtag(keep, 'keep-etag-2'),
      cache.invalidate(drop),
      cache.setEtag(keep, 'keep-etag-3'),
    ]);

    const onDisk = JSON.parse(
      readFileSync(etagsPath(project), 'utf8'),
    ) as Record<string, string>;
    expect(drop in onDisk).toBe(false);
    expect(onDisk[keep]).toMatch(/^keep-etag(-2|-3)$/);
  });

  it('stores etags and redirects in separate files (no key collision)', async () => {
    // Regression for the redirect-vs-etag conflation: a server emitting an
    // opaque ETag whose value happens to be a URL string must not be
    // disambiguatable from a stored redirect target for the same URI. With
    // the two stores split, both values coexist without overwriting each
    // other.
    const project = projectRoot('etag-vs-redirect');
    const cache = new SchemaSourceCache(project);
    const uri = 'https://example.com/schema.json';
    const urlShapedEtag = 'https://example.com/schema.json';
    const redirectTarget = 'https://cdn.example.com/schema.json';

    await cache.setEtag(uri, urlShapedEtag);
    await cache.setRedirect(uri, redirectTarget);

    expect(await cache.etag(uri)).toBe(urlShapedEtag);
    expect(await cache.redirect(uri)).toBe(redirectTarget);

    const root = join(project, '.loopback', 'cache', 'schemas');
    const etags = JSON.parse(
      readFileSync(join(root, 'etags.json'), 'utf8'),
    ) as Record<string, string>;
    const redirects = JSON.parse(
      readFileSync(join(root, 'redirects.json'), 'utf8'),
    ) as Record<string, string>;
    expect(etags[uri]).toBe(urlShapedEtag);
    expect(redirects[uri]).toBe(redirectTarget);
  });

  it('invalidate clears both etag and redirect entries for a URI', async () => {
    const project = projectRoot('invalidate-clears-both');
    const cache = new SchemaSourceCache(project);
    const uri = 'https://example.com/schema.json';
    await cache.setEtag(uri, 'some-etag');
    await cache.setRedirect(uri, 'https://cdn.example.com/schema.json');

    await cache.invalidate(uri);

    expect(await cache.etag(uri)).toBeUndefined();
    expect(await cache.redirect(uri)).toBeUndefined();
  });

  it('does not leave .tmp.* sibling files behind after concurrent writes', async () => {
    const project = projectRoot('no-tmp-leak');
    const cache = new SchemaSourceCache(project);
    const uris = Array.from(
      {length: 20},
      (_, i) => `https://example.com/leak-${i}.json`,
    );
    await Promise.all(uris.map(uri => cache.setEtag(uri, `etag-${uri}`)));

    const dir = join(project, '.loopback', 'cache', 'schemas');
    const {readdirSync} = await import('node:fs');
    const entries = readdirSync(dir);
    const stragglers = entries.filter(e => e.includes('.tmp.'));
    expect(stragglers).toEqual([]);
  });
});
