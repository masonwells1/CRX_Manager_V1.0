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

### An ambiguous comment post skipped revalidation (Codex P2)

When `createComment` errored *after* GitHub had actually accepted the command, the recovery branch
returned `requested` immediately — skipping the post-comment head/base/auto-merge/check snapshot the
confirmed path runs. A change racing that ambiguous post therefore left the command standing and
spent a CodeRabbit review on an unfrozen candidate: the exact failure this gate exists to prevent.

A recovered command is a **posted** command, so it now falls through to the same revalidation, and the
raced comment is deleted like any other. The `recovered` flag is preserved on the success return.
Regression test added and mutation-proved: restoring the early return turns it red.

### The same sequential-await defect in `resetLabels` (Codex P2)

Fixing the recovery path left the identical shape in `resetLabels`, which is the hotter path — every
push, reopen, draft conversion, base edit and auto-merge change goes through it. A transient failure
on the first removal skipped the second, leaving a stale `coderabbit-review-requested` marker on a
candidate the gate had just invalidated, which the outer recovery then *preserves*. Both removals are
now attempted, and a half-cleared reset throws rather than reporting a clean `reset`, so the caller
cannot mistake stale gate state for a fresh candidate. Regression test, mutation-proved.

### Duplicate-review risk, and two copies of the same rule that had diverged

Three findings from the review of the frozen candidate. All three are the *same* underlying
mistake — a rule written out more than once, where the copies stopped agreeing.

**An unverifiable lookup cleared the dedupe marker (Codex P2 and CodeRabbit Major, found
independently).** When `createComment` failed *and* the recovery `listComments` also failed, the gate
could not know whether GitHub had accepted the command — yet it removed
`coderabbit-review-requested` and invited a relabel, which would post a **second paid review** for the
same head. A confirmed absence and an unverifiable lookup are different states and no longer share a
branch; the marker is preserved when the lookup itself failed, matching what the outer recovery path
already did. Neither reviewer found a test covering the double-failure path, correctly — there wasn't
one. Added, and mutation-proved.

**The `edited` branch had lost the confirmation re-read (CodeRabbit Major).** One reconciliation
sequence was implemented three times, and the copies had diverged: the metadata-edit copy omitted the
post-lookup re-read the others perform, so a head change or marker removal racing the command lookup
was reported there as a confirmed **duplicate** while every other path **reset**. The branch now
delegates to `reconcileLabelEvent` with only its reason prefix varying — about 55 lines of copy
removed. Regression test asserts the edit path now emits `changed_live_state` on a raced head.

**Two validators repeated six security conditions (CodeRabbit Major).** `validatePullRequest` is now
derived from `validateAuthorizationState` and adds only the two checks specific to a ready-label
candidate. A property test asserts every shared reason still surfaces, so a future re-duplication
that drops or weakens a condition fails the suite rather than silently letting one path accept what
the other rejects.

### Three stale claims about administrator enforcement

Three, not two: `.claude/commands/ship.md` carried the same instruction and was missed on the first
sweep. It is the worst place for it — every `/ship` run reaching the merge step would verify a rule
that is deliberately off, so a policy-compliant agent would block **every** otherwise-ready landing.
Corrected, adapter regenerated. (Found by Codex, correctly, as a P1.)

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
