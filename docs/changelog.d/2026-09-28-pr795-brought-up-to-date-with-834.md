## 2026-09-28 - PR #795 brought up to date with `main` at `fcfab3a` (#834)

- **What:** `main` moved to `fcfab3a` (#834, a bundled `-o` push option read by shape), which changes
  `codex-push-lib.mjs`, its tests and `production-action-guard.mjs`, the same files PR #795 changes.
  `main` was merged in with no conflicts.
- **Proof:** `test:correction-guards` and `test:agent-workflows` pass on the merge.
- **Review state (correcting the PR body):** a `gpt-6-luna` xhigh round DID run, on 2026-09-26, at local
  head `6967695e7`. It reported 12 findings. Only the option-padding BLOCKER is fixed (`92d7d4b`).
  Re-reading the code after this merge confirms these are still open: the silent 32-command cutoff,
  interpreter-fed input without a literal gh/git, a wrapper between a pipe and its interpreter, runtime
  program names without `$`/backtick, dropped non-gh decoded payloads in the Codex guard, and the
  six-word wrapper window.
- **Still required:** Mason's call on which of those to fix versus accept as documented residuals, then
  Luna rounds, CodeRabbit approval and the exact-SHA `gpt-6-sol`.
