## 2026-09-06 — PR #619: examine every runtime-name occurrence, and re-verify every earlier review round

**Why.** CodeRabbit's round-3 finding that `/usr/bin/node "$F"` was still allowed turned out to be a
finding `gpt-5.6-sol` had already made in **round 1** of this same PR. It was recorded in the PR body
as one of two evasions, the round was marked addressed, and the case survived two further review
rounds and a merge from `main` without anyone re-running it.

So before shipping, the case list from EVERY earlier round on this PR was re-run against the CURRENT
head rather than against the commit that claimed to close it. That surfaced the **second** of Sol's
two round-1 evasions, also still open.

**What was open.** `env -u node node "$F"` was allowed. `JS_RUNTIME_TOKEN_RE.exec()` returns the
FIRST occurrence of a runtime name in the segment, and in this command that is the argument to `-u`
— the environment variable being unset happens to be named `node`. The walk then started after that
first hit, read the real `node` as a literal script argument, and stopped before reaching the
computed `"$F"`. Bash runs the script named by `$F`.

**What changed** (`.claude/hooks/bash-safety-lib.mjs`, tests in `bash-safety.test.mjs`).

- `scanForComputedScript()` now examines EVERY occurrence of a runtime name in a segment instead of
  only the first. The per-occurrence token walk moved into `computedScriptAfterRuntime()`, called
  once per match. An earlier occurrence that is an option's VALUE can no longer shadow the launch
  behind it.
- Pinned in section (g)6 with six neighbours that hide a launch behind an earlier token the same
  way: `env -i node "$F"`, `env -u PATH /usr/bin/node "$F"`, `env FOO=bar node "$F"`,
  `command -p node "$F"`, `nice -n 10 node "$F"`, `xargs -I{} node "$F"`.
- Two over-block controls pin that scanning every occurrence does not invent a computed script:
  `env -u node node scripts/safe.mjs` and `env -u node printenv node` stay allowed.

**Re-verification result.** 18 cases drawn from rounds 1, 2 and 3 were run against the head that
preceded this commit: **1 of 18 was still wrong** (this one). All 18 are correct after it.

**The durable lesson.** A "round addressed" note in a PR body is a CLAIM, not a MEASUREMENT. This PR
carried two false ones for three review rounds, and both were in writing in the PR description the
whole time. Re-run an earlier round's cases against the CURRENT head before treating that round as
closed — not against the commit that claimed to close it, and not by reading the note that says it
was. See `docs/changelog.d/2026-09-06-pr619-path-qualified-runtimes-and-launcher-heads.md` for the
round-3 findings that prompted this.

**Proof observed.** `node .claude/hooks/bash-safety.test.mjs`: 536 assertions pass.
`node .claude/hooks/mcp-tool-guard.test.mjs`: 30 assertions pass. The generated Codex production
guard (`.codex/hooks/production-action-guard.mjs`) is untouched.
