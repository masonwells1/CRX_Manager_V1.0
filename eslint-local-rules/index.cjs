// eslint-local-rules/index.cjs
// Local ESLint rules for CRX Manager — committed to repo, works everywhere.
// Uses .cjs because the project has "type": "module" but eslint-plugin-local-rules
// loads rules via require().
const requireAssertRpcResult = require('./rules/require-assert-rpc-result.cjs');
const noDirectSentryImport = require('./rules/no-direct-sentry-import.cjs');
const assertRpcResultArgShape = require('./rules/assert-rpc-result-arg-shape.cjs');
const idempotencyKeyFromHook = require('./rules/idempotency-key-from-hook.cjs');
const handleSupabaseError = require('./rules/handle-supabase-error.cjs');
const requireCheckMutationResult = require('./rules/require-check-mutation-result.cjs');
const requireSupabaseErrorCapture = require('./rules/require-supabase-error-capture.cjs');

module.exports = {
  'require-assert-rpc-result': requireAssertRpcResult,
  'no-direct-sentry-import': noDirectSentryImport,
  'assert-rpc-result-arg-shape': assertRpcResultArgShape,
  'idempotency-key-from-hook': idempotencyKeyFromHook,
  'handle-supabase-error': handleSupabaseError,
  'require-check-mutation-result': requireCheckMutationResult,
  'require-supabase-error-capture': requireSupabaseErrorCapture,
};
