## 2026-09-30 — field-season delivery: CodeRabbit round 1 on PR #850

Fixes for CodeRabbit's gate-dispatched review of `cce5e02dc` (CHANGES_REQUESTED, 4 threads):

- **Major, re-run the proof on the current head.** `npm run proof:field-app-season` printed
  `PREVIEW_SEASON_PROOF_PASS` (all phases) and `RECEIPT_GATE_NARROWING_PROOF_PASS`, exit 0, in two
  runs, both after the #844 merge (`b114e6c2d`):
  - on this branch while round 1's doc edits were uncommitted, with `supabase/migrations/` and
    `scripts/smoke/` byte-identical to `cce5e02dc`;
  - on the clean committed head `72abfb7cb` (round 3).

  The commits that follow change docs only. This is delivery-branch evidence, not install
  evidence: the PRE-APPLY PROOF RULE binds the proof to the exact head of the checkout the apply
  runs from. Since 2026-09-30 that is the owner-approval PR, and the exact-head proof there is still
  PENDING until install day.
- **Minor, changelog entries lacked observed results.** Recorded here rather than in the older
  entries, which stay unchanged (round 2: "one file per change; do not append to someone else's
  entry"):
  - `2026-09-13-field-app-cutover-reference.md`: the outcome of its reference-vs-migration
    comparison was not recorded when it was written. The nearest later evidence is the `72abfb7cb`
    proof run above; it is not a re-run of that comparison. Production apply was not verified:
    neither phase is applied live.
  - `2026-09-20-restamp-the-unchanged-date-correction-and-close-the-review-round.md`: its "rerun on
    this head" results were not recorded. The nearest later evidence is the `72abfb7cb` proof run
    above. Still open: the four migrations' live applies, the exact-head proof on the owner-approval
    checkout, and the read-only post-apply checks.
  - The 2026-09-30 quiet-database entry, added on this branch, states its doc-drift check and that
    no live query or apply was run.
- **Minor, over-long DECISION_LOG entries.** The 2026-09-22 (49 → 7 lines) and 2026-09-08
  (28 → 7 lines) entries now keep the source, decision, rule and an evidence pointer. The
  measurement table and full history moved verbatim into `migration-history.md`.
- **Minor, receipt wait wording.** `rpc-functions.md` now tells operators to wait only for the
  BLOCKING receipts: unexpired ones that resolve to a field-application invoice or cannot be
  identified.

Not verified: no migration was applied and no live query was run. `node scripts/check-doc-drift.mjs`
passed.
