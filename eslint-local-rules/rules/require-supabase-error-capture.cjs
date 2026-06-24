/**
 * require-supabase-error-capture — a supabase `.from()`/`.storage` read that takes
 * `data` MUST also destructure `error`, so the failure path can be handled.
 *
 * The sibling rule `handle-supabase-error` flags an `error` that is destructured but
 * never handled. This rule closes the OTHER half of that gap: `error` never even
 * captured, e.g.
 *
 *     const { data: prepayRows } = await supabase.from('prepay_credits').select('balance_cents');
 *     const prepaySum = (prepayRows || []).reduce(...) / 100;   // a failed read → $0
 *
 * That was the AccountsReceivable "Unused Prepay" + Receiving Hub "nothing on order"
 * bug class (2026-06-24): a failed query (RLS / schema drift / transient) silently
 * renders as an empty list or a $0 finance total instead of surfacing an error.
 *
 * Once `error` is captured, `handle-supabase-error` (a sibling rule) takes over and
 * requires it actually be handled — together they force capture AND handling.
 *
 * Scope: `.from()` (DB) and `.storage` chains only — NOT `supabase.rpc(...)` (guarded
 * by `require-assert-rpc-result`). Intentionally enabled per-file (a ratchet): hard
 * `error` on the money screens where a $0 lie costs real money; widen as files are
 * cleaned. See eslint.config.js.
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require capturing `error` (not just `data`) from supabase .from()/.storage reads',
    },
    messages: {
      missingError:
        "Supabase `{{ source }}` returns { data, error } but only `data` was destructured — the " +
        "`error` is dropped entirely, so a failed query (RLS, drift, transient) silently renders as " +
        "an empty list / $0 instead of surfacing the failure (the AccountsReceivable prepay + Receiving " +
        "Hub bugs, 2026-06-24). Capture AND handle it: `const { data, error } = await ...; if (error) throw error;`",
    },
    schema: [
      {
        type: 'object',
        properties: {
          client: { type: 'string' }, // identifier name of the supabase client (default 'supabase')
        },
        additionalProperties: false,
      },
    ],
  },

  create(context) {
    const clientName = (context.options[0] && context.options[0].client) || 'supabase';

    // Walk a call/member chain down to its root identifier, collecting property names.
    function getChain(node) {
      if (!node) return { root: null, props: [] };
      if (node.type === 'Identifier') return { root: node, props: [] };
      if (node.type === 'CallExpression') return getChain(node.callee);
      if (node.type === 'MemberExpression') {
        const inner = getChain(node.object);
        const prop = node.property && node.property.type === 'Identifier' ? node.property.name : null;
        return { root: inner.root, props: inner.props.concat(prop) };
      }
      return { root: null, props: [] };
    }

    // Is this awaited/called expression a supabase .from()/.storage chain (not .rpc)?
    function classify(callExpr) {
      if (!callExpr || callExpr.type !== 'CallExpression') return null;
      const { root, props } = getChain(callExpr.callee);
      if (!root || root.type !== 'Identifier' || root.name !== clientName) return null;
      if (props.includes('rpc')) return null; // covered by require-assert-rpc-result
      if (!props.includes('from')) return null; // .from() (DB) + .storage.from() (storage)
      const source = `${clientName}.${props.filter(Boolean).join('.')}()`;
      return { source };
    }

    return {
      VariableDeclarator(node) {
        const init = node.init;
        if (!init) return;
        const callExpr = init.type === 'AwaitExpression' ? init.argument : init;
        const info = classify(callExpr);
        if (!info) return;
        if (node.id.type !== 'ObjectPattern') return;

        let hasData = false;
        let hasError = false;
        for (const prop of node.id.properties) {
          if (prop.type !== 'Property') continue;
          if (prop.key.type !== 'Identifier') continue;
          if (prop.key.name === 'data') hasData = true;
          if (prop.key.name === 'error') hasError = true;
        }

        // `data` taken but `error` never captured → it cannot be handled, so a failed
        // query silently becomes an empty/zero displayed value.
        if (hasData && !hasError) {
          context.report({ node: node.id, messageId: 'missingError', data: { source: info.source } });
        }
      },
    };
  },
};
