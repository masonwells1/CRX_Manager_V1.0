function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

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

function codeMask(text) {
  const mask = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (current === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    if (current === "'" || current === '"' || current === '`') {
      const quote = current;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index] === quote) break;
        index += 1;
      }
      continue;
    }
    mask[index] = 1;
  }
  return mask;
}

function isStaticRpcLiteral(text, index) {
  const quote = text[index];
  if (quote !== "'" && quote !== '"' && quote !== '`') return false;
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') { cursor += 1; continue; }
    if (quote === '`' && text.startsWith('${', cursor)) return false;
    if (text[cursor] === quote) return true;
  }
  return false;
}

// Surface only literal application .rpc('routine_name') call sites. Routine
// names are PostgreSQL identifiers, not regular expressions: quoting their
// text prevents `$`, `[`, `^`, and other valid identifier characters from
// changing the evidence query itself.
export function applicationRpcCallSites(name, snapshot) {
  const files = applicationSourceFiles(snapshot);
  // JavaScript permits whitespace and comments around a call, optional calls,
  // bracket property access, and static template literals. Treat each of
  // those as a literal caller; interpolated names intentionally remain
  // unprovable rather than being guessed from their template source.
  const trivia = '(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*(?:\\r\\n?|\\n|$))*';
  const routineName = escapeRegExp(name);
  const rpc = new RegExp(
    `(?:\\.\\s*rpc|\\[\\s*(?:'rpc'|"rpc")\\s*\\])${trivia}(?:\\?\\.)?${trivia}\\(${trivia}(?:'${routineName}'|"${routineName}"|\`${routineName}\`)`,
    'g',
  );
  const sites = [];
  for (const file of files) {
    const text = snapshot.text(file);
    const mask = codeMask(text);
    for (const match of text.matchAll(rpc)) {
      if (mask[match.index]) sites.push(lineSite(file, text, match.index));
    }
  }
  return sites;
}

// A dynamic routine-name argument cannot prove which PostgreSQL routine is
// called. Keep those sites separate from literal matches so an empty literal
// match is never presented as evidence that application exposure is absent.
export function unresolvedApplicationRpcCallSites(snapshot) {
  const trivia = '(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*(?:\\r\\n?|\\n|$))*';
  const rpcStart = new RegExp(
    `(?:\\.\\s*rpc|\\[\\s*(?:'rpc'|"rpc")\\s*\\])${trivia}(?:\\?\\.)?${trivia}\\(${trivia}`,
    'g',
  );
  const sites = [];
  for (const file of applicationSourceFiles(snapshot)) {
    const text = snapshot.text(file);
    const mask = codeMask(text);
    for (const match of text.matchAll(rpcStart)) {
      if (!mask[match.index]) continue;
      const argumentIndex = match.index + match[0].length;
      if (!isStaticRpcLiteral(text, argumentIndex)) sites.push(lineSite(file, text, match.index));
    }
  }
  return sites;
}
