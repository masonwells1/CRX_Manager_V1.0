## 2026-09-24 - Merge and push guards read nested shells and refuse gh aliases

Follow-up to the adversarial review of PR #630. Three holes, each measured against the real
guards on PR #630's head with a merge-ready fixture (approved, clean, green, valid Sol proof),
so a refusal can only come from the defect being fixed.

- **Nested shells.** A command handed to another program as ONE argument was one word to every
  parser, so both merge guards allowed an administrator merge written as `bash -c "gh pr merge
  123 --admin"`, `sh -c`, `cmd /c`, `pwsh -Command`, `powershell "<command>"`,
  `pwsh -EncodedCommand <base64>`, `eval`, `Invoke-Expression`/`iex`,
  `Start-Process gh -ArgumentList …`, or a `&{ … }` block. The Codex guard also allowed
  `bash -c "gh api -X DELETE …/git/refs/heads/main"`, and both push guards allowed a force-push
  to main hidden in `pwsh -enc`. New shared `expandNestedCommands` in
  `.claude/hooks/codex-push-lib.mjs` unwraps these (recursively, up to 4 levels / 32 inner
  commands; deeper is refused). The Codex guard evaluates each inner command with the same
  function on the same hard-gate deadline; Claude's merge guard scans each inner command like
  the outer one; Claude's push guard refuses a nested push outright (an agent never needs one).
- **gh aliases.** `gh alias set mm 'pr merge --admin'` followed by `gh mm 123` was an
  administrator merge both guards allowed. Both merge guards now refuse `gh alias set|import`
  and any top-level gh command not in `GH_BUILTIN_COMMANDS` (aliases and extensions). `gh co`
  is refused too: it is a redefinable config alias — use `gh pr checkout`.
- **Push time budget.** The Codex guard's push checks used the raw git runner, so a chain of
  main-bound pushes could outrun the 15-second hook, and a killed hook allows (CodeRabbit's
  outstanding Major on PR #630). Push branch lookups and `gateMainChange` now spend the same
  hard-gate budget as merges and deny with a push-specific message when it runs out.
- Also fixed the double-backtick code span in `2026-09-14-shell-composition-checks-every-chained-command.md`.

**Proof:** a 50-command probe ran the Codex guard in-process and both Claude guards as real
hook subprocesses, before and after. Every nested/alias attack moved from allow to deny in
every guard that should catch it; no benign command moved from allow to deny except `gh co`
(intended). New assertions in `codex-push-lib.test.mjs`, `pr-merge-guard.test.mjs` and
`production-action-guard.test.mjs` pin each case plus controls (a nested ordinary merge is
gated and allowed; `bash -c "npm test"` passes; quoted parens are data). `test:correction-guards`
and `test:agent-workflows` pass.

**Not verified / still open:** a script FILE (`bash x.sh`, `pwsh -File x.ps1`) runs text no guard
can see. A nested command that mentions neither `gh` nor `git` is not re-inspected, so a
protected-file write hidden in `pwsh -EncodedCommand` still relies on the outer checks. The
Codex guard's pre-existing refusals of some benign shapes with parens (for example
`git log --format='%h (%s)'`) are unchanged. The exact-SHA `gpt-5.6-sol` review has not run —
the Codex CLI is not available in the cloud session that wrote this.
