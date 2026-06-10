// eslint-local-rules/index.cjs
// Local ESLint rules for CRX Manager — committed to repo, works everywhere.
// Uses .cjs because the project has "type": "module" but eslint-plugin-local-rules
// loads rules via require().
const requireAssertRpcResult = require('./rules/require-assert-rpc-result.cjs');
const noDirectSentryImport = require('./rules/no-direct-sentry-import.cjs');
const assertRpcResultArgShape = require('./rules/assert-rpc-result-arg-shape.cjs');
const idempotencyKeyFromHook = require('./rules/idempotency-key-from-hook.cjs');

module.exports = {
  'require-assert-rpc-result': requireAssertRpcResult,
  'no-direct-sentry-import': noDirectSentryImport,
  'assert-rpc-result-arg-shape': assertRpcResultArgShape,
  'idempotency-key-from-hook': idempotencyKeyFromHook,
};
