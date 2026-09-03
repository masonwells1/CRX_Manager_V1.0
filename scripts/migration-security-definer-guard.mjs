// A migration that creates SECURITY DEFINER code must visibly remove both
// inherited PUBLIC and CRX's explicit anon EXECUTE grants. Unknown syntax and
// unterminated SQL fail closed rather than becoming an ACL bypass.
export const CREATE_FN_ANY = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?(\w+)"?\s*\(/gi;
const SECURITY_DEFINER_CREATE = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:public\s*\.\s*)(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;
const SECURITY_DEFINER_ALTER = /ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;
const SECURITY_DEFINER_ROUTINE_HEADER = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)|ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE))\s+/gi;

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
      if (/\bDO\b[^;]*$/i.test(out)) return null;
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
        // Dynamic SQL in a DO block can alter ACLs without leaving an
        // analyzable GRANT/REVOKE statement. Lex its body recursively so an
        // EXECUTE keyword inside a quoted diagnostic string is inert, while a
        // real PL/pgSQL EXECUTE fails this static proof closed.
        if (/\bDO\b[^;]*$/i.test(out)) {
          const doBody = executableSql(src.slice(i + tag[0].length, close));
          if (doBody === null || /\bEXECUTE\b/i.test(doBody)) return null;
        }
        out = blank(out, end - i); i = end; continue;
      }
    }
    if (ch === '"') {
      let end = i + 1;
      while (end < src.length) {
        if (src[end] === '"' && src[end + 1] === '"') { end += 2; continue; }
        if (src[end] === '"') break;
        end++;
      }
      if (end === src.length) return null;
      // A quoted identifier is executable syntax, but its contents are not SQL
      // keywords. Break action words without losing deterministic identity for a
      // matching quoted routine declaration and ACL target.
      out += src.slice(i, end + 1).replace(/\b(?:REVOKE|GRANT|CREATE|ALTER|DROP|SECURITY|DO)\b/gi, (word) => `\u0001${word.slice(1)}`);
      i = end + 1; continue;
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

function statementEnd(text, start) {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') { i += 2; continue; }
        if (text[i] === '"') break;
        i++;
      }
      if (i === text.length) return null;
    } else if (text[i] === ';') return i;
  }
  return text.length;
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

function canonicalSignature(name, args, declaration = false, quoted = false) {
  if (args.includes('"')) return null;
  const types = splitArgs(args).map((arg) => {
    let value = arg.replace(/\bDEFAULT\b[\s\S]*$/i, '').replace(/\s*=\s*[\s\S]*$/, '').trim();
    if (declaration) value = value.replace(/^(?:IN|OUT|INOUT|VARIADIC)\s+/i, '').replace(/^(?:p_[A-Za-z0-9_]*|arg_[A-Za-z0-9_]*)\s+/i, '');
    return value.replace(/\s+/g, ' ').replaceAll('"', '').toLowerCase();
  });
  const canonicalName = quoted ? `quoted:${name.replaceAll('""', '"')}` : `bare:${name.toLowerCase()}`;
  return `${canonicalName}(${types.join(',')})`;
}

function aclEvents(sql) {
  const events = [];
  const re = /\b(REVOKE|GRANT)\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;
  for (const match of sql.matchAll(re)) {
    const open = match.index + match[0].length - 1;
    const args = balanced(sql, open);
    if (!args) return null;
    const roles = /^\s+(?:FROM|TO)\s+([^;]+);/i.exec(sql.slice(args.end));
    if (!roles || /\b(?:WITH|GROUP|ROLE|GRANTED\s+BY)\b/i.test(roles[1])) return null;
    const signature = canonicalSignature(match[2] || match[3], args.text, false, Boolean(match[2]));
    if (!signature) return null;
    const roleNames = roles[1].split(',').map((role) => role.trim());
    if (roleNames.some((role) => role.includes('"'))) return null;
    events.push({ index: match.index, action: match[1].toLowerCase(), signature, roles: roleNames.map((value) => {
      if (/^public$/i.test(value)) return 'public';
      if (/^anon$/i.test(value)) return 'anon';
      return null;
    }) });
  }
  // Schema-wide grants, default privileges, and unfamiliar GRANT/REVOKE forms
  // can restore effective execution without appearing in a function-specific
  // event. The producer has no live ACL graph, so reject them rather than guess.
  if ((sql.match(/\b(?:GRANT|REVOKE)\b/gi) || []).length !== events.length) return null;
  return events;
}

