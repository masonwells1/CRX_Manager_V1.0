## 2026-10-02 — PR #827: keep both test-list additions when merging #841

After CodeRabbit approved #827 at `a75640b`, `main` landed #841, which added
`.claude/hooks/merge-guard-launcher.test.mjs` to the same `test:correction-guards` line
in `package.json` that #827 extends with `.claude/hooks/stop-wrap-ledger.test.mjs`. The
merge conflicted on that one line only (`docs/reference/agent-guardrails.md` merged
automatically). The resolution keeps `main`'s line and adds the stop-wrap test after
`applied-source-containment.test.mjs`, as in the earlier merges. Against `main`, the
script still differs only by the one added stop-wrap test, and the PR still touches only
its original seven files. A later docs-only `main` commit (#871) merged without conflict.

### Proof observed

- `npm run test:correction-guards` passes on the merge, including both
  `merge-guard-launcher` and `stop-wrap-ledger`.
- Every CI check passed on the merged head `42d33b3` and again on `a7959ec`.

### Not verified

- CodeRabbit was rate limited on both merged heads, so the re-approval and the
  exact-SHA Sol review were still pending when this entry was written.
