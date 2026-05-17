#!/usr/bin/env node
// Copy EJS templates from `src/templates/` and `src/cli/templates/` into the
// matching `dist/` locations after `tsc` has compiled the TS sources. The
// generators reference templates via `join(__dirname, '..', 'templates')`,
// which resolves to `dist/templates/` at runtime, so the assets must live
// alongside the compiled JS. Using a tiny Node script avoids pulling in a
// dev dependency (`copyfiles`, `cpy-cli`, etc.) for a one-line copy.

import {readdir, mkdir, copyFile, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const copies = [
  {from: 'src/templates', to: 'dist/templates'},
  {from: 'src/cli/templates', to: 'dist/cli/templates'},
  // Built-in manifest emitters ship their .emitter.json + .ejs templates
  // alongside the compiled JS so ManifestEmitterBooter can scan
  // <plugin-dist>/emitters/manifest/ at runtime.
  {from: 'src/emitters/manifest', to: 'dist/emitters/manifest'},
];

async function copyTree(srcDir, destDir) {
  let entries;
  try {
    entries = await readdir(srcDir, {withFileTypes: true});
  } catch (err) {
    if (err && err.code === 'ENOENT') return; // nothing to copy
    throw err;
  }
  await mkdir(destDir, {recursive: true});
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dest);
    } else if (entry.isFile()) {
      await copyFile(src, dest);
    }
  }
}

for (const {from, to} of copies) {
  const src = resolve(repoRoot, from);
  const dest = resolve(repoRoot, to);
  try {
    await stat(src);
  } catch (err) {
    if (err && err.code === 'ENOENT') continue;
    throw err;
  }
  await copyTree(src, dest);
}
