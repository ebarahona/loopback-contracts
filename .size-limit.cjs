// Package size budget. This is a Node-only CLI and library, so esbuild bundles for
// the Node platform: built-ins (node:path, node:crypto, ...) stay external.
/** @type {import('size-limit').SizeLimitConfig} */
module.exports = [
  {
    name: 'dist (CommonJS)',
    path: 'dist/index.js',
    limit: '100 KB',
    ignore: [
      '@loopback/core',
      '@loopback/metadata',
      'ajv',
      'ajv-formats',
      'ejs',
      'chokidar',
      'jsonc-parser',
      '@clack/prompts',
      'debug',
      'undici',
    ],
  },
].map(entry => ({
  ...entry,
  modifyEsbuildConfig: config => ({...config, platform: 'node'}),
}));
