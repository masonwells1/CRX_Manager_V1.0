# Codex Triage — Ordering Cycle Review (Step 2)

Independent second-model triage of all 77 findings. **This is the approval artifact.** Mason signs off on this, not on the raw 77.

Reviewer: `gpt-5.6-sol`, high reasoning effort, read-only sandbox, run 2026-08-10 against branch `claude/ordering-cycle-live-evidence`. Three runs, one per review phase. Each was given `FINDINGS.md` plus `LIVE-EVIDENCE.md`, and told that where the live production evidence contradicts the paper findings, **the live evidence wins**.

## Bottom line

**Codex confirmed 75 of 77 findings as real. It refuted none.** One finding is already fixed in production; one cannot be settled without a live measurement. Seven findings had their severity or scope changed. The remediation plan's shape survives — money first, then the direct-write lockdown — with two additions to the HIGH tier and one item removed from Wave A.

| | Original review | After Codex triage |
|---|---|---|
| HIGH | 10 | **12** |
| MED | 36 | **35** |
| LOW | 31 | **30** |
| Total | 77 | 77 |
| Verdicts | — | 75 real · 1 already fixed · 1 unprovable · **0 refuted** |

**A triage that refutes nothing deserves a hard look, so state the reason plainly:** these 77 are not raw finder output. The original review already put every claim through an adversarial verifier instructed to refute it, and that pass dropped 26 claims into `REFUTED.md`. Codex was triaging pre-filtered survivors, not a raw list. That makes a near-zero refutation rate credible rather than suspicious — but it also means Codex is corroborating a filter it did not itself apply. It is not an independent re-derivation of the 26 refusals.

## The seven disagreements

Everything else, Codex agreed with on both verdict and severity. These are the only places the second model departed from the review.

### 1. Caller-controlled cost — scope confirmed narrower (no change needed)

> The overall finding is REAL, but its two-seam scope is wrong: `convert_quote_to_order` is mitigated; only `create_direct_order` remains exposed.

**Agree — and the plan already says this.** `REMEDIATION-PLAN.md` Wave A already scopes this to `create_direct_order` only, on the strength of the original verifier's refutation of the other half. Codex reached the same narrowing independently, from the source, without being told. That is genuine corroboration of the most consequential scoping call in the plan. **No change.**

### 2. NaN/Infinity in money and quantity fields — MED → HIGH

> One accepted payload can persist non-finite inventory and money values that break later billing and require data repair.

**Agree.** A value that is not a number reaching a stored money or inventory column is not a cosmetic defect — it fails later, somewhere else, and needs manual data repair to undo. Promote to HIGH and fix in **Wave A**, not Wave D.

**But see the batching caveat below — Codex rated this same defect MED in a different run.**

### 3. `jobs.commission_split` directly writable — MED → HIGH

> I rate an ownership-bypass that can silently redirect employee pay with no audit trail as HIGH.

**Agree.** This is money routing with no validation, no lock, and no audit record, in the window between scheduling a job and invoicing it. Silent misrouting of employee pay with no trail is a HIGH by the same standard that put the other commission findings there. Promote and fold into **Wave A**.

### 4. `quotes.total_cost` unrounded — MED → LOW

> The remaining defect is LOW because live code eliminated the commission-liability drift and left only the quote header's sub-cent identity mismatch.

**Agree.** The money-correctness half of this was closed by live code; what remains is a display-level identity that does not tie out to the cent on the quote header. Real, worth fixing, not urgent. Demote to LOW, handle in **Wave D**.

### 5. `allocate_payment` unlocked version — LOW → MED

> The same fail-closed cash-application defect rated MED in the earlier separate finding, with a misleading message that can make a clerk believe the payment already exists.

**Agree, and note what Codex did here:** it recognised this as a duplicate of a MED finding elsewhere in the same batch and aligned the two severities itself. The user-facing consequence is the part that matters — a clerk sees an error implying the payment already exists, when it does not. Promote to MED.

### 6. `customers.default_commission_split` readable by field roles — LOW → MED

> API exposure of internal compensation attribution and adjacent customer financial fields to field roles is a meaningful confidentiality gap.

