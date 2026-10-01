## 2026-09-30 — CodeRabbit follow-up clearance is bound to its own pull request

Codex review of PR #836 (P1) found a gap in the 2026-09-28 follow-up rule: a commit status belongs
to a **commit**, not a pull request. If the same head commit were pushed to a second PR, CodeRabbit's
`Review completed` status from that other PR's review would sit on the same commit and could clear
this PR's merge without CodeRabbit ever reviewing it here.

**Fix.** The follow-up path now also asks GitHub which pull requests contain the head commit
(`GET /repos/{owner}/{repo}/commits/{sha}/pulls`) and clears the head only when the answer is this
pull request and no other. An empty, unreadable, malformed or shared answer refuses (fail closed).
The exact-head APPROVED path is unchanged and costs no read.

- Hooks: `coderabbitClearedHead()` / `coderabbitFollowUpClearedHead()` in
  `.claude/hooks/codex-push-lib.mjs` make the second `gh api` read; `pr-merge-guard.mjs` and the
  Codex `production-action-guard.mjs` now request the PR `number` (the migration landing gate
  already did).
- CI: `inspectCodeRabbitFollowUp()` in `.github/scripts/coderabbit-final-review.cjs` calls
  `repos.listPullRequestsAssociatedWithCommit` and requires every PR number to equal this PR's.
- Docs: `docs/reference/coderabbit-native-review.md` (rule 4), `docs/manual/DECISION_LOG.md`,
  `docs/reference/agent-guardrails.md`, `docs/reference/gotchas.md`.

**Proof.** GitHub's real answers, read 2026-09-30: `970052fc` and `ffb400b2` → only #820;
`f89d574e` → only #836, so real follow-ups still clear. New tests cover a shared head, a head
linked only to another PR, an empty list, a missing or malformed PR number and a failed or
non-list read in all three hook suites and the CI suite. With the new CI check switched off,
three of the new CI tests fail; with it on, all 271 pass.

**Not verified:** the tests use fixtures, and the GitHub reads above only show that three real
heads map to one PR each. No real head shared between two PRs was observed, no live merge or
apply has used the follow-up path yet, and no Codex Luna round or Sol proof has run on this change.

Also fixed (Codex P2 on #836): `docs/manual/CURRENT_STATE.md`, `docs/reference/migration-history.md`
and `2026-09-29-record-100900-apply.md` still said the schema registry stopped at `100700` and
needed a refresh; it was regenerated on 2026-09-29 (high-water `20260928025520`).
