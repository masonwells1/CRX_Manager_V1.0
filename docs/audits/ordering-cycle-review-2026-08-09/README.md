# Ordering Cycle Review — 2026-08-09

Read-only review of the full ordering cycle: quote → planned booking → order → delivery → invoice, plus inventory holds, commissions, permissions, and the reports that read from all of it.

**Result: 77 confirmed findings — 10 HIGH, 36 MED, 31 LOW. 26 further claims were refuted and dropped.** Findings are not deduplicated across finders; see *Duplicates across finders* below — roughly 69 distinct defects.

The review changed no application source, schema, migration, deployment, or live data. The only files it produced are this audit folder itself.

## Files

| File | What it is |
|---|---|
| `FINDINGS.md` | All 77 findings with full detail, evidence, failure scenario, and verifier reasoning. The canonical record. |
| `findings.json` | Same data as structured JSON — the source the report is generated from. |
| `REFUTED.md` / `refuted.json` | The 26 disproven claims, in full. Not defects — kept so a later live check can overturn a refutation on stronger evidence, which the titles alone would not support. |
| `report.html` | Plain-English summary report for Mason (published as an artifact). |
| `build-report.mjs` | Generates `report.html` from `findings.json`. Correct a verdict there and re-run to rebuild. |
| `workflow.mjs` | The review workflow itself — 9 finder agents across 3 phases, each finding adversarially verified. Kept verbatim as the record of what ran; its prompt embeds the original session's absolute repo path, so update that before re-running elsewhere. |

## Method

Nine finder agents ran across three phases at high reasoning effort, with no severity cap (per the CLAUDE.md review-prompt rule). **Every** finding was then handed to an independent verifier whose instruction was to refute it, defaulting to refuted when evidence was weak or the issue was already recorded in `KNOWN_ISSUES.md` or the 2026-08-05 gauntlet section-04 baseline. Only findings that survived that pass are recorded here.

**Refuted claims are kept, not discarded.** The workflow returned only the titles of refuted claims, which would have made a refutation impossible to revisit. The full records were recovered from the run journal into `REFUTED.md` / `refuted.json`. If the live-catalog check contradicts a refutation, the original claim and its evidence are there to promote.

**Coverage limitation on any re-run.** `workflow.mjs` treats an agent that dies on a terminal API error the same as one that found nothing, and drops failed verifiers rather than flagging them. A finder killed mid-run therefore reads as clean coverage. In this run every failed agent was re-run to completion before the result was taken (the first two attempts hit session limits), and the final pass reported 112 of 112 agents done with zero errors — but a future re-run must check the agent error count before trusting the totals.

- **Phase 1 — Lifecycle & Holds:** state machines, planned-booking holds, conversion seams.
- **Phase 2 — Money & Idempotency:** cent maths, commissions, idempotency and concurrency.
- **Phase 3 — Security & Frontend:** RLS/grants, frontend rule compliance, reporting drift.

## Evidence caveat

**No phase queried the live database.** All three worked from committed sources: phases 1 and 2 from the on-disk migrations, phase 3 additionally from the 2026-07-27 disaster-recovery baseline (`supabase/baselines/20260727174805_acl_lockdown.sql`) plus later migrations. That baseline is a point-in-time snapshot, not current state.

So the delivery-completion bypass appearing twice (findings 2 and 8) is **not** an independent live confirmation — both derive from committed files, one from migrations and one from the baseline. Treat it as corroboration between two offline sources, nothing more.

Confirm the live function bodies, grants and policies against the database catalog before acting on **any** finding here. If anything was ever changed directly in Supabase without a migration, that drift is invisible to this review.

## Duplicates across finders

The nine finders worked independently and were never reconciled against each other, so **the same defect is sometimes counted more than once.** The 77 total is verified findings, not 77 distinct defects. Six known overlaps collapse 14 findings into 6, giving roughly **69 distinct defects** to remediate:

