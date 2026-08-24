#!/usr/bin/env node
// WHAT A MIGRATION ACTUALLY WRITES WHEN IT APPLIES.
//
// Twenty-three adversarial rounds against migration-apply-guard.mjs have all
// had the same shape: the guard asked "does this text look like the repair we
// already ran?", and each round found another spelling that reads differently
// and runs identically. Round 23 turned `SET total_price = total_price` into
// `SET total_price = (total_price)` and walked straight through the name,
// whole-body, and shared-statement checks.
//
// Text matching cannot win that race, because the set of spellings is infinite
// while the set of things the statement DOES is small. So this module answers
// the smaller question instead: which (table, column) pairs does this SQL write
// AT APPLY TIME? Parentheses, aliases, casing, comments, CTEs, and quoting all
// change the text and none of them change the answer.
//
// The load-bearing distinction is apply-time versus deferred. A migration that
// says
//
//   CREATE FUNCTION recalc() ... AS $$ UPDATE order_items SET total_price ... $$;
//
// writes nothing when it applies — it defines behavior for later callers, and
// 29 migrations in this repository do exactly that with this very column.
// Treating those as writes would demand an override for almost every RPC
// change, which is how a guard gets disabled. A `DO $$ ... $$` block, by
// contrast, executes immediately, so its body IS apply-time and is parsed as
// such. Routine bodies are dropped; DO bodies are recursed into.
//
// ROUND 24. Dropping routine bodies opened a door: define the repair inside a
// helper and call it in the same migration.
//
//   CREATE FUNCTION tmp_fix() ... AS $$ UPDATE order_items SET total_price ... $$;
//   SELECT tmp_fix();
//
// The definition is deferred and the call looks like a read, so the analyzer
// saw nothing while the migration rewrote the column. A body is deferred only
// until something invokes it. So routine bodies are no longer discarded — they
// are set aside, and any body the migration invokes at apply time (CALL,
// PERFORM, or a bare call in any executing position) has its writes folded back
// in, transitively through helpers that call helpers. Defining a function is
// still free; defining one and running it is not.
//
// Everything here fails toward over-reporting: an unparseable construct is
// reported as a write rather than skipped, because a false demand for an
// override costs one prompt and a false silence costs a money population.

const IDENT_START = /[A-Za-z_\u0080-\uFFFF]/;
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;
// Only this exact statement head introduces a deferred routine body. Keywords
// such as COMMENT/GRANT/ALTER ... FUNCTION can also be followed by a dollar-
// quoted string, but that string is metadata or an argument — never a new body.
// Keeping one shared predicate for dollar- and single-quoted forms prevents the
// two legal body syntaxes from drifting apart.
const ROUTINE_CREATE_HEAD = /^create\s+(?:or\s+replace\s+)?(?:function|procedure)\b/;
const ROUTINE_NAME_CAPTURE = /\b(?:function|procedure)\s+((?:[A-Za-z0-9_]+\s*\.\s*)*[A-Za-z0-9_]+)/;
const DOLLAR_ROUTINE_BODY_HEAD = /\bas\s*$/;
const QUOTED_ROUTINE_BODY_HEAD = /\bas\s*(?:e|u&)?$/;
const DISABLES_STANDARD_CONFORMING_STRINGS =
  /\bset\s+(?:(?:local|session)\s+)?standard_conforming_strings\s*(?:=|to)\s*(?:off|false|0|(?:e|u&)?''(?=\s|;|$))/i;

function hasNewlineContinuedString(sql, start) {
  let i = start;
  let sawNewline = false;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) {
      if (sql[i] === "\n" || sql[i] === "\r") sawNewline = true;
      i += 1;
      continue;
    }
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i += 1;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "\n" || sql[i] === "\r") sawNewline = true;
        if (sql[i] === "/" && sql[i + 1] === "*") { depth += 1; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { depth -= 1; i += 2; continue; }
        i += 1;
      }
      continue;
    }
    break;
  }
  if (!sawNewline) return false;
  return sql[i] === "'" ||
    ((sql[i] === "e" || sql[i] === "E") && sql[i + 1] === "'") ||
    ((sql[i] === "u" || sql[i] === "U") && sql[i + 1] === "&" && sql[i + 2] === "'");
}

function routineParameterDefaults(statement) {
  const named = ROUTINE_NAME_CAPTURE.exec(statement);
  if (!named) return [];
  const open = statement.indexOf("(", named.index + named[0].length);
  if (open < 0) return [];

  const parameters = [];
  let start = open + 1;
  let depth = 0;
  let bracketDepth = 0;
  for (let i = start; i < statement.length; i += 1) {
    const ch = statement[i];
    // Commas and parentheses inside literal/comment text are not parameter
    // delimiters. Skip each construct with PostgreSQL's real doubling/nesting
    // rules before updating the structural depths below.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      for (i += 1; i < statement.length; i += 1) {
        if (statement[i] !== quote) continue;
        if (statement[i + 1] === quote) { i += 1; continue; }
        break;
      }
      continue;
    }
    if (ch === "-" && statement[i + 1] === "-") {
      const end = statement.indexOf("\n", i + 2);
      i = end < 0 ? statement.length : end;
      continue;
    }
    if (ch === "/" && statement[i + 1] === "*") {
      let commentDepth = 1;
      i += 2;
      while (i < statement.length && commentDepth > 0) {
        if (statement[i] === "/" && statement[i + 1] === "*") { commentDepth += 1; i += 2; continue; }
        if (statement[i] === "*" && statement[i + 1] === "/") { commentDepth -= 1; i += 2; continue; }
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (ch === "$" && !IDENT_CHAR.test(statement[i - 1] || "")) {
      const tag = /^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*)?\$/.exec(statement.slice(i))?.[0];
      if (tag) {
        const end = statement.indexOf(tag, i + tag.length);
        if (end < 0) break;
        i = end + tag.length - 1;
        continue;
      }
    }
    if (ch === "[") { bracketDepth += 1; continue; }
    if (ch === "]") { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") {
      if (depth === 0 && bracketDepth === 0) { parameters.push(statement.slice(start, i)); break; }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "," && depth === 0 && bracketDepth === 0) {
      parameters.push(statement.slice(start, i));
      start = i + 1;
    }
  }

  return parameters.flatMap((parameter) => {
    const keyword = /\bdefault\b/.exec(parameter);
    if (keyword) return [parameter.slice(keyword.index + keyword[0].length)];

    let nested = 0;
    for (let i = 0; i < parameter.length; i += 1) {
      const ch = parameter[i];
      if (ch === "(") { nested += 1; continue; }
      if (ch === ")") { nested = Math.max(0, nested - 1); continue; }
      if (ch !== "=" || nested !== 0) continue;
      const before = parameter[i - 1] || "";
      const after = parameter[i + 1] || "";
      if ("<>!:".includes(before) || "=>".includes(after)) continue;
      return [parameter.slice(i + 1)];
    }
    return [];
  });
}

