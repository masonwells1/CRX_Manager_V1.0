// Pure classifier for live-testdata-guard.mjs. Decides whether an execute_sql
// query is a real-business-data write that should be blocked (unless it's clearly
// fake [E2E] data or Mason has authorized real data this session).
//
// Also closes the execute_sql side door around the migration gauntlet: raw DDL,
// GRANT/REVOKE, TRUNCATE, financial-amount UPDATEs, and any hand-written touch of
// financial_audit_log are blocked here so live schema/money changes can only travel
// the reviewed apply_migration path. Rolled-back smoke batches (BEGIN;...;ROLLBACK;
// with no COMMIT) stay allowed — that is the documented safe test pattern.

const BUSINESS_TABLES = [
  "customers", "products", "orders", "order_items", "invoices", "invoice_items",
  "quotes", "quote_items", "deliveries", "delivery_items", "blend_tickets",
  "jobs", "job_fields", "returns", "return_items", "payments", "commissions",
  "commission_payments",
  // Codex P1 2026-07-13: the AP/prepay/credit/inventory side was missing, so a
  // raw UPDATE against these live tables slipped past the catch-all entirely.
  // Every name verified against .claude/schema-registry.json columns.
  "vendor_bills", "vendor_payments", "purchase_orders", "prepay_credits",
  "prepay_applications", "credit_memo_applications", "inventory_transactions",
  "inventory", "inventory_holds",
  "fields", "job_applied_records", "allocation_sets", "write_offs",
];
const FINANCIAL_TABLES = [
  "invoices", "orders", "payments", "commissions", "commission_payments", "financial_audit_log",
  "vendor_bills", "vendor_payments", "prepay_credits", "prepay_applications",
  "credit_memo_applications", "allocation_sets", "write_offs",
  "inventory", "inventory_holds", "inventory_transactions",
];

function tableAlt(tables) {
  return tables.map((t) => t.replace(/[^a-z_]/g, "")).join("|");
}
// Qualification prefix: bare, `public.`, `"public".`, or quoted table — all
// valid SQL forms. Codex P1 2026-07-13 round 3: `UPDATE "public"."customers"`
// evaded the earlier `(?:public\.)?` prefix entirely.
const QUAL = `(?:"?public"?\\s*\\.\\s*)?"?`;
const INSERT_RE = new RegExp(`\\binsert\\s+into\\s+${QUAL}(${tableAlt(BUSINESS_TABLES)})"?\\b`, "i");
const DELETE_RE = new RegExp(`\\bdelete\\s+from\\s+${QUAL}(${tableAlt(FINANCIAL_TABLES)})"?\\b`, "i");
const CANCEL_VOID_RE = new RegExp(`\\bupdate\\s+${QUAL}(${tableAlt(FINANCIAL_TABLES)})"?\\b[\\s\\S]*?\\bset\\b[\\s\\S]*?status\\s*=\\s*'(cancelled|voided)'`, "i");

// Any hand-written touch of the append-only audit log — [E2E] does NOT exempt this.
const AUDIT_LOG_WRITE_RE = new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from)\\s+${QUAL}financial_audit_log\\b`, "i");

// Statement-anchored DDL (start of batch or after a `;`). `create temp`/`temporary`
// tables are legitimate scratch space for analysis and stay allowed.
const DDL_STMT_RE = /(?:^|;)\s*(?:create(?!\s+(?:temp|temporary)\b)(?:\s+or\s+replace)?|alter|drop)\s+\S+/im;
const GRANT_REVOKE_RE = /(?:^|;)\s*(?:grant|revoke)\b/im;
const TRUNCATE_RE = /(?:^|;)\s*truncate\b/im;

// Money-ish column assignment (column name on the LEFT of `=`) on a financial table.
const FIN_UPDATE_RE = new RegExp(`\\bupdate\\s+${QUAL}(${tableAlt(FINANCIAL_TABLES)})"?\\b`, "i");
const MONEY_COL_RE = /\b[a-z_]*(?:cents|amount|total|balance|price|rate|paid)[a-z_]*\s*=/i;

