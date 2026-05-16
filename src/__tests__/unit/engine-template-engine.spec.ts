import {randomBytes} from 'node:crypto';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {EjsTemplateEngine} from '../../engine/template-engine';
import {ContractsCodegenError} from '../../helpers';

const ROOT = join(
  tmpdir(),
  `lb-contracts-template-${randomBytes(6).toString('hex')}`,
);

beforeAll(() => {
  mkdirSync(ROOT, {recursive: true});
});

afterAll(() => {
  rmSync(ROOT, {recursive: true, force: true});
});

function writeTemplate(name: string, body: string): string {
  const path = join(ROOT, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('EjsTemplateEngine.render', () => {
  it('renders a simple template against a view-model', async () => {
    const path = writeTemplate(
      'hello.ejs',
      `Hello, <%= name %>! Pascal=<%= h.pascal(name) %>`,
    );
    const engine = new EjsTemplateEngine(ROOT);
    await engine.preload([path]);
    const out = engine.render(path, {name: 'jane doe'});
    expect(out).toBe('Hello, jane doe! Pascal=JaneDoe');
  });

  it('preload is idempotent — re-preloading a cached path is a no-op', async () => {
    const path = writeTemplate('cached.ejs', `<%= h.snake(value) %>`);
    const engine = new EjsTemplateEngine(ROOT);
    await engine.preload([path]);
    const first = engine.render(path, {value: 'CacheTest'});
    expect(first).toBe('cache_test');

    // Replace the file's bytes on disk. preload should NOT re-read because
    // the path is already in the cache — render therefore must return the
    // originally-compiled output.
    const {writeFileSync: wfs} = await import('node:fs');
    wfs(path, `<%= h.pascal(value) %>`, 'utf8');
    await engine.preload([path]);
    const second = engine.render(path, {value: 'CacheTest'});
    expect(second).toBe('cache_test');
  });

  it('throws ContractsCodegenError on EJS syntax errors (at preload time)', async () => {
    const path = writeTemplate('broken.ejs', `<% if (foo`);
    const engine = new EjsTemplateEngine(ROOT);
    await expect(engine.preload([path])).rejects.toBeInstanceOf(
      ContractsCodegenError,
    );
  });

  it('throws ContractsCodegenError when the template file is missing (at preload time)', async () => {
    const engine = new EjsTemplateEngine(ROOT);
    await expect(
      engine.preload([join(ROOT, 'no-such-template.ejs')]),
    ).rejects.toBeInstanceOf(ContractsCodegenError);
  });

  it('throws ContractsCodegenError when rendering a path that was not preloaded', () => {
    const engine = new EjsTemplateEngine(ROOT);
    expect(() => engine.render(join(ROOT, 'never-preloaded.ejs'), {})).toThrow(
      ContractsCodegenError,
    );
  });

  it('exposes h helpers that produce the expected outputs', async () => {
    // Use `<%-` (unescaped) so the asserted strings travel through the
    // template engine verbatim — EJS HTML-escapes `<%= %>` interpolation.
    const path = writeTemplate(
      'helpers.ejs',
      [
        `pascal=<%- h.pascal('user-profile') %>`,
        `camel=<%- h.camel('user-profile') %>`,
        `kebab=<%- h.kebab('UserProfile') %>`,
        `snake=<%- h.snake('UserProfile') %>`,
        `importPath=<%- h.importPath('/a/b/from.ts', '/a/b/to.ts') %>`,
        `escapeStr=<%- h.escapeStr("it's \\"quoted\\"") %>`,
      ].join('\n'),
    );
    const engine = new EjsTemplateEngine(ROOT);
    await engine.preload([path]);
    const out = engine.render(path, {});
    expect(out).toContain('pascal=UserProfile');
    expect(out).toContain('camel=userProfile');
    expect(out).toContain('kebab=user-profile');
    expect(out).toContain('snake=user_profile');
    expect(out).toContain('importPath=./to');
    // escapeStr keeps the double quotes as-is and back-slashes the single quote.
    expect(out).toContain(`escapeStr=it\\'s "quoted"`);
  });
});
