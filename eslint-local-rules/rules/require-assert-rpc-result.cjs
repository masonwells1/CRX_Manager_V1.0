/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require assertRpcResult() when using data from supabase.rpc() calls',
    },
    messages: {
      missingAssert:
        'RPC "{{ rpcName }}" data is used without assertRpcResult(). ' +
        'Supabase returns null (not an error) when RLS denies an RPC call. ' +
        'Wrap with: assertRpcResult<Type>(data, \'{{ rpcName }}\')',
    },
    schema: [],
  },
  create(context) {
    const scopeStack = [];

    function currentScope() {
      return scopeStack[scopeStack.length - 1];
    }

    function pushScope() {
      scopeStack.push({ rpcDataVars: new Map(), hasAssertCall: new Set() });
    }

    function popScope() {
      const scope = scopeStack.pop();
      if (!scope) return;
      for (const [varName, { node, rpcName }] of scope.rpcDataVars) {
        if (!scope.hasAssertCall.has(varName)) {
          context.report({ node, messageId: 'missingAssert', data: { rpcName } });
        }
      }
    }

    return {
      FunctionDeclaration() { pushScope(); },
      'FunctionDeclaration:exit'() { popScope(); },
      FunctionExpression() { pushScope(); },
      'FunctionExpression:exit'() { popScope(); },
      ArrowFunctionExpression() { pushScope(); },
      'ArrowFunctionExpression:exit'() { popScope(); },

      VariableDeclarator(node) {
        const scope = currentScope();
        if (!scope) return;

        const init = node.init;
        if (!init) return;

        const callExpr = init.type === 'AwaitExpression' ? init.argument : init;
        if (!callExpr || callExpr.type !== 'CallExpression') return;

        const callee = callExpr.callee;
        if (
          !callee ||
          callee.type !== 'MemberExpression' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'rpc'
        ) return;

        const rpcNameArg = callExpr.arguments[0];
        const rpcName =
          rpcNameArg && rpcNameArg.type === 'Literal'
            ? String(rpcNameArg.value)
            : '<dynamic>';

        if (node.id.type !== 'ObjectPattern') return;

        for (const prop of node.id.properties) {
          if (prop.type !== 'Property') continue;
          const key = prop.key;
          if (key.type === 'Identifier' && key.name === 'data') {
            const localName =
              prop.value.type === 'Identifier' ? prop.value.name : 'data';
            scope.rpcDataVars.set(localName, { node: prop, rpcName });
          }
        }
      },

      CallExpression(node) {
        const scope = currentScope();
        if (!scope) return;

        const callee = node.callee;
        if (!callee || callee.type !== 'Identifier' || callee.name !== 'assertRpcResult') return;

        const firstArg = node.arguments[0];
        if (firstArg && firstArg.type === 'Identifier') {
          scope.hasAssertCall.add(firstArg.name);
        }
      },
    };
  },
};
