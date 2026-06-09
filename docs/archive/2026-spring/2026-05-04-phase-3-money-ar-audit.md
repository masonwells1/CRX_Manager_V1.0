# Phase 3 — Money & AR Audit

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context)
**Scope:** Read-only. Money flows: invoices, posting, payments, prepay, AR aging, statements, finance charges, write-offs, month-end close, commissions, customer balances, AP / vendor bills, rebates.
**Mantra:** Every dollar must be traceable.

---

## Plain-English Summary

The money side of CRX is genuinely well-built. The single source of truth (`invoices.balance_cents` as a `GENERATED ALWAYS` column derived from `total_amount_cents − paid_amount_cents − prepay_applied_cents`) is real and respected throughout the codebase — the legacy `orders.total_paid` / `orders.balance_due` columns are dropped, and a quick scan confirms nothing in the UI reads them. Period-close enforcement runs through `check_period_open()` consistently in `post_invoice`, `post_invoice_group`, `record_invoice_payment`, and `apply_write_off`. Idempotency keys, financial audit logging, and admin-only role gates are present where they should be.

That said, this phase found **one critical, ship-blocking bug** — `reverse_write_off()` tries to UPDATE the `invoices.balance_cents` column, which is `GENERATED ALWAYS`. Postgres will refuse the update. Reversing a write-off will fail every time, and no test exercises this. That same migration also leaves several other rough edges (its idempotency-column fix uses the exact `pg_get_functiondef + replace` anti-pattern that CLAUDE.md and SAFE_DEVELOPMENT_RULES.md were written to forbid, and it omits `pg_temp` from `search_path`).

