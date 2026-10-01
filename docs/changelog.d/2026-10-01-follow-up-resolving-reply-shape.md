## 2026-10-01 — follow-up clearance: a resolving reply must have CodeRabbit's exact shape

Codex review of PR #836 (on `d0198f59`) raised a P1, checked against the code and found valid. The
follow-up rule tolerated any CodeRabbit thread reply that contained `✅ Review thread resolved.`
anywhere. A reply could quote that line and still say the fix is wrong, and it would pass.

Now a reply is tolerated only in CodeRabbit's exact resolving shape:
- it is a thread reply;
- it names the marker exactly once;
- it ends with the marker line, then CodeRabbit's fixed `_You are interacting with an AI system._`
  line and its `<!-- This is an auto-generated reply by CodeRabbit -->` footer;
- some acknowledgement text comes before the marker.

The opening text is CodeRabbit's own prose and differs on every reply, so it is not matched.

Applied in `isCodeRabbitResolvingReply()` in `.claude/hooks/codex-push-lib.mjs` and the same function
in `.github/scripts/coderabbit-final-review.cjs`. The reference is
`docs/reference/coderabbit-native-review.md`, rule 2.

**Proof:**
- Real data: every CodeRabbit review comment on 33 PRs was read (#605–#850). The rule accepts all 79
  real resolving replies, on 21 PRs, and rejects all 113 other CodeRabbit comments. Those include
  the 8 replies that keep a thread open and every thread-opening finding.
- `pr-merge-guard` (294 assertions), `migration-apply-lib` (283), the Codex production guard and the
  lifecycle suite (281/281) pass. New cases cover the marker quoted and then objected to, the
  marker followed by an objection, the marker named twice, the marker without the footer, and a
  real reply with a zero-width space in the mention.
- Mutation check: putting back the old "marker anywhere" check makes the new tests fail in both
  paths.

**Not verified:**
- No Codex Luna round or Sol proof has run on this change; both run on Mason's machine before #836
  lands.
- If CodeRabbit changes its reply footer, resolving replies will refuse. That fails closed: an
  exact-head approval is still required.
