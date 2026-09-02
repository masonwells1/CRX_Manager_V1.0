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

### Not adopted

The same Codex comment also asserted that `/ship` should say formal approval "is
no longer required". That was **not** adopted. Verified live the same day:

```
GET .../branches/main/protection/required_pull_request_reviews  -> HTTP 200
{"dismiss_stale_reviews":false,"require_last_push_approval":false,
 "required_approving_review_count":1}
```

The rule still exists (a removed rule 404s on that endpoint). What actually
changed is that `enforce_admins` is off and every agent session runs on Mason's
admin token, so the requirement binds nobody currently merging — bypassed, not
deleted. Writing "no longer required" into `/ship` would be a false statement
that becomes a live landmine the moment admin bypass changes or a non-admin
merges. The top-level `/protection` object omits the key while the sub-resource
returns it populated; two sessions have already been misled by reading only the
former.

### Verification

- 88 unit assertions, up from 83; the 5 new ones pin gate ordering on both files.
- 10/10 mutation tests still caught.
- `test:correction-guards` and `test:agent-workflows` green; Codex guard
  protected-blob pins re-pinned.
