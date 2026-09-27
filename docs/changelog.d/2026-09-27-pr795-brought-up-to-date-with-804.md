## 2026-09-27 - PR #795 brought up to date with `main` at `93f6ee2` (#802, #804)

- **What:** PR #795 had a merge conflict with `main`, which is why GitHub never started its main CI
  run for `92d7d4b`. Merged `main` at `93f6ee2` (#802 dangling-fence hold fix; #804 autonomous landing,
  which requires CodeRabbit approval, a Sol proof for every merge and a `--match-head-commit` pin).
- **Conflict:** `.claude/hooks/pr-merge-guard.mjs` imports — kept #804's removal of
  `describeRiskyContent` and #795's `expandNestedCommands`.
- **Test update:** the Codex guard's "a nested ordinary merge is gated, not refused" control now carries
  the head pin #804 requires of every agent merge; without it the control was refused for the missing
  pin, not for the nesting.
- **Proof:** `test:correction-guards`, `test:agent-workflows`, `check-doc-drift` and
  `eslint . --max-warnings=0` pass on the merge; the option-padding probe still shows every padded
  admin merge refused by all three guards.
