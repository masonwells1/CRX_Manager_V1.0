## 2026-09-26 - autonomous landing: no agent override for destructive migrations; applies are Claude-only

**Sol HIGH, round 6 on PR #804.** `scripts/apply-migration-file.mjs --mason-approved-destructive` let an
unarmed session apply a destructive migration, but the flag was self-attested: an agent could pass it
itself, so it proved nothing about Mason's approval of that exact migration. The flag is gone.
`migration-apply-lib.mjs` now refuses destructive SQL for agents in every session with no override
input, and the apply script rejects `--mason-approved-destructive` as an unknown option instead of
silently ignoring it. A destructive migration is parked and Mason applies it himself; a Mason-bound
approval mechanism is a possible follow-up.

**Sol MEDIUM, round 6.** Codex's `production-action-guard` blocks every live apply, including
`apply-migration-file.mjs`, and the old protected-environment migration workflow no longer exists. The
docs now say plainly that autonomous applies come from Claude sessions only; a Codex session hands its
migration to a Claude session. Updated `ship.md`, `DECISION_LOG.md`, `OWNER_PLAYBOOK.md`,
`agent-guardrails.md`, and the create-migration, new-rpc and deploy-check skills.
