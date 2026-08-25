# Remediation Plan — Ordering Cycle Review

Companion to `FINDINGS.md`. This is the proposed scope and order of work, so the local session (and Codex) start from a settled plan rather than re-litigating 77 findings.

**Status: proposed. Nothing here is approved for implementation yet — the Codex triage in Step 2 comes first.**

## Count the backlog by fix, not by finding

The finders were never reconciled against each other, so six defects are counted twice or more (full table in `README.md`). 77 findings is roughly **69 distinct defects**. The duplicates are not noise — the second finder usually names another caller or a detection gap — but they belong to one fix each. Check for further overlap during the Step 2 triage.

## Scope decisions

**LOW findings are triaged, not fixed wholesale.** Of the 31, nine are cheap and genuinely worth doing; the rest are parked as known-and-accepted. Fixing all 31 would add churn and review surface for no real gain.

Keep (fold into the wave that already touches that area):

| Finding | Why keep |
|---|---|
| `create_direct_order` performs no cent rounding anywhere | Money correctness; fractional cents reach `order_items`/`orders` and the commission basis |
| Mint-time penny reconciliation can compute a negative commission | Aborts the whole order conversion — a crash, not a cosmetic issue |
| QuoteBuilder client totals use a different rounding formula than `save_quote` | Displayed money differs from stored money |
| `generate_order_number()` / `generate_quote_number()` EXECUTE-able by anon | Logged-out visitor can burn the sequences; one-line REVOKE |
| `invoices_select` / `invoice_items_select` granted to PUBLIC, no role or `is_active` predicate | Cheap policy tightening in the same wave as the other RLS work |
| Voided orders still offer Edit / Create Invoice / Schedule Delivery | UI gate tests `fulfilled`/`cancelled` but never `voided`; small, user-visible |
| Quotes list Duplicate reuses a stale page-scoped idempotency key | Same class as the MED idempotency-key findings; fix together |
| `duplicate_quote` silently drops `is_planned` / `needed_by_date` | Small, and it silently loses booking intent |
| `QUOTE_TO_DELIVERY.md` documents 7 of 9 statuses and names a nonexistent `prepay_credits` column | Docs drift that will mislead the next reviewer |

Park the remaining 22 LOW findings. They stay recorded in `FINDINGS.md`; revisit only if one surfaces in real use.

**Order of work: money first, direct-write lockdown second.** The money bugs are actively producing wrong numbers today, are self-contained, and are easy to verify — good ground to build confidence on. The direct-write lockdown is the largest blast radius in the set and benefits from being done deliberately rather than first.

## Sequence

Every wave: its own branch, its own PR, CodeRabbit, and a `codex-gauntlet` gate. All four waves touch money, RLS, or migrations, so the exact-SHA `gpt-5.6-sol` high-effort proof is mandatory on each — none of them qualify as "ordinary reversible code".

### Step 0 — Confirm the backups are fresh
Two automated weekly backups already run: an encrypted off-site `pg_dump` to the private `CRX_Backups` repo, and an in-database `pg_cron` snapshot (`backup_snapshots`, migration `20260713050000`). Neither is point-in-time recovery, and the in-database copy does not survive a database-level disaster. Verify both ran recently — and that the off-site one is restorable — before starting. Gates everything below.

### Step 1 — Close the evidence gap
**No phase queried the live database.** Phases 1–2 read on-disk migrations; phase 3 added the 2026-07-27 grants baseline, which is a snapshot rather than current state. Pull the **live** bodies of `_enforce_quote_status_transition`, `revert_quote_status`, `restore_quote_version`, `convert_quote_to_order`, `create_direct_order`, `complete_delivery`, `void_invoice`, plus live grants and policies on `quotes` / `orders` / `deliveries` / `order_items`. Diff against the repo and the baseline. Any finding whose live body differs must be re-read before it becomes work. This step is what turns the review from file-derived into fact.

### Step 2 — Codex triage and reconciliation
Independent `codex-review` (gpt-5.6-sol, high effort) over `FINDINGS.md` + cited files + the Step 1 live evidence. Per-finding verdict: real / not real / already mitigated, with its own severity. Then `agent-pair-review` to surface only the disagreements between Codex and this review. **The reconciled list is the approval artifact** — Mason signs off on that, not on the raw 77.

