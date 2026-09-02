## 2026-09-01 — sixth and FINAL review round: nested execution, and a deliberate stop

A sixth exact-SHA `gpt-5.6-sol` review returned BLOCKED on one HIGH: only the OUTER command head was
inspected, so the real command could hide one level down. Both probe-confirmed ALLOW:

- `echo $(rm -f .husky/pre-push)` — `echo` is allowlisted; the deletion lived in the substitution.
- `PATH=/tmp:$PATH; cat .husky/pre-push` — the name `cat` stayed allowlisted while pointing at
  whatever binary the modified PATH resolved to.

Command substitution, backticks, and process substitution now fail closed whenever the command also
names a protected path, as does anything that changes command resolution (`PATH`, `BASH_ENV`, `ENV`,
`SHELL`, `IFS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `PATHEXT`). Regression tests cover
every probe.

**Known friction accepted with it:** a command that both uses a substitution and names a protected
path is now refused even when harmless — `node "$(git rev-parse --show-toplevel)/.claude/hooks/x.mjs"`
must be written with a literal path instead. Backticks in a commit message that also names one of
these paths will be refused for the same reason. Both err toward refusal, which is the correct
direction.

**This is the last round, by Mason's decision (2026-09-01).** Six independent reviews each found a
real bypass in this guard, and a seventh very likely would too. That is not reviewer pedantry — it is
the shape of the problem. **A guard that inspects shell command text can always be fooled by a shell
that rewrites its own commands**, and each remaining bypass is more exotic than the last while the
actual protection has not changed all day: GitHub branch protection, required checks, and review
before anything reaches production. This guard's own header has said exactly that from the start, and
`DECISION_LOG.md` records it as a speed bump rather than a boundary.

Remaining known gaps, stated rather than implied: an interpreter that writes a script and then runs
it; a path hidden entirely in a variable; and the two pinned over-blocks (`.coderabbit.yaml.bak`, and
`|` inside a quoted regex splitting a segment). None are closed by more command-text rules.

Verified live against the real hook, not only in tests: `echo $(rm -f .husky/pre-push)` and
`PATH=/tmp:$PATH; cat .husky/pre-push` are both refused, while `cat .husky/pre-push | head -2` and
`git diff --stat` on a guard file still return their output.