| Defect | Counted as | Collapses to |
|---|---|---|
| Deleting a quote leaks its inventory holds | `state-machines` HIGH + `planned-holds` HIGH + `frontend-compliance` MED + `reporting-drift` MED (the parity check that would have caught it) | 1 fix, 4 findings |
| Delivery walkable to `completed` by direct update | `state-machines` HIGH + `rls-security` HIGH | 1 fix, 2 findings |
| NaN/Infinity accepted in money and quantity fields | `conversion-seams` MED + `money-math` MED | 1 fix, 2 findings |
| `allocate_payment` unlocked `MAX(version)+1` race | `idempotency-concurrency` MED + `money-math` LOW | 1 fix, 2 findings |
| Order detail reads invoices without a `deleted_at` filter | `money-math` MED + `frontend-compliance` MED | 1 fix, 2 findings |
| Quote `accepted → sent` writable directly | `state-machines` HIGH + `idempotency-concurrency` LOW (the frontend caller that relies on it) | 1 fix, 2 findings |

Duplicate coverage is useful — two finders reaching the same defect from different angles is corroboration, and the lower-severity entries usually name a second caller or a detection gap worth fixing alongside. But count the backlog by fix, not by finding. Codex flagged this on PR #356; the merge list above may not be exhaustive, so check for further overlap during triage.

## The ten HIGH findings

Six of the ten share one root cause: **safety logic lives in the RPCs, but the underlying tables remain directly writable by the same roles.** Anyone using the API rather than the UI bypasses it.

1. Quote transition trigger allows `accepted → sent` on a direct update, bypassing every `revert_quote_status` reopen guard.
2. Deliveries can be walked to `completed` by direct update, skipping all `complete_delivery` effects — no inventory movement, no order rollup, no invoice.
3. Quote soft delete has no DB guard; deleting a planned booking leaks its inventory holds permanently.
4. Soft-deleting a planned quote orphans its active crop-program holds (same leak, independently found).
5. Caller-controlled cost drives the commission basis on `create_direct_order` — the class already hardened out of `bulk_import_order`. (The finding's title also names `convert_quote_to_order`; its verifier refuted that half — `save_quote` recomputes cost and profit server-side from `products.current_cost` before conversion, so only `create_direct_order` is exposed.)
6. Quick-delivery invoice posted before completion is never adjusted on partial completion; the follow-up delivery then bills the shortfall a second time.
7. Void-then-rebill of an order invoice permanently cancels the order's commissions, with no path that re-mints them.
8. Assigned driver can complete a delivery by direct table update (derived from the 2026-07-27 grants baseline — same defect as 2, reached from a different committed source).
9. `get_customer_year_end_summary` is an ungated `SECURITY DEFINER` RPC granted to `authenticated` — any role reads any customer's full financial history.
10. Sales reps can insert orders and order lines directly, bypassing every canonical order-creation effect and the confirmed-only status rule.

## Order of work

**`REMEDIATION-PLAN.md` is authoritative for sequencing and scope.** It is reproduced here in outline only; if the two ever disagree, the plan wins.

Nothing below is approved for implementation. Two gates come first: confirm the backups are fresh, and close the evidence gap with a live-catalog check, then an independent Codex triage whose reconciled list is what gets signed off.

Then, in order: **money fixes first** (double-billing, cancelled commissions, caller-controlled commission basis), **direct-write lockdown second** (the six-finding root cause — largest blast radius, wants a full test pass), **ungated read RPCs third**, **MED maintenance last**. Money leads because those bugs produce wrong numbers today, are self-contained, and are easy to verify.

Full detail, the LOW-findings triage, and the per-wave gates are in `REMEDIATION-PLAN.md`.

## Reproducing

```bash
# Re-run the review (read-only; ~90 min, high token cost) via the Workflow tool
# with workflow.mjs — first replace the hard-coded repo path in its reviewer
# prompt with this checkout's path, or every agent reads the wrong tree.

# Regenerate the HTML report from findings.json
node docs/audits/ordering-cycle-review-2026-08-09/build-report.mjs
```
