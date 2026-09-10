// This proof helper intentionally uses only Node builtins. Loading a parser from
// ignored node_modules would put executable, unverified code outside the proof
// boundary. The lexer recognizes every direct `.rpc` access regardless of the
// receiver name; indirect or dynamic forms with a known client fail closed.

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

function isIdentifierStart(char) { return /[A-Za-z_$]/.test(char || ''); }
function isIdentifierPart(char) { return /[A-Za-z0-9_$]/.test(char || ''); }

function decodeEscape(text, index) {
  const next = text[index + 1];
  if (next === undefined) return null;
  const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  if (Object.hasOwn(simple, next)) return { value: simple[next], end: index + 2 };
  if (next === 'x') {
    const digits = text.slice(index + 2, index + 4);
    if (!/^[0-9a-f]{2}$/i.test(digits)) return null;
    return { value: String.fromCharCode(Number.parseInt(digits, 16)), end: index + 4 };
  }
  if (next === 'u') {
    if (text[index + 2] === '{') {
      const close = text.indexOf('}', index + 3);
      const digits = close === -1 ? '' : text.slice(index + 3, close);
      if (!/^[0-9a-f]{1,6}$/i.test(digits)) return null;
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff) return null;
      return { value: String.fromCodePoint(codePoint), end: close + 1 };
    }
    const digits = text.slice(index + 2, index + 6);
    if (!/^[0-9a-f]{4}$/i.test(digits)) return null;
    return { value: String.fromCharCode(Number.parseInt(digits, 16)), end: index + 6 };
  }
  if (next === '\r' && text[index + 2] === '\n') return { value: '', end: index + 3 };
  if (next === '\r' || next === '\n') return { value: '', end: index + 2 };
  return { value: next, end: index + 2 };
}

// JavaScript permits Unicode escapes in identifier names, including a member
// access such as `client.r\\u0070c(...)`. Decode only escapes that produce the
// ASCII identifier alphabet this scanner intentionally accepts. Any malformed
// or unsupported escape makes the whole file unresolved below; silently
// skipping it would allow a direct RPC caller to disappear from the evidence.
function consumeIdentifier(text, start) {
  let index = start;
  let value = '';
  let first = true;
  while (index < text.length) {
    const char = text[index];
    if ((first ? isIdentifierStart(char) : isIdentifierPart(char))) {
      value += char;
      index++;
      first = false;
      continue;
    }
    if (char === '\\') {
      const escape = decodeEscape(text, index);
      if (escape === null || !(first ? isIdentifierStart(escape.value) : isIdentifierPart(escape.value))) return null;
      value += escape.value;
      index = escape.end;
      first = false;
      continue;
    }
    break;
  }
  return first ? null : { value, end: index };
}

function consumeQuotedString(text, start, quote) {
  let value = '';
  for (let index = start + 1; index < text.length;) {
    const char = text[index];
    if (char === quote) return { value, end: index + 1 };
    if (char === '\\') {
      const escape = decodeEscape(text, index);
      if (escape === null) return null;
      value += escape.value;
      index = escape.end;
      continue;
    }
    // TSX attribute literals may legally span lines. Invalid plain JavaScript
    // string continuations are still safe here: treating them as one literal
    // can only withhold proof, never create a fictitious executable call.
    value += char;
    index++;
  }
  return null;
}

function canStartRegex(previous) {
  if (!previous) return true;
  if (previous.kind === 'identifier') return new Set(['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do']).has(previous.value);
  return new Set(['(', '[', '{', ',', ':', ';', '=', '=>', '!', '~', '?', '&&', '||', '??', '?.']).has(previous.value);
}

function consumeRegex(text, start) {
  let inClass = false;
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '\\') { index++; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']') { inClass = false; continue; }
    if (char === '/' && !inClass) {
      index++;
      while (/[A-Za-z]/.test(text[index] || '')) index++;
      return index;
    }
    if (char === '\r' || char === '\n') return null;
  }
  return null;
}

function consumeTemplateExpression(text, start) {
  let depth = 1;
  for (let index = start; index < text.length;) {
    const char = text[index];
    if (char === '\\') { index += 2; continue; }
    if (char === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && !/[\r\n]/.test(text[index])) index++;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const finish = text.indexOf('*/', index + 2);
      if (finish === -1) return null;
      index = finish + 2;
      continue;
    }
    let previous = index - 1;
    while (previous >= start && /\s/.test(text[previous])) previous--;
    const previousChar = text[previous] || '';
    if (char === '/' && !/[A-Za-z0-9_$)\]]/.test(previousChar) && !/\s/.test(text[index + 1] || '')) {
      const regex = consumeRegex(text, index);
      if (regex !== null) { index = regex; continue; }
    }
    if (char === '\'' || char === '"') {
      const string = consumeQuotedString(text, index, char);
      if (string === null) return null;
      index = string.end;
      continue;
    }
    if (char === '`') {
      const nested = consumeTemplateLiteral(text, index);
      if (nested === null) return null;
      index = nested.end;
      continue;
    }
    if (char === '{') { depth++; index++; continue; }
    if (char === '}') {
      depth--;
      if (depth === 0) return index + 1;
      index++;
      continue;
    }
    index++;
  }
  return null;
}