The other notable findings are softer but real: the reconciliation file checks `invoices.status === 'void'` while the actual status value is `'voided'` (so AR consistency Check 10 silently skips no rows); `PrepaymentManager` does N+1 queries against the `invoices` table on load; `ARaging` and `Reports` use the column name `total_paid` (which is *not* `orders.total_paid` — it's an RPC return-row alias — so this is a documentation worry only, not a bug); `CommissionPayments` doesn't show split percentages on the create-payment screen, so there's no way to spot a corrupt 95%-only split; `MonthEndClose` allows reopening any closed period as long as a reason is typed (no escalating warning if the period is more than one month old); and the closed-period guard does NOT run on `apply_remaining_prepayments` / `batch_apply_prepayments` — a bookkeeper could apply a prepay credit dated into a closed month.

Overall the money path is one of the strongest parts of the app. Land the `reverse_write_off` fix and the small set of P2/P3 polish items below and Phase 3 is genuinely shippable.

---

## Evidence Reviewed

| Source | Purpose |
|---|---|
| `CLAUDE.md` (Schema Gotchas, Hard Red Lines) | Rules: bigint cents, `balance_cents` GENERATED, `orders.total_paid`/`balance_due` dropped |
| `docs/workflows/SAFE_DEVELOPMENT_RULES.md` | Migration anti-patterns; idempotency column conventions |
| `docs/workflows/QUOTE_TO_DELIVERY.md` Stages 4–5 | Invoice + payment expected behaviour |
| `docs/audits/2026-05-04-phase-0-current-state-audit.md` | Baseline; flagged two payment paths with different role rules |
| `src/pages/InvoiceDetail.tsx` (1338 lines) | Post / void / write-off / record-payment / reverse-write-off |
| `src/pages/Invoices.tsx` (first 120 lines reviewed) | List + batch post + batch void |
| `src/pages/PaymentAllocation.tsx` (655 lines) | Unified `/payments` entry — auto / manual allocation |
| `src/pages/PaymentHistory.tsx` (first 150 lines) | Reads from `allocation_sets` + `invoice_line_allocations` |
| `src/pages/ARaging.tsx` (1119 lines) | Aging, statements, season comparison, AR reminders |
| `src/pages/MonthEndClose.tsx` (583 lines) | Period close + reopen + checklist |
| `src/pages/PrepaymentManager.tsx` (918 lines) | Customer prepay summaries + auto-apply |
| `src/pages/PrepayWorkspace.tsx` (465 lines) | Manual bucket → invoice allocation |
| `src/pages/CommissionPayments.tsx` (626 lines) | Create / post / void commission payments |
| `src/pages/CustomerTransactionReview.tsx` (first 80 lines) | Per-customer ledger |
| `src/pages/AccountsPayable.tsx` (first 100 lines) | AP dashboard + aging |
| `src/pages/VendorBills.tsx` (first 120 lines) + `VendorBillDetail.tsx` (first 130) + `NewVendorBill.tsx` (first 80) | AP entry |
| `src/pages/Rebates.tsx` (first 120 lines) | Rebate programs + claims |
| `src/pages/FinancialDashboard.tsx` (first 120 lines) | Top-of-funnel finance summary |
| `src/lib/reconciliation.ts` (944 lines) | Cross-entity integrity checks |
| `src/components/invoices/WriteOffModal.tsx` | Calls `apply_write_off` RPC |
| Migrations: `20260213100000_phase2_billing_architecture.sql`, `20260217200000_accounting_periods.sql`, `20260311200000_invoice_ar_single_source.sql`, `20260325200000_sprint1_fix_financial_compliance.sql`, `20260330100000_prelaunch_state_machine_and_security.sql`, `20260331100000_admin_corrections_phase1.sql`, `20260332200000_fix_idempotency_column_refs_round2.sql`, `20260430210000_field_app_workflow_phase9.sql`, `20260430260000_field_app_workflow_phase14.sql` | RPC sources |

---

## Findings

### P3-1 — `reverse_write_off()` writes to a GENERATED column → it will fail every call (CRITICAL)

**Business risk:** If a write-off is keyed in error, the admin reverses it from `InvoiceDetail` → "Reverse Write-Off". The button calls `reverse_write_off(...)`, which Postgres rejects because `invoices.balance_cents` is a `GENERATED ALWAYS` column (set up in `20260213100000_phase2_billing_architecture.sql:58` and re-confirmed in `20260305200000_audit_safety_fixes.sql:56`). The UI will display the error, the write-off stays "active", and the customer's AR balance stays understated by the write-off amount. There is **no unit or e2e test** that exercises a real reversal.

**Evidence:**
- `supabase/migrations/20260331100000_admin_corrections_phase1.sql:171-175`
  ```sql
  -- Restore invoice balance (add back what was written off)
  UPDATE invoices SET
    balance_cents = balance_cents + v_wo.amount_cents,
    updated_at    = now()
  WHERE id = v_wo.invoice_id;
  ```
- `supabase/migrations/20260213100000_phase2_billing_architecture.sql:58`
  ```sql
  balance_cents bigint GENERATED ALWAYS AS (total_amount_cents - paid_amount_cents - prepay_applied_cents) STORED,
  ```
- The later "fix" migration `20260332200000_fix_idempotency_column_refs_round2.sql:26-98` only rewrites idempotency-column names via `pg_get_functiondef + replace()`. It does **not** touch the `UPDATE invoices SET balance_cents = ...` line.
- The `apply_write_off` companion RPC (the one the UI uses to *create* the write-off) increments `write_off_cents` instead — see `20260305200000_audit_safety_fixes.sql:290`. Reversal needs to do the inverse.
- Frontend trigger: `src/pages/InvoiceDetail.tsx:521-527` (and modal at `:1275-1302`).

**Fix direction:** Replace `balance_cents = balance_cents + v_wo.amount_cents` with `write_off_cents = GREATEST(write_off_cents - v_wo.amount_cents, 0)` (and also re-derive status from `paid` back to `posted` if the write-off being reversed was what zeroed the balance). Add a `tests/integration/reverse_write_off.spec.ts` that round-trips a write-off + reverse and asserts `balance_cents` returns to the pre-write-off value.

**Likely files:** new migration in `supabase/migrations/`; possibly a follow-up to update `src/pages/InvoiceDetail.tsx` to refresh the row after success.

---

### P3-2 — Migration `20260332200000` re-uses the forbidden `pg_get_functiondef + replace()` anti-pattern (HIGH)

**Business risk:** SAFE_DEVELOPMENT_RULES.md and CLAUDE.md both explicitly call out `pg_get_functiondef() + regex injection` as the cause of the March 2026 "40+ bug" crisis. The cure migration that landed only a few days later then **reuses that exact technique** to fix idempotency column names in 10 different RPCs. This wallpapers over the symptom but reintroduces the root-cause risk: if Postgres ever changes its `pg_get_functiondef` formatting, the regex misses, the function is silently left with the wrong column names, and the bug returns invisibly.

**Evidence:**
- `supabase/migrations/20260332200000_fix_idempotency_column_refs_round2.sql:23-98` — the `DO $$` block scrapes 10 functions via `pg_get_functiondef`, runs `replace()` on the body, then `EXECUTE`s the result.
- `docs/workflows/SAFE_DEVELOPMENT_RULES.md:101` lists this exact pattern as the #1 anti-pattern.
- CLAUDE.md "Migration Anti-Patterns (NEVER Do These)" repeats the rule.

**Fix direction:** Replace the existing migration approach with explicit `CREATE OR REPLACE FUNCTION` rewrites for each of the 10 RPCs (named in the array at lines 28–38). This is more lines of SQL, but it's audit-able and not silently regexed. Same goes for the `save_quote` block at lines 106–148.

**Likely files:** a new migration that explicitly redefines `reopen_accounting_period`, `reverse_write_off`, `void_delivery`, `void_commission_payment`, `revert_quote_status`, `restore_cancelled_order`, `restore_cancelled_delivery`, `unapply_credit_memo`, `reverse_blend_ticket_approval`, and `save_quote` from scratch.

---

### P3-3 — `reopen_accounting_period` and `reverse_write_off` missing `pg_temp` in `search_path` (MEDIUM)

**Business risk:** Every `SECURITY DEFINER` function must include `pg_temp` in `SET search_path` so other `SECURITY DEFINER` callers can't inject objects via the temp schema. Both these RPCs ship with `SET search_path = public` only.

**Evidence:**
- `supabase/migrations/20260331100000_admin_corrections_phase1.sql:22` — `SET search_path = public` (reopen)
- `supabase/migrations/20260331100000_admin_corrections_phase1.sql:124` — same (reverse_write_off)
- Compare with the `post_invoice_group` rewrite which gets it right: `supabase/migrations/20260430210000_field_app_workflow_phase9.sql:915` → `SET search_path = public, pg_temp`
- Rule: `CLAUDE.md` "Migration Safety Rules" → "Every `SECURITY DEFINER` function MUST have `SET search_path = public, pg_temp`"

**Fix direction:** Bundled with the P3-2 rewrite. Add `pg_temp`.

**Likely files:** Same migration as P3-2.

---

### P3-4 — Closed-period guard does NOT run on prepay application paths (HIGH)

**Business risk:** `apply_remaining_prepayments` and `batch_apply_prepayments` create `prepay_applications` rows and decrement `prepay_credits.balance_cents` while incrementing `invoices.prepay_applied_cents` (which feeds the GENERATED `balance_cents`). They do NOT call `check_period_open(<application_date>)`. So an admin who applies a prepay on, say, May 4 against a posted invoice that is dated April 28 — and April is a closed period — will succeed in adjusting AR for the closed period without going through `reopen_accounting_period`. The financial_audit_log trail will show it, but the period-close lock that month-end depends on is bypassed.

**Evidence:**
- `MonthEndClose.tsx:447` UI promise: *"This period has been closed. No new postings can be made to dates within this period."*
- Frontend confirmation copy at `MonthEndClose.tsx:567-570`: *"After closing, no invoices can be posted or payments recorded for dates within this period."*
- `PrepaymentManager.tsx:329-332` calls `apply_remaining_prepayments`; `PrepayWorkspace.tsx:197-201` calls `batch_apply_prepayments`. Neither RPC accepts an "application date" param, and neither passes one to a period check.
- Compare with `post_invoice` in `20260325200000_sprint1_fix_financial_compliance.sql:457` which does call `PERFORM check_period_open(v_inv.invoice_date)`.

**Fix direction:** In both `apply_remaining_prepayments` and `batch_apply_prepayments`, before mutating `prepay_applied_cents`, `PERFORM check_period_open(v_invoice.invoice_date)` for each invoice being touched. If any invoice's date is in a closed period, raise and roll back.

**Likely files:** new migration touching `apply_remaining_prepayments` and `batch_apply_prepayments`.

---

### P3-5 — `reconciliation.ts` Check 10 uses wrong status value (`'void'` vs `'voided'`) (MEDIUM)

**Business risk:** `checkCustomerARConsistency()` skips invoices via `if (inv.status === 'void') continue;` — but the actual status value is `'voided'` (per CLAUDE.md status lifecycle and `Invoices.tsx:33,52`). The check therefore inspects every voided invoice for `balance_cents IS NULL`. In practice voided invoices keep numeric balances so the check still mostly passes, but the count of "entitiesChecked" includes voided invoices and any voided invoice with NULL balance would falsely show as a discrepancy.

**Evidence:**
- `src/lib/reconciliation.ts:584` → `if (inv.status === 'void') continue;`
- `src/lib/reconciliation.ts:925` → also filters `arInvoices.filter((i) => i.status !== 'void')` (same bug; same mistake repeated)
- Real status values: `Invoices.tsx:33` (`voided: { variant: 'error', label: 'Voided' }`)
- CLAUDE.md Invoice lifecycle: `draft → unposted → posted → paid → overdue → voided → cancelled`

**Fix direction:** Replace both occurrences of `'void'` with `'voided'`. Add a unit test.

**Likely files:** `src/lib/reconciliation.ts` lines 584 and 925; companion test in `src/lib/reconciliation.test.ts` if one exists.

---

### P3-6 — `PrepaymentManager` does N+1 queries on every page load (MEDIUM)

**Business risk:** For every customer with a prepay balance the page issues a separate `SELECT id, balance_cents FROM invoices WHERE customer_id = c.id AND status='posted' AND balance_cents > 0`. With ~60 customers carrying prepay credit at peak season this is 60 round trips on top of the initial customer query before the page renders. Mason has reported "this page is slow" in older sessions; this is the cause.

**Evidence:**
- `src/pages/PrepaymentManager.tsx:111-128` — `for (const c of (custData || []) ...) { const { data: invData } = await supabase.from('invoices').select(...).eq('customer_id', c.id) ... }`
- Same pattern (one-by-one fetch) used at `CommissionPayments.tsx:99-110` for item counts on commission payments — minor, but worth noting.

**Fix direction:** Replace with a single RPC `get_prepayment_dashboard()` that returns one row per customer with prepay balance, joined to invoices in SQL (or use a Postgres function with `LATERAL`). Cuts page load to one round trip.

**Likely files:** new migration adding the RPC; rewrite of `PrepaymentManager.tsx:92-132`.

---

### P3-7 — Reopen-period flow has no warning gradient based on age of the closed period (MEDIUM)

**Business risk:** The reopen modal at `MonthEndClose.tsx:522-558` requires an admin to type a reason but applies the *same* warning copy whether they're reopening last month's close (likely a legitimate correction) or the close from 8 months ago (which probably means the books were already wrong everywhere downstream — financial reports, sales-rep commission already paid, statements already sent, year-end summaries already mailed). For a beginner owner this matters: there is no "you are about to reopen a period that is already 8 months in the past — this will affect 5 prior month-end closes" guard.

**Evidence:**
- `src/pages/MonthEndClose.tsx:522-558` — the modal has identical copy regardless of `reopenTarget.period_end`.
- `supabase/migrations/20260331100000_admin_corrections_phase1.sql:62-68` — server allows reopen of any closed period unconditionally.

**Fix direction:** Modal: derive `monthsSinceClose` from `reopenTarget.period_end`. If `> 1` show a stronger banner ("This period was closed N months ago. Reopening it can change reports that were already generated and statements that were already sent. Are you sure?"). If `> 6` require typing the literal period label (`May 2025`) to confirm. Server: optionally raise an exception if more than 12 months back without an `p_force = true` flag.

**Likely files:** `src/pages/MonthEndClose.tsx`, new migration for `reopen_accounting_period`.

---

### P3-8 — Commission "Create Payment" screen does not show split-percentage info (MEDIUM)

**Business risk:** `CommissionPayments.tsx` lets the admin pick checkboxes for unpaid commissions and creates a payment per recipient. Each commission row shows only `commission_amount` (a dollar number). It does NOT show the underlying `split_percentage` or the order's other recipients on the same order. So if a commission was created with a corrupt split (say recipient A = 95%, recipient B = 0% because the JSON didn't sum to 100%), there is no signal to the admin paying it. CLAUDE.md says `save_customer()` validates splits sum to 100%, so corrupt rows shouldn't exist — but the reconciliation `Commission Splits` check (`reconciliation.ts:325-351`) is the only after-the-fact catch, and that runs only when an admin opens Integrity Report.

