/**
 * require-check-mutation-result — a supabase `.update()` / `.delete()` mutation
 * must have its result passed to `checkMutationResult()` (CLAUDE.md Architecture
 * Rule #3: "Use checkMutationResult() after every supabase .update() or .delete()").
 *
 * Supabase RETURNS errors ({ data, error }) instead of throwing. A fire-and-forget
 * mutation — `await supabase.from('t').update({...}).eq('id', id);` as a bare
 * statement — silently swallows an RLS denial or constraint violation: the row was
 * never written, but the UI proceeds as if it was. `checkMutationResult(result, ...)`
 * inspects the envelope and throws on failure.
 *
 * The companion `handle-supabase-error` rule already covers the DESTRUCTURED-error
 * shape (`const { error } = await supabase.from('t').update(...)`). This rule closes
 * the gap that rule leaves open: the result discarded ENTIRELY (no destructure, no
 * checkMutationResult). To avoid double-reporting, this rule deliberately ignores any
 * mutation whose result is destructured (ObjectPattern) — that is `handle-supabase-error`'s.
 *
 * What it flags (conservative — only clearly-discarded results):
 *   - fire-and-forget bare statement: `await supabase.from('t').delete().eq('id', id);`
 *   - captured to a simple var that is then NEVER READ at all (a dead capture):
 *       `const r = await supabase.from('t').update({...});  // r never referenced again`
 *
 * What it allows (NOT reported):
 *   - `const r = await supabase...update(...); checkMutationResult(r, '...')`  (captured + checked)
 *   - `checkMutationResult(await supabase...update(...), '...')`               (inline)
 *   - `const { data, error } = await supabase...update(...)`                   (handle-supabase-error owns it)
 *   - `return await supabase...update(...)` / arrow-body return                (caller checks)
 *   - `const r = await supabase...update(...); if (r.error) throw r.error;`    (handled via member access)
 *   - result read in ANY larger expression / passed to another call           (fail-open; avoid false positives)
 *
 * The captured-variable case is deliberately conservative: a variable read ANYWHERE
 * (member access like `r.error`, passed to a function, returned, etc.) is treated as
 * the result being used — only a capture with NO reads at all is flagged. This keeps
 * the rule free of false positives on the real codebase, where deliberate non-
 * `checkMutationResult` handling (`if (r.error) throw r.error` for zero-rows-valid
 * mutations) is a legitimate pattern.
 *
 * Scope: gated on root identifier === `supabase` + the chain INCLUDES `.from(` (so a
 * plain JS Set/Map/array `.delete()`/`.update()` is never matched) and EXCLUDES `.rpc(`
 * (covered by `require-assert-rpc-result`).
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require checkMutationResult() on the result of a supabase .update()/.delete() mutation',
    },
    messages: {
      discarded:
        'Result of supabase `{{ source }}` is discarded without checkMutationResult(). ' +
        'Supabase returns { data, error } instead of throwing — a fire-and-forget mutation ' +
        'silently swallows an RLS denial or constraint failure (the row is never written, but ' +
        'the UI proceeds as if it was). CLAUDE.md Architecture Rule #3: capture the result and ' +
        "pass it to `checkMutationResult(result, '...')` — or inline `checkMutationResult(await ..., '...')`.",
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
    // (Same shape as handle-supabase-error's getChain.)
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

    // Is this CallExpression a supabase .from(...).update(...)/.delete(...) chain (not .rpc)?
    function classify(callExpr) {
      if (!callExpr || callExpr.type !== 'CallExpression') return null;
      const { root, props } = getChain(callExpr.callee);
      if (!root || root.type !== 'Identifier' || root.name !== clientName) return null;
      if (props.includes('rpc')) return null; // covered by require-assert-rpc-result
      if (!props.includes('from')) return null; // gate: real DB chain, not JS Set/Map/array .delete()
      if (!props.includes('update') && !props.includes('delete')) return null; // mutations only
      const source = `${clientName}.${props.filter(Boolean).join('.')}()`;
      return { source };
    }

    // Walk from a (possibly mid-chain) CallExpression up to the OUTERMOST call of the
    // chain: while the parent is a MemberExpression whose .object is us, ascend; when
    // that member is itself the callee of a CallExpression, that call is the new tail.
    function getOutermostCall(callExpr) {
      let node = callExpr;
      for (;;) {
        const parent = node.parent;
        if (parent && parent.type === 'MemberExpression' && parent.object === node) {
          const grand = parent.parent;
          if (grand && grand.type === 'CallExpression' && grand.callee === parent) {
            node = grand;
            continue;
          }
        }
        return node;
      }
    }

    // Find the supabase mutation chain inside an (awaited) expression, if any.
    // Returns the matched (inner) CallExpression or null.
    function findMutationCall(expr) {
      if (!expr) return null;
      const inner = expr.type === 'AwaitExpression' ? expr.argument : expr;
      if (!inner || inner.type !== 'CallExpression') return null;
      // The classify() helper walks the callee chain, so the SAME info is reachable
      // from any call node in the chain; classify on the inner node directly.
      if (classify(inner)) return inner;
      return null;
    }

    // Pending captured-variable candidates, resolved at Program:exit via scope refs.
    const captured = [];

    return {
      // ── Fire-and-forget: the awaited mutation is a bare ExpressionStatement ──
      ExpressionStatement(node) {
        const expr = node.expression;
        const mutation = findMutationCall(expr);
        if (!mutation) return;
        const outer = getOutermostCall(mutation);
        const info = classify(mutation);
        context.report({ node: outer, messageId: 'discarded', data: { source: info.source } });
      },

      // ── Captured to a variable: defer to Program:exit to check references ──
      VariableDeclarator(node) {
        const mutation = findMutationCall(node.init);
        if (!mutation) return;
        // handle-supabase-error owns the destructured-error shape — never double-report.
        if (node.id.type !== 'Identifier') return;
        const info = classify(mutation);
        captured.push({ declarator: node, name: node.id.name, reportNode: getOutermostCall(mutation), source: info.source });
      },

      'Program:exit'() {
        for (const c of captured) {
          const declared = sourceCode.getDeclaredVariables(c.declarator);
          const variable = declared.find((v) => v.name === c.name);
          if (!variable) continue;

          // Conservative: ANY read of the captured variable (member access like
          // `r.error`, passed to checkMutationResult / another fn, returned, etc.)
          // means the result is being used — exempt it. Only a capture that is NEVER
          // read at all (a truly dead capture) is a clearly-discarded result.
          const everRead = variable.references.some((ref) => ref.isRead && ref.isRead());
          if (everRead) continue;

          context.report({ node: c.reportNode, messageId: 'discarded', data: { source: c.source } });
        }
      },
    };
  },
};
