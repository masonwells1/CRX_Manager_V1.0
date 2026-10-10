## 2026-10-10 - Sol exemption: docs/reference/ always needs Sol (Mason, "Drop the reference")

Five review rounds in a row (Sol, then the Codex GitHub App) each found one more page in
`docs/reference/` that agents follow as rules: the onboarding-routed gotchas and coding
guidelines, and last `sql-canonical-patterns.md`, the SQL safety rules for `SECURITY DEFINER`,
idempotency and mutation checks. About 11 of its 16 pages are rules of that kind. Asked to choose
between adding pages one by one and dropping the folder, Mason replied "Drop the reference"
(2026-10-10).

- `.claude/hooks/sol-exempt-lib.mjs`: `docs/reference/` is no longer in `SOL_EXEMPT_PREFIXES`. The
  never list keeps naming its rule pages, so re-adding the folder would not exempt them.
- `docs/reference/sol-exempt-paths.md` drops it from the eligible list and says why;
  `docs/reference/agent-guardrails.md` says seven folders; `DECISION_LOG.md` and the proposal's
  status line record Mason's narrowing.
- Still eligible: `docs/changelog.d/`, `docs/manual/` (minus its rule pages), `docs/plans/`,
  `docs/reports/`, `docs/audits/` (minus the commands' prompt files), `docs/handoffs/`,
  `docs/research/`.

### Proof observed

- `node .claude/hooks/sol-exempt-lib.test.mjs` passes 210 assertions with 59 mutants caught.
  Reference pages (`sql-canonical-patterns.md`, `database-schema.md`, `code-patterns.md`) need
  Sol, and a mutant that puts `docs/reference/` back on the allow-list is caught.
- `node .codex/hooks/production-action-guard.test.mjs` passes.
