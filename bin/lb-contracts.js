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
  const cli = require(distEntry);
  // The compiled module exports `runCli(argv)` which awaits the
  // dispatcher and calls `process.exit` with the resolved exit code.
  // Calling it explicitly avoids relying on `require.main === module`
  // — that condition is FALSE when this shim is the process entry and
  // the dispatcher is loaded via `require()`, so the dispatcher's own
  // auto-exit branch never fires from this path.
  if (typeof cli.runCli !== 'function') {
    throw new Error(
      'compiled CLI is missing the `runCli` export (rebuild may be stale)',
    );
  }
  cli.runCli(process.argv.slice(2));
} catch (err) {
  const message = err && err.message ? err.message : String(err);
  process.stderr.write('lb-contracts: failed to load CLI (' + message + ')\n');
  process.exit(1);
}