**Evidence:**
- `src/pages/CommissionPayments.tsx:531-549` — commission list UI (no split %, no co-recipient).
- `src/lib/reconciliation.ts:325-351` — split-sum check exists, but it lives in IntegrityReport.

**Fix direction:** Show `split_percentage` next to each commission row in the create-payment modal. If a commission belongs to an order whose splits don't sum to 100, show a red banner (or refuse to include it) at the top of the modal. Cheap to implement.

**Likely files:** `src/pages/CommissionPayments.tsx`.

---

### P3-9 — `void_invoice` reverses payment allocations but the UI has no preview of the impact (MEDIUM)

**Business risk:** The void modal at `InvoiceDetail.tsx:1218-1238` reads *"This will void invoice INV-XYZ and reverse any balance impact. This action cannot be easily undone."* — but does NOT show the admin: (a) how many payment allocations will be reversed, (b) whether prepay credits will be restored, (c) whether the customer's AR will swing positive/negative as a result. The migration body of `void_invoice` (in `20260311200000_invoice_ar_single_source.sql:392+`) does the right work — it reverses allocations and restores prepay — but the user-facing dialog has no preview of that work.

**Evidence:**
- `src/pages/InvoiceDetail.tsx:1218-1238` — void modal.
- `supabase/migrations/20260311200000_invoice_ar_single_source.sql:392-420` — the actual reversal logic includes adjusting `paid_amount_cents` and `prepay_applied_cents`.

