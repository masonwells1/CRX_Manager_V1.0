# Deep Audit Wave 2 — Swarm Results (2026-03-11)

**Audited by:** 6 parallel agents targeting specific bug categories identified from the delivery/RPC issues.
**Scope:** Silent failures, idempotency gaps, state machine mismatches, role/permission holes, RPC signature drift, type drift.
**Result:** 65 NEW bugs found (not in the Wave 1 report).

---

## Executive Summary

| Category | Agent | Critical | High | Medium | Low | Total |
|----------|-------|----------|------|--------|-----|-------|
| Silent Failures | ERR | 0 | 5 | 7 | 12 | 24 |
| Idempotency Gaps | IDEMP | 2 | 5 | 4 | 2 | 13 |
| State Machine | STATE | 2 | 3 | 4 | 1 | 10 |
| Role/Permission | ROLE | 2 | 3 | 3 | 2 | 10 |
| Type Drift | TYPE | 0 | 1 | 4 | 3 | 8 |
| **TOTAL** | | **6** | **17** | **22** | **20** | **65** |

Plus: 2 RPC drift runtime bugs, 7 `SECURITY DEFINER` missing `SET search_path`, 11 stale overloads to clean up.

---

## 🔴 CRITICAL (6 bugs — fix immediately)

### IDEMP-1 | `cancel_order` called without idempotency key
- **File:** `src/pages/OrderDetail.tsx:178`
- **Bug:** DB accepts `p_idempotency_key` (added in `20260311000000`) but frontend never passes it. The "Update Status" button has NO `disabled` or `loading` prop — rapid clicks fire multiple concurrent cancel cascades.
- **Fix:** Pass `p_idempotency_key` from `useIdempotencyKey()`, add `loading` state to button.

### IDEMP-2 | `create_invoice_from_order` has zero idempotency
- **File:** `src/pages/OrderDetail.tsx:374`
- **Bug:** No idempotency at any level (DB or frontend). Double-click creates duplicate draft invoices. The `setCreatingInvoice(true)` has a gap between click and state set.
- **Fix:** Add `p_idempotency_key` to DB function with `check_idempotency`/`save_idempotency` guards. Pass key from frontend.

### ROLE-1 | `void_invoice` RPC has no role check
- **File:** Migration `20260325200000` (~line 138)
- **Bug:** `SECURITY DEFINER` (bypasses RLS) with no internal role check. Any authenticated user — including drivers — can void posted invoices.
- **Fix:** Add `IF role != 'admin' THEN RAISE EXCEPTION` at function start.

### ROLE-2 | `void_payment` RPC has no role check
- **File:** Migration `20260321300000` (~line 13)
- **Bug:** Same as ROLE-1. Any authenticated user can reverse payment allocations.
- **Fix:** Add admin-only role check.

### STATE-1 | Return cancel button crashes — trigger rejects `cancelled`
- **File:** `src/pages/Returns.tsx:327`
- **Bug:** Cancel button sets `status = 'cancelled'` via direct `.update()`, but the `_enforce_return_status_transition()` trigger has no path to `cancelled` from any state. CHECK constraint allows it; trigger blocks it.
- **Fix:** Add `IF NEW.status = 'cancelled' AND OLD.status IN ('requested', 'approved') THEN RETURN NEW;` to trigger.

### STATE-2 | Quote status revert (`accepted -> sent`) crashes on failed order conversion
- **File:** `src/pages/QuoteBuilder.tsx:1076-1078`
- **Bug:** When `convert_quote_to_order` fails, code reverts quote from `accepted` back to `sent` via direct `.update()`. Trigger doesn't allow `accepted -> sent`.
- **Fix:** Add `accepted -> sent` to trigger's allowed transitions, or use `save_quote` RPC with admin_override.

---

## 🟠 HIGH (17 bugs — fix before production use)

### Silent Failures (5)

**ERR-1 | CustomerDetail.tsx** — Customer fetch error never destructured. RLS denial or network failure shows "Customer not found" — indistinguishable from genuinely nonexistent customer.

**ERR-2 | ProductDetail.tsx** — Same pattern. Product fetch error silently swallowed.

**ERR-5 | CustomerDetail.tsx financials** — Three parallel RPC calls (`get_ar_aging`, `get_customer_statement`, prepay_credits) via `Promise.all` — none check `.error`. Customer AR aging could silently show empty, leading to extending credit to over-limit customers.

**ERR-6 | MonthEndClose.tsx** — Accounting periods fetch error swallowed. The "Is Closed" check defaults to `false`, letting user attempt to re-close an already-closed period.

**ERR-8 | Rebates.tsx** — Claim number generation: `const { count }` doesn't destructure error. If count query fails, `count` is null, `(null || 0) + 1 = 1` → generates `RC-2026-0001` which may duplicate. Also no advisory lock (race condition).

### Idempotency (5)

**IDEMP-3 | `void_payment`** — No idempotency at any level. Double-click could reverse the same payment twice, double-restoring invoice balances.

**IDEMP-4 | `manual_inventory_add`** — No idempotency. Double-click adds inventory twice (100 units becomes 200), inflating `quantity_available`.

