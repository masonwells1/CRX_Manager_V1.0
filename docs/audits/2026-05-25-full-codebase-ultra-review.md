# Full-Codebase Ultra Review — CRX Manager V1.0

**Date:** 2026-05-25
**Mode:** Report-only. **No code, migrations, schema, or deployments were changed during this review.**
**Method:** 10 risk domains, each audited at full depth by an independent adversarial agent (2 waves of 5), then consolidated. P0/P1 claims were independently re-verified by the orchestrator against the **live database** (`rhyzpcqhnizqbxphqdkr`) using read-only SQL.
**Scope:** entire repo (`src/`, `supabase/migrations/` ×353, `supabase/functions/` ×7+`_shared`, `docs/`). `node_modules/` and `.claude/worktrees/` excluded.

---

## Executive Summary

The codebase is, on the whole, **well-engineered and well-defended** — and most of the scariest *candidate* bugs turned out to be already fixed and verified live (see "Confirmed-Fixed Regressions"). Money/AR math, the quote→delivery→invoice state machines, inventory ledger immutability, and RLS *table* coverage (100% of 95 tables) are all genuinely solid.

**However, there is one production-blocking P0 and a cluster of P1s.** The headline: a perfect-looking RLS matrix is masking a wide-open RPC surface, because `SECURITY DEFINER` functions bypass RLS and dozens of them are callable by the unauthenticated `anon` role with no `auth.uid()` check.

**Verdict: HOLD — do not deploy further until RLS-1 is remediated. Fix the 6 P1s before the next functional release.**

### Recommended fix order
1. **RLS-1 + RLS-2 (P0/P1) — deploy blocker.** Broadly `REVOKE EXECUTE` on mutating `SECURITY DEFINER` functions from `anon`/`PUBLIC`; add `auth.uid()` actor binding to every mutating RPC that lacks it (start with `apply_write_off`, `issue_return_credit`, `void_order`); `REVOKE` table-level DML from `anon`. Add a CI guard.
2. **EDGE-2 + EDGE-1 (P1).** Redeploy `reset-user-password` from current source (restores the missing `entity_recipient` gate) and refactor its CORS to the fail-loud pattern.
3. **COMM-2 + COMM-1 (P1).** Add server-side commission-split validation in `save_customer`; fix split rounding so per-recipient amounts reconcile to the order total.
4. **MIG-1 (P1).** Consolidate `next_invoice_number` to a single function and unify the three coexisting invoice-numbering strategies.
5. **P2 cluster.** Honor-the-key sprint (IDEM-1/2), CSV formula-injection escape (RPT-1), `assertRpcResult` gap (FE-1), stranded-commission path (COMM-3).
6. **P3 / doc drift.** DOC-1…4, misc cleanup.

### Severity tally
| Severity | Count | IDs |
|---|---|---|
| **P0** | 1 | RLS-1 |
| **P1** | 6 | RLS-2, COMM-1, COMM-2, EDGE-1, EDGE-2, MIG-1 |
| **P2** | 6 | COMM-3, IDEM-1, IDEM-2, FE-1, RPT-1, MIG-2/3 |
| **P3** | 9 | PIPE-2, EDGE-3, FE-2, IDEM-3, MONEY-1*, DOC-1, DOC-2, DOC-3, DOC-4, RPT-4 |
| **INFO** | many | incl. INV-1 (non-issue, live-clean), EDGE-4, EDGE-5, FE-3, DOC-5…8, etc. |

\* MONEY-1 is INFO/P3 (dead code).

### Per-domain verdict
| # | Domain | Verdict | Worst finding |
|---|---|---|---|
| 1 | Money & AR core | ✅ Clean | INFO/P3 only |
| 2 | Commissions & payouts | ⚠️ 2× P1 | COMM-2 (no server-side split validation) |
| 3 | Pipeline & holds | ✅ Pass | P3 (blank signature) — **holds P0 candidate fixed** |
| 4 | Inventory & purchasing | ✅ Clean | INFO only (INV-1 is live-clean) |
| 5 | RLS & permissions | 🟥 **P0** | RLS-1 (anon-executable mutating RPCs) |
| 6 | Idempotency & concurrency | ⚠️ P2 cluster | IDEM-2 (duplicate finance charges) — **3 prior findings fixed** |
| 7 | Migration safety & drift | ⚠️ P1 | MIG-1 (`next_invoice_number` overload) — **pg_temp sweep verified complete** |
| 8 | Edge functions & secrets | ⚠️ 2× P1 | EDGE-2 (deployed-vs-source security drift) |
| 9 | Frontend integrity | ✅ Pass + 1 P2 | FE-1 (assert gap in Promise.all) |
| 10 | Reports/PDFs & doc drift | ⚠️ P2 | RPT-1 (CSV formula injection) |

