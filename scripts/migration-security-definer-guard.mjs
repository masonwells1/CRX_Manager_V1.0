// A migration that creates SECURITY DEFINER code must visibly remove both
// inherited PUBLIC and CRX's explicit anon EXECUTE grants. Unknown syntax and
// unterminated SQL fail closed rather than becoming an ACL bypass.
export const CREATE_FN_ANY = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?(\w+)"?\s*\(/gi;
const SECURITY_DEFINER_CREATE = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:public\s*\.\s*)(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;
const SECURITY_DEFINER_ALTER = /ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;
const SECURITY_DEFINER_ROUTINE_HEADER = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)|ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE))\s+/gi;

function blank(out, count) { return out + ' '.repeat(count); }

function isIdentifierCharacter(ch) {
  // PostgreSQL allows non-ASCII letters in unquoted identifiers. Treat every
  // non-ASCII code point as identifier content here: the lexer must never let
  // a dollar quote start in the middle of an identifier it cannot classify.
  return Boolean(ch) && (/[A-Za-z0-9_$]/.test(ch) || ch.codePointAt(0) > 0x7f);
}

function startsKeyword(text, index, keyword) {
  const candidate = text.slice(index, index + keyword.length);
  return candidate.toLowerCase() === keyword
    && !isIdentifierCharacter(text[index - 1])
    && !isIdentifierCharacter(text[index + keyword.length]);
}

function skipWhitespaceAndComments(text, start) {
  let index = start;
  while (index < text.length) {
    if (/\s/.test(text[index])) { index++; continue; }
    if (text[index] === '-' && text[index + 1] === '-') {
      index += 2;
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index++;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      let depth = 1; index += 2;
      while (index < text.length && depth) {
        if (text[index] === '/' && text[index + 1] === '*') { depth++; index += 2; }
        else if (text[index] === '*' && text[index + 1] === '/') { depth--; index += 2; }
        else index++;
      }
      if (depth) return null;
      continue;
    }
    break;
  }
  return index;
}

function readSingleQuotedLiteral(text, start) {
  const quote = text[start] === "'" ? start : ((text[start] === 'e' || text[start] === 'E') && text[start + 1] === "'" ? start + 1 : -1);
  if (quote === -1) return null;
  let value = '';
  for (let index = quote + 1; index < text.length; index++) {
    if (text[index] === "'" && text[index + 1] === "'") { value += "'"; index++; continue; }
    if (text[index] === "'") return { value, end: index + 1 };
    value += text[index];
  }
  return null;
}

function isStandardConformingStringsParameter(text, start) {
  if (startsKeyword(text, start, 'standard_conforming_strings')) return true;
  if (text[start] !== '"') return false;
  let value = '';
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '"' && text[index + 1] === '"') { value += '"'; index++; continue; }
    if (text[index] === '"') return value.toLowerCase() === 'standard_conforming_strings';
    value += text[index];
  }
  return true;
}

function unsafeStandardConformingStringsChange(text, start) {
  if (startsKeyword(text, start, 'set')) {
    let index = skipWhitespaceAndComments(text, start + 3);
    if (index === null) return true;
    if (startsKeyword(text, index, 'local') || startsKeyword(text, index, 'session')) {
      index = skipWhitespaceAndComments(text, index + (startsKeyword(text, index, 'local') ? 5 : 7));
      if (index === null) return true;
    }
    return isStandardConformingStringsParameter(text, index);
  }
  if (!startsKeyword(text, start, 'set_config')) return false;
  let index = skipWhitespaceAndComments(text, start + 'set_config'.length);
  if (index === null || text[index] !== '(') return true;
  index = skipWhitespaceAndComments(text, index + 1);
  if (index === null) return true;
  const setting = readSingleQuotedLiteral(text, index);
  // A dynamic setting name cannot be statically proven not to alter this mode.
  return setting === null || setting.value.toLowerCase() === 'standard_conforming_strings';
}

