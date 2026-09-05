// A migration that creates SECURITY DEFINER code must visibly remove both
// inherited PUBLIC and CRX's explicit anon EXECUTE grants. Unknown syntax and
// unterminated SQL fail closed rather than becoming an ACL bypass.
// PostgreSQL accepts a quoted identifier immediately after a routine keyword:
// `CREATE FUNCTION"public"."danger"()`. The identity parser remains deliberately
// strict, but this broad header detector must see the form and fail closed rather
// than silently treating an unparsed owner-privileged routine as absent.
export const CREATE_FN_ANY = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?(\w+)"?\s*\(/gi;
const SECURITY_DEFINER_CREATE = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:public\s*\.\s*)(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;
const SECURITY_DEFINER_ALTER = /ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi;
const SECURITY_DEFINER_ROUTINE_HEADER = /\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)|ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE))(?:\s+|(?="))/gi;

function blank(out, count) { return out + ' '.repeat(count); }

function isIdentifierCharacter(ch) {
  // PostgreSQL allows non-ASCII letters in unquoted identifiers. Treat every
  // non-ASCII code point as identifier content here: the lexer must never let
  // a dollar quote start in the middle of an identifier it cannot classify.
  return Boolean(ch) && (/[A-Za-z0-9_$]/.test(ch) || ch.codePointAt(0) > 0x7f);
}

function isDollarTagStart(ch) {
  return Boolean(ch) && (/[A-Za-z_]/.test(ch) || ch.codePointAt(0) > 0x7f);
}

function isDollarTagCharacter(ch) {
  return Boolean(ch) && (/[A-Za-z0-9_]/.test(ch) || ch.codePointAt(0) > 0x7f);
}

function dollarQuoteDelimiter(text, start) {
  if (text[start] !== '$') return null;
  let end = start + 1;
  if (text[end] === '$') return '$$';
  if (!isDollarTagStart(text[end])) return null;
  end++;
  while (end < text.length && isDollarTagCharacter(text[end])) end++;
  return text[end] === '$' ? text.slice(start, end + 1) : null;
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
    if (text[index] === "'") return { value, end: index + 1, escapeString: quote !== start };
    value += text[index];
  }
  return null;
}

function readDoubleQuotedIdentifier(text, start) {
  if (text[start] !== '"') return null;
  let value = '';
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '"' && text[index + 1] === '"') { value += '"'; index++; continue; }
    if (text[index] === '"') return { value, end: index + 1 };
    value += text[index];
  }
  return null;
}

function startsUnicodeEscapedIdentifier(text, start) {
  return (text[start] === 'u' || text[start] === 'U') && text[start + 1] === '&' && text[start + 2] === '"';
}

function readUnicodeEscapedIdentifier(text, start) {
  if (!startsUnicodeEscapedIdentifier(text, start)) return null;
  const quoted = readDoubleQuotedIdentifier(text, start + 2);
  if (quoted === null) return null;
  // The default Unicode escape is a backslash. An explicit UESCAPE clause is
  // deliberately not modeled here: configuration syntax we cannot decode must
  // fail closed rather than being mistaken for a harmless parameter.
  const after = skipWhitespaceAndComments(text, quoted.end);
  if (after === null || startsKeyword(text, after, 'uescape')) return null;
  let value = '';
  for (let index = 0; index < quoted.value.length;) {
    if (quoted.value[index] !== '\\') { value += quoted.value[index++]; continue; }
    if (quoted.value[index + 1] === '\\') { value += '\\'; index += 2; continue; }
    const plus = quoted.value[index + 1] === '+';
    const digits = quoted.value.slice(index + (plus ? 2 : 1), index + (plus ? 8 : 5));
    if (!/^[0-9a-f]{4}(?:[0-9a-f]{2})?$/i.test(digits) || (plus && digits.length !== 6) || (!plus && digits.length !== 4)) return null;
    const codePoint = Number.parseInt(digits, 16);
    if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    value += String.fromCodePoint(codePoint);
    index += plus ? 8 : 5;
  }
  return { value, end: quoted.end };
}

function readConfigurationIdentifier(text, start) {
  const unicode = readUnicodeEscapedIdentifier(text, start);
  if (unicode !== null) return unicode;
  const quoted = readDoubleQuotedIdentifier(text, start);
  if (quoted !== null) return quoted;
  const bare = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(start));
  return bare === null ? null : { value: bare[0], end: start + bare[0].length };
}

