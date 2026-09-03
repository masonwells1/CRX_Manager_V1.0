## 2026-09-03 — `administration:` in an Actions permissions block is not "unnecessary", it is a brick

Correction to the two entries on this branch that described the dropped
`administration: read` grant as merely unproven. That framing invites someone to
re-add it the first time a permission check 403s. It must not be re-added.

**Files:** documentation only — `docs/changelog.d/2026-09-02-final-review-gate-missing-administration-scope.md`,
`docs/changelog.d/2026-09-03-drop-speculative-administration-scope.md`

### Why

`administration` is a GitHub **App** permission. It is not a valid key in a workflow's
`permissions:` block. An unrecognized key there does not warn and does not degrade — it
makes the workflow file **unloadable**, and GitHub reports a **zero-job** run whose name
is the file path. That presents as an unrelated infrastructure blip, not as a syntax
error, which is why it survived review on this branch. Observed live here: run
`33696773987`.

The consequence is worse than the bug it claimed to fix. `coderabbit-final-review.yml`
was failing; declaring this key would have replaced a **broken gate** with **no gate**.

### And the call never needed it

`repos.getCollaboratorPermissionLevel` requires only **Metadata** read, which every
workflow token already holds. Run `33704559392` reached that call and returned a real
product verdict (`pull request has merge conflicts`) with no `administration` scope
present and zero `Resource not accessible by integration`. The ready-label path is
therefore **exercised**, not pending — an earlier entry on this branch says otherwise
and is superseded here.

### Credit and provenance

Found independently by PR #569, and verified from live run logs rather than from prose.
The real fix for the repo-wide gate failure was `pull-requests: write` (PR #570).

### Follow-up — CLOSED by #571 while this branch was in review

#570 pinned its own fix with the test `the gate's own label and comment writes are
actually granted`, but the companion guard — a test that every declared permission is a
key GitHub Actions actually accepts — was missing, so nothing prevented the zero-job
bricking class from recurring. **#571 landed exactly that test**, and this branch merged
it at `bb260f562`. The follow-up is closed; do not re-open it, and do not re-land #569's
permission change, which #570 already made.
