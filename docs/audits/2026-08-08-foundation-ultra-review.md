# Foundation Ultra Review — 2026-08-08

**Verdict: SOLID-WITH-FOLLOWUPS**

No BLOCKER. No HIGH survived adversarial verification. The foundation is sound enough to build the next stretch of features on. The most valuable finding of this run is not a bug — it is a **process gap in how migrations reach production**, described in §2.

Read-only run. Nothing was changed in the database, no migration was applied, no function deployed. The only file written is this report.

Previous ultra review: `docs/audits/2026-06-10-foundation-ultra-review.md`. Delta since: **109 commits, 463 migrations**, heavy churn across `src/lib`, `src/components`, `src/pages`.

---

## 1. Counts by severity

| Severity | Count | Notes |
|---|---|---|
| BLOCKER | 0 | — |
| HIGH | 0 surviving | 3 raised, all refuted or downgraded (§6) |
| MED | 6 | §3 |
| LOW | 4 | §4 |
| INFO | 3 | §4 |

Per layer:

| Layer | Result |
|---|---|
| A — Live-data integrity | 2 HIGH raised → both refuted; 3 MED survive |
| B — Disk-vs-live drift | 3 HIGH raised → 1 refuted, 2 downgraded to LOW–MED; exhaustive clean on overloads and SECDEF posture |
| C — Edge-function bundles | CLEAN — all 7 byte-identical |
| D — Deferred ledger | CLEAN — no item worse than recorded, none silently fixed; 1 doc drift |
| E — Frontend runtime safety | CLEAN — route-guard matrix exhaustive, no gaps |
| F — Authorization & exposure | CLEAN on anon surface — zero anon-reachable rows; 2 MED |

---

## 2. The finding that matters most: an out-of-order migration replay silently reverted a hardening migration

This is the run's headline, and it is a process defect rather than a single bug.

`20260714220000_shared_idempotency_and_hold_hardening` renamed `batch_apply_prepayments` to `_batch_apply_prepayments_impl` and created a thin wrapper enforcing `AUTH_REQUIRED` and `ACTOR_MISMATCH` (`p_performed_by IS DISTINCT FROM auth.uid()`).

Then the ledger recorded:

```
20260714220000 | shared_idempotency_and_hold_hardening
20260715134618 | 20260714185130_gate_batch_prepay_admin    <-- OLDER file, LATER version
```

The older disk file was replayed **after** the newer one and re-created `batch_apply_prepayments` with its full pre-rename body, discarding the actor guard. Live authorization is now only:

```sql
IF NOT public.is_admin() THEN
  RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
END IF;
```

**Nothing detected this.** It surfaced only because this audit hash-compared all 566 live functions against every definition on disk.

**Why the immediate security impact is small** (verified, not assumed):
- `p_performed_by` is accepted but **provably unused** — zero occurrences in the function body. There is no attribution field for a forged actor to land in.
- The admin gate is intact and unweakened; `is_admin()` checks `id = auth.uid() AND role='admin' AND is_active`.
- Only an active admin passes the gate. `anon` cannot execute it.
- `_batch_apply_prepayments_impl` is dead code — zero callers, no `authenticated` EXECUTE.
- The frontend (`src/components/prepay/PrepayWorkspacePanel.tsx:201`) passes `p_performed_by: profile?.id`, silently ignored today.

**Why it still matters:** the same mechanism can revert a guard that *does* matter. A stale disk file re-applied out of order silently undid a security hardening migration and no gate caught it. The defense-in-depth invariant also becomes load-bearing the moment anyone adds attribution logging to this path.

**Fix (two parts, both forward-only — never replay):**
1. A forward migration re-creating `batch_apply_prepayments(jsonb,uuid,text)` with the `AUTH_REQUIRED` / `ACTOR_MISMATCH` / admin block, delegating to `_batch_apply_prepayments_impl`, plus `REVOKE ALL FROM PUBLIC, anon` and `GRANT EXECUTE TO authenticated, service_role`.
2. A **preflight ordering guard**: fail when a migration whose recorded name embeds an older timestamp is applied after a newer one. This is the durable prevention, and it is worth more than the single fix above.

**Scope caveat, stated plainly:** the verifier checked only the prepay and rate-limit slices. Both slices it examined contained drift. It explicitly declined to assume the remaining ~700 ledger rows are clean. A full ledger-vs-disk ordering reconciliation is recommended and is **not** covered by this report.

---

## 3. MED findings