---

## P0 — Block deploy

### RLS-1 · P0 · Unauthenticated `anon` can invoke RLS-bypassing mutating RPCs that have no actor check (LIVE-CONFIRMED)
**DB objects:** `public.apply_write_off`, `public.issue_return_credit`, `public.void_order` (and a broad class). Precedent fix: `supabase/migrations/20260513060000_revoke_anon_on_new_security_definer_fns.sql`.

**Live verification (read-only, 2026-05-25):**
- `apply_write_off(p_invoice_id, p_amount_cents, p_reason, p_performed_by, p_idempotency_key)` → `anon_can_exec = true`, `refs_auth_uid = false`, `security_definer = true`.
- `issue_return_credit(p_return_id, p_actor_id, p_idempotency_key)` → `anon_can_exec = true`, `refs_auth_uid = false`.
- `void_order(p_order_id, p_performed_by, p_reason, p_idempotency_key)` → `anon_can_exec = true`, `refs_auth_uid = false` (validates the **client-supplied** `p_performed_by` against `profiles`, which is spoofable with any leaked admin UUID).
- Aggregate: **223** SECURITY DEFINER functions; **215** are `anon`-EXECUTE; **106** never reference `auth.uid()` (the RLS agent identified ~49 of those as data-mutating).
- Control group (correctly gated, reject anon): `post_invoice`, `void_invoice`, `allocate_payment`, `close_accounting_period`, `save_customer`, `create_quick_delivery` all `refs_auth_uid = true`.

**Why it's a P0.** `SECURITY DEFINER` runs as the table owner and **bypasses RLS entirely**, so the per-table policy layer (which is otherwise excellent — 100% coverage) provides *zero* protection for these calls. The authorization boundary is the `auth.uid()` check *inside* each function — and it is absent. The Supabase `anon` API key is, by design, embedded in the deployed frontend bundle, so it is trivially extractable. An attacker (or any authenticated low-privilege user — driver/applicator) who knows or guesses an invoice UUID can `POST /rest/v1/rpc/apply_write_off` and **erase AR balance / flip an invoice to paid with no authentication**, or mint a posted negative `credit_memo` via `issue_return_credit`. This violates CLAUDE.md Hard Red Lines (admin-only financial ops; `financial_audit_log` integrity — `void_order` even stamps the spoofed actor into the audit log) and Architecture Rule 2 (RLS as the universal gate). The team clearly knows the correct pattern — `post_invoice`/`close_accounting_period` implement it, and `20260513060000` revoked anon on ~7 functions — but it was applied to a handful, not the full set.

**Proposed fix.**
1. `REVOKE EXECUTE ... FROM anon` (and `FROM PUBLIC`) on every `SECURITY DEFINER` RPC not intended for unauthenticated use — extend the `20260513060000` / `20260516040000` pattern to the full mutating set.
2. In every mutating RPC, derive the actor from `auth.uid()`, raise on `auth.uid() IS NULL`, and treat `p_performed_by`/`p_actor_id` as advisory only (`RAISE` on `IS DISTINCT FROM auth.uid()`) — the canonical strict-actor block already documented in CLAUDE.md.
3. Add a CI guard (extend `scripts/validate-sql.sh`) that fails any new `SECURITY DEFINER` mutator lacking an `auth.uid()` gate, and a live `pg_proc` audit step in `/audit`.

**Confidence: High** (live grants + bodies inspected by the orchestrator).

---

## P1 — Fix before next release

### RLS-2 · P1 · Blanket `anon` table-level DML grant on all 95 tables (LIVE-CONFIRMED, defense-in-depth)
**DB:** `information_schema.role_table_grants` shows `anon` holds `SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER` on every public table (incl. `invoices`, `payments`, `financial_audit_log`, `commissions`). This is the stock Supabase posture and is **contained today** because RLS is enabled on all tables and every policy fails for `anon` (NULL `auth.uid()`) — the prompt's two coverage queries returned `[]`. It is P1, not P0, *because RLS holds*. The risk: it removes the second layer of defense — one future `USING (true)` policy, one `TO public` slip, or one new table missing its role predicate becomes immediately anon-exploitable for read **and** write, and it compounds RLS-1's blast radius. **Fix:** `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon;`, audit `ALTER DEFAULT PRIVILEGES`. Bundle with the RLS-1 remediation. **Confidence: High.**

