## 2026-09-21 — Codex GitHub App findings on the review-tier PR (#750)

After the fourth Sol pass came back clean, the merge gate refused on unresolved Codex GitHub App
comments. All six were checked; five were real and are fixed here, one was already fixed.

- **Already fixed** — `--no-textconv` (same defect as Sol's first finding; fixed in
  `2026-09-21-review-tier-sol-gate-fixes.md`).
- **Step 4 read the wrong file after a Luna round** (P1). Only the Sol wrapper writes
  `.claude/session-state/codex-review-latest.txt`, so after a Luna round it holds an older review's
  verdict. Step 4 now reads `$WORK/luna-final.txt` after Step 3A and the session-state file only
  after Step 3B.
- **`/ship` ran Sol before the docs commit** (P1). The Sol pass sat in Step 6 while Step 7 commits,
  which voids an exact-HEAD proof (and the writer refuses a dirty tree). Step 6 now runs Luna only;
  the Sol pass moves to the end of Step 7, on the final commit, immediately before the Step 8 push.
- **The manual paste packet called itself the gate pass** (P2). A pasted reply cannot mint the
  head-bound proof; `codex-cross-review` now calls it an advisory second opinion and says a risky
  change stays parked until Step 3B can run.
- **"Until clean" contradicted `/ship`'s deferral rule** (P2). `AGENTS.md` now defines clean once:
  no BLOCKER or HIGH, and every MED/LOW fixed, refuted with evidence, or named as a deferral in the
  report to Mason — matching the long-standing `/ship` rule.
- **`--sol --reason --timeout 600` recorded `--timeout` as the reason** (P2).
  `overnight-codex-gate.mjs` now rejects an option token as a reason. **Proof (executed):**
  `--sol --reason --timeout 600`, `--sol --reason` and bare `--sol` all refuse before launching
  Codex; `--sol --reason "complex RLS rewrite"` proceeds and logs
  `tier: gpt-5.6-sol / high (--sol; reason: complex RLS rewrite)`.
