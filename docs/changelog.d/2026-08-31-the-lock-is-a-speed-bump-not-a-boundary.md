## 2026-08-31 — The guarded-surface lock is a speed bump, not a boundary; the `ask` tier stays

Corrects the earlier entries today. The lock was built to REPLACE the `ask` tier on the premise
that an agent could not circumvent it. That premise is false, and the `ask` entries are therefore
restored rather than removed.

**How it was established.** A third exact-SHA `gpt-5.6-sol` round returned BLOCKED with three HIGH
findings. The decisive one was reproduced directly rather than accepted on the reviewer's word:
with the surface **locked and verified locked via `--status`**, a five-line script writing through
node's `fs` created a file inside `.claude/hooks/`, and the hook never fired. The lock inspects the
ARGUMENTS OF TOOL CALLS; code an agent writes and then runs performs its writes inside its own
process, where there is no tool call to inspect. The TTY unlock is no stronger — a PTY-capable
agent satisfies `isTTY`, and the confirmation phrase is a literal in the source.

This is the same residual gap `review-proof-guard.mjs` already documents about itself. The mistake
was not noticing that the identical limit applied to a guard built the same way.

**What changes.** The `ask` entries for the enforcement paths stay. Removing them would have been a
net weakening: under `dontAsk` an `ask` rule is a real denial for `Edit`/`Write`, whereas the lock
is bypassable. The lock is kept as defense in depth, because it closes something no `ask` rule ever
covered — the CodeRabbit Major finding that blanket `Bash` was never gated on these paths, so an
in-place stream edit of a guard file was always open. That hole predates this work.

**What this does not deliver.** Mason asked to be prompted less. He is not prompted less. The
prompts were never the `ask` entries (under `dontAsk` those are silent denials), and the lock adds
an unlock step rather than removing one. The original request remains unmet and its real cause
remains unidentified.

**Cost of the correction, recorded honestly.** Five real defects were found in this PR across three
review rounds and one CodeRabbit round; four were in code already declared tested. The lock had 166
green assertions and had been observed blocking its own author when the first fatal hole was found.
Guard work does not get to call itself done on the strength of its own test suite.