**M1 — `payments` is readable company-wide by every sales rep.** `payments_select` is `is_admin() OR is_sales_rep()` with no per-rep scoping, while `invoices_select` (`created_by`/`salesman_id`) and `customers_select` (`assigned_sales_rep`) *are* scoped. A rep who cannot see another rep's customer or invoice can still read every payment attached to them — amount, customer, method, check number. Same unscoped shape on `prepay_credits`, `prepay_applications`, `invoice_line_allocations`, `order_line_allocations`, `rebate_claims`, `cycle_counts`. Nothing in `DECISION_LOG.md` or `KNOWN_ISSUES.md` documents this as intentional. **Owner decision required** — see §7.

**M2 — An admin can move stock with no ledger row.** `authenticated` holds INSERT/UPDATE/DELETE/TRUNCATE on `public.inventory`; RLS gates all three DML commands on `is_admin()`, so the authorization boundary holds for ordinary users. But an admin session can `PATCH /rest/v1/inventory` directly, bypassing every RPC that maintains `inventory_transactions`. This is the plausible mechanism behind the March 2026 artifacts in §4/L2. Additionally, the **`TRUNCATE` grant to `authenticated` is not constrained by RLS** — Postgres does not apply row policies to TRUNCATE. PostgREST does not expose TRUNCATE, so this is not reachable from the browser and no exploit is claimed; the grant is simply unnecessary and should be revoked.

**M3 — Sub-cent money in live rows.** 46 `order_items.total_price` and 3 `commissions.commission_amount` values carry fractional cents, including a **$5,245.195 pending commission payout**. These columns are `numeric` dollars — the documented historical exception — but the *values* are unrounded products of price × fractional units. Whoever pays these rounds at an unspecified point, so payout and stored liability can disagree by a cent per row. `purchase_orders.total_cost_cents` is `GENERATED ... round(total_cost*100)`, so the same rounding happens silently on AP. **Owner decision on the canonical rounding point** — see §7.

**M4 — `cancel_order` leaves `quantity_remaining` non-zero, and stock stays prebooked.** One cancelled order line carries `quantity_remaining = 247` and its product holds `quantity_prebooked = 36` with zero open demand. 1 of 117 inventory rows; the other 116 tie exactly.

**M5 — The go-live prebook check produces a false discrepancy.** `checkPrebookedInventory()` (`tests/e2e/golive/utils/reconciliation-checks.ts:355-372`) sums `order_items.quantity_remaining` with no order-status awareness; its caller (`tests/e2e/golive/stream0-db-integrity.spec.ts:237`) fetches `order_items?select=product_id,quantity_remaining&quantity_remaining=gt.0` with no join to `orders`. Confirmed live: exactly one `cancelled` order line carries 247 units. Capped at MED because the check only `console.log`s rather than failing the build — it produces a misleading go-live report, not a red build.

**M6 — `check_rate_limit` live has no disk file.** Live upserts into `rate_limits` with `ON CONFLICT`; disk-latest (`20260221200000_rate_limiting.sql`) counts `rate_limit_log` rows. The live-only ledger row `20260223014457|upgrade_rate_limit_to_upsert_and_consolidate` has no corresponding file. The claimed off-by-one **does not exist** — both block after exactly `p_max_calls`. The real difference is the window model: disk uses a sliding window (stricter), live a fixed bucket permitting up to `2 × p_max_calls` across a boundary (looser). Not executable by anon or authenticated; called by four SECDEF functions. Fix: commit the live body forward. Do not replay the 2026-02-21 file.

---

## 4. LOW / INFO

**L1 — `payments` is a vestigial table that will keep generating false alarms.** Zero rows, zero writers, zero inbound FKs, an order-scoped shape from the pre-reset schema generation, and a live SELECT policy that makes it look active. It caused a HIGH-severity scare in this very run. A `COMMENT ON TABLE` marking it superseded by `allocation_sets`/`prepay_credits` is the zero-risk fix.

**L2 — 2,015 units of historical inventory drift across 5 products.** Traced to March 2026 receiving-record reversals ("APPLIED TO WRONG PRODUCT", "Wrong entery"). Historical artifact, not an ongoing leak — every RPC that moves `quantity_available` also writes the ledger, and the frontend performs zero direct inventory writes. Recommended: a typed `prebook_reconciliation` transaction type (already allowed by the CHECK constraint, currently zero rows) so prebooked repairs stop polluting available-stock reconciliation.

**L3 — Negative inventory is 19 rows, `KNOWN_ISSUES.md:919` says 18.** Doc drift only. The owner decision recorded there ("reconcile only from physical counts; negative stock is intentional discrepancy evidence") stands.

