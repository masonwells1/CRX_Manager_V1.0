// A migration that creates SECURITY DEFINER code must visibly remove both
// inherited PUBLIC and CRX's explicit anon EXECUTE grants. Unknown syntax and
// unterminated SQL fail closed rather than becoming an ACL bypass.
export const CREATE_FN_ANY = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?(\w+)"?\s*\(/gi;
const SECURITY_DEFINER_CREATE = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;

function blank(out, count) { return out + ' '.repeat(count); }

// Preserve executable tokens and quoted identifiers, but blank comments and all
// data literals. A revoke in prose, a string, or a function body cannot satisfy
// an apply-time ACL check. Null means malformed SQL and fails closed.
function executableSql(sql) {
  const src = String(sql || ''); let out = '';
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    const escape = (ch === 'e' || ch === 'E') && src[i + 1] === "'" && !/[A-Za-z0-9_$]/.test(src[i - 1] || '');
    if (ch === '-' && src[i + 1] === '-') {
      let end = i + 2; while (end < src.length && src[end] !== '\n' && src[end] !== '\r') end++;
      out = blank(out, end - i); i = end; continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      let depth = 1, end = i + 2;
      while (end < src.length && depth) {
        if (src[end] === '/' && src[end + 1] === '*') { depth++; end += 2; }
        else if (src[end] === '*' && src[end + 1] === '/') { depth--; end += 2; }
        else end++;
      }
      if (depth) return null;
      out = blank(out, end - i); i = end; continue;
    }
    if (ch === "'" || escape) {
      let end = i + (escape ? 2 : 1);
      while (end < src.length) {
        if (escape && src[end] === '\\') { end += 2; continue; }
        if (src[end] === "'" && src[end + 1] === "'") { end += 2; continue; }
        if (src[end] === "'") { end++; break; }
        end++;
      }
      if (end > src.length || src[end - 1] !== "'") return null;
      out = blank(out, end - i); i = end; continue;
    }
    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (tag) {
        const close = src.indexOf(tag[0], i + tag[0].length);
        if (close === -1) return null;
        const end = close + tag[0].length;
        out = blank(out, end - i); i = end; continue;
      }
    }
    if (ch === '"') {
      let end = i + 1; while (end < src.length && src[end] !== '"') end++;
      if (end === src.length) return null;
      out += src.slice(i, end + 1); i = end + 1; continue;
    }
    out += ch; i++;
  }
  return out;
}

function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return { text: text.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

function splitArgs(args) {
  const parts = []; let start = 0, depth = 0;
  for (let i = 0; i <= args.length; i++) {
    if (args[i] === '(') depth++;
    else if (args[i] === ')') depth--;
    else if ((args[i] === ',' && depth === 0) || i === args.length) { parts.push(args.slice(start, i)); start = i + 1; }
  }
  return parts;
}

function canonicalSignature(name, args, declaration = false) {
  const types = splitArgs(args).map((arg) => {
    let value = arg.replace(/\bDEFAULT\b[\s\S]*$/i, '').replace(/\s*=\s*[\s\S]*$/, '').trim();
    if (declaration) value = value.replace(/^(?:IN|OUT|INOUT|VARIADIC)\s+/i, '').replace(/^(?:p_[A-Za-z0-9_]*|arg_[A-Za-z0-9_]*)\s+/i, '');
    return value.replace(/\s+/g, ' ').replaceAll('"', '').toLowerCase();
  });
  return `${name.toLowerCase()}(${types.join(',')})`;
}

function aclEvents(sql) {
  const events = [];
  const re = /\b(REVOKE|GRANT)\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+FUNCTION\s+(?:"?public"?\s*\.\s*)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;
  for (const match of sql.matchAll(re)) {
    const open = match.index + match[0].length - 1;
    const args = balanced(sql, open);
    if (!args) return null;
    const roles = /^\s+(?:FROM|TO)\s+([^;]+);/i.exec(sql.slice(args.end));
    if (!roles || /\b(?:WITH|GROUP|ROLE)\b/i.test(roles[1])) return null;
    events.push({ action: match[1].toLowerCase(), signature: canonicalSignature(match[2] || match[3], args.text), roles: roles[1].split(',').map((r) => r.trim().replaceAll('"', '').toLowerCase()) });
  }
  // Schema-wide grants, default privileges, and unfamiliar GRANT/REVOKE forms
  // can restore effective execution without appearing in a function-specific
  // event. The producer has no live ACL graph, so reject them rather than guess.
  if ((sql.match(/\b(?:GRANT|REVOKE)\b/gi) || []).length !== events.length) return null;
  return events;
}

export function securityDefinerMissingAnonRevokes(sql) {
  const executable = executableSql(sql);
  if (executable === null) return ['unparseable-security-definer-sql'];
  const declarations = [...executable.matchAll(SECURITY_DEFINER_CREATE)];
  const required = new Map();
  for (let index = 0; index < declarations.length; index++) {
    const declaration = declarations[index];
    const args = balanced(executable, declaration.index + declaration[0].length - 1);
    if (!args) return ['unparseable-security-definer-sql'];
    const end = declarations[index + 1]?.index ?? executable.length;
    const name = declaration[1] || declaration[2];
    if (/\bSECURITY\s+DEFINER\b/i.test(executable.slice(declaration.index, end))) required.set(canonicalSignature(name, args.text, true), name);
  }
  const events = aclEvents(executable);
  if (events === null) return ['unparseable-security-definer-sql'];
  const state = new Map([...required.keys()].map((signature) => [signature, new Map()]));
  for (const event of events) {
    const roles = state.get(event.signature);
    if (!roles) continue;
    for (const role of event.roles) if (role === 'public' || role === 'anon') roles.set(role, event.action === 'revoke');
  }
  return [...required.entries()]
    .filter(([signature]) => state.get(signature).get('public') !== true || state.get(signature).get('anon') !== true)
    .map(([, name]) => name);
}