function routineHasCallableParameterDefault(statement) {
  const call = /(?:^|[^A-Za-z0-9_$\u0080-\uFFFF])(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*\s*\.\s*)*[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*\s*\(/;
  return routineParameterDefaults(statement).some((expression) => call.test(expression));
}

// PostgreSQL quoted identifiers can legally contain comment markers, spaces,
// punctuation, and doubled quotes. Feeding their raw contents back into the
// syntax stream turns public."--now" into a line comment and erases both the
// definition and call. Canonicalize non-identifier characters instead. The
// mapping may collide with an ordinary name, but that only unions extra bodies
// and therefore fails toward an override prompt.
const QUOTED_IDENT_PREFIX = "_crxq_";

function canonicalQuotedIdentifier(value) {
  const raw = String(value || "");
  const canonical = raw
    .replace(/\$/g, "_dollar_")
    .replace(/[^A-Za-z0-9_\u0080-\uFFFF]/g, "_");
  // PostgreSQL folds an unquoted identifier to lowercase. A quoted identifier
  // that is already a legal lowercase spelling therefore has the SAME
  // identity: public."round" and public.round can resolve one routine. Keeping
  // the quote tag on that narrow spelling lets a mutating same-file definition
  // hide behind an unqualified builtin-looking call. Coalesce those identities;
  // mixed-case, keyword-shaped, and punctuation-bearing quoted names retain the
  // tag because they are genuinely distinct or need their syntactic role kept.
  if (/^[a-z_][a-z0-9_$]*$/.test(raw) && !NON_RELATION_KEYWORDS.has(raw)) return canonical;
  // Keep the token visibly quoted until its syntactic role is known. Without
  // this tag a legal name such as public."on" is flattened to the keyword ON:
  // relation readers then discard the write, and trigger readers can mistake a
  // quoted trigger name for the attachment clause.
  return `${QUOTED_IDENT_PREFIX}${canonical || "_quoted_"}`;
}

function identifierIdentity(value) {
  const text = String(value || "");
  if (!text.startsWith(QUOTED_IDENT_PREFIX)) return { value: text, quoted: false };
  return { value: text.slice(QUOTED_IDENT_PREFIX.length) || "_quoted_", quoted: true };
}

// A format placeholder standing where a relation name belongs — `EXECUTE
// format('UPDATE %I SET ...', v_table)`. The target is chosen at runtime, so no
// static reading of this file can rule out a protected table.
const FORMAT_PLACEHOLDER = /^%(\d+\$)?[isl]/i;

// Words that can stand immediately after a write verb without being a relation.
// `GRANT UPDATE ON t`, `AFTER UPDATE OF c ON t`, `FOR UPDATE USING (...)`,
// `BEFORE INSERT OR UPDATE`, `SELECT ... FOR UPDATE` — each of these puts a
// keyword where a table name would otherwise sit.
const NON_RELATION_KEYWORDS = new Set([
  "on", "of", "or", "to", "set", "using", "from", "where", "and", "with",
  "do", "conflict", "nothing", "all", "select", "for", "each", "row",
  "statement", "before", "after", "instead", "cascade", "restrict",
  "references", "execute", "grant", "revoke", "trigger", "rule", "policy",
  "function", "procedure", "table", "as", "returning", "values",
]);

/**
 * Strip comments and string bodies, drop deferred routine bodies, and inline
 * `DO` block bodies, so what remains is the code that runs when this migration
 * is applied.
 *
 * Returns `{ code, literals, routines }`. `literals` holds the text of every
 * string literal that appeared in apply-time position — that is where dynamic
 * SQL hides, and it is scanned separately. `routines` holds every routine body
 * this SQL defines, parsed as if it were running, keyed by name; a body only
 * counts once something invokes it, which the caller resolves.
 */
export function applyTimeCode(sql, depth = 0) {
  let code = "";
  const literals = [];
  const routines = [];
  let unsupportedDoBody = false;
  if (typeof sql !== "string") {
    return { code, literals, routines, unsupportedDoBody };
  }
  // Guard against a pathological nest; 8 is far past anything real. This is a
  // denial boundary, never a silent truncation boundary: a deeper executable
  // body may contain the only money write in the migration.
  if (depth > 8) {
    return { code, literals, routines, unsupportedDoBody: true };
  }
  const n = sql.length;
  let i = 0;
  let stmtStart = 0; // where the current statement begins inside `code`

  while (i < n) {
    const ch = sql[i];

    // -- line comment
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      code += " ";
      continue;
    }

    // /* block comment */ — PostgreSQL nests these, so count depth.
    if (ch === "/" && sql[i + 1] === "*") {
      let d = 0;
      while (i < n) {
        if (sql[i] === "/" && sql[i + 1] === "*") { d += 1; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { d -= 1; i += 2; if (d === 0) break; continue; }
        i += 1;
      }
      code += " ";
      continue;
    }

    // $tag$ ... $tag$
    if (ch === "$") {
      // PostgreSQL requires a dollar-quoted string to be separated from a
      // preceding identifier. In repair$x$, the first $x$-looking run is part
      // of one legal identifier, not a body delimiter.
      const precededByIdent = i > 0 && IDENT_CHAR.test(sql[i - 1]);
      const m = precededByIdent
        ? null
        : /^\$([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const bodyEnd = close === -1 ? n : close;
        const body = sql.slice(i + tag.length, bodyEnd);
        // Which statement is this body attached to? `DO` runs now; a routine
        // body does not. Anything else unrecognized is treated as running now,
        // which is the over-reporting direction.
        const stmt = code.slice(stmtStart).trim().toLowerCase();
        // A CREATE head alone is not enough: parameter defaults can themselves
        // be dollar-quoted strings. Only the literal introduced by the
        // routine's AS clause is its stored body.
        const routineHead = ROUTINE_CREATE_HEAD.test(stmt);
        const deferred = routineHead && DOLLAR_ROUTINE_BODY_HEAD.test(stmt);
        if (routineHead && !deferred) {
          // This is a dollar-quoted value inside the signature or another
          // pre-body clause, not executable SQL. Keep a literal placeholder so
          // the surrounding default expression remains structurally intact.
          literals.push(body);
          code += "''";
          i = close === -1 ? n : close + tag.length;
          continue;
        }
        const inner = applyTimeCode(body, depth + 1);
        if (deferred) {
          // Keep a placeholder so the statement still parses, and contribute no
          // writes from inside the body — UNTIL something calls it. The body is
          // parsed now and filed under the routine's name so the caller can fold
          // it back in if this migration invokes it (round 24).
          code += " '' ";
          const named = ROUTINE_NAME_CAPTURE.exec(stmt);
          const identity = canonicalRoutineIdentity(named?.[1]);
          if (identity) routines.push({
            name: identity,
            code: inner.code,
            literals: inner.literals,
            unresolved: inner.unsupportedDoBody,
            callableDefault: routineHasCallableParameterDefault(stmt),
            defaultCode: routineParameterDefaults(stmt).map((expression) => `SELECT ${expression}`).join(";\n"),
          });
          // A routine defined inside this body is still defined by this file.
          routines.push(...inner.routines);
        } else {
          code += ` ${inner.code} `;
          literals.push(...inner.literals);
          routines.push(...inner.routines);
          if (inner.unsupportedDoBody) unsupportedDoBody = true;
        }
        i = close === -1 ? n : close + tag.length;
        continue;
      }
      // Outside a dollar-quote delimiter this is an identifier character.
      // Canonicalize it before later definition/call regexes so foo$bar and a
      // quoted "$count" keep the same identity at both sites instead of being
      // truncated at `$`. Collisions only union extra bodies and fail closed.
      code += "_dollar_";
      i += 1;
      continue;
    }

    // 'string literal' — kept aside; `''` escapes an embedded quote.
    if (ch === "'") {
      const escapePrefixed = i > 0 && /[eE]/.test(sql[i - 1]) &&
        (i < 2 || !IDENT_CHAR.test(sql[i - 2]));
      const unicodePrefixed = i > 1 && /[uU]/.test(sql[i - 2]) && sql[i - 1] === "&" &&
        (i < 3 || !IDENT_CHAR.test(sql[i - 3]));
      const unsafeRoutineLiteral = escapePrefixed || unicodePrefixed;
      let lit = "";
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { lit += "'"; i += 2; continue; }
        if (escapePrefixed && sql[i] === "\\" && i + 1 < n) {
          // Preserve the escape bytes only to locate the real closing quote.
          // We deliberately do not decode PostgreSQL's octal/hex/Unicode
          // semantics; an invoked routine using them is marked unresolved.
          lit += sql.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (sql[i] === "'") { i += 1; break; }
        lit += sql[i];
        i += 1;
      }
      // ROUND 31. A routine body may legally be a plain single-quoted string
      // rather than a `$$` block. Read as an ordinary literal, the body of
      //
      //   CREATE FUNCTION f() ... AS 'UPDATE public.order_items SET ...'
      //
      // was reported as an apply-time dynamic write, so deploying a function
      // that changes no rows demanded a one-shot money-repair override. It is
      // the same deferral the `$$` branch above already makes, so make it here
      // too: file the text under the routine's name, to be folded back in only
      // if this migration goes on to call it. The test is narrower than the
      // `$$` branch's — an exact CREATE FUNCTION/PROCEDURE head — because at
      // this point in a statement a quote can also be a COMMENT's text or a
      // SET's value, and neither is a body.
      const head = code.slice(stmtStart).trim().toLowerCase();
      // ROUND 40. PostgreSQL accepts an anonymous block as an ordinary,
      // escape, or Unicode string literal too:
      //
      //   DO E'BEGIN PERFORM public.existing_repair(); END';
      //
      // A single-quoted body is executable now, but this lexer deliberately
      // removes string contents before the call/write readers run. Treating it
      // as an ordinary literal therefore loses resident routine calls, while
      // parsing every PostgreSQL string-escape form would create a new SQL
      // parser here. CRX uses dollar-quoted anonymous blocks, so refuse every
      // non-dollar body fail-closed and keep the readable form as the control.
      if (/^do\b/.test(head)) {
        unsupportedDoBody = true;
        code += "''";
        continue;
      }
      // E'...' and U&'...' parameter defaults also appear beneath a CREATE
      // head. Require the body's AS introducer so a harmless default cannot
      // leave a second, falsely opaque definition under the routine's name.
      if (ROUTINE_CREATE_HEAD.test(head) && QUOTED_ROUTINE_BODY_HEAD.test(head)) {
        const named = ROUTINE_NAME_CAPTURE.exec(head);
        const identity = canonicalRoutineIdentity(named?.[1]);
        if (identity) {
          const inner = applyTimeCode(lit, depth + 1);
          routines.push({
            name: identity,
            code: inner.code,
            literals: inner.literals,
            // E'...' can spell UPDATE as UPD\101TE, and U&'...' has its own
            // escape alphabet. Until those PostgreSQL grammars are decoded,
            // their stored body is safe only while deferred; invocation must
            // fail closed rather than trust the raw literal bytes.
            // PostgreSQL concatenates adjacent string constants when their
            // separating whitespace contains a newline. This lexer stores one
            // literal at a time, so an invoked continued body must be opaque
            // instead of trusting only its first fragment.
            unresolved: unsafeRoutineLiteral || inner.unsupportedDoBody ||
              hasNewlineContinuedString(sql, i),
            plainQuotedBody: !unsafeRoutineLiteral,
            callableDefault: routineHasCallableParameterDefault(head),
            defaultCode: routineParameterDefaults(head).map((expression) => `SELECT ${expression}`).join(";\n"),
          });
          routines.push(...inner.routines);
          code += "''";
          continue;
        }
      }
      literals.push(lit);
      code += "''";
      continue;
    }

    // "quoted identifier" — unquoted into the stream. PostgreSQL would treat
    // "Total_Price" and total_price as different columns; folding them together
    // can only cause an extra override prompt, never a missed write.
    if (ch === '"') {
      let id = "";
      i += 1;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { id += '"'; i += 2; continue; }
        if (sql[i] === '"') { i += 1; break; }
        id += sql[i];
        i += 1;
      }
      code += canonicalQuotedIdentifier(id);
      continue;
    }

    if (ch === ";") {
      code += ";";
      i += 1;
      stmtStart = code.length;
      continue;
    }

    code += ch;
    i += 1;
  }

  // PostgreSQL can reinterpret backslashes in an otherwise plain '...'
  // routine body after this session setting is disabled. We do not attempt to
  // decode that alternate grammar: keep definitions deferred, but make any
  // same-migration invocation opaque. Quoted setting values become '' in the
  // sanitized stream, so they are conservatively included as well.
  if (DISABLES_STANDARD_CONFORMING_STRINGS.test(code)) {
    for (const routine of routines) {
      if (routine.plainQuotedBody) routine.unresolved = true;
    }
  }

  return { code, literals, routines, unsupportedDoBody };
}

function readIdent(s, pos) {
  let i = pos;
  if (i >= s.length || !IDENT_START.test(s[i])) return null;
  let out = "";
  while (i < s.length && IDENT_CHAR.test(s[i])) { out += s[i]; i += 1; }
  return { value: out, end: i };
}

function skipSpace(s, pos) {
  let i = pos;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  return i;
}

// `public.order_items` and `order_items` are the same relation here. Public is
// dropped so a waiver written one way cannot be dodged by writing the other.
// Non-public schemas stay attached: auth.users is a live fan-out source whose
// DELETE cascades into public rows, and flattening it to users loses that edge.
function readRelation(s, pos) {
  let i = skipSpace(s, pos);
  const only = /^only\b/.exec(s.slice(i));
  if (only) i = skipSpace(s, i + only[0].length);
  const first = readIdent(s, i);
  if (!first) return null;
  i = first.end;
  const firstIdentity = identifierIdentity(first.value);
  let identity = firstIdentity;
  const after = skipSpace(s, i);
  if (s[after] === ".") {
    const second = readIdent(s, skipSpace(s, after + 1));
    if (second) {
      const secondIdentity = identifierIdentity(second.value);
      identity = firstIdentity.value === "public"
        ? secondIdentity
        : {
            value: `${firstIdentity.value}.${secondIdentity.value}`,
            quoted: firstIdentity.quoted || secondIdentity.quoted,
          };
      i = second.end;
    }
  }
  return { table: identity.value, quoted: identity.quoted, end: i };
}

function canonicalRoutineIdentity(value) {
  const parts = String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .split(".")
    .filter(Boolean);
  if (!parts.length) return "";
  // PostgreSQL accepts current_database.schema.routine() at a call site. The
  // database component can only name the current database, so schema+routine
  // is the canonical identity this analyzer needs to preserve.
  return parts.slice(-2).join(".");
}

function routineBareName(identity) {
  return canonicalRoutineIdentity(identity).split(".").pop() || "";
}

// Walk forward from `pos` at paren depth 0 until one of `stops` appears as a
// whole word, or the statement ends. Used to find `SET`, and then the end of
// the assignment list.
function scanTo(s, pos, stops) {
  let depth = 0;
  let i = pos;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "(") { depth += 1; i += 1; continue; }
    if (ch === ")") { depth -= 1; i += 1; continue; }
    if (ch === ";" && depth === 0) return { hit: ";", at: i };
    if (depth === 0 && IDENT_START.test(ch) && !(i > 0 && IDENT_CHAR.test(s[i - 1]))) {
      const id = readIdent(s, i);
      if (id && stops.includes(id.value)) return { hit: id.value, at: i, end: id.end };
      if (id) { i = id.end; continue; }
    }
    i += 1;
  }
  return { hit: "", at: s.length };
}

