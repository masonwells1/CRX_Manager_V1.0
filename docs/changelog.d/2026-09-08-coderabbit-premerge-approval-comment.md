## 2026-09-08 — the `pre_merge_checks` comment still claimed an approval was required

Ninth Codex pass on PR #634. The `.coderabbit.yaml` header was corrected earlier in this PR, but a
second comment lower in the same file survived and still described the superseded rule:

> Mason's 2026-08-28 protection change now requires a current approval, so an unresolved failed
> check blocks the merge-unlocking approval…

`required_pull_request_reviews` was removed from `main` on 2026-09-02. No approval is required to
merge, so a failed pre-merge check cannot block one by withholding it. Left in place, this comment
would steer future configuration work back toward protection settings that lines 27-35 of the same
file now say do not exist.

Rewritten to describe what actually enforces the checks today: `request_changes_workflow` is on, so a
failed check can drive CodeRabbit to a `CHANGES_REQUESTED` verdict, and both agent merge gates
hard-deny a merge over `CHANGES_REQUESTED`. That is a real gate; an approval requirement is not.

Also carried the protection-API warning down to this comment, because this is exactly where someone
would go looking to "restore" the requirement: the `required_pull_request_reviews` sub-resource still
returns a phantom `required_approving_review_count: 1` that does not reflect what GitHub enforces
(verified 2026-09-02, after it misled two sessions in a row). Verify enforcement behaviourally with
`gh pr view <n> --json mergeStateStatus,reviewDecision` on a PR with no review.

Comment-only change; no configuration key was touched.
