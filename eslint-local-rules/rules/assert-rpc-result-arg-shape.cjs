// C6 control (docs/audits/2026-06-10-error-prevention-review.md §4 C6).
//
// Catches the 2026-05-28 P1B bug class: calling
//
//   const result = await supabase.rpc('some_rpc', {...});
//   assertRpcResult(result, 'some_rpc');          // BUG — whole {data,error} response
//
// instead of
//
//   const { data, error } = await supabase.rpc('some_rpc', {...});
//   assertRpcResult(data, 'some_rpc');            // correct — unwrapped data
//
// When the whole response object is passed, assertRpcResult's null/undefined
// check always passes (the response envelope is always truthy), so the guard
// silently becomes a no-op and RLS-denied nulls flow into the UI.
//
// Heuristic (tuned against the real codebase 2026-06-10, zero false positives):
//   FLAG when the first argument is...
//     (a) an identifier whose declaration/assignment is `= await supabase.rpc(...)`
//         (or any `.rpc(...)` chain, e.g. `.rpc(...).throwOnError()`) bound as a
//         PLAIN identifier — i.e. the whole response envelope;
//     (b) an inline `await supabase.rpc(...)` expression;
//     (c) an inline object literal containing BOTH `data` and `error` keys.
//   ALLOW everything else — destructured bindings (`const { data } = ...`,
//   `const { data: alias } = ...`), member expressions (`result.data`),
//   function parameters, and anything the rule cannot resolve. Fail-open is
//   deliberate: the companion safety-net test (assertRpcCoverage.test.ts)
//   covers the "forgot to assert at all" class; this rule only needs to make
//   the specific envelope-instead-of-data mistake unwritable without noise.

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

/**
 * True when `expr` is (or terminates in) a `.rpc(...)` member call —
 * `supabase.rpc(...)`, `supabase.rpc(...).throwOnError()`,
 * `supabase.rpc(...).single()`, etc.
 */
function isRpcChainCall(expr) {
  let cur = unwrap(expr);
  while (cur) {
    if (cur.type === 'AwaitExpression') {
      cur = cur.argument;
    } else if (cur.type === 'CallExpression') {
      const callee = cur.callee;
      if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'rpc'
      ) {
        return true;
      }
      cur = callee.type === 'MemberExpression' ? callee.object : null;
    } else if (cur.type === 'MemberExpression') {
      cur = cur.object;
    } else {
      return false;
    }
  }
  return false;
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
        'assertRpcResult() first argument must be the unwrapped rpc data, never the whole {data,error} response',
    },
    messages: {
      wholeResponse:
        'assertRpcResult() received the WHOLE supabase.rpc() response ("{{ name }}" is bound to ' +
        '`await supabase.rpc(...)` — the {data,error} envelope). The envelope is always truthy, ' +
        'so the guard silently becomes a no-op (2026-05-28 P1B). Destructure first: ' +
        "`const { data, error } = await supabase.rpc(...)` then `assertRpcResult(data, 'rpc_name')`.",
      inlineResponse:
        'assertRpcResult() received an inline `await supabase.rpc(...)` call — that is the whole ' +
        '{data,error} envelope, so the guard is a no-op (2026-05-28 P1B). Destructure first and ' +
        'pass only `data`.',
      dataErrorPair:
        'assertRpcResult() received an object literal with both `data` and `error` keys — the ' +
        'response envelope shape. Pass only the unwrapped `data` (2026-05-28 P1B).',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'Identifier' || callee.name !== 'assertRpcResult') return;

        const rawArg = node.arguments[0];
        if (!rawArg) return;
        const arg = unwrap(rawArg);

        // (b) inline `await supabase.rpc(...)` (or bare `supabase.rpc(...)` chain)
        if (arg.type === 'AwaitExpression' || arg.type === 'CallExpression') {
          if (isRpcChainCall(arg)) {
            context.report({ node: rawArg, messageId: 'inlineResponse' });
          }
          return;
        }

        // (c) inline `{ data, error }` pair
        if (arg.type === 'ObjectExpression') {
          const keys = new Set(
            arg.properties
              .filter((p) => p.type === 'Property' && p.key)
              .map((p) => (p.key.type === 'Identifier' ? p.key.name : p.key.value))
          );
          if (keys.has('data') && keys.has('error')) {
            context.report({ node: rawArg, messageId: 'dataErrorPair' });
          }
          return;
        }

        // (a) identifier bound (declared OR later assigned) to a whole rpc response
        if (arg.type !== 'Identifier') return; // member expressions (`x.data`) etc. — allowed

        const variable = findVariable(sourceCode.getScope(node), arg.name);
        if (!variable) return; // unresolved (import/global) — fail open

        // Declared as a plain identifier whose init is an rpc chain?
        for (const def of variable.defs) {
          if (
            def.type === 'Variable' &&
            def.node.type === 'VariableDeclarator' &&
            def.node.id.type === 'Identifier' && // ObjectPattern destructuring is the CORRECT shape
            def.node.init &&
            isRpcChainCall(def.node.init)
          ) {
            context.report({ node: rawArg, messageId: 'wholeResponse', data: { name: arg.name } });
            return;
          }
        }

        // Re-assigned later (`let x; x = await supabase.rpc(...)`)?
        // Only DIRECT assignments to the bare identifier count — destructured
        // declarations (`const { data } = await supabase.rpc(...)`) also carry a
        // writeExpr pointing at the init, but that binding is the CORRECT shape.
        for (const ref of variable.references) {
          if (!ref.writeExpr || !isRpcChainCall(ref.writeExpr)) continue;
          const parent = ref.identifier.parent;
          if (
            parent &&
            parent.type === 'AssignmentExpression' &&
            parent.left === ref.identifier
          ) {
            context.report({ node: rawArg, messageId: 'wholeResponse', data: { name: arg.name } });
            return;
          }
        }
      },
    };
  },
};