// FIX 5 (2026-07-13 audit — "live-testdata UPDATE gap"): ANY UPDATE against a
// live business table, without [E2E]/REAL-DATA-OK, is a real-data write just
// like an un-marked INSERT — even when it doesn't touch a money column or set
// a cancel/void status. (Before this, "UPDATE customers SET phone = ...
// WHERE id = 5" with no [E2E] marker sailed straight through.) This is a
// catch-all checked AFTER the more specific INSERT/DELETE/cancel-void/
// money-column rules above, so their more specific "kind"/message still wins
// when they match; this only fires for everything else.
const UPDATE_ANY_RE = new RegExp(`\\bupdate\\s+${QUAL}(${tableAlt(BUSINESS_TABLES)})"?\\b`, "i");

// Same catch-all standard for DELETE: the financial-table DELETE rule above
// missed non-financial business tables (customers, products, quotes, ...) — a
// raw `DELETE FROM customers` sailed through (CodeRabbit critical follow-up,
// PR #352: consequential now that execute_sql auto-approves under dontAsk).
const DELETE_ANY_RE = new RegExp(`\\bdelete\\s+from\\s+${QUAL}(${tableAlt(BUSINESS_TABLES)})"?\\b`, "i");

// A DO body is hand-written SQL that EXECUTES immediately (a DO block can even
// COMMIT mid-transaction), so unlike a stored function body it must stay visible
// to the classifier. Matches "DO $tag$" and "DO LANGUAGE plpgsql $tag$".
const DO_PREFIX_RE = /\bdo(?:\s+language\s+[a-z_][a-z0-9_]*)?\s*$/i;

// Comments are legal between DO and its dollar quote (`DO /* x */ $$...$$`,
// `DO -- note\n$$...$$`) and used to hide the executable body from the DO
// check (Codex P1 2026-07-13 round 3). Strip trailing comments/whitespace from
// the already-emitted text before testing the DO prefix. Used ONLY for that
// test — never for output — so an over-strip can only make MORE text visible
// to the classifiers (the safe direction).
function stripTrailingComments(s) {
  let t = s;
  let prev;
  do {
    prev = t;
    t = t.replace(/\s+$/, "");
    t = t.replace(/\/\*(?:[^*]|\*(?!\/))*\*\/$/, "");
    t = t.replace(/--[^\r\n]*$/, "");
  } while (t !== prev);
  return t;
}

// Strip dollar-quoted string bodies ($function$...$function$, $$...$$, any
// $tag$...$tag$ pair) so classification sees only top-level hand-written SQL —
// an INSERT INTO financial_audit_log inside a CREATE OR REPLACE FUNCTION body
// being re-emitted by a BEGIN;...;ROLLBACK; smoke is machine content, not a
// hand-written audit-log write. Single-quoted literals and comments are walked
// (not stripped) so a stray $$ inside them can't open a fake quote span that
// swallows real statements. DO bodies are kept (they execute). An unterminated
// dollar-quote leaves the rest untouched (fail closed).
function stripDollarQuotedCore(sql, keepBody) {
  const src = String(sql || "");
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      out += src.slice(i, j); i = j; continue;
    }
    if (ch === "-" && src[i + 1] === "-") {
      let j = i + 2;
      while (j < n && src[j] !== "\n" && src[j] !== "\r") j++;
      out += src.slice(i, j); i = j; continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      let depth = 1, j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") { depth++; j += 2; continue; }
        if (src[j] === "*" && src[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      out += src.slice(i, j); i = j; continue;
    }
    if (ch === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 66));
      if (tag) {
        const open = tag[0];
        const close = src.indexOf(open, i + open.length);
        if (close === -1) { out += src.slice(i); break; }
        const end = close + open.length;
        out += keepBody(out) ? src.slice(i, end) : " ";
        i = end; continue;
      }
    }
    out += ch; i++;
  }
  return out;
}

