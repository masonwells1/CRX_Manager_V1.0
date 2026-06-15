# Foundation Ultra Review — 2026-06-15

**Verdict: `SOLID-WITH-FOLLOWUPS`** — 0 BLOCKER, 0 HIGH. The foundation is safe to build the next stretch of features on. Every follow-up is either an owner decision (storage-bucket privacy, a data load, two dashboard toggles) or doc/ledger hygiene — none block feature work.

**Scope of this run:** the blind-spot layers no other tool checks — live-data integrity (A), disk-vs-live drift (B), edge-bundle drift (C), deferred-ledger reconciliation (D), frontend runtime safety (E), authorization/exposure surface (F) — run as a dynamic multi-agent fan-out with adversarial verification. Read-only throughout: the **only** file written is this report. No code edited, no migration applied, no Edge Function deployed, no DML.

**Delta covered:** everything since the last ultra review (2026-06-10) — the G5 sell-side roadmap (#2–#7: `create_rush_order`, `price_order`, `consolidate_draft_invoices`, prepay-booking link + settlement, open-booking rollover, pricing-gate, terminal-draw guard), Field Mode (`/my-route` driver workspace), `create_direct_order` PO param, the `execute_sql_readonly` REVOKE, the partial-draw-down hold-resync trio, the plpgsql-check column-fix batch, and the live-only label-corrections migration.

---

## 1. Counts by severity, per layer

| Layer | BLOCKER | HIGH | MED | LOW | INFO/clean |
|-------|:-:|:-:|:-:|:-:|:-:|
| A — Live-data integrity | 0 | 0 | 0¹ | 1 | clean (vacuous on money) |
| B — Disk-vs-live drift | 0 | 0 | 0 | 2 | clean |
| C — Edge-function bundles | 0 | 0 | 0 | 0 | all 7 IN-SYNC |
| D — Deferred-ledger | 0 | 0 | 2 | 1 | many resolved |
| E — Frontend runtime safety | 0 | 0 | 0 | 1 | clean (sample) |
| F — Authz / exposure surface | 0 | 0 | 1 | 0 | clean |
| Advisors | 0 | 0 | 0 | 2 | baseline-clean |
| Delta reviewers (RLS / drift / types / compliance) | 0 | 0 | 0 | 2 | clean |
| **Total** | **0** | **0** | **3** | **9** | — |

¹ Layer A's one MED (17 negative-inventory products) is the *known, already-recorded* H1 owner item — listed in the reconciled ledger, not double-counted as a new finding.

---

## 2. Findings

Each: **severity | layer | claim | citation | verified-by | fix route**.

### MED

**MED-1 | F | Three Storage buckets are `public=true`, one holding real customer delivery photos.**
`delivery-photos` (12 objects — actual customer delivery photos, can depict customer property/locations), `receiving-photos` (0 objects), `team-note-attachments` (0 objects) are served via the **unauthenticated public-URL endpoint**, bypassing RLS, with no signed-URL expiry. Sensitive assets are correctly private (`delivery-signatures` 17 objs, `document-uploads`, `blend-ticket-images` all `public=false`).
- *Mitigants that keep this below HIGH:* object paths embed a random UUID folder + ms timestamp (non-enumerable), and **anon has no `storage.objects` LIST policy** (`SET ROLE anon; count(*) … = 0`). So URLs are not discoverable — but anyone who *obtains* a URL keeps permanent, unauthenticated access.
- *Citation:* live `SELECT name, public FROM storage.buckets` → `{delivery-photos:true, receiving-photos:true, team-note-attachments:true, document-uploads:false, blend-ticket-images:false, delivery-signatures:false}`; `delivery-photos` object count = 12; anon LIST = 0.
- *Verified by:* Agent F + orchestrator Phase-3 SQL (re-ran the bucket flags independently).
- *Fix route (`/ship`):* Decide whether delivery/receiving photos genuinely need public URLs. If not, flip the three buckets to `public=false` and switch the frontend to `createSignedUrl()` (the signatures path already does this). The two **empty** buckets (`receiving-photos`, `team-note-attachments`) are zero-cost to flip *now*, before content lands.

**MED-2 | D | Grower-portal pesticide label data is not loaded — the shipped WPS/REI/PHI/RUP features render blank.**
Of **604 products**: `rei_hours` populated on 0, `phi_days` on 0, `signal_word` on 0, `is_rup=true` on only 2, `epa_registration` on 299. The point-of-sale compliance features shipped 2026-06-10 (B1 RUP warnings, B3 WPS notice PDF, B5 license gates) have nothing to display until label data exists.
- *Citation:* live `SELECT count(*) FILTER (WHERE rei_hours IS NOT NULL) …` counts above.
- *Verified by:* Agent D + orchestrator.
- *Fix route:* **Owner-gated data load** — the researched top-9 draft CSV is untracked, pending Mason's go (per memory `grower-portal-label-data-2026-06-14`; note the 2 flagged wrong EPA #s + glyphosate formulation + first-2 RUP review). This is an **enablement gap, not a defect** — the code is correct and dark by data, not by bug.

**MED-3 | D / Advisor | L4 Supabase leaked-password protection still disabled.**
HaveIBeenPwned compromised-password check is off (a long-standing owner item).
- *Citation:* security advisor `auth_leaked_password_protection` WARN (1).
- *Fix route:* **Owner action** — enable in Supabase dashboard → Authentication (not MCP-exposed).

### LOW

**LOW-1 | B / D | Live-only migration `20260615115130_product_label_corrections_safe` has no disk file on `main`.**
It is **data-only** — two value-guarded `UPDATE public.products` statements (Trivapro EPA `100-1567`→`100-1613`; flag two beta-cyfluthrin generics `is_rup=true`); it changes no function, table, constraint, RLS policy, or trigger, so it carries **zero hidden-function-drift risk**. The matching disk file exists on the unmerged branch `fix/product-label-corrections-2026-06-15` (commit `bf92fa8`); it was applied live ahead of merge.
- *Citation:* `git branch --contains bf92fa8` → only that branch; `git merge-base --is-ancestor bf92fa8 origin/main` → NO; live `list_migrations` contains version `20260615115130`; body grep for `CREATE|FUNCTION|POLICY|ALTER TABLE|TRIGGER` → none.
- *Fix route:* Merge `fix/product-label-corrections-2026-06-15` to `main` (or export the live body to a disk file) so the disk set matches live 1:1 again.

**LOW-2 | B / D | Disk-only stamp `20260614153000_revoke_execute_sql_readonly_authenticated` is on `main` but not in `schema_migrations`.**
Applied live via the Supabase dashboard (not MCP-stamped), exactly as its own header documents. The REVOKE is **live-effective** (verified — see INFO below). Idempotent.
- *Fix route:* Re-run the file once via MCP/CLI (idempotent no-op) to record it in `schema_migrations` and close the ledger gap.

**LOW-3 | Advisor / D | Two CLAUDE.md doc statements read as contradictory / scoped imprecisely.**
(a) The 2026-05-29 entry implies report/financial RPCs (`financial_dashboard_summary`, `get_ar_aging`, `get_customer_statement`, `get_sales_detail_report`) were anon-REVOKE'd, yet they still carry anon EXECUTE live (reconciled by the Schema Gotchas note: those self-gate and are inert grant-debt; a *different* set of 37 was revoked). (b) CLAUDE.md's "0 WARN findings" is **performance-advisor-scoped**; the security advisor has 273 accepted WARN (218 authenticated-SECDEF + 53 anon-SECDEF grant-debt + 1 leaked-password + 1 extension-in-public).
- *Fix route:* Doc fix in CLAUDE.md — clarify both.

**LOW-4 | A | Stale `quote_product_draws` row on a cancelled TEST FARM quote.**
One draw row (qty 247) belongs to **Q-2026-1811**, a *cancelled* TEST FARM quote with **zero orders** — test residue from the 2026-06-10 data-fix. No money/commission impact (0 orders, 0 booking_draw orders for the quote).
- *Citation:* live join `quote_product_draws → quotes`: `{quote:Q-2026-1811, qstatus:cancelled, qty:247, order_exists_for_quote:0}`.
- *Fix route:* Optional cleanup (delete the orphan draw row). Harmless.

**LOW-5 | Types | `orders.booking_draw` typed optional but DB is `NOT NULL DEFAULT false`.**
`booking_draw?: boolean` in `src/types/index.ts:327`; a SELECT always returns a boolean, never `undefined`. Not a runtime bug (all callsites use optional chaining, e.g. `order?.booking_draw`).
- *Fix route:* Optional — drop the `?` for type precision; defensible to leave.

**LOW-6 | RLS-security | `create_direct_order_customer_po_param` uses a legacy non-canonical actor check.**
`p_performed_by <> v_actor` + string `'Actor mismatch'` (not `IS DISTINCT FROM` / `'ACTOR_MISMATCH'`) — but this is **byte-verbatim from the live body** (the DROP+CREATE only added `p_customer_po_number`) and is **NULL-safe** because the `p_performed_by IS NOT NULL` guard precedes the `<>`. Not a new defect.
- *Citation:* `20260614142939_create_direct_order_customer_po_param.sql:75-77`.
- *Fix route:* Optional canonicalize in a future strict-actor sweep; not a blocker.

**LOW-7 | Advisor | `plpgsql_check` extension installed in the `public` schema.**
Cosmetic; dev-tooling extension added 2026-06-10, not on any data path. *Fix route:* optional — move to a dedicated schema.

**LOW-8 | A | One blank-recipient commission row.**
A single `cancelled`, `$0`, NULL-recipient commission row — the known legacy row already documented in CLAUDE.md. No action.

---

## 3. Refuted / downgraded appendix

| Candidate | Disposition | Why |
|-----------|-------------|-----|
| "Live-only label migration is a B7-class drift risk (MED)" | **Downgraded to LOW** | Agent B's own follow-up proved the body is two guarded `UPDATE`s — data-only, no function/schema/RLS change → zero hidden-drift risk. |
| "1 draw row vs 0 `booking_draw` orders → draw-down may be corrupting" | **Refuted** | The single draw row is on cancelled TEST FARM quote Q-2026-1811 with no order — test residue, not a systemic bug (LOW-4). |
| "177 `delivery_items` under voided/cancelled deliveries → inventory uncompensated" | **Refuted (INFO)** | Expected historical rows across 25 cancelled/voided deliveries; `void_delivery_reversal` txns present for the completed-then-voided subset; cancelled-while-scheduled deliveries correctly need no reversal. No double-count surfaced. |
| "Field Mode lets a driver see all stops (RLS)" | **Refuted** | `deliveries.del_select` = `is_admin() OR is_sales_rep() OR assigned_driver = auth.uid()`; `delivery_items` scoped via parent. A driver sees only their own assigned stops. |
| "53 anon-SECDEF functions = exposure" | **Refuted (accepted baseline)** | Each self-gates on `auth.uid()`/role at its first statement (live-verified on the 5 highest-value money/report RPCs); the set is a strict subset of the 218 authenticated-SECDEF grant-debt. Inert. |
| "profile_public_view anon-readable (the 2026-06-10 miss)" | **Refuted — closed** | `has_table_privilege('anon', 'profile_public_view', 'SELECT')` = false; REVOKE'd by `20260610131144`. View exposes only its 4 documented columns. |

---

## 4. Reconciled deferred ledger (Agent D, live-verified)

| Claim (as recorded) | Recorded status | **Verified status** | Evidence |
|---------------------|-----------------|---------------------|----------|
| 3 shelved earmark-engine migrations | shelved, do not apply | ✅ **Correctly absent** | `set_prepay_credit_booking` / `apply_booking_prepay` / `aggregate_prepay_reserve_earmarked` / `auto_apply_booking_prepay_on_post` all absent from `pg_proc`; files only in `docs/roadmap/shelved-earmark-engine/`. |
| "11 plpgsql_check functions — fix one /ship at a time" | open follow-up | ✅ **DONE — close it** | Full non-trigger `plpgsql_check` sweep = 0 errors; the 20260611* batch closed the whole class. CLAUDE.md wording is stale. |
| "22-RPC idempotency-scoping sweep" | open follow-up | ✅ **DONE — close it** | `20260611211058` live; 36/36 inline lookups scoped to `operation`, 0 unscoped, 84 more use the helper. |
| `generate_rup_sales_records` REVOKE | to do | ✅ Done (`20260611001248`) | anon=false, authenticated=false, service_role=true. |
| `execute_sql_readonly` REVOKE | to do | ✅ **Live-effective** | `has_function_privilege('authenticated', …, 'EXECUTE')` = false; HIGH RLS-bypass closed. (Ledger-stamp gap = LOW-2.) |
| `void_payment` prepay-credit reversal bug | to fix | ✅ Fixed (`20260611001904`) | multi-credit `FOR … LOOP` reversal, strict-actor, scoped idempotency. |
| `get_customer_statement` blind spots | to fix | ✅ Fixed (`20260611131549`) | filters `deleted_at`, includes paid/overdue, handles NULL-order_id payments. |
| 3 blank-recipient commission defaults | owner input pending | ✅ **Resolved** | 0 active/nonzero blank-recipient commissions (only the 1 cancelled-$0 legacy row, LOW-8). |
| ORD-2026-0189 $50→$2,455.37 revert? | question | ✅ Resolved | recalc kept ($2,455, recipient Mason Wells, status `pending`, nothing paid) — Mason-confirmed. |
| Grower-portal label data (top-9) | pending owner go | ⚠️ **Still not loaded (MED-2)** | 0/604 products with REI/PHI/signal_word. |
| L4 leaked-password protection | open owner item | ⚠️ **Still open (MED-3)** | advisor WARN. |
| M4 seed-admin `ENVIRONMENT=production` | owner confirm | ◻️ Code-guarded; secret value not MCP-verifiable | edge fn v15 returns 403 when env==='production'; owner must confirm the secret is set. |
| H1 — 17 negative-inventory products | owner re-base (physical counts) | ◻️ **Still open, unchanged** | 17 rows `quantity_available<0` (real products: Water W/D-Chlorinator −2345, HumiK Bio WSP −1870, …). System "warn-not-block" allows negatives by design. |
| A1 Stripe/ACH · D1 vendor-bill AI pilot · B6 states/WI DATCP · Phase-4 backup/restore drill | open owner items | ◻️ Remain open | listed in TODO.md "needs Mason"; no code action possible. |

Legend: ✅ resolved/correct · ⚠️ open finding (escalated above) · ◻️ correctly parked on owner input.

---

## 5. Per-layer clean evidence (what makes the verdict trustworthy)

- **A — Live-data integrity (orchestrator, direct SQL):** Money/AR invariants M1–M7 = **0 violations**, but **vacuously** — production is operationally near-empty: 4 draft invoices, **0 posted / 0 paid / 0 payments / 0 prepay credits**. Non-vacuous checks that *did* have data are clean: **commission splits sum to 100 on all 50 orders** (L3=0); blend-ticket 4-axis combos valid; 0 active holds stranded on terminal quotes; 0 orphan-source holds; prepay-credit balances consistent; G5 pricing columns in a clean state (all 50 orders `priced`, 0 `pricing_pending`).
- **B — Disk-vs-live:** B7-era (≥20260526) parity is 1:1 except the two documented items (LOW-1, LOW-2). **All 11 reviewed money/security function bodies match their latest disk definition** (no live≠disk behavioral drift); overload check clean (only `plpgsql_check` ext fns have >1); `apply_booking_prepay` correctly absent.
- **C — Edge bundles:** all 7 functions **IN-SYNC**; no DEPLOYED-AHEAD, no security-guard REPO-AHEAD. `process-blend-ticket` v20 byte-identical (M3 atomic-claim live); `create-user` B8 reset-password entity_recipient guard present in the deployed bundle.
- **E — Frontend (sampled):** Field Mode pages role-guarded `admin/sales_rep/driver`; `FieldStop` completion path fully instrumented (idempotency + reset, `assertRpcResult`, Sentry critical-action capture, offline stale-write guard, signature-upload-failure surfaced); no swallowed money-path errors in the 10 money-heaviest pages.
- **F — Authz:** anon table grants inert (RLS on all tables; `SET ROLE anon` counts = 0); both public views safe; RLS SELECT policies match documented bounds; **5 pg_cron jobs** all point at live single-overload functions (note: CLAUDE.md lists only 3 of the 5).
- **Advisors:** security 274 findings all within accepted baseline (no new finding type, no new SECDEF view, no anon-readable table, no missing-RLS); performance 137 findings **all INFO `unused_index`, 0 WARN/0 ERROR**.
- **Delta reviewers:** RLS-security, migration-drift, types-drift, compliance all clean on the 34-file delta (orchestrator independently re-confirmed the live constraints, overloads, gates, and shelved-fn absence via direct SQL — see §3/§Phase-3).

---

## 6. Escalation trace (audit of the audit)

- **Phase 0 (recon):** git delta since 2026-06-10, disk migration count (455), live migration list, both advisor outputs (saved to file, delegated to avoid context bloat), edge-function versions, schema introspection (money/inventory columns + the `balance_cents` generation expr).
- **Phase 1 (fan-out):** 10 read-only agents in one background workflow — advisor-parse, B, C, D, E, F + 4 scoped delta reviewers (1.56M tokens, 258 tool calls, ~6 min). Agent A (live-data integrity) was run by the orchestrator directly with batched SQL, *not* delegated — the highest-stakes BLOCKER-class layer is kept in-loop per the project's structured-output-flake lesson.
- **Phase 2 (dynamic escalation):** **No mandatory escalation fired.** Agent A surfaced no corrupted rows (only known/benign items → no causal-trace needed); Agent B found no live≠disk function body (→ no blast-radius trace); Agent C found no REPO-AHEAD security guard (→ no exposure check). Cap not approached.
- **Phase 3 (adversarial verification):** With 0 BLOCKER/HIGH there was nothing to *refute*, so the orchestrator instead spent Phase 3 **independently re-verifying the load-bearing CLEAN claims that the no-MCP delta reviewers had leaned on self-verify blocks for** — the live `pricing_status`/`holder_check` constraint defs, the 6 G5 RPC gates + overload counts, the shelved-fn absence, `profile_public_view` anon priv, `execute_sql_readonly` grant, storage flags, and the `deliveries`/`delivery_items` driver RLS. All reproduced. The refuted/downgraded candidates are in §3.

---

## 7. Deferrals & the mandatory re-run gate

**Explicitly NOT covered by A–F (name them so the verdict can't imply otherwise):**
- Performance under realistic data volume (DB is low-traffic; the 137 unused-index INFOs are an artifact of that).
- Auth/session-flow correctness.
- Backup verification + restore drill (Phase-4 owner exercise).
- True end-to-end billing *behavior* (only the data state was checked — and there is almost none).
- Exhaustive per-page frontend coverage (Layer E sampled the ~10 money-heaviest + the 2 new Field Mode pages; CLEAN claims are sample-based).
- Inventory ledger-vs-snapshot reconciliation for the highest-volume products (holds/prebooked/negatives were checked; a full signed-ledger replay was not — deferred).

**🔁 MANDATORY RE-RUN GATE:** because money volume is near-zero (0 posted invoices, 0 payments, 0 prepay credits), the money/AR probes (A.M1–M7) and Layer F are **vacuously clean**. This review **must be re-run after the first real billing cycle** — once invoices are posted, payments recorded, and prepay credits earmarked — to validate those invariants against actual money rows. This carries forward the identical gate from the 2026-06-10 run, still unmet.

---

## 8. 5-line summary for Mason

1. **Verdict: SOLID-WITH-FOLLOWUPS** — 0 blockers, 0 high. The foundation is safe to build the next stretch of features on; nothing here blocks feature work.
2. **Single most actionable finding:** three Storage buckets are public — `delivery-photos` holds 12 real customer delivery photos served by unauthenticated URL (non-enumerable, but permanent if a URL leaks). Decide public-vs-signed; flip the 2 empty buckets now for free.
3. **Biggest *enablement* gap (not a defect):** the WPS/REI/PHI/RUP point-of-sale features are live but **dark** — 0 of 604 products have label data loaded. Owner-gated CSV load, pending your go.
4. **Two stale follow-ups are actually DONE** — the "11 plpgsql_check functions" and the "22-RPC idempotency sweep" are both fully resolved live; CLAUDE.md can close them. Two owner toggles remain open (leaked-password protection L4, seed-admin env confirm M4).
5. **Nothing was changed — read-only throughout.** Remediation goes through `/ship` one finding at a time; a `/codex-cross-review` packet for the batch is worth drafting (the Codex round-trip has caught a real miss in every prior cycle).
