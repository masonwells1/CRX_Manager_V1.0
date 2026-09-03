## 2026-09-03 — an invalid `permissions:` key silently bricks the final-review gate; now a test catches it

Follow-up to the same-day fix that gave `coderabbit-final-review.yml` the
`pull-requests: write` it needs (#570). That change landed with a test pinning
the two scopes it declares — but nothing on `main` validated that the declared
keys are keys GitHub Actions actually **accepts**.

**Files:** `.github/scripts/coderabbit-final-review.test.cjs` (test-only; the
workflow is unchanged)

### Why this is worth a guard

`administration` is a GitHub *App* permission. It is **not a valid key in an
Actions `permissions:` block at all**, and an unknown key does not warn and does
not degrade — it makes the workflow file **unloadable**. GitHub then reports a
**zero-job** run (`"jobs": []`) whose name is the file path, which reads like an
unrelated infrastructure blip rather than a syntax error.

That is not hypothetical: PR #563 added `administration: read` to this workflow
on the (incorrect) theory that `repos.getCollaboratorPermissionLevel` needed it,
and run **33696773987** is that break observed live. It would have replaced a
*broken* gate with *no* gate — a strictly worse failure, because a red check is
at least visible.

The existing suite stayed green through it. Every other test in the file reads
the workflow as **text** and never validates the key names, and the scope test
added in #570 matches lines with a narrow lowercase-and-hyphen matcher, which
cannot see a malformed key such as `pull_requests: write` at all.

### The guard

`every declared permission is a key GitHub Actions actually accepts` parses the
workflow's `permissions:` block with a deliberately **broader** line matcher
than the scope test — it has to see a malformed key in order to reject it — and
asserts every declared key is in the documented Actions permission set.

Mutation-tested twice against the real failure modes, with the workflow reverted
after each:

- `administration: read` (the exact key from #563) then fails, reporting
  `+ 'administration'`.
- `pull_requests: write` (underscore typo for `pull-requests`) then fails; the
  narrower matcher in the neighbouring test would have skipped it.

In both cases the pre-existing `the gate's own label and comment writes are
actually granted` test stayed **green**, which is the proof that the gap this
closes was real. Suite: 88 pass / 0 fail with the workflow unmodified.

The test was salvaged from PR #569, which is otherwise a conflicted duplicate of
the already-merged permission fix in #570.
