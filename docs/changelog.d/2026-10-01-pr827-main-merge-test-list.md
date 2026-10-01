## 2026-10-01 — PR #827: keep both test-list additions when merging `main`

Merging `main` into PR #827 conflicted on the `test:correction-guards` script in
`package.json`. `main` (#855/#856) had added
`scripts/db-invariant-sweeps/allowlist-match.test.mjs`, and #827 adds
`.claude/hooks/stop-wrap-ledger.test.mjs`. The resolution keeps `main`'s line and adds
the stop-wrap test after `applied-source-containment.test.mjs`, so both run. Against
`main`, the script now differs only by that one added test.

### Proof observed

- `npm run test:correction-guards` passes, including `stop-wrap-ledger: 16 assertions passed`
  and the new `allowlist-match` test.
- `npm run check-doc-drift` and `npm run test:agent-workflows` pass.
