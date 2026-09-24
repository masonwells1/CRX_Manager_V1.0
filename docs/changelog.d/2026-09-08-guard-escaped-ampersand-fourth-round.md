## 2026-09-08 - An escaped `&` is data, not a separator

Fourth round on the same gates, and the second in a row where the review found a hole the
previous round had OPENED. Companion to
`2026-09-08-guard-word-splitting-is-shell-aware.md` (round one),
`2026-09-08-guard-gh-spellings-second-round.md` (round two) and
`2026-09-08-guard-quoted-separators-and-escaped-admin.md` (round three).

A `gpt-5.6-sol` high-effort review of `3e099b510` returned BLOCKERS. Five of its six
findings were artifacts of the base moving underneath the review — a peer session fetched
into the shared `.git` mid-run, so `origin/main` advanced and files this branch never
touches read as deleted. Verified by `git diff --name-only <merge-base>...HEAD`, which
lists eleven files, all of them this branch's own. Those five are not recorded here
because there was nothing to fix.

The sixth finding was real, and it was about the round-three fix itself.

### SEC-003 - the segmenter knew one shell's escape character, not three

Round three replaced a bare regex split with a quote-aware character walk,
`splitCommandSegments`, so that a quoted `&` could no longer carry `--admin` out of the
segment the guard inspects. That walk treated a backslash as an escape, because a POSIX
shell does. But this fleet runs PowerShell and cmd.exe, and neither uses a backslash:
PowerShell escapes with a backtick and cmd.exe with a caret.

```shell
gh pr merge 123 --body x^&y --admin --squash
```

is ONE command to cmd.exe — `x&y` is a single literal argument. The segmenter cut it in
two:

```js
["gh pr merge 123 --body x^", "y --admin --squash"]
```

Segment one is a merge with **no `--admin`**, so it went to the ordinary merge gate.
Segment two carries the override and contains no `gh`, so no parser looked at it. That is
SEC-001 again, in the spelling round three did not cover.

**The fix widens the escape set to the union of all three shells**: a backslash, a
backtick or a caret consumes the character that follows it. Consuming one can only JOIN
segments, never divide them, so a shell that treats the character literally still leaves
the parsers reading more text, not less — the fail-safe direction.

### Measured against the merge-ready fixture

Against the fixture the guard's own suite uses — APPROVED, CLEAN, green checks, a valid
Sol proof on disk, so a plain `gh pr merge 123 --squash` is **allowed** and the `--admin`
refusal is the only thing left standing:

| command | at `3e099b510` | now |
| --- | --- | --- |
| `gh pr merge 123 --squash` (control) | `blocked: false` | false |
| `gh pr merge 123 --admin --squash` (control) | true | true |
| ``gh pr merge 123 --body x`&y --admin --squash`` | true | true |
| `gh pr merge 123 --body x^&y --admin --squash` | **`false`** | true |
| `gh pr merge 123 --body x\&y --admin --squash` | true | true |
| `gh pr view 1 & gh pr merge 2 --admin --squash` (control) | true | true |

One row moved, and it is the live hole. The backslash row was already correct — that was
the one escape round three knew. The backtick row was already denied, but by the generic
command-substitution rule, because a backtick in PowerShell is also how a subshell opens;
that is a compensator, not a fix, and the caret spelling — which has no compensator — is
what proves the difference.

### Both directions

- An UNescaped `&` must still separate, or round two is undone. `gh pr view 1 & gh pr
  merge 2 --admin --squash` still denies, and the assertion checks that the `--admin` in
  the SECOND segment is what fires.
- Widening the escape set joins `gh^ pr merge 123 --squash` back into one segment, so the
  round-two caret case was re-run explicitly: it still refuses.
  `ghHiddenByShellComposition` strips escapes on its own, independently of the segmenter,
  so joining them back cannot stand it down.

### Proof

- The table above is a differential run of `evaluateProductionAction` in a detached
  worktree at `3e099b510` versus this commit, through the merge-ready fixture.
- New assertions live inside that same fixture in the guard's own suite, so a refusal
  from an unrelated gate cannot satisfy them.
- The 50-command × 16-predicate differential sweep reports **no verdict moved** for any
  push predicate — measured both against `3e099b510` (isolating this round) and against
  `223bdf0d5` (rounds three and four together) — and none for `mainPushSource` with
  `currentBranch=main`.
- Both hooks were run again as real `PreToolUse` SUBPROCESSES over the round-two corpus:
  every attack refused by the correct gate, every benign command still allowed.
- `node .claude/hooks/codex-push-lib.test.mjs`,
  `node .codex/hooks/production-action-guard.test.mjs`,
  `node .claude/hooks/pr-merge-guard.test.mjs`,
  `node .claude/hooks/guards.test.mjs`,
  `npm run test:correction-guards`, `npm run check-doc-drift`,
  `npm run test:agent-workflows` — all pass.