function isStandardConformingStringsParameter(text, start) {
  const identifier = readConfigurationIdentifier(text, start);
  return identifier !== null && identifier.value.toLowerCase() === 'standard_conforming_strings';
}

function isSearchPathParameter(text, start) {
  const identifier = readConfigurationIdentifier(text, start);
  return identifier !== null && identifier.value.toLowerCase() === 'search_path';
}

function setConfigNameEnd(text, start) {
  const identifier = readConfigurationIdentifier(text, start);
  return identifier !== null && identifier.value.toLowerCase() === 'set_config' ? identifier.end : null;
}

function unsafeStandardConformingStringsChange(text, start) {
  if (startsUnicodeEscapedIdentifier(text, start) && readUnicodeEscapedIdentifier(text, start) === null) return true;
  if (startsKeyword(text, start, 'set')) {
    let index = skipWhitespaceAndComments(text, start + 3);
    if (index === null) return true;
    if (startsKeyword(text, index, 'local') || startsKeyword(text, index, 'session')) {
      index = skipWhitespaceAndComments(text, index + (startsKeyword(text, index, 'local') ? 5 : 7));
      if (index === null) return true;
    }
    return readConfigurationIdentifier(text, index) === null || isStandardConformingStringsParameter(text, index);
  }
  const setConfigEnd = setConfigNameEnd(text, start);
  if (setConfigEnd === null) return false;
  let index = skipWhitespaceAndComments(text, setConfigEnd);
  if (index === null || text[index] !== '(') return true;
  index = skipWhitespaceAndComments(text, index + 1);
  if (index === null) return true;
  const setting = readSingleQuotedLiteral(text, index);
  // A dynamic setting name cannot be statically proven not to alter this mode.
  if (setting === null || setting.escapeString) return true;
  const afterSetting = skipWhitespaceAndComments(text, setting.end);
  if (afterSetting === null || text[afterSetting] !== ',') return true;
  return setting.value.toLowerCase() === 'standard_conforming_strings';
}

// A fixed routine-level search_path is insufficient if a SECURITY DEFINER body
// can replace it while running with owner privileges. This scanner is used only
// on an actual routine body (before that body is blanked), so ordinary
// migration-level SET statements retain their established semantics.
function unsafeRoutineBodySearchPathChange(text, start) {
  if (startsUnicodeEscapedIdentifier(text, start) && readUnicodeEscapedIdentifier(text, start) === null) return true;
  if (startsKeyword(text, start, 'set')) {
    let index = skipWhitespaceAndComments(text, start + 3);
    if (index === null) return true;
    if (startsKeyword(text, index, 'local') || startsKeyword(text, index, 'session')) {
      index = skipWhitespaceAndComments(text, index + (startsKeyword(text, index, 'local') ? 5 : 7));
      if (index === null) return true;
    }
    return readConfigurationIdentifier(text, index) === null || isSearchPathParameter(text, index);
  }
  if (startsKeyword(text, start, 'reset')) {
    const index = skipWhitespaceAndComments(text, start + 5);
    return index === null || readConfigurationIdentifier(text, index) === null || isSearchPathParameter(text, index) || startsKeyword(text, index, 'all');
  }
  const setConfigEnd = setConfigNameEnd(text, start);
  if (setConfigEnd === null) return false;
  let index = skipWhitespaceAndComments(text, setConfigEnd);
  if (index === null || text[index] !== '(') return true;
  index = skipWhitespaceAndComments(text, index + 1);
  if (index === null) return true;
  const setting = readSingleQuotedLiteral(text, index);
  // A computed GUC name cannot be proved not to target search_path.
  if (setting === null || setting.escapeString) return true;
  const afterSetting = skipWhitespaceAndComments(text, setting.end);
  if (afterSetting === null || text[afterSetting] !== ',') return true;
  return setting.value.toLowerCase() === 'search_path';
}

