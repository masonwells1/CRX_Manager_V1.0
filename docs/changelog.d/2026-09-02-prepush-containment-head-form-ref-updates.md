## 2026-09-02 — Pre-push containment refused `HEAD:<branch>` and branch deletion as "malformed"

`checkPrePushPrivateArtifactContainment` required **both** ref names on a pre-push stdin line to
start with `refs/`:

```js
if (!localRef.startsWith('refs/') || !remoteRef.startsWith('refs/'))
  throw new Error('private Phase 3C pre-push containment received malformed ref update');
```

Git does not guarantee that for the **local** side. Per `githooks(5)` (confirmed against
git 2.54.0.windows.1 by reading real pre-push stdin):

- `git push origin HEAD:<branch>` supplies `HEAD` verbatim —
  `HEAD <sha> refs/heads/some-branch 0{40}`
- `git push origin --delete <branch>` supplies the literal `(delete)` with an all-zeroes local
  object name — `(delete) 0{40} refs/heads/some-branch <sha>`
- more generally, "if the local commit was specified by something other than a name which could be
  expanded (such as `HEAD~`, or an object name) it will be supplied as it was originally given"

Both forms are ordinary, legal git usage, and both were hard-refused. Observed pushing PR #516
(`push origin HEAD:codex/coderabbit-ready-label-20260830`); the workaround was to spell the local
ref in full. **Branch deletion was broken by the same two lines and had not been noticed** — the
shape check ran *before* the `isZeroSha(localSha)` short-circuit that exists precisely to skip a
deletion, so the guard rejected the update before reaching the branch that handles it.

**The local-ref shape check was doing no security work.** Traced every downstream use of
`localRef`: it is passed to `inspectOutgoingRefObject`, where it is used only as `repoPath` (a label
in violation messages), inside the cache keys `outgoing-commit:<localRef>:<sha>` /
`outgoing-ref:<localRef>:<sha>`, and as the label argument to `budget.admit()`. What is actually
scanned is `localSha` — validated by `assertCommitSha`, resolved through `cat-file -t`, and passed
as `spec` to `scanGitObjectEntries`, which is what reaches `git cat-file --batch`. `localRef` never
occupies a Git argv position and never selects an object. Constraining its shape protected nothing.

So the clause is removed rather than worked around. **`HEAD` is deliberately not resolved** via
`git rev-parse --symbolic-full-name`: that would add a Git call for no security benefit, return
empty on a detached HEAD, and *misreport* the label for the `HEAD~2` and raw-object-name pushes Git
also passes verbatim. The value Git supplied is the most useful thing to name in a violation
message, so it is kept as-is.

The `remoteRef` check stays — Git always fully qualifies the destination — and both remaining
messages now name the constraint and the fix instead of a generic "malformed ref update", which
suggested the operator had typed something wrong rather than naming the actual rule.

**Containment is unchanged.** The scan surface is identical; only which stdin lines are accepted
for scanning changed. The regression test asserts this directly: the same fixture that is rejected
through a fully-qualified local ref is still rejected when the identical push is spelled
`HEAD:<branch>`.

Verified — the guard was proven by running it, not only by the suite:

- **Real binary, before/after.** The exact command line `.husky/pre-push` uses,
  `node scripts/check-supplier-pricing-phase3-private-artifacts.mjs --pre-push <remote> <location>`,
  fed real `HEAD`-form stdin: **before**, `malformed ref update`, exit 1; **after**,
  `PHASE3_PRIVATE_ARTIFACT_CONTAINMENT_PASS checked_paths=2984 checked_commits=1
  scanned_logical_bytes=95076111`. Delete-form passes with `checked_commits=0`, correct for an
  update that exports nothing.
- **End-to-end push.** A real `HEAD:refs/heads/probe` push to a scratch bare remote through the
  actual husky hook: `✅ Phase 3C containment, type check, and build passed`,
  `* [new branch] HEAD -> probe`, exit 0.
- **Mutation-proved, twice.** Restoring the `refs/` clause turns the HEAD test red; a narrower
  mutation rejecting only `(delete)` turns the deletion test red. Neither test is vacuous.

**Worth knowing for whoever touches this next.** No existing test pinned the old rejection —
`'malformed ref update'` appeared only in the source — and all 24 pre-push cases used a
fully-qualified `refs/heads/packet`, which is why neither gap was caught. The new cases cover
`HEAD`, `HEAD~1`, `(delete)`, an unqualified remote ref, and a short line.

Unrelated but found while verifying: this worktree's `core.hooksPath` was pinned by
**worktree-scoped** config to a foreign checkout
(`C:\Users\mason\.codex\worktrees\pr432-multitarget-20260825\CRX_Manager\.husky`), overriding the
correct local value. Git hooks here were running a different checkout's copy of this very script.
Reset to the canonical `.husky`; the recurrence is tracked separately.
