import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import localRules from 'eslint-plugin-local-rules';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Archived audit workflow scripts run under the Workflow tool, which allows top-level
  // `return`; they are not standalone ES modules and must be ignored like .claude/workflows.
  { ignores: ['dist', 'coverage', 'CRX_Manager_V1.0', '.claude/worktrees', '.claude/workflows', 'docs/audits/**/workflow.mjs', '.playwright-mcp', 'playwright-report', 'test-results'] },
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
        message: 'Use ConfirmModal instead of confirm(). See docs/workflows/SAFE_DEVELOPMENT_RULES.md.',
      }, {
        name: 'alert',
        message: 'Use toast() instead of alert(). See docs/workflows/SAFE_DEVELOPMENT_RULES.md.',
      }, {
        // Wave B audit B-6: window.prompt blocks silently on iOS Safari and
        // PWA-installed Chrome (returns null when the page isn't the active
        // top-level frame), making cancellations silently abort. Use
        // ReasonModal for any flow that needs a free-form reason.
        name: 'prompt',
        message: 'Use ReasonModal instead of prompt(). See docs/workflows/SAFE_DEVELOPMENT_RULES.md and src/components/ui/ReasonModal.tsx.',
      }],
      'no-restricted-properties': ['error', {
        object: 'window',
        property: 'confirm',
        message: 'Use ConfirmModal instead of window.confirm(). See docs/workflows/SAFE_DEVELOPMENT_RULES.md.',
      }, {
        object: 'window',
        property: 'alert',
        message: 'Use toast() instead of window.alert(). See docs/workflows/SAFE_DEVELOPMENT_RULES.md.',
      }, {
        object: 'window',
        property: 'prompt',
        message: 'Use ReasonModal instead of window.prompt(). See docs/workflows/SAFE_DEVELOPMENT_RULES.md and src/components/ui/ReasonModal.tsx.',
      }],
      'no-restricted-imports': ['error', {
        paths: [{
          name: '@sentry/react',
          message: 'Import { Sentry } from "../lib/sentry" instead. See docs/workflows/SAFE_DEVELOPMENT_RULES.md.',
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
    // ── C6 controls (2026-06-10 error-prevention review §4) ──
    // App code only: Edge Functions (Deno) and Node scripts have no React
    // hook available, so the idempotency rule would only produce noise there.
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // assertRpcResult(X) where X is the whole {data,error} response → no-op guard (P1B class)
      'local-rules/assert-rpc-result-arg-shape': 'error',
      // p_idempotency_key minted fresh at the callsite → retries double-execute
      'local-rules/idempotency-key-from-hook': 'error',
      // destructured supabase .from()/.storage `error` swallowed (Field Mode F4/F6 / C3)
      'local-rules/handle-supabase-error': 'error',
      // fire-and-forget supabase .update()/.delete() whose result is discarded (Architecture Rule #3)
      'local-rules/require-check-mutation-result': 'error',
    },
  },
  {
    // Unit tests / mocks intentionally use synthetic keys and fake responses
    files: [
      'src/**/*.test.{ts,tsx}',
      'src/tests/**/*.{ts,tsx}',
      'src/**/__mocks__/**/*.{ts,tsx}',
    ],
    rules: {
      'local-rules/assert-rpc-result-arg-shape': 'off',
      'local-rules/idempotency-key-from-hook': 'off',
      'local-rules/handle-supabase-error': 'off',
      'local-rules/require-check-mutation-result': 'off',
      'local-rules/require-supabase-error-capture': 'off',
    },
  },
  {
    // require-supabase-error-capture — HARD-enforce capturing `error` (not just `data`)
    // from supabase .from()/.storage reads on the MONEY screens, where a failed read
    // silently shown as $0/empty costs real money (the AccountsReceivable "Unused
    // Prepay" + Receiving Hub "nothing on order" bug class, 2026-06-24). Scoped as a
    // RATCHET: these files are clean today; widen this glob as the ~130 legacy reads
    // elsewhere are individually triaged. NOT global — most of those legacy reads are
    // benign list loads, so a blanket block would be churn + noise.
    files: [
      'src/pages/AccountsReceivable.tsx',
      'src/pages/ReceivingHub.tsx',
      'src/components/dashboard/FinanceSnapshotCard.tsx',
    ],
    rules: {
      'local-rules/require-supabase-error-capture': 'error',
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