### COMM-2 · P1 · `save_customer()` performs ZERO server-side commission-split validation
**File:** `supabase/migrations/20260510080000_bulk_idempotency_wiring.sql:600-751`. The documented invariant ("`save_customer()` validates splits sum to 100%") **does not exist in any version** of the function. It writes `default_commission_split` JSONB raw — accepting splits summing to 70% or 250%, empty/duplicate `recipient`, negative or >100 percentages. The only sum check is client-side (`CustomerDetail.tsx:408-417`), which a direct PostgREST `rpc('save_customer', …)` bypasses (and any admin/sales_rep can call it). The `ABS(SUM(pct)-100)>0.01` guard lives only in the delivery/quick-delivery creation paths — `convert_quote_to_order` and `create_direct_order` do **not** re-validate, so an invalid split flows straight into commission generation, producing payouts that don't sum to the intended amount. **Fix:** add the sum/null/duplicate/range checks inside `save_customer` before persisting, raising a machine-readable token. **Confidence: High.**

### COMM-1 · P1 · Commission split rounding never reconciles to the order total
**Files:** `supabase/migrations/20260513100000_*.sql:51-78` (helper), `20260513020000_*.sql:46-58` (`compute_commission_amount`); evidence in `src/lib/commissionSplit.test.ts:257-274`. Each recipient's amount is rounded independently (`ROUND(profit * pct/100, 2)` per split) with **no remainder/largest-remainder reconciliation**. Two 50% splits on a $99.99 base each round to $50.00 → **$100.00 distributed, a penny more than the base**. The test file's own comment claims "the SQL side handles it with last-recipient-gets-remainder logic" — **it does not** (verified across all three helper versions). Across many split orders the firm systematically over/under-pays. **Fix:** compute splits as a set and assign the last/largest recipient `base − sum(others)`; correct the misleading test comment. **Confidence: High.**

### EDGE-2 · P1 · Deployed `reset-user-password` (v11) is missing a security gate present in source (LIVE-CONFIRMED drift)
**File:** `supabase/functions/reset-user-password/index.ts:87-106` (source) vs deployed v11. Source blocks password resets for `entity_recipient` service profiles (the non-loginable CMCTW LLC / Crop Rx Solutions commission-payee rows from `20260516090000`); the **deployed body does not contain this block at all** and goes straight to `updateUserById`. Production is running code older than the repo for a security-relevant gate — an admin (or a caller bypassing the Settings UI filter) could set a usable password on a service profile and grant it login. Bounded (requires admin auth) → P1. **Fix:** redeploy `reset-user-password` from current source. **Confidence: High** (both bodies read directly via `get_edge_function`).

### EDGE-1 · P1 · `reset-user-password` silently falls back to the prod origin (fail-loud violation)
**File:** `supabase/functions/reset-user-password/index.ts:6-19` (source **and** deployed v11). Unlike the other six functions (which call `getAllowedOrigin()` and `throw` when `ALLOWED_ORIGIN` is missing), this one hardcodes `ALLOWED_ORIGINS = ["https://croprxsolutions.app", "http://localhost:5173"]` and defaults to `ALLOWED_ORIGINS[0]` when the origin isn't matched — the exact anti-pattern the 2026-05-16 review fixed in `setup-blend-tickets-storage`, missed here. It hides deployment misconfiguration on an admin password-reset endpoint. **Fix:** replace with the shared fail-loud `getAllowedOrigin()` pattern; redeploy. **Confidence: High.**

### MIG-1 · P1 · `next_invoice_number` is the one surviving function overload (LIVE-CONFIRMED)
**DB objects:** `public.next_invoice_number()` and `public.next_invoice_number(p_invoice_type text)`. Sources: `20260213100000_phase2_billing_architecture.sql:24` (no-arg) and `20260219200000_invoice_statement_enrichment.sql:146` (text-arg). The overload-detection query (`HAVING count(*) > 1`) returns exactly one offender — every other RPC is correctly singular. Both overloads draw `INV-YYYY-NNNN` from the same `invoice_number_seq`, and no migration ever drops the no-arg version. Today the no-arg call resolves by exact match so it doesn't error, but PostgREST overload resolution is fragile — the moment the DEFAULT-arg version is the only candidate (or someone drops the no-arg), resolution silently flips bodies. The `invoices.invoice_number` column DEFAULT pins the no-arg signature, so a naive `DROP` will fail unless the DEFAULT is repointed first. **Fix:** repoint the column DEFAULT to `next_invoice_number('field_application')`, drop the no-arg overload, verify `count(*)=1`. **Confidence: High.**

