## 2026-09-03 — dropped the speculative `administration: read` grant from the final-review gate

Removed from this branch. `#570` landed the real fix for the repo-wide red
`final-review-gate` 25 minutes earlier, and the diagnosis this change was built on
turned out to be wrong.

**Files:** `.github/workflows/coderabbit-final-review.yml`

### What the failure actually was

This branch attributed the repo-wide gate failure to a missing `administration: read`,
needed by `repos.getCollaboratorPermissionLevel`. That attribution does not survive
the logs. Every observed failure — runs `33702506753`, `33701849744`, `33700442498`,
`33700095181`, `33699009201`, `33702436849` — reports the same thing:

```
workflow label reset failed for ready-for-coderabbit (Resource not accessible by
integration); coderabbit-review-requested (Resource not accessible by integration)
```

Those are the **label** endpoints, not the collaborator-permission endpoint. The
declared scope was `pull-requests: read`, and GitHub gates `/issues/{n}/labels` on the
**Pull requests** permission whenever the target number is a pull request. `#570` fixed
exactly that by moving the scope to `pull-requests: write`.

### Why the grant is being dropped rather than kept "just in case"

`getCollaboratorPermissionLevel` is reached only on the `labeled` event carrying
`ready-for-coderabbit` (`.github/scripts/coderabbit-final-review.cjs:648-671`). Every
failing run above took the reset/reconcile path and returned before that line, so **no
run has ever exercised the call**. There is no observed 403 for it, and GitHub's REST
documentation for the endpoint states no fine-grained permission requirement either
way. The grant was a prediction, not a finding.

Adding an unproven scope to a privileged `pull_request_target` job is the wrong default.
`#570`'s test `the gate's own label and comment writes are actually granted` pins the
**write** surface closed on purpose; the read surface deserves the same discipline. If
the first real ready-label run 403s on that call, the log will name the endpoint and the
scope can be added with evidence attached.

### Residual

The ready-label path remains unexercised end to end. The next genuine review request is
the test; if it fails, the error text distinguishes the two causes unambiguously.
