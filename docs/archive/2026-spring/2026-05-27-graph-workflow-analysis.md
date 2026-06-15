# Graph Workflow Analysis — 2026-05-27

## Executive Summary

**Graph scope:** `src/pages` + `src/lib` + `src/hooks` (TypeScript business layer only).
**Graph stats:** 1,381 nodes · 2,681 edges · 76 communities.
**Extraction quality:** 100% EXTRACTED, 0% INFERRED, 6 low-confidence inferred edges (avg confidence 0.8).
**Analysis limits:** graph captures code-structure edges only (`contains`, `calls`, `imports`). It does not contain RPC/DB names. Workflow-integrity checks were performed by grepping source, not from graph edges.

### Finding counts
| Category | Count |
|----------|-------|
| Misplaced & Duplicated Logic | 5 findings |
| Workflow Integrity | 2 findings |
| Structural Health | 2 findings |

### Top 5 highest-impact findings
1. **A1 [High]** — `parseDollarsToCents()` re-implemented in `ApplicationServiceDetail.tsx` with weaker sanitization — `parseFloat("$1.50")` silently stores 0 cents.
2. **A2 [Med]** — `conditionVariant()` / `conditionLabel()` triplicated byte-for-byte across 3 receiving pages and the receiving PDF lib — any change to condition values requires 3–4 coordinated edits.
3. **A3 [Med]** — `statusBadge()` for `InvoiceStatus` duplicated identically between `InvoiceDetail.tsx` and `Invoices.tsx`.
4. **B1 [Med]** — `create_commission_payment` mutation embedded in `Reports.tsx`, creating an undocumented second pathway to the commission payment lifecycle.
5. **A4 [Med]** — `currentSeason()` duplicated identically in two unrelated pages; no lib equivalent exists.

---

## 1. Misplaced & Duplicated Logic

### A1 — `parseDollarsToCents()` re-implemented with weaker sanitization — **High**
**Why it matters:** The page version silently converts user input containing `$` or commas to zero cents, causing rate-per-acre values to be saved as 0 without error or validation feedback.

**Graph evidence:** node `parseDollarsToCents()` appears in both `lib/parseCents.ts` and `pages/ApplicationServiceDetail.tsx` (duplicate-name query, 2 files).

**Source:**
- `lib/parseCents.ts:25` — exported canonical version:
  ```
  export function parseDollarsToCents(input: string): number {
    return Math.abs(parseDollarsToCentsSigned(input));
  }
  // parseDollarsToCentsSigned strips non-numeric chars, rejects 'e', handles commas
  ```
- `pages/ApplicationServiceDetail.tsx:19` — private local version:
  ```
  function parseDollarsToCents(val: string): number {
    const n = parseFloat(val);
    return isNaN(n) ? 0 : Math.round(n * 100);
  }
  ```
- Callsites: `ApplicationServiceDetail.tsx:87`, `ApplicationServiceDetail.tsx:112`

**Divergence:** `parseFloat("$1.50")` returns `NaN` (no stripping), so the page version falls back to `0`. The lib version strips `$` first and returns `150`. A `formatCentsToDollars()` helper is also defined locally at `ApplicationServiceDetail.tsx:23` rather than using any lib equivalent.

**Tag:** [verified in source]

---

### A2 — `conditionVariant()` / `conditionLabel()` triplicated across receiving pages — **Med**
**Why it matters:** Condition values (good, damaged, wrong_product, short, mixed) are a DB-level enum. If a new value is added, three page files and one PDF lib must be updated in lockstep — a silent inconsistency risk.

**Graph evidence:** duplicate-name query returns `conditionVariant()` in 3 source files; `conditionLabel()` in 3 source files.

**Source — all identical implementations:**
- `pages/PurchaseOrderDetail.tsx:25` (`conditionVariant`) and `:31` (`conditionLabel`)
- `pages/QuickReceive.tsx:56` (`conditionVariant` only — no `conditionLabel` used here)
- `pages/ReceivingLog.tsx:32` (`conditionVariant`) and `:38` (`conditionLabel`)
- `lib/receivingPdf.ts:41` (`conditionLabel` only)

```typescript
// All three conditionVariant() implementations are byte-for-byte identical:
const conditionVariant = (c: string): 'success' | 'error' | 'warning' | 'default' => {
  if (c === 'good') return 'success';
  if (c === 'damaged' || c === 'wrong_product') return 'error';
  if (c === 'short' || c === 'mixed') return 'warning';
  return 'default';
};
```

**Tag:** [verified in source]

---

