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
  const rpc = new RegExp(`\\.rpc\\(\\s*(['"])${escapeRegExp(name)}\\1`, 'g');
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