function hasUnsafeRoutineBodySearchPathChange(body) {
  for (let index = 0; index < body.length;) {
    const ch = body[index];
    if (ch === '-' && body[index + 1] === '-') {
      index += 2; while (index < body.length && body[index] !== '\n' && body[index] !== '\r') index++;
      continue;
    }
    if (ch === '/' && body[index + 1] === '*') {
      let depth = 1; index += 2;
      while (index < body.length && depth) {
        if (body[index] === '/' && body[index + 1] === '*') { depth++; index += 2; }
        else if (body[index] === '*' && body[index + 1] === '/') { depth--; index += 2; }
        else index++;
      }
      if (depth) return true;
      continue;
    }
    const escape = (ch === 'e' || ch === 'E') && body[index + 1] === "'" && !/[A-Za-z0-9_$]/.test(body[index - 1] || '');
    if (ch === "'" || escape) {
      let end = index + (escape ? 2 : 1);
      while (end < body.length) {
        if (escape && body[end] === '\\') { end += 2; continue; }
        if (body[end] === "'" && body[end + 1] === "'") { end += 2; continue; }
        if (body[end] === "'") { end++; break; }
        end++;
      }
      if (end > body.length || body[end - 1] !== "'") return true;
      index = end; continue;
    }
    if (ch === '$' && !isIdentifierCharacter(body[index - 1])) {
      const tag = dollarQuoteDelimiter(body, index);
      if (tag) {
        const close = body.indexOf(tag, index + tag.length);
        if (close === -1) return true;
        index = close + tag.length; continue;
      }
    }
    if ((ch === 's' || ch === 'S' || ch === 'r' || ch === 'R' || ch === 'u' || ch === 'U' || ch === '"') && unsafeRoutineBodySearchPathChange(body, index)) return true;
    if (ch === '"') {
      const identifier = readDoubleQuotedIdentifier(body, index);
      if (identifier === null) return true;
      index = identifier.end; continue;
    }
    index++;
  }
  return false;
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
    if ((ch === 's' || ch === 'S' || ch === 'u' || ch === 'U' || ch === '"') && unsafeStandardConformingStringsChange(src, i)) return null;
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
        const rawBody = src.slice(i + (escape ? 2 : 1), end - 1);
        if (hasUnsafeRoutineBodySearchPathChange(rawBody)) return null;
        const body = executableSql(rawBody);
        if (body === null || /\b(?:EXECUTE|GRANT|REVOKE)\b/i.test(body) || hasForbiddenSecurityDefinerMutation(body)) return null;
      }
      out = blank(out, end - i); i = end; continue;
    }
    // PostgreSQL allows `$` inside unquoted identifiers. A dollar quote may
    // begin only at a token boundary; otherwise `x$tag$` is an identifier, not
    // a literal that can hide executable ACL statements.
    if (ch === '$' && !isIdentifierCharacter(src[i - 1])) {
      const tag = dollarQuoteDelimiter(src, i);
      if (tag) {
        const close = src.indexOf(tag, i + tag.length);
        if (close === -1) return null;
        const end = close + tag.length;
        // A transient helper routine can make the same dynamic ACL change as a
        // DO block, then disappear before the migration ends. Lex every
        // executable DO/function/procedure body recursively so only real
        // dynamic SQL or ACL commands fail this static proof closed; quoted
        // diagnostic text inside the body remains inert.
        if (isExecutableRoutineBody(out)) {
          const rawBody = src.slice(i + tag.length, close);
          if (hasUnsafeRoutineBodySearchPathChange(rawBody)) return null;
          const body = executableSql(rawBody);
          if (body === null || /\b(?:EXECUTE|GRANT|REVOKE)\b/i.test(body) || hasForbiddenSecurityDefinerMutation(body)) return null;
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
      // Keep quoted identifier bytes exact: PostgreSQL permits control
      // characters, so replacing a keyword with a sentinel can collapse two
      // distinct routine identities. Keyword-only scans mask quoted contents in
      // a separate, offset-preserving view instead.
      out += src.slice(i, end + 1);
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

function maskQuotedIdentifierContents(text) {
  let out = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '"') { out += text[index]; continue; }
    const start = index++;
    while (index < text.length) {
      if (text[index] === '"' && text[index + 1] === '"') { index += 2; continue; }
      if (text[index] === '"') break;
      index++;
    }
    if (index === text.length) return null;
    out += `${text[start]}${' '.repeat(index - start - 1)}${text[index]}`;
  }
  return out;
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

function hasFixedSecurityDefinerCreateSearchPath(definition) {
  // `AS` begins the blanked routine body in executableSql(). Any other routine
  // option can occur before or after SET, so stop only at the next option word
  // rather than accepting a path prefix that an additional schema can extend.
  // Quoted identifiers can legally contain the complete apparent directive
  // (for example an output column in RETURNS TABLE). They are names, never
  // routine configuration, so mask their contents before looking for SET.
  const keywordDefinition = maskQuotedIdentifierContents(definition);
  if (keywordDefinition === null) return false;
  // PostgreSQL accepts more than one SET option on a routine. The last
  // search_path setting wins, and quoted parameter names can spell it too.
  // This narrow source guard can only prove the safe form when this is the
  // sole SET option; any other setting is withheld from proof rather than
  // risking an override that the parser did not model.
  if ([...keywordDefinition.matchAll(/\bSET\b/gi)].length !== 1) return false;
  const settings = [...keywordDefinition.matchAll(
    /\bSET\s+search_path\s*(?:TO|=)\s*([\s\S]*?)(?=\s+\b(?:AS|LANGUAGE|TRANSFORM|WINDOW|SUPPORT|COST|ROWS|SET|SECURITY|IMMUTABLE|STABLE|VOLATILE|LEAKPROOF|CALLED|RETURNS|STRICT)\b|\s*$)/gi,
  )];
  if (settings.length !== 1) return false;
  const entries = settings[0][1]
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, '').toLowerCase());
  return entries.length === 2 && entries[0] === 'public' && entries[1] === 'pg_temp';
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
  const unescapedName = name.replaceAll('""', '"');
  // PostgreSQL folds bare identifiers to lower case. A quoted identifier that
  // already has that exact bare spelling (for example "f") resolves to the
  // same catalog identity as f; keeping separate keys would let an ACL target
  // the same routine through the alternate spelling.
  const canonicalName = !quoted || /^[a-z_][a-z0-9_$]*$/.test(unescapedName)
    ? `bare:${unescapedName.toLowerCase()}`
    : `quoted:${unescapedName}`;
  return `${canonicalName}(${types.join(',')})`;
}

