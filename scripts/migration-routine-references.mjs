// Parse the routine headers that migration-review evidence must surface. This is
// deliberately small and fail-closed: an unrecognised CREATE/ALTER/ACL header is
// safer than silently omitting an existing routine's prior definition or grants.

function isIdentifierStart(character) {
  return /^[_\p{L}]$/u.test(character);
}

function isIdentifierCharacter(character) {
  return /^[$_\p{L}\p{N}]$/u.test(character);
}

function dollarQuoteDelimiter(text, index) {
  if (text[index] !== '$') return null;
  let cursor = index + 1;
  if (text[cursor] === '$') return '$$';
  if (!isIdentifierStart(text[cursor] || '')) return null;
  cursor += 1;
  while (cursor < text.length && isIdentifierCharacter(text[cursor])) cursor += 1;
  return text[cursor] === '$' ? text.slice(index, cursor + 1) : null;
}

// PostgreSQL block comments can nest. Keep one implementation for every
// scanner below so a comment cannot change statement boundaries in one path
// while being treated as SQL in another.
function skipBlockComment(text, start) {
  let depth = 1;
  let cursor = start + 2;
  while (cursor < text.length) {
    if (text[cursor] === '/' && text[cursor + 1] === '*') {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (text[cursor] === '*' && text[cursor + 1] === '/') {
      depth -= 1;
      cursor += 2;
      if (depth === 0) return cursor;
      continue;
    }
    cursor += 1;
  }
  return null;
}

function skipTrivia(text, start) {
  let cursor = start;
  while (cursor < text.length) {
    if (/\s/.test(text[cursor])) { cursor += 1; continue; }
    if (text[cursor] === '-' && text[cursor + 1] === '-') {
      cursor += 2;
      while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor += 1;
      continue;
    }
    if (text[cursor] === '/' && text[cursor + 1] === '*') {
      const next = skipBlockComment(text, cursor);
      if (next === null) return null;
      cursor = next;
      continue;
    }
    break;
  }
  return cursor;
}

function consumeQuoted(text, start) {
  let cursor = start + 1;
  let value = '';
  while (cursor < text.length) {
    if (text[cursor] === '"' && text[cursor + 1] === '"') { value += '"'; cursor += 2; continue; }
    if (text[cursor] === '"') return { value, raw: text.slice(start, cursor + 1), next: cursor + 1 };
    value += text[cursor];
    cursor += 1;
  }
  return null;
}

function consumeIdentifier(text, start) {
  if (text[start] === '"') return consumeQuoted(text, start);
  if (!isIdentifierStart(text[start] || '')) return null;
  let cursor = start + 1;
  while (cursor < text.length && isIdentifierCharacter(text[cursor])) cursor += 1;
  const raw = text.slice(start, cursor);
  return { value: raw.toLowerCase(), raw, next: cursor };
}

function consumeParenthesized(text, start) {
  if (text[start] !== '(') return null;
  let depth = 0;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    if (text[cursor] === '-' && text[cursor + 1] === '-') {
      cursor += 2; while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor += 1;
    } else if (text[cursor] === '/' && text[cursor + 1] === '*') {
      const next = skipBlockComment(text, cursor);
      if (next === null) return null;
      cursor = next - 1;
    } else if (text[cursor] === "'") {
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === "'" && text[cursor + 1] === "'") { cursor += 2; continue; }
        if (text[cursor] === "'") break;
        cursor += 1;
      }
      if (cursor >= text.length) return null;
    } else if (text[cursor] === '"') {
      const quoted = consumeQuoted(text, cursor);
      if (!quoted) return null;
      cursor = quoted.next - 1;
    } else if (text[cursor] === '$') {
      const delimiter = dollarQuoteDelimiter(text, cursor);
      if (delimiter) {
        const end = text.indexOf(delimiter, cursor + delimiter.length);
        if (end === -1) return null;
        cursor = end + delimiter.length - 1;
      }
    } else if (text[cursor] === '(') depth += 1;
    else if (text[cursor] === ')') {
      depth -= 1;
      if (depth === 0) return cursor + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

function maskComments(text) {
  const chars = [...text];
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (text[cursor] === "'") {
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === "'" && text[cursor + 1] === "'") { cursor += 2; continue; }
        if (text[cursor] === "'") break;
        cursor += 1;
      }
      if (cursor >= text.length) return null;
    } else if (text[cursor] === '"') {
      const quoted = consumeQuoted(text, cursor);
      if (!quoted) return null;
      cursor = quoted.next - 1;
    } else if (text[cursor] === '-' && text[cursor + 1] === '-') {
      const start = cursor;
      cursor += 2; while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor += 1;
      for (let index = start; index < cursor; index += 1) chars[index] = ' ';
      cursor -= 1;
    } else if (text[cursor] === '/' && text[cursor + 1] === '*') {
      const start = cursor;
      const next = skipBlockComment(text, cursor);
      if (next === null) return null;
      for (let index = start; index < next; index += 1) chars[index] = ' ';
      cursor = next - 1;
    }
  }
  return chars.join('');
}