### Wave A — Money (3 HIGH + related)
- Quick-delivery invoice posted before completion never adjusted; follow-up delivery double-bills the shortfall
- Void-then-rebill permanently cancels an order's commissions with no re-mint path
- Caller-controlled cost drives the commission basis on `create_direct_order` — **this seam only**. The finding's title names `convert_quote_to_order` as well, but its own verifier refuted that half: `save_quote` overwrites every line's cost and profit from `products.current_cost` before conversion, so the basis it passes is already server-computed. Do not touch `convert_quote_to_order` for this; changing a money path that is not broken is added risk, not caution.
- Plus the four money/commission LOW items kept above

Verification: real-path proof on each — run the flow, observe the invoice and commission rows, not just a passing test.

### Wave B — Close the direct-write lane (6 HIGH)
The six findings that share one root cause: safety logic lives in the RPCs while the tables stay directly writable by the same roles.
- Quote `accepted → sent` trigger edge (note: `QuoteBuilder.tsx:2686` is a residual consumer — the arm cannot simply be deleted; gate it on admin override or order-existence)
- Deliveries walkable to `completed` by direct update, by any sales rep or the assigned driver — one fix covering both the `state-machines` and `rls-security` findings, which reached it from the migrations and the grants baseline respectively (both offline sources, not a live confirmation)
- Quote soft delete leaking planned/crop-program holds — one fix covering four findings, including the parity check that should have detected it
- Sales reps inserting orders and order lines directly

Highest blast radius in the set. Needs a full test pass and a careful look at every legitimate caller before permissions tighten.

### Wave C — Gate the ungated read RPCs (1 HIGH + MED siblings)
`get_customer_year_end_summary`, `check_customer_credit_limit`, `get_customer_summary`, `global_search` — all `SECURITY DEFINER`, all granted to `authenticated`, none checking the caller. Add role checks. Small and low-risk. Include the two LOW grant fixes kept above.

### Wave D — MED maintenance (36, batched)
Missing `deleted_at` filters (the soft-deleted draft invoice that permanently hides Create Invoice), reused page-scoped idempotency keys on Quotes and Deliveries, the three inconsistent AR derivations, and the reporting/docs drift items. Group into 2–3 PRs by area rather than one large diff.

## Open follow-ups on the record itself

Found while writing this up. None affect a finding's validity — they are defects in the summary layer and its tooling. Fix opportunistically; nothing here blocks remediation.

| Item | Where | Why it matters |
|---|---|---|
| The hold-leak summary overstates the dated case | `README.md` HIGH item 3, and the same wave text in `report.html` | It says orphaned holds shrink available stock **forever**. True only when the booking has no `needed_by_date` — then `expires_at` is NULL and the hold never expires. With a date set, `expires_at` is `needed_by_date + 14 days` and the inventory queries filter expired holds, so the dated case is a temporary capacity distortion plus an unreclaimed row. The defect is real either way; the permanence claim is not. Confirmed in the finding's own verifier text (`20260702171000:101`). |
| The report's remediation prose is hand-written, not generated | `build-report.mjs` wave list | Totals and severity counts regenerate from `findings.json`, but the wave text does not. If triage refutes or demotes a money finding, the report would still name three money fixes beside totals that disagree. Mitigated today by the section stating `REMEDIATION-PLAN.md` is authoritative — but the mitigation is a sentence, not a mechanism. Raised by Codex on PR #356. |
| A killed agent is indistinguishable from a clean one | `workflow.mjs` finder/verifier error handling | The harness returns `null` for an agent that dies on a terminal API error, and the script turns that into a finder with zero findings; failed verifiers are dropped rather than flagged. A re-run interrupted mid-flight would publish partial coverage that reads as complete. This run's totals came from a pass reporting 112/112 agents with zero errors — but the next run needs that checked explicitly. Details in `README.md` under *Method*. |
| The workflow embeds one session's absolute repo path | `workflow.mjs` reviewer prompt | Re-running from any other checkout points all agents at a directory that does not exist. Documented in `README.md`; kept unedited so the file stays a faithful record of what ran. |

If a Step 2 triage verdict changes, remember `build-report.mjs` now honours `verdict.refuted` and derives the distinct-defect estimate — edit `findings.json`, run `node docs/audits/ordering-cycle-review-2026-08-09/build-report.mjs` from the repository root, and do not hand-edit `report.html`.

## Out of scope

- The 22 parked LOW findings.
- Anything not in `FINDINGS.md`. If a wave uncovers a new issue, record it rather than widening the diff.