**Agree.** Drivers, applicators and location-dispatchees can read internal pay-attribution data through the customer row policies. That is a confidentiality gap, not a nitpick. Promote to MED and fix in **Wave C** alongside the other read-gating work.

### 7. Integrity report pagination — REAL → UNPROVABLE FROM REPO

> The repository proves missing pagination but cannot prove that production's configured cap and present row counts are already truncating these queries.

**Agree, and this is the right kind of caution.** The missing pagination is proven from the code. Whether it is *currently* silently truncating depends on the live row cap and live row counts, neither of which was measured. The fix is worth doing either way; the claim that it is actively producing wrong numbers today is not yet evidenced.

## One finding is already fixed — with a catch

**`create_direct_order` performs no cent rounding — verdict: ALREADY MITIGATED.**

Verified independently rather than taken on trust. The applied migration `20260810150000_commission_basis_from_canonical_order_header.sql` rounds the line accumulators (line 388), rounds the money written into `order_items` (lines ~434–436), and re-reads a rounded canonical `orders.total_profit` as the commission basis (line 467). All three effects named in the finding's own title are closed.

**The catch: that migration is applied to production but is not in `origin/main`, and has no pull request.** It lives on one unmerged branch. So this defect is fixed in the live database and in one person's branch — and not in the shared codebase. If that branch is ever abandoned, production keeps the fix and the repository silently loses it. **This is a drift risk that outlives the audit, and it is worth raising on its own.**

Remove this item from Wave A's kept-LOW list. Do not remove it from the record.

## Limitation: the triage was batched, and duplicates cross the batches

I split the triage into three runs by review phase, one per Codex process. That was a cost and reliability decision, and it has a consequence worth stating rather than burying.

`README.md` records six known duplicate pairs — the same defect found by two finders. **Five of those six span two different phases**, so the two halves were triaged by two Codex runs that could not see each other. Only the `allocate_payment` pair fell inside one batch, and that is the one pair Codex reconciled itself (disagreement 5 above).

**This produced exactly one visible inconsistency:** the NaN/Infinity defect was rated **HIGH** in the Phase 1 run and **MED** in the Phase 2 run — by the same reviewer, on the same defect, in two batches. I have taken the HIGH, per disagreement 2, on the strength of its stated reasoning.

I checked the other four cross-batch pairs for the same problem. They are consistent: the quote-soft-delete leak (HIGH/HIGH/MED/MED), the delivery walkable-to-completed pair (HIGH/HIGH), the order-detail `deleted_at` pair (MED/MED), and the quote `accepted → sent` pair (HIGH/LOW) all match the original review's split. **One inconsistency out of five cross-batch pairs.**

## What this triage does NOT settle

- **The 26 refuted claims were not re-examined.** Codex triaged the 77 survivors. If a refutation was wrong, this pass would not catch it.
- **Nothing here was executed against production.** Codex ran read-only against source and the Step 1 live-evidence document. It measured no live state itself.
- **One finding is explicitly unmeasured** — the integrity-report truncation, above.
- **Codex agreed with the review's own duplicate-collapsing.** It did not independently search for further overlap beyond the pair it caught, so the "roughly 69 distinct defects" figure is still the original review's estimate, not a verified count.

## Effect on the remediation plan

| Wave | Change |
|---|---|
| **A — Money** | **+2 promoted in:** NaN/Infinity rejection, and `jobs.commission_split` write guard. **−1 removed:** `create_direct_order` cent rounding (already fixed live). |
| **B — Direct-write lockdown** | No change. All six HIGH findings confirmed real at HIGH. |
| **C — Ungated read RPCs** | **+1:** `customers.default_commission_split` exposure joins this wave. |
| **D — MED maintenance** | **+1:** `quotes.total_cost` demoted in from MED. |

The plan's central judgement — money first, direct-write lockdown second — is unchanged and now has a second model behind it.

## Recommended next step

**Get Mason's sign-off on this reconciled list, then run Step 0 (the backup freshness check) before Wave A touches anything.** The Step 0 waiver Mason granted covered the read-only evidence work only; it expires the moment remediation starts writing.

Separately and sooner: **the unmerged `20260810150000` migration should get a PR.** A production fix living on one unmerged branch is a drift risk regardless of what this audit does next.
