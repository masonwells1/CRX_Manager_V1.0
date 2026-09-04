## 2026-09-03 — a chained merge could still starve the second merge's hard gates; cmd.exe's caret escaped the shell check

Codex round 8 on PR #563, two Highs — the exact-SHA `gpt-5.6-sol` proof of head
`fd72af13e` (the branch after round 7 and the merge of `main` #581). Follows round 6
(`2026-09-03-advisory-lookup-could-starve-the-hard-merge-gates.md`) and rounds 2/3/4/7 on the
protected-path matcher.

**Files:** `.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`,
`.claude/hooks/codex-bot-review-lib.test.mjs`, `.codex/hooks/production-action-guard.test.mjs`,
`scripts/apply-live-testdata-maintenance-20260812.mjs` (guard blob re-pin only)

### SEC-001 — running the advisory last *within one merge* was not enough

Round 6 moved the advisory, fail-open Codex App lookup to each merge's ALLOW point so it could
not starve that merge's hard denials. But both guards gate a command **segment by segment**:

```
gh pr merge 123 --squash && gh pr merge 456 --squash
```

#123 clears its hard gates → its advisory runs (up to four `gh` calls) → only then does #456
reach its objection / green-pipeline / proof checks. A slow GitHub during #123's advisory
could exhaust the hook budget before #456 was examined, and a killed hook denies nothing — so
#456 would merge over `CHANGES_REQUESTED`, a red pipeline, or no proof.

**Fix.** The per-merge gate no longer runs the advisory. It hands its request back
(`advisoryRequest`), the segment loop queues it, and the queue is drained only after **every**
merge and push segment in the command has cleared its hard gates. One deadline is computed
once and shared by every deferred lookup, so N merges spend one budget, not N. Same shape on
the Claude side: `gateRequest()` pushes to `advisoryQueue` at both allow points and the queue is
drained after the request loop.

Pinned behaviourally on the Codex side: a chained command whose **second** merge carries
`CHANGES_REQUESTED` is denied with **zero** advisory attempts (a GraphQL stub that throws if
reached), with a control showing two clean merges still get two advisory lookups — deferred, not
dropped. Pinned by source position on both guards: the drain sits after the segment / request
loop, the per-merge gate returns its request instead of calling the advisory, and the loop
actually queues what is returned.

### SEC-002 — cmd.exe's `^` and the POSIX backslash

Round 4 stripped the characters a shell **deletes** while building a word — but only
PowerShell's (quotes, backtick). cmd.exe deletes `^` the same way:

```
cmd /c "echo x > .claude/hooks/codex-push-^lib.mjs"
```

writes the protected file while the token the guard examined still carried the caret. A POSIX
shell (Git Bash on this machine) does the same with an unquoted backslash.

**Fix.** The no-op set is now the union of every shell's word-building no-ops (quotes,
backtick, caret). The backslash is also Windows' separator, so it cannot join that set —
`.claude\hooks\x` must still read as a path — and gets its own **deleted** view instead: the
POSIX escape collapses there, while a backslash-separated Windows path merely stops matching in
that one view and is still caught by the two that keep it. A literal caret in a PowerShell path
is a different file this over-blocks, which is the deny direction.

Eight payloads asserted on the shell channel (both escapes, in the file and directory part, and
combined with a quote splice); three near-miss canaries keep the deleted view from fabricating a
protected path out of an unrelated backslash-separated file or whitespace-separated fragments.

### Mutation check

With the advisory call put back inside the per-merge gate, the chained probe records one
advisory attempt before the second merge's denial. With the caret removed from the no-op set
and the backslash view dropped, both escaped writes return `blocked:false`. Restored, all three
cases hold. Recorded in the PR.
