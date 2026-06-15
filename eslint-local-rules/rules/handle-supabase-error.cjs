/**
 * handle-supabase-error — a destructured `error` from a Supabase data/storage call
 * must be HANDLED, not swallowed.
 *
 * Supabase RETURNS errors ({ data, error }) instead of throwing. Two field-proven
 * failure shapes (Field Mode 2026-06-14, F4/F6):
 *   F6  const { data, error } = await supabase.from('x').select(); setRows(data);
 *       → `error` destructured but NEVER inspected; an RLS/query failure renders as
 *         an empty "nothing here" state instead of an error.
 *   F4  const { error } = await supabase.storage.from('b').upload(...);
 *       if (!error) { ...success... }            // no else / no throw
 *       → the error branch is missing; a failed upload is silently lost.
 *
 * The rule flags a destructured `error` (incl. aliased `error: uploadError`) coming
 * from a `supabase.*.from(...)....` or `supabase.storage....` call when EVERY use of
 * that binding is a `!error` negation (i.e. only ever used to gate a success block)
 * or there are no uses at all. Any positive reference — `if (error)`, `throw error`,
 * `error.message`, `toast(error)`, `checkMutationResult({ data, error })`, an `else`
 * branch, a ternary test, etc. — counts as handled and is NOT flagged.
 *
 * Scope: deliberately does NOT cover `supabase.rpc(...)` — its result is guarded by
 * `local-rules/require-assert-rpc-result` (`assertRpcResult(data, ...)`). This rule
 * covers the .from()/.storage gap that rule leaves open.
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require handling the `error` returned (not thrown) by supabase .from()/.storage calls',
    },
    messages: {
      unhandled:
        "Supabase returned-`error` from `{{ source }}` is destructured but never handled. " +
        "Supabase returns { data, error } instead of throwing — an unhandled error renders " +
        "as a wrong empty-state or a silently-lost write. Handle it: `if ({{ name }}) throw {{ name }}` " +
        "/ toast it / `checkMutationResult({ data, error }, '...')`. (An `if (!{{ name }})` success-" +
        "gate with no else does NOT handle the error.)",
    },
    schema: [
      {
        type: 'object',
        properties: {
          // identifier name of the supabase client (default 'supabase')
          client: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
  },

  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();
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
      if (!props.includes('from')) return null; // .from() for DB + .storage.from() for storage
      const source = `${clientName}.${props.filter(Boolean).join('.')}()`;
      return { source };
    }

    const candidates = [];

    return {
      VariableDeclarator(node) {
        const init = node.init;
        if (!init) return;
        const callExpr = init.type === 'AwaitExpression' ? init.argument : init;
        const info = classify(callExpr);
        if (!info) return;
        if (node.id.type !== 'ObjectPattern') return;

        for (const prop of node.id.properties) {
          if (prop.type !== 'Property') continue;
          if (prop.key.type !== 'Identifier' || prop.key.name !== 'error') continue;
          if (prop.value.type !== 'Identifier') continue; // ignore nested patterns
          candidates.push({ declarator: node, name: prop.value.name, reportNode: prop, source: info.source });
        }
      },

      'Program:exit'() {
        for (const c of candidates) {
          const declared = sourceCode.getDeclaredVariables(c.declarator);
          const variable = declared.find((v) => v.name === c.name);
          if (!variable) continue;

          const handled = variable.references.some((ref) => {
            if (!ref.isRead || !ref.isRead()) return false;
            const id = ref.identifier;
            const parent = id.parent;
            // `!error` negation = a success-gate, NOT handling the error itself.
            if (parent && parent.type === 'UnaryExpression' && parent.operator === '!' && parent.argument === id) {
              return false;
            }
            return true; // any other read is positive handling
          });

          if (!handled) {
            context.report({
              node: c.reportNode,
              messageId: 'unhandled',
              data: { source: c.source, name: c.name },
            });
          }
        }
      },
    };
  },
};