function canonicalType(value) {
  const normalized = value.replace(/\s+/g, ' ').replaceAll('"', '').trim().toLowerCase();
  const array = /^(.*?)(?:\s*(\[\s*\]))+$/.exec(normalized);
  // Built-in types may be written with their pg_catalog qualification. It is
  // the same type identity as the unqualified built-in spelling in a routine
  // signature, so normalize it before applying aliases.
  const base = (array ? array[1] : normalized).trim().replace(/^pg_catalog\s*\.\s*/, '');
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
  const keywordSql = maskQuotedIdentifierContents(sql);
  if (keywordSql === null) return null;
  const actionRe = /\b(REVOKE|GRANT)\b/gi;
  const routineAclPrelude = /^\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+(?:(?:ALL\s+)?(?:FUNCTIONS?|PROCEDURES?|ROUTINES?))\b/i;
  const eventRe = /^(REVOKE|GRANT)\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+(?:FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)(?:"((?:""|[^"])*)"|([A-Za-z_][A-Za-z0-9_$]*))\s*\(/i;
  for (const action of keywordSql.matchAll(actionRe)) {
    if (!routineAclPrelude.test(keywordSql.slice(action.index + action[0].length))) continue;
    const match = eventRe.exec(sql.slice(action.index));
    if (!match) return null;
    const open = action.index + match[0].length - 1;
    const args = balanced(sql, open);
    if (!args) return null;
    const roles = /^\s+(?:FROM|TO)\s+([^;]+);/i.exec(sql.slice(args.end));
    if (!roles || /\b(?:WITH|GROUP|ROLE|GRANTED\s+BY)\b/i.test(roles[1])) return null;
    const signature = canonicalSignature(match[2] || match[3], args.text, false, Boolean(match[2]));
    if (!signature) return null;
    const roleNames = roles[1].split(',').map((role) => role.trim());
    if (roleNames.some((role) => role.includes('"'))) return null;
    events.push({ index: action.index, action: match[1].toLowerCase(), signature, roles: roleNames.map((value) => {
      if (/^public$/i.test(value)) return 'public';
      if (/^anon$/i.test(value)) return 'anon';
      return null;
    }) });
  }
  // Schema-wide grants, default privileges, and unfamiliar GRANT/REVOKE forms
  // can restore effective execution without appearing in a function-specific
  // event. The producer has no live ACL graph, so reject them rather than guess.
  return events;
}

function hasRoleMembershipMutation(sql) {
  const keywordSql = maskQuotedIdentifierContents(sql);
  if (keywordSql === null) return true;
  let start = 0;
  while (start < keywordSql.length) {
    const end = statementEnd(keywordSql, start);
    if (end === null) return true;
    const statement = keywordSql.slice(start, end);
    if (/^\s*(?:GRANT|REVOKE)\b/i.test(statement) && !/\bON\b/i.test(statement)) return true;
    start = end + 1;
  }
  return false;
}