**Fix direction:** Add a `preview_void_invoice(p_invoice_id)` RPC that returns `{ allocations_to_reverse, prepay_to_restore, customer_balance_after }`. Show that summary in the modal before the admin clicks confirm.

**Likely files:** new migration for the preview RPC; `src/pages/InvoiceDetail.tsx`.

---

### P3-10 — Two payment paths with inconsistent role + idempotency rules (MEDIUM)

**Business risk:** Phase 0 already flagged this; Phase 3 confirms it. There are two ways to record a payment:
1. **`/payments` (PaymentAllocation.tsx)** — admin OR sales_rep (route allow-list `App.tsx:166-209`); calls `allocate_payment` (which itself enforces `admin OR sales_rep` server-side, see `20260430260000_field_app_workflow_phase14.sql:64-69`).
2. **InvoiceDetail.tsx "Record Payment" button** — admin only (`isAdmin` gate at `InvoiceDetail.tsx:773-794`); calls `record_invoice_payment`.

Both eventually adjust `invoices.paid_amount_cents`, but one creates an `allocation_set` (auditable, voidable from PaymentHistory) and the other writes to `payments` directly. Sales reps using `/payments` get full payment-history voiding ability; admins clicking Record Payment from an invoice get a simpler row that's harder to fully reverse.

