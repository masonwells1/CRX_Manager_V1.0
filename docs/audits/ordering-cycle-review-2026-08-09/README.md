# Ordering Cycle Review — 2026-08-09

Read-only review of the full ordering cycle: quote → planned booking → order → delivery → invoice, plus inventory holds, commissions, permissions, and the reports that read from all of it.

**Result: 77 confirmed findings — 10 HIGH, 36 MED, 31 LOW. 26 further claims were refuted and dropped.**

No code was changed. No migration was written. Nothing was pushed, deployed, or written to the database.

## Files

| File | What it is |
|---|---|
| `FINDINGS.md` | All 77 findings with full detail, evidence, failure scenario, and verifier reasoning. The canonical record. |
| `findings.json` | Same data as structured JSON — the source the report is generated from. |
| `report.html` | Plain-English summary report for Mason (published as an artifact). |
| `build-report.mjs` | Generates `report.html` from `findings.json`. Correct a verdict there and re-run to rebuild. |
| `workflow.mjs` | The review workflow itself — 9 finder agents across 3 phases, each finding adversarially verified. Re-runnable. |

## Method

Nine finder agents ran across three phases at high reasoning effort, with no severity cap (per the CLAUDE.md review-prompt rule). **Every** finding was then handed to an independent verifier whose instruction was to refute it, defaulting to refuted when evidence was weak or the issue was already recorded in `KNOWN_ISSUES.md` or the 2026-08-05 gauntlet section-04 baseline. Only findings that survived that pass are recorded here.

- **Phase 1 — Lifecycle & Holds:** state machines, planned-booking holds, conversion seams.
- **Phase 2 — Money & Idempotency:** cent maths, commissions, idempotency and concurrency.
- **Phase 3 — Security & Frontend:** RLS/grants, frontend rule compliance, reporting drift.

## Evidence caveat

Phases 1 and 2 read the on-disk migrations only — no live database access. If a function was ever altered directly in Supabase without a migration, those findings describe the file rather than the live database. **Phase 3 did pull the live schema and grants**, which is why the delivery-completion bypass appears twice, once from each source; that one carries the strongest evidence.

Confirm the live function bodies before acting on any Phase 1 or Phase 2 finding.

## The ten HIGH findings

Six of the ten share one root cause: **safety logic lives in the RPCs, but the underlying tables remain directly writable by the same roles.** Anyone using the API rather than the UI bypasses it.

1. Quote transition trigger allows `accepted → sent` on a direct update, bypassing every `revert_quote_status` reopen guard.
2. Deliveries can be walked to `completed` by direct update, skipping all `complete_delivery` effects — no inventory movement, no order rollup, no invoice.
3. Quote soft delete has no DB guard; deleting a planned booking leaks its inventory holds permanently.
4. Soft-deleting a planned quote orphans its active crop-program holds (same leak, independently found).
5. Caller-controlled cost/profit still drives the commission basis on `convert_quote_to_order` and `create_direct_order` — the class already hardened out of `bulk_import_order`.
6. Quick-delivery invoice posted before completion is never adjusted on partial completion; the follow-up delivery then bills the shortfall a second time.
7. Void-then-rebill of an order invoice permanently cancels the order's commissions, with no path that re-mints them.
8. Assigned driver can complete a delivery by direct table update (confirmed against **live** grants and policies).
9. `get_customer_year_end_summary` is an ungated `SECURITY DEFINER` RPC granted to `authenticated` — any role reads any customer's full financial history.
10. Sales reps can insert orders and order lines directly, bypassing every canonical order-creation effect and the confirmed-only status rule.

## Suggested order of work

1. **Confirm the backups are fresh.** Two automated weekly backups run (encrypted off-site dump to `CRX_Backups`, plus an in-database `pg_cron` snapshot). Neither is point-in-time, so verify both are recent before starting.
2. **Close the direct-write lane.** Retires most of findings 1–4, 8 and 10 in one change. Highest blast radius — needs a real test pass.
3. **Fix the three money bugs** (5, 6, 7). No misuse required; these are ordinary workflows producing wrong numbers today.
4. **Gate the ungated read RPCs** — `get_customer_year_end_summary`, `check_customer_credit_limit`, `get_customer_summary`, `global_search`. Small, low-risk.
5. **Work the MED list as maintenance** — missing `deleted_at` filters, reused page-scoped idempotency keys, and the three inconsistent AR derivations.

## Reproducing

```bash
# Re-run the review (read-only; ~90 min, high token cost)
# via the Workflow tool with workflow.mjs

# Regenerate the HTML report from findings.json
node docs/audits/ordering-cycle-review-2026-08-09/build-report.mjs
```