export function stripDollarQuoted(sql) {
  return stripDollarQuotedCore(sql, (out) => DO_PREFIX_RE.test(stripTrailingComments(out)));
}

// Function-definition bodies ONLY: a dollar-quote is stripped iff the last
// non-comment token before it is `AS` (the CREATE FUNCTION body marker in
// this repo's migration style). EVERYTHING ELSE — DO blocks with comments
// anywhere in their prefix, unknown or obfuscated forms — stays VISIBLE.
// Default-keep is the fail-safe direction (Codex P1 2026-07-13 round 4: the
// DO-prefix allowlist kept being bypassable by legal comment placement; an
// over-kept body can only cause a false PARK, never hidden data loss).
const FN_BODY_PREFIX_RE = /\bas\s*$/i;
function stripFunctionBodiesOnly(sql) {
  return stripDollarQuotedCore(sql, (out) => !FN_BODY_PREFIX_RE.test(stripTrailingComments(out)));
}

// Quote-aware comment removal. String literals, quoted identifiers, and
// dollar-quoted spans are copied VERBATIM — a `/*` or `--` inside them is data,
// not a comment (Codex P1 2026-07-13 round 5: `SELECT '/*'; DELETE FROM
// customers; SELECT '*/';` let a raw-regex comment strip swallow the real
// DELETE). Real comments become a single space. Side effect: a comment INSIDE
// a kept dollar-quoted body (e.g. a DO block) is no longer stripped, so prose
// like `-- never TRUNCATE` in a DO body can false-positive — that parks the
// migration for Mason, which is the safe direction.
export function stripCommentsQuoteAware(sql) {
  const src = String(sql || "");
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      out += src.slice(i, j); i = j; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j++;
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(src.slice(i, i + 66));
      if (tag) {
        const open = tag[0];
        const close = src.indexOf(open, i + open.length);
        const end = close === -1 ? n : close + open.length;
        out += src.slice(i, end); i = end; continue;
      }
    }
    if (ch === "-" && src[i + 1] === "-") {
      let j = i + 2;
      while (j < n && src[j] !== "\n" && src[j] !== "\r") j++;
      out += " "; i = j; continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      let depth = 1, j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") { depth++; j += 2; continue; }
        if (src[j] === "*" && src[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      out += " "; i = j; continue;
    }
    out += ch; i++;
  }
  return out;
}

