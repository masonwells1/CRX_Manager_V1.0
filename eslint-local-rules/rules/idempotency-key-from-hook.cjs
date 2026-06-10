// C6 control (docs/audits/2026-06-10-error-prevention-review.md §4 C6).
//
// Catches the financial-reversal double-execution class: an idempotency key
// minted FRESH at the rpc callsite —
//
//   p_idempotency_key: crypto.randomUUID(),                       // BUG
//   p_idempotency_key: `${op}:${Date.now()}`,                     // BUG
//   p_idempotency_key: generateIdempotencyKey('op', userId),      // BUG (inline)
//
// A fresh-per-call key means a network-timeout retry (or double click before
// re-render) sends a DIFFERENT key, the server dedup never matches, and the
// mutation executes twice. The canonical pattern is useIdempotencyKey(), whose
// getKey() persists the key in a ref across retries and only resets on
// confirmed success:
//
//   const saveIdem = useIdempotencyKey('save_thing', profile.id);
//   ...
//   p_idempotency_key: saveIdem.getKey(),                         // OK
//   const idemKey = saveIdem.getKey(); ... p_idempotency_key: idemKey,  // OK
//
// Heuristic (tuned against the real codebase 2026-06-10):
//   Report ONLY when the value is PROVABLY a fresh/static key:
//     crypto.randomUUID() / randomUUID() / uuid() / uuidv4() / v4(),
//     Date.now() / new Date().getTime() / new Date().valueOf(),
//     an inline generateIdempotencyKey(...) call (fresh key every call —
//       cache it via the hook or a ref instead),
//     a template literal, string literal, or string concatenation,
//     or an identifier ALL of whose assignments are one of the above.
//   Everything unresolvable (function params, data-object members like
//   `order.idempotency_key`, ref-cache reads) is allowed — fail-open keeps
//   the rule noise-free; the banned set is exactly the bug class.
//
// Scope: wired in eslint.config.js for src/** only, with *.test.* excluded —
// Edge Functions (Deno) and Node scripts have no React hook available, and
// tests intentionally use synthetic literal keys.

// ---------------------------------------------------------------------------
// LEGACY VIOLATIONS — grandfathered so lint stays green without editing src/.
// Each entry is a REAL pre-existing violation recorded as a C6 finding on
// 2026-06-10. Fix the file, then DELETE its entry — do not add new ones.
// ---------------------------------------------------------------------------
const LEGACY_VIOLATION_FILES = [
  // crypto.randomUUID() at 2 rpc callsites (notify_* RPCs) — retries can
  // double-insert notifications. Lib code can't use the hook; fix is a
  // caller-supplied key or a module-level keyed cache.
  'src/lib/notificationTriggers.ts',
  // crypto.randomUUID() at 2 callsites (save_field / save_field_geometry) —
  // a timeout-retry during bulk import can double-create fields.
  'src/components/fields/BulkFieldImport.tsx',
  // Deterministic template key `cancel_purchase_order:{user}:{po.id}` —
  // retry-safe (entity-scoped) but not hook-based; migrate or keep + exempt.
  'src/pages/PurchaseOrders.tsx',
  // Deterministic template key `reports-commission-pay-{ids}` — same class.
  'src/pages/Reports.tsx',
  // Per-click crypto.randomUUID() ×3 — the in-file "F2 fix" comment documents
  // WHY the hook is avoided (one cached key per mount collides across rows),
  // but a timeout-retry still double-executes. Correct fix: a per-row keyed
  // ref cache (see Rebates.tsx transitionKeysRef pattern), then delete this.
  'src/pages/IntegrityCleanup.tsx',
];

/** Unwrap TS assertion/parenthesis/chain wrappers around an expression. */
function unwrap(expr) {
  while (
    expr &&
    (expr.type === 'TSAsExpression' ||
      expr.type === 'TSNonNullExpression' ||
      expr.type === 'TSTypeAssertion' ||
      expr.type === 'TSSatisfiesExpression' ||
      expr.type === 'ChainExpression' ||
      expr.type === 'ParenthesizedExpression')
  ) {
    expr = expr.expression;
  }
  return expr;
}

const UUID_CALLEES = new Set(['randomUUID', 'uuid', 'uuidv4', 'v4', 'nanoid']);

/**
 * Classify an expression:
 *   'banned'  — provably a fresh/static key minted at the callsite
 *   'allowed' — provably hook-derived (`.getKey()` / `getKey()`)
 *   'neutral' — anything else (params, data members, cache reads, ...)
 */
