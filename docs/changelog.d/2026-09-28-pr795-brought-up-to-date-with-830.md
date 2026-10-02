## 2026-09-28 - PR #795 brought up to date with `main` at `4b6ff62` (#820, #830)

- **What:** `main` moved to `4b6ff62` (#820 schema-registry refresh; #830 docs cleanup) and #830
  conflicted with PR #795 in `docs/reference/agent-guardrails.md`. A conflicted PR gets no CI run, so
  `main` was merged in.
- **Conflict:** one guardrails-table row. Kept #830's wording (the `packet-review` permission profile) and
  re-added #795's sentence on push segments sharing the hard-gate time budget. No guard code changed.
- **Proof:** `check-doc-drift`, `test:agent-workflows`, `test:correction-guards` and
  `eslint . --max-warnings=0` pass on the merge.
- **Still required:** the Codex review of PR #795 (`gpt-6-luna` rounds, CodeRabbit approval, then the
  exact-SHA `gpt-6-sol`).
