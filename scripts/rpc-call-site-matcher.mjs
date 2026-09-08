import ts from 'typescript';

function applicationSourceFiles(snapshot) {
  return [
    ...snapshot.paths('src/', (relative) => /\.(?:ts|tsx)$/.test(relative) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relative)),
    ...snapshot.paths('supabase/functions/', (relative) => /\.(?:ts|tsx)$/.test(relative) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relative)),
  ];
}

function lineSite(file, text, index) {
  const line = text.slice(0, index).split(/\r?\n/).length;
  const excerpt = text.split(/\r?\n/)[line - 1]?.trim() || '(call spans lines)';
  const source = file.startsWith('supabase/functions/') ? 'edge-function' : 'frontend';
  return `  ${source} RPC: ${file}:${line}\n    ${excerpt}`;
}

function staticString(node) {
  if (!node) return null;
  const literal = unwrapExpression(node);
  return ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal) ? literal.text : null;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  return current;
}

function isRpcAccess(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'rpc';
  return ts.isElementAccessExpression(node) && staticString(node.argumentExpression) === 'rpc';
}

function directCallForAccess(access) {
  let parent = access.parent;
  while (
    ts.isParenthesizedExpression(parent)
    || ts.isAsExpression(parent)
    || ts.isTypeAssertionExpression(parent)
    || ts.isNonNullExpression(parent)
  ) parent = parent.parent;
  if (!ts.isCallExpression(parent) || unwrapExpression(parent.expression) !== access) return null;
  return parent;
}

function scriptKind(file) {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function snapshotRpcUses(snapshot) {
  const uses = [];
  for (const file of applicationSourceFiles(snapshot)) {
    const text = snapshot.text(file);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const addUnresolved = (node) => uses.push({
      file,
      text,
      index: node.getStart(source),
      routine: null,
      unresolved: true,
    });
    if (source.parseDiagnostics.length) {
      for (const diagnostic of source.parseDiagnostics) addUnresolved({ getStart: () => diagnostic.start || 0 });
      continue;
    }
    const visit = (node) => {
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isRpcAccess(node)) {
        const call = directCallForAccess(node);
        if (!call) addUnresolved(node);
        else {
          const routine = staticString(call.arguments[0]);
          uses.push({ file, text, index: node.getStart(source), routine, unresolved: routine === null });
        }
      } else if (
        ts.isBindingElement(node)
        && ts.isObjectBindingPattern(node.parent)
        && ((node.propertyName && staticString(node.propertyName) === 'rpc')
          || (!node.propertyName && ts.isIdentifier(node.name) && node.name.text === 'rpc'))
      ) addUnresolved(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return uses;
}

// Surface literal application RPC calls only. Every indirect, dynamic, or
// unparsable access is reported separately and blocks proof production.
export function applicationRpcCallSites(name, snapshot) {
  const literalName = String(name);
  return snapshotRpcUses(snapshot)
    .filter((use) => !use.unresolved && use.routine === literalName)
    .map((use) => lineSite(use.file, use.text, use.index));
}

export function unresolvedApplicationRpcCallSites(snapshot) {
  return snapshotRpcUses(snapshot)
    .filter((use) => use.unresolved)
    .map((use) => lineSite(use.file, use.text, use.index));
}
