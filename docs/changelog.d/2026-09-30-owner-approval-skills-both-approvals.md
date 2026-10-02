## 2026-09-30 — workflows require both approvals for a parked migration (Codex P1, PR #853)

The Codex GitHub review of #853 found that the `deploy-check` skill still named Windows Hello as the
only approval for a destructive, data-overwriting or access-changing migration, and still said in two
places that no agent command can apply a destructive one.

- `deploy-check`, `create-migration` and `new-rpc` (and their `.agents/` mirrors) now all say such a
  migration applies only after Mason's explicit yes in chat AND his Windows Hello approval of that
  exact file (`scripts/owner-approve-migration.mjs`), through `scripts/apply-migration-file.mjs`.
- The obsolete "Mason applies it himself — no agent command can" lines are gone. A repository-wide
  search finds none left in `.claude/skills`, `.claude/commands` or `.agents`.

Proof: `npm run test:agent-workflows` passes, including the mirror parity check. Docs and workflow
text only; no code or migration changed.
