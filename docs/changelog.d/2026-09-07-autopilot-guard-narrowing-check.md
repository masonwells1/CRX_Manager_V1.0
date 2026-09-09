## 2026-09-07 - the armed-mode shape rule is NOT purely a widening, and now says so

Follow-up within PR #607, correcting a claim made earlier the same day in
`2026-09-07-autopilot-guard-option-shape.md`. That entry ended with the comfortable sentence "this
widens a deny-set only; nothing previously blocked becomes allowed." It was not checked, and it was
not quite true.

A differential sweep of 1,728 generated commands over the option grammar (both binaries x 36 option
regions x 24 subcommand tails), run against the pre-fix library and the fixed one, found **231 newly
denied and 36 newly ALLOWED**. A guard getting narrower is the opposite of this PR's intent, so the
36 were run down rather than rounded off.

All 36 are a single class: an **unbalanced quote inside the option region** — `git -C "a push`,
`git -c a'b push`, and the same shape across `reset --hard`, `clean -fd`, `worktree remove`,
`branch -D` and `filter-branch`. The old `\S+` swallowed the stray quote as an ordinary character;
the new word model treats a quote as opening a run, so the token stops there and the option region
ends before the subcommand.

**They are not a hole, because they are not commands.** Measured rather than argued:

| Shell | Input | Result |
|---|---|---|
| `bash -c` | `echo START a"b push END` | status 2, `unexpected EOF while looking for matching '"'` |
| `bash -c` | `echo START 'a b push END` | status 2, `unexpected EOF while looking for matching "'"` |
| `powershell -Command` | `Write-Output START a"b push END` | status 1, `The string is missing the terminator: ".` |
| `bash -c` (balanced control) | `echo START "a b" push END` | status 0, runs |

The shell refuses the string outright, so nothing is pushed. The balanced counterparts do run, and
those are denied.

The rule underneath is that the guard models the **shell's word splitting**: if the subcommand sits
inside a quoted run, the shell does not treat it as the subcommand either. Closing the last sliver
would mean letting a lone quote count as an ordinary character as well, which reintroduces exactly
the ambiguity the word model removed and begins denying `git -C "a push" status`. The trade was taken
knowingly rather than by omission.

## What changed

Three assertions in `.claude/hooks/autopilot-lib.test.mjs` pin the behaviour in both directions — the
two unbalanced forms allowed, the balanced counterpart denied — with the measured shell evidence
recorded beside them, so this stays a deliberate property instead of surfacing as a surprise in the
next review. `2026-09-07-autopilot-guard-option-shape.md` was corrected in place; the overreaching
sentence is gone.

## Proof

`node .claude/hooks/autopilot-lib.test.mjs` -> **140 assertions passed** (137 before this commit, 107
before the PR's second round). `npm run test:correction-guards` passes.
