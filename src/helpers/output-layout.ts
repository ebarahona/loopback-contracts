import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import type {EmittedFile, ProjectPaths} from '../interfaces';

/**
 * The bucket every emitter writes model-scoped output to
 * (`models/<name>.base.model.ts`, `models/<name>.zod.ts`, ...). The engine
 * relocates it to {@link ProjectPaths.modelsDir} at write time.
 *
 * @internal
 */
export const MODELS_BUCKET = 'models';

/**
 * Absolute directory the `models/` bucket is written to.
 *
 * @internal
 * @param paths - The run's project paths.
 * @returns `paths.modelsDir`, or `<outputDir>/models` when unset.
 */
export function modelsDirOf(
  paths: Pick<ProjectPaths, 'outputDir' | 'modelsDir'>,
): string {
  return paths.modelsDir ?? join(paths.outputDir, MODELS_BUCKET);
}

/**
 * Relative import prefix (no trailing slash) from a file in `fromBucket`
 * (`repositories`, `controllers`, ...) under `outputDir` to the models
 * directory: `../models` by default, `../generated` for
 * `outputDir: src/generated`.
 *
 * @internal
 * @param paths - The run's project paths.
 * @param fromBucket - Bucket directory of the importing file, relative to
 *   `paths.outputDir`.
 * @returns A `./`- or `../`-prefixed POSIX specifier prefix.
 */
export function modelsImportPrefix(
  paths: Pick<ProjectPaths, 'outputDir' | 'modelsDir'>,
  fromBucket: string,
): string {
  let rel = relative(join(paths.outputDir, fromBucket), modelsDirOf(paths));
  if (sep !== '/') rel = rel.split(sep).join('/');
  if (rel === '') return '.';
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Relocate every `models/...` descriptor to {@link modelsDirOf}. Paths the
 * relocation leaves inside `outputDir` are rewritten relative to it; a
 * models directory elsewhere in the project is anchored at `paths.root`
 * through the returned per-file root map (the {@link FileWriter.writeAll}
 * `perFileRoots` argument). The default layout is returned unchanged.
 *
 * @internal
 * @param files - Emitted descriptors, paths relative to `outputDir`.
 * @param paths - The run's project paths.
 * @returns The relocated descriptors and the per-file root overrides.
 */
export function placeModelOutputs(
  files: readonly EmittedFile[],
  paths: Pick<ProjectPaths, 'root' | 'outputDir' | 'modelsDir'>,
): {
  readonly files: readonly EmittedFile[];
  readonly perFileRoots: ReadonlyMap<string, string>;
} {
  const perFileRoots = new Map<string, string>();
  const modelsDir = modelsDirOf(paths);
  const fromOutput = toPosix(relative(paths.outputDir, modelsDir));
  if (fromOutput === MODELS_BUCKET) return {files, perFileRoots};

  const insideOutput =
    fromOutput !== '' &&
    fromOutput !== '..' &&
    !fromOutput.startsWith('../') &&
    !isAbsolute(fromOutput);
  const prefix = insideOutput
    ? fromOutput
    : toPosix(relative(paths.root, modelsDir));
  const placed = files.map(file => {
    const segments = file.path
      .split(/[\\/]/)
      .filter(s => s !== '' && s !== '.');
    if (segments[0] !== MODELS_BUCKET) return file;
    const rest = segments.slice(1).join('/');
    const path = prefix === '' ? rest : `${prefix}/${rest}`;
    if (!insideOutput) perFileRoots.set(path, paths.root);
    return {...file, path};
  });
  return {files: placed, perFileRoots};
}

/**
 * Outcome of {@link resolveModelsDir}: the absolute models directory, or
 * why the requested one is refused (a phrase such as "must be a directory
 * inside the project root", for the caller to prefix with the setting's
 * source).
 *
 * @internal
 */
export type ModelsDirResolution =
  | {readonly ok: true; readonly modelsDir: string}
  | {readonly ok: false; readonly problem: string};

/** Project-root directories the models directory must never land in. */
const RESERVED_ROOT_DIRS: readonly string[] = [
  '.git',
  '.loopback',
  '_meta',
  'node_modules',
];

/**
 * Resolve the models directory (`loopback.config.json` `outputDir` or
 * `lb-contracts gen --out-dir`) against the project root. It must lie
 * inside the root, and not inside `node_modules` (at any depth), `.git`,
 * `_meta`, `.loopback`, the schemas directory or the configs directory:
 * generated files there would be overwritten, published, or read back as
 * authored input. Symlinks are not resolved; a symlinked directory inside
 * the root is trusted like any other.
 *
 * @internal
 * @param root - Absolute project root.
 * @param outputDir - The requested value; `undefined` selects the default.
 * @param authored - Absolute schemas and configs directories.
 * @returns The absolute models directory, or the reason it is refused.
 */
export function resolveModelsDir(
  root: string,
  outputDir: string | undefined,
  authored: {readonly schemasDir: string; readonly configsDir: string},
): ModelsDirResolution {
  const abs = resolve(root, outputDir ?? join('src', MODELS_BUCKET));
  const rel = relative(root, abs);
  if (rel === '' || !isWithin(root, abs)) {
    return {
      ok: false,
      problem: 'must be a directory inside the project root',
    };
  }
  const segments = rel.split(sep);
  if (segments.includes('node_modules')) {
    return {ok: false, problem: "must not be inside 'node_modules'"};
  }
  const top = segments[0] ?? '';
  if (RESERVED_ROOT_DIRS.includes(top)) {
    return {ok: false, problem: `must not be inside '${top}'`};
  }
  for (const [label, dir] of [
    ['schemas', authored.schemasDir],
    ['configs', authored.configsDir],
  ] as const) {
    if (isWithin(dir, abs)) {
      return {
        ok: false,
        problem:
          `must not be inside the ${label} directory ` +
          `'${toPosix(relative(root, dir)) || '.'}'`,
      };
    }
  }
  return {ok: true, modelsDir: abs};
}

// `child` equals `parent` or lies below it. `..foo` is a sibling name, not
// a traversal, so only a whole `..` segment counts as leaving `parent`.
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !isOutside(rel);
}

function isOutside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