**Evidence:**
- `src/App.tsx:166-209` — `/payments` allowed for admin + sales_rep.
- `src/pages/InvoiceDetail.tsx:493-501` — `record_invoice_payment` call.
- `src/pages/PaymentAllocation.tsx:274-283` — `allocate_payment` call.
- `src/pages/PaymentHistory.tsx:142-158` — `void_payment` works against `allocation_sets` only.

**Fix direction:** Decide on one source of truth. Recommended: keep the unified `/payments` page; in `InvoiceDetail`, replace the "Record Payment" modal with a `Navigate` to `/payments?customer={customer_id}&invoice={invoice_id}&amount={balance_cents}` and let the unified page handle it. That collapses the two paths into one and makes everything voidable from PaymentHistory.

**Likely files:** `src/pages/InvoiceDetail.tsx`, `src/pages/PaymentAllocation.tsx`.

---

### P3-11 — `record_invoice_payment` payments don't appear in PaymentHistory (RELATED to P3-10) (MEDIUM)

**Business risk:** Following from P3-10: `PaymentHistory.tsx:69-93` queries `allocation_sets` only. Payments recorded via the InvoiceDetail "Record Payment" button never create an `allocation_set` (see `record_invoice_payment` in `20260318400000_fix_record_invoice_payment_use_payments_table.sql`), so they're invisible from PaymentHistory. The bookkeeper can't void or audit them from the centralized history page; the only trace is the `payments` table and the `financial_audit_log`.

**Evidence:**
- `src/pages/PaymentHistory.tsx:69-93` — fetches `allocation_sets` only.
- Migration name confirms behaviour: `20260318400000_fix_record_invoice_payment_use_payments_table.sql`.

**Fix direction:** Same fix as P3-10 collapses both paths and makes everything land in `allocation_sets`.

---

### P3-12 — `apply_remaining_prepayments` confirmation copy doesn't tell the admin which invoices will be touched (LOW)

**Business risk:** The "Apply Prepayments" modal at `PrepaymentManager.tsx:768-800` says only that credits will apply to "their oldest unpaid invoices". It doesn't list which invoices, in what order, with what amounts. PrepayWorkspace gets this right (it stages allocations and shows them), but the quick-apply path on PrepaymentManager is opaque. For a single-customer click, this is OK; for the **Apply All** batch (which can affect dozens of customers in one click — see modal at `PrepaymentManager.tsx:738-766`) it's a leap of faith.

**Evidence:**
- `src/pages/PrepaymentManager.tsx:768-800` (per-customer) and `:738-766` (Apply All).
- Compare with `PrepayWorkspace.tsx:376-391` — staging banner with allocation count and total.

**Fix direction:** Before confirming, fetch a "preview" via a new RPC `preview_apply_remaining_prepayments(p_customer_id)` returning the planned allocation list. Render in the modal.

**Likely files:** new migration for the preview RPC; `src/pages/PrepaymentManager.tsx`.

---

### P3-13 — AR Reminder dedup key uses today's date but no per-org tenant scope (LOW)

**Business risk:** `ARaging.tsx:555` builds the email idempotency key as `ar-reminder-${customer_id}-${reminderLevel}-${localToday()}`. Plus the dedup table check at `:492-498` keys on `(customer_id, reminder_level, sent_date)`. If a sales rep accidentally clicks "Send AR Reminders" on the same day twice it correctly dedupes. But `localToday()` is local time — for a multi-time-zone team or a server with different TZ this could cross midnight in unexpected ways. Low risk in practice (single-owner business right now), but worth a flag.

**Evidence:**
- `src/pages/ARaging.tsx:555` — idempotency key.
- `:492-498` — `ar_reminder_tracking` lookup.

**Fix direction:** Use UTC date (or a server-side timestamp inside the RPC). Or, for now, accept and document.

---

### P3-14 — Finance-charge calculation runs from a UI button only, with no scheduled fallback (LOW)

