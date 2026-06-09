# 14-Domain Ultra Review — Supplement to `2026-05-25-full-codebase-ultra-review.md`

**Date:** 2026-05-25 (same day, later run)
**Status:** Report-only — no code/migrations/deploys changed.
**Relationship to prior report:** This run was scoped to **14 risk domains** (vs the earlier 10), adding four lanes the earlier audit did not cover: **Application Security**, **Concurrency & races**, **Date/time & timezone**, **Referential integrity & orphans**. This document is a *supplement* — read the earlier `2026-05-25-full-codebase-ultra-review.md` first; this one builds on it.

**Plan + reusable master prompt:** `C:\Users\mason\.claude\plans\i-want-a-full-synchronous-ocean.md`

---

## Why a second run

The earlier same-day audit covered Money, Commissions, Pipeline, Inventory, RLS, Idempotency, Migrations, Edge Functions, Frontend, and Reports/Docs. It found a real P0 (RLS-1 — anon-executable mutating RPCs) and 6 P1s.

Mason then asked: *"what else can we audit that this didn't?"* — and selected four additions to fold into the run:

1. **Application security** beyond RLS (XSS sinks, file uploads, storage buckets, secrets, CSV formula injection at the bucket level, npm CVEs).
2. **Concurrency** for *distinct* concurrent edits (not just idempotency double-submit).
3. **Date/time & timezone** correctness (the codebase straddles UTC DB and Central business hours).
4. **Referential integrity & orphans** across all 95 tables (FK coverage, dangling references, cascade behavior, soft-vs-hard delete consistency).

This supplement reports findings from those four domains and from the re-runs of the original ten, plus a few corroborations and corrections vs the earlier report.

---

## Corroboration — where the two runs agree

This is signal-strengthening, not duplication. When two independent agents from different angles find the same thing, confidence is high.

| Finding (this run / earlier run) | Verdict |
|---|---|
| **Mine D5-01 + D7-02** ↔ earlier **RLS-1** (anon-executable mutating SECDEF RPCs, ~215 functions, ~106 without `auth.uid()`) | Independently confirmed P0 — the biggest single attack surface |
| **Mine D1-01 / D1-02** ↔ earlier audit confirmed period-close on void-side reversals (paths gated forward, ungated on reversal) | Confirmed |
| **Mine D7-01 / D12-03** ↔ earlier **MIG-1** (`next_invoice_number` overload) | Confirmed |
| **Mine D6-01..D6-05** ↔ earlier **IDEM-1** (RPCs declare `p_idempotency_key`, body ignores) | Confirmed — both agents identified the same ~9–13 offenders |
| **Mine D8-01** ↔ earlier **EDGE-2** (deployed `reset-user-password` v11 missing `entity_recipient` block) | Confirmed |
| **Mine D11-04** ↔ earlier **RPT-1** (CSV formula injection) | Partial overlap — see Correction below |
| **Mine D10-01..D10-03** ↔ earlier **DOC-1..DOC-3** (doc count drift) | Confirmed |
| **Money/AR core integrity** verified clean by both runs (`balance_cents` GENERATED, audit log immutable, prepay immutable, money concurrency safe, cents discipline) | Confirmed |

---

## Findings the earlier audit caught that this run missed (honest correction)

These belong in any remediation plan — they're real and were not flagged by my agents:

