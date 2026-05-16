const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');
// Use eslint-plugin-import-x: the maintained fork compatible with
// ESLint 10 flat config. Registered under the `import` plugin
// namespace so rule names match the conventional `import/...` form.
const importPlugin = require('eslint-plugin-import-x');
const tsdocPlugin = require('eslint-plugin-tsdoc');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  {
    files: ['src/**/*.ts'],
    ignores: ['dist/**', 'node_modules/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin,
      tsdoc: tsdocPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_'},
      ],
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {assertionStyle: 'as', objectLiteralTypeAssertions: 'never'},
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': {descriptionFormat: '^: .+$'},
          'ts-check': false,
        },
      ],
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      'default-case': 'error',
      eqeqeq: ['error', 'always', {null: 'ignore'}],
      'no-throw-literal': 'error',
      'no-console': 'error',
      'import/no-default-export': 'error',
      'import/no-duplicates': 'error',
      'tsdoc/syntax': 'warn',
    },
  },
  // Allow default exports in vitest config (defineConfig idiom).
  {
    files: ['vitest.config.ts'],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  // Apply prettier-config last so it disables stylistic rules that
  // conflict with Prettier formatting.
  {
    files: ['src/**/*.ts'],
    rules: prettierConfig.rules,
  },
];