// Preserve executable tokens and quoted identifiers, but blank comments and all
// data literals. A revoke in prose, a string, or a function body cannot satisfy
// an apply-time ACL check. Null means malformed SQL and fails closed.
export function executableSql(sql) {
  const src = String(sql || ''); let out = '';
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    // The lexer models PostgreSQL's default string rules. Changing the mode
    // through SET (including comment-separated tokens) or set_config() would
    // make its treatment of backslash escapes unknowable, so reject it before
    // handling any quoted content.
    if ((ch === 's' || ch === 'S') && unsafeStandardConformingStringsChange(src, i)) return null;
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
      if (isExecutableRoutineBody(out)) {
        const body = executableSql(src.slice(i + (escape ? 2 : 1), end - 1));
        if (body === null || /\b(?:EXECUTE|GRANT|REVOKE)\b/i.test(body)) return null;
      }
      out = blank(out, end - i); i = end; continue;
    }
    // PostgreSQL allows `$` inside unquoted identifiers. A dollar quote may
    // begin only at a token boundary; otherwise `x$tag$` is an identifier, not
    // a literal that can hide executable ACL statements.
    if (ch === '$' && !isIdentifierCharacter(src[i - 1])) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i));
      if (tag) {
        const close = src.indexOf(tag[0], i + tag[0].length);
        if (close === -1) return null;
        const end = close + tag[0].length;
        // A transient helper routine can make the same dynamic ACL change as a
        // DO block, then disappear before the migration ends. Lex every
        // executable DO/function/procedure body recursively so only real
        // dynamic SQL or ACL commands fail this static proof closed; quoted
        // diagnostic text inside the body remains inert.
        if (isExecutableRoutineBody(out)) {
          const body = executableSql(src.slice(i + tag[0].length, close));
          if (body === null || /\b(?:EXECUTE|GRANT|REVOKE)\b/i.test(body)) return null;
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
      out += src.slice(i, end + 1).replace(/\b(?:REVOKE|GRANT|CREATE|ALTER|DROP|SECURITY|DO|BEGIN)\b/gi, (word) => `\u0001${word.slice(1)}`);
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

function isExecutableRoutineBody(text) {
  let start = 0;
  while (start < text.length) {
    const end = statementEnd(text, start);
    if (end === null) return false;
    if (end === text.length) break;
    start = end + 1;
  }
  const statement = text.slice(start);
  return /\bDO\b/i.test(statement)
    || /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i.test(statement);
}

function unsafeRoutineAlterConfiguration(sql) {
  const headers = /\bALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b/gi;
  for (const header of sql.matchAll(headers)) {
    const end = statementEnd(sql, header.index);
    if (end === null) return true;
    const statement = sql.slice(header.index, end);
    // This source-level ACL guard has no catalog proof of an ALTER target's
    // current body or configuration. Changing an existing routine to SECURITY
    // DEFINER, or changing any routine configuration except the fixed safe
    // path, therefore cannot mint a proof.
    if (/\bSECURITY\s+DEFINER\b/i.test(statement) || /\bRESET\b/i.test(statement)) return true;
    const setPath = /\bSET\s+search_path\s*(?:TO|=)\s+([\s\S]*)$/i.exec(statement);
    if (/\bSET\b/i.test(statement) && !setPath) return true;
    if (!setPath) continue;
    const entries = setPath[1].split(',').map((entry) => entry.trim().replace(/^'|'$/g, '').toLowerCase());
    // The CRX SECURITY DEFINER contract permits only this fixed, nonempty
    // path. Anything else may permit object shadowing under the owner role.
    if (entries.length !== 2 || entries[0] !== 'public' || entries[1] !== 'pg_temp') return true;
  }
  return false;
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
  const types = splitArgs(args).flatMap((arg) => {
    let value = arg.replace(/\bDEFAULT\b[\s\S]*$/i, '').replace(/\s*=\s*[\s\S]*$/, '').trim();
    if (declaration) {
      // PostgreSQL excludes OUT-only arguments from a routine's identity. INOUT
      // arguments remain because callers provide their input value.
      if (/^OUT\s+/i.test(value)) return [];
      value = value.replace(/^(?:IN|INOUT|VARIADIC)\s+/i, '').replace(/^(?:p_[A-Za-z0-9_]*|arg_[A-Za-z0-9_]*)\s+/i, '');
    }
    return [canonicalType(value)];
  });
  const canonicalName = quoted ? `quoted:${name.replaceAll('""', '"')}` : `bare:${name.toLowerCase()}`;
  return `${canonicalName}(${types.join(',')})`;
}

function canonicalType(value) {
  const normalized = value.replace(/\s+/g, ' ').replaceAll('"', '').trim().toLowerCase();
  const array = /^(.*?)(?:\s*(\[\s*\]))+$/.exec(normalized);
  const base = (array ? array[1] : normalized).trim();
  // PostgreSQL treats these spellings as identical routine argument types.
  // Retaining their source spelling would let an ACL target a SECURITY
  // DEFINER overload without updating its tracked state.
  const aliases = new Map([
    ['smallint', 'int2'], ['int2', 'int2'],
    ['integer', 'int4'], ['int', 'int4'], ['int4', 'int4'],
    ['bigint', 'int8'], ['int8', 'int8'],
    ['decimal', 'numeric'], ['numeric', 'numeric'],
    ['real', 'float4'], ['float4', 'float4'],
    ['double precision', 'float8'], ['float8', 'float8'], ['float', 'float8'],
    ['boolean', 'bool'], ['bool', 'bool'],
    ['character varying', 'varchar'], ['varchar', 'varchar'],
    ['character', 'bpchar'], ['char', 'bpchar'], ['bpchar', 'bpchar'],
    ['timestamp without time zone', 'timestamp'], ['timestamp', 'timestamp'],
    ['timestamp with time zone', 'timestamptz'], ['timestamptz', 'timestamptz'],
    ['time without time zone', 'time'], ['time', 'time'],
    ['time with time zone', 'timetz'], ['timetz', 'timetz'],
    ['bit varying', 'varbit'], ['varbit', 'varbit'],
  ]);
  return `${aliases.get(base) || base}${array ? '[]'.repeat((normalized.match(/\[\s*\]/g) || []).length) : ''}`;
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

function renameRoutineEvents(sql) {
  const events = [];
  const headers = /\bALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b/gi;
  const target = /^ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)(?:"((?:""|[^"])*?)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/i;
  for (const header of sql.matchAll(headers)) {
    const end = statementEnd(sql, header.index);
    if (end === null) return null;
    const statement = sql.slice(header.index, end);
    if (!/\bRENAME\s+TO\b/i.test(statement)) continue;
    const match = target.exec(statement);
    if (!match) return null;
    const open = match[0].length - 1;
    const args = balanced(statement, open);
    if (!args) return null;
    const renamed = /^\s+RENAME\s+TO\s+(?:"((?:""|[^"])*?)"|([A-Za-z_][A-Za-z0-9_$]*))\s*$/i.exec(statement.slice(args.end));
    if (!renamed) return null;
    const signature = canonicalSignature(match[1] || match[2], args.text, false, Boolean(match[1]));
    const renamedSignature = canonicalSignature(renamed[1] || renamed[2], args.text, false, Boolean(renamed[1]));
    if (!signature || !renamedSignature) return null;
    events.push({
      index: header.index,
      signature,
      renamedSignature,
      name: (renamed[1] || renamed[2]).replaceAll('""', '"'),
    });
  }
  return events;
}

