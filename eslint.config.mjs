import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

// Browser modules, CommonJS services, and Node scripts use separate globals.
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'r-backend/**',
      'vault/**',
      'data/**'
    ]
  },

  // React browser modules.
  {
    files: ['src/**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },

  // Shared contracts and server modules.
  {
    files: ['shared/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { TextEncoder: 'readonly' } },
    rules: js.configs.recommended.rules,
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.node },
    rules: js.configs.recommended.rules,
  },
  {
    files: ['backend/**/*.js', 'server.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^req$|^res$|^next$' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },

  // Node scripts also contain Playwright callbacks that use browser globals.
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },

  {
    files: ['scripts/fixtures/*.js'],
    languageOptions: { sourceType: 'module' },
  },

  // ── Root build/config files: ESM + node ───────────────────────────────
  {
    files: ['*.config.js', '*.config.mjs', 'desktop/**/*.{js,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: { ...js.configs.recommended.rules }
  },

  // The desktop connection screen is a local browser page loaded by Electron.
  {
    files: ['desktop/setup.js'],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },

  // ── Test files: ESM (vitest imported explicitly), mixed node + browser ─
  // (some tests use require() for CJS modules and browser globals via jsdom)
  {
    files: ['**/*.test.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    }
  }
];