**Business risk:** `ARaging.tsx:734-742` exposes a "Preview Finance Charges" admin button which opens `FinanceChargePreviewModal`. There is no `pg_cron` job to auto-generate finance charges on a schedule. If Mason forgets to click the button on the 1st of each month, customers with 30+ day overdue balances will not be charged interest that month — a quiet revenue leak. Acceptable trade-off if intentional, but the absence is worth confirming.

**Evidence:**
- `src/pages/ARaging.tsx:734-742` — manual entry point only.
- No `pg_cron` schedule for `calculate_finance_charges` found in the migration log (last cron-job migration referenced in CHANGELOG was for reconciliation report and prepay sweeps, not finance charges).

**Fix direction:** Confirm with Mason whether finance charges should be auto-generated on a schedule. If yes, add a `pg_cron` job that runs `calculate_finance_charges()` on the 1st of each month at 6am.

**Likely files:** new migration scheduling the cron job.

---

### P3-15 — VendorBills does not call `check_period_open` on bill date (LOW)

**Business risk:** `record_vendor_payment` (called from `VendorBillDetail.tsx:121-130`) and `create_vendor_bill` (`NewVendorBill.tsx`) do not appear to enforce `check_period_open()` against the bill date or payment date. So an admin can backdate a vendor bill into a closed accounting period. This affects AP only (not AR), but it still means the period close on the AP side is advisory, not enforced.

**Evidence:**
- `src/pages/VendorBillDetail.tsx:121-130` — no period check on `payment_date`.
- `src/pages/NewVendorBill.tsx` (first 80 lines) — no period check on `bill_date`.
- I did not search every migration that defines `record_vendor_payment` / `create_vendor_bill`; this is best confirmed by reading the latest definition. Flag for verification.

**Fix direction:** If period close should apply to AP too, add `PERFORM check_period_open(p_payment_date)` to `record_vendor_payment` and similar to `create_vendor_bill`. If AP is intentionally exempt, document that in the Month-End Close help text.

**Likely files:** migration touching the vendor RPCs, plus a copy update in `MonthEndClose.tsx`.

---

### P3-16 — `Reports.tsx` and `types/index.ts` reference `total_paid` — but it's an RPC return alias, not the dropped `orders.total_paid` (CONFIRMATION ONLY, not a bug)

**Business risk:** None — but worth recording so the next auditor doesn't double-count this. Phase 0 noted that `orders.total_paid` and `orders.balance_due` were dropped. Grep finds 5 hits in `Reports.tsx` and 4 in `types/index.ts` for `total_paid`. All of them are aliases on RPC return rows (`CustomerBalanceRow.total_paid`, `CommissionBalanceRow.total_paid`, year-end summary `total_paid_cents`), not direct reads of `orders.total_paid`. The dropped-column rule is being respected.

**Evidence:**
- `src/types/index.ts:1837` (`CustomerBalanceRow`), `:1903` (`CommissionBalanceRow`), `:2063,:2077` (year-end summary).
- `src/pages/Reports.tsx:548,557,664,673` — all refer to those RPC return objects.
- `src/pages/OrderDetail.tsx:752` — explicit comment confirms the rule: *"AR derived from invoices (single source of truth — never use order.total_paid / balance_due)"*.

**Fix direction:** None. Document in the next pass of `docs/reference/database-schema.md` that "`total_paid` exists in *RPC return shapes* but no longer in `orders`."

---

### P3-17 — `customers.prepay_balance_cents` is a denormalized counter — drift risk (LOW)

**Business risk:** `PrepaymentManager.tsx:96-102` reads `customers.prepay_balance_cents` directly. The actual source of truth is `SUM(prepay_credits.balance_cents) WHERE customer_id = X AND deleted_at IS NULL`. If any RPC writes to `prepay_credits.balance_cents` without also updating the `customers.prepay_balance_cents` rollup (or vice-versa), the dashboard will silently lie. There's no reconciliation check for this in `reconciliation.ts`.

**Evidence:**
- `src/pages/PrepaymentManager.tsx:96-102` — read of denormalized column.
- `src/lib/reconciliation.ts:609-944` — 10 checks defined, none for `customers.prepay_balance_cents` vs `SUM(prepay_credits.balance_cents)`.
- Frontend trusts the rollup at `PaymentAllocation.tsx:117-120` as well (search returns `prepay_balance_cents`).

**Fix direction:** Add Check #11 to `reconciliation.ts`: `checkPrepayBalanceRollup`. Pure function takes `customers[]` and `prepay_credits[]` and reports any mismatch > 1¢. Cheap and high-value.

**Likely files:** `src/lib/reconciliation.ts`, optional companion test.

---

### P3-18 — `MonthEndClose` checklist counts deliveries, not invoiceable deliveries (LOW)