function consumeTemplateLiteral(text, start) {
  let dynamic = false;
  for (let index = start + 1; index < text.length;) {
    const char = text[index];
    if (char === '\\') { index += 2; continue; }
    if (char === '`') return { end: index + 1, dynamic };
    if (char === '$' && text[index + 1] === '{') {
      dynamic = true;
      const finish = consumeTemplateExpression(text, index + 2);
      if (finish === null) return null;
      index = finish;
      continue;
    }
    index++;
  }
  return null;
}

// A template interpolation is dynamic input. Rather than pretending to parse
// all embedded JSX/TypeScript grammar, record any `.rpc` text inside it as an
// unresolved caller. That is conservative and prevents a template expression
// from silently escaping the proof inventory.
function tokenize(text) {
  const tokens = [];
  const templateRpcStarts = [];
  let failedAt = null;
  const add = (kind, value, start, end) => tokens.push({ kind, value, start, end });

  function scan(start) {
    for (let index = start; index < text.length;) {
      const char = text[index];
      if (/\s/.test(char)) { index++; continue; }
      if (char === '/' && text[index + 1] === '/') {
        index += 2;
        while (index < text.length && !/[\r\n]/.test(text[index])) index++;
        continue;
      }
      if (char === '/' && text[index + 1] === '*') {
        const finish = text.indexOf('*/', index + 2);
        if (finish === -1) { failedAt = index; return text.length; }
        index = finish + 2;
        continue;
      }
      if (char === '/' && canStartRegex(tokens.at(-1))) {
        const finish = consumeRegex(text, index);
        if (finish === null) { failedAt = index; return text.length; }
        add('regex', null, index, finish);
        index = finish;
        continue;
      }
      // TSX text is not JavaScript string syntax. A prose apostrophe such as
      // `can't` must not swallow the remainder of a component as a quote.
      if (char === '\'' && isIdentifierPart(text[index - 1]) && isIdentifierPart(text[index + 1])) {
        add('punct', char, index, index + 1);
        index++;
        continue;
      }
      if (char === '\'' || char === '"') {
        const string = consumeQuotedString(text, index, char);
        if (string === null) { failedAt = index; return text.length; }
        add('string', string.value, index, string.end);
        index = string.end;
        continue;
      }
      if (char === '`') {
        const tokenStart = index;
        const template = consumeTemplateLiteral(text, index);
        if (template === null) { failedAt = tokenStart; return text.length; }
        const rawTemplate = text.slice(tokenStart, template.end);
        for (const match of rawTemplate.matchAll(/\.\s*rpc\b/g)) templateRpcStarts.push(tokenStart + match.index);
        const staticTemplate = template.dynamic ? undefined : consumeQuotedString(text, tokenStart, '`');
        if (!template.dynamic && staticTemplate === null) { failedAt = tokenStart; return text.length; }
        add(template.dynamic ? 'template' : 'string', template.dynamic ? null : staticTemplate.value, tokenStart, template.end);
        index = template.end;
        continue;
      }
      if (isIdentifierStart(char) || (char === '\\' && text[index + 1] === 'u')) {
        const identifier = consumeIdentifier(text, index);
        if (identifier === null) { failedAt = index; return text.length; }
        add('identifier', identifier.value, index, identifier.end);
        index = identifier.end;
        continue;
      }
      if (/[0-9]/.test(char)) {
        let finish = index + 1;
        while (/[A-Za-z0-9_.]/.test(text[finish] || '')) finish++;
        add('number', text.slice(index, finish), index, finish);
        index = finish;
        continue;
      }
      const punct = text.slice(index, index + 3) === '...' ? '...'
        : text.slice(index, index + 2) === '?.' ? '?.'
          : text.slice(index, index + 2) === '=>' ? '=>'
            : text.slice(index, index + 2) === '??' ? '??'
              : text.slice(index, index + 2) === '&&' ? '&&'
                : text.slice(index, index + 2) === '||' ? '||'
                  : char;
      add('punct', punct, index, index + punct.length);
      index += punct.length;
    }
    return text.length;
  }

  scan(0);
  return { tokens, templateRpcStarts, failedAt };
}

function nextCallToken(tokens, index) {
  let cursor = index;
  if (tokens[cursor]?.value === '?.') cursor++;
  while (tokens[cursor]?.value === ')') cursor++;
  return { token: tokens[cursor], index: cursor };
}

function knownClientAliases(tokens) {
  const aliases = new Set(['client', 'supabase', 'db', 'adminClient', 'supabaseUntyped']);
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index + 3 < tokens.length; index++) {
      if (!['const', 'let', 'var'].includes(tokens[index].value)) continue;
      const local = tokens[index + 1];
      const equals = tokens[index + 2];
      const source = tokens[index + 3];
      if (local.kind === 'identifier' && equals.value === '=' && source.kind === 'identifier' && aliases.has(source.value) && !aliases.has(local.value)) {
        aliases.add(local.value);
        changed = true;
      }
    }
  }
  return aliases;
}

