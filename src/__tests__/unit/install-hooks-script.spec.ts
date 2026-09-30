import {spawnSync} from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

// Exercises scripts/install-hooks.sh (run by `npm install` via `prepare`)
// in a throwaway sandbox: temp HOME, temp global git config, temp git
// repo, and a stub `npx` on PATH that only records that it was called.
// Nothing here reads or writes the real HOME or the real git config.

const SCRIPT = resolve(__dirname, '../../../scripts/install-hooks.sh');

interface Sandbox {
  root: string;
  home: string;
  npxMarker: string;
  binDir: string;
}

let sb: Sandbox;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {cwd, env: sandboxEnv(), encoding: 'utf8'});
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function sandboxEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Drop anything that could leak the host's git/CI/npm context into
    // the script under test.
    if (/^(GIT_|CI$|npm_)/.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: sb.home,
    XDG_CONFIG_HOME: join(sb.home, '.config'),
    GIT_CONFIG_GLOBAL: join(sb.home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${sb.binDir}:${process.env.PATH ?? ''}`,
    ...extra,
  };
}

/** Lay out `<dir>/scripts/install-hooks.sh` + package.json, optionally as a git repo. */
function makePackage(dir: string, initGit: boolean): string {
  mkdirSync(join(dir, 'scripts'), {recursive: true});
  copyFileSync(SCRIPT, join(dir, 'scripts/install-hooks.sh'));
  writeFileSync(join(dir, 'package.json'), '{"name":"pkg"}\n');
  if (initGit) git(dir, 'init', '-q');
  return dir;
}

function runScript(pkgDir: string, extra: Record<string, string> = {}) {
  return spawnSync('sh', ['scripts/install-hooks.sh'], {
    cwd: pkgDir,
    env: sandboxEnv(extra),
    encoding: 'utf8',
  });
}

function npxCalled(): boolean {
  return existsSync(sb.npxMarker);
}

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-hooks-')));
  const home = join(root, 'home');
  const binDir = join(root, 'bin');
  mkdirSync(home, {recursive: true});
  mkdirSync(binDir, {recursive: true});
  writeFileSync(join(home, '.gitconfig'), '');
  const npxMarker = join(root, 'npx-called');
  const npx = join(binDir, 'npx');
  writeFileSync(npx, `#!/bin/sh\necho "$@" >> "${npxMarker}"\nexit 0\n`);
  chmodSync(npx, 0o755);
  sb = {root, home, npxMarker, binDir};
});

afterEach(() => {
  rmSync(sb.root, {recursive: true, force: true});
});

describe('scripts/install-hooks.sh', () => {
  it('installs via lefthook when no core.hooksPath is set', () => {
    const pkg = makePackage(join(sb.root, 'repo'), true);
    const r = runScript(pkg);
    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(true);
  });

  it('installs when a local core.hooksPath points at the repo .git/hooks', () => {
    const pkg = makePackage(join(sb.root, 'repo'), true);
    git(pkg, 'config', '--local', 'core.hooksPath', '.git/hooks');
    const r = runScript(pkg);
    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(true);
  });

  it('never writes into a global core.hooksPath and exits 0', () => {
    const globalHooks = join(sb.home, '.git-templates/hooks');
    mkdirSync(globalHooks, {recursive: true});
    const existing = join(globalHooks, 'pre-commit');
    writeFileSync(existing, '#!/bin/sh\nexit 0\n');
    chmodSync(existing, 0o755);
    // Written directly to the sandbox global config file (GIT_CONFIG_GLOBAL).
    writeFileSync(
      join(sb.home, '.gitconfig'),
      '[core]\n\thooksPath = ~/.git-templates/hooks\n',
    );

    const pkg = makePackage(join(sb.root, 'repo'), true);
    const r = runScript(pkg);

    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(false);
    expect(readdirSync(globalHooks)).toEqual(['pre-commit']);
    expect(r.stderr).toContain('git config --local core.hooksPath .git/hooks');
  });

  it('skips when a local core.hooksPath points outside the repo', () => {
    const outside = join(sb.root, 'elsewhere-hooks');
    mkdirSync(outside, {recursive: true});
    const pkg = makePackage(join(sb.root, 'repo'), true);
    git(pkg, 'config', '--local', 'core.hooksPath', outside);

    const r = runScript(pkg);

    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('skips when installed as a dependency under node_modules', () => {
    // Consumer repo with the package vendored under node_modules.
    const consumer = join(sb.root, 'consumer');
    mkdirSync(consumer, {recursive: true});
    git(consumer, 'init', '-q');
    const pkg = makePackage(join(consumer, 'node_modules/@scope/pkg'), false);

    const r = runScript(pkg);

    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(false);
  });

  it('skips when installed as a dependency with its own .git under node_modules', () => {
    // e.g. a git-URL dependency cloned in place.
    const pkg = makePackage(join(sb.root, 'consumer/node_modules/pkg'), true);

    const r = runScript(pkg);

    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(false);
  });

  it('skips when the package is not the root of its git work tree', () => {
    const outer = join(sb.root, 'outer');
    mkdirSync(outer, {recursive: true});
    git(outer, 'init', '-q');
    const pkg = makePackage(join(outer, 'vendor/pkg'), false);

    const r = runScript(pkg);

    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(false);
  });

  it('skips when CI is set', () => {
    const pkg = makePackage(join(sb.root, 'repo'), true);
    const r = runScript(pkg, {CI: 'true'});
    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(false);
  });

  it('skips during npm pack / publish', () => {
    const pkg = makePackage(join(sb.root, 'repo'), true);
    expect(runScript(pkg, {npm_command: 'pack'}).status).toBe(0);
    expect(runScript(pkg, {npm_command: 'publish'}).status).toBe(0);
    expect(runScript(pkg, {npm_config_dry_run: 'true'}).status).toBe(0);
    expect(npxCalled()).toBe(false);
  });
});
