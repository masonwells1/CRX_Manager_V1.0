## 2026-09-30 — field-season delivery: exact attribution of the proof runs on PR #850

This corrects how `2026-09-30-field-season-review-round-fixes.md` describes its proof evidence. That
entry is left unchanged (CodeRabbit rounds 3–4 on PR #850).

- `npm run proof:field-app-season` ran twice on the delivery branch, both after the #844 merge
  (`b114e6c2d`):
  - while round 1's doc edits were uncommitted, with `supabase/migrations/` and `scripts/smoke/`
    byte-identical to `cce5e02dc`;
  - on the clean committed head `72abfb7cb`.

  Both printed `PREVIEW_SEASON_PROOF_PASS` (all phases) and `RECEIPT_GATE_NARROWING_PROOF_PASS`,
  exit 0. Later commits change docs only.
- This is delivery-branch evidence. It does not re-run the older reference comparison of
  `2026-09-13-field-app-cutover-reference.md`, and it does not replace the unrecorded
  "rerun on this head" results of `2026-09-20-restamp-…`.
- **Still pending:** the exact-head install proof on the owner-approval PR's checkout (the
  PRE-APPLY PROOF RULE binds it to the checkout the apply runs from), the four live applies, and
  their read-only post-apply checks.
