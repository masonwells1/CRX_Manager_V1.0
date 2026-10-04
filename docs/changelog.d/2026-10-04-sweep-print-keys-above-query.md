## 2026-10-04 — sweep print mode puts exception-key notes above each query

Follow-up in PR #881 (Codex connector P2). In print mode, `npm run db-sweeps` printed the candidate
exception keys as `--` comment lines straight after `AS sweep_result;`, for the 7 predicates that have
allowlist entries. Sending those blocks "exactly as printed" (the README's instruction) included the
notes, and the guard refused them, because a wrapped query must end at the envelope's last line.

- `run-sweeps.mjs` now prints the keys inside the banner (`│ candidate exception keys …`), above the
  query, so every block between banners is just the query.
- `allowlist-match.test.mjs` runs the full print mode and asserts that all 29 printed blocks are
  allowed by `classifySql` as `known-sweep-query`. Run against the previous print layout, the same
  test fails. With the new layout it passes (594 assertions).