### A3 — `statusBadge()` for `InvoiceStatus` duplicated between InvoiceDetail and Invoices — **Med**
**Why it matters:** Adding a new invoice status (e.g., `disputed`) requires two identical edits; a missed update would render the status as the raw string in one of the two views.

**Graph evidence:** duplicate-name query returns `statusBadge()` in 2 source files.

**Source:**
- `pages/InvoiceDetail.tsx:53`
- `pages/Invoices.tsx:44`

Both define the complete 7-status `Record<InvoiceStatus, { variant, label }>` mapping with identical variant assignments. Confirmed byte-for-byte identical.

**Tag:** [verified in source]

---

### A4 — `currentSeason()` duplicated in two unrelated pages — **Med**
**Why it matters:** The season boundary rule (October 1 = start of next season) is a core business constant in CLAUDE.md. If the boundary ever changes, this logic lives in two isolated page files with no lib-layer equivalent to update.

**Graph evidence:** duplicate-name query returns `currentSeason()` in 2 source files.

**Source:**
- `pages/ApplicationServiceDetail.tsx:27`
- `pages/ProgramTracker.tsx:35`

Both are private module-level functions with identical bodies:
```typescript
function currentSeason(): number {
  const now = new Date();
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
}
```

`lib/dateUtils.ts` exports related season helpers (`computeSeason`, `getSeasonDates`, `seasonStartDate`, `seasonEndDate`) but not a simple `currentSeason()` wrapper. Neither page imports from the date lib.

**Tag:** [verified in source]

---

### A5 — `getPresetDates()` evolved divergently across 4 pages — **Low**
**Why it matters:** A new date preset (e.g., "current quarter") requires four independent additions with no shared test coverage for the date math.

**Graph evidence:** duplicate-name query returns `getPresetDates()` in 4 source files.

**Source:**
- `pages/ApplicationRecords.tsx:27` — presets: `this_season`, `last_season`, `last30`
- `pages/Jobs.tsx:40` — presets: `today`, `this_week`, `this_season`
- `pages/Reports.tsx:74` — presets: `this_season`, `last_season`, `ytd`, `last30`, `last90`
- `pages/SalesReports.tsx:22` — presets: `this_season`, `last_season`, `ytd`, `last30`, `last90`

The implementations share the same building blocks from `lib/dateUtils.ts` (`localToday`, `getSeasonDates`, `computeSeason`, `formatLocalDate`) but each page re-assembles them independently. Reports and SalesReports are nearly identical; ApplicationRecords and Jobs have unique presets not present in the others.

**Tag:** [verified in source]

---

## 2. Workflow Integrity

### B1 — `create_commission_payment` mutation embedded in `Reports.tsx` — **Med**
**Why it matters:** `Reports.tsx` is a read-oriented reporting page. Embedding a commission payment creation pathway there means an audit of the commission payment lifecycle (`CommissionPayments.tsx`) would miss this second mutation pathway. It also means the page must maintain its own commission payment state (selected commissions, loading state, idempotency key) alongside unrelated reporting logic.

**Graph evidence:** `create_commission_payment` call found at `pages/Reports.tsx:468` via `grep -rno "\.rpc\('create_commission_payment'"`.

**Source:**
- `pages/Reports.tsx:455-490` — "Quick pay from Reports page" feature:
  - Reads `selected` commissions from a table displayed on the Reports page
  - Groups by `recipient_user_id`
  - Calls `supabase.rpc('create_commission_payment', { ..., p_notes: 'Quick pay from Reports page', ... })` for each group
  - Calls `logActivity({ event: 'commissions_paid', ... })` on success
- `pages/CommissionPayments.tsx:226` — the canonical commission payment pathway with the same `create_commission_payment` RPC

**Lifecycle comparison (CLAUDE.md):** Commission status: `pending → paid → cancelled`. `create_commission_payment` is a mutating RPC that advances commissions from `pending` to `paid`. The Reports page implements a subset of the CommissionPayments workflow without going through `CommissionPayments.tsx`.

**Tag:** [verified in source]

---

### B2 — `receive_po_items` called directly from `InventoryPage` — **Low**
**Why it matters:** The canonical receiving flow (PO lifecycle: `draft → submitted → partially_received → fully_received → cancelled`) runs through `PurchaseOrderDetail.tsx`. The inventory page exposes a secondary path that reaches the same RPC without the PO review UI.

**Graph evidence:** `receive_po_items` call found at `pages/InventoryPage.tsx:552` via `grep`.

**Source:**
- `pages/InventoryPage.tsx:541-573` — calls `receive_po_items` with a single `po_item_id` selected directly from inventory view
- `pages/PurchaseOrderDetail.tsx:250` — canonical pathway; shows full PO line items before receiving
- `pages/QuickReceive.tsx:316` — also calls `receive_po_items`; this page's sole purpose is expedited receiving, so it is intentionally a second pathway

