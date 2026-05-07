import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import localRules from 'eslint-plugin-local-rules';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'CRX_Manager_V1.0'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'jsx-a11y': jsxA11y,
      'local-rules': localRules,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // a11y rules — cherry-picked from recommended to avoid minimatch compatibility issues
      'jsx-a11y/alt-text': 'warn',
      'jsx-a11y/anchor-has-content': 'warn',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/aria-props': 'warn',
      'jsx-a11y/aria-role': 'warn',
      'jsx-a11y/aria-unsupported-elements': 'warn',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/heading-has-content': 'warn',
      'jsx-a11y/html-has-lang': 'warn',
      'jsx-a11y/img-redundant-alt': 'warn',
      'jsx-a11y/no-access-key': 'warn',
      'jsx-a11y/no-autofocus': 'warn',
      'jsx-a11y/no-distracting-elements': 'warn',
      'jsx-a11y/no-redundant-roles': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'warn',
      'jsx-a11y/role-supports-aria-props': 'warn',
      'jsx-a11y/scope': 'warn',
      'jsx-a11y/tabindex-no-positive': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // ── CRX Project Rules ── Block patterns that have caused repeat bugs
      'no-restricted-globals': ['error', {
        name: 'confirm',
        message: 'Use ConfirmModal instead of confirm(). See CLAUDE.md.',
      }, {
        name: 'alert',
        message: 'Use toast() instead of alert(). See CLAUDE.md.',
      }, {
        // Wave B audit B-6: window.prompt blocks silently on iOS Safari and
        // PWA-installed Chrome (returns null when the page isn't the active
        // top-level frame), making cancellations silently abort. Use
        // ReasonModal for any flow that needs a free-form reason.
        name: 'prompt',
        message: 'Use ReasonModal instead of prompt(). See CLAUDE.md and src/components/ui/ReasonModal.tsx.',
      }],
      'no-restricted-properties': ['error', {
        object: 'window',
        property: 'confirm',
        message: 'Use ConfirmModal instead of window.confirm(). See CLAUDE.md.',
      }, {
        object: 'window',
        property: 'alert',
        message: 'Use toast() instead of window.alert(). See CLAUDE.md.',
      }, {
        object: 'window',
        property: 'prompt',
        message: 'Use ReasonModal instead of window.prompt(). See CLAUDE.md and src/components/ui/ReasonModal.tsx.',
      }],
      'no-restricted-imports': ['error', {
        paths: [{
          name: '@sentry/react',
          message: 'Import { Sentry } from "../lib/sentry" instead. See CLAUDE.md.',
        }],
      }],
      'local-rules/require-assert-rpc-result': 'error',
      'local-rules/no-direct-sentry-import': 'error',
      'no-console': ['warn', { allow: ['warn'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    // Edge Functions run in Deno — no lib/sentry wrapper available
    files: ['supabase/functions/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  }
);
