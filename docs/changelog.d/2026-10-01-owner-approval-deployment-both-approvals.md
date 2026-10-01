## 2026-10-01 — DEPLOYMENT.md names both approvals for a parked migration (CodeRabbit on PR #857)

CodeRabbit (Minor) noted that `DEPLOYMENT.md` named only the Windows Hello approval for a
destructive, data-overwriting or access-changing migration. It now says such a migration applies
only with BOTH Mason's explicit approval in the current conversation AND his Windows Hello approval
of that exact file, and that the apply gate verifies only the signature. The Edge Function wording
is unchanged.

Not changed (CodeRabbit, Major, same review): moving the pinned key and the Windows Hello helper to
a source the apply checkout cannot modify. That is the residual already recorded in
`docs/manual/DECISION_LOG.md` (2026-09-29, "Residuals"): the approval is as strong as the rule that
agents cannot edit the guard files, the same boundary every other gate relies on, and Mason accepted
it when he approved the design. Any check that runs on the same PC as the same Windows user can, in
principle, be edited by that user; committed changes to these files are reviewed by CodeRabbit and
Sol on the exact head the landing gate binds the approval to.

Proof: wording only; `npm run check:docs` passes. Not verified: no code, migration or production
deployment changed.
