# CodeRabbit native review requests

The operator applies `ready-for-coderabbit` after the candidate is frozen,
current, green and independently reviewed. The privileged `pull_request_target`
workflow runs trusted default-branch code and checks the actor's permission,
head, branch, draft/conflict state, auto-merge, check provenance and outstanding
review decision. After its quiet period and final checks, it records
`coderabbit-review-requested` and adds `coderabbit-review-dispatch`.

CodeRabbit's positive-label opt-in starts the review while automatic reviews
remain disabled. The provider label is separate from operator intent, so
applying the ready label cannot start a review before the trusted checks. The
workflow must find the configured provider label already present in the
repository; it never creates one.

GitHub does not restrict a label to one writer. Collaborators who can manage
labels can directly apply the provider label and potentially consume a review
before validation. This repair does not change collaborator permissions. Such
a label write cannot establish authorized reconciliation or merge clearance;
agents must use the trusted ready-label path, except for the explicitly approved
introducing-PR bootstrap below.

Provider documentation:

- [Automatic review controls](https://docs.coderabbit.ai/configuration/auto-review)
- [Feature-branch YAML configuration](https://docs.coderabbit.ai/getting-started/yaml-configuration)
- [Configuration reference](https://docs.coderabbit.ai/reference/configuration)

## Autonomous landing (Mason, 2026-09-26)

Mason's standing rule (see `docs/manual/DECISION_LOG.md`, 2026-09-26): once
CodeRabbit has reviewed the FINAL head with no unresolved objection, a fresh
exact-SHA `gpt-6-sol` high review of that head is clean, and every required
check is green, the agent merges by itself. The merge gates enforce it — both
`.claude/hooks/pr-merge-guard.mjs` and `.codex/hooks/production-action-guard.mjs`
deny a merge into `main` unless CodeRabbit's latest verdict is `APPROVED` on the
exact `headRefOid`, the newest run of every reported check is green with
`mergeStateStatus` CLEAN, and the Sol proof is bound to that head and to GitHub's
real base. `--auto` and `--admin` are refused.

Three plumbing changes made that loop possible without a person:

1. **The review no longer restarts CI.** `.coderabbit.yaml` sets
   `high_level_summary_in_walkthrough: true`, so CodeRabbit writes its summary into
   the walkthrough comment instead of the PR description. Writing the description
   was an `edited` event, `ci.yml` re-runs its ~11-minute required jobs on
   `edited`, and the lifecycle check that had just observed the review died
   `in_progress ... dispatch state was preserved` (PR #794, runs `36091053453` and
   `36091203653`, the second triggered by `coderabbitai[bot]`).
2. **The lifecycle check waits instead of failing.** With `checkSettleAttempts`
   configured (the trusted workflow sets 80 x 15 s = 20 minutes), the gate waits
   out running checks before dispatch and again after delivery, then runs its
   ordinary validation. Waiting only delays; it never credits anything. An
   unrelated metadata or label event during an in-flight dispatch now reports a
   neutral "still in flight" pass instead of a red row — the red row survived
   every rerun and stranded agent merges — while a READY event that no longer
   matches the live head/base still fails.
3. **The merge gates judge the newest run per check**, the way GitHub's own
   required-check evaluation does, so an early failed lifecycle run no longer
   outvotes the later green one.

## Delivery and clearance

The workflow observes reviews for up to six minutes and may wait up to twenty
minutes on each side for running checks, inside its fifty-minute job limit.
Success requires a submitted `coderabbitai[bot]` formal review on the frozen SHA
with a valid identity and submission time. An approval or a substantive
`COMMENTED` summary can prove delivery. A `CHANGES_REQUESTED` review proves
delivery but keeps the gate blocked. A queued/skipped status, empty `COMMENTED`
reply artifact or dismissed review is insufficient. Delivery is not merge
clearance: the merge gates additionally require CodeRabbit's `APPROVED` verdict on
the exact head.

Each normal native attempt records a head/base receipt tied to its trusted
Actions run before dispatch. A review must be submitted after that receipt;
reconciliation verifies the original run's workflow, actor and candidate and
requires both commits still to match. Receipts survive resets. A preexisting
same-head review with no receipt of this epoch cannot establish attribution:
that case (rare — e.g. a base-only retarget that keeps the head) still needs a
fresh delivery PR. The receipt and labels record attempts; neither establishes
merge authorization.

**The provider label is released once a review is observed.** As soon as the
workflow sees CodeRabbit's review of the dispatched head (whatever its verdict),
it removes `coderabbit-review-dispatch`, `coderabbit-review-requested` and the
ready label. The head's receipt stays on the PR as the dedupe record: re-applying
the ready label to that head **reconciles** against the receipt (verified
receipt, exactly one provider-label event after it inside the current epoch, a
review of this exact head submitted after the receipt) and never dispatches
again. Releasing matters because `auto_incremental_review` is now `true` (below);
a provider label left attached would let every later work-in-progress push buy an
unvalidated review.

The trusted workflow records the original `opened` webhook's head and base.
Its opened job reports `CodeRabbit candidate snapshot`, a separate check context;
snapshot success never reports completed review delivery. Other events report
`CodeRabbit candidate lifecycle`, including ignored and reset outcomes. A green lifecycle
check never attests review delivery; actual authenticated exact-head formal review and
disposition of every real finding remain mandatory before merge.
Its run name also includes the action, PR number, both original SHAs and the independent
execution SHA from the trusted default branch; execution is provenance, never the PR base.
All three SHAs are validated independently, and the execution value must match the
authenticated original run name. Receipt inspection checks that name on the
authenticated original workflow run. Later REST PR and activity-event payloads can
expose current values, so they cannot reconstruct this original context. The
snapshot comment is an index to that run, never a grant of authority. Missing,
edited, duplicate or mismatched snapshots block dispatch before provider quota is
spent.

## Same-PR follow-up reviews (candidate epochs)

Until 2026-09-26 a review was bound to the head/base the `opened` webhook
captured for the whole life of the PR, so every fix round needed a replacement
PR (the field-invoice fix went through about fourteen). The reason — a late
review of an OLD candidate must never be credited to a new request — is kept;
only its unit shrank from "the PR" to "the candidate epoch".

- A push (`synchronize`), a `reopened`, or a base retarget (`edited` with a base
  change) resets the workflow labels as before and then, after a clean reset,
  records a `crx-coderabbit-candidate-epoch:v1` comment from that event's own
  webhook head and base. It is verified later exactly like the birth: parsed only
  from an unedited `github-actions[bot]` comment, bound to the PR, repository and
  PR creation time, and matched against the immutable run name
  `CodeRabbit gate <action> PR <n> head <head> base <base> execution <sha>` of a
  completed, successful run of this trusted workflow, recorded inside that run's
  lifetime.
- The newest birth/epoch record must describe the live head and base. If it does
  not — the synchronize run has not finished, it failed, or the PR predates epochs
  — dispatch is refused with guidance to wait for (or trigger, by pushing) the
  trusted run. No replacement PR is needed.
- Receipts, provider-label events and history-rewrite events (`base_ref_changed`,
  force pushes) from before the current epoch belong to earlier candidates and are
  ignored. Inside the epoch the one-candidate rules apply unchanged: an untracked
  or duplicate provider-label event, a history rewrite, or a receipt for another
  head/base blocks. An event whose timestamp cannot be read is never excluded.
- `auto_incremental_review` is `true`, because per CodeRabbit's documentation a PR
  first reviewed because of a positive label is only re-reviewed while that
  setting stays true (with it false, a relabel at a new head was observed to skip
  with `incremental reviews are disabled`). Work-in-progress pushes stay
  unreviewed because the positive label is attached only during a validated
  dispatch window and every push resets it.
- **A stale CodeRabbit objection does not block its own follow-up.** When the
  only outstanding `CHANGES_REQUESTED` is CodeRabbit's, recorded against an older
  commit, the gate lets the ready label request the follow-up review — that is
  the review that can clear it. A human reviewer's objection, or CodeRabbit's at
  the current head, still refuses. The merge gates still deny while the aggregate
  `reviewDecision` is `CHANGES_REQUESTED`.

The loop for a fix is therefore: fix, push to the same PR, wait for checks, run
the exact-SHA Sol proof, apply `ready-for-coderabbit`, and merge once CodeRabbit
approves the new head. Never post `@coderabbitai` commands by hand and never use
`@coderabbitai resume`.

The run API's `head_sha` can expose either the PR head or the execution base.
It is separate from `GITHUB_SHA`; both candidate commits must match the run's
associated pull-request record, regardless of that metadata form. Repository
run `34699373055` is an observed PR-head example.

Read and resolve all real findings, including findings outside the diff, before
merge. Delivery success is not merge clearance. All existing exact-head,
independent-review, CI and merge gates still apply. The legacy comment transport
remains available to its regression suite and legacy-state recovery; the trusted
production workflow explicitly selects native dispatch.

## Pending or uncertain requests

Unspent cleanup rechecks provider-label absence after removing a receipt and
after clearing labels. A raced or unknown cleanup restores the requested
marker and preserves the original receipt details as recovery evidence. This
evidence is deliberately not a replacement dispatch receipt and cannot credit
a late review with a newly created timestamp.

A provider-label write may have succeeded even when its HTTP response fails.
Timeouts, missing review evidence and ambiguous writes therefore fail closed
and preserve dedupe state. Do not clear and re-add the provider label to retry.
Read the actual review and current candidate state first. When a matching review
has arrived after the observation window, re-apply `ready-for-coderabbit` to
reconcile that existing dispatch without requesting another review.
Only a fresh ready-label event from an authorized actor can reconcile delivery,
and that authorization is bound to the event's validated commit. Labels alone
cannot prove authorization: lower-permission collaborators can manage labels.
Unrelated label and metadata events therefore preserve dispatch state; since
2026-09-26 they report a neutral pass rather than a failure, and they still
cannot reconcile, credit or release anything.

A head change or deliberate invalidating reset clears workflow labels, but
removing a provider label cannot cancel an already accepted review. Before any
deliberate retry, check for late review delivery and other active requests.
Incomplete native state remains blocked; old command comments do not prove a
native request was unspent. No manual command bypass or new credential is part
of this repair.

## Introducing this workflow

The old default-branch workflow cannot attach the new provider label, while the
repair PR must receive a real review before merge. Finish a concrete PR and
obtain Mason's exact one-time authorization to create
`coderabbit-review-dispatch` and apply it once to that frozen repair PR.

Before that action, independently verify the head/base, clean/current branch,
non-draft/conflict-free state, auto-merge off, all required checks with trusted
provenance, no outstanding changes request, exact-SHA protected Sol review and
resolved GitHub Codex findings. Use trusted current-main code or direct read-only
GitHub metadata; never execute PR code with a write credential.

CodeRabbit documents that it reads the feature branch's YAML. Observe the real
review for that SHA, resolve its findings, refresh every changed/stale gate, and
only then use the normal protected merge path. After merge, observe one normal
ready-label request through the trusted default-branch workflow. Until those
observations exist, distinguish local verification, bootstrap review and live
workflow verification in the status report.

A change to this workflow, `.coderabbit.yaml` or the merge gates is judged by the
copies already on `main`, so it cannot pass its own new rules: Mason merges such a
PR by hand, once (as with #796 and the 2026-09-26 autonomous-landing PR).

Rollback uses a scoped protected revert. A revert does not cancel already
dispatched reviews; inspect and preserve their evidence before another request.
