#!/usr/bin/env node
// Remove `.d.ts` / `.d.ts.map` files under `dist/cli/` after `tsc` has emitted
// them. The CLI is consumed at runtime via the `bin/lb-contracts.js` shim
// (which `require()`s `dist/cli/index.js`), never imported as a library, so
// its declarations are not part of the public types surface. Several CLI
// modules — most notably `src/cli/commands/gen.ts` — export `@internal`
// helpers (`mergeEmitFlags`, `ParsedFlags`) for unit testing; without this
// step those identifiers would ship in the published tarball and become a
// de-facto API consumers could import from
// `@ebarahona/loopback-contracts/dist/cli/commands/gen`.
//
// We strip declarations rather than excluding `src/cli/**` from
// `tsconfig.build.json` because the CLI's `.js` output is required at
// runtime. We do NOT touch `.js` / `.js.map` files.

import {readdir, rm, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliDistRoot = resolve(repoRoot, 'dist', 'cli');

async function stripDts(dir) {
  let entries;
  try {
    entries = await readdir(dir, {withFileTypes: true});
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await stripDts(full);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.ts.map'))
    ) {
      await rm(full);
    }
  }
}

try {
  await stat(cliDistRoot);
} catch (err) {
  if (err && err.code === 'ENOENT') process.exit(0);
  throw err;
}

await stripDts(cliDistRoot);