**Business risk:** Checklist at `MonthEndClose.tsx:141-144` shows `Deliveries completed: 12/15`. The 3 not-yet-completed could be tomorrow's scheduled deliveries (perfectly fine to roll the month) or yesterday's no-show drivers (which absolutely should block the close). The current logic blocks the close until all deliveries in the period are completed regardless. That's overcautious — but it also doesn't surface *which* deliveries are blocking, so the admin has to leave the page, find them, and chase them down without a link.

**Evidence:**
- `src/pages/MonthEndClose.tsx:141-144` — `done: summary.deliveries.count === summary.deliveries.completed_count || summary.deliveries.count === 0`.

**Fix direction:** Make "Deliveries completed" expandable to show the actual blocking delivery numbers (`/deliveries/<id>` links). Optionally relax the rule to only require deliveries dated *within* the period to be completed (deliveries scheduled for the future are fine).

**Likely files:** `src/pages/MonthEndClose.tsx`.

---

### P3-19 — "All checklist items" can be checked off without genuinely reconciling payments / commissions (LOW)

**Business risk:** Mason added the M1/M2 review-confirmation checkboxes (`reviewedPayments`, `reviewedCommissions`) at `MonthEndClose.tsx:78-80`. These are pure local React state — they're never persisted, never logged, and don't actually verify anything. An admin in a hurry can tick them and roll the month without reading anything. That's the entire point of an honor-system checkbox, but if the goal was to add a real audit gate, this isn't it.

**Evidence:**
- `src/pages/MonthEndClose.tsx:78-80` (state) and `:418-431` (UI).
- Server-side `close_accounting_period` RPC doesn't receive these flags, so the close goes through without recording that they were checked.

**Fix direction:** Either (a) accept that these are honor-system reminders (current behaviour, harmless) and document them as such in `MonthEndClose.tsx` comments — or (b) make the close RPC accept `p_reviewed_payments boolean, p_reviewed_commissions boolean` and write them to `accounting_periods` for audit. (b) is the right answer if any external auditor will ever ask "did you review payments before closing May 2025?".

**Likely files:** `src/pages/MonthEndClose.tsx`, migration for `close_accounting_period`.

---

### P3-20 — `apply_write_off` modal does not handle closed-period error gracefully (POLISH)

**Business risk:** Tiny user-experience nit. If an admin tries to write off a balance against a posted invoice whose `invoice_date` is in a closed period, the server's `check_period_open()` raises and the toast just says "period is closed" with no explanation of what to do (close was rolled, period needs reopening). For a beginner this is confusing.

**Evidence:**
- `src/components/invoices/WriteOffModal.tsx:46-77` — generic catch.

**Fix direction:** Trap the specific error code/message and render a banner: "Invoice INV-123 is dated April 2026, which is closed. Reopen the period from Month-End Close before writing off this invoice."

---

## What's Already Working

These should NOT be undone in subsequent phases — they are the load-bearing money-safety machinery:

1. **`balance_cents` is GENERATED ALWAYS** (`20260213100000_phase2_billing_architecture.sql:58`). No code can set it directly; the formula `total - paid - prepay` always holds. (Modulo the `reverse_write_off` bug in P3-1, which crashes rather than corrupts.)
2. **`check_period_open()` is wired** into `post_invoice` (`20260325200000_sprint1_fix_financial_compliance.sql:457`), `post_invoice_group` (`20260430210000_field_app_workflow_phase9.sql:958`), `record_invoice_payment` (multiple migrations), and `apply_write_off` (per `20260305200000_audit_safety_fixes.sql`).
3. **`allocate_payment` strict actor check** (`20260430260000_field_app_workflow_phase14.sql:48-69`) — Phase 14 closed the actor-spoofing vector. `p_performed_by` MUST equal `auth.uid()`. This is the right pattern.
4. **`post_invoice_group` is properly atomic** (`20260430210000_field_app_workflow_phase9.sql:907-988`) — pre-flights status + period check on every member, then posts in one loop, with a single idempotency cache record.
5. **PaymentAllocation auto-allocate** (`PaymentAllocation.tsx:45-62`) is a pure function (`autoAllocate`), exported and unit-testable — and the page validates `over-allocation`, `exceeds invoice balance`, and `100% prepay → confirm modal` at `:238-259`.
6. **`reconciliation.ts` is genuinely thorough** (10 cross-entity checks, all pure-function-testable). Wires into Integrity Report. Catches commission split drift, invoice payment drift, GENERATED-column sanity. Just needs the Check 10 status string fix (P3-5) and the new prepay-rollup check (P3-17).
7. **`PrepayWorkspace` correctly stages allocations and runs them as one atomic batch via `batch_apply_prepayments`** (`PrepayWorkspace.tsx:192-214`). Pure UX win — bookkeeper sees what they're about to commit.
8. **Statement, year-end summary, and AR reminder emails all carry idempotency keys** (`ARaging.tsx:555`, `MonthEndClose.tsx`, etc.). Customers can't get duplicate dunning emails on the same day.
9. **Bigint cents is universal** in the money modules — no `parseFloat` for currency, every formatter goes through `(cents / 100)`.
10. **Append-only `financial_audit_log`** is the audit substrate — every write-off, reverse, period close, void, payment touches it.