**L4 — Docs describe a payment ledger that no longer exists.** `CURRENT_STATE.md` reports `payments = 0` as evidence the money loop has never completed a cycle. It has: on 2026-07-17 a $6,800 check was recorded against the owner's own customer record — $5,020.40 allocated to invoice CS-2026-0094, $1,779.60 to prepay credit — and both halves reconcile exactly. The live ledger is `allocation_sets` + `prepay_credits`.

**I1 — Six live objects have no creation provenance in `supabase/migrations/`:** `require_admin()`, `require_admin_or_sales_rep()`, `cleanup_rate_limits()`, `execute_sql_readonly(text)`, `enforce_blend_ticket_fields_billed_lock()`, and table `rate_limits`. The claim that this breaks rebuild-from-disk is **false**: `supabase/baselines/README.md` states the migrations directory is not the rebuild path, and all six are present in the Brotli baseline. Documentation/auditability gap only. No migration needed.

**I2 — `execute_sql_readonly(text)` is unsafe in shape.** It string-concatenates `sql_query` into `EXECUTE` behind a `LIKE 'select%'` prefix check, trivially bypassed by a CTE with a data-modifying statement. Revoked from `anon` and `authenticated`, so not currently exploitable. It should not exist in this shape.

**I3 — 43 orphaned `financial_audit_log` rows** from March 2026 reference the dead `payments` generation. Harmless (append-only log, no FK on `entity_id`) but permanent noise for future audits.

---

## 5. Layers that came back clean

- **Edge functions (C):** all 7 byte-identical between deployed bundle and disk, including `_shared/*`. The "M3 atomic-claim" change docs flagged as possibly undeployed **is live**. `process-document` v21 genuinely carries `VISION_OCR_TOTAL_TIMEOUT_MS = 120_000` and the shared `AbortSignal.timeout` as `CURRENT_STATE.md` claims.
- **Anon exposure (F):** **zero anon-reachable rows anywhere.** The 2026-06-10 miss is closed and re-verified — `profile_public_view` is `security_invoker=true` with no `anon` SELECT privilege. Both views in `public` are `security_invoker`; no materialized views exist. Every public table has RLS enabled with ≥1 policy. `anon` has EXECUTE on none of the five role helpers, so any anon read transitively touching `profiles` fails closed. The one anon-SECDEF advisor function is `handle_new_user()`, a trigger function proven uncallable.
- **SECDEF posture (B, exhaustive):** 459 `SECURITY DEFINER` functions — zero with NULL ACL, zero missing an explicit `search_path`, exactly one anon-executable (the trigger function above). Zero accidental dual overloads across 566 live functions.
- **Route guards (E, exhaustive across all 88 routes):** no mutating page lacks a role guard. `/payments`, `/month-end`, `/commission-payments`, `/settings` all match documented rules.
- **Money invariants (A):** invoice `balance_cents` generation expression verified and satisfied; zero negative balances on non-credit-memo; zero overpaid invoices; zero AP negatives; commission splits sum to 100 across all 33 orders; zero commissions on cancelled/voided orders. No float/double money columns anywhere.
- **pg_cron (F):** 8 jobs, all active, all targeting functions that exist live.

---

## 6. Refuted appendix

This section is as valuable as the findings.

**R1 — "44 payment records were hard-deleted; AR money asserted with no ledger behind it" (HIGH → REFUTED).** `payments` is a dead legacy table, not the current ledger. Zero live RPCs write it; it is empty because nothing has ever written it in the current architecture. Invoice CS-2026-0094's lifecycle survives intact in `financial_audit_log`; the $1,779.60 prepay balance has a proper backing row in `prepay_credits` (the finder checked `prepay_applications`, the *consumption* table, correctly empty); the "unresolvable idempotency key" was a query for `payment_id`, a field the `allocate_payment_v1` contract does not emit — it carries `allocation_set_id`, which resolves. No delete path exists: `authenticated` and `anon` both have `DELETE = false`, there is no DELETE policy, and no inbound FKs can cascade.

**R2 — "4,861 units of stock movement are unledgered" (HIGH → LOW).** Wrong in direction and magnitude. Nothing is unledgered; the ledger contains *extra* rows. Several `adjusted` transactions repaired `quantity_prebooked`, not `quantity_available`, and say so in their own notes ("Prebooked reconciliation: cancel_delivery bug fix (migration 20260331900000). Old: 39982, New: 42182"), with each delta matching the repair amount exactly. Residual after exclusion: 5 products / 2,015 units (§4/L2). The verifier tested two alternative sign conventions and found the original finder's was the best of three (107 ties vs 87 and 89) — method confirmed, conclusion refuted.

**R3 — "A rebuild-from-disk produces a database that cannot authorize" (HIGH → INFO).** The migrations directory is not the rebuild path; all six objects are present in the supported baseline artifact. See §4/I1.

