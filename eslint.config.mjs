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
      'scratch/**',
      'out/**',
      'release/**',
      'playwright/report/**',
      'playwright-report/**',
      'test-results/**',
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
      // React stays importable for the classic JSX pragma; other unused names are
      // reported, including capitalized components and icons.
      'no-unused-vars': ['warn', { varsIgnorePattern: '^(React$|_)', argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },

  // Shared contracts and server modules.
  {
    files: ['shared/**/*.mjs'],
    languageOptions: { ecmaVersion: 2025, sourceType: 'module', globals: { TextEncoder: 'readonly' } },
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
  },
  {
    // Added to eslint:recommended in ESLint 10. Public API wrappers deliberately
    // throw sanitized errors without the internal cause, and the flagged
    // assignments are defensive defaults; keep the previous rule set.
    rules: {
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },
];
