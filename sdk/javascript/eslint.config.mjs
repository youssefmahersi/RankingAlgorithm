import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', 'types/**', 'test/types.ts'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { console: 'readonly', Date: 'readonly', URL: 'readonly' },
    },
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    files: ['src/legacy.js', 'test/**/*.js'],
    rules: { 'no-console': 'off' },
  },
];
