// This proof helper intentionally uses only Node builtins. Loading a parser from
// ignored node_modules would put executable, unverified code outside the proof
// boundary. It recognizes the narrow RPC surface and withholds proof for every
// indirect, dynamic, or malformed form.

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

function maskedCode(text) {
  // Only comments need removing before the narrow access matcher runs. Keeping
  // literals intact lets the matcher read its first argument without attempting
  // to parse JSX, regular expressions, or every template-expression grammar.
  return String(text).replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, ' '));

  /* c8 ignore next -- retained defensive lexer documentation below */
  let out = '';
  const blank = (start, end) => text.slice(start, end).replace(/[^\r\n]/g, ' ');
  for (let index = 0; index < text.length;) {
    if (text[index] === '/' && text[index + 1] === '/') {
      const end = text.slice(index).search(/[\r\n]/);
      const finish = end === -1 ? text.length : index + end;
      out += blank(index, finish); index = finish; continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const finish = text.indexOf('*/', index + 2);
      if (finish === -1) return null;
      out += blank(index, finish + 2); index = finish + 2; continue;
    }
    if (text[index] === '/' && /(?:^|[=(:,;[!{?])\s*$/.test(out)) {
      const start = index++; let inClass = false;
      for (; index < text.length; index++) {
        if (text[index] === '\\') { index++; continue; }
        if (text[index] === '[') { inClass = true; continue; }
        if (text[index] === ']') { inClass = false; continue; }
        if (text[index] === '/' && !inClass) break;
      }
      if (index >= text.length) return null;
      index++; while (/[A-Za-z]/.test(text[index] || '')) index++;
      out += blank(start, index); continue;
    }
    if (["'", '"', '`'].includes(text[index])) {
      const start = index; const quote = text[index++];
      for (; index < text.length; index++) {
        if (text[index] === '\\') { index++; continue; }
        if (text[index] === quote) break;
      }
      if (index >= text.length) return null;
      out += blank(start, index + 1); index++; continue;
    }
    out += text[index++];
  }
  return out;
}

function skipTrivia(text, index) {
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    if (text[index] === '/' && text[index + 1] === '/') {
      index += 2; while (index < text.length && !/[\r\n]/.test(text[index])) index++;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) return null;
      index = end + 2; continue;
    }
    return index;
  }
  return index;
}

function staticStringAt(text, index) {
  const start = skipTrivia(text, index);
  if (start === null || !['\'', '"', '`'].includes(text[start])) return null;
  const quote = text[start]; let value = '';
  for (let cursor = start + 1; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') { if (cursor + 1 >= text.length) return null; value += text[++cursor]; continue; }
    if (quote === '`' && text[cursor] === '$' && text[cursor + 1] === '{') return null;
    if (text[cursor] === quote) return { value, end: cursor + 1 };
    value += text[cursor];
  }
  return null;
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function snapshotRpcUses(snapshot) {
  const uses = [];
  for (const file of applicationSourceFiles(snapshot)) {
    const text = snapshot.text(file);
    const code = maskedCode(text);
    const reported = new Set();
    const addUnresolved = (index) => {
      if (reported.has(index)) return;
      reported.add(index); uses.push({ file, text, index, routine: null, unresolved: true });
    };
    if (code === null) { addUnresolved(0); continue; }
    const aliases = new Set(['client', 'supabase', 'db', 'adminClient']);
    let changed = true;
    while (changed) {
      changed = false;
      const sourceNames = [...aliases].map(escapeRegex).join('|');
      const declarations = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=;{}]+)?=\\s*(?:\\(\\s*)?(${sourceNames})\\b`, 'g');
      for (const match of code.matchAll(declarations)) if (!aliases.has(match[1])) { aliases.add(match[1]); changed = true; }
    }
    const sourceNames = [...aliases].map(escapeRegex).join('|');
    const destructuring = new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\brpc\\b[^}]*\\}\\s*=\\s*(?:${sourceNames})\\b`, 'g');
    for (const match of code.matchAll(destructuring)) addUnresolved(match.index + match[0].indexOf('rpc'));
    for (const alias of aliases) {
      const escaped = escapeRegex(alias);
      const reflect = new RegExp(`\\bReflect\\s*\\.\\s*get\\s*\\(\\s*${escaped}\\b`, 'g');
      for (const match of code.matchAll(reflect)) addUnresolved(match.index);
      const access = new RegExp(`\\b${escaped}\\s*(?:\\?\\.|\\.)\\s*rpc\\b`, 'g');
      for (const match of code.matchAll(access)) {
        const index = match.index; let cursor = index + match[0].length;
        cursor = skipTrivia(text, cursor);
        if (cursor === null) { addUnresolved(index); continue; }
        if (text.startsWith('?.', cursor)) cursor = skipTrivia(text, cursor + 2);
        while (text[cursor] === ')') cursor = skipTrivia(text, cursor + 1);
        if (cursor === null || text[cursor] !== '(') { addUnresolved(index); continue; }
        const routine = staticStringAt(text, cursor + 1);
        if (routine === null) addUnresolved(index);
        else uses.push({ file, text, index, routine: routine.value, unresolved: false });
      }
      const computed = new RegExp(`\\b${escaped}\\s*\\[`, 'g');
      for (const match of code.matchAll(computed)) {
        const index = match.index; const key = staticStringAt(text, index + match[0].length);
        const close = key && skipTrivia(text, key.end);
        if (key === null || key.value !== 'rpc' || close === null || text[close] !== ']') { addUnresolved(index); continue; }
        let cursor = skipTrivia(text, close + 1);
        if (text.startsWith('?.', cursor)) cursor = skipTrivia(text, cursor + 2);
        while (text[cursor] === ')') cursor = skipTrivia(text, cursor + 1);
        if (cursor === null || text[cursor] !== '(') { addUnresolved(index); continue; }
        const routine = staticStringAt(text, cursor + 1);
        if (routine === null) addUnresolved(index);
        else uses.push({ file, text, index, routine: routine.value, unresolved: false });
      }
    }
  }
  return uses;
}

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
