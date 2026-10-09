## 2026-10-01 — PR #827: keep both test-list additions when merging `main`

Merging `main` into PR #827 conflicted on the `test:correction-guards` script in
`package.json`. `main` (#855/#856) had added
`scripts/db-invariant-sweeps/allowlist-match.test.mjs`, and #827 adds
`.claude/hooks/stop-wrap-ledger.test.mjs`. The resolution keeps `main`'s line and adds
the stop-wrap test after `applied-source-containment.test.mjs`, so both run. The next
merge (2026-10-02) hit the same line again after `main` added
`.claude/hooks/owner-approval-lib.test.mjs` (#857), and was resolved the same way. Against
`main`, the script still differs only by the one added stop-wrap test.

### Proof observed

- `npm run test:correction-guards` passes, including the `stop-wrap-ledger` test and the
  new `allowlist-match` test.
- `npm run check-doc-drift` and `npm run test:agent-workflows` pass.

### Not verified

- Only the `test:correction-guards` script line was merged by hand. The other files
  `main` changed merged automatically and were checked only by the same test runs and
  CI, not reviewed line by line.
