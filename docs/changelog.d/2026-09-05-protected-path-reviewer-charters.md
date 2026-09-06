## 2026-09-05 — Protect the migration-proof minter's inputs: `.claude/agents/**` and `write-apply-proofs*` (Codex HIGH on PR #605 head `1730c5cfd`)

The exact-SHA `gpt-5.6-sol` review of `1730c5cfd` returned `CODEX_PROOF_VERDICT: BLOCKERS` with one
HIGH, and the GitHub Codex reviewer posted the same finding as a P1 ("Gate edits to migration
reviewer charters"): the protected-path `ask` rules omit `.claude/agents/**`, and
`scripts/write-apply-proofs.mjs` reads those reviewer charters verbatim from the working tree to mint
the proofs `migration-apply-guard.mjs` accepts. A mistaken or hijacked session could weaken a charter
with an auto-accepted native edit, obtain a clean proof, and apply a migration live before any
merge-time exact-SHA review sees the change. Charter edits were already silent on `main` (bare
`Edit`/`Write` in `allow`, no `.claude/agents` entry), so this is a pre-existing gap the PR's
protected-path list now covers, not a regression the PR introduced.

### What changed in `.claude/settings.json`

- `ask`: `Edit`, `Write`, `MultiEdit`, and `NotebookEdit` entries for three more patterns —
  `.claude/agents/**`, `scripts/write-apply-proofs.mjs`, `scripts/write-apply-proofs-lib.mjs`.
  19 patterns, 76 entries (was 16 / 64).
- Sweep basis: the proof minters the guards accept (`scripts/write-apply-proofs.mjs`,
  `scripts/write-codex-push-proof.mjs`, `scripts/run-claude-review.mjs`) import only each other and
  `.claude/hooks/**` libs; every one of those paths is now in the list.
- No other tier, entry, hook, or matcher changed.

### Follow-up, not in this PR

Bind the SHA-256 of each charter consumed into the minted proof and have `migration-apply-guard.mjs`
refuse a proof whose charter hash differs from the committed file, so a charter edit is caught at
apply time by a hard guard rather than only by the `ask` prompt.

### Verification

- Parse of the file; 76 protected `ask` entries across 19 patterns, each pattern present under all
  four editor names.
- `node scripts/check-agent-workflows.mjs`, `node scripts/check-agent-guidance.mjs`,
  `node scripts/agent-manifest-parity.test.mjs`, `node .claude/hooks/mcp-tool-guard.test.mjs`,
  `node .claude/hooks/migration-apply-guard.test.mjs`, `node .claude/hooks/review-proof-guard.test.mjs`,
  `node .codex/hooks/production-action-guard.test.mjs`, `npm run check:docs`,
  `npm run test:agent-workflows` pass.
