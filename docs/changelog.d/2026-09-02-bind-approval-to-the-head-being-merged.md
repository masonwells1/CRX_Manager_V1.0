## 2026-09-02 — the merge guards bind an approval to the head being merged

Both merge gates accepted a bare `reviewDecision === "APPROVED"` and never checked which commit the
approval described. That was documented as safe *conditionally*, and the condition stopped holding.

### The condition, verified live

```
GET repos/masonwells1/CRX_Manager_V1.0/branches/main/protection/required_pull_request_reviews
{"dismiss_stale_reviews":false,
 "require_code_owner_reviews":false,
 "require_last_push_approval":false,
 "required_approving_review_count":1}
```

The `protect-main` ruleset contributes nothing here either — `required_approving_review_count: 0`,
`dismiss_stale_reviews_on_push: false`, `require_last_push_approval: false`.

One approval is still required. What is gone is stale-review dismissal and last-push approval — both
of which the comments in `codex-push-lib.mjs` and `production-action-guard.mjs` recorded as verified
true on **2026-09-01**, so they changed within a day. The same comments named the consequence in
advance: *"If stale-review dismissal is ever turned off, this check must be joined by one that an
APPROVED review's commit_id equals headRefOid."*

With dismissal off, an approval granted on commit A survives pushes B, C and D while `reviewDecision`
keeps reporting APPROVED — so the bare check would clear a merge of D on the strength of a review
of A. **Not latent. Live, on `main`, tonight.**

### The fix

`pullRequestApproved()` in `.claude/hooks/codex-push-lib.mjs` and
`.codex/hooks/production-action-guard.mjs` now requires **both**: GitHub's aggregate verdict
(a later CHANGES_REQUESTED from another reviewer supersedes an earlier approval, and only the
aggregate knows that) **and** an APPROVED review whose own commit oid is the head being merged.

This deliberately does not depend on Mason restoring a toggle — it holds whether or not dismissal
ever comes back. `reviews` was added to both `--json` field lists, and both test suites pin that:
if the field list stops requesting it the head binding can never be satisfied and every merge fails
closed with a mystery denial.

Fails closed on: no head oid, absent or non-array `reviews`, no APPROVED review, an APPROVED review
carrying an **empty** commit oid, and a non-approving review at the head.

That empty-oid case is not hypothetical. `gh pr view --json latestReviews` returns
`"commit":{"oid":""}` on **every** entry; only `--json reviews` populates it. A caller that reached
for the more natural-sounding field would otherwise have compared `""` to `""` somewhere and credited
an unbound approval.

### Proof

**Mutation-proved on both sides.** Reverting each guard to the bare check turns the canary red:
`MUST DENY: an APPROVED review pinned to a superseded commit is not an approval of this head`. On the
Codex side the blob pin fires first and masks the assertion, so the pin was moved to the mutated blob
for the run and restored afterwards — otherwise the mutation would have been reported as "no
failures" when the test never executed.

**Real-path, on live GitHub data** rather than fixtures — fixtures were written next to the predicate
they test:

- #516, #552, #550 fetched live and run through the shipped function: all DENY, matching their real
  review state.
- The ALLOW path on #552's **real** review objects and **real** head oid (it carries a genuine
  CodeRabbit approval bound to its head): `ALLOW`. Same real approval with the head moved on: `DENY`,
  where the old gate said `ALLOW`. That divergence is the hole, reproduced on live data.

**Honest limit:** GitHub reports `reviewDecision` as empty on merged PRs and no open PR is currently
approved, so a live end-to-end ALLOW could not be observed today. The #552 run supplies that one
field — its value at the moment it merged — and everything else is live. The gate is strictly
stricter than the one it replaces, so it cannot allow anything the old one refused.

### Three downstream tests were being disarmed, not passing

Adding an earlier gate changed which denial fired first in
`production-action-guard.test.mjs`. Three base-check tests began failing on their **reason**
assertions rather than silently passing for the wrong cause — which is exactly why those assertions
exist. Their fixtures now carry head-bound approvals so each still exercises the base logic it is
about.

### Not fixed here

`require_last_push_approval` is also `false`, so the approver may be the person who last pushed.
That is a branch-protection setting, not code, and restoring it is Mason's call — reported to him
with the recommendation and no change made.
