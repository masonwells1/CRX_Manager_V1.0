## 2026-09-20 - The merge gate reports a cancellation instead of swallowing it

The shared gh parser stood the gate down inside itself when a merge command
carried the flag that cancels a pending auto-merge, returning "this is not a
merge". Both merge guards refuse a composed command only for a command the
parser handed them, so the whole command became invisible: a command
substitution in the same line could carry a second, administrator merge, which
the shell runs first. The normalization added on this branch is what made the
quoted spelling of the cancellation flag reach that stand-down, so the branch
turned a spelling-dependent hole into a reliable one.

The parser now reports the cancellation as a field on the request, and each
guard stands down for it only after its raw-transport, GraphQL and substitution
refusals have inspected the segment.

Proven by driving the exact command from the review through the guard process:
it is refused as a composed command, while a plain cancellation stays allowed.
Locked in by a subprocess regression test in `.claude/hooks/guards.test.mjs`.

Found by the `gpt-5.6-sol` exact-SHA review of `d4ee53665` (HIGH-01) on PR #630,
measured as base-denies/candidate-allows.