export function securityDefinerMissingAnonRevokes(sql) {
  const executable = executableSql(sql);
  if (executable === null) return ['unparseable-security-definer-sql'];
  if (unsafeRoutineAlterConfiguration(executable)) return ['unparseable-security-definer-sql'];
  if (/\bALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b[\s\S]*?\bOWNER\s+TO\b/i.test(executable)) return ['unparseable-security-definer-sql'];
  const declarations = [
    ...executable.matchAll(SECURITY_DEFINER_CREATE).map((match) => ({ match, kind: 'create' })),
    ...executable.matchAll(SECURITY_DEFINER_ALTER).map((match) => ({ match, kind: 'alter' })),
  ].sort((a, b) => a.match.index - b.match.index);
  // Keep all routines declared in this migration, not only SECURITY DEFINER
  // ones. An ACL event for an undeclared routine may be changing an existing
  // SECURITY DEFINER function, whose current body and ACL are not available to
  // this narrow source parser; it must therefore block proof production.
  const locallyDeclaredRoutines = new Set();
  for (const declaration of executable.matchAll(SECURITY_DEFINER_CREATE)) {
    const args = balanced(executable, declaration.index + declaration[0].length - 1);
    if (!args) return ['unparseable-security-definer-sql'];
    const signature = canonicalSignature(declaration[1] || declaration[2], args.text, true, Boolean(declaration[1]));
    if (!signature) return ['unparseable-security-definer-sql'];
    locallyDeclaredRoutines.add(signature);
  }
  // SQL-standard routines can hold a body directly in BEGIN ATOMIC … END,
  // without a string delimiter for executableSql to blank. Until the parser
  // models that body boundary, no ACL-looking text inside it can be trusted.
  if (declarations.length > 0 && /\bBEGIN\s+ATOMIC\b/i.test(executable)) return ['unparseable-security-definer-sql'];
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
  const renames = renameRoutineEvents(executable);
  if (acl === null || drops === null || renames === null) return ['unparseable-security-definer-sql'];
  lifecycle.push(
    ...acl.map(({ action, ...event }) => ({ ...event, action: 'acl', aclAction: action })),
    ...drops.map((event) => ({ ...event, action: 'drop' })),
    ...renames.map((event) => ({ ...event, action: 'rename' })),
  );
  lifecycle.sort((a, b) => a.index - b.index);
  const state = new Map();
  for (const event of lifecycle) {
    if (event.action === 'declare') state.set(event.signature, { name: event.name, roles: new Map() });
    else if (event.action === 'drop') state.delete(event.signature);
    else if (event.action === 'rename') {
      const routine = state.get(event.signature);
      if (!routine) continue;
      if (state.has(event.renamedSignature)) return ['unparseable-security-definer-sql'];
      state.delete(event.signature);
      state.set(event.renamedSignature, { ...routine, name: event.name });
    }
    else {
      const routine = state.get(event.signature);
      // A grant/revoke to PUBLIC or anon that does not resolve to tracked
      // state is not harmless: it may change an existing SECURITY DEFINER
      // routine whose body and effective privileges are outside this migration.
      // The proof producer has no catalog to disambiguate that target, so only
      // an ACL for a routine explicitly declared in this migration is safe to
      // classify as unrelated to its tracked SECURITY DEFINER state.
      if (!routine) {
        const touchesPublicExecution = event.roles.some((role) => role === 'public' || role === 'anon');
        if (touchesPublicExecution && !locallyDeclaredRoutines.has(event.signature)) return ['unparseable-security-definer-sql'];
        continue;
      }
      for (const role of event.roles) if (role === 'public' || role === 'anon') routine.roles.set(role, event.aclAction === 'revoke');
    }
  }
  return [...state.values()]
    .filter(({ roles }) => roles.get('public') !== true || roles.get('anon') !== true)
    .map(({ name }) => name);
}
