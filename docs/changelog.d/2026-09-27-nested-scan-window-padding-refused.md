## 2026-09-27 - Guards refuse option padding that hid a nested command

- **What was wrong:** the nested-command unwrap in PR #795 reads at most 64 words of a program's
  options. Padding a command with 70 repeated harmless options (`bash --norc … -c`, `sh -e … -c`,
  `cmd /d … /c`, `pwsh -NoProfile … -Command`) pushed the real command-carrying option out of view, and
  all three guards allowed an administrator merge. This was the open question both independent Opus
  reviewers left for the Codex review; a probe with a merge-ready fixture confirmed it.
- **Fix:** `.claude/hooks/codex-push-lib.mjs` — a per-program scan that reaches the 64-word window with
  words still unread now reports it, and `expandNestedCommands` marks the command `tooDeep`, which every
  guard already refuses. The denial text names the padding case.
- **Proof:** new assertions in `codex-push-lib.test.mjs` (eight padded attacks refused, five ordinary
  long commands allowed); the probe shows the Codex guard, the Claude merge guard and the Claude push
  guard all deny every padded form, and none of ten harmless controls is refused.
  `test:correction-guards`, `test:agent-workflows`, `check-doc-drift` and `eslint . --max-warnings=0` pass.
- **Still required:** the Codex review of PR #795 (`gpt-6-luna` rounds, then the exact-SHA `gpt-6-sol`).
