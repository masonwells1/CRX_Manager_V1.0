# CodeRabbit native review requests

The operator applies `ready-for-coderabbit` after the candidate is frozen,
current, green and independently reviewed. Complete and freeze the candidate
before opening its delivery PR. The privileged `pull_request_target`
workflow runs trusted default-branch code and checks the actor's permission,
head, branch, draft/conflict state, auto-merge, check provenance and outstanding
review decision. After its quiet period and final checks, it records
`coderabbit-review-requested` and adds `coderabbit-review-dispatch`.

CodeRabbit's positive-label opt-in starts the review while automatic reviews
and push-driven incremental reviews remain disabled. The provider label is
separate from operator intent, so applying the ready label cannot start a
review before the trusted checks. The workflow must find the configured
provider label already present in the repository; it never creates one.

GitHub does not restrict a label to one writer. Collaborators who can manage
labels can directly apply the provider label and potentially consume a review
before validation. This repair does not change collaborator permissions. Such
a label write cannot establish authorized reconciliation or merge clearance;
agents must use the trusted ready-label path, except for the explicitly approved
introducing-PR bootstrap below.

Provider documentation:

- [Automatic review controls](https://docs.coderabbit.ai/configuration/auto-review)
- [Feature-branch YAML configuration](https://docs.coderabbit.ai/getting-started/yaml-configuration)

## Delivery and clearance

The workflow observes reviews for up to six minutes, leaving time for validation
and cleanup inside its ten-minute job limit. Success requires a submitted
`coderabbitai[bot]` formal review on the frozen SHA with a valid identity and
submission time. An approval or a substantive `COMMENTED` summary can prove
delivery; an approving verdict is not newly required. A `CHANGES_REQUESTED`
review proves delivery but keeps the gate blocked. A queued/skipped status,
empty `COMMENTED` reply artifact or dismissed review is insufficient.

Each normal native attempt records a head/base receipt tied to its trusted
Actions run before dispatch. A review must be submitted after that receipt;
reconciliation verifies the original run's workflow, actor and candidate and
requires both commits still to match. Receipts survive resets. A preexisting
same-head review or retained attempt cannot establish attribution for another
base: create a fresh delivery PR before another request, then close the superseded PR as described below. The receipt and labels
record attempts; neither establishes merge authorization.

The trusted workflow records the original `opened` webhook's head and base.
Its opened job reports `CodeRabbit candidate snapshot`, a separate check context;
snapshot success never reports completed review delivery. Other events report
`CodeRabbit candidate lifecycle`, including ignored and reset outcomes. A green lifecycle
check never attests review delivery; actual authenticated exact-head formal review and
disposition of every real finding remain mandatory before merge.
Its run name also includes the action, PR number, both original SHAs and the independent
execution SHA from the trusted default branch; execution is provenance, never the PR base.
All three SHAs are validated independently, and the execution value must match the
authenticated original run name. A changed live PR head or base still requires a fresh PR. Receipt
inspection checks that name on the authenticated original workflow run. Later
REST PR and activity-event payloads can expose current values, so they cannot
reconstruct this original context. The snapshot comment is an index to that
run, never a grant of authority. Missing, edited, duplicate or mismatched
snapshots block dispatch before provider quota is spent.

Normal delivery requires the candidate to retain its original head and base
for the whole PR lifetime. Changed candidates, retargets and head/base force
pushes require a fresh delivery PR. This prevents an old command from another
base being credited to a new request, without guessing the commenter's historical
permission or asserting that CodeRabbit ignores public commands. Manual comments
on an unchanged candidate cannot change its review context and remain preserved;
they never authorize a dispatch or merge. The active dispatch receipt still needs
exactly one provider-label event. Untracked or duplicate provider-label attempts
remain blocked and require a fresh PR.

The positive opt-in label delivered a first review but a same-PR follow-up at
another head was observed to skip with `incremental reviews are disabled`.
Keep `auto_incremental_review: false`: enabling it could spend quota on an
unvalidated push. Finish corrections and required checks before opening a fresh
delivery PR. As soon as the fresh PR exists, close the previous PR with a comment
naming its replacement (`Replaced by #N`); do not leave it open "as the record".
Closing keeps the branch, commits, comments and findings, is reversible, and the
`closed` event only resets that PR's own workflow labels. Leaving superseded PRs
open buried real work under about 40 stale copies by 2026-09-14. If a manual or
status document names the old PR as a task owner, point it at the new PR. PRs opened
before the trusted opened capture becomes available also need a fresh PR for
normal native delivery. The introducing repair uses only the approved bootstrap.

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
Unrelated label and metadata events therefore preserve dispatch state and stay
blocked until an authorized ready action occurs.

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

Rollback uses a scoped protected revert. A revert does not cancel already
dispatched reviews; inspect and preserve their evidence before another request.
