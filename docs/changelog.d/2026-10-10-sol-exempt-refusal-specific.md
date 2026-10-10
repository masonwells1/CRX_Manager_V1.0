## 2026-10-10 - Run Sol only for an exemption refusal, not any gate refusal (CodeRabbit on #888)

CodeRabbit's review of PR #888 (head `d8b7e3f66`) asked for two fixes in the landing workflows.

- **Run Sol only for the right refusal.** `.claude/commands/ship.md` Step 8, the codex-review
  skill's Step 3B and the deploy-check skill said "if a gate refuses, run Sol". A merge gate also
  refuses for a red check, a missing CodeRabbit approval or a missing head pin, and a Sol review
  cannot fix any of those. All three now say to run Sol only when the refusal says
  "documentation-only exemption does not apply" (both guards' exact wording), and otherwise to fix
  the condition the refusal names.
- **The codex-review Step 5 handoff** still listed the Step 3B Sol proof as always required. It
  now says "unless the documentation-only exemption in Step 3B applies".

The generated `.agents/skills/` copies were regenerated.

### Proof observed

- Both guards' refusal text contains "documentation-only exemption does not apply"
  (`.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`).
- `node scripts/sync-agent-workflows.mjs --write`, `npm run test:agent-workflows`,
  `npm run agent-health` and `node scripts/check-doc-drift.mjs` pass.