**IDEMP-5 | `release_inventory_hold`** — No idempotency. Double-click double-restores available inventory from hold amount.

**IDEMP-7 | Prepay check recording** — Non-atomic 2-step write: (1) `prepay_credits.insert()` then (2) `increment_customer_prepay` RPC. No transaction boundary, no idempotency. Step 1 success + step 2 failure = inconsistent balances.

**IDEMP-8 | `edit/delete_prepay_credit`** — No idempotency. Edit double-click could apply balance change twice. Delete double-click could double-reverse prepay balance.

### State Machine (3)

**STATE-3 | Quote CHECK missing `cancelled`** — Trigger allows `cancelled` from `draft/sent/revised` but CHECK constraint only allows `draft, sent, revised, accepted, declined, expired`. The `cancelled` transition in the trigger is dead code.

**STATE-4 | `void_vendor_bill` allows voiding `partially_paid`** — Sets `status = 'voided'` without checking for existing payments, reversing them, or zeroing `paid_cents`. Leaves orphaned `vendor_payments` records.

**STATE-5 | Invoice filter has phantom statuses** — Filter dropdown includes `paid` and `overdue` options that never match any DB records (invoices only store `draft|unposted|posted|voided|cancelled`). Users select these filters and get zero results.

### Roles (3)

**ROLE-3 | `record_invoice_payment`** — `SECURITY DEFINER` with no role check. Any authenticated user can fabricate payment records.

