## 2026-09-02 - Close two paid-review leaks in the CodeRabbit label gate

Both were Codex findings on this PR's own head, both real, both inside the gate
this PR introduces. Each one could spend a second CodeRabbit review out of the
org's ~2-per-hour allowance on a single frozen candidate.

## A superseded head's command survived a retry

`runGate` looks for an Actions command matching the CURRENT head. When a
ready-label run replaced a queued `synchronize` reset, the live pull request
could still carry the OLD head's marker and command. The lookup for the new head
found nothing, so the branch cleared only the marker and went on to post a second
command — leaving the superseded one in place. The retry now routes through
`deleteReviewCommands()` first, which removes every Actions-authored command
regardless of head, and refuses to clear the marker if that cleanup cannot be
verified (`blockCandidate`, marker preserved). This is the same ordering
`resetCandidate` already used, and for the same reason.

The existing test `an old-head marker and command cannot suppress the
current-head request` asserted that BOTH comments remained — it pinned the defect
in place. It is renamed and now asserts the superseded command is gone.

## A queued ready-label payload could clear a live dedupe marker

The outer recovery path decided whether this attempt could have posted a command
from `attemptState.requestedMarkerPreexisted`, derived from the QUEUED event
payload. A ready-label event that queued behind an earlier run carries a payload
predating that run's marker, so the flag read false, recovery cleared
`coderabbit-review-requested` while the earlier run's command was still live, and
the next relabel bought a second review. The `edited` and unrelated-label paths
already forced the conservative value; the ready-label path did not. Recovery now
reads the LIVE labels instead of the payload — accurate on every path — and
preserves the marker when that read fails.

## Verification

- `node .github/scripts/coderabbit-final-review.test.cjs` — 103/103 pass.
- Both fixes mutation-tested: restoring the payload-derived flag turns `a stale
  ready-label payload cannot clear a live dedupe marker` red; stubbing the
  cleanup to a no-op turns `an old-head marker and command are deleted, not left
  beside the current-head request` red. Neither is a test that cannot fail.

## Known residual — NOT closed here

Codex's P1 on this PR stands: the gate's authorization result is advisory. Both
deterministic merge guards accept a generic `reviewDecision === "APPROVED"` and
never read `coderabbit-review-requested`, the marker SHA, or the approving
reviewer's identity. This PR does not create that gap — it exists on `main`
today, independent of the gate — but it does not close it either, so the recorded
gate state is documentation rather than enforcement. Binding the guards to the
marker and reviewer identity belongs with PR #556, which is already reworking
both guard files; doing it here would re-break the blob pin this PR just cleared
and collide with that branch.
