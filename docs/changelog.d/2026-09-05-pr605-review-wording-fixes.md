## 2026-09-05 — Two wording fixes from the exact-SHA Codex review of PR #605 head `753940cb1`

The `gpt-5.6-sol` review returned `CODEX_PROOF_VERDICT: CLEAN` with two Low, documentation-only notes.
No settings entry, hook decision, or test changed.

- `docs/reference/agent-guardrails.md` (`review-proof-guard.mjs` row): the sentence still said Mason
  had removed the native `Write`/`Edit` `ask` tier for the protected enforcement-surface paths and
  merged over the Codex HIGH. He did not: the 32 `ask` entries were restored by `189e2b9ff` and he
  chose to keep them (the 2026-09-05 "Retain guard approvals" decision). The row now says the `ask`
  tier still gates those edits and that the prompt is a mode-dependent residual, with the risky-path
  exact-SHA Codex proof at merge time as the boundary — matching the file's header.
- `.claude/hooks/migration-apply-guard.mjs`: the comment on the silent success path said the tool's
  "ask/deny tier still applies", but the registered Supabase `apply_migration` entries sit in `allow`
  (unchanged from `main`). The comment now says the settings tier decides: a proven apply on a
  registered server still runs without a prompt, while a replacement connector's `ask`/`deny` entry
  keeps its prompt or refusal instead of being overridden by a hook `allow`.

### Verification

- `node .claude/hooks/migration-apply-guard.test.mjs` (115 assertions), `node .claude/hooks/mcp-tool-guard.test.mjs`
  (130 assertions), `node scripts/check-agent-guidance.mjs`, `node scripts/check-agent-workflows.mjs`,
  `node scripts/agent-manifest-parity.test.mjs`, and `node .codex/hooks/production-action-guard.test.mjs` pass.
- Not a behaviour change: `git diff` touches one prose sentence, one comment block, and this fragment.
