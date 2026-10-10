## 2026-10-09 - codex-review and deploy-check skip Sol for a documentation-only change (Codex review on #888)

The Codex GitHub App's review of PR #888 (two P2s) found two workflows that still required the Sol
proof for every merge:

- `.claude/skills/codex-review/SKILL.md`: Step 3B ("for EVERY change headed for `main`") and the
  merge section ("both merge gates require a fresh ... proof for every merge") now say a
  documentation-only change as defined in `docs/reference/sol-exempt-paths.md` skips Step 3B, and
  to run Step 3B if a merge gate refuses.
- `.claude/skills/deploy-check/SKILL.md`: step 5 ("every change, since 2026-09-26") now names the
  same exception.

Both generated `.agents/skills/` copies were regenerated with `sync-agent-workflows.mjs --write`.
Every other workflow file that mentions Sol (`preflight`, `codex-gauntlet`, the bug-hunt
commands, `new-rpc`, `create-migration`, `codex-cross-review`, `docs/workflows/`) was checked: each
ties Sol to a migration, money or risky diff, never to every merge, so none changed.

### Proof observed

- `node scripts/sync-agent-workflows.mjs --write`, `npm run test:agent-workflows`,
  `npm run agent-health` and `node scripts/check-doc-drift.mjs` pass.