---

## P2 — Medium

### MIG-2 / MIG-3 · P2 · Fragmented invoice numbering + source/live drift (LIVE-CONFIRMED; UNIQUE-backstopped)
Three uncoordinated INV-number generators coexist: `next_invoice_number()` (seq), the text-arg overload's `ELSE` branch (same seq), and an **inline `MAX(...)`-scan** in `transfer_job_to_invoice` (`20260516010000`). The inline scan computes `max+1` from existing `invoice_number` values and does **not** share state with the sequence, so concurrent use across paths can collide → spurious `UNIQUE` abort (the `invoices.invoice_number UNIQUE` constraint prevents a *silent* duplicate). Separately, the live `next_invoice_number()` body has **drifted from its latest migration** (`20260327220000` wave-4 added an advisory lock + 5-digit MAX-scan; the live body reverted to atomic `nextval` + 4-digit via a later `pg_temp` sweep). **Practical risk is lower than "dropped concurrency fix" implies** — atomic `nextval` is concurrency-safe on its own — so the real action item is *consolidation*, not "restore the lock." **Fix:** make `transfer_job_to_invoice` call `next_invoice_number('field_application')` so all INV numbers come from one sequence; ship one explicit canonical definition. **Confidence: High.**

### IDEM-1 · P2 · ~9–13 live mutating RPCs declare `p_idempotency_key` but ignore it (the 9b36cd2 regression class, recurring) (LIVE-CONFIRMED)
A live `pg_proc` scan found 13 functions whose signature has `p_idempotency_key` but whose body never references `idempotency_keys`/`check_idempotency`/`save_idempotency`. The mutating money/inventory/quote ones: `batch_apply_all_prepayments`, `batch_void_invoices`, `create_invoice_from_delivery`, `generate_finance_charges`, `generate_rup_sales_records`, `save_job`, `save_blend_ticket`, `duplicate_quote`, `create_followup_delivery`. The TS callers dutifully thread `getKey()` into the call (a unit test even asserts it), so the frontend *believes* these are deduplicated — but the server discards the key. Most have an incidental state guard that blunts simple retries; the genuinely unguarded creators are **`duplicate_quote`** and **`create_followup_delivery`** — a dropped-response retry creates a duplicate. The `idempotency-body-check.mjs` hook can't catch this because it only fires on Write/Edit of migration files, and these contracts drifted under functions defined in older migrations. **Fix:** wire canonical `check_idempotency`/`save_idempotency` into each body (mirror the `transfer_job_to_invoice` fix), or drop the parameter + TS threading where a state guard is the real mechanism. Add a live `pg_proc` audit to `/audit`. **Confidence: High.**

### IDEM-2 · P2 · `generate_finance_charges` dedup is not lock-protected → concurrent double-submit can duplicate finance charges (LIVE-CONFIRMED)
The per-customer guard `IF EXISTS (SELECT 1 FROM finance_charges WHERE customer_id=… AND period_end=p_as_of_date) THEN CONTINUE` is not under a row/advisory lock at the decision point (the advisory lock taken later guards only invoice-number allocation). Two truly concurrent invocations (fast double-click → two in-flight requests) can both pass `IF EXISTS` before either commits, then both `INSERT` → **duplicated finance charge = duplicated AR**. The `p_idempotency_key` the UI passes (and a test enforces) is the intended protection and is ignored (see IDEM-1). Sequential retries are safe, so the window is narrow → P2. **Fix:** honor `p_idempotency_key`, and/or add `UNIQUE (customer_id, period_end)` to `finance_charges`. **Confidence: High.**

### COMM-3 · P2 · Unposted commission payments can permanently strand commissions
**Files:** `src/pages/CommissionPayments.tsx:325, 395-419, 516-548`; `20260501150000_*.sql:109-117` (create-guard) vs `20260430250000_*.sql:430` (void requires `posted`). `create_commission_payment` inserts items but no longer marks commissions paid (only `post` does), and its guard rejects commissions already in a non-voided payment. But `void_commission_payment` only accepts `status='posted'`, the Void button only renders on the posted tab, and there is no delete path / no DELETE RLS policy on `commission_payments`. So an unposted payment built with the wrong commissions locks them: they can't be re-selected (guard) and the payment can't be voided (not posted) or deleted → **unpayable commissions**. **Fix:** allow void/delete of `unposted` payments and surface it in the unposted tab. **Confidence: High.**