// ── SELECT-invoked function classification (Codex P1 round 4, PR #352) ───────
// A mutating-verb blocklist can never converge (save_customer, close_accounting_
// period, restore_quote_version all slipped it), so this is DEFAULT-DENY: any
// custom function invoked in the statement is blocked unless its name carries a
// read-only prefix or is a recognized SQL builtin. A false positive denies —
// the safe direction — and REAL-DATA-OK (checked by the guard) overrides.
// `check_` is deliberately NOT trusted: check_unpriced_orders() inserts
// notifications and updates orders (Codex P1 round 5, PR #352) — the prefix is
// not proof of immutability. Audited read-only functions with untrusted names
// go in READONLY_FN_NAMES below, one per line, with the audit date.
const READONLY_FN_PREFIX_RE = /^(?:get|list|find|search|count|calc|calculate|compute|report|fetch|lookup|has|is|can|preview|estimate|summarize|derive)_/;
export const READONLY_FN_NAMES = new Set([
  // (none audited yet — add "fn_name", // audited YYYY-MM-DD entries here)
]);
const SQL_BUILTIN_FNS = new Set([
  // aggregates / window
  "count", "sum", "avg", "min", "max", "string_agg", "array_agg", "jsonb_agg",
  "json_agg", "jsonb_object_agg", "json_object_agg", "bool_and", "bool_or",
  "row_number", "rank", "dense_rank", "percent_rank", "ntile", "lag", "lead",
  "first_value", "last_value", "nth_value", "percentile_cont", "percentile_disc",
  // conditionals / generic
  "coalesce", "nullif", "greatest", "least", "num_nonnulls", "num_nulls",
  // json
  "jsonb_build_object", "json_build_object", "jsonb_build_array", "json_build_array",
  "jsonb_array_elements", "json_array_elements", "jsonb_array_elements_text",
  "jsonb_each", "json_each", "jsonb_each_text", "jsonb_object_keys", "json_object_keys",
  "jsonb_typeof", "json_typeof", "jsonb_array_length", "json_array_length",
  "jsonb_extract_path", "jsonb_extract_path_text", "jsonb_path_query",
  "jsonb_path_query_array", "jsonb_path_exists", "jsonb_pretty", "jsonb_strip_nulls",
  "to_json", "to_jsonb", "row_to_json", "array_to_json", "json_populate_record",
  "jsonb_populate_record", "jsonb_set", "jsonb_insert", "jsonb_concat",
  // arrays / sets
  "unnest", "generate_series", "generate_subscripts", "array_length", "cardinality",
  "array_position", "array_positions", "array_to_string", "string_to_array",
  "array_append", "array_prepend", "array_remove", "array_replace", "array_cat",
  "array_fill", "array_agg_distinct", "array_upper", "array_lower", "array_ndims",
  // date / time
  "now", "clock_timestamp", "statement_timestamp", "transaction_timestamp",
  "date_trunc", "date_part", "extract", "to_char", "to_date", "to_timestamp",
  "to_number", "age", "justify_interval", "justify_days", "justify_hours",
  "make_date", "make_time", "make_timestamp", "make_timestamptz", "make_interval",
  "date_bin", "timezone", "isfinite",
  // math
  "round", "floor", "ceil", "ceiling", "abs", "sign", "mod", "power", "sqrt",
  "cbrt", "exp", "ln", "log", "log10", "trunc", "random", "setseed", "width_bucket",
  "div", "gcd", "lcm", "factorial", "pi", "degrees", "radians",
  // strings
  "length", "char_length", "character_length", "octet_length", "bit_length",
  "lower", "upper", "initcap", "trim", "ltrim", "rtrim", "btrim", "lpad", "rpad",
  "substring", "substr", "replace", "translate", "overlay", "split_part",
  "position", "strpos", "starts_with", "concat", "concat_ws", "left", "right",
  "reverse", "repeat", "format", "quote_ident", "quote_literal", "quote_nullable",
  "regexp_replace", "regexp_matches", "regexp_match", "regexp_split_to_table",
  "regexp_split_to_array", "regexp_count", "regexp_like", "regexp_instr",
  "regexp_substr", "md5", "encode", "decode", "convert_from", "convert_to",
  "to_hex", "ascii", "chr", "parse_ident",
  // casts / type info / misc reads
  "cast", "pg_typeof", "pg_column_size", "pg_size_pretty", "version",
  "current_setting", "current_database", "current_schema", "current_user",
  "session_user", "pg_backend_pid", "txid_current", "pg_is_in_recovery",
  "obj_description", "col_description", "shobj_description",
  "pg_get_serial_sequence", "pg_get_functiondef", "pg_get_constraintdef",
  "pg_get_indexdef", "pg_get_viewdef", "pg_get_expr", "pg_relation_size",
  "pg_total_relation_size", "pg_table_size", "pg_indexes_size", "pg_database_size",
  "format_type", "to_regclass", "to_regproc", "to_regtype",
  "has_table_privilege", "has_column_privilege", "has_function_privilege",
  "has_schema_privilege", "has_database_privilege", "pg_has_role",
  "gen_random_uuid", "uuid_generate_v4", "exists", "currval", "lastval",
  // full-text search (read-only)
  "to_tsvector", "to_tsquery", "plainto_tsquery", "phraseto_tsquery",
  "websearch_to_tsquery", "ts_rank", "ts_rank_cd", "ts_headline",
]);
// SQL keywords that look like `word (` in text but are not function calls.
const SQL_KEYWORD_FNS = new Set([
  "select", "from", "where", "and", "or", "not", "in", "on", "as", "join",
  "values", "using", "over", "filter", "within", "group", "order", "by",
  "having", "limit", "offset", "union", "all", "any", "some", "distinct",
  "case", "when", "then", "else", "end", "between", "like", "ilike", "similar",
  "is", "null", "true", "false", "interval", "array", "row", "with", "lateral",
  "cross", "inner", "outer", "full", "grouping", "window", "partition", "if",
]);