function readSqlIdentifier(text, start) {
  const quoted = readDoubleQuotedIdentifier(text, start);
  if (quoted !== null) return { value: quoted.value.toLowerCase(), end: quoted.end };
  const bare = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(start));
  return bare === null ? null : { value: bare[0].toLowerCase(), end: start + bare[0].length };
}

function hasSystemCatalogMutation(sql) {
  // Every source-level mutation form is unsafe against PostgreSQL system
  // catalogs. The producer deliberately does not model their effects, so a
  // catalog target fails closed whether the mutation is direct or in a body.
  const mutation = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|COPY)\s+/gi;
  for (const match of sql.matchAll(mutation)) {
    let index = skipWhitespaceAndComments(sql, match.index + match[0].length);
    if (index === null) return true;
    // PostgreSQL accepts UPDATE ONLY table_name. It does not make a catalog
    // mutation less privileged, so normalize it before reading the target.
    if (startsKeyword(sql, index, 'only')) {
      index = skipWhitespaceAndComments(sql, index + 4);
      if (index === null) return true;
    }
    let target = readSqlIdentifier(sql, index);
    if (target === null) return true;
    index = skipWhitespaceAndComments(sql, target.end);
    if (index === null) return true;
    if (target.value === 'pg_catalog' && sql[index] === '.') {
      index = skipWhitespaceAndComments(sql, index + 1);
      if (index === null) return true;
      target = readSqlIdentifier(sql, index);
      if (target === null) return true;
    }
    if (target.value.startsWith('pg_')) return true;
  }
  return false;
}

// Source-level ACL proof cannot model a catalog, ownership, or role mutation.
// This predicate is intentionally reusable for the top-level migration and
// every executable routine/DO body before that body is removed from the token
// stream; otherwise a body could hide the same privileged change.
function hasForbiddenSecurityDefinerMutation(sql) {
  const keywordSql = maskQuotedIdentifierContents(sql);
  return keywordSql === null
    || /\b(?:REASSIGN\s+OWNED|OWNER\s+TO)\b/i.test(keywordSql)
    || /\b(?:ALTER|CREATE|DROP)\s+(?:ROLE|GROUP|USER)\b/i.test(keywordSql)
    || hasRoleMembershipMutation(sql)
    || hasSystemCatalogMutation(sql);
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
  // Source-only evidence cannot prove ownership or catalog state. Those can
  // silently change a routine's effective ACL or configuration after a valid
  // declaration, so any ownership transfer or direct system-catalog DML
  // blocks proof generation rather than attempting an incomplete model.
  if (hasForbiddenSecurityDefinerMutation(executable)) return ['unparseable-security-definer-sql'];
  const declarations = [
    ...executable.matchAll(SECURITY_DEFINER_CREATE).map((match) => ({ match, kind: 'create' })),
    ...executable.matchAll(SECURITY_DEFINER_ALTER).map((match) => ({ match, kind: 'alter' })),
  ].sort((a, b) => a.match.index - b.match.index);
  // A source-only proof has no role-inheritance graph. Any role definition or
  // membership mutation can alter effective anonymous access, so reject it
  // regardless of whether this migration also declares a routine.
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
    const end = statementEnd(executable, header.index);
    if (end === null) return ['unparseable-security-definer-sql'];
    const statement = executable.slice(header.index, end);
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
    if (/\bSECURITY\s+DEFINER\b/i.test(definition)) {
      // A creation statement sets the routine's effective configuration. Its
      // ACL revokes are not enough: an owner-privileged routine without the
      // fixed path can resolve attacker-controlled objects before RLS applies.
      if (!hasFixedSecurityDefinerCreateSearchPath(definition)) return ['unparseable-security-definer-sql'];
      // SQL-standard routines can use `RETURN expression` as an inline body.
      // executableSql() only recursively inspects quoted/dollar-quoted bodies,
      // so source-only proof cannot distinguish executable path changes in
      // this unbounded form from harmless declaration text. Withhold the proof
      // until this body grammar has a complete parser rather than trusting a
      // safe-looking header.
      const keywordDefinition = maskQuotedIdentifierContents(definition);
      if (keywordDefinition === null || /\bRETURN\b/i.test(keywordDefinition)) return ['unparseable-security-definer-sql'];
      lifecycle.push({
        index: declaration.index,
        action: 'declare',
        signature,
        name: name.replaceAll('""', '"'),
      });
    }
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
