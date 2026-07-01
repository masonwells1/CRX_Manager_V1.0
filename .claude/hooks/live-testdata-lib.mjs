// Pure classifier for live-testdata-guard.mjs. Decides whether an execute_sql
// query is a real-business-data write that should be blocked (unless it's clearly
// fake [E2E] data or Mason has authorized real data this session).

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

// Returns { block: false } | { block: true, kind, reason }
export function classifySql(query) {
  const q = String(query || "");
  if (!q) return { block: false };
  // Clearly-fake test data is always fine.
  if (q.includes("[E2E]")) return { block: false };

  let m;
  if ((m = INSERT_RE.exec(q))) {
    return {
      block: true,
      kind: "real-insert",
      reason: `This INSERTs into the live business table "${m[1]}" without the [E2E] fake-data marker. On the LIVE app, use only clearly-fake [E2E]-prefixed entities for analysis (and delete them when done). If Mason explicitly asked for a REAL write, first create .claude/session-state/REAL-DATA-OK to record his authorization, then retry.`,
    };
  }
  if ((m = DELETE_RE.exec(q))) {
    return {
      block: true,
      kind: "financial-delete",
      reason: `This DELETEs from the live financial table "${m[1]}". Deleting real financial records is Mason's call — surface the record IDs in your findings instead of acting. (Override: he authorizes via .claude/session-state/REAL-DATA-OK.)`,
    };
  }
  if ((m = CANCEL_VOID_RE.exec(q))) {
    return {
      block: true,
      kind: "financial-cancel",
      reason: `This cancels/voids a real record in "${m[1]}". Cancelling/voiding live invoices/orders/payments is Mason's job — surface the IDs, don't act. (Override: .claude/session-state/REAL-DATA-OK.)`,
    };
  }
  return { block: false };
}

export { BUSINESS_TABLES, FINANCIAL_TABLES };
