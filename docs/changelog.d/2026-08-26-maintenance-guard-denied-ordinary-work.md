## 2026-08-26 — the maintenance-producer guard denied ordinary work, and left no way around itself

Mason reported multiple sessions blocked constantly. It traced to **one rule**, not to the
hook layer as a whole — and the diagnosis circulating between sessions ("it refuses chained
shell commands") was wrong. Plain chaining always passed.

**What was actually happening.** `maintenanceProducerCommandMentioned()` in
`.claude/hooks/bash-safety-lib.mjs` scans the command as raw text. A `node` token plus any
dynamic character (dollar sign, asterisk, question mark, backtick, brace) anywhere in the
string denied the command. So a variable in a sibling `echo`, an unrelated pipeline stage, or
**the body of a file being written by the same command** denied every `node` invocation in it.

The compounding failure: the remedy for a denial is "write a script to a file, then run it" —
and that was denied too, because the file's own contents tripped the same scan. Both doors
shut, so sessions thrashed and routed around the guard.

**What shipped.** Exactly one region is now excluded: the body of a **quoted** here-document.
That is the only region bash provably never expands — no parameter expansion, no command
substitution, no arithmetic. It is literal data, so excluding it cannot create a bypass.
Unquoted heredocs stay in scope precisely because bash *does* expand them. The stripper fails
closed (an unterminated heredoc puts its body back, so it cannot swallow a later invocation)
and keeps the command line and redirect target, so writing *over* the producer with a quoted
heredoc is still denied.

**The design this replaced, and why that matters.** The first two revisions excluded per
command *segment*. That approach reopened a hole in each of three review rounds:

1. **Brace expansion** — caught by the guard's own suite; `apply-l{i..i}ve-...` split across
   "segments".
2. **Process substitution** — caught by CodeRabbit; it tokenizes into two adjacent control
   tokens, so a per-token scan missed it entirely.
3. **`&>` redirections and unquoted heredoc bodies** — caught by Codex, both P1, and both
   confirmed by direct reproduction before being accepted.

Three rounds, three holes, each fix inviting the next. Matching bash's real parsing with this
tokenizer is not achievable, and continuing would have been the "enumerate the cheats"
failure Mason has flagged before. All three rounds are pinned as permanent regression cases,
so whatever this guard becomes, they stay denied.

**The trade-off, stated plainly.** The shipped design gives back *less* than the segment
approach did. A command mixing a variable with a node call in one line — for example an `echo`
of a variable followed by a node invocation — is still denied. What it does give back is the
escape route: write a script with a quoted heredoc, then run it. That is the shape that was
structurally impossible before, and it is what made sessions thrash.

**Proof observed.** `bash-safety.test.mjs` 426 assertions pass (was 411, and the new cases
include all three bypass rounds in both directions); `guards.test.mjs` 168;
`mcp-tool-guard.test.mjs` 30; `codex-push-lib.test.mjs` pass; `check:docs` green; pre-commit
and pre-push containment/typecheck/build green. Both Codex P1 claims were reproduced against
the built library *before* accepting them, and re-run after the fix: both now denied. Ran
end-to-end through the live hook — wrote a script with a quoted heredoc whose body mentions a
variable and two node commands, then executed it; that exact shape was denied twice earlier in
the same session.

**Not verified.** The false-positive *rate* in live multi-session use is not measured here,
only that the specific shapes above flipped. Whether this removes the churn Mason observed
becomes visible only after merge, since each worktree carries its own copy of the guard.

**Deliberately not changed.** `stop-wrap.mjs` can re-fire when its acknowledgment file cannot
be written; that is intentional per a 2026-08-19 review and it only fires on genuine loose
ends. Separately, `C:/CRX_Manager/.git/config` pins `core.hooksPath` to a **foreign checkout**,
as did this worktree's `config.worktree`. This worktree was repaired in the safe order (install
deps, verify its own husky, re-pin to its own hooks) so these commits ran the real gate; the
repo-level pin still affects other worktrees and needs a separate sweep.
