## 2026-09-07 — a generality claim that listed its own examples refuted itself (PR #607)

The comment shipped with the case-fold fix in `9eccd0d35` said `foldCase` covers
mixed-case binary spellings "without appearing anywhere in this file or in the
tests" — and then **listed six of them**, so three of the six now did appear in
that file. The sentence contradicted itself on the line where it was made.

That matters more than a wording slip. The whole reason this branch keeps
re-learning the same lesson is that a **list** of spellings looks exactly like a
**rule** covering them until someone checks. A comment that claims "unseen input
was used" while naming the input leaves the next reader no way to tell which one
this is, which is the precise ambiguity the fix exists to remove.

The examples are removed and the sentence now states what was actually done: the
spellings used to check generality were deliberately kept OUT of both
`.claude/hooks/autopilot-lib.mjs` and `.claude/hooks/autopilot-lib.test.mjs`, so
nothing in either file could be matching them by having them written down.

Re-verified after the edit rather than assumed: all eight probe spellings are
absent from both files, and running the real `autopilotDecision` still denies every
one of them while a mixed-case benign command is still allowed.
`autopilot-lib.test.mjs` — 255 assertions passed; lint clean. No pattern changed.

## Files

- `.claude/hooks/autopilot-lib.mjs` (comment only)