export function findNonReadFunctionCall(sqlText) {
  const text = String(sqlText || "");
  if (!/\bselect\b/i.test(text)) return null;
  const re = /(?:"?public"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (SQL_KEYWORD_FNS.has(name) || SQL_BUILTIN_FNS.has(name)) continue;
    if (READONLY_FN_NAMES.has(name)) continue;
    if (READONLY_FN_PREFIX_RE.test(name)) continue;
    // pg_catalog/information_schema internals are reads
    if (name.startsWith("pg_stat") || name.startsWith("pg_ls") || name.startsWith("information_schema")) continue;
    return name;
  }
  return null;
}

// Returns { block: false } | { block: true, kind, reason }
export function classifySql(query) {
  const q = String(query || "");
  if (!q) return { block: false };

  // Pattern checks run against the stripped text (machine content removed).
  // The rolled-back-smoke structure below still reads the ORIGINAL text: the
  // RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK' marker lives inside a DO body, and a
  // COMMIT anywhere (even inside a DO body) must keep disqualifying the batch.
  const t = stripDollarQuoted(q);

  // 1. financial_audit_log is append-only, written only by triggers/RPCs — a Hard
  //    Red Line. No [E2E] exemption; only REAL-DATA-OK (checked by the guard) overrides.
  if (AUDIT_LOG_WRITE_RE.test(t)) {
    return {
      block: true,
      kind: "audit-log-write",
      reason: "This writes to financial_audit_log by hand. The audit log is append-only and written ONLY by the database's own triggers/RPCs (Hard Red Line). If a correction is genuinely needed, it is Mason's call — surface the row IDs instead.",
    };
  }

  // 2. TRUNCATE has no legitimate execute_sql use against the live DB.
  if (TRUNCATE_RE.test(t)) {
    return {
      block: true,
      kind: "truncate",
      reason: "TRUNCATE wipes a live table and is never done via raw SQL here. If data really must be cleared, that is Mason's explicit call via the migration path.",
    };
  }

  // 3. Schema changes (DDL, GRANT/REVOKE) must travel the migration gauntlet —
  //    a rolled-back smoke batch is the one exception. "Rolled back" must be
  //    STRUCTURAL, not textual (Codex 2026-07-05: `SELECT 'SMOKE_PASS_ROLLBACK'`
  //    used to qualify): either a real transaction wrapper (BEGIN is the first
  //    statement AND ROLLBACK is the last), or a DO-block smoke that force-aborts
  //    via an actual RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'. Any statement-anchored
  //    COMMIT disqualifies the batch.
  const hasCommitStmt = /(?:^|;)\s*commit\b/i.test(q);
  const txWrapped = /^\s*begin\s*;[\s\S]*;\s*rollback\s*;?\s*$/i.test(q);
  const smokeAbort = /raise\s+exception\s+'?SMOKE_PASS_ROLLBACK/i.test(q);
  const rolledBack = !hasCommitStmt && (txWrapped || smokeAbort);
  if (!rolledBack && (DDL_STMT_RE.test(t) || GRANT_REVOKE_RE.test(t))) {
    return {
      block: true,
      kind: "raw-ddl",
      reason: "This changes the live database schema (or grants) via raw execute_sql, which routes around the entire migration review gauntlet. Put the change in a supabase/migrations/ file and go through apply_migration (with its reviews), or wrap the batch in BEGIN; ... ROLLBACK; if this is a smoke test.",
    };
  }

  // 3b. Side-effecting expressions hidden inside SELECT (Codex P1 round 3,
  //     PR #352): setval/nextval mutate live sequence state (e.g. invoice
  //     numbering), and the app's mutating RPCs can be invoked via a plain
  //     SELECT fn(...). Neither is a read. No [E2E] exemption — these change
  //     shared state regardless of marker; REAL-DATA-OK (checked by the guard)
  //     is the override. currval/lastval remain allowed (true reads).
  if (/\b(?:setval|nextval)\s*\(/i.test(t)) {
    return {
      block: true,
      kind: "sequence-mutation",
      reason: "setval()/nextval() changes live sequence state (e.g. invoice numbering) even inside a SELECT. Read with currval()/last_value instead, or get Mason's explicit REAL-DATA-OK for a real sequence change.",
    };
  }
  {
    const rpc = findNonReadFunctionCall(t);
    if (rpc) {
      return {
        block: true,
        kind: "rpc-via-select",
        reason: `This statement invokes "${rpc}()", which is not a known read-only function — calling an application RPC changes live data even when the statement starts with SELECT. Use the app, or get Mason's explicit REAL-DATA-OK. (Read-prefixed functions like get_/check_/list_ and SQL builtins stay allowed.)`,
      };
    }
  }

  // 4. Clearly-fake test data is fine for ordinary data writes.
  if (t.includes("[E2E]")) return { block: false };

  let m;
  if ((m = INSERT_RE.exec(t))) {
    return {
      block: true,
      kind: "real-insert",
      reason: `This INSERTs into the live business table "${m[1]}" without the [E2E] fake-data marker. On the LIVE app, use only clearly-fake [E2E]-prefixed entities for analysis (and delete them when done). If Mason explicitly asked for a REAL write, first create .claude/session-state/REAL-DATA-OK to record his authorization, then retry.`,
    };
  }
  if ((m = DELETE_RE.exec(t))) {
    return {
      block: true,
      kind: "financial-delete",
      reason: `This DELETEs from the live financial table "${m[1]}". Deleting real financial records is Mason's call — surface the record IDs in your findings instead of acting. (Override: he authorizes via .claude/session-state/REAL-DATA-OK.)`,
    };
  }
  if ((m = CANCEL_VOID_RE.exec(t))) {
    return {
      block: true,
      kind: "financial-cancel",
      reason: `This cancels/voids a real record in "${m[1]}". Cancelling/voiding live invoices/orders/payments is Mason's job — surface the IDs, don't act. (Override: .claude/session-state/REAL-DATA-OK.)`,
    };
  }

  // 5. Money-amount edits on financial tables (SET clause only, not the WHERE part).
  if ((m = FIN_UPDATE_RE.exec(t))) {
    const afterSet = t.slice(m.index).match(/\bset\b([\s\S]*)/i);
    const setClause = afterSet ? afterSet[1].split(/\bwhere\b/i)[0] : "";
    if (MONEY_COL_RE.test(setClause)) {
      return {
        block: true,
        kind: "financial-amount-update",
        reason: `This UPDATEs a money column on the live financial table "${m[1]}" via raw SQL. Real financial amounts change only through the app's RPCs (or Mason's explicit REAL-DATA-OK authorization) — surface the row IDs and the proposed correction instead.`,
      };
    }
  }

  // 5b. DELETE catch-all: any DELETE against a real (non-[E2E]) business table,
  //     not just the financial subset (rule 4 above already handled those).
  if ((m = DELETE_ANY_RE.exec(t))) {
    return {
      block: true,
      kind: "real-delete",
      reason: `This DELETEs from the live business table "${m[1]}" without the [E2E] fake-data marker. Deleting real records is Mason's call — surface the record IDs instead of acting. (Override: he authorizes via .claude/session-state/REAL-DATA-OK.)`,
    };
  }

  // 6. FIX 5 catch-all: any OTHER UPDATE against a real (non-[E2E]) business
  //    table — same standard already applied to INSERT above.
  if ((m = UPDATE_ANY_RE.exec(t))) {
    return {
      block: true,
      kind: "real-update",
      reason: `This UPDATEs the live business table "${m[1]}" without the [E2E] fake-data marker. On the LIVE app, use only clearly-fake [E2E]-prefixed entities for analysis (and delete them when done). If Mason explicitly asked for a REAL write, first create .claude/session-state/REAL-DATA-OK to record his authorization, then retry.`,
    };
  }

  return { block: false };
}

// ── Destructive-migration classifier (Mason's settled 2026-07-13 policy) ─────
// Detects APPLY-TIME data destruction in a migration's SQL: DROP TABLE,
// ALTER TABLE ... DROP COLUMN, TRUNCATE, or ANY top-level DELETE FROM. Runs
// against stripDollarQuoted() output, so a DELETE inside a CREATE FUNCTION
// body (which does NOT execute at apply time) doesn't count — but a DO block's
// body does (it executes immediately).
// The DELETE rule is deliberately GENERIC — no table allowlist (Codex P1
// 2026-07-13 round 2: a hard-coded list missed live tables like invoice_shares
// and finance_charges; in a migration, a top-level DELETE is rare enough that
// every one deserves Mason's eyes). DROP POLICY/INDEX/TRIGGER/FUNCTION/
// CONSTRAINT are routine schema hygiene and deliberately do NOT match.
// Comments are removed before matching so prose like "-- never TRUNCATE here"
// can't false-positive. Conservative by design: used by migration-apply-guard
// to refuse a destructive apply in a hands-free run — a false positive parks
// the migration for the morning, a false negative would delete data with
// nobody watching.
export function destructiveMigrationCheck(sql) {
  // Strip ONLY clear function-definition bodies (AS $$...$$) — everything
  // else, including DO blocks however commented, stays visible (default-keep).
  const stripped = stripFunctionBodiesOnly(String(sql || ""));
  if (!stripped) return { destructive: false };
  // Quote-aware, NOT raw regex: a `/*` inside a string literal must not open a
  // fake comment span that swallows a real DELETE (Codex P1 round 5).
  const t = stripCommentsQuoteAware(stripped);
  if (/\bdrop\s+table\b/i.test(t)) return { destructive: true, reason: "DROP TABLE" };
  // DOMAIN/TYPE/EXTENSION drops can CASCADE into data-bearing columns/tables;
  // any of them in a migration is rare enough to deserve Mason's eyes
  // (Codex P1 2026-07-13 round 4).
  if (/\bdrop\s+(?:schema|database|owned|domain|type|extension)\b/i.test(t)) return { destructive: true, reason: "DROP SCHEMA/DATABASE/OWNED/DOMAIN/TYPE/EXTENSION" };
  // `COLUMN` is OPTIONAL in ALTER TABLE ... DROP <col> (Codex P1 round 4).
  // Match any ALTER TABLE ... DROP <thing> EXCEPT the non-data forms:
  // DROP CONSTRAINT, and the ALTER COLUMN sub-forms DROP NOT NULL / DROP
  // DEFAULT / DROP IDENTITY / DROP EXPRESSION.
  if (/\balter\s+table\b[^;]*\bdrop\s+(?!constraint\b|not\s+null\b|default\b|identity\b|expression\b)/i.test(t)) {
    return { destructive: true, reason: "ALTER TABLE ... DROP [COLUMN]" };
  }
  if (/\btruncate\b/i.test(t)) return { destructive: true, reason: "TRUNCATE" };
  if (/\bdelete\s+from\b/i.test(t)) return { destructive: true, reason: "top-level DELETE FROM (any table)" };
  // MERGE can delete matched rows (WHEN MATCHED THEN DELETE) — and is rare
  // enough in a migration that ANY top-level MERGE deserves Mason's eyes
  // (Codex P1 2026-07-13 round 3).
  if (/\bmerge\s+into\b/i.test(t)) return { destructive: true, reason: "MERGE INTO (can delete matched rows)" };
  return { destructive: false };
}

export { BUSINESS_TABLES, FINANCIAL_TABLES };