function isKnownMemberReceiver(tokens, bracketIndex, aliases) {
  let cursor = bracketIndex - 1;
  if (tokens[cursor]?.value === '?.') cursor--;
  return tokens[cursor]?.kind === 'identifier' && aliases.has(tokens[cursor].value);
}

function fallbackDirectRpcUses(file, text, uses, addUnresolved) {
  // A malformed lexer state must not erase later callers. This recovery path is
  // intentionally conservative: any source-looking direct access is recorded,
  // and any form we cannot prove literal remains unresolved.
  let recovered = 0;
  for (const match of text.matchAll(/\.\s*rpc\b/g)) {
    const index = match.index;
    let cursor = index + match[0].length;
    while (/\s/.test(text[cursor] || '')) cursor++;
    if (text.startsWith('?.', cursor)) cursor += 2;
    while (/\s/.test(text[cursor] || '')) cursor++;
    if (text[cursor] !== '(') { addUnresolved(index); recovered++; continue; }
    let argument = cursor + 1;
    while (/\s/.test(text[argument] || '')) argument++;
    const quote = text[argument];
    const routine = ['\'', '"'].includes(quote) ? consumeQuotedString(text, argument, quote) : null;
    if (routine === null) addUnresolved(index);
    else uses.push({ file, text, index, routine: routine.value, unresolved: false });
    recovered++;
  }
  return recovered;
}

function snapshotRpcUses(snapshot) {
  const uses = [];
  for (const file of applicationSourceFiles(snapshot)) {
    const text = snapshot.text(file);
    const { tokens, templateRpcStarts, failedAt } = tokenize(text);
    const reported = new Set();
    const addUnresolved = (index) => {
      if (reported.has(index)) return;
      reported.add(index);
      uses.push({ file, text, index, routine: null, unresolved: true });
    };
    if (failedAt !== null) {
      if (fallbackDirectRpcUses(file, text, uses, addUnresolved) === 0) addUnresolved(failedAt);
      continue;
    }
    for (const index of templateRpcStarts) addUnresolved(index);
    const aliases = knownClientAliases(tokens);

    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const next = tokens[index + 1];
      if ((token.value === '.' || token.value === '?.') && next?.kind === 'identifier' && next.value === 'rpc') {
        const call = nextCallToken(tokens, index + 2);
        if (call.token?.value !== '(') { addUnresolved(token.start); continue; }
        const routine = tokens[call.index + 1];
        if (routine?.kind !== 'string') addUnresolved(token.start);
        else uses.push({ file, text, index: token.start, routine: routine.value, unresolved: false });
        continue;
      }
      if (token.value === '[' && next?.kind === 'string' && next.value === 'rpc' && tokens[index + 2]?.value === ']') {
        const call = nextCallToken(tokens, index + 3);
        if (call.token?.value !== '(') { addUnresolved(token.start); continue; }
        const routine = tokens[call.index + 1];
        if (routine?.kind !== 'string') addUnresolved(token.start);
        else uses.push({ file, text, index: token.start, routine: routine.value, unresolved: false });
        continue;
      }
      if (token.value === '[' && isKnownMemberReceiver(tokens, index, aliases)) addUnresolved(token.start);
      if (token.kind === 'identifier' && token.value === 'Reflect' && tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === 'get' && tokens[index + 3]?.value === '(') {
        const comma = tokens.slice(index + 4).find((candidate) => candidate.value === ',');
        const key = comma && tokens[tokens.indexOf(comma) + 1];
        if (key?.kind === 'string' && key.value === 'rpc') addUnresolved(token.start);
      }
      if (['const', 'let', 'var'].includes(token.value) && tokens[index + 1]?.value === '{') {
        let cursor = index + 2;
        let braceDepth = 1;
        while (cursor < tokens.length && braceDepth > 0) {
          if (tokens[cursor].value === '{') braceDepth++;
          else if (tokens[cursor].value === '}') braceDepth--;
          const previous = tokens[cursor - 1];
          const following = tokens[cursor + 1];
          // `const { data: rpc }` binds a response variable named rpc. Only an
          // object key named rpc is an indirect method extraction: `{ rpc }` or
          // `{ rpc: renamedRpc }`.
          if (braceDepth === 1 && tokens[cursor].kind === 'identifier' && tokens[cursor].value === 'rpc' && ['{', ','].includes(previous?.value) && ['}', ',', ':', '='].includes(following?.value)) addUnresolved(tokens[cursor].start);
          cursor++;
        }
      }
    }
  }
  return uses;
}

export function applicationRpcAccessInventory(snapshot) {
  return snapshotRpcUses(snapshot).map((use) => ({
    file: use.file,
    index: use.index,
    routine: use.routine,
    unresolved: use.unresolved,
    site: lineSite(use.file, use.text, use.index),
  }));
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
