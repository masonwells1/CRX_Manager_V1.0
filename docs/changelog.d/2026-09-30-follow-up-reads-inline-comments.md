## 2026-09-30 — follow-up clearance also reads CodeRabbit's inline comments

CodeRabbit's review of PR #836 (`d69bbcf7`) raised two Major findings, one in the hook library and
one in the lifecycle script. Both were checked against the code and are valid. The follow-up rule
tolerated an empty-body `COMMENTED` CodeRabbit review after the approval. However, GitHub stores a
review's inline comments apart from its body, and neither `gh pr view --json reviews` nor
`listReviews` returns them. So an empty-body review carrying new line findings could pass as a
harmless reply artifact, and a newer `Review completed` status could then clear the head.

**Fix.** Both paths now read the PR's inline review comments (`GET /repos/{o}/{r}/pulls/{n}/comments`).
A CodeRabbit comment created at or after the approval that starts a new thread (no
`in_reply_to_id`) is a later finding and refuses. A reply inside an existing thread is still
tolerated, because CodeRabbit's empty-body reply artifacts consist of exactly such replies. An
unreadable list, a non-list answer and an undated CodeRabbit comment all refuse.

- Hooks: `coderabbitClearedHead()` / `coderabbitFollowUpClearedHead()` in
  `.claude/hooks/codex-push-lib.mjs`. Pages of 100 are read until a short page. More than 10 pages
  refuses (fail closed), and a PR view without `number` refuses before any read.
- CI: `inspectCodeRabbitFollowUp()` in `.github/scripts/coderabbit-final-review.cjs` (paginated
  `pulls.listReviewComments`).
- Docs: `docs/reference/coderabbit-native-review.md`, rule 2.

**Proof.** Real data: PR #820, the case this rule exists for, has no CodeRabbit inline comments,
so it still clears. New tests cover:
- a later finding, including one in the same second as the approval and one on a second page
- a thread reply, a superseded finding and a person's comment, which are all tolerated
- the page cap, an undated comment, and a failed or unreadable read

The results: `pr-merge-guard` 274, `migration-apply-lib` 281, the Codex production guard, and the
CI suite 275/275. With the CI check switched off, the two new CI refusal tests fail.

**Follow-up (CodeRabbit on `1cec7e5c`, Major):** a malformed comment entry (not an object, or with no
author login) was skipped as "not CodeRabbit". It now refuses in both paths, with refusal tests for
`null`, `{}`, a string, a missing login and a blank login in the hook suite, and for `null`, `{}`
and a missing login in the lifecycle suite.

**Not verified:** no Codex Luna round and no Sol proof covered this change; the cloud session has no
Codex CLI. Both run on Mason's machine before #836 lands. The live read against a PR whose follow-up
really carries an inline CodeRabbit finding was not exercised; only fixtures model it.
