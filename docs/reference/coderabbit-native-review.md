# CodeRabbit native review requests

The operator applies `ready-for-coderabbit` after the candidate is frozen,
current, green and independently reviewed. The privileged `pull_request_target`
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

Read and resolve all real findings, including findings outside the diff, before
merge. Delivery success is not merge clearance. All existing exact-head,
independent-review, CI and merge gates still apply. The legacy comment transport
remains available to its regression suite and legacy-state recovery; the trusted
production workflow explicitly selects native dispatch.

## Pending or uncertain requests

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
