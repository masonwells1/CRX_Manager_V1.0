## 2026-09-07 - the armed-mode over-denial is a measured CLASS, not the one example that was written down

Third and final follow-up within PR #607. The shape-rule commit documented its over-denial with a
single instance — `git --no-pager log --grep push` — and called it "an occasional extra denial". A
differential sweep then measured the actual size and shape of it, and the honest number belongs in
the file rather than the word "occasional".

## The class

When a global option **does not consume a detached value** — it takes none, or it carries its value
attached — the **subcommand** is the next bare word and gets consumed as that option's value instead.
The deny word two tokens later then matches:

| Command | Verdict | What was swallowed |
|---|---|---|
| `git --no-pager log --grep push` | denied | `log`, as `--no-pager`'s value |
| `git -C/x stash push -m w` | denied | `stash`, as the attached `-C/x`'s value |
| `git --git-dir=/x/.git stash push` | denied | `stash`, as the attached long option's value |

**A 1,728-command differential sweep** (both binaries x 36 option regions x 24 subcommand tails, run
against the pre-fix library and this one) puts it at **43 benign commands newly denied against 188
dangerous shapes newly closed**.

## Why the trade is acceptable

The **common spellings are not among the 43.** `git -C /x stash push -m wip`, `git log --grep push`
and `git -C /x log --grep push` all stay allowed, because a detached value or a non-option first word
ends the option region before the deny word is reachable. What lands in the 43 is the unusual
attached-value spellings (`-C/x`, `--git-dir=…`) and the two valueless global flags.

That distinction is the whole reason this is tolerable. An over-broad deny set gets disarmed by
whoever it blocks, so a guard that started denying everyday commands would be a worse outcome than
the bypass it fixed. Five assertions now pin the boundary in both directions — the three common forms
allowed, the two accepted over-denials denied — so a future change that moves a common command onto
the denied side fails a test instead of quietly annoying a loop into turning the guard off.

Separating them properly needs per-option **arity**, i.e. another name list. That is exactly the
construct that failed twice on this PR, so it was rejected rather than attempted a third time.

A narrower variant was tried and dropped on the evidence: forbidding a detached value after an option
that already carries an attached one removes 25 of the 43, but every one it fixes is an unrealistic
spelling, and it does not touch `--no-pager log --grep push`, the only instance likely to be typed. It
bought a second grammar rule to review in exchange for no real-world improvement.

## Proof

`node .claude/hooks/autopilot-lib.test.mjs` -> **145 assertions passed** (140 before this commit; 107
before the PR's second round). The 33-case bypass corpus still scores 33/33 with zero failures on
either side.