**ROLE-4 | `create_vendor_bill`** — `SECURITY DEFINER` with no role check. Any user can create vendor bills (AP frontend is admin-restricted, but RPC isn't).

**ROLE-5 | `record_vendor_payment`** — Same as ROLE-4 for vendor payments.

### RPC Drift (1)

**RPC-DRIFT-001 | `reassign_delivery` on DeliveryDetail** — Does NOT pass `p_idempotency_key`, so PostgREST resolves to the stale `(uuid, uuid, uuid)` overload instead of the fixed version. Stale version only allows `role = 'driver'` as target — admins clicking "Take Delivery" get "Target driver not found or inactive". Same RPC on `Deliveries.tsx` works correctly because it passes the key.

### Type Drift (1)

**TYPE-1 | `AllocationSet` interface missing 9 DB columns** — Shared type has 8 fields; DB has 17 (after migration `20260315200000`). `PaymentHistory.tsx` works around this with a local interface copy.

---

## 🟡 MEDIUM (22 bugs)

### Silent Failures (7)

| ID | File | What's swallowed |
|----|------|-----------------|
| ERR-3 | SettingsPage.tsx | Settings fetch error → user could overwrite real settings with blanks |
| ERR-7 | Rebates.tsx | `Promise.all` of 3 lookup queries — all errors ignored, dropdowns empty |
| ERR-10 | PrepayWorkspace.tsx | Prepay credits + invoices fetch errors swallowed |
| ERR-11 | CustomerDetail.tsx | Purchase history queries error swallowed |
| ERR-14 | FieldDetail.tsx | Field master record fetch error swallowed |
| ERR-16 | OfflineBanner.tsx | **Sync failure silently swallowed** — driver thinks delivery saved but it wasn't |
| ERR-17 | rupCompliance.ts | **RUP compliance check silently passes when queries fail** — restricted pesticide could be sold without proper license |
| ERR-21 | QuoteBuilder.tsx | Quote number fallback count query error swallowed → duplicate numbers possible |

### Idempotency (4)

| ID | File | Issue |
|----|------|-------|
| IDEMP-6 | DeliveryDetail.tsx | `reassign_delivery` no idempotency + no loading state on "Take Delivery" buttons |
| IDEMP-9 | PurchaseOrders.tsx | Batch PO cancel loop skips `p_idempotency_key` (detail page passes it) |
| IDEMP-10 | Returns.tsx | Return creation is 3 sequential writes (number, header, items) — no transaction, no idempotency |
| IDEMP-11 | CustomerDetail.tsx | `save_customer` with `p_customer_id: null` creates duplicates on double-click |

### State Machine (4)

| ID | Entity | Issue |
|----|--------|-------|
| STATE-6 | Badge.tsx | `statusToBadgeVariant` map missing 8 statuses (invoiced, requested, approved, etc.) |
| STATE-7 | OrderDetail.tsx | Voided/cancelled invoices show yellow "warning" badge instead of red |
| STATE-8 | Reports.tsx | Marks commissions `paid` via direct `.update()`, bypassing `create_commission_payment` RPC — no audit trail |
| STATE-9 | PurchaseOrderDetail.tsx | Submit uses direct `.update()` bypassing RPC/audit pattern |

### Roles (3)

| ID | Issue |
|----|-------|
| ROLE-6 | `send-email` Edge Function is admin-only, but UI triggers emails from sales_rep (quotes, orders) and driver (deliveries) — emails silently fail |
| ROLE-7 | `save_purchase_order` RPC is admin-only, but routes allow sales_rep — form works, save crashes |
| ROLE-8 | `operational_dashboard_summary` exposes financial data to all authenticated roles |

### Type Drift (4)

| ID | Interface | Missing Fields |
|----|-----------|---------------|
| TYPE-2 | TeamNoteComment | parent_id, mentions, updated_at |
| TYPE-3 | PrepayCredit | source_type, source_reference, bucket_label |
| TYPE-4 | InvoiceItem | tote_number |
| TYPE-5 | DeliveryItem | **Phantom** `is_non_returnable` — column doesn't exist on this table |

### RPC Drift (1)

**RPC-DRIFT-002 | `batch_post_invoices`** — Has stale overload from dynamic injection migration. Works today but both versions lack `SET search_path` despite `SECURITY DEFINER`.

---

## 🟢 LOW (20 bugs)

### Silent Failures (12)
ERR-4 (Compliance.tsx customer dropdown), ERR-9 (SalesReports.tsx 4 filter fetches without `.catch()`), ERR-12 (CustomerDetail fields tab console.error only), ERR-13 (FieldDetail geometry console.error only), ERR-15 (NotificationsPanel 3 operations console.error only), ERR-18 (ProductDetail 2 `.then()` without `.catch()`), ERR-19 (PrepaymentManager 2 `.then()` without `.catch()`), ERR-20 (Dashboard `log_failed_notification` fire-and-forget), ERR-22 (3 pages customer list `.then()` without `.catch()`), ERR-23 (ManualTicketCreate products/recipes `.then()` without `.catch()`), ERR-24 (ReceivingLog summary `catch { // non-critical }`)

### Idempotency (2)
IDEMP-13 (Bulk field import loop no per-field idempotency), IDEMP-14 (`increment_customer_prepay` — DB accepts key but frontend never passes it)

### State Machine (1)
STATE-10 (VendorBills filter includes computed `overdue` mixed with DB statuses)

### Roles (2)
ROLE-9 (`cancel_order` admin-only but UI shows cancel to sales_rep), ROLE-10 (DeliveryDetail email button shown to all roles but Edge Function blocks non-admin)

### Type Drift (3)
TYPE-6 (WriteOff missing reversed_at/reversed_reason), TYPE-7 (Profile missing applicator_license_number/faa_certificate_number), TYPE-8 (OrderItem missing sort_order)

---

## Security: `SECURITY DEFINER` without `SET search_path` (7 RPCs)

These RPCs bypass RLS but don't pin `search_path`, making them vulnerable to search_path injection:
1. `batch_post_invoices`
2. `approve_return`
3. `create_invoice_from_order`
4. `get_customer_statement`
5. `link_blend_ticket_to_order`
6. `unlink_blend_ticket_from_order`
7. `create_prepay_credit`

**Fix:** Add `SET search_path = public, extensions` to each function definition.

---

## Stale Function Overloads to Drop (11)

Legacy overloads left behind by the dynamic injection migration. Should be dropped to prevent PostgREST routing surprises:

| Function | Stale Signature to DROP |
|----------|------------------------|
| reassign_delivery | (uuid, uuid, uuid) |
| batch_post_invoices | (uuid[]) |
| cancel_purchase_order | (uuid, uuid) |
| batch_adjust_inventory | (jsonb, uuid) |
| record_inventory_transfer | (uuid, uuid, text, text, uuid) |
| link_blend_ticket_to_order | (uuid, uuid) |
| unlink_blend_ticket_from_order | (uuid, uuid) |
| manual_inventory_add | (uuid, text, numeric, text, uuid) |
| release_inventory_hold | (uuid, uuid) |
| record_invoice_payment | (uuid, bigint, text, text, text, uuid) |
| void_invoice | (uuid, text, uuid) |

---

## Systemic Patterns Identified

### Pattern 1: `.then()` without `.catch()` (~15 instances)
Pages use `supabase.from(...).select(...).then(({ data }) => ...)` for dropdown population without `.catch()`. This causes unhandled promise rejections and silently empty dropdowns.

### Pattern 2: `const { data } = await supabase...` without destructuring `error` (~12 instances)
Detail pages fetch records but never check for errors. RLS denials, network failures, and query errors all look identical to "record doesn't exist."

### Pattern 3: SECURITY DEFINER RPCs without role checks (~8 instances)
When an RPC is `SECURITY DEFINER`, RLS is bypassed. The function MUST implement its own role check — but several newer RPCs forgot this.

### Pattern 4: Local interface shadows instead of updating shared types (~4 instances)
Developers added DB columns via migrations but created local interfaces in consuming components instead of updating `src/types/index.ts`. The shared types silently drift.

### Pattern 5: Frontend sends key / doesn't send key inconsistently
Some callers of the same RPC pass `p_idempotency_key` while others don't, causing PostgREST to resolve different overloads with different business logic.

---

## Combined Totals (Wave 1 + Wave 2)

| | Wave 1 | Wave 2 | Combined |
|--|--------|--------|----------|
| Critical | 3 | 6 | **9** |
| High | 7 | 17 | **24** |
| Medium | 16 | 22 | **38** |
| Low | 18 | 20 | **38** |
| Doc | 1 | 0 | **1** |
| **TOTAL** | **45** | **65** | **110** |