---

## Open Questions for Mason

These are decisions only the owner can make. List them here so the next implementation pass doesn't guess:

1. **Reopening a closed period** — do you want a hard cap (e.g. cannot reopen anything older than 12 months without a developer override) or just a stronger warning gradient as the period gets older? See P3-7. My instinct: warn at >1 month, require typed period label at >6 months, hard-block at >12 months unless `--force` from a developer.
2. **Prepay credit on closed periods** — should `apply_remaining_prepayments` block applying credits to invoices in a closed period (P3-4)? My instinct: yes, blocked unless the period is reopened.
3. **Auto-apply prepay vs require admin click** — currently prepay credits do NOT auto-apply when an invoice is created. Bookkeeper must visit PrepaymentManager → Apply All. Some shops want this automatic on invoice posting; some hate it. Which do you want?
4. **AR reminder cadence** — `ARaging.tsx:489` triggers reminders at 30 / 60 / 90 day buckets. Does that match what you want, or do you want different thresholds, or auto-send weekly?
5. **Finance charges** — should they generate automatically on the 1st of each month, or stay manual (current state, P3-14)?
6. **Vendor bill / AP and accounting period** — does month-end close apply to AP too (P3-15), or are AP entries always free to backdate?
7. **Two payment paths** (P3-10/P3-11) — OK with collapsing the InvoiceDetail "Record Payment" button into a redirect to `/payments?invoice=<id>`?
8. **Honor-system M1/M2 checkboxes** (P3-19) — are these for your own conscience (current behaviour fine), or for an external auditor (then they need to be persisted)?

---

## Recommended Fix Order Within Phase 3

| # | Finding | Why first | Effort |
|---|---|---|---|
| 1 | **P3-1** — `reverse_write_off` UPDATE on GENERATED column | Correctness bug. Reversal is silently broken right now. | Small migration |
| 2 | **P3-3** — add `pg_temp` to `reopen_accounting_period` & `reverse_write_off` | Bundle with P3-1 — same migration | Trivial |
| 3 | **P3-2** — replace `pg_get_functiondef + replace()` migration with explicit rewrites | Removes a class of future drift. Stops the MARCH-2026 pattern from re-rotting in the codebase. | Medium migration (10 RPC bodies, but each short) |
| 4 | **P3-4** — `check_period_open` on prepay application paths | Closes the only remaining period-bypass route in the AR side. | Small migration |
| 5 | **P3-5** — `'void'` → `'voided'` in `reconciliation.ts` | Cheap correctness fix; affects Integrity Report accuracy. | 2 lines |
| 6 | **P3-17** — add reconciliation Check #11 for `customers.prepay_balance_cents` rollup | Same file; while you're in there. | Small |
| 7 | **P3-10 + P3-11** — collapse to one payment path | UX consolidation, removes a class of "where did that payment go?" questions. | Medium UI rewrite |
| 8 | **P3-7** — escalating reopen-period warning | UX safety net for the most dangerous admin action. | UI only |
| 9 | **P3-8** — show split % on commission payment screen | Cheap UX, prevents a class of "why did Bob get 95%?" questions. | UI only |
| 10 | **P3-9** — preview void invoice impact | UX safety net for void. | RPC + UI |
| 11 | **P3-12** — preview prepay batch apply | UX safety net for batch apply. | RPC + UI |
| 12 | **P3-6** — fix N+1 in PrepaymentManager | Performance. Visible benefit, low risk. | RPC + UI rewrite |
| 13 | **P3-15** — confirm AP period-close policy with Mason | Decision-gated. Possibly no work. | Decision |
| 14 | **P3-14** — schedule finance charge cron if Mason wants auto-charge | Decision-gated. | Migration if yes |
| 15 | **P3-18 / P3-19 / P3-20** — checklist polish | Pure UX polish. Can wait. | Small |
| 16 | **P3-13** — UTC date in AR reminder dedup key | Theoretical only at single-TZ scale. Last. | Trivial |

**Phase exit criteria:** items 1–6 land before Phase 4 starts. Items 7–12 are stretch goals for Phase 3, fair game to defer to a polish sprint after Phase 8. Items 13–16 are decisions or polish that can flow into the standing OPEN_ITEMS backlog.

---

*End of Phase 3. Phase 4 (Inventory & Purchasing) follows as a separate file.*
