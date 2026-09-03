## 2026-09-02 — the Codex guard's App-review check sat behind its approval deny and never ran

Third round on the Codex GitHub App review gate (see
`2026-09-02-read-the-codex-github-app-review.md` and
`2026-09-02-codex-review-fixes-thread-paging-and-silent-failopen.md`). Found by
the Codex GitHub App's own comment on PR #563 — fittingly, the first finding the
new machinery surfaced was against the machinery itself.

**Files:** `.codex/hooks/production-action-guard.mjs`, `.claude/hooks/codex-bot-review-lib.test.mjs`, `scripts/apply-live-testdata-maintenance-20260812.mjs`

### The defect

In `.codex/hooks/production-action-guard.mjs` the new App-review check was placed
**after** `if (!pullRequestApproved(pullRequest))`, which hard-denies. So on the
Codex side the check was unreachable for any PR without a formal approval — which,
on the current board, is most of them. The equivalent Claude-side block had
already been moved above the green-pipeline gate for exactly this reason; the
Codex mirror did not get the same treatment.

Every existing test still passed, because they all asserted that the code
**exists** — imports resolved, the call site was present, the notices were
spelled correctly. None asserted it could ever **run**. That is the specific way
a guard becomes decorative without any suite going red.

### The fix

The block moved above the approval deny, so ordering on the Codex side is now
App-review → approval → green pipeline, mirroring the Claude guard.

Ordering is now **pinned by tests on both guards** — the check's source position
must precede the approval deny and the green-pipeline deny. Those assertions are
the durable fix; moving the block back makes them fail.

### Not adopted here — and an UNRESOLVED disagreement worth recording

The same Codex comment also wanted `/ship` rewritten to say formal approval "is
no longer required". That edit was not made in this change, because two API
routes disagree and this entry is not the place to settle it.

Raw observations, 2026-09-02, stated as readings rather than as a verdict:

```
GET .../branches/main/protection
  -> the object OMITS required_pull_request_reviews

GET .../branches/main/protection/required_pull_request_reviews
  -> HTTP 200
     {"dismiss_stale_reviews":false,"require_last_push_approval":false,
      "required_approving_review_count":1}
```

Two readings fit. **Canonical `AGENTS.md` on main** treats the sub-resource as
phantom state left behind by a DELETE that returned 204, i.e. the rule is gone.
**The other reading** is that a removed rule 404s on that endpoint, so the rule
exists and is merely unenforced. A third session reached a third answer via
`mergeStateStatus`.

`AGENTS.md` is canonical and this entry does not contradict it. What the readings
agree on, and the only part that should drive behaviour: **no approval
requirement binds anyone currently merging**, because `enforce_admins` is off and
every agent session runs on Mason's admin token. Both accounts also agree that
`CHANGES_REQUESTED` still blocks and that no agent may use the admin override.

Recorded as unresolved rather than decided: three sessions, three routes, three
answers is a withdraw-the-claim situation, not a pick-your-endpoint one. Anyone
resolving it should test the one case that separates the readings — whether a
**non-admin** merge is refused — rather than re-reading either endpoint.

### Verification

- 88 unit assertions, up from 83; the 5 new ones pin gate ordering on both files.
- 10/10 mutation tests still caught.
- `test:correction-guards` and `test:agent-workflows` green; Codex guard
  protected-blob pins re-pinned.
