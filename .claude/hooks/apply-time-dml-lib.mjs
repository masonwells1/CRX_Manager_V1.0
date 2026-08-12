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
 * Returns `{ code, literals }` where `literals` holds the text of every string
 * literal that appeared in apply-time position — that is where dynamic SQL
 * hides, and it is scanned separately.
 */
export function applyTimeCode(sql, depth = 0) {
  let code = "";
  const literals = [];
  // Guard against a pathological nest; 8 is far past anything real.
  if (typeof sql !== "string" || depth > 8) return { code, literals };
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
        if (deferred) {
          // Keep a placeholder so the statement still parses, but contribute
          // no writes and no literals from inside the body.
          code += " '' ";
        } else {
          const inner = applyTimeCode(body, depth + 1);
          code += ` ${inner.code} `;
          literals.push(...inner.literals);
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

  return { code, literals };
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

const WRITE_VERB = /\b(update|insert\s+into|delete\s+from|merge\s+into)\s/gi;

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
export function applyTimeWriteTargets(sql) {
  const { code, literals } = applyTimeCode(sql || "");
  const s = code.toLowerCase();
  const targets = new Set();
  const tables = new Set();
  // An `ON CONFLICT DO UPDATE` whose INSERT relation could not be recovered.
  // Nothing legal produces it, so if it ever happens the caller must treat the
  // migration as unresolvable rather than as writing nothing.
  let unparsedUpsert = false;

  WRITE_VERB.lastIndex = 0;
  let m;
  // `INSERT INTO t ... ON CONFLICT DO UPDATE SET c = ...` writes `t.c`, but the
  // word after that `UPDATE` is `SET`, not a relation. The upsert's target is
  // the INSERT's, so the most recent one is carried forward.
  let lastInsertTable = "";
  while ((m = WRITE_VERB.exec(s)) !== null) {
    const verb = m[1].replace(/\s+/g, " ");

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
    if (!rel) continue;
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

  const dynamicWrites = [];
  let unresolved = false;
  for (const lit of literals) {
    const dm = /\b(update|insert\s+into|delete\s+from|merge\s+into)\s+/i.exec(lit);
    if (!dm) continue;
    dynamicWrites.push(lit);
    const rest = lit.slice(dm.index + dm[0].length).replace(/^only\s+/i, "");
    if (FORMAT_PLACEHOLDER.test(rest.trim())) unresolved = true;
  }

  return { targets, tables, dynamicWrites, unresolved: unresolved || unparsedUpsert };
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