function dropRoutineEvents(sql) {
  const events = [];
  const re = /\bDROP\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:IF\s+EXISTS\s+)?(?:public\s*\.\s*)(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;
  for (const match of sql.matchAll(re)) {
    const open = match.index + match[0].length - 1;
    const args = balanced(sql, open);
    if (!args) return null;
    const signature = canonicalSignature(match[1] || match[2], args.text, false, Boolean(match[1]));
    if (!signature) return null;
    events.push({ index: match.index, signature });
  }
  if ((sql.match(/\bDROP\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b/gi) || []).length !== events.length) return null;
  return events;
}

export function securityDefinerMissingAnonRevokes(sql) {
  const executable = executableSql(sql);
  if (executable === null) return ['unparseable-security-definer-sql'];
  if (/\bALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b[\s\S]*?\bOWNER\s+TO\b/i.test(executable)) return ['unparseable-security-definer-sql'];
  const declarations = [
    ...executable.matchAll(SECURITY_DEFINER_CREATE).map((match) => ({ match, kind: 'create' })),
    ...executable.matchAll(SECURITY_DEFINER_ALTER).map((match) => ({ match, kind: 'alter' })),
  ].sort((a, b) => a.match.index - b.match.index);
  const declarationOffsets = new Set(declarations.map(({ match }) => match.index));
  for (const header of executable.matchAll(SECURITY_DEFINER_ROUTINE_HEADER)) {
    const end = executable.indexOf(';', header.index + header[0].length);
    const statement = executable.slice(header.index, end === -1 ? executable.length : end);
    if (/\bSECURITY\s+DEFINER\b/i.test(statement) && !declarationOffsets.has(header.index)) {
      return ['unparseable-security-definer-sql'];
    }
  }
  const lifecycle = [];
  for (let index = 0; index < declarations.length; index++) {
    const { match: declaration, kind } = declarations[index];
    const args = balanced(executable, declaration.index + declaration[0].length - 1);
    if (!args) return ['unparseable-security-definer-sql'];
    const end = statementEnd(executable, args.end);
    if (end === null) return ['unparseable-security-definer-sql'];
    const name = declaration[1] || declaration[2];
    const definition = executable.slice(declaration.index, end);
    const signature = canonicalSignature(name, args.text, kind === 'create', Boolean(declaration[1]));
    if (!signature) return ['unparseable-security-definer-sql'];
    if (/\bSECURITY\s+DEFINER\b/i.test(definition)) lifecycle.push({
      index: declaration.index,
      action: 'declare',
      signature,
      name: name.replaceAll('""', '"'),
    });
  }
  const acl = aclEvents(executable);
  const drops = dropRoutineEvents(executable);
  if (acl === null || drops === null) return ['unparseable-security-definer-sql'];
  lifecycle.push(...acl.map(({ action, ...event }) => ({ ...event, action: 'acl', aclAction: action })), ...drops.map((event) => ({ ...event, action: 'drop' })));
  lifecycle.sort((a, b) => a.index - b.index);
  const state = new Map();
  for (const event of lifecycle) {
    if (event.action === 'declare') state.set(event.signature, { name: event.name, roles: new Map() });
    else if (event.action === 'drop') state.delete(event.signature);
    else {
      const routine = state.get(event.signature);
      if (!routine) continue;
      for (const role of event.roles) if (role === 'public' || role === 'anon') routine.roles.set(role, event.aclAction === 'revoke');
    }
  }
  return [...state.values()]
    .filter(({ roles }) => roles.get('public') !== true || roles.get('anon') !== true)
    .map(({ name }) => name);
}