### FE-1 · P2 · Two RLS-sensitive read RPCs used without `assertRpcResult` (guardrail blind spot)
**File:** `src/pages/CustomerDetail.tsx:271-282`. `get_ar_aging` and `get_customer_statement` are called inside a `Promise.all`, and their `.data` is consumed (`agingRes.data || []`, `txnRes.data || []`) without `assertRpcResult`. Both the ESLint rule (`require-assert-rpc-result.cjs` only inspects destructured `VariableDeclarator` inits) and the zero-baseline coverage test explicitly miss `Promise.all` array elements. On an RLS denial Supabase returns `null`, which `|| []` masks as "customer has no AR" → **customer financials silently render empty**. Read-only, so P2 not P1. **Fix:** pull each rpc into its own `const { data, error } = …` and `assertRpcResult`, or null-check `.error` before reading `.data`. **Confidence: High.**

### RPT-1 · P2 · CSV formula injection — `csvExport.ts` quotes but never neutralizes formula-leading cells
**File:** `src/lib/csvExport.ts:19-31`. Every cell is wrapped in double-quotes with embedded-quote escaping, but cells beginning with `=`, `+`, `-`, `@`, tab, or CR are not neutralized — and a leading `"` does **not** stop Excel/Sheets from evaluating a formula. User-controlled fields flow straight through (customer/farm/product names, free-text notes). This single helper backs **~40 export callsites**, so the exposure is systemic. **Fix:** prefix a leading apostrophe (or guard) when `String(value)` matches `/^[=+\-@\t\r]/`, in both the `col.format` and plain branches. **Confidence: High.**

---

## P3 / INFO — Cleanup (abbreviated)

| ID | Sev | Where | Issue / Fix |
|---|---|---|---|
| PIPE-2 | P3 | `20260510010000_*.sql:165` | `complete_delivery` accepts a blank `p_signed_by` (proof-of-receipt gate defeated by `''`). Add `IF trim(p_signed_by)='' THEN RAISE 'SIGNATURE_REQUIRED'`. |
| EDGE-3 | P3 | `create-user/index.ts:138-143` | Unchecked service-role `phone` update (silent drop). Capture `{error}` + Sentry. |
| FE-2 | P3 | `NewDelivery.tsx:238` | `logActivity({ performedBy: profile?.id ?? '' })` — empty-string actor. Guard `if (!profile) return;`. |
| IDEM-3 | P3 | `DeliveryDetail.tsx:765-778` | Offline `complete_delivery` branch doesn't `resetKey()` after enqueue. |
| MONEY-1 | INFO | `20260510020000_*.sql:117` | Dead `record_invoice_payment` bypasses the allocation ledger; unreachable (frontend uses `allocate_payment`). Drop or redirect. |
| RPT-4 | INFO | `quotePdf.ts:205` | Second `any` (`Record<number, any>`) not covered by the "only `reportPdf.ts`" exception. Whitelist or tighten. |
| DOC-1 | P3 | `CLAUDE.md` Deferred bullet | Stale: all 3 `safe_cents_qty` instances ARE now wrapped (`20260516000000/010000`, `20260517020000`). Delete bullet. |
| DOC-2 | P3 | `database-schema.md:25` | Says `total_paid/balance_due` "DEPRECATED" — they were **DROPPED** (`20260332100000`). |
| DOC-3 | P3 | `database-schema.md:1` + CLAUDE.md | Title says 95 tables; body lists 97 bullets. Reconcile to live count. |
| DOC-4 | P3 | `docs/CHANGELOG.md` | Missing entries for `20260517010000`, `20260517020000`, `20260518010000`. |
| EDGE-4 | INFO | `seed-admin` | Re-runnable (gated by prod-block + shared secret). Add "abort if any admin exists". |
| EDGE-5 | INFO | CLAUDE.md vs live | Deployed versions are NEWER than documented (send-email v13, setup-storage v15, process-blend-ticket v19 — not v11/v14/v17). Reconcile doc. |
| FE-3 | INFO | `Notifications.tsx:90` | `checkMutationResult` throws a spurious toast on "mark all read" when 0 unread. Short-circuit empty set. |
| INV-1 | **non-issue** | `release_inventory_hold` | A static read of an old migration flagged `search_path = public, extensions`. **Live verified clean**: 0/223 SECURITY DEFINER functions lack `pg_temp`; this one shows `public, pg_temp`. No action. |
| COMM-5 | INFO | `20260511060000_*.sql:45` | Sales-rep commission SELECT matches on `recipient = full_name` (name string) in addition to `recipient_user_id`; tighten to id-only. |
| Others | INFO | PIPE-1/3, INV-2/3, IDEM-4/5, MIG-4/5, DOC-5…8, MONEY-2 | Consistency/doc notes; see per-domain reports. DOC-5: `void_vendor_bill` doc is already correct (prior note was itself stale). MIG-4: 436 live applied-migration rows vs 353 files is benign historical bookkeeping. |