The RPC handles PO state transitions atomically, so this is not unsafe at the database level. The concern is operator flow: receiving from the Inventory page does not require reviewing the full PO (quantities ordered, items expected) before confirming receipt.

**Tag:** [verified in source]

---

## 3. Structural Health

### C1 — "DB Helpers & Money Parsing" community (Community 10) groups unrelated page components with core lib utilities — **Low**
**Why it matters:** The community label is misleading — this is not a cohesive module problem; it's a graph artifact. The graph cannot distinguish "lives here" from "imports from here," so all pages that import `parseDollarsToCents`, `assertRpcResult`, or `useIdempotencyKey` land in this community alongside those lib files.

**Graph evidence:** Community 10 (cohesion 0.10, 26 nodes). Contains `lib/parseCents.ts`, `hooks/useIdempotencyKey.ts`, `lib/db.ts` (core utilities) alongside `pages/CustomerDetail.tsx`, `pages/PaymentAllocation.tsx`, `pages/PrepayWorkspace.tsx`, `pages/SettingsPage.tsx`, `pages/Vendors.tsx`, `pages/VendorBillDetail.tsx`, `pages/InventoryPage.tsx`, `pages/NewVendorBill.tsx`, `pages/FieldSetup.tsx`.

**What this tells you:** These pages are co-consumers of the DB helper layer; they are not structurally interrelated with each other. The community is a false cluster — not a split candidate.

**Tag:** [verified in source]

---

### C2 — Five communities with cohesion ≤ 0.10 and 30–50 nodes each — **Low**
**Why it matters:** Low cohesion at this scale indicates the graph clustering algorithm found no strong internal connection pattern — these nodes ended up together because they share a few common import targets rather than because they form a coherent module.

**Graph evidence (from GRAPH_REPORT.md):**
| Community | Label | Cohesion | Nodes |
|-----------|-------|----------|-------|
| 0 | Notifications & Inventory Allocations | 0.05 | 50 |
| 1 | Credit/Driver Guardrails | 0.05 | 39 |
| 2 | Data Integrity Checks | 0.07 | 44 |
| 3 | Commission Calculation | 0.06 | 31 |
| 4 | RPC Param/Result Types | 0.05 | 42 |

Spot-checked Community 0: source files include `lib/activityLogger.ts`, `lib/notificationTriggers.ts`, `pages/Dashboard.tsx`, and `pages/QuickReceive.tsx`. Dashboard and QuickReceive are in this community because they call notification functions — not because they belong architecturally to notification infrastructure.

Community 4 ("RPC Param/Result Types") is a structural false-cluster: it groups ~42 TypeScript interface definitions from `lib/rpcTypes.ts` (or similar) that are individually used by many pages but have no internal cohesion with each other.

**Tag:** [graph-only — community-level, not verified per-node in source]

---

## Appendix — Looked Odd But Is Fine

| Candidate | Why it's fine |
|-----------|---------------|
| `nextKey()` in 4 pages (NewOrder, NewPurchaseOrder, QuickReceive, QuoteBuilder) | Different key prefixes per page (`_k`, `poi_`, `qr_`) — intentional namespace separation for local form row keys, not duplication |
| `makeEmptyItem()` in NewOrder and QuoteBuilder | Different field shapes (`quantity`/`price_per_unit` vs `sort_order`/`notes`/`current_cost`) — same name, different local types |
| `fmtCents()` in `pages/DeliveryDetail.tsx` | Graph flagged as cross-module (2 callsites) but grep confirms it is used only within `DeliveryDetail.tsx` — graph false positive |
| `fmt()` currency formatter in 8+ locations | PDF-lib versions divide `cents / 100`; page-side versions format dollar amounts directly — different units, not safely mergeable |
| `post_invoice_group` + `post_invoice` called from the same page | Intentional conditional branch: `if (invoice_group_id) → post_invoice_group`, else `→ post_invoice`. Correct and documented in comments |
| `toDollarDisplay()` + `daysBetween()` in `PaymentAllocation.tsx` | Both used only within `PaymentAllocation.tsx` — private helpers, not dead code despite graph orphan flag |
| Page components (Dashboard, Reports, etc.) appearing as orphans | Default-exported page components rendered by the router in `App.tsx` — `App.tsx` is outside the graph scope; all are false orphans |
| `initSentry()` in `lib/sentry.ts` appearing as orphan | Called at app startup in a file outside graph scope; not dead code |
| `getPresetDates()` implementations not identical | Confirmed divergent (different preset sets per page) — not suitable for a simple shared function without a union type design first |