- **COMM-1 (P1) — Commission split rounding never reconciles.** Each recipient's amount is rounded independently with no remainder reconciliation. Two 50% splits on a $99.99 base each round to $50.00 → **$100.00 distributed, a penny more than base**. My commissions agent found 9 other things but missed this specific rounding bug. **Add to fix list.**
- **COMM-3 (P2) — Unposted commission payments strand commissions.** `create_commission_payment` reserves commissions; `void_commission_payment` only accepts `posted` status; no delete path → unposted payments built with the wrong commissions lock them permanently.
- **PIPE-2 (P3) — `complete_delivery` accepts blank `p_signed_by`.** Defeats the proof-of-receipt gate via `''`.
- **EDGE-1 (P1) — `reset-user-password` silent-fallback CORS** (vs the other 6 functions' fail-loud pattern).

Disagreement worth noting:

- **RPT-1 vs my D11 verified-clean:** The earlier report flagged CSV formula injection in `csvExport.ts` as P2. My AppSec agent explicitly verified that `src/lib/csvExport.ts` *does* have a `FORMULA_LEADING_CHAR` regex (matching `/^[=+\-@\t\r]/`) at line 3, prefixing matching cells with `'`. **Recommend re-verifying** which version of `csvExport.ts` was reviewed by each agent before deciding whether RPT-1 is still open. (My agent reads `csvExport.ts:5-8`; earlier report references `:19-31`.)

---

## New findings from the 4 added domains

### Domain 11 — Application security (NEW)

> Earlier run did not cover bucket configs, upload validation, raw-HTML sinks, customer-email HTML injection, npm audit, dynamic SQL injection.

| ID | Sev | Location | Summary |
|---|---|---|---|
| **D11-01** | 🟧 HIGH | `delivery-photos`, `team-note-attachments`, `receiving-photos` buckets | Public buckets accept arbitrary files from any authenticated user — no `allowed_mime_types`, no `file_size_limit`. INSERT policies check only `bucket_id`. A driver can upload HTML/SVG with inline script and `NoteAttachments.tsx:100` opens it in a new tab on the `supabase.co` origin → XSS / phishing host vector. |
| **D11-02** | 🟧 HIGH | `delivery-signatures` policy + `DeliveryDetail.tsx:798-801` | Bucket policy has no path scoping; client uses `upsert: true`. **Any authenticated user can overwrite any delivery's signature** by `POST`ing `signatures/<delivery-id>.png` with their JWT. Signature-of-record fraud vector for COD/credit disputes. |
| **D11-03** | 🟨 MEDIUM | `DeliveryDetail.tsx:874-885,905,962-976` | Customer-facing delivery emails build HTML by string-concatenating user-controlled values (`signed_by`, photo captions, product names) — no escaping. Real Resend delivery to customer inboxes. Phishing-CTA injection vector. Same in 952-1010 (resend path). |
| **D11-04** | 🟨 MEDIUM | `BulkTicketUpload.tsx:60-74,165-167`; `imageCompression.ts:21-23` | Client-side MIME check is bypassable (`file.type` is user-controlled via direct HTTP). `blend-ticket-images` bucket has `allowed_mime_types = null`. `compressImage()` short-circuits and returns the raw file when `file.type` doesn't start with `image/`. Private bucket → smaller blast radius than D11-01, but still untrusted storage. |
| **D11-05** | 🟦 LOW | `seed-admin/index.ts:32-38` | Production gate is `if (env === "production") return 403` — fails *open* if env var is unset. Bounded by `SEED_ADMIN_SECRET` but the gate should be inverted. |
| **D11-06** | ⚪ INFO | `db.ts:25` | Supabase session in `localStorage` (Supabase default for SPAs). Defense-in-depth note only. |

**Pattern fix for D11-01 / D11-02 / D11-04:** on every upload bucket, set `allowed_mime_types = ['image/jpeg','image/png','image/webp']` and `file_size_limit = 10485760`. Add `with_check ((storage.foldername(name))[1] = (auth.uid())::text)` so users can only write to their own folder. Replace `upsert: true` with explicit delete-then-insert (and add a status-aware check for `delivery-signatures`).

**Verified clean (D11):**
- **Zero raw-HTML / code-eval sinks** in `src/`. Exhaustive grep of the usual XSS/injection patterns (raw HTML write APIs, code-evaluation primitives, runtime function constructors) returned no matches in application source.
- **CSV formula injection IS handled** at `src/lib/csvExport.ts:3` — a `FORMULA_LEADING_CHAR` regex prefixes matching cells with `'`. (This **disagrees with earlier RPT-1** — see Correction above.)
- No `service_role` / `SERVICE_KEY` / hardcoded API keys anywhere in `src/`.
- CSP in `vercel.json` is strong (no `unsafe-inline`/`unsafe-eval`, explicit `connect-src` allowlist, `frame-ancestors 'none'`).
- `npm audit`: 0 high / 0 critical; 2 moderate (vite/esbuild dev-only, don't ship).
- No dynamic-SQL injection (`EXECUTE format(...)` calls all use `%I`/admin-time pg_catalog DDL, no user input).

### Domain 12 — Concurrency & races (NEW)

> Earlier run did not cover *distinct* concurrent edits or optimistic locking.

| ID | Sev | Location | Summary |
|---|---|---|---|
| **D12-01** | 🟧 HIGH | `save_quote` RPC | No `FOR UPDATE` on the quote row. Two reps editing the same quote → DELETE + re-INSERT of items means last writer silently wins. |
| **D12-02** | 🟨 MEDIUM | codebase-wide | **No optimistic-locking column on any transactional table** (only `allocation_sets.version` exists). Bare `UPDATE … WHERE id` everywhere — `OrderDetail.handleTogglePlanned` (line 451-465), manual cancel path (line 514-519), `QuoteBuilder.tsx:1316`. Two-tab edits silently overwrite. |
| **D12-04** | 🟨 MEDIUM | `generate_ticket_number` | Missing `pg_advisory_xact_lock` (every other number generator has one). UNIQUE constraint catches collisions but produces a confusing user error during the spring rush. |
| **D12-05** | 🟦 LOW | `allocate_payment` allocation_set MAX+1 | No lock; UNIQUE catches but raises bare Postgres error to UI. Two cashiers paying the same customer simultaneously is rare but possible at month-end. |
| **D12-06** | 🟦 LOW | `check_period_open` | TOCTOU window between check and write — `apply_prepay_to_invoice`, `record_invoice_payment`, `post_invoice`, `allocate_payment`. Theoretical at month-end. |

**Verified clean (D12) — important good news:** every reviewed money-touching RPC takes `FOR UPDATE` correctly: `apply_prepay_to_invoice`, `record_invoice_payment`, `allocate_payment`, `post_invoice`, `complete_delivery`, `create_inventory_hold`, `convert_quote_to_order`, `update_order_items`, `edit_delivery`, `cancel_delivery`, `create_quick_delivery`, `edit_prepay_credit`, `delete_prepay_credit`. **Prepay double-spend / inventory overdraw / payment over-allocation are not at risk.**

### Domain 13 — Date/time & timezone (NEW — biggest hidden surface)

> Earlier run did not cover timezone correctness. **11 findings; 4 HIGH.** This is the most under-covered category in your prior audits.

The DB runs UTC, the business runs Central. `localToday()` helper exists in `src/lib/dateUtils.ts` for exactly this — and is only half-applied.

| ID | Sev | Location | Summary |
|---|---|---|---|
| **D13-01** | 🟧 HIGH | `FieldApplicationInvoice.tsx:81` | Default invoice date uses `new Date().toISOString().slice(0,10)` (UTC) — after ~5pm CT it defaults to *tomorrow*. May land in the wrong period if today's just closed. |
| **D13-02** | 🟧 HIGH | `Invoices.tsx:115-116` | Season filter on `created_at` (timestamptz) with `lte(seasonEnd + 'T23:59:59')` — no Z. Postgres interprets in UTC → Sep 30 evening invoices vanish from this season's list; Sep 30 evening "last season" invoices leak into the new season view. |
| **D13-03** | 🟧 HIGH | `TeamBoard.tsx:219` | `${activityDateTo}T23:59:59Z` hardcodes UTC → 5 hours of activity per day disappears from the report for Central-time users. |
| **D13-04** | 🟧 HIGH | `apply_prepay_to_invoice`, `create_prepay_check_splits`, other money RPCs | Server `CURRENT_DATE` is UTC. At 7pm CT on March 31 (closed period), `CURRENT_DATE` is already April 1 → `check_period_open(CURRENT_DATE)` checks April (open) instead of March (closed). **Period-close bypass silently at 7pm CT every day.** Same root cause flips `current_season()` at Oct 1 boundary. |
| **D13-05** | 🟨 MED | `compute_season` (server, UTC) vs `src/utils/season.ts:14` (client, LOCAL) | Same moment in time → different season numbers across the Sep 30/Oct 1 boundary. Server tags `current_season=2027` while UI filter shows "Season 2026" — payment vanishes from view. |
| **D13-06** | 🟨 MED | `financial_dashboard_summary` vs `get_ar_aging` | Two AR-aging implementations with **different bucket boundaries** (≤30/31-60/61-90/>90 vs 0-29/30-59/60-89/90-119/≥120) **and different date-diff methods** (`NOW() - invoice_date` vs `CURRENT_DATE - invoice_date`). Same customer shows "current" on the dashboard and "30 days past due" on the AR page. |
| **D13-07** | 🟨 MED | `generate_finance_charges` | `period_start` hardcoded as `as_of - 30 days` regardless of customer `grace_days`. Dup-check uses `period_end = as_of` (date equality), so running on Mar 31 and Apr 1 produces two charges for nearly-identical invoices. |
| **D13-08** | 🟨 MED | `InvoiceDetail.tsx:951`, `FieldApplicationInvoice.tsx` | No `max` attribute and no server-side future-date guard on invoice date. A typo like `2206-03-15` (180 years out) is accepted — never goes overdue, never appears in finance charges, but counts in AR. |
| **D13-09** | 🟨 MED | pg_cron jobs at `0 6 * * *` UTC | `mark_overdue_invoices`, `release_expired_quote_holds`, `check_remainder_reminders` fire at midnight–1am CT depending on DST. Customer X is "overdue" 5 hours before the operator's local end-of-day. |
| **D13-10** | 🟦 LOW | `CustomerContextCard.tsx:45` | UTC slice for `p_as_of_date` → AR aging on customer summary card disagrees with the AR page (which uses `parseLocalDate`). |
| **D13-11** | 🟦 LOW | `CustomerDetail.tsx:270` | "90 days ago" via `Date.now() - 90 * 86400000` — DST-unaware ms math + UTC slice. Off by 1 day for late-evening users near DST. |

**Pattern fix (pick one — strongly recommended):**
- **(a)** Set the Postgres session/role `TimeZone` to `'America/Chicago'` at the connection or role level — one change closes the server-side findings (D13-04, D13-05, D13-09) and harmonizes the rest. OR
- **(b)** Finish migrating every `new Date().toISOString().slice(0,10)` callsite to `localToday()` and pass explicit dates to RPCs (`p_operation_date date DEFAULT NULL`, fall back to `CURRENT_DATE`).

(a) is one change. (b) is a hunting expedition but more explicit.

### Domain 14 — Referential integrity & orphans (NEW)

> Earlier run did not cover orphan-row checks against live data or cascade behavior.

| ID | Sev | Location | Summary |
|---|---|---|---|
| **D14-01** | 🟥 **BLOCKER** | `financial_audit_log` live data | **161 rows reference deleted invoices; 43 reference deleted payments.** The "append-only" audit log is hollow — somewhere, invoices/payments are being hard-deleted, and the log doesn't snapshot the parent data into `old_values`/`new_values`. An auditor reconstructing a $2,875 payment against INV-2026-0193 from the trail has nothing to join to. This is the single most damning finding of the run. |
| **D14-02** | 🟨 MEDIUM | 8 live deliveries | Point at soft-deleted orders (ORD-2026-0345, ORD-2026-0187). Order soft-delete doesn't cascade to its deliveries. 4 of the 8 are `status='completed'` — inventory moved, customer received product, order hidden. |
| **D14-03** | 🟦 LOW-MED | 2 live commissions | Same pattern: point at soft-deleted orders ORD-2026-0329, ORD-2026-0330. Both are cancelled $0 rows so blast radius is nil, but the pattern would corrupt a non-cancelled commission. |
| **D14-04** | 🟦 LOW | `inventory_holds.product_id` FK | `ON DELETE CASCADE` while peer money-bearing FKs use NO ACTION / RESTRICT. A future admin DELETE of a product chain-deletes active customer-reservation holds. Preventative — change to RESTRICT. |

**Pattern fix for D14-01:** populate `financial_audit_log.old_values` / `new_values` (both already JSONB) at audit-write time with the full row snapshot, so the trail is self-contained. Alternatively, block hard-delete of invoices/payments/orders via trigger and force soft-delete.

**Verified clean (D14) — extensive good news:**
- 239 FKs total: 183 NO ACTION, 50 CASCADE (all reviewed appropriate — they link items to parents), 5 SET NULL, 1 RESTRICT (`payments.order_id` — matches CLAUDE.md).
- **All 30 direct orphan-row checks across 95 tables returned ZERO** — `invoice_items`, `delivery_items`, `order_items`, `quote_items`, `payments`, `inventory_transactions`, `commissions`, `prepay_applications`, `invoice_line_allocations`, `return_items`, `finance_charges`, `field_polygons`, etc. FK coverage is structurally complete.
- 17 `_id`-named columns lack FKs — all intentional (polymorphic `source_id`/`entity_id`, text `signed_by`, USER-DEFINED `centroid`, external IDs like `resend_message_id`).
- Polymorphic `inventory_holds.source_id` — all 9 active `crop_program` holds resolve to real quotes.

---

## Net-new findings within the original 10 domains

These are issues my agents surfaced that the earlier 10-domain report didn't (or covered differently):

| ID | Sev | Where | What |
|---|---|---|---|
| **D2-01** | 🟧 HIGH | `update_order_items`, `trg_recalc_order_totals` | **Commissions never recompute when order items change after creation.** Live SQL query found **CMCTW LLC is currently underpaid ~$4,351 net** across 3 live orders (verified via live `SELECT` on `commissions` joined to `orders`). Distinct from COMM-1 (rounding) — this is missing recompute entirely. |
| **D2-02** | 🟧 HIGH | `save_customer` body | CLAUDE.md claim of split=100% validation is false — body has zero validation. (Same root as earlier COMM-2; my finding adds that live data already has rows with empty-string recipients.) |
| **D2-03** | 🟧 HIGH | `restore_cancelled_order` | `cancel_order` zeros `commission_amount`; `restore_cancelled_order` doesn't restore commissions → cancel/restore silently zeros commissions forever. |
| **D3-08** | 🟥 **BLOCKER** | `create_quick_delivery` + `trg_prebook_quick_delivery` | **Quick delivery double-prebooks inventory** — both inline RPC code AND the trigger do `UPDATE inventory SET quantity_prebooked = + qty`. `quantity_prebooked` has been ~2× the actual reservation on every quick delivery since the trigger was added. Net Position shown to users is wrong. |
| **D3-01** | 🟧 HIGH | `delivery_items` RLS | No status-aware trigger; admins can mutate `delivery_items` after delivery is in_progress/completed via direct PostgREST UPDATE. Ledger desync since `complete_delivery` already wrote `inventory_transactions`. |
| **D3-07** | 🟧 HIGH | `invoices` table | CLAUDE.md says "NEVER create invoices without order OR blend ticket" but there's **no CHECK constraint** enforcing it. Hard red line not DB-enforced. |
| **D4-01** | 🟥 **BLOCKER** | `inventory_holds_insert` policy | `WITH CHECK ((SELECT auth.uid()) = created_by)` — any authenticated user can INSERT a hold for any product/quantity directly, bypassing `create_inventory_hold` RPC validation entirely. (RPC is the second locked door; this is the first one being unlocked.) |
| **D4-04** | 🟧 HIGH | CLAUDE.md Inventory section | **Wrong Net Free formula documented**: claims `available − planned holds − prebooked`; actual live formula is `available − prebooked + on_order`. Doc drift will cause the next agent to "fix" working code. |
| **D6-02** | 🟥 **BLOCKER** | `save_job` | The unguarded `save_job` from IDEM-1 — on the v_is_new=true path it does `INSERT INTO jobs (job_number, ...) VALUES (next_job_number(), ...)`. **A double-click creates TWO jobs with two sequential job-numbers.** Distinct from IDEM-1's broader pattern call-out — this one specifically corrupts data. |

---

## Combined verdict (after merging both runs)

**HOLD — do not deploy new features until these are addressed.**

**Updated BLOCKER set (4):**

1. **RLS-1 / D5-01 / D7-02** — anon-executable mutating SECDEF RPCs (~106 without `auth.uid()`). Pattern fix: strict-actor + role preamble + `REVOKE EXECUTE FROM anon, public` sweep.
2. **D14-01** — `financial_audit_log` hollowed by hard-deletes elsewhere (161 invoice + 43 payment dangling refs). Pattern fix: snapshot row into `old_values`/`new_values` at write OR block hard-delete via trigger.
3. **D3-08** — `create_quick_delivery` double-prebooks (`quantity_prebooked` is 2× actual on every quick delivery). Fix: remove the inline UPDATE from the RPC body; let the trigger handle it.
4. **D4-01** — `inventory_holds_insert` RLS lets any authenticated user INSERT a hold directly, bypassing all RPC validation. Fix: `WITH CHECK (false)` / revoke direct INSERT.

**Plus the BLOCKER-adjacent HIGHs:**

5. **D6-02** — `save_job` double-create on double-click.
6. **D11-02** — anyone can overwrite any delivery's signature in storage.
7. **D11-01** — public buckets accept arbitrary file content from any authenticated user.
8. **D2-01** — commissions stale on order edits (live $4.4K underpayment).
9. **D2-02 / COMM-2** — `save_customer` doesn't validate splits (CLAUDE.md falsely claims it does).
10. **D1-01 / D1-02** — period-close bypass on `void_payment` and `reverse_write_off`.
11. **D8-01 / EDGE-2** — `reset-user-password` deployed v11 missing the `entity_recipient` block.
12. **D13 cluster** — UTC vs Central timezone confusion (8 separate findings). Single-config fix (set DB TZ) closes most.

**Plus the items from the earlier audit not in my run:**

13. **COMM-1** — Commission split rounding never reconciles to order total.
14. **COMM-3** — Unposted commission payments strand commissions.
15. **EDGE-1** — `reset-user-password` silent-fallback CORS.

---

## Updated follow-up audit queue

| Audit | Status |
|---|---|
| Test coverage & quality (70 skipped tests, E2E disabled in CI) | **Queue** |
| Performance & observability (bundle size, N+1 queries, Sentry coverage) | **Queue** |
| Mason's "something else" — TBD | **Awaiting clarification from Mason** |
| Backup verification + restore drill | **Already PENDING in CLAUDE.md** — operator action |
| Mobile / offline / maps (CRXMap, field_polygons, OCR) | Queue when relevant |

---

## Methodology notes

- 14 risk-domain agents (general-purpose), 3 waves (5 + 5 + 4), all read-only.
- Each agent grounded itself in CLAUDE.md / SAFE_DEVELOPMENT_RULES.md / relevant `docs/reference/*.md`, then cross-checked code against the live database via Supabase MCP (project `rhyzpcqhnizqbxphqdkr`) using read-only SQL.
- Every finding cites `file:line` or a live query result.
- "Silence ≠ verified" rule applied — each agent affirmatively listed what it checked and found clean.
- No code, migrations, schemas, or deployments were modified.
- The master prompt template and domain decomposition are in `C:\Users\mason\.claude\plans\i-want-a-full-synchronous-ocean.md` — reusable for future runs.
