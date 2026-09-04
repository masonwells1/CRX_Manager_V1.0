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

### Correction — dropping it was more urgent than "unproven"

The paragraph above was written before the live evidence from `#569`/`#570`, and it
understates the case in a way that could get the scope re-added. Two facts settle it:

1. **`administration` is not a valid key in an Actions `permissions:` block.** It is a
   GitHub *App* permission. An unrecognized key does not warn or degrade — it makes the
   workflow file **unloadable**, and GitHub reports a **zero-job** run whose name is the
   file path, which reads like an unrelated infrastructure blip rather than a syntax
   error. Observed live on this branch, run `33696773987`. This branch's "fix" would
   have replaced a broken gate with **no gate at all**.
2. **The call it was meant to enable never needed it.** `repos.getCollaboratorPermissionLevel`
   requires only **Metadata** read, which every workflow token already holds. Proven
   2026-09-03: run `33704559392` reached the collaborator check and returned a real
   product verdict (`pull request has merge conflicts`) with no `administration` scope
   anywhere and zero `Resource not accessible by integration`.

So the ready-label path is **not** unexercised — it has now run past that call
successfully. Do not re-add this scope on a future 403; a 403 there would mean something
else entirely, and adding the key would brick the workflow rather than fix it.
