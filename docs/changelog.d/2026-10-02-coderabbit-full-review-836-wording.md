## 2026-10-02 — #836: two wording fixes from CodeRabbit's full review

CodeRabbit's full review of #836 (head `bf6d8692`) raised two Minor findings. Both are valid and
both are wording only; no gate logic changed.

1. `.claude/commands/ship.md` said a clean follow-up means CodeRabbit "posted nothing new". The
   rule actually tolerates an empty `COMMENTED` reply artifact, so the line now says "no new
   substantive content", matching `coderabbit-native-review.md` and the gates.
2. `docs/changelog.d/2026-10-01-follow-up-replies-and-read-order.md` claimed the evidence read after
   the completion status "always" includes CodeRabbit's findings. That is only what the observed
   runs showed; GitHub does not guarantee list freshness. The entry now limits the claim to those
   runs and says comment-list freshness was not verified.

**Proof:** `node scripts/sync-agent-workflows.mjs --write`, `npm run test:agent-workflows` and
`node scripts/check-doc-drift.mjs` pass.

**Not verified:** no Codex Luna round or Sol proof has run on this change; both run on Mason's
machine before #836 lands.
