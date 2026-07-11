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
];
const FINANCIAL_TABLES = [
  "invoices", "orders", "payments", "commissions", "commission_payments", "financial_audit_log",
];

function tableAlt(tables) {
  return tables.map((t) => t.replace(/[^a-z_]/g, "")).join("|");
}
const INSERT_RE = new RegExp(`\\binsert\\s+into\\s+(?:public\\.)?"?(${tableAlt(BUSINESS_TABLES)})"?\\b`, "i");
const DELETE_RE = new RegExp(`\\bdelete\\s+from\\s+(?:public\\.)?"?(${tableAlt(FINANCIAL_TABLES)})"?\\b`, "i");
const CANCEL_VOID_RE = new RegExp(`\\bupdate\\s+(?:public\\.)?"?(${tableAlt(FINANCIAL_TABLES)})"?\\b[\\s\\S]*?\\bset\\b[\\s\\S]*?status\\s*=\\s*'(cancelled|voided)'`, "i");

// Any hand-written touch of the append-only audit log — [E2E] does NOT exempt this.
const AUDIT_LOG_WRITE_RE = /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?"?financial_audit_log\b/i;

// Statement-anchored DDL (start of batch or after a `;`). `create temp`/`temporary`
// tables are legitimate scratch space for analysis and stay allowed.
const DDL_STMT_RE = /(?:^|;)\s*(?:create(?!\s+(?:temp|temporary)\b)(?:\s+or\s+replace)?|alter|drop)\s+\S+/im;
const GRANT_REVOKE_RE = /(?:^|;)\s*(?:grant|revoke)\b/im;
const TRUNCATE_RE = /(?:^|;)\s*truncate\b/im;

// Money-ish column assignment (column name on the LEFT of `=`) on a financial table.
const FIN_UPDATE_RE = new RegExp(`\\bupdate\\s+(?:public\\.)?"?(${tableAlt(FINANCIAL_TABLES)})"?\\b`, "i");
const MONEY_COL_RE = /\b[a-z_]*(?:cents|amount|total|balance|price|rate|paid)[a-z_]*\s*=/i;

// A DO body is hand-written SQL that EXECUTES immediately (a DO block can even
// COMMIT mid-transaction), so unlike a stored function body it must stay visible
// to the classifier. Matches "DO $tag$" and "DO LANGUAGE plpgsql $tag$".
const DO_PREFIX_RE = /\bdo(?:\s+language\s+[a-z_][a-z0-9_]*)?\s*$/i;

// Strip dollar-quoted string bodies ($function$...$function$, $$...$$, any
// $tag$...$tag$ pair) so classification sees only top-level hand-written SQL —
// an INSERT INTO financial_audit_log inside a CREATE OR REPLACE FUNCTION body
// being re-emitted by a BEGIN;...;ROLLBACK; smoke is machine content, not a
// hand-written audit-log write. Single-quoted literals and comments are walked
// (not stripped) so a stray $$ inside them can't open a fake quote span that
// swallows real statements. DO bodies are kept (they execute). An unterminated
// dollar-quote leaves the rest untouched (fail closed).
export function stripDollarQuoted(sql) {
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
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
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
        out += DO_PREFIX_RE.test(out) ? src.slice(i, end) : " ";
        i = end; continue;
      }
    }
    out += ch; i++;
  }
  return out;
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

  return { block: false };
}

export { BUSINESS_TABLES, FINANCIAL_TABLES };
