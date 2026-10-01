## 2026-10-01 — CodeRabbit full review of PR #836: four fixes

CodeRabbit's full review of `0eb759b1` raised four minor findings. Each was checked against the
current files and was valid. All four are fixed; two of them (both about missing verification
limits) are grouped as item 2 below.

1. **Out-of-time reported correctly** (`.claude/hooks/migration-landing-gate-lib.mjs`). If the
   15-second hook deadline passed during the CodeRabbit follow-up reads, `coderabbitClearedHead()`
   turned the deadline error into "not cleared". The gate still refused, but its message told the
   operator to request another CodeRabbit review instead of retrying. The gate now catches a
   deadline hit during those reads and reports it as out-of-time. Other read failures still refuse
   as "not cleared". The two merge gates already handled this case.
2. **Verification limits recorded.** Five of this PR's changelog entries did not say what was not
   verified: `2026-09-30-coderabbit-review-836-doc-fixes`, `-follow-up-clearance-binds-pr`,
   `-follow-up-wording-substantive-content`, `-landing-rule-wording-follow-up` and
   `-landing-rule-wording-remaining`. Each now does, and the ones without observed proof have it.
3. **Decision-log entry condensed.** The 2026-09-28 entry in `docs/manual/DECISION_LOG.md` is down to
   the decision and the operative rule. The full conditions stay in
   `docs/reference/coderabbit-native-review.md`.

**Proof:**
- `migration-apply-lib` passes (284 assertions), including a new test. In it, the deadline passes
  during the follow-up status read, and the gate must report out-of-time, not missing clearance.
- Mutation check: with the old call (`coderabbitClearedHead(pr, { gh })`) put back, that test
  fails with "CodeRabbit has not cleared".
- The other suites, lint and the agent-workflow checks pass.

**Not verified:**
- The out-of-time path has only been exercised with an injected clock, not a real slow `gh`.
- No Codex Luna round or Sol proof has run on this change.
