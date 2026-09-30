## 2026-09-30 — field-season delivery: CodeRabbit round 1 on PR #850

Fixes for CodeRabbit's gate-dispatched review of `cce5e02dc` (CHANGES_REQUESTED, 4 threads):

- **Major, re-run the proof on the current head.** `npm run proof:field-app-season` was re-run on
  this branch and printed `PREVIEW_SEASON_PROOF_PASS` (all phases) and
  `RECEIPT_GATE_NARROWING_PROOF_PASS`, with exit 0. `supabase/migrations/` and `scripts/smoke/`
  are byte-identical to the reviewed head `cce5e02dc` (`git diff --quiet` passed); this round
  changes docs only. The PRE-APPLY PROOF RULE now binds the proof to the exact head of the checkout
  the apply runs from. Since 2026-09-30 that is the owner-approval PR, so it is re-run there on
  install day.
- **Minor, changelog entries lacked observed results.** The 2026-09-13 cutover-reference entry and
  the 2026-09-20 restamp entry now say that their results were not recorded at the time, point to
  this proof, and name what is still unverified (the live applies). The 2026-09-30 quiet-database
  entry states its doc-drift check and that no live query or apply was run.
- **Minor, over-long DECISION_LOG entries.** The 2026-09-22 (49 → 7 lines) and 2026-09-08
  (28 → 7 lines) entries now keep the source, decision, rule and an evidence pointer. The
  measurement table and full history moved verbatim into `migration-history.md`.
- **Minor, receipt wait wording.** `rpc-functions.md` now tells operators to wait only for the
  BLOCKING receipts: unexpired ones that resolve to a field-application invoice or cannot be
  identified.

Not verified: no migration was applied and no live query was run. `node scripts/check-doc-drift.mjs`
passed.