---

## Confirmed-Fixed Regressions (the good news — verified, not assumed)

Each prior-known defect was re-checked against current/live code and confirmed resolved:

- **Phantom-inventory holds asymmetry (P0 candidate):** Holds are soft reservations — neither `create_planned_holds`/`create_inventory_hold` nor the release trigger touch `inventory.quantity_available`. The asymmetric restoration (`20260316100001`) was removed by `20260507210000`, and the **latest** redefinitions (`20260510050000`, *after* the fix) did not regress it. Declining/expiring a quote no longer inflates stock.
- **SECURITY DEFINER `search_path` missing `pg_temp` (2026-05-16 P1):** Live query — **0 of 223** SECURITY DEFINER functions lack `pg_temp`. The 5 named functions (`log_failed_notification`, `retry_failed_notifications`, `release_expired_quote_holds`, `notify_damaged_receiving`, `check_remainder_reminders`) all now show `public, pg_temp`.
- **`transfer_job_to_invoice` idempotency (2026-05-16 P1):** Live body wires `check_idempotency`/`save_idempotency`; exempt marker removed; single overload.
- **Notification RPC signature mismatch (2026-05-16 P1):** `log_failed_notification` (6 args) and `notify_damaged_receiving` (4 args) now accept `p_idempotency_key`; TS callers match.
- **`offlineSync` drop-on-`{null,null}` (2026-05-16 P1):** `offlineSync.ts:141-202` now throws on error and `assertRpcResult`s every branch — queued financial work is no longer silently dropped.
- **`send-email` durable idempotency (2026-05-16 P2):** Deployed **v13** implements the full WAL pattern (pre-send pending `email_log` insert with `UNIQUE` key, abort-on-insert-failure, post-send update). Verified live.
- **`process-blend-ticket` ignored write errors (2026-05-16 P2):** Deployed **v19** checks `{error}` on all critical service-role writes and throws for core ticket/queue writes. Verified live.
- **`setup-blend-tickets-storage` CORS fallback (2026-05-16 P3):** Resolved — fail-loud `getAllowedOrigin()` in deployed v15. *(The sibling defect survives in `reset-user-password` — EDGE-1.)*
- **`receive_po_items` wrong idempotency columns:** Superseded twice; latest (`20260430250000`) uses `save_idempotency()` with the correct `idempotency_key` column.
- **`idempotency_keys` wrong-column refs:** Live `pg_proc` scan for `key`/`entity_type`/`result_id`/`ON CONFLICT (key)` returned empty — all historical buggy versions superseded.
- **Money/AR core:** No GENERATED-column writes, no float-on-cents, period-close enforced, append-only `financial_audit_log` intact, no live references to dropped `orders.total_paid`/`balance_due`.
- **RLS table coverage:** Live — all 95 tables have RLS enabled + ≥1 policy; `profile_public_view` exposes only `id, full_name, role, is_active` (no PII); no `service_role` in the frontend.
- **Status-enum CHECK constraints:** All are supersets matching the documented lifecycles; the `'void'/'voided'` class bug is not present.
- **Frontend enforcement stack:** Banned dialogs, Sentry-import discipline, single client, `any`/`@ts-ignore`, lazy-load (66), route guards — all genuinely clean, not green-by-suppression.

---

## Methodology & Scope Limits
- 10 domains × 1 dedicated adversarial agent, dispatched in 2 parallel waves of 5; each agent traced every claim to the **latest** definition (resolved by migration timestamp), not the first match.
- P0/P1 claims were independently re-verified by the orchestrator via read-only SQL against the live DB (`rhyzpcqhnizqbxphqdkr`).
- **Not done:** full Playwright E2E run; production data inspection beyond schema/grants/function bodies; load/penetration testing. The `anon`-exploitability of RLS-1 is inferred from grants + the public anon-key design, not from an executed exploit (which would be a mutating action — out of scope for a report-only review).
- This document is the only artifact created; no source, migrations, schema, or deployments were modified.
