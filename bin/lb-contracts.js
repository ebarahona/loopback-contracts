#!/usr/bin/env node
// Entry shim for the `lb-contracts` CLI. Delegates to the compiled
// dispatcher in `dist/cli/index.js` and surfaces its returned exit code.
// Catches anything thrown above the dispatcher (e.g., a failed `require`
// when `dist/` was not built) and prints an actionable message to stderr.

'use strict';

const {existsSync} = require('node:fs');
const {resolve} = require('node:path');

const distEntry = resolve(__dirname, '..', 'dist', 'cli', 'index.js');

if (!existsSync(distEntry)) {
  process.stderr.write(
    'lb-contracts: compiled CLI not found at ' +
      distEntry +
      '\n  Hint: run `npm run build` (or `npm install` from a published ' +
      'tarball) before invoking this binary.\n',
  );
  process.exit(1);
}

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(distEntry);
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write('lb-contracts: failed to load CLI (' + message + ')\n');
  process.exit(1);
}
