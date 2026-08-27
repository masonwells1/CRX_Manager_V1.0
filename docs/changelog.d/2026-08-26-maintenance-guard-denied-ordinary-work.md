## 2026-08-26 — the maintenance-producer guard denied ordinary work, and left no way around itself

Mason reported multiple sessions blocked constantly. It traced to **one rule**, not to the
hook layer as a whole — and the diagnosis circulating between sessions ("it refuses chained
shell commands") was wrong.

**What was actually happening.** `maintenanceProducerCommandMentioned()` in
`.claude/hooks/bash-safety-lib.mjs` tested for dynamic shell syntax against the **entire
command string**, then denied if that string also contained a `node` token anywhere. So a
single dollar sign, asterisk, question mark or backtick in *any* part of a command — an
unrelated pipeline stage, a variable in a sibling `echo`, or the body of a file being written
by the same command — denied every `node` invocation in that command, even when nothing in it
could reach the guarded producer. Plain chaining was never implicated: `npm run typecheck &&
npm run build` always passed.

The compounding failure was that this also denied the **only escape route** available — write
a script to a file, then run it — because the file's own contents tripped the same
whole-string test. Both doors shut, so sessions thrashed and routed around the guard.

**The fix.** The dynamic-syntax test is now evaluated per command *segment*, so it fires only
when the opacity sits in the `node` invocation's own segment. Segment bounds use genuine
command separators (semicolon, ampersand, pipe, newline) only, never the brace, paren or
redirect control tokens the tokenizer also emits — using those would let brace expansion split
the producer name across "segments" and slip past the check.

**Two defects were caught during the change, both by tooling rather than by me.**

- The guard's own suite caught the first draft letting `apply-l{i..i}ve-...` through.
- CodeRabbit caught a genuine, security-relevant regression the suite did not cover: process
  substitution tokenizes into two *adjacent* control tokens, so neither token carries the
  pattern alone and the new per-token scan missed it. A node invocation could be fed opaque
  generated content. The adjacency is now re-joined explicitly. A plain output redirect is not
  substitution and stays allowed.

Regression assertions were added in **both** directions, so the narrowing cannot silently widen
back into a false-positive engine or silently leak.

The guarded producer's maintenance is still **pending** — `live-testdata-lib.mjs` is at the
expected INPUT blob, not the OUTPUT blob — so retiring the gate was not an option and it stays
fully wired. Everything else it denied still denies: dynamic node script paths and arguments,
inline node evaluation, require/import/loader hooks, encoded PowerShell, xargs/parallel stdin
execution, and every raw or obfuscated spelling of the producer name.

**Proof observed.** `bash-safety.test.mjs` 422 assertions pass (was 411); `guards.test.mjs`
168; `mcp-tool-guard.test.mjs` 30; `codex-push-lib.test.mjs` pass; `test:agent-workflows` and
`check:docs` green; pre-commit and pre-push containment/typecheck/build green; full CI green on
PR #503. Ran end-to-end through the live hook: a command combining a command-substitution
assignment with a node invocation now executes, and that exact shape was denied beforehand. A
purpose-built matrix returned 16/16 correct — 7 previously-denied ordinary commands allowed, 6
producer-reaching forms still denied, 3 unrelated destructive rules still denied.

**Not verified.** The false-positive *rate* in live multi-session use is not measured here —
only that the specific shapes above flipped. Whether this removes all of the churn Mason
observed will only be visible once other worktrees pick the fix up at merge; each worktree
carries its own copy of the guard.

**Deliberately not changed.** `stop-wrap.mjs` can re-fire when its acknowledgment file cannot
be written; that is intentional per a 2026-08-19 review (an alarm the agent can self-acknowledge
is not a guard) and it only fires on genuine loose ends. Separately, `C:/CRX_Manager/.git/config`
pins `core.hooksPath` to a **foreign checkout**, as did this worktree's `config.worktree`. This
worktree was repaired in the safe order (install deps, verify its own husky, then re-pin to its
own hooks) so these commits ran the real gate; the repo-level pin still affects other worktrees
and needs a separate sweep.
