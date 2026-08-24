# Claude → Codex handoff: PR #432 red CI and two open guard findings

Date: 2026-08-24
From: Claude (Opus 5) session `01faa429`
To: Codex, owner of PR #432
Branch to resume: `codex/pr432-final-followup-20260820`

## Start here — read this before touching anything

**The work you need is NOT on GitHub.** PR #432's remote head is `ea526dc5`. The local branch
`codex/pr432-final-followup-20260820` is one commit further along at `c160c024`, and that commit was
never pushed. Starting from the PR head silently discards a full night of identity-guard work.

Resume from the local worktree:

```bash
cd "C:/Users/mason/.codex/worktrees/pr432-final/CRX_Manager"
```

Confirm before you begin: `git rev-parse --short HEAD` must print `c160c024`, and
`git status --short` must be empty.

## State as verified 2026-08-24

| Fact | Value |
|---|---|
| PR | #432 `fix(hooks): close remaining maintenance guard bypasses` |
| PR head on GitHub | `ea526dc5` |
| Local head | `c160c024` (**unpushed**) |
| Commits ahead of `origin/main` | 90 (83 Codex, 7 Claude) |
| Behind `origin/main` | 1 |
| CI on `ea526dc5` | **RED** — "Lint, Type Check, Test, Build" |
| CodeRabbit / Vercel / CodeQL | green |
| Exact-SHA `gpt-5.6-sol` proof | BLOCKED, 2 High findings (below) |

Test counts at `c160c024`, all passing locally on Windows:
`bash-safety: 1396`, `mcp-tool-guard: 489`, `protected-identity-guard: 17`.

## BLOCKER — the red CI

### Symptom

`.claude/hooks/bash-safety.test.mjs:769` fails on Linux CI, passes on Windows:

```
AssertionError: cmd current-directory PATHEXT resolution cannot hide a bare ignored wrapper
```

The assertion is that `cmd /c evil`, with an untracked `evil.cmd` in the working directory, is
denied. It was introduced by commit `76dbbb04` ("fix: resolve windows executor aliases") and does
not exist on `main`.

### Root cause — a real weakness, not a test quirk

Two gates in `.claude/hooks/bash-safety-lib.mjs` condition the check on the **runtime** platform of
the hook process rather than on the semantics of the command being inspected:

- **Line 1155**, in `directPathBackedInvocation` — a bare, extensionless token is only treated as a
  file-backed executor candidate when `process.platform === "win32"`. On Linux, `evil` is never
  considered at all, so nothing downstream can catch it.
- **Line 597**, in `inspect` — the same runtime gate governs whether a bare name is expanded against
  the directory listing to find `evil.cmd`.

Consequence: this entire class of check is silently inactive on Linux. CI is the only place the
guard runs on Linux, so CI has been exercising a weaker guard than the one protecting the machine.

### Required fix

Remove the runtime-platform condition in both places so bare extensionless executables resolve on
every platform.

Line 597 — drop the leading condition:

```js
if (!/[\\/]/.test(rawPath) && !/\.[A-Za-z0-9]+$/.test(rawPath)) {
```

Line 1154–1156 — drop the platform/extension disjunct entirely, leaving:

```js
if (!candidate || /^(?:https?|file):/i.test(candidate)) return false;
```

Both edits must land together. Changing only line 1155 makes Linux resolve a bare `npm` to a literal
`<base>/npm`, which is absent from `headEntries` and would deny ordinary commands. Line 597's
directory expansion is what returns "no match → allow" and prevents that false-positive storm.

This is strictly **stricter** behavior, and it is exactly the behavior Windows already has and that
already passes 1396 assertions.

### What NOT to do

Do not make the assertion Windows-only, and do not skip the test on Linux. That turns CI green by
deleting the safety net rather than fixing the guard. Mason's standing instruction on this PR is
*"do not bypass or weaken any guard."*

### Why Claude did not fix it

Claude Code's auto-mode permission classifier refuses edits to `.claude/hooks/bash-safety-lib.mjs`.
This is a Claude-side guard on security-guard files; Codex is not subject to it in its own worktree.
The diagnosis above is complete — only the edit is outstanding.