**R4 — "`check_rate_limit` has an off-by-one threshold difference" (partially refuted).** Both implementations block after exactly `p_max_calls`. The real difference is sliding vs fixed window. See §3/M6.

**R5 — "A caller can claim to be anyone via `p_performed_by`" (severity collapsed).** Syntactically true, semantically empty — the parameter is provably unused and there is no attribution field for a forged actor to reach. See §2.

---

## 7. Owner decisions required

These are business or product choices, not bugs. Combined here so they can be answered in one sitting.

1. **Payment visibility (M1).** Should every sales rep see every payment company-wide, or should `payments_select` be scoped to the invoices the rep can already see? Scoping it would mirror `invoice_items_select`.
2. **Canonical rounding point (M3).** Where should `order_items.total_price` and `commissions.commission_amount` be rounded to whole cents? A $5,245.195 commission is currently pending payout. Once decided, a live invariant predicate should assert whole cents on both.
3. **`cancel_order` semantics (M4).** Should cancelling an order zero `quantity_remaining` on its lines and release the prebooked stock? Current behavior leaves both stranded.
4. **Negative inventory (L3).** The recorded decision is "reconcile only from physical counts". Still 19 rows. Confirm it stands, or schedule the re-base.

---

## 8. Explicit deferrals — NOT covered by this run

Naming these so the SOLID verdict cannot be read as covering them:

- Performance under realistic data volume.
- Auth/session flow correctness.
- **Backup/restore drill.** Note: no off-site database dump exists. The in-database `backup_snapshots` automation is stored inside the database it protects, and the project is on the Supabase Free plan with no point-in-time recovery. This is the single largest unmitigated risk to the business and is outside this audit's scope.
- True end-to-end billing behavior beyond the single 2026-07-17 cycle.
- Exhaustive per-page frontend coverage. Layer E's error-path and async-race conclusions are **sample-based** across 8 money-heavy files; `Prepay.tsx` and `AccountsReceivable.tsx` are thin wrappers whose sub-components were not opened.
- **Full ledger-vs-disk ordering reconciliation** across all ~700 rows (§2).
- RLS *policy body* live-vs-disk comparison, indexes, trigger-to-function bindings, and column-level DDL drift.
- ~180 live CHECK constraints were not individually diffed; 17 named constraints on money/lifecycle tables were, and all matched.

**Post-first-billing-cycle re-run gate:** money volume remains near-zero (one real cycle, on the owner's own record). The money/AR probes in Layer A and the exposure probes in Layer F should be re-run once real customer billing volume exists. Layer A could not cross-check any admin-gated reporting RPC at all — `get_ar_aging` refuses the service-role connection because `auth.uid()` is NULL. That requires an authenticated admin session and remains unverified.

---

## 9. Escalation trace (audit of the audit)

- **Phase 0** — recon: 109-commit / 463-migration delta; 322 security advisors, all WARN, zero ERROR; anon-SECDEF count down from an accepted baseline of 53 to 1. Migration name parity computed, then **recomputed** after the first pass proved confounded by inconsistent live `name` formatting (some rows carry the version prefix and `.sql`, some do not).
- **Phase 1** — 6 layers in parallel. Model-tiered by risk: Opus on A/B/F, Sonnet on C/D/E.
- **Phase 2/3** — 3 refutation agents spawned on the 3 HIGH-bearing threads, each combining causal trace with adversarial refutation. All 3 HIGHs fell. One wave; the cap of 2 was not reached.
- **Direct orchestrator verification** — the `inventory` grant/policy claim was confirmed by direct SQL rather than a fourth agent, and its severity corrected downward from the agent's framing.
- **Delta reviewers: deliberately not dispatched.** With 463 migrations of delta, "scoped to the delta" is effectively the whole codebase. Running `/whole-codebase-audit` separately is the honest path; this report does not claim that coverage.

**Process finding, outside the audit's scope but worth recording:** three independent read-only reviewer agents reported that hook text instructing them to run `.claude/hooks/autopilot-arm.mjs` appeared inside their Bash tool results. All three declined, correctly identifying it as outside a read-only reviewer's mandate. The source is `.claude/hooks/autopilot-intent-reminder.mjs`, a `UserPromptSubmit` hook — so it should not be reaching subagent context at all. The hook's own source comment (line 25) anticipates exactly this leak. Worth tightening.

---

## 10. Suggested next step

Land the two forward migrations from §2 (actor-guard restoration + the ledger ordering preflight guard) via `/ship`, one at a time, with a `/codex-cross-review` packet for the pair. The ordering guard is the higher-value of the two.

Everything else in §3 either waits on an owner decision (§7) or is a doc/test fix.
