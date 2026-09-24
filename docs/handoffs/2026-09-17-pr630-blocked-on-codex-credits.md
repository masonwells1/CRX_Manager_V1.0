# PR #630 — parked at the Codex proof gate, 2026-09-17

> **Resumed 2026-09-19:** merged the GitHub branch update (`c98ae38b9`) and current `origin/main`,
> re-ran all seven suites green, then ran the exact-SHA Codex proof once credits reset. This file is
> kept as the record of the park; the state below is as of 2026-09-17.

## One-line state

Every known finding is fixed and every suite is green, but the branch **cannot be pushed** until
OpenAI Codex credits reset (**2026-09-19 08:36 local**), because the push guard requires a fresh
exact-SHA `gpt-5.6-sol` proof for these files and the review could not run.

## Where the code is

- Worktree: `C:\CRX_Manager\.claude\worktrees\usage-review-optimization-46d351`
- Local branch: `pr630-fixes`, HEAD **`64e3051da`** (contains `origin/main` as of 2026-09-17, i.e. #706)
- PR #630 branch on GitHub: `claude/codex-guard-import-shared-gh-parsers`, head still **`06a7c5168`** (2026-09-11)
- **11 non-merge commits are local-only.** Nothing has been pushed.
- PR #630 `reviewDecision` is `CHANGES_REQUESTED`. `mergeStateStatus` reads `BEHIND`, which masks that —
  do not read anything into `mergeStateStatus`; read `reviewDecision`.

## What was fixed since the PR head (all local)

Each was raised by a local `gpt-5.6-sol` review, verified against real code before fixing, and
mutation-tested (revert the fix → the new assertion fails):

1. **CodeRabbit round 7, Major** — nothing bounded the *series* of `gh`/`git` hard-gate calls, and a
   PreToolUse hook killed at its timeout emits nothing, which ALLOWS. Added
   `createHardGateBudget` / `hookDeadlineMs` / `hardGateBudgetDenial` to `.claude/hooks/codex-push-lib.mjs`
   and wired them into both merge guards.
2. **Codex round 1** — `defaultRunGh` retried `gh.exe` after *any* failure, so one admitted call could
   cost two timeouts. Retry is now ENOENT-only. Proven live by stripping GitHub CLI from PATH.
3. **Codex round 2** — PowerShell keeps a backslash and still splits on the space after it, while the
   POSIX splitter binds `\ ` into one word, hiding `--admin` / `-X DELETE`. Added a third (PowerShell)
   reading to `splitCommandSegments`.
4. **Codex round 3** — `ghHiddenByShellComposition` compared only the *first* merge in a chained line,
   so a backtick spliced into the SECOND merge was invisible. It now compares the set of gh operations
   per command.
5. **Codex round 4** — the round-2 fix only handled backslash-before-*space*. Backslash-before-*quote*
   (`gh api --template \"x" -X DELETE …`) still slipped through, and this one was a real **regression**:
   `origin/main` denies that command and the candidate allowed it. Fix: double EVERY backslash for the
   PowerShell reading. Commit `67151c29b`.

## Proof already run at HEAD `64e3051da`

- `node .claude/hooks/codex-push-lib.test.mjs` — OK
- `node .claude/hooks/pr-merge-guard.test.mjs` — 137 assertions
- `node .claude/hooks/guards.test.mjs` — 168 assertions
- `node .codex/hooks/production-action-guard.test.mjs` — OK
- `npm run test:correction-guards`, `npm run check-doc-drift`, `npm run test:agent-workflows` — all PASS
- Live probe (`scratchpad/probe-chained-backtick.mjs`) ran the REAL guards as hook subprocesses against
  both the candidate and `origin/main`'s guard files: the candidate now denies the round-4 DELETE with
  the same message `main` uses.

`npm test` does NOT run the node guard suite — run the files above by name.

## The blocker

```
node scripts/write-codex-push-proof.mjs --timeout 2400
→ Exit code: 1
→ ERROR: You've hit your usage limit. … try again at Sep 19th, 2026 8:36 AM.
```

No review ran at all — this is not a findings verdict. The wrapper correctly minted nothing.
`riskyFiles()` confirms the gate applies: `.claude/hooks/codex-push-lib.mjs`, `pr-merge-guard.mjs`,
`.codex/hooks/production-action-guard.mjs` and their tests are all on the risky-path list.

Do not self-certify, do not hand-write the proof JSON, do not `--no-verify`.

## Resume checklist (after credits return, or after Mason buys more)

1. `git fetch origin main` and merge it in if `main` has moved; re-run the suites above.
2. `node scripts/write-codex-push-proof.mjs --timeout 2400` until it prints `(verdict: clean, head …)`.
   Rounds 1–4 each found something real; expect a round 5 and treat its findings as probably right,
   but verify each against current code before fixing.
3. Push: `git push origin pr630-fixes:claude/codex-guard-import-shared-gh-parsers`
4. Wait ~10 min for "Lint, Type Check, Test, Build".
5. **Check the last fleet CodeRabbit grant before posting.** Slots are roughly one per hour fleet-wide;
   a collision wastes it for every session. Then post exactly `@coderabbitai review` once.
6. Merge ONLY on a fresh `APPROVED` CodeRabbit review whose `commit_id` equals the PR's final
   `headRefOid`, with CI green: squash merge, `--match-head-commit <sha>`. A resolved thread, a reply,
   or a COMMENTED review does NOT clear `CHANGES_REQUESTED`. Never `--admin`.
7. After #630 merges: close PR #626 unmerged (Mason approved this; #626 is fully contained in #630).

## Standing approvals from Mason in the originating chat

- Merge #630 once CodeRabbit approves.
- Close #626 unmerged after #630 lands.
- Edit guard `.mjs` files without asking.

Nothing else is approved. Pushing is the first outward-facing step and is gated by the proof above.
