function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

// Surface only literal application .rpc('routine_name') call sites. Routine
// names are PostgreSQL identifiers, not regular expressions: quoting their
// text prevents `$`, `[`, `^`, and other valid identifier characters from
// changing the evidence query itself.
export function applicationRpcCallSites(name, snapshot) {
  const files = [
    ...snapshot.paths('src/', (relative) => /\.(?:ts|tsx)$/.test(relative) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relative)),
    ...snapshot.paths('supabase/functions/', (relative) => /\.(?:ts|tsx)$/.test(relative) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(relative)),
  ];
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
    for (const match of text.matchAll(rpc)) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      const excerpt = text.split(/\r?\n/)[line - 1]?.trim() || '(call spans lines)';
      const source = file.startsWith('supabase/functions/') ? 'edge-function' : 'frontend';
      sites.push(`  ${source} RPC: ${file}:${line}\n    ${excerpt}`);
    }
  }
  return sites;
}
