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
  // Guard against a pathological nest; 8 is far past anything real.
  if (typeof sql !== "string" || depth > 8) return { code, literals, routines };
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
      const m = /^\$([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const bodyEnd = close === -1 ? n : close;
        const body = sql.slice(i + tag.length, bodyEnd);
        // Which statement is this body attached to? `DO` runs now; a routine
        // body does not. Anything else unrecognized is treated as running now,
        // which is the over-reporting direction.
        const stmt = code.slice(stmtStart).trim().toLowerCase();
        const deferred = /\b(function|procedure)\b/.test(stmt);
        const inner = applyTimeCode(body, depth + 1);
        if (deferred) {
          // Keep a placeholder so the statement still parses, and contribute no
          // writes from inside the body — UNTIL something calls it. The body is
          // parsed now and filed under the routine's name so the caller can fold
          // it back in if this migration invokes it (round 24).
          code += " '' ";
          const named = /\b(?:function|procedure)\s+([A-Za-z0-9_.]+)/.exec(stmt);
          const bare = named ? named[1].split(".").pop() : "";
          if (bare) routines.push({ name: bare, code: inner.code, literals: inner.literals });
          // A routine defined inside this body is still defined by this file.
          routines.push(...inner.routines);
        } else {
          code += ` ${inner.code} `;
          literals.push(...inner.literals);
          routines.push(...inner.routines);
        }
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }

    // 'string literal' — kept aside; `''` escapes an embedded quote.
    if (ch === "'") {
      let lit = "";
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { lit += "'"; i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        lit += sql[i];
        i += 1;
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
      code += id;
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

  return { code, literals, routines };
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

// `public.order_items` and `order_items` are the same relation here. The schema
// is dropped so a waiver written one way cannot be dodged by writing the other.
function readRelation(s, pos) {
  let i = skipSpace(s, pos);
  const only = /^only\b/.exec(s.slice(i));
  if (only) i = skipSpace(s, i + only[0].length);
  const first = readIdent(s, i);
  if (!first) return null;
  i = first.end;
  let name = first.value;
  const after = skipSpace(s, i);
  if (s[after] === ".") {
    const second = readIdent(s, skipSpace(s, after + 1));
    if (second) { name = second.value; i = second.end; }
  }
  return { table: name, end: i };
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
        if (id) cols.push(id.value);
      }
      continue;
    }
    const id = readIdent(piece, 0);
    if (id) cols.push(id.value);
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
  let unresolved = false;

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
        if (!rel || NON_RELATION_KEYWORDS.has(rel.table)) continue;
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
    if (NON_RELATION_KEYWORDS.has(rel.table)) continue;
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
          .map((id) => id.value);
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
    if (!rel || NON_RELATION_KEYWORDS.has(rel.table)) continue;
    const stmtEnd = s.indexOf(";", am.index);
    const body = s.slice(rel.end, stmtEnd === -1 ? s.length : stmtEnd);
    if (/\balter\s+(?:column\s+)?[a-z0-9_"]+\s+(?:set\s+data\s+)?type\b/.test(body)) {
      tables.add(rel.table);
      targets.add(`${rel.table}.*`);
    }
  }

  const dynamicWrites = [];

  // ROUND 25. Scanning string literals one at a time cannot see a statement that
  // was assembled from several of them. `EXECUTE 'UPDATE ' || 'public.order_items
  // SET total_price = 0'` puts the verb in one fragment and the relation in the
  // next, so each fragment read alone is harmless: the first has no table, the
  // second has no verb, and the write is reported as nothing at all.
  //
  // The fragments cannot be usefully reassembled — `EXECUTE v_sql` builds the
  // text somewhere else entirely. So the operand is judged instead of the
  // pieces: a single complete literal (optionally wrapped in `format(...)`, whose
  // placeholders are already handled below) is readable, and anything else —
  // concatenation, a variable, a function result — is unresolvable and refuses.
  const EXEC_OPERAND_READABLE = /^''\s*$|^format\s*\(\s*''\s*[,)]/;
  const EXEC_STMT = /\bexecute\s+/g;
  let xm;
  while ((xm = EXEC_STMT.exec(s)) !== null) {
    // `CREATE TRIGGER ... EXECUTE FUNCTION f()` and `GRANT/REVOKE EXECUTE ON
    // FUNCTION f` spell EXECUTE without running any dynamic SQL.
    const rest = s.slice(xm.index + xm[0].length);
    if (/^(function|procedure)\b/.test(rest)) continue;
    if (inGrantOrRevoke(s, xm.index)) continue;
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

  return { targets, tables, dynamicWrites, unresolved: unresolved || unparsedUpsert };
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
const NOT_A_CALL = /\b(function|procedure)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:[a-z0-9_]+\.)?$/;

function invokedRoutines(codeLower, defined) {
  const found = new Set();
  for (const name of defined) {
    const re = new RegExp(`(^|[^A-Za-z0-9_.])((?:[a-z0-9_]+\\.)?)${name}\\s*\\(`, "g");
    let mm;
    while ((mm = re.exec(codeLower)) !== null) {
      const nameStart = mm.index + mm[1].length + mm[2].length;
      if (NOT_A_CALL.test(codeLower.slice(0, nameStart))) continue;
      found.add(name);
      break;
    }
  }
  return found;
}

// A statement that exists to run something, as opposed to defining it. Round 25
// found that restricting the unknown-call scan to CALL and PERFORM missed the
// most ordinary spelling of all: `SELECT public.existing_repair();` runs the
// routine exactly as CALL does, and was reported as calling nothing.
const RUNS_FOR_EFFECT = /^(select|call|perform|with)\b/;

// Splitting a routine body on `;` leaves the first statement fused to the block
// keywords in front of it — `BEGIN PERFORM repair()` arrives as one fragment
// whose first word is BEGIN, which is how the round-25 test case of a helper
// calling a database-resident routine slipped past a leading-keyword test.
// These carry no meaning of their own, so they are peeled off before the test.
const BLOCK_LEAD = /^(begin|declare|end(\s+(if|loop))?|then|else|loop|do|exception|when\s+others|<<[a-z0-9_]+>>|\$\$|as)\b\s*/;

function runForEffectRegion(stmt) {
  // PERFORM and CALL exist only as statement verbs, so wherever they appear in
  // a fragment, what follows them runs. Scan from there.
  const verb = /\b(perform|call)\s+/.exec(stmt);
  if (verb) return stmt.slice(verb.index);
  let rest = stmt;
  let prev;
  do { prev = rest; rest = rest.replace(BLOCK_LEAD, ""); } while (rest !== prev);
  return RUNS_FOR_EFFECT.test(rest) ? rest : "";
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
  "select", "where", "using", "join", "filter", "cast", "position", "when",
  "case", "values", "row", "over", "within", "order", "group", "having",
  "returning", "set", "distinct", "between", "like", "overlaps", "at", "by",
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
  "lpad", "rpad", "regexp_replace", "regexp_match", "regexp_matches",
  "regexp_split_to_array", "regexp_split_to_table", "starts_with",
  "is_admin", "auth", "uid", "jwt", "role",
]);

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
const NOT_A_CALL_HERE = /\b(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?|copy|into|as|references|table)\s+(only\s+)?(if\s+(not\s+)?exists\s+)?(?:[a-z0-9_]+\.)?$/;

function unknownCallsIn(codeLower, defined) {
  const out = new Set();
  for (const raw of codeLower.split(";")) {
    const stmt = runForEffectRegion(raw.trim());
    if (!stmt) continue;
    const re = /(^|[^a-z0-9_.])((?:[a-z0-9_]+\.)?)([a-z0-9_]+)\s*\(/g;
    let mm;
    while ((mm = re.exec(stmt)) !== null) {
      const nameStart = mm.index + mm[1].length + mm[2].length;
      const before = stmt.slice(0, nameStart);
      if (NOT_A_CALL.test(before) || NOT_A_CALL_HERE.test(before)) continue;
      const name = mm[3];
      if (defined.has(name) || NOT_A_ROUTINE_CALL.has(name)) continue;
      out.add(name);
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
export function applyTimeWriteTargets(sql) {
  const { code, literals, routines } = applyTimeCode(sql || "");
  const top = targetsFromCode(code, literals);

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
  for (const r of routines) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }

  // Fold in every invoked body, then anything those bodies invoke, until the
  // set stops growing. `seen` also stops a recursive routine from looping.
  const seen = new Set();
  let frontier = invokedRoutines(code.toLowerCase(), byName.keys());
  while (frontier.size) {
    const next = new Set();
    for (const name of frontier) {
      if (seen.has(name)) continue;
      seen.add(name);
      for (const r of byName.get(name) || []) {
        const inner = targetsFromCode(r.code, r.literals);
        for (const t of inner.targets) top.targets.add(t);
        for (const t of inner.tables) top.tables.add(t);
        top.dynamicWrites.push(...inner.dynamicWrites);
        if (inner.unresolved) top.unresolved = true;
        for (const n of invokedRoutines(r.code.toLowerCase(), byName.keys())) {
          if (!seen.has(n)) next.add(n);
        }
      }
    }
    frontier = next;
  }

  // Routines run for effect whose bodies are not in this file. Scanned across
  // the top-level code and every body folded in above, because a defined helper
  // may itself call something that only exists in the database.
  const bodies = [...seen].flatMap((n) => (byName.get(n) || []).map((r) => r.code));
  const scan = [code, ...bodies].join("\n;\n").toLowerCase();
  const unknownCalls = [...unknownCallsIn(scan, new Set(byName.keys()))];

  return { ...top, unknownCalls, definedRoutines: [...byName.keys()], invokedRoutines: [...seen] };
}

/**
 * Does `submitted` write anything `registered` wrote? `table.*` on either side
 * covers every column of that table.
 */
export function overlappingTargets(submitted, registered) {
  const hits = [];
  const regList = [...registered];
  for (const t of submitted) {
    const [sTable, sCol] = t.split(".");
    for (const r of regList) {
      const [rTable, rCol] = r.split(".");
      if (sTable !== rTable) continue;
      if (sCol === "*" || rCol === "*" || sCol === rCol) { hits.push(t); break; }
    }
  }
  return hits;
}
