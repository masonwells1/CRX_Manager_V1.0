Check whether the CRX Claude/Codex collaboration setup is healthy.

Use this when Mason asks whether the agents, hooks, handoff workflow, direct review workflow, or connector setup is ready.

## What This Checks

- Claude workflow files exist.
- Codex-facing skills are synced from `.claude`.
- Codex hooks are tracked, worktree-aware, and invoke the shared `.claude/hooks/` source.
- The current branch is compared with `origin/main`.
- Direct Claude review helper exists.
- Pair review helper exists.
- PR comment helper exists.
- Claude CLI is reachable, and its auth status (a logged-out Claude CLI is a WARN).
- Codex CLI is reachable through the version-hashed OpenAI binary path, and its login status (a logged-out Codex CLI is a FAIL).
- GitHub auth is reachable when the GitHub CLI is available.
- Optional CLI warnings for Vercel and Supabase.
- Schema/doc/session staleness warnings.

## Run

```powershell
npm run test:agent-workflows
node scripts/agent-health-check.mjs
```

## Interpret

- `PASS` means the required collaboration wiring is healthy.
- `PASS with warnings` means the workflow is usable, but Mason should know about stale schema/docs, missing optional CLIs, or auth warnings.
- `FAIL` means do not rely on the collaboration workflow until the listed required check is fixed.

## Safety

This is read-only except for normal test temp files. Do not push, deploy, apply live migrations, delete data, or commit as part of a health check.