## Open finding 1 (High) — `apply_patch` bypasses the identity guard

Source-verified in `.claude/hooks/mcp-tool-guard.mjs`:

```js
66: const DC_TOOL_RE = /^mcp__[\w-]+__(start_process|interact_with_process|write_file|...)$/;
72: if (!DC_TOOL_RE.test(toolName)) nothing();
```

The pattern is anchored to an `mcp__…` prefix. Codex's `apply_patch` write route does not match, so
line 72 exits with no check at all. A patch aimed at a hard link or junction pointing into
`.claude/hooks/` receives neither the canonical-path check nor the file-identity check.

This also invalidates a justification currently in the tree. `scripts/agent-manifest-parity.mjs`
lists `protected-identity-guard.mjs` under `CLAUDE_ONLY_HOOKS` on the stated grounds that Codex
reaches the same shared check through its own file route. That claim is false. Either wire the
identity check into the `apply_patch` route, or correct the declared justification to state
accurately what is and is not covered. Do not leave the current wording in place.

## Open finding 2 (High) — proof directory is not protected

`.claude/hooks/protected-identity-lib.mjs` protects `supabase/migrations/*.sql`, `.gitattributes`,
the hooks directory, `.env*`, settings, and Git control files. It does **not** cover
`.claude/session-state`.

Attack shape: create a junction whose target is the proof directory, then create a *new* proof file
through it under an innocent name. A file that does not yet exist has no inode to compare against,
so identity matching cannot catch it, and proof files are unsigned JSON trusted from their own
fields. That is a path to self-certifying a risky change.

This one deserves priority attention because it is a hole in the proof mechanism that gates this
very PR. Note that pathname-based protection (the approach already used for Git control files, where
creating the file *is* the attack) is the applicable pattern here, not identity matching.

## Critical path to merge

1. Fix both platform gates in `bash-safety-lib.mjs`.
2. `node .claude/hooks/bash-safety.test.mjs` — must stay at **1396 assertions passing**.
3. Merge current `origin/main` (branch is 1 behind).
4. Close findings 1 and 2, with tests that fail before the fix and pass after.
5. Push `codex/pr432-final-followup-20260820`.
6. Confirm CI green **pinned to the new head SHA** — not merely "0 checks pending".
7. Read CodeRabbit's review on the final head and fix anything real.
8. Rerun the exact-SHA `gpt-5.6-sol` high-effort proof via
   `scripts/write-codex-push-proof.mjs`. Do not use the `codex review` subcommand — it self-recurses,
   kills its own PID, and exits 0 with no verdict.
9. **Stop.** Merging deploys production. Mason approves that himself.

## Traps this session actually hit

- **Stale base produces false findings.** `main` moved three times mid-session. The proof wrapper
  diffs two directory snapshots, which is structurally a two-dot comparison with no merge base, so
  anything `main` gained after your merge base reads as a deletion *you* caused. Before "restoring"
  any file a review says you deleted, check `git diff --stat origin/main...HEAD -- <path>`; empty
  three-dot plus differing two-dot means you are simply behind. Merge `main` and re-run.
- **Re-check `origin/main` immediately before minting the proof**, not just at session start. A moved
  `main` invalidates a proof you already hold.
- **A green rerun with no code change is not a clean verdict.** Mason rejected exactly this on
  2026-08-24.
- **The pre-push hook takes 10+ minutes.** It is slow, not hung. Do not kill it — killing it corrupts
  the graphify artifact and the next push dies on a spurious `ENOENT graph.html`.
- **Prove guards by driving the real hook binary**, not by reading the pattern table. Several
  defects this session passed the table and failed the binary. Mutation-test every new assertion:
  break the guard, confirm the test goes red.

## Provenance

The six preceding rounds are recorded in the branch history. The originating Codex→Claude analysis
is `docs/audits/2026-08-24-codex-to-claude-dynamic-hardlink-bypass-handoff.md`.

Nothing in this handoff has been pushed. Nothing has been merged.
