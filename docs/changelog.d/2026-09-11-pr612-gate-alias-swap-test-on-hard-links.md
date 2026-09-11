## 2026-09-11 - PR #612: gate the alias-swap test case on hard-link support

CodeRabbit's full review of `308df48f5` (the whole PR against `main` `6b9efeae1`, 19 files) raised one
finding, Minor and test-only: in `.claude/hooks/review-proof-guard.test.mjs` the alias-swap junction
residual case called `linkSync` unconditionally, even when the earlier hard-link probe had already
found that the filesystem cannot make hard links. On such a filesystem the test threw instead of
recording the case as skipped.

The case now runs only when that probe succeeded, and otherwise calls `skipAliasCase(...)` so the
end-of-run summary counts it. The case's own assertions and its cleanup are unchanged. No guard logic
changed.

**Verified by execution** on Windows, where hard links are available so the case still runs: the
guard's test suite passes and still prints the alias-swap residual reproduction, and
`npm run test:correction-guards` passes. The skip branch itself cannot be exercised on this machine.
