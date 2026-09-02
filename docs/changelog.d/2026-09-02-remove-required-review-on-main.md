## 2026-09-02 - Remove the required review on `main`; CI becomes the merge gate

**Mason, 2026-09-02.** `required_pull_request_reviews` was deleted from classic branch protection
on `main`. A pull request now merges with no approving review.

## Why

The approval requirement was the only merge gate that could wedge with nothing green to do about
it. CodeRabbit is a shared, rate-limited fleet allowance; when it was down, throttled, or stuck,
`main` became unmergeable and the only escape was the 2026-09-01 administrator override — reserved
to Mason by hand and forbidden to every agent. Routine landings depended on Mason being present.

## What did NOT change

Removing the review did not remove the tests. Verified live immediately after the change:

- `SQL Migration Validation` and `Lint, Type Check, Test, Build` still required
- `strict` (branch must be up to date with `main`) still on
- force-push blocked, deletion blocked
- the `protect-main` ruleset untouched, bypass list still empty

CI, not a review, is what gates a landing now. Policy that CodeRabbit reviews each frozen candidate
and its real findings get fixed is unchanged — now held by convention and the merge gates rather
than by GitHub.

## Guard changes

`pullRequestReviewBlocked` (new, `.claude/hooks/codex-push-lib.mjs`) replaces `pullRequestApproved`
as the merge-blocking predicate in `.claude/hooks/pr-merge-guard.mjs`:

- **denies** `reviewDecision === "CHANGES_REQUESTED"` — never merge over an unresolved objection
- **allows** `APPROVED`, `REVIEW_REQUIRED`, and `null`, printing a stderr NOTICE when there is no
  current approval

It deliberately does not fail closed on a null verdict: `null` is now the ordinary verdict for an
unreviewed PR, so blocking it would rebuild the deadlock this removed. The fail-closed floor is
upstream in `gateRequest`, which denies outright when the PR's JSON cannot be fetched. The
green-pipeline check is untouched and remains a hard deny. `gh pr merge --admin` is still denied
outright.

Tests: `.claude/hooks/pr-merge-guard.test.mjs`, 95 assertions, mutation-tested (neutering
`pullRequestReviewBlocked` turns the suite red).

## The protection API lies about this — verify behaviourally

`DELETE .../branches/main/protection/required_pull_request_reviews` returns `204 No Content` and
the top-level `/protection` response correctly drops the block — but an immediate GET of the
**sub-resource** still reports `required_approving_review_count: 1`. That value is a phantom; it is
not what GitHub enforces. Two sessions in a row read it and wrongly concluded an approval was still
required, one of them reverting the conclusion in a memory file.

**Ground truth is the merge-state machine:** `gh pr view <n> --json mergeStateStatus,reviewDecision`
on a PR with no review. Confirmed on PRs #554, #555 and #556 — all `CLEAN`/`MERGEABLE` with an
empty `reviewDecision`, which is only possible when no approval is required.

## Residual

The ruleset still sets `require_extra_approval_for_unattributed_changes: true`, so a PR whose
commits GitHub cannot attribute to a known account can still demand an approval. Narrow path, not
the general rule; clearing it is Mason's by hand.

## Rollback

```bash
gh api -X PATCH repos/masonwells1/CRX_Manager_V1.0/branches/main/protection/required_pull_request_reviews -f required_approving_review_count=1 -F dismiss_stale_reviews=true -F require_last_push_approval=true
```

Docs: `AGENTS.md`, `docs/manual/DECISION_LOG.md` (2026-09-02 entry),
`docs/reference/agent-guardrails.md`.
