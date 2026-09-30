## 2026-09-30 — follow-up clearance refuses malformed review-comment entries

CodeRabbit's review of PR #836 (`1cec7e5c`, Major) found that the new inline-comment check skipped
malformed entries as "not CodeRabbit". Examples are `null`, `{}`, or an entry with no author login.
With otherwise qualifying evidence, a follow-up could therefore clear without readable comment
evidence. Both paths now refuse on any such entry:
- `codeRabbitInlineFindingSince()` in `.claude/hooks/codex-push-lib.mjs`
- `inspectCodeRabbitFollowUp()` in `.github/scripts/coderabbit-final-review.cjs`

Proof: new refusal tests cover `null`, `{}`, a string, a missing login and a blank login in
`pr-merge-guard` (279 assertions). The lifecycle suite covers `null`, `{}` and a missing login
(278/278). `migration-apply-lib` (281) and the Codex production guard still pass.

**Not verified:** no Codex Luna round or Sol proof has run on this change; both run on Mason's
machine before #836 lands. The details are in `2026-09-30-follow-up-reads-inline-comments.md`.
