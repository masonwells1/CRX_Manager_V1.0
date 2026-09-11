## 2026-09-07 - Push and merge guards: model the binary by SHAPE, not by a one-item extension list

`.claude/hooks/codex-push-lib.mjs` spelled the `git` and `gh` binaries as
`git(?:\.exe)?` / `gh(?:\.exe)?` — a one-item extension list. Everything else the
shell resolves to the same program walked straight past the guard.

**Reproduced by execution** against the file's own exported predicates at
`336f92e4d` (not by reading the pattern — reading a regex tells you what it says,
not what it matches):

| command | before | after |
| --- | --- | --- |
| `git.cmd push origin HEAD:main` | `isGitPush` **false** | true |
| `git.ps1` / `git.com` / `git.bat push …` | **false** | true |
| `C:\Tools\git.cmd push origin main` | **false** | true |
| `"C:/Program Files/Git/bin/git.cmd" push …` | **false** | true |
| `gh.cmd pr merge 625 --squash` | `ghMergeRequest` **null** | gated |
| `gh.ps1` / `gh.bat pr merge …` | **null** | gated |
| `npm test&&gh pr merge 625 --squash` | **null** | gated |
| `git.cmd $verb origin main` | `gitSubcommandIsDynamic` **false** | true |
| `git.cmd --namespace=x push …` | `unknownGitGlobalOptions` **[]** | `["--namespace=x"]` |

A `false` from `isGitPush` means the push guard exited before the force,
destination, risky-diff and Codex-proof checks ran at all; a `null` from
`ghMergeRequest` means the merge gate — green pipeline, `CHANGES_REQUESTED`,
risky-diff proof — never ran. `.cmd` is what Windows resolves `git` to when Git
ships its shim, and PATHEXT is user-configurable, so these are ordinary
invocations rather than exotic ones.

### Why a shape and not a longer list

This is the same error a third time. `autopilot-lib.mjs` enumerated option
*spellings* (broke), then attached-vs-detached option *values* (broke), then the
binary *name* (broke); PR #607 replaced all three with a grammar. This file never
got that treatment. Adding `.cmd|.bat|.ps1` here would inherit the next list's
omissions, so the binary now reuses #607's model verbatim rather than a second,
differently-shaped answer to "what is a git command":

- `BIN_TAIL` = an optional **extension** (a `.` followed by the last dot-segment
  of the final path segment — no separator, no further dot, no quote inside it)
  plus an optional **closing quote**. Any extension matches because "what follows
  the dot" is a shape; none is named.
- `\b` after the name keeps it off the neighbours, and the argv-walking parsers
  (`gitSubcommandIsDynamic`, `unknownGitGlobalOptions`) got the token-level twin
  `/^git(?:\.[^.]*)?$/i` so all three agree on what a git command is.
- `GH_BIN_RE`'s command-start class widened from `\s` to `CMD_START`'s
  `[\s;&|]`, for the reason this file already recorded for git: `npm test&&gh pr
  merge 625` is an ordinary shell line.

### Both directions are pinned

A guard that over-denies gets switched off, so the benign boundary is asserted
too: `git-crypt`, `git-lfs`, `github-release`, `gitfoo`, `npm run gitpush`,
`git commit -m "fix the push bug"`, `gh-dash`, `ghq`, `ghost` and `npm run ghpr`
are unchanged. `-` is not `.`, so the extension tail never opens on a hyphenated
neighbour, and `\b` never matches inside a longer word.

The new assertions were verified to **fail against the pre-fix library and pass
after**, by running the real test files with `codex-push-lib.mjs` resolved to the
`336f92e4d` snapshot. The tests also pin a linearity ceiling: 20,000-character
`git.git.git…` and `gh.gh.gh…` inputs decide in under a millisecond (the same
shape's first draft elsewhere took 414ms before the extension was bounded).

### Known, unchanged, reported not fixed

- **`.codex/hooks/production-action-guard.mjs` carries the identical gap** in its
  own copies of these parsers (lines 1079/1130/1168). Measured through the
  exported `evaluateProductionAction`: `gh pr merge 625 --squash` returns
  `blocked: true`, while `gh.cmd pr merge 625 --squash` and `gh.ps1 …` return
  `blocked: false`. That file's stated follow-up — import these helpers instead
  of copying them — is the right fix and is out of this change's scope.
- **Pre-existing catastrophic backtracking in `GIT_GLOBAL_OPTS`**, unrelated to
  the binary and neither caused nor worsened here (identical curve before and
  after). `git` followed by repeated `-c`/`-C` global options and a non-`push`
  tail is exponential: 8.9ms at 20 repeats, 32ms at 20 quoted repeats, ~110s at
  50 (`git -C "a b"` ×50, 455 characters). The ambiguity is `-C`/`-c` colliding
  under the `i` flag plus a backtrackable `\S+` value inside a starred group.
- `.claude/hooks/review-proof-guard.mjs:504` uses the same `git(?:\.exe)?`
  anchored token test; it appears to fail closed (an unrecognized head is not
  vouched for) rather than open, but that was not proven either way here.
- `.claude/hooks/loop-guard.mjs:86,94` looks like the same construct but is not:
  `\bgit\b` already matches inside `git.cmd`, and the loose `[^\n]*` reaches the
  subcommand. No change needed.
- `GIT_GLOBAL_OPTS` remains an enumerated option list. Its omissions are covered
  by `unknownGitGlobalOptions`, which refuses any unlisted global option when a
  later token is `push` — and that compensator now sees every binary spelling.

Files: `.claude/hooks/codex-push-lib.mjs`, `.claude/hooks/codex-push-lib.test.mjs`,
`.claude/hooks/pr-merge-guard.test.mjs`.