export function statementEnd(text, start) {
  for (let cursor = start; cursor < text.length; cursor += 1) {
    if (text[cursor] === '-' && text[cursor + 1] === '-') {
      cursor += 2; while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor += 1;
    } else if (text[cursor] === '/' && text[cursor + 1] === '*') {
      const next = skipBlockComment(text, cursor);
      if (next === null) return null;
      cursor = next - 1;
    } else if (text[cursor] === "'") {
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === "'" && text[cursor + 1] === "'") { cursor += 2; continue; }
        if (text[cursor] === "'") break;
        cursor += 1;
      }
      if (cursor >= text.length) return null;
    } else if (text[cursor] === '"') {
      const quoted = consumeQuoted(text, cursor);
      if (!quoted) return null;
      cursor = quoted.next - 1;
    } else if (text[cursor] === '$') {
      const delimiter = dollarQuoteDelimiter(text, cursor);
      if (delimiter) {
        const end = text.indexOf(delimiter, cursor + delimiter.length);
        if (end === -1) return null;
        cursor = end + delimiter.length - 1;
      }
    } else if (text[cursor] === ';') return cursor;
  }
  return text.length;
}

export function sqlStatements(text) {
  const statements = [];
  let start = 0;
  while (start < text.length) {
    const end = statementEnd(text, start);
    if (end === null) return null;
    statements.push(text.slice(start, end + Number(end < text.length)));
    start = end + 1;
  }
  return statements;
}

function consumeRoutineTarget(text, start, { signatureRequired }) {
  const firstStart = skipTrivia(text, start);
  if (firstStart === null) return null;
  const first = consumeIdentifier(text, firstStart);
  if (!first) return null;
  const dot = skipTrivia(text, first.next);
  if (dot === null) return null;
  let schema = null;
  let name = first;
  let next = dot;
  if (text[dot] === '.') {
    const nameStart = skipTrivia(text, dot + 1);
    if (nameStart === null) return null;
    const parsedName = consumeIdentifier(text, nameStart);
    if (!parsedName) return null;
    schema = first;
    name = parsedName;
    next = skipTrivia(text, parsedName.next);
    if (next === null || text[next] === '.') return null;
  }
  const signatureEnd = text[next] === '(' ? consumeParenthesized(text, next) : next;
  if (signatureEnd === null || (signatureRequired && text[next] !== '(')) return null;
  return {
    routine: {
      key: name.value,
      display: schema ? `${schema.raw}.${name.raw}` : name.raw,
    },
    next: signatureEnd,
  };
}

const ROUTINE_HEADER = /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b|ALTER\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b|(?:GRANT|REVOKE)\s+(?:ALL(?:\s+PRIVILEGES)?|EXECUTE)\s+ON\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b)/i;
const GRANT_OR_REVOKE_HEADER = /^(?:GRANT|REVOKE)\b/i;

export function routineReferencesIn(sql) {
  const statements = sqlStatements(sql);
  if (!statements) return { entries: [], error: 'unterminated SQL while parsing routine references' };
  const entries = [];
  for (const statement of statements) {
    const masked = maskComments(statement);
    if (masked === null) return { entries: [], error: 'unterminated comment or quoted identifier while parsing routine references' };
    const start = skipTrivia(masked, 0);
    if (start === null) return { entries: [], error: 'unterminated comment while parsing routine references' };
    const header = ROUTINE_HEADER.exec(masked.slice(start));
    if (!header) continue;
    const grantOrRevoke = GRANT_OR_REVOKE_HEADER.test(header[0]);
    const routines = [];
    let cursor = start + header[0].length;
    while (true) {
      const target = consumeRoutineTarget(statement, cursor, { signatureRequired: !grantOrRevoke });
      if (!target) return { entries: [], error: `unparseable routine header: ${statement.trim().slice(0, 160)}` };
      routines.push(target.routine);
      cursor = skipTrivia(statement, target.next);
      if (cursor === null || !grantOrRevoke || statement[cursor] !== ',') break;
      cursor += 1;
    }
    entries.push({ statement, routines });
  }
  return { entries, error: null };
}