// Split a region on commas that sit at paren depth 0.
function splitTopLevel(region) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of region) {
    if (ch === "(") { depth += 1; cur += ch; continue; }
    if (ch === ")") { depth -= 1; cur += ch; continue; }
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Column names out of an `UPDATE ... SET` list. Handles `c = x`, `c[1] = x`,
// `c.field = x` (composite), and the tuple form `(a, b) = (x, y)`.
function assignmentColumns(region) {
  const cols = [];
  for (const raw of splitTopLevel(region)) {
    const piece = raw.trim();
    if (!piece) continue;
    if (piece.startsWith("(")) {
      // `(a, b) = (...)`: every identifier in the leading group is a target.
      const close = piece.indexOf(")");
      const inner = close === -1 ? piece.slice(1) : piece.slice(1, close);
      for (const part of splitTopLevel(inner)) {
        const id = readIdent(part.trim(), 0);
        if (id) cols.push(identifierIdentity(id.value).value);
      }
      continue;
    }
    const id = readIdent(piece, 0);
    if (id) cols.push(identifierIdentity(id.value).value);
  }
  return cols;
}

// TRUNCATE empties a whole table, so it is as much a write as DELETE. Round 25
// found it missing here: a renamed apply could truncate a table a registered
// one-shot had written and produce no targets at all, skipping the override.
const WRITE_VERB = /\b(update|insert\s+into|delete\s+from|merge\s+into|truncate(?:\s+table)?|copy)\s/gi;

// `GRANT TRUNCATE ON a, b` and `REVOKE TRUNCATE ON a, b` name tables next to a
// write verb while writing nothing. The single-relation readers already fall out
// on the `ON` keyword, but the TRUNCATE list reader below walks past it to the
// second name, which would read a privilege change as emptying every table it
// lists. This repository has a pending revoke over 114 relations, so that is not
// hypothetical.
function inGrantOrRevoke(s, idx) {
  const start = s.lastIndexOf(";", idx) + 1;
  return /\b(grant|revoke)\b/.test(s.slice(start, idx));
}

// ROUND 44. PostgreSQL accepts high-bit characters in unquoted identifiers,
// but the routine-definition/call graph below canonicalizes into an ASCII token
// language. Silently truncating `public.修復()` drops both its deferred body and
// its invocation. Until that whole graph uses a Unicode-safe identity, detect
// the callable shape here and classify it fail-closed.
const CALLABLE_IDENTITY =
  /(?:^|[^A-Za-z0-9_$.\u0080-\uFFFF])((?:(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*)\s*\.\s*)*[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*)\s*\(/g;

function hasUnsupportedRoutineIdentity(code) {
  for (const raw of String(code || "").split(";")) {
    const statement = raw.trim().toLowerCase();
    if (!statement) continue;
    // Definitions/drops do not execute, but a non-ASCII definition is still
    // unsupported evidence and must not disappear. Other syntax is inspected
    // only when PostgreSQL evaluates it at apply time.
    const region = /\b(?:function|procedure)\s+/.test(statement)
      ? statement
      : runForEffectRegion(statement);
    if (!region) continue;
    CALLABLE_IDENTITY.lastIndex = 0;
    let match;
    while ((match = CALLABLE_IDENTITY.exec(region)) !== null) {
      if (/[^\x00-\x7F]/.test(match[1])) return true;
    }
  }
  return false;
}

// A write verb with no relation after it is usually a write this reader failed
// to understand — but not always. These are the positions where the word is
// part of some other construct and the missing relation is expected:
//
//   SELECT ... FOR UPDATE / FOR NO KEY UPDATE   a row lock
//   CREATE TRIGGER ... AFTER INSERT OR UPDATE   a trigger's timing
//   CREATE TRIGGER ... UPDATE OF col ON t       a trigger's column list
//   ALTER ... ON UPDATE CASCADE                 a foreign-key action
//   CREATE POLICY ... FOR UPDATE TO role        a policy's applicability
//   GRANT/REVOKE UPDATE ON t                    a privilege
//
// Anything outside this list keeps the refusal, which is the whole point of the
// rule: an unrecognised construct must not read as writing nothing.
const BENIGN_VERB_CONTEXT = /\b(for(\s+no\s+key)?|of|or|to|on|before|after|instead\s+of|not|no)\s+$/;

function benignVerbContext(s, idx) {
  if (inGrantOrRevoke(s, idx)) return true;
  const start = s.lastIndexOf(";", idx) + 1;
  const before = s.slice(start, idx);
  if (/\bcreate\s+(or\s+replace\s+)?rule\b/.test(before)) return true;
  return BENIGN_VERB_CONTEXT.test(before);
}

/**
 * The (table, column) pairs a migration writes when it is applied.
 *
 * `targets` holds `"table.column"` strings; a statement whose columns cannot be
 * enumerated (DELETE, MERGE, an INSERT with no column list, an unparseable SET)
 * contributes `"table.*"`, which is treated as covering every column of that
 * table.
 *
 * `dynamicWrites` holds the text of apply-time string literals that contain a
 * write verb — `EXECUTE format('UPDATE %I SET ...')` and friends. Their target
 * is chosen at runtime, so the caller decides how to treat them; `unresolved`
 * is true when such a literal names its relation with a format placeholder
 * instead of a literal name, which no static read can pin down.
 */
function targetsFromCode(code, literals) {
  const s = code.toLowerCase();
  const targets = new Set();
  const tables = new Set();
  // An `ON CONFLICT DO UPDATE` whose INSERT relation could not be recovered.
  // Nothing legal produces it, so if it ever happens the caller must treat the
  // migration as unresolvable rather than as writing nothing.
  let unparsedUpsert = false;
  // Set anywhere the reader sees evidence of a write it cannot pin to a table.
  // ROUND 43. A bound cursor stores its query in DECLARE and executes that
  // query later through OPEN/FETCH. Statement-by-statement call discovery does
  // not currently pair those fragments, so treating a cursor body as quiet is
  // a fail-open: `CURSOR FOR SELECT money_fix()` used to report no call and no
  // write. Cursor syntax that reaches this function is executable code (routine
  // definitions are stripped until invoked), so refuse it conservatively until
  // cursor lifecycle analysis can prove the query's effects precisely.
  const cursorConstruct =
    /\bcursor(?:\s*\([^;]*\))?\s+for\b|\bopen\s+(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)(?=\s|;|$)|\bfetch\b[^;]*\binto\b|\bmove\b[^;]*(?:\bfrom\b|\bin\b)\s*(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)(?=\s|;|$)|\bclose\s+(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)(?=\s|;|$)/.test(s);
  // Event triggers fire on database-wide DDL rather than a named relation.
  // Their live enabled set and bodies belong to the linked catalog evidence,
  // not to this fragment, and CREATE/ALTER/DROP can change that set mid-batch.
  // Refuse every event-trigger definition/change until a full DDL-event
  // lifecycle model exists; a routine that merely RETURNS event_trigger stays
  // deferred unless an EVENT TRIGGER statement attaches it.
  const eventTriggerChange = /\b(?:create|alter|drop)\s+event\s+trigger\b/.test(s);
  // VALIDATE CONSTRAINT replays a stored domain CHECK over existing values.
  // The expression is absent from this statement, so its resident routine
  // effects cannot be recovered statically and the validation must fail closed.
  const domainConstraintValidation = s.split(";").some((statement) =>
    /^\s*alter\s+domain\b[\s\S]*\bvalidate\s+constraint\b/.test(statement));
  // An unpinned event-trigger routine resolves unqualified pg_catalog helpers
  // through the applying session's search_path. Any executable search-path
  // mutation (including set_config, whose string operands were lexed out) is a
  // catalog-binding boundary and must be visible to manifest consumers.
  const searchPathChange = s.split(';').some((statement) => {
    if (/\b(?:pg_catalog\.)?set_config\s*\(/.test(statement)) return true;
    if (!/\b(?:set|reset)\s+(?:(?:local|session)\s+)?search_path\b/.test(statement)) {
      return false;
    }
    // CREATE FUNCTION ... SET search_path records deferred routine config; it
    // does not mutate the applying session. An attached event routine is still
    // caught by eventTriggerChange, and ALTER FUNCTION remains conservative.
    return !/^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\b/.test(statement);
  });
  const unsupportedRoutineIdentity = hasUnsupportedRoutineIdentity(s);
  // `nextval` and `setval` persistently change a sequence even when they are
  // written inside SELECT/PERFORM rather than a DML verb. Restrict call
  // detection to the executable region of each statement so stored defaults,
  // views, policies, and uninvoked routine bodies remain deferred. Explicit
  // restart DDL mutates the counter directly and therefore also fails closed.
  const sequenceMutation = s.split(";").some((raw) => {
    const executable = runForEffectRegion(raw.trim());
    return /\b(?:(?:pg_catalog)\s*\.\s*)?(?:nextval|setval)\s*\(/.test(executable);
  }) || /\balter\s+sequence\b[^;]*\brestart\b/.test(s) ||
    /\btruncate\b[^;]*\brestart\s+identity\b/.test(s) ||
    /\balter\s+table\b[^;]*\balter\s+(?:column\s+)?[a-z0-9_]+\s+restart\b/.test(s);
  let unresolved = cursorConstruct || eventTriggerChange || domainConstraintValidation ||
    unsupportedRoutineIdentity || sequenceMutation;

  WRITE_VERB.lastIndex = 0;
  let m;
  // `INSERT INTO t ... ON CONFLICT DO UPDATE SET c = ...` writes `t.c`, but the
  // word after that `UPDATE` is `SET`, not a relation. The upsert's target is
  // the INSERT's, so the most recent one is carried forward.
  let lastInsertTable = "";
  while ((m = WRITE_VERB.exec(s)) !== null) {
    const verb = m[1].replace(/\s+/g, " ");

    if (verb === "truncate" || verb === "truncate table") {
      // `TRUNCATE [TABLE] [ONLY] a [, [ONLY] b ...] [RESTART|CONTINUE IDENTITY]
      // [CASCADE|RESTRICT]`. Every name in the list loses all its rows, so each
      // one is a whole-table write; reading only the first would miss the rest.
      if (inGrantOrRevoke(s, m.index)) continue;
      const from = m.index + m[0].length - 1;
      const stop = scanTo(s, from, ["restart", "continue", "cascade", "restrict"]);
      for (const part of splitTopLevel(s.slice(from, stop.at))) {
        const rel = readRelation(part, 0);
        if (!rel || (NON_RELATION_KEYWORDS.has(rel.table) && !rel.quoted)) continue;
        if (rel.quoted && NON_RELATION_KEYWORDS.has(rel.table)) unresolved = true;
        tables.add(rel.table);
        targets.add(`${rel.table}.*`);
      }
      continue;
    }

    if (verb === "update") {
      // ON CONFLICT DO UPDATE SET — attribute to the INSERT's relation.
      if (/\bdo\s*$/.test(s.slice(Math.max(0, m.index - 16), m.index))) {
        const set = scanTo(s, m.index + m[0].length, ["set"]);
        const table = lastInsertTable || "";
        if (!table) { unparsedUpsert = true; continue; }
        if (set.hit !== "set") { targets.add(`${table}.*`); continue; }
        const stop = scanTo(s, set.end, ["from", "where", "returning"]);
        const cols = assignmentColumns(s.slice(set.end, stop.at));
        if (cols.length === 0) targets.add(`${table}.*`);
        else for (const c of cols) targets.add(`${table}.${c}`);
        continue;
      }
    }

    const rel = readRelation(s, m.index + m[0].length - 1);
    if (!rel) {
      // ROUND 25, AND THE REASON THERE SHOULD NOT BE A ROUND 26 OF THIS KIND.
      // A write verb with no readable relation after it means the reader saw a
      // write and could not say what it writes. Every previous round of this
      // guard's history was a spelling of a write the reader silently scored as
      // zero writes; this turns that silence into a refusal, so a construct
      // nobody anticipated fails toward the override prompt instead of through
      // it. Measured across all 882 migrations in this repository, it fires on
      // four files, none of which touch a registered one-shot's tables.
      if (!benignVerbContext(s, m.index)) unresolved = true;
      continue;
    }
    // NOT EVERY `UPDATE` IS A WRITE. `GRANT UPDATE ON t`, `REVOKE UPDATE ON t`,
    // `CREATE TRIGGER ... AFTER UPDATE OF c ON t`, `CREATE POLICY ... FOR
    // UPDATE USING (...)`, and `SELECT ... FOR UPDATE` all put a keyword where
    // a relation would go. Reading that keyword as a table name invented
    // targets like `on.*` and `of.*` — noise that hides the real ones.
    if (NON_RELATION_KEYWORDS.has(rel.table) && !rel.quoted) continue;
    if (rel.quoted && NON_RELATION_KEYWORDS.has(rel.table)) unresolved = true;
    tables.add(rel.table);
    if (verb === "insert into") lastInsertTable = rel.table;

    if (verb === "update") {
      const set = scanTo(s, rel.end, ["set"]);
      if (set.hit !== "set") { targets.add(`${rel.table}.*`); continue; }
      const stop = scanTo(s, set.end, ["from", "where", "returning"]);
      const cols = assignmentColumns(s.slice(set.end, stop.at));
      if (cols.length === 0) targets.add(`${rel.table}.*`);
      else for (const c of cols) targets.add(`${rel.table}.${c}`);
      continue;
    }

    if (verb === "insert into") {
      let i = skipSpace(s, rel.end);
      // An alias may sit between the relation and the column list.
      const asKw = /^as\b/.exec(s.slice(i));
      if (asKw) i = skipSpace(s, i + asKw[0].length);
      if (s[i] === "(") {
        let depth = 0;
        let j = i;
        for (; j < s.length; j += 1) {
          if (s[j] === "(") depth += 1;
          else if (s[j] === ")") { depth -= 1; if (depth === 0) break; }
        }
        const cols = splitTopLevel(s.slice(i + 1, j))
          .map((p) => readIdent(p.trim(), 0))
          .filter(Boolean)
          .map((id) => identifierIdentity(id.value).value);
        if (cols.length === 0) targets.add(`${rel.table}.*`);
        else for (const c of cols) targets.add(`${rel.table}.${c}`);
      } else {
        // `INSERT INTO t VALUES (...)` names no columns: it writes all of them.
        targets.add(`${rel.table}.*`);
      }
      continue;
    }

    // DELETE and MERGE remove or rewrite whole rows.
    targets.add(`${rel.table}.*`);
  }

  // A column type change rewrites every existing value in that column, and
  // `USING <expr>` lets the rewrite be any expression at all — `ALTER COLUMN
  // total_price TYPE numeric USING round(total_price)` re-performs a rounding
  // repair without containing a single write verb. Whole-column, so `table.*`.
  const ALTER_TABLE = /\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?/g;
  let am;
  while ((am = ALTER_TABLE.exec(s)) !== null) {
    const rel = readRelation(s, am.index + am[0].length - 1);
    if (!rel || (NON_RELATION_KEYWORDS.has(rel.table) && !rel.quoted)) continue;
    const stmtEnd = s.indexOf(";", am.index);
    const body = s.slice(rel.end, stmtEnd === -1 ? s.length : stmtEnd);
    if (/\balter\s+(?:column\s+)?[a-z0-9_"]+\s+(?:set\s+data\s+)?type\b/.test(body)) {
      tables.add(rel.table);
      targets.add(`${rel.table}.*`);
    }
  }

  // VALIDATE CONSTRAINT evaluates a stored CHECK against existing rows. The
  // expression is not present in this migration, so a resident routine inside
  // it cannot be enumerated. Refuse rather than treating the validation as a
  // schema-only no-op. ADD CHECK is inspected by unknownCallsIn; NOT VALID is
  // deliberately deferred and therefore does not run here.
  if (/\balter\s+table\b[^;]*\bvalidate\s+constraint\b/.test(s)) unresolved = true;

  const dynamicWrites = [];

  // ROUND 25. Scanning string literals one at a time cannot see a statement that
  // was assembled from several of them. `EXECUTE 'UPDATE ' || 'public.order_items
  // SET total_price = 0'` puts the verb in one fragment and the relation in the
  // next, so each fragment read alone is harmless: the first has no table, the
  // second has no verb, and the write is reported as nothing at all.
  //
  // The fragments cannot be usefully reassembled — `EXECUTE v_sql` builds the
  // text somewhere else entirely. So the operand is judged instead of the
  // pieces: a single complete literal is readable, and anything else —
  // concatenation, a variable, a function result — is unresolvable and refuses.
  //
  // ROUND 26. `format(...)` used to count as readable, on the reasoning that its
  // placeholders were caught further down. They were caught only in the position
  // where a placeholder names the *relation*, after a write verb the scanner had
  // already recognised. A placeholder can also split the verb itself:
  //
  //   EXECUTE format('UP%sATE public.order_items SET total_price = 0', 'D')
  //
  // PostgreSQL runs an UPDATE; no single literal contains the word. So format is
  // no longer readable in any shape. A constant format string loses only the
  // column-level precision of the target and keeps the refusal, since an
  // unresolved operand refuses against any registered one-shot's tables — the
  // strictly safer direction.
  //
  // Measured over all 882 migrations in this tree, under both rules: 11 mention
  // `EXECUTE format`, and 8 change classification. All eight assemble a SET
  // LOCAL, a REVOKE, an ALTER TABLE ... ADD CONSTRAINT or a CREATE SEQUENCE, so
  // none of them writes a row; they now reach the override prompt, which is the
  // accepted cost. An allowlist of leading statement keywords would silence them
  // and open a fresh attack surface — a positional placeholder ahead of the verb,
  // a comment before it, a placeholder inside the keyword itself — which is the
  // surface that produced the previous nine review rounds. Widen there and
  // re-measure if it ever becomes worth it; do not make `format` readable again.
  const EXEC_OPERAND_READABLE = /^''\s*$/;
  const EXEC_STMT = /\bexecute\s+/g;
  let xm;
  // ROUND 29. Whether this code runs dynamic SQL at all. A readable operand no
  // longer ends the analysis — see `applyTimeWriteTargets`, which reads the
  // literals as SQL — so the fact has to leave this function.
  let dynamicExec = false;
  while ((xm = EXEC_STMT.exec(s)) !== null) {
    // `CREATE TRIGGER ... EXECUTE FUNCTION f()` and `GRANT/REVOKE EXECUTE ON
    // FUNCTION f` spell EXECUTE without running any dynamic SQL.
    const rest = s.slice(xm.index + xm[0].length);
    if (/^(function|procedure)\b/.test(rest)) continue;
    if (inGrantOrRevoke(s, xm.index)) continue;
    dynamicExec = true;
    // `EXECUTE <expr> [INTO target] [USING args]` — only the expression matters.
    const stop = scanTo(s, xm.index + xm[0].length, ["into", "using"]);
    if (!EXEC_OPERAND_READABLE.test(s.slice(xm.index + xm[0].length, stop.at).trim())) {
      unresolved = true;
    }
  }

  for (const lit of literals) {
    const dm = /\b(update|insert\s+into|delete\s+from|merge\s+into|truncate(?:\s+table)?)\s+/i.exec(lit);
    if (!dm) continue;
    dynamicWrites.push(lit);
    const rest = lit.slice(dm.index + dm[0].length).replace(/^only\s+/i, "");
    if (FORMAT_PLACEHOLDER.test(rest.trim())) unresolved = true;
  }

  return {
    targets,
    tables,
    dynamicWrites,
    unresolved: unresolved || unparsedUpsert,
    dynamicExec,
    eventTriggerChange,
    domainConstraintValidation,
    sequenceMutation,
    searchPathChange,
    unsupportedRoutineIdentity,
  };
}

// Which of `defined` does this code actually invoke? A name followed by `(` is
// a call in every executing position — `CALL f()`, `PERFORM f()`, `SELECT f()`,
// `SELECT * FROM f()`, an argument, a default. The one position where it is NOT
// a call is right after the words FUNCTION or PROCEDURE, which is how
// `CREATE FUNCTION f(`, `GRANT EXECUTE ON FUNCTION f(`, `DROP FUNCTION f(`, and
// `ALTER FUNCTION f(` all read. Excluding exactly that keeps a migration free to
// define and grant a routine without being charged for its body.
//
// `DROP FUNCTION IF EXISTS f()` puts two words between the keyword and the
// name, and reading that as a call charged a plain drop-and-redefine — the most
// ordinary shape in this repository — for the body it was replacing.
const NOT_A_CALL = /\b(function|procedure)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:[a-z0-9_]+\.)*$/;

// ROUND 28. A TRIGGER IS A STANDING INVOCATION.
//
// Round 24 made a body count once the migration calls it, and `CREATE TRIGGER
// ... EXECUTE FUNCTION f()` is deliberately NOT such a call — attaching a
// trigger runs nothing, and charging every trigger creation for its function's
// body would demand an override for most schema work in this repository. That
// exclusion is correct and stays. What it missed is the statement AFTER it:
//
//   CREATE FUNCTION tmp_fix() RETURNS trigger AS $$
//     UPDATE public.order_items SET profit = (profit); $$;
//   CREATE TEMP TABLE scratch(id integer);
//   CREATE TRIGGER run_fix AFTER INSERT ON scratch
//     FOR EACH ROW EXECUTE FUNCTION tmp_fix();
//   INSERT INTO scratch(id) VALUES (1);
//
// Every statement is individually harmless and the analyzer reported exactly
// `scratch.id`, unresolved false, no unknown calls — while applying it rewrote
// a money column and re-fired the authoritative profit trigger. The attachment
// is the missing edge: firing DML on the trigger's relation runs the function
// as surely as `SELECT f()` does.
//
// So attachments are recorded here and the caller fires one once it sees an
// apply-time write to that relation. Ordering is not modelled — DML written
// ABOVE the CREATE TRIGGER fires nothing in reality but is charged anyway,
// which is the over-reporting direction this module always takes.
const TRIGGER_STMT = /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+/g;
const RULE_STMT = /\bcreate\s+(?:or\s+replace\s+)?rule\s+/g;
const OPERATOR_RUN = /[+\-*\/<>=~!@#%^&|`?]+/g;

/**
 * `{ table, fn }` for every trigger this SQL attaches at apply time.
 *
 * `table` is the relation the trigger fires on and `fn` is the canonical
 * schema-qualified function identity. The relation remains schema-stripped to
 * match the protected-table inventory; routine schemas must not collide.
 */
export function triggerAttachments(code) {
  const s = (code || "").toLowerCase();
  const out = [];
  TRIGGER_STMT.lastIndex = 0;
  let m;
  while ((m = TRIGGER_STMT.exec(s)) !== null) {
    const semi = s.indexOf(";", m.index);
    const body = s.slice(m.index, semi === -1 ? s.length : semi);
    // `... ON relation ...`. The first ON at paren depth zero: a `WHEN (...)`
    // condition can spell the word too, and `UPDATE OF on_hand` reads as one
    // identifier, so neither is mistaken for the relation clause.
    const on = scanTo(body, 0, ["on"]);
    if (on.hit !== "on") continue;
    const rel = readRelation(body, on.end);
    if (!rel || (NON_RELATION_KEYWORDS.has(rel.table) && !rel.quoted)) continue;
    const fn = /\bexecute\s+(?:function|procedure)\s+((?:[a-z0-9_]+\s*\.\s*)*[a-z0-9_]+)/.exec(body);
    if (!fn) continue;
    out.push({ table: rel.table, fn: canonicalRoutineIdentity(fn[1]) });
  }
  return out;
}

function invokedRoutines(codeLower, defined) {
  // Callers commonly pass Map#keys(), which is a one-shot iterator. Reusing it
  // for each executable statement would exhaust it after the first statement
  // and silently miss calls in every later statement.
  const identities = [...defined].map(canonicalRoutineIdentity).filter(Boolean);
  const found = new Set();
  for (const raw of String(codeLower || "").split(";")) {
    const executable = runForEffectRegion(raw.trim());
    if (!executable) continue;
    const re = /(?<![a-z0-9_.])((?:[a-z0-9_]+\s*\.\s*)*[a-z0-9_]+)\s*\(/g;
    let mm;
    while ((mm = re.exec(executable)) !== null) {
      if (NOT_A_CALL.test(executable.slice(0, mm.index))) continue;
      const called = canonicalRoutineIdentity(mm[1]);
      if (!called) continue;
      if (called.includes(".")) {
        if (identities.includes(called)) found.add(called);
        continue;
      }
      // An unqualified call can resolve to any same-file definition with this
      // bare name. Fold every candidate body, but unknownCallsIn deliberately
      // keeps the call unresolved because search_path was not proven.
      for (const identity of identities) {
        if (routineBareName(identity) === called) found.add(identity);
      }
    }
  }
  return found;
}

// A statement that exists to run something, as opposed to defining it. Round 25
// found that restricting the unknown-call scan to CALL and PERFORM missed the
// most ordinary spelling of all: `SELECT public.existing_repair();` runs the
// routine exactly as CALL does, and was reported as calling nothing.
//
// ROUND 30 widened it again, for the same reason one step further out: a routine
// runs wherever a statement runs it, not only where the statement BEGINS with a
// verb that runs. The review's probe of
//
//     INSERT INTO scratch VALUES (public.wrapper());
//
// was reported as calling nothing at all. Its head is INSERT, so this test
// failed and the entire statement — operands included — went unread. PostgreSQL
// evaluates those operands while the migration applies, so a database-resident
// wrapper called from one of them executes unseen, and the migration is charged
// only with the scratch write it declares. That is a way through both new
// guards, since the apply guard fails closed on this inventory.
//
// Every head listed here is a statement whose operand expressions are evaluated
// at apply time. Definition verbs are deliberately absent: a policy's USING, a
// column DEFAULT, a trigger's WHEN and a routine's body are all deferred until
// something later fires them, and reading them here would charge a migration for
// writes it does not perform. The three definition statements that DO evaluate
// an expression while applying are handled separately below.
const RUNS_FOR_EFFECT =
  /^(select|table|call|perform|with|do|values|insert|update|delete|merge|refresh|explain)\b/;

// `CREATE TABLE ... AS SELECT` and `CREATE MATERIALIZED VIEW ... AS SELECT`
// evaluate their query as they apply. Plain `CREATE VIEW ... AS SELECT` is
// excluded on purpose — defining a view runs nothing.
const CREATE_RUNS_QUERY =
  /^create\s+(or\s+replace\s+)?(global\s+|local\s+)?(temp\w*\s+|unlogged\s+)?(table|materialized\s+view)\b/;
const AS_QUERY = /\bas\s+(select|with|values)\b/;

// An expression index evaluates its expression per row as the index is built.
// The leading `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON
// [ONLY] <table> [USING <method>]` is stripped rather than matched around,
// because once the ON keyword is behind us `<table> (` is indistinguishable from
// a call — and so is the access method in `USING btree (col)`.
const INDEX_PREFIX =
  /^create\s+(unique\s+)?index\s+(concurrently\s+)?(if\s+not\s+exists\s+)?([a-z0-9_."]+\s+)?on\s+(only\s+)?[a-z0-9_."]+\s*(using\s+[a-z0-9_]+\s*)?/;

// `ALTER TABLE ... ALTER COLUMN ... TYPE ... USING <expr>` runs <expr> once per
// existing row. Round 29 taught the approved-set scanner to read that shape as a
// rewrite; this teaches the analyzer to read the call inside it. Scoped to ALTER
// TABLE so that `ALTER POLICY ... USING (...)`, which is deferred, stays out.
const RETYPE_USING = /\busing\s/;
const ADD_COLUMN_DEFAULT =
  /\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?[a-z_][a-z0-9_$]*\b[\s\S]*?\bdefault\s+/;
const ADD_COLUMN_GENERATED =
  /\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?[a-z_][a-z0-9_$]*\b[\s\S]*?\bgenerated\s+always\s+as\s*\(/;
const ADD_CHECK_CONSTRAINT =
  /\badd\s+(?:constraint\s+[a-z_][a-z0-9_$]*\s+)?check\s*\(/;

// Splitting a routine body on `;` leaves the first statement fused to the block
// keywords in front of it — `BEGIN PERFORM repair()` arrives as one fragment
// whose first word is BEGIN, which is how the round-25 test case of a helper
// calling a database-resident routine slipped past a leading-keyword test.
// These carry no meaning of their own, so they are peeled off before the test.
const BLOCK_LEAD = /^(begin|declare|end(\s+(if|loop))?|then|else|loop|do|exception|when\s+others|<<[a-z0-9_]+>>|\$\$|as)\b\s*/;

// ROUND 31. Peeling the block keywords off the FRONT only reaches a statement
// that happens to sit at the start of its fragment. A control structure puts
// one further in:
//
//   DO $$ BEGIN IF true THEN SELECT public.existing_repair(); END IF; END $$;
//
// splits to a fragment reading `IF true THEN SELECT ...`. `IF` is not a running
// verb and is not a block lead — a condition sits between it and the statement —
// so the region came back empty and the resident routine was reported as never
// called. THEN, ELSE and LOOP each introduce a statement, and `FOR ... IN` is
// followed by a query that runs, so a running verb immediately after any of them
// is scanned from there.
//
// This cannot reach into a definition: the create/alter branches below return
// their own executing tail and never fall through to here, so a CHECK holding a
// CASE ... THEN, or a policy's USING, still contributes nothing.
const CONTROL_INTRO = /\b(?:then|else|loop|\bin)\s+/g;

// ROUND 32. A control fragment evaluates more than the statement introduced by
// THEN/ELSE/LOOP. Its condition is executable too, as are assignment and
// declaration initializers:
//
//   IF public.existing_repair() THEN NULL; END IF;
//   v_result := public.existing_repair();
//   v_result boolean := public.existing_repair();
//
// A database-resident routine in any of those expressions runs while the
// migration applies. Definitions still return above without reaching this
// branch, so stored CHECK/policy/view/default expressions remain quiet.
const PLPGSQL_EVALUATED_EXPRESSION =
  /^(?:if|elsif|elseif|while|case|for|foreach|assert|raise|return(?:\s+(?:next|query))?|exit\s+when|continue\s+when)\b|^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?(?:\[[^\]]+\])?\s*(?::=|=(?!=))|^[a-z_][a-z0-9_]*\s+(?:constant\s+)?[a-z_][a-z0-9_.]*(?:(?:%type|%rowtype)|\s*\([^)]*\)|\s*\[\])*(?:\s+not\s+null)?\s*(?::=|default\b)/;

function runForEffectRegion(stmt) {
  let rest = stmt;
  let prev;
  do { prev = rest; rest = rest.replace(BLOCK_LEAD, ""); } while (rest !== prev);
  if (RUNS_FOR_EFFECT.test(rest)) return rest;
  // The definition verbs that still evaluate an expression as they apply. Each
  // returns only its executing TAIL, never the whole statement: read from the
  // head, the target table's own name would be charged as a call.
  if (/^create\b/.test(rest)) {
    const idx = INDEX_PREFIX.exec(rest);
    if (idx) return rest.slice(idx[0].length);
    if (CREATE_RUNS_QUERY.test(rest)) {
      const as = AS_QUERY.exec(rest);
      if (as) return rest.slice(as.index + as[0].length - as[1].length);
    }
    return "";
  }
  if (/^alter\s+table\b/.test(rest)) {
    const using = RETYPE_USING.exec(rest);
    if (using) return rest.slice(using.index);
    const addedDefault = ADD_COLUMN_DEFAULT.exec(rest);
    if (addedDefault) return rest.slice(addedDefault.index + addedDefault[0].lastIndexOf("default"));
    const generated = ADD_COLUMN_GENERATED.exec(rest);
    if (generated) return rest.slice(generated.index + generated[0].lastIndexOf("generated"));
    const check = ADD_CHECK_CONSTRAINT.exec(rest);
    if (check && !/\bnot\s+valid\b/.test(rest)) {
      return rest.slice(check.index + check[0].lastIndexOf("check"));
    }
    return "";
  }
  if (/^alter\s+domain\b/.test(rest)) {
    // ADD CONSTRAINT without NOT VALID immediately checks every existing
    // domain value. Its CHECK expression therefore executes at apply time.
    const check = /\bcheck\s*\(/.exec(rest);
    if (check && !/\bnot\s+valid\b/.test(rest)) return rest.slice(check.index);
    return "";
  }

  // The expression at the head of a control fragment executes before the arm's
  // statement. Keep the WHOLE fragment here: returning only a later PERFORM,
  // CALL, or THEN/ELSE tail would discard a callable IF/ELSIF/WHILE condition.
  if (PLPGSQL_EVALUATED_EXPRESSION.test(rest)) return rest;

  // A statement introduced by a control structure rather than beginning the
  // fragment. Reached only when the fragment is not a definition and its head
  // is not itself an evaluated PL/pgSQL expression.
  CONTROL_INTRO.lastIndex = 0;
  let intro;
  while ((intro = CONTROL_INTRO.exec(rest)) !== null) {
    const tail = rest.slice(intro.index + intro[0].length);
    if (RUNS_FOR_EFFECT.test(tail)) return tail;
  }

  // PERFORM and CALL exist only as statement verbs. This broad suffix fallback
  // is deliberately last so it cannot hide an earlier executable expression in
  // the same semicolon-delimited fragment.
  const verb = /\b(perform|call)\s+/.exec(rest);
  if (verb) return rest.slice(verb.index);
  return "";
}

/**
 * Routine identities whose catalog entry this SQL creates, replaces, alters,
 * or drops. Comments, metadata strings, and routine bodies are removed first,
 * so prose and deferred code cannot invent a catalog mutation. A
 * current-database qualifier is reduced to its final schema/name pair; an
 * unqualified identity keeps an empty schema so callers can bind it
 * conservatively through search_path.
 */
export function routineIdentityChanges(sql) {
  const code = applyTimeCode(sql).code.toLowerCase();
  const changes = [];
  let unparsed = false;
  const head = /\b(?:create\s+(?:or\s+replace\s+)?|alter\s+|drop\s+)(?:function|procedure|routine)\s+(?:if\s+(?:not\s+)?exists\s+)?/g;
  let match;
  while ((match = head.exec(code)) !== null) {
    let i = skipSpace(code, match.index + match[0].length);
    const parts = [];
    while (i < code.length) {
      const ident = readIdent(code, i);
      if (!ident) break;
      parts.push(identifierIdentity(ident.value).value);
      i = skipSpace(code, ident.end);
      if (code[i] !== ".") break;
      i = skipSpace(code, i + 1);
    }
    if (!parts.length) {
      unparsed = true;
      continue;
    }
    changes.push({
      schema: parts.length > 1 ? parts.at(-2) : "",
      name: parts.at(-1),
    });
  }
  return { changes, unparsed };
}

/**
 * Custom PostgreSQL operators defined by this SQL. An operator call does not
 * look like `routine_name(...)`, but PostgreSQL dispatches it to the routine
 * named by FUNCTION/PROCEDURE. Pair the two so operator syntax cannot hide a
 * mutating routine from the ordinary transitive call graph.
 */
export function operatorDefinitions(code) {
  const out = [];
  for (const statement of String(code || "").toLowerCase().split(";")) {
    const head = /\bcreate\s+operator\s+(?:[a-z_][a-z0-9_$]*\s*\.\s*)?([+\-*\/<>=~!@#%^&|`?]+)\s*\(/.exec(statement);
    if (!head) continue;
    const backing = /\b(?:function|procedure)\s*=\s*((?:[a-z_][a-z0-9_$]*\s*\.\s*)*[a-z_][a-z0-9_$]*)/.exec(statement);
    out.push({ operator: head[1], fn: canonicalRoutineIdentity(backing?.[1]) });
  }
  return out;
}

function operatorRunsOutsideDefinitions(code) {
  const executable = String(code || "")
    .split(";")
    .filter((statement) => !/\bcreate\s+operator\b/i.test(statement))
    .join(";");
  return new Set(executable.match(OPERATOR_RUN) || []);
}

function invokedOperators(code, definitions) {
  const runs = operatorRunsOutsideDefinitions(code);
  return definitions.filter((definition) => runs.has(definition.operator));
}

function normalizeCastType(type) {
  return String(type || "").toLowerCase().replace(/"/g, "").replace(/\s+/g, "");
}

function bareCastType(type) {
  const normalized = normalizeCastType(type);
  const array = normalized.endsWith("[]") ? "[]" : "";
  const base = array ? normalized.slice(0, -2) : normalized;
  return `${base.split(".").pop() || ""}${array}`;
}

/**
 * Custom PostgreSQL casts and domains defined by this SQL. WITH FUNCTION
 * dispatches to an ordinary routine without spelling a conventional call;
 * WITH INOUT dispatches through type I/O routines whose identities are not
 * present in the statement. A domain cast evaluates its stored CHECK
 * expressions, whose live routine identities likewise cannot be proven from
 * the cast site. Those opaque coercions use an empty backing function and are
 * refused only when an apply-time expression actually invokes them.
 */
export function castDefinitions(code) {
  const out = [];
  for (const statement of String(code || "").toLowerCase().split(";")) {
    if (/\bcreate\s+domain\b/.test(statement)) {
      const header = /\bcreate\s+domain\s+(?:if\s+not\s+exists\s+)?((?:[a-z_][a-z0-9_$]*\s*\.\s*)?[a-z_][a-z0-9_$]*)\b/.exec(statement.replace(/"/g, ""));
      out.push({
        source: "",
        target: header ? normalizeCastType(header[1]) : "",
        fn: "",
        context: "domain",
      });
      continue;
    }
    if (!/\bcreate\s+cast\b/.test(statement)) continue;
    const header = /\bcreate\s+cast\s*\(\s*([a-z_][a-z0-9_$]*(?:\s*\.\s*[a-z_][a-z0-9_$]*)?(?:\s*\[\s*\])?)\s+as\s+([a-z_][a-z0-9_$]*(?:\s*\.\s*[a-z_][a-z0-9_$]*)?(?:\s*\[\s*\])?)\s*\)/.exec(statement.replace(/"/g, ""));
    const backing = /\bwith\s+function\s+((?:[a-z_][a-z0-9_$]*\s*\.\s*)*[a-z_][a-z0-9_$]*)\s*\(/.exec(statement.replace(/"/g, ""));
    const inout = /\bwith\s+inout\b/.test(statement);
    const context = /\bas\s+(implicit|assignment)\b/.exec(statement)?.[1] || "explicit";
    if (!header || (!backing && !inout)) {
      // An unparsed custom cast is still evidence. Any apply-time expression in
      // the same analysis scope can invoke an implicit/assignment cast, so the
      // unknown record fails closed once executable code is present.
      out.push({ source: "", target: "", fn: "", context: "unknown" });
      continue;
    }
    out.push({
      source: normalizeCastType(header[1]),
      target: normalizeCastType(header[2]),
      fn: canonicalRoutineIdentity(backing?.[1]),
      context,
    });
  }
  return out;
}

function invokedCasts(code, definitions) {
  const regions = String(code || "")
    .split(";")
    .filter((statement) => !/\bcreate\s+cast\b/i.test(statement))
    .map((statement) => runForEffectRegion(statement.trim().toLowerCase()))
    .filter(Boolean);
  if (!regions.length) return [];
  return definitions.filter((definition) => {
    // Type resolution for implicit and assignment casts requires the live
    // catalog. Any executable expression can select one, so conservatively
    // follow/refuse its backing routine rather than pretending it did not run.
    if (definition.context !== "explicit" && definition.context !== "domain") return true;
    const target = bareCastType(definition.target);
    if (!target) return true;
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const qualified = `(?:[a-z_][a-z0-9_$]*\\s*\\.\\s*)?${escaped}`;
    const shorthand = new RegExp(`::\\s*${qualified}(?![a-z0-9_$])`);
    const standard = new RegExp(`\\bcast\\s*\\([\\s\\S]*?\\bas\\s+${qualified}\\s*\\)`);
    return regions.some((region) => shorthand.test(region) || standard.test(region));
  });
}

/** Relations that receive a standing PostgreSQL rule in this migration. */
export function ruleAttachments(code) {
  const source = String(code || "");
  const s = source.toLowerCase();
  const out = [];
  RULE_STMT.lastIndex = 0;
  let m;
  while ((m = RULE_STMT.exec(s)) !== null) {
    const nameStart = skipSpace(s, m.index + m[0].length);
    const ruleName = readIdent(source, nameStart);
    const semi = s.indexOf(";", m.index);
    const body = s.slice(m.index, semi === -1 ? s.length : semi);
    const eventMatch = /\bas\s+on\s+(select|insert|update|delete)\s+to\b/.exec(body);
    const to = scanTo(body, 0, ["to"]);
    if (!ruleName || !eventMatch || to.hit !== "to") continue;
    const rel = readRelation(body, to.end);
    if (!rel || (NON_RELATION_KEYWORDS.has(rel.table) && !rel.quoted)) continue;
    const nameIdentity = identifierIdentity(ruleName.value);
    const name = nameIdentity.quoted ? nameIdentity.value : nameIdentity.value.toLowerCase();
    const parts = rel.table.split(".");
    const schema = parts.length === 2 ? parts[0] : "public";
    const relation = parts.at(-1);
    out.push({ name, schema, relation, table: rel.table, event: eventMatch[1] });
  }
  return [...new Map(out.map((rule) => [ruleAttachmentIdentity(rule), rule])).values()];
}

/** Stable full identity for a PostgreSQL rewrite-rule attachment. */
export function ruleAttachmentIdentity(rule) {
  return `${rule?.schema || ""}\0${rule?.relation || ""}\0${rule?.event || ""}\0${rule?.name || ""}`;
}

/** Ordinary (non-materialized) view definitions and their stored query text. */
export function viewDefinitions(code) {
  const out = [];
  for (const statement of String(code || "").split(";")) {
    const normalized = statement.toLowerCase().replace(/"/g, "");
    const head = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|recursive)\s+)*view\s+(?:if\s+not\s+exists\s+)?(?:[a-z_][a-z0-9_$]*\s*\.\s*)?([a-z_][a-z0-9_$]*)\b/.exec(normalized);
    if (!head || /\bcreate\s+(?:or\s+replace\s+)?materialized\s+view\b/.test(normalized)) continue;
    const tail = normalized.slice((head.index || 0) + head[0].length);
    const as = /\bas\s+/.exec(tail);
    out.push({ name: head[1], query: as ? tail.slice(as.index + as[0].length).trim() : "" });
  }
  return out;
}

function invokedViews(code, definitions) {
  const names = new Set(definitions.map((definition) => definition.name).filter(Boolean));
  if (!names.size) return [];
  const found = new Set();
  for (const statement of String(code || "").split(";")) {
    const region = runForEffectRegion(statement.trim().toLowerCase().replace(/"/g, ""));
    if (!region) continue;
    const relation = /\b(?:from|join|update|into|table)\s+(?:only\s+)?(?:[a-z_][a-z0-9_$]*\s*\.\s*)?([a-z_][a-z0-9_$]*)\b/g;
    let match;
    while ((match = relation.exec(region)) !== null) {
      if (names.has(match[1])) found.add(match[1]);
    }
  }
  return definitions.filter((definition) => found.has(definition.name));
}

/** Relations read by SQL that executes while the migration applies. */
function invokedRelations(code) {
  const found = new Set();
  for (const statement of String(code || "").split(";")) {
    const region = runForEffectRegion(statement.trim().toLowerCase().replace(/"/g, ""));
    if (!region) continue;
    const relation = /\b(?:from|join|using|table)\b/g;
    let match;
    while ((match = relation.exec(region)) !== null) {
      const parsed = readRelation(region, match.index + match[0].length);
      if (parsed && !(NON_RELATION_KEYWORDS.has(parsed.table) && !parsed.quoted)) {
        found.add(parsed.table);
      }
    }
  }
  return found;
}

// ROUND 29. The verbs that begin a statement PostgreSQL will run. Used to tell
// a string literal that is SQL from one that is a comment, an error message or
// a column default. Deliberately wider than the write verbs: a literal handed to
// EXECUTE may call a routine, rewrite a column's type, or define a trigger, and
// none of those spells UPDATE.
const STATEMENT_HEAD = /^(select|table|with|call|perform|do|update|insert|delete|merge|truncate|copy|alter|create|drop|grant|revoke|comment|refresh|set|reset|execute|lock|analyze|vacuum|reindex|cluster|values|explain)\b/;

function readsAsStatement(text) {
  let rest = String(text).trim().toLowerCase();
  let prev;
  do { prev = rest; rest = rest.replace(BLOCK_LEAD, ""); } while (rest !== prev);
  return STATEMENT_HEAD.test(rest);
}

// Names that are followed by `(` without being a call to a routine whose body we
// would need to read: SQL syntax (`exists (`, `in (`, `cast (`), type names in a
// cast or column definition (`numeric(12,2)`), and PostgreSQL's own functions.
//
// Membership here is deliberately explicit rather than a prefix rule such as
// "anything starting with pg_". A prefix rule is an escape hatch — a routine can
// be created under any name — and this list is the one place where a name gets
// to mean "reading the body is unnecessary".
//
// A builtin missing from this list costs one override prompt on a migration that
// also has to be replaying a registered one-shot. That is the safe direction.
const NOT_A_ROUTINE_CALL = new Set([
  // Syntax that takes a parenthesized operand.
  "in", "exists", "and", "or", "not", "any", "all", "some", "from", "as", "on",
  "select", "where", "using", "join", "filter", "cast", "position", "when", "check",
  "case", "values", "row", "over", "within", "order", "group", "having",
  "returning", "set", "distinct", "between", "like", "overlaps", "at", "by",
  // `ON CONFLICT (v) DO UPDATE` — reachable only since round 30 taught this scan
  // to read INSERT statements, and `conflict (` is not a routine.
  "conflict", "nothing", "each", "lateral", "tablesample", "grouping",
  "into", "for", "of", "if", "then", "else", "end", "loop", "while", "return",
  "t", "p", "r", "x", "e", "c", "o", "i", "n", "v", "s",
  // Type names, which take a length/precision in parentheses.
  "numeric", "decimal", "char", "varchar", "character", "bit", "timestamp",
  "timestamptz", "time", "interval", "text", "integer", "bigint", "smallint",
  "boolean", "real", "float", "double", "money", "uuid", "jsonb", "json",
  // Aggregates and ordinary functions this corpus actually uses.
  "count", "sum", "min", "max", "avg", "array_agg", "string_agg", "jsonb_agg",
  "bool_and", "bool_or", "every", "coalesce", "nullif", "greatest", "least",
  "md5", "encode", "decode", "lower", "upper", "btrim", "trim", "ltrim",
  "rtrim", "length", "substring", "substr", "replace", "split_part", "chr",
  "ascii", "concat", "concat_ws", "format", "quote_ident", "quote_literal",
  "quote_nullable", "repeat", "reverse", "strpos", "translate", "initcap",
  "round", "floor", "ceil", "ceiling", "abs", "trunc", "mod", "power", "sqrt",
  "sign", "div", "width_bucket", "random", "now", "clock_timestamp",
  "statement_timestamp", "transaction_timestamp", "localtimestamp", "age",
  "date_trunc", "date_part", "extract", "to_char", "to_date", "to_number",
  "to_timestamp", "make_date", "make_timestamp", "make_interval", "justify_days",
  "unnest", "generate_series", "generate_subscripts", "cardinality",
  "array_length", "array_to_string", "string_to_array", "array_position",
  "array_remove", "array_replace", "array_append", "array_prepend", "array_cat",
  "array_fill", "array_dims", "array_lower", "array_upper", "array_ndims",
  "jsonb_build_object", "jsonb_build_array", "jsonb_array_elements",
  "jsonb_array_elements_text", "jsonb_object_keys", "jsonb_typeof",
  "jsonb_extract_path", "jsonb_extract_path_text", "jsonb_set", "jsonb_insert",
  "jsonb_strip_nulls", "jsonb_pretty", "jsonb_each", "jsonb_each_text",
  "jsonb_array_length", "jsonb_populate_record", "to_jsonb", "to_json",
  "json_build_object", "json_build_array", "json_array_elements",
  "row_to_json", "row_number", "rank", "dense_rank", "lag", "lead",
  "first_value", "last_value", "nth_value", "ntile",
  "current_setting", "set_config", "current_user", "session_user",
  "current_database", "current_schema", "version", "txid_current",
  "pg_backend_pid", "pg_sleep", "pg_typeof", "pg_get_expr", "pg_get_functiondef",
  "pg_get_function_identity_arguments", "pg_get_function_result",
  "pg_get_function_arguments", "pg_get_triggerdef", "pg_get_constraintdef",
  "pg_get_indexdef", "pg_get_viewdef", "pg_get_userbyid", "pg_get_serial_sequence",
  "pg_total_relation_size", "pg_relation_size", "pg_size_pretty",
  "pg_notify", "pg_advisory_lock", "pg_advisory_xact_lock", "pg_try_advisory_lock",
  "to_regclass", "to_regproc", "to_regprocedure", "to_regtype", "to_regnamespace",
  "has_table_privilege", "has_column_privilege", "has_function_privilege",
  "has_schema_privilege", "has_sequence_privilege", "has_database_privilege",
  "pg_has_role", "acldefault", "makeaclitem", "pg_catalog",
  "aclexplode", "obj_description", "col_description", "shobj_description",
  "gen_random_uuid", "uuid_generate_v4", "nextval", "currval", "setval",
  // ROUND 30. Reading INSERT/UPDATE/DELETE operands reaches expressions that
  // were never scanned before, and these are the builtins the existing 884
  // migrations actually call from one. Measured, not guessed: without them the
  // widening charged five migrations for routines PostgreSQL and PostGIS ship.
  // Still an explicit list and not an `st_`/`pg_` prefix rule, for the reason
  // given above — a prefix is an escape hatch anyone can name themselves into.
  "gen_random_bytes", "hashtext", "digest", "convert_to", "convert_from",
  "st_area", "st_collect", "st_collectionextract", "st_force2d",
  "st_geomfromgeojson", "st_isempty", "st_makevalid", "st_multi",
  "st_setsrid", "st_unaryunion",
  "lpad", "rpad", "regexp_replace", "regexp_match", "regexp_matches",
  "regexp_split_to_array", "regexp_split_to_table", "starts_with",
  "auth", "uid", "jwt", "role",
  // ROUND 31. Reading statements introduced by a control structure reaches four
  // migrations that guard a repair behind the plpgsql_check static analyzer —
  // `IF EXISTS (...) THEN SELECT count(*) ... FROM plpgsql_check_function(...)`.
  // The call is real and was genuinely missed before; the routine is shipped by
  // the plpgsql_check extension and only reports on a function's source, so it
  // is named here rather than charged as a resident routine of unknown effect.
  "plpgsql_check_function",
]);
// These are grammar or type-constructor spellings, not schema-resolved routine
// calls. They remain safe unqualified. Ordinary functions in the larger list
// above are trusted only as explicit pg_catalog identities: an unqualified
// `round(...)` can resolve a public.round overload through search_path.
const NON_ROUTINE_PAREN_SYNTAX = new Set([
  "in", "exists", "and", "or", "not", "any", "all", "some", "from", "as", "on",
  "select", "where", "using", "join", "filter", "cast", "position", "when", "check",
  "case", "values", "row", "over", "within", "order", "group", "having",
  "returning", "set", "distinct", "between", "like", "overlaps", "at", "by",
  "conflict", "nothing", "each", "lateral", "tablesample", "grouping",
  "into", "for", "of", "if", "then", "else", "end", "loop", "while", "return",
  "numeric", "decimal", "char", "varchar", "character", "bit", "timestamp",
  "timestamptz", "time", "interval", "text", "integer", "bigint", "smallint",
  "boolean", "real", "float", "double", "money", "uuid", "jsonb", "json",
  "coalesce", "nullif", "greatest", "least",
]);
const TRUSTED_AUTH_ROUTINES = new Set(["uid", "jwt", "role"]);

/**
 * Routines this code runs for effect whose bodies are not in `defined`.
 *
 * Their bodies live in the database, so no reading of this file can say what
 * they write. The caller refuses rather than assuming they write nothing.
 */
// Positions where `name (` is a relation or an alias rather than a call. A
// write's target table (`INSERT INTO public.commissions (…)`) and a set-returning
// function's column alias (`… AS ta(attnum)`) both look exactly like a call, and
// reading them as one charged two migrations for routines that do not exist.
// `FROM` is deliberately absent: `SELECT * FROM do_the_repair()` IS a call.
const NOT_A_CALL_HERE = /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?|copy|into|as|references|table)\s+(only\s+)?(if\s+(not\s+)?exists\s+)?(?:[a-z0-9_]+\.)*$/;

function unknownCallsIn(codeLower, defined, trustedUnqualifiedRoutines = new Set()) {
  const out = new Set();
  for (const raw of codeLower.split(";")) {
    const stmt = runForEffectRegion(raw.trim());
    if (!stmt) continue;
    // The name boundary is a LOOKBEHIND, not a consumed character. Round 30: it
    // used to consume the delimiter, so in `VALUES (public.wrapper())` the match
    // on `values (` ate the open paren and left `public.wrapper(` with no
    // separator in front of it to match against. The very next call — the one
    // that mattered — was invisible, and only when it sat immediately inside
    // another call's parentheses, which is exactly where an argument sits.
    const re = /(?<![a-z0-9_.])((?:[a-z0-9_]+\s*\.\s*)*)([a-z0-9_]+)\s*\(/g;
    let mm;
    while ((mm = re.exec(stmt)) !== null) {
      const nameStart = mm.index + mm[1].length;
      const before = stmt.slice(0, nameStart);
      if (NOT_A_CALL.test(before) || NOT_A_CALL_HERE.test(before)) continue;
      const schema = mm[1].replace(/\s+/g, "").replace(/\.$/, "");
      const name = mm[2];
      const identity = canonicalRoutineIdentity(schema ? `${schema}.${name}` : name);
      // Only an explicitly qualified call can be proven to select an exact
      // same-file definition. An unqualified call remains unresolved even when
      // a same-bare-name definition exists: PostgreSQL overload/search_path
      // resolution may choose a resident routine in another schema.
      if (schema && defined.has(identity)) continue;
      // A bare builtin name is not a grant of trust to public.<same_name>.
      // Only unqualified calls, explicit pg_catalog calls, and the three fixed
      // Supabase auth helpers may use the builtin exemption. A schema-qualified
      // public overload stays unknown and therefore fails closed.
      const trustedBuiltin =
        (!schema && NON_ROUTINE_PAREN_SYNTAX.has(name)) ||
        (schema === "pg_catalog" && NOT_A_ROUTINE_CALL.has(name)) ||
        (schema === "auth" && TRUSTED_AUTH_ROUTINES.has(name));
      // A caller may add an exact unqualified routine identity only after it
      // has independently proved pg_catalog resolves before user schemas. The
      // event-trigger capture uses this for PostgreSQL's read-only DDL metadata
      // helpers and binds the routine search_path into the manifest hash.
      if (trustedBuiltin || (!schema && trustedUnqualifiedRoutines.has(name))) continue;
      out.add(identity);
    }
  }
  return out;
}

/**
 * The (table, column) pairs a migration writes when it is applied.
 *
 * See `targetsFromCode` for the shape. On top of the statements that run
 * directly, this folds in the body of every routine the migration defines AND
 * invokes, following helper-calls-helper chains to a fixpoint.
 *
 * `unknownCalls` names routines the migration executes for effect but does not
 * define; their bodies live in the database, not in this file.
 */
export function applyTimeWriteTargets(
  sql,
  {
    knownOperators = [],
    knownCasts = [],
    knownViews = [],
    knownRules = [],
    trustedUnqualifiedRoutines = [],
  } = {},
) {
  const { code, literals, routines, unsupportedDoBody } = applyTimeCode(sql || "");
  const top = targetsFromCode(code, literals);
  if (unsupportedDoBody) top.unresolved = true;
  const routineCatalogChanges = new Map();
  let routineCatalogUnparsed = false;
  const recordRoutineCatalog = (sourceCode) => {
    const catalog = routineIdentityChanges(sourceCode);
    if (catalog.unparsed) {
      routineCatalogUnparsed = true;
      top.unresolved = true;
    }
    for (const change of catalog.changes) {
      routineCatalogChanges.set(`${change.schema}\0${change.name}`, change);
    }
  };
  recordRoutineCatalog(code);

  // ROUND 25. A name maps to a LIST of bodies, not one. PostgreSQL allows any
  // number of routines to share a name and differ only by argument types, and a
  // migration may also drop and redefine one. Keeping the first definition and
  // discarding the rest let a harmless `helper()` shadow a mutating
  // `helper(integer)`: `SELECT helper(1)` resolved to the empty body and the
  // migration read as writing nothing.
  //
  // Picking the right overload means type-resolving the arguments, which is
  // more than this module can do honestly. It unions them instead — every body
  // that could be the one being called is counted, which can only over-report.
  const byName = new Map();
  const defineRoutines = (list) => {
    for (const r of list) {
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name).push(r);
    }
  };
  defineRoutines(routines);

  const operators = [];
  const operatorKeys = new Set();
  const defineOperators = (list) => {
    for (const definition of list) {
      const operator = String(definition?.operator || "");
      const fn = canonicalRoutineIdentity(definition?.fn);
      if (!operator) continue;
      const key = `${operator}\0${fn}`;
      if (operatorKeys.has(key)) continue;
      operatorKeys.add(key);
      operators.push({ operator, fn });
    }
  };
  defineOperators(knownOperators);
  defineOperators(operatorDefinitions(code));

  const casts = [];
  const castKeys = new Set();
  const defineCasts = (list) => {
    for (const definition of list) {
      const source = normalizeCastType(definition?.source);
      const target = normalizeCastType(definition?.target);
      const fn = canonicalRoutineIdentity(definition?.fn);
      const context = String(definition?.context || "explicit");
      const key = `${source}\0${target}\0${fn}\0${context}`;
      if (castKeys.has(key)) continue;
      castKeys.add(key);
      casts.push({ source, target, fn, context });
    }
  };
  defineCasts(knownCasts);
  defineCasts(castDefinitions(code));

  const views = [];
  const viewKeys = new Set();
  const defineViews = (list) => {
    for (const definition of list) {
      const name = String(definition?.name || "");
      const query = String(definition?.query || "").toLowerCase();
      if (!name) continue;
      const key = `${name}\0${query}`;
      if (viewKeys.has(key)) continue;
      viewKeys.add(key);
      views.push({ name, query });
    }
  };
  defineViews(knownViews);
  defineViews(viewDefinitions(code));

  // ROUND 28. Triggers this migration attaches, and the ones a write has
  // already fired. A trigger whose relation is written runs its function, so
  // the function joins the frontier exactly as an explicit call would; if its
  // body is not in this file it joins the unknown calls instead, because
  // nothing here can say what a database-resident body writes.
  const attachments = triggerAttachments(code);
  const rules = [];
  const ruleKeys = new Set();
  const defineRules = (list) => {
    for (const definition of list) {
      const rawTable = String(definition?.table || "").toLowerCase();
      const tableParts = rawTable.split(".").filter(Boolean);
      const schema = String(definition?.schema ||
        (tableParts.length === 2 ? tableParts[0] : "public")).toLowerCase();
      const relation = String(definition?.relation || tableParts.at(-1) || "").toLowerCase();
      const table = schema === "public" ? relation : `${schema}.${relation}`;
      const event = String(definition?.event || "").toLowerCase();
      const name = String(definition?.name || "").toLowerCase();
      if (!/^[a-z_][a-z0-9_$]*$/.test(schema) ||
          !/^[a-z_][a-z0-9_$]*$/.test(relation) ||
          !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ||
          !new Set(["select", "insert", "update", "delete"]).has(event)) {
        top.unresolved = true;
        continue;
      }
      const rule = { name, schema, relation, table, event };
      const key = ruleAttachmentIdentity(rule);
      if (ruleKeys.has(key)) continue;
      ruleKeys.add(key);
      rules.push(rule);
    }
  };
  defineRules(knownRules);
  defineRules(ruleAttachments(code));
  const readRuleRelations = invokedRelations(code);

  // ROUND 29. A string literal handed to EXECUTE is SQL, and the only thing this
  // module did with one was scan it for a bare DML verb. So
  //
  //     EXECUTE 'SELECT public.tmp_fix()'
  //
  // reported no targets, no unknown calls and unresolved=false — a call is not a
  // DML verb — while PostgreSQL ran a function that rewrites money rows. The same
  // silence covered `EXECUTE 'ALTER TABLE public.orders ALTER COLUMN total TYPE
  // numeric USING ...'`, which rewrites every row of the table.
  //
  // Mapping an EXECUTE back to its own operand is not reliable here: a deferred
  // routine body emits `''` into `code` without pushing a literal, and a nested
  // `$$` body contributes literals whose positions are relative to its own code.
  // So position is not used. Instead, once a body is known to run dynamic SQL at
  // all, EVERY apply-time literal in it that reads as a statement is parsed as
  // SQL and folded in — its writes, its routine definitions, its trigger
  // attachments and the calls it makes. A body with no runnable EXECUTE is
  // untouched, which is what keeps this affordable: a literal there is a comment
  // or a default, not a statement.
  const execCodes = [];
  const analysed = new Set();
  const foldLiterals = (result, lits) => {
    if (!result.dynamicExec) return;
    for (const lit of lits) {
      if (analysed.has(lit)) continue;
      if (analysed.size >= 500) {
        // The cap is a denial boundary, never a silent truncation boundary.
        // Otherwise an attacker can pad 500 harmless literals ahead of the
        // executable one that calls a resident money mutator.
        top.unresolved = true;
        break;
      }
      analysed.add(lit);
      if (!readsAsStatement(lit)) continue;
      const parsed = applyTimeCode(lit);
      const inner = targetsFromCode(parsed.code, parsed.literals);
      for (const t of inner.targets) top.targets.add(t);
      for (const t of inner.tables) top.tables.add(t);
      top.dynamicWrites.push(...inner.dynamicWrites);
      if (inner.unresolved) top.unresolved = true;
      if (inner.eventTriggerChange) top.eventTriggerChange = true;
      if (inner.domainConstraintValidation) top.domainConstraintValidation = true;
      if (inner.sequenceMutation) top.sequenceMutation = true;
      if (inner.searchPathChange) top.searchPathChange = true;
      if (inner.unsupportedRoutineIdentity) top.unsupportedRoutineIdentity = true;
      if (parsed.unsupportedDoBody) top.unresolved = true;
      recordRoutineCatalog(parsed.code);
      defineRoutines(parsed.routines);
      defineOperators(operatorDefinitions(parsed.code));
      defineCasts(castDefinitions(parsed.code));
      defineViews(viewDefinitions(parsed.code));
      attachments.push(...triggerAttachments(parsed.code));
      defineRules(ruleAttachments(parsed.code));
      for (const relation of invokedRelations(parsed.code)) readRuleRelations.add(relation);
      execCodes.push(parsed.code);
      foldLiterals(inner, parsed.literals);
    }
  };
  foldLiterals(top, literals);
  const fired = new Set();
  const firedRules = new Map();
  const firedRuleKeys = new Set();
  const unknownTriggerFns = new Set();
  const unknownOperatorFns = new Set();
  const unknownCastFns = new Set();
  const firedOperators = new Set();
  const firedCasts = new Set();
  const firedViews = new Set();
  const foldedViewQueries = new Set();
  const addOperatorInvocations = (sourceCode, into) => {
    for (const definition of invokedOperators(sourceCode, operators)) {
      const key = `${definition.operator}\0${definition.fn}`;
      firedOperators.add(key);
      if (!definition.fn) {
        top.unresolved = true;
      } else if (byName.has(definition.fn)) {
        if (!seen.has(definition.fn)) into.add(definition.fn);
      } else {
        unknownOperatorFns.add(definition.fn);
      }
    }
  };
  const addCastInvocations = (sourceCode, into) => {
    for (const definition of invokedCasts(sourceCode, casts)) {
      const key = `${definition.source}\0${definition.target}\0${definition.fn}\0${definition.context}`;
      firedCasts.add(key);
      if (!definition.fn) {
        top.unresolved = true;
      } else if (byName.has(definition.fn)) {
        if (!seen.has(definition.fn)) into.add(definition.fn);
      } else {
        unknownCastFns.add(definition.fn);
      }
    }
  };
  const addViewInvocations = (sourceCode) => {
    for (const definition of invokedViews(sourceCode, views)) {
      const key = `${definition.name}\0${definition.query}`;
      firedViews.add(key);
      if (!definition.query) {
        top.unresolved = true;
      } else if (!foldedViewQueries.has(key)) {
        foldedViewQueries.add(key);
        execCodes.push(definition.query);
        for (const relation of invokedRelations(definition.query)) readRuleRelations.add(relation);
      }
    }
  };
  const fireAttached = (into) => {
    for (const rule of rules) {
      const key = ruleAttachmentIdentity(rule);
      const bareRuleTable = rule.table.split(".").pop();
      const isQualifiedRule = bareRuleTable !== rule.table;
      // An unqualified relation can resolve through search_path to a captured
      // non-public rule. Without the live applying-session path, matching the
      // bare name is the only fail-closed answer. Explicit schema matches still
      // work through the full identity.
      const readMatches = readRuleRelations.has(rule.table) ||
        (isQualifiedRule && readRuleRelations.has(bareRuleTable));
      const writeMatches = top.tables.has(rule.table) ||
        (isQualifiedRule && top.tables.has(bareRuleTable));
      const firedByEvent = rule.event === "select"
        ? readMatches
        : writeMatches;
      if (firedRuleKeys.has(key) || !firedByEvent) continue;
      // A rule action can call a database-resident mutator or issue arbitrary
      // DML. Until rule actions are parsed as fully as routine bodies, firing
      // one is not provably bounded and must refuse rather than disappear.
      firedRuleKeys.add(key);
      firedRules.set(key, {
        name: rule.name,
        schema: rule.schema,
        relation: rule.relation,
        event: rule.event,
      });
      top.unresolved = true;
    }
    for (const att of attachments) {
      const key = `${att.table}.${att.fn}`;
      if (fired.has(key) || !top.tables.has(att.table)) continue;
      fired.add(key);
      if (byName.has(att.fn)) { if (!seen.has(att.fn)) into.add(att.fn); }
      else unknownTriggerFns.add(att.fn);
    }
  };

  // Literal SQL runs whatever it names, so the routines it calls join the
  // frontier exactly as a call written in plain text does. Drained rather than
  // scanned once, because a body folded in later can itself EXECUTE a literal.
  let execScanned = 0;
  const drainExec = (into) => {
    while (execScanned < execCodes.length) {
      const c = execCodes[execScanned++];
      for (const relation of invokedRelations(c)) readRuleRelations.add(relation);
      for (const n of invokedRoutines(c.toLowerCase(), new Set(byName.keys()))) {
        if (!seen.has(n)) into.add(n);
      }
      addOperatorInvocations(c, into);
      addCastInvocations(c, into);
      addViewInvocations(c);
    }
  };

  // Fold in every invoked body, then anything those bodies invoke, until the
  // set stops growing. `seen` also stops a recursive routine from looping.
  const seen = new Set();
  let frontier = invokedRoutines(code.toLowerCase(), new Set(byName.keys()));
  addOperatorInvocations(code, frontier);
  addCastInvocations(code, frontier);
  addViewInvocations(code);
  drainExec(frontier);
  fireAttached(frontier);
  while (frontier.size) {
    const next = new Set();
    for (const name of frontier) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const r of byName.get(name) || []) {
        for (const relation of invokedRelations(r.code)) readRuleRelations.add(relation);
        const inner = targetsFromCode(r.code, r.literals);
        for (const t of inner.targets) top.targets.add(t);
        for (const t of inner.tables) top.tables.add(t);
        top.dynamicWrites.push(...inner.dynamicWrites);
        if (inner.unresolved) top.unresolved = true;
        if (inner.eventTriggerChange) top.eventTriggerChange = true;
        if (inner.domainConstraintValidation) top.domainConstraintValidation = true;
        if (inner.sequenceMutation) top.sequenceMutation = true;
        if (inner.searchPathChange) top.searchPathChange = true;
        if (inner.unsupportedRoutineIdentity) top.unsupportedRoutineIdentity = true;
        // PostgreSQL evaluates omitted-argument defaults when this routine is
        // invoked. Argument binding is deliberately not reimplemented here;
        // if a default can call code, the invocation is unresolved rather than
        // silently treating the deferred header expression as inert.
        if (r.unresolved || r.callableDefault) top.unresolved = true;
        // Creating/replacing/altering/dropping a routine from an invoked body
        // mutates the catalog at apply time. Preserve the identity so callers
        // can compare it with captured enabled event-trigger routines.
        recordRoutineCatalog(r.code);
        // Defaults live in the routine header, not its body, but omitted
        // arguments evaluate them at invocation time. Feed that executable
        // expression through the same routine/operator/cast/view dispatch
        // graph as the body. In particular, `1::custom_type` can invoke a
        // user-defined cast function without looking like `name(...)`.
        for (const n of invokedRoutines(r.defaultCode || "", new Set(byName.keys()))) {
          if (!seen.has(n)) next.add(n);
        }
        addOperatorInvocations(r.defaultCode || "", next);
        addCastInvocations(r.defaultCode || "", next);
        addViewInvocations(r.defaultCode || "");
        foldLiterals(inner, r.literals);
        defineOperators(operatorDefinitions(r.code));
        defineCasts(castDefinitions(r.code));
        defineViews(viewDefinitions(r.code));
        // DDL inside an invoked routine executes now just like literal dynamic
        // SQL. Preserve its trigger/rule graph edges before firing attachments.
        attachments.push(...triggerAttachments(r.code));
        defineRules(ruleAttachments(r.code));
        for (const n of invokedRoutines(r.code.toLowerCase(), new Set(byName.keys()))) {
          if (!seen.has(n)) next.add(n);
        }
        addOperatorInvocations(r.code, next);
        addCastInvocations(r.code, next);
        addViewInvocations(r.code);
      }
    }
    drainExec(next);
    // A body just folded in may write the relation of another attachment, and
    // that trigger fires too. Re-checked every round; `fired` ends the chain.
    fireAttached(next);
    frontier = next;
  }

  // Routines run for effect whose bodies are not in this file. Scanned across
  // the top-level code, every literal executed as SQL, and every body folded in
  // above, because a defined helper may itself call something that only exists
  // in the database.
  const bodies = [...seen].flatMap((n) => (byName.get(n) || []).flatMap((r) => [r.code, r.defaultCode || ""]));
  const scan = [code, ...execCodes, ...bodies].join("\n;\n").toLowerCase();
  const unknownCalls = [...new Set([
    ...unknownCallsIn(
      scan,
      new Set(byName.keys()),
      new Set(trustedUnqualifiedRoutines.map((name) => String(name).toLowerCase())),
    ),
    ...unknownTriggerFns,
    ...unknownOperatorFns,
    ...unknownCastFns,
  ])];

  // `dynamicExec` is internal bookkeeping for the literal fold above and is not
  // part of this function's contract, so the fields are named rather than spread.
  return {
    targets: top.targets,
    tables: top.tables,
    dynamicWrites: top.dynamicWrites,
    unresolved: top.unresolved,
    eventTriggerChange: top.eventTriggerChange,
    domainConstraintValidation: top.domainConstraintValidation,
    sequenceMutation: top.sequenceMutation,
    searchPathChange: top.searchPathChange,
    unsupportedRoutineIdentity: top.unsupportedRoutineIdentity,
    routineCatalog: {
      changes: [...routineCatalogChanges.values()],
      unparsed: routineCatalogUnparsed,
    },
    unknownCalls,
    definedRoutines: [...byName.keys()],
    invokedRoutines: [...seen],
    firedTriggers: [...fired],
    firedRules: [...firedRules.values()],
    invokedOperators: [...firedOperators],
    invokedCasts: [...firedCasts],
    invokedViews: [...firedViews],
  };
}

/**
 * Does `submitted` write any TABLE `registered` wrote? Deliberately table-level:
 * the column is recorded and reported, but never narrows the match.
 *
 * This compared columns until round 27, which is unsound wherever a trigger
 * recomputes one column from its siblings — and that is the exact shape of the
 * repair this guard exists to contain. `backfill_stale_line_profit` writes
 * `order_items.total_price`, but the canonical profit trigger is scoped
 * `BEFORE INSERT OR UPDATE OF total_price, profit, cost_per_unit,
 * total_units_needed`, so `SET profit = profit` re-runs the identical money
 * correction while sharing no column with the registered target. Codex proved it
 * with a read-only probe: overlaps `[]`, unresolved `false`, straight through.
 *
 * A column list cannot express that closure — it would have to track every
 * trigger on every registered table and stay correct as triggers change, and a
 * silently stale list here is a replayed money repair. The table is the honest
 * unit: writing any part of a row whose derived money a trigger owns is a
 * replay candidate, and the operator clears it with the one-shot override.
 *
 * @param {Iterable<string>} submitted `table.column` targets of the candidate
 * @param {Iterable<string>} registered `table.column` targets of the one-shot
 * @returns {string[]} the submitted targets whose table a registered write named
 */
export function overlappingTables(submitted, registered) {
  const regTables = new Set([...registered].map((t) => t.split(".")[0]));
  return [...submitted].filter((t) => regTables.has(t.split(".")[0]));
}
