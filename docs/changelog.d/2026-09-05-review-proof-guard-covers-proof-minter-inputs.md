## 2026-09-05 — Hard-deny shell and path-field writes to the migration-proof minter's inputs (Codex HIGH x2 on PR #605 head `02b342610`)

The exact-SHA `gpt-5.6-sol` review of `02b342610` returned `CODEX_PROOF_VERDICT: BLOCKERS` with two HIGHs:

1. The `ask` entries added in `02b342610` for `.claude/agents/**`, `scripts/write-apply-proofs.mjs`, and
   `scripts/write-apply-proofs-lib.mjs` gate native editors only. `review-proof-guard.mjs` omitted all three
   from its shell and path-field enforcement-surface patterns, and the reviewer probe-confirmed that
   `Set-Content` to each passed silently. A weakened charter or minter mints a clean proof for a live apply.
2. `codex-push-lib.mjs` `RISKY_PATH_RES` classified the charters and `write-apply-proofs.mjs` as risky
   but not `write-apply-proofs-lib.mjs`, so a `return true` in the helper could merge without the
   exact-SHA review.

Both omissions exist on `main` today (the patterns there are identical), so this closes pre-existing gaps
that the PR's protected-path list exposed rather than a regression the PR introduced.

### What changed

- `.claude/hooks/review-proof-guard.mjs`: `.claude/agents` and `write-apply-proofs(-lib).mjs` added to
  `ENFORCEMENT_SURFACE_RE` (shell) and to the path-field pattern; both deny messages name the new surfaces.
  Reads and `node scripts/write-apply-proofs.mjs ...` stay allowed.
- `.claude/hooks/codex-push-lib.mjs`: `scripts/write-apply-proofs-lib.mjs` added to `RISKY_PATH_RES`.
- Tests: `review-proof-guard.test.mjs` gains ten shell deny cases (`Set-Content`, `cp`, `echo >`, `sed -i`,
  `tee`, doubled separator, `..` traversal), five path-field deny cases, and four allow cases (run the minter,
  `cat`/`grep`/`Read` a charter or the helper); `codex-push-lib.test.mjs` pins the helper as risky.
- No settings entry changed. The three lists that name protected surfaces — settings `ask` patterns,
  `review-proof-guard.mjs` patterns, `RISKY_PATH_RES` — now all include these three paths.

### Verification

- `node .claude/hooks/review-proof-guard.test.mjs`, `node .claude/hooks/codex-push-lib.test.mjs`,
  `node .claude/hooks/mcp-tool-guard.test.mjs`, `node .claude/hooks/migration-apply-guard.test.mjs`,
  `node scripts/agent-manifest-parity.test.mjs`, `node scripts/check-agent-guidance.mjs`,
  `node scripts/check-agent-workflows.mjs`, `node .codex/hooks/production-action-guard.test.mjs`,
  `npm run check:docs`, `npm run test:agent-workflows` pass.
