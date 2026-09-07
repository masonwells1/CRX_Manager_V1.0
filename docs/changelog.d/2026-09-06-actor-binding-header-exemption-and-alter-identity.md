## 2026-09-06 - Close the two open actor-binding findings and bring PR #449 current

- `main` was merged into the PR #449 branch. The only conflict was `docs/manual/DECISION_LOG.md`,
  where both sides had appended new entries at the top of a newest-first log; both sets were kept
  in date order and nothing from `main` was dropped.
- The `-- actor-binding-check: exempt` marker is now honored only in the migration's leading
  comment block. A file beginning `SELECT '-- actor-binding-check: exempt';` previously disarmed
  the entire guard from ordinary SQL string data; it no longer does. Marker text below the
  migration's SQL is likewise not a file-level marker, and an unterminated header block comment
  fails closed. Every existing exemption in this repository sits on line 1 and is unaffected.
- The ALTER-only security-mode path now applies the same intervening identity-change test the
  CREATE-originated path already used. A routine elevated by `ALTER ... SECURITY DEFINER`, renamed
  away, and shadowed by a namesake replacement that is demoted to `SECURITY INVOKER` is reported
  instead of read as demoted.
- Proof: both bypasses were reproduced against the merged candidate by running the real hook, then
  observed closed after the repair. Each repair was mutation-tested in isolation — reverting it
  reintroduces exactly its own bypass and no other probe changes verdict. Regression assertions for
  both, plus the honored-marker and clean-demotion controls, are in the hook's own suite: 582
  assertions pass, up from 576.
- The two earlier open findings on the PR (top-level `set_config` before `FROM CURRENT`, and the
  shadowed bare `uuid` overload) were re-probed on the merged candidate and are already closed by
  the 2026-09-03/04 repairs; their threads were simply never resolved.
- `docs/manual/KNOWN_ISSUES.md` no longer describes `main`'s hook as a "213-line whole-write-only
  check": it is 235 lines and already carries the 2026-09-03 Edit/MultiEdit reconstruction
  maintenance. The guard remains a best-effort speed bump, not a security boundary.
