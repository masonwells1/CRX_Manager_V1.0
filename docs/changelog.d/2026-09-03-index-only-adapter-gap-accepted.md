## 2026-09-03 - the index-only adapter gap is ACCEPTED, and the round stops here

**Class:** a deliberate stop. Mason's call, in chat, after round 11 of findings in one function.

`scripts/sync-agent-workflows.mjs` — the `actualFiles` sweep in `checkExpected()`.

## The finding

Raised by the Codex PR reviewer against `c16ce625c`. The drift sweep enumerates the working
tree via `walkFiles(TARGET_ROOT)`, so a file that exists only in the git index is never
classified. Stage an imported `source-command-*` adapter, delete its working-tree copy without
staging that deletion, then commit: the candidate tree carries the adapter, `--check` never
examines it, and the parity gate passes.

Real, and reproduced by the reviewer against the reviewed commit.

## The decision: accept and document

Not fixed. Three reasons, and the first is the one that decides it:

1. The consequence — one stale, mangled instruction file under `.agents/` — is the **same
   consequence class Mason already accepted knowingly** when the durable ownership layer was cut
   earlier the same day, pinned on purpose by test case (d).
2. The obvious fix reopens a worse hole. Unioning the index into the sweep also pulls in staged
   DELETIONS, so a legitimate `git rm` of a non-generated file under `.agents/` would report as
   drift and block the commit. Doing it correctly needs a `--diff-filter` excluding deletions —
   another narrow subtlety in the function that had already produced ten rounds of findings,
   each fix shipping a new edge.
3. The trigger needs a partial commit that stages an import and then removes the file from disk
   without staging the removal.

## Recorded in two places, on purpose

- `docs/manual/KNOWN_ISSUES.md` — full entry, marked `OPEN (ACCEPTED — WONTFIX by decision)`,
  including what still holds and the condition for ever reopening it.
- A comment at the `actualFiles` sweep itself, so the next person to read that line sees the
  decision at the point of the gap rather than discovering it as a bug.

## What this does NOT weaken

An adapter that is staged **and present on disk** is still caught: `classifyExtras()` condition
(3) refuses the exemption for any tracked-or-staged path, and fails closed when git cannot be
consulted. `gitEnvironment()` still preserves a repository-local `GIT_INDEX_FILE`, so
`git commit <paths>` is inspected against the temporary index git actually built. Only the
index-only-and-absent-from-disk case is uncovered.

## Reopening condition

Not as a narrow patch. A reopen needs the staged-deletion filter AND a test proving a
legitimate `git rm` still passes — not merely a test that the adapter is caught.
