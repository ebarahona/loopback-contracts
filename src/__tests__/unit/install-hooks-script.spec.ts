import {spawnSync} from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

// Exercises scripts/install-hooks.sh (run by `npm install` via `prepare`)
// in a throwaway sandbox: temp HOME, temp global git config, temp git
// repo, and a stub `npx` on PATH that only records that it was called.
// Nothing here reads or writes the real HOME or the real git config.

const PKG_ROOT = resolve(__dirname, '../../..');
const SCRIPT = join(PKG_ROOT, 'scripts/install-hooks.sh');
const LEFTHOOK_PIN = 'lefthook@2.1.6';

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

function npxArgs(): string {
  return readFileSync(sb.npxMarker, 'utf8').trim();
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
  it('installs via a pinned npx lefthook when no core.hooksPath is set', () => {
    const pkg = makePackage(join(sb.root, 'repo'), true);
    const r = runScript(pkg);
    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(true);
    expect(npxArgs()).toBe(`--yes ${LEFTHOOK_PIN} install`);
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

  it('opt-in instructions use the same pinned lefthook version', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    expect(script).toContain(`npx --yes ${LEFTHOOK_PIN} install --force`);
    expect(script).not.toMatch(/npx lefthook /);
  });
});

describe('npm install never writes into a global core.hooksPath', () => {
  // lefthook's npm package runs `lefthook install -f` from its own
  // postinstall whenever CI is unset, bypassing install-hooks.sh and
  // writing shims into whatever core.hooksPath resolves to (renaming
  // existing hooks to *.old). It must therefore never be installed as
  // a dependency of this package.
  const pkgJson = JSON.parse(
    readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, string> | undefined>;

  it('does not depend on the lefthook npm package', () => {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      expect(Object.keys(pkgJson[field] ?? {})).not.toContain('lefthook');
    }
    const lock = readFileSync(join(PKG_ROOT, 'package-lock.json'), 'utf8');
    expect(lock).not.toMatch(/"node_modules\/lefthook(-[a-z0-9-]+)?"/);
  });

  it('has no install-time script other than the guarded prepare hook', () => {
    const scripts = pkgJson.scripts ?? {};
    for (const name of ['preinstall', 'install', 'postinstall']) {
      expect(scripts[name]).toBeUndefined();
    }
    expect(scripts.prepare).toBe('sh scripts/install-hooks.sh');
  });

  it('leaves a sentinel hook in the global hooksPath untouched', () => {
    const globalHooks = join(sb.root, 'global-hooks');
    mkdirSync(globalHooks, {recursive: true});
    const sentinel = join(globalHooks, 'commit-msg');
    const body = '#!/bin/sh\n# sentinel\nexit 0\n';
    writeFileSync(sentinel, body);
    chmodSync(sentinel, 0o755);
    writeFileSync(
      join(sb.home, '.gitconfig'),
      `[core]\n\thooksPath = ${globalHooks}\n`,
    );

    const pkg = makePackage(join(sb.root, 'repo'), true);
    const r = runScript(pkg);

    expect(r.status).toBe(0);
    expect(npxCalled()).toBe(false);
    expect(readdirSync(globalHooks)).toEqual(['commit-msg']);
    expect(readFileSync(sentinel, 'utf8')).toBe(body);
    expect(statSync(sentinel).mode & 0o777).toBe(0o755);
  });
});
