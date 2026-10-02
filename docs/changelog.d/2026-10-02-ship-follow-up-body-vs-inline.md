## 2026-10-02 — ship.md: empty review body vs. inline comments (#836)

CodeRabbit's follow-up review of #836 (head `5df43b8c`) raised one Minor finding on
`.claude/commands/ship.md`. It is valid and wording only; no gate logic changed.

The earlier fix said a clean follow-up means "no new substantive content — an empty `COMMENTED`
reply artifact is tolerated". That blurred two separate checks. The line now spells out both:
- an empty `COMMENTED` review body is tolerated;
- new CodeRabbit inline comments block clearance, except an exact resolving thread reply containing
  `✅ Review thread resolved.` and CodeRabbit's fixed footer.

This matches `docs/reference/coderabbit-native-review.md` rule 2, `codeRabbitInlineFindingSince()`
in `.claude/hooks/codex-push-lib.mjs`, and `inspectCodeRabbitFollowUp()` in
`.github/scripts/coderabbit-final-review.cjs`.

**Proof:** `node scripts/sync-agent-workflows.mjs --write`, `npm run test:agent-workflows`,
`node scripts/check-doc-drift.mjs` and `node .claude/hooks/prompt-hooks.test.mjs` pass.

**Not verified:** no Codex Luna round or Sol proof has run on this change; both run on Mason's
machine before #836 lands.
