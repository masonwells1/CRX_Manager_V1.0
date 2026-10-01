## 2026-10-01 — follow-up clearance: objecting replies refuse; evidence is read after the completion

Codex review of PR #836 raised two P1s on the CodeRabbit follow-up rule. Both were checked against
the code and real data, and both are valid.

1. **Replies can object** (on `2e6a943d`). The rule tolerated every CodeRabbit reply inside an
   existing thread. Real replies are not all harmless: on PR #818 CodeRabbit replied "I'll leave this
   thread open until the fix is on the PR branch." Now any CodeRabbit inline comment at or after the
   approval refuses, except a thread reply that carries CodeRabbit's own `✅ Review thread resolved.`
   line. That reply is the only content of the empty-body COMMENTED artifacts seen on #810, #816 and
   #818.
2. **Read order** (on `29baf6b6`). The gate used the reviews from the caller's earlier
   `gh pr view` and read the inline comments before the completion status. A finding posted between
   those reads and the status could be missed. Both paths now read the `Review completed` status
   first. Only then do they read the head's PR association, the inline comments and a fresh copy of
   the reviews (`GET /repos/{o}/{r}/pulls/{n}/reviews`, paginated). CodeRabbit posts findings 6-8 s
   before its completion status on every observed run, so the evidence read after the status always
   includes them.

Applied in `coderabbitClearedHead()` / `codeRabbitInlineFindingSince()` in
`.claude/hooks/codex-push-lib.mjs`, and in `inspectCodeRabbitFollowUp()` in
`.github/scripts/coderabbit-final-review.cjs`. The reference is
`docs/reference/coderabbit-native-review.md`, rule 2.

**Proof:**
- `pr-merge-guard` (283 assertions) and `migration-apply-lib` (282) pass. New cases cover a
  resolving reply (clears), #818's objecting reply (refuses), a finding only the post-status
  re-read shows (refuses), and a failed or non-list review re-read (refuses).
- The Codex production guard passes, and the lifecycle suite passes 280/280.
- Mutation check: with the CI check reverted to the stale review list, the re-read test fails. With
  every reply tolerated again, the objecting-reply test fails.

**Not verified:**
- No Codex Luna round or Sol proof has run on this change; both run on Mason's machine before #836
  lands.
- The resolving-reply wording is CodeRabbit's current text. If CodeRabbit changes it, the follow-up
  refuses: it fails closed, and an exact-head approval is still required.
