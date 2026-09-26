## 2026-09-26 - Guards refuse a nested command whose program name is built at run time

- **What changed:** `expandNestedCommands` in `.claude/hooks/codex-push-lib.mjs` now reports `computed`
  (which all three guards refuse) when a nested shell or evaluator's inner command has its PROGRAM word
  built at run time — `bash -c 'g$1 pr merge 1 --admin' x h`, `${P}h …`, `$P …`, `` `echo g`h … ``,
  `& $p …` — even when the command never spells gh or git.
- **Why:** those spellings never name gh or git, so the gh/git filter dropped them. Both Claude guards
  allowed all six tested forms and the Codex guard allowed the backtick one. Found while checking the
  code-reading note of round 2 of the independent Opus review of PR #795 (that round stopped early and
  did not certify the PR).
- **Not refused:** a variable in an ARGUMENT (`bash -c 'echo $HOME'`,
  `pwsh -Command "Get-ChildItem | ForEach-Object { $_.Name }"`); a quoted string with spaces is not read
  as a program name.
- **Proof:** the six forms are now denied by all three guards (hook subprocesses and the Codex guard
  in-process against the merge-ready fixture); the 52-command differential probe still shows no leak and
  no harmless command refused; new assertions in `codex-push-lib.test.mjs`; `test:correction-guards`,
  `test:agent-workflows` and `eslint . --max-warnings=0` pass; unwrap timing unchanged (under 0.5 s at
  about 200 KB).