function classify(expr, findVar, scope, seen = new Set()) {
  expr = unwrap(expr);
  if (!expr) return 'neutral';

  switch (expr.type) {
    case 'TemplateLiteral':
      return 'banned';
    case 'Literal':
      return typeof expr.value === 'string' ? 'banned' : 'neutral';
    case 'BinaryExpression':
      // string concatenation = key built at the callsite
      return expr.operator === '+' ? 'banned' : 'neutral';
    case 'CallExpression': {
      const callee = expr.callee;
      if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        const prop = callee.property.name;
        const obj = unwrap(callee.object);
        if (prop === 'getKey') return 'allowed'; // xxxIdem.getKey()
        if (obj && obj.type === 'Identifier' && obj.name === 'crypto' && prop === 'randomUUID') {
          return 'banned';
        }
        if (obj && obj.type === 'Identifier' && obj.name === 'Date' && prop === 'now') {
          return 'banned';
        }
        if (
          (prop === 'getTime' || prop === 'valueOf' || prop === 'toISOString') &&
          obj &&
          obj.type === 'NewExpression' &&
          obj.callee.type === 'Identifier' &&
          obj.callee.name === 'Date'
        ) {
          return 'banned';
        }
        return 'neutral';
      }
      if (callee.type === 'Identifier') {
        if (callee.name === 'getKey') return 'allowed'; // destructured from the hook
        if (UUID_CALLEES.has(callee.name)) return 'banned';
        // fresh key per call — must be cached via useIdempotencyKey/ref instead
        if (callee.name === 'generateIdempotencyKey') return 'banned';
      }
      return 'neutral';
    }
    case 'ConditionalExpression': {
      const a = classify(expr.consequent, findVar, scope, seen);
      const b = classify(expr.alternate, findVar, scope, seen);
      if (a === 'banned' && b === 'banned') return 'banned';
      if (a === 'allowed' && b === 'allowed') return 'allowed';
      return 'neutral';
    }
    case 'LogicalExpression': {
      const a = classify(expr.left, findVar, scope, seen);
      const b = classify(expr.right, findVar, scope, seen);
      if (a === 'banned' && b === 'banned') return 'banned';
      return 'neutral';
    }
    case 'Identifier': {
      if (seen.has(expr.name)) return 'neutral'; // cycle guard
      seen.add(expr.name);
      const variable = findVar(scope, expr.name);
      if (!variable) return 'neutral';

      const writes = [];
      for (const def of variable.defs) {
        if (def.type === 'Variable' && def.node.type === 'VariableDeclarator') {
          // Destructured bindings (e.g. `const { getKey } = useIdempotencyKey(...)`)
          // have an ObjectPattern id — treat the binding itself as neutral.
          if (def.node.id.type !== 'Identifier') return 'neutral';
          if (def.node.init) writes.push(def.node.init);
        } else {
          return 'neutral'; // parameter, import, catch clause, ...
        }
      }
      for (const ref of variable.references) {
        if (ref.writeExpr && !writes.includes(ref.writeExpr)) writes.push(ref.writeExpr);
      }
      if (writes.length === 0) return 'neutral';

      const kinds = writes.map((w) => classify(w, findVar, scope, seen));
      if (kinds.every((k) => k === 'banned')) return 'banned';
      if (kinds.every((k) => k === 'allowed')) return 'allowed';
      return 'neutral';
    }
    default:
      return 'neutral';
  }
}

/** Find a variable by name walking up the scope chain. */
function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const found = s.variables.find((v) => v.name === name);
    if (found) return found;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'p_idempotency_key must come from useIdempotencyKey().getKey() — never a fresh crypto.randomUUID()/Date.now()/template key minted at the callsite',
    },
    messages: {
      freshKey:
        'p_idempotency_key is minted fresh at the callsite ({{ what }}). A retry after a network ' +
        'timeout sends a DIFFERENT key, so the server dedup never matches and the mutation ' +
        'executes TWICE (financial-reversal double-execution class). Use the useIdempotencyKey() ' +
        'hook: `const xIdem = useIdempotencyKey(\'op\', profile.id)` then pass `xIdem.getKey()` ' +
        'and call `xIdem.resetKey()` only on confirmed success.',
    },
    schema: [],
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename()).replace(/\\/g, '/');
    if (LEGACY_VIOLATION_FILES.some((f) => filename.endsWith(f))) {
      return {};
    }

    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      Property(node) {
        const key = node.key;
        const isIdemKey =
          (key.type === 'Identifier' && key.name === 'p_idempotency_key') ||
          (key.type === 'Literal' && key.value === 'p_idempotency_key');
        if (!isIdemKey || node.value.type === 'ObjectPattern') return;

        const scope = sourceCode.getScope(node.value);
        const kind = classify(node.value, findVariable, scope);
        if (kind !== 'banned') return;

        const text = sourceCode.getText(node.value);
        context.report({
          node: node.value,
          messageId: 'freshKey',
          data: { what: text.length > 60 ? text.slice(0, 57) + '...' : text },
        });
      },
    };
  },
};
