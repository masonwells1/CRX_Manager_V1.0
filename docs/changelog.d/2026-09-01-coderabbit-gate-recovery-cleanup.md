## 2026-09-01 — the CodeRabbit final-review gate can no longer strand its own ready label

**Landing PR #516 on current `main`.** Three changes on top of the frozen candidate: one real
recovery-path defect, and two documentation claims that the 2026-09-01 manual-review-override
decision made false while this branch sat.

### The defect — a failed marker removal wedged the gate

`.github/scripts/coderabbit-final-review.cjs`'s outer recovery path removed
`coderabbit-review-requested` and then `ready-for-coderabbit` with two bare sequential `await`s. If
the first removal failed transiently, the second never ran and the workflow exited with the ready
label still attached. That is a **wedge, not a retry**: the label is already present, so no further
`labeled` event can fire, and the documented failed-gate behaviour — clear the ready label so the
operator can relabel — silently did not happen.

Both removals are now attempted independently through `removeLabelsIndependently()`, and any
cleanup failure is named in the `setFailed` message so the operator knows to remove the labels by
hand. The recovered-command branch reports its cleanup failure as a warning instead of throwing out
of the catch block.

**Proof.** Two new regression tests in `.github/scripts/coderabbit-final-review.test.cjs`
(87 assertions total, all green). Mutation-tested: reverting `removeLabelsIndependently` to rethrow
turns both new tests red — `a failed ready-label removal during recovery is reported, not thrown`
fails with the raw `label removal rejected for ready-for-coderabbit` error. Reverted; no residue.

Reported by Codex on PR #516 as a P2. It was correct.

### Two stale claims about administrator enforcement

This branch froze on 2026-08-30. On 2026-09-01 Mason took the manual review override, which set
`enforce_admins: false` on `main`'s classic protection. Two of this branch's own sentences instructed
the reader to verify that protection "still requires ... administrators" — a check that now fails by
design, and one that an agent following it would either report as a broken gate or, worse, treat as
licence to use the override.

Corrected in `AGENTS.md` and `.claude/skills/deploy-check/SKILL.md` (adapter regenerated via
`node scripts/sync-agent-workflows.mjs --write`) to state that administrators are deliberately exempt
since 2026-09-01 and that **no agent may act on that exemption**. Live state re-read before the edit:
`enforce_admins=false approvals=1 dismiss_stale=true last_push=true strict=true`.

### The bootstrap escape hatch made this PR unmergeable by construction

Found by bringing the branch up to date, not by reading. The workflow's
"the trusted script is legitimately absent from `main`" arm was pinned to a hardcoded
`github.event.pull_request.base.sha`. `main` requires a pull request to be **up to date** before it
can merge — so the base SHA necessarily changes before the merge, the pin necessarily stops matching,
and `final-review-gate` fails closed. The PR could satisfy the review gate or the branch-currency
gate, never both.

Re-pinned to PR number + head ref + base ref, all stable for the life of this pull request. The arm
is unreachable after the merge — the script is then on the default branch and the first test wins —
and its failure mode is a no-op, never a privilege gain.

### Merge conflict

`docs/manual/DECISION_LOG.md` conflicted on the newest-first prepend. Resolved by keeping both sides
in reverse chronological order — `main`'s two 2026-09-01 entries and four 2026-08-31 entries first,
then this branch's 2026-08-30 label-gate entry ahead of the existing 2026-08-28 entry. CRLF preserved.
