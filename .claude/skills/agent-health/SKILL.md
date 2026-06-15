---
name: agent-health
description: Use when Mason asks whether Claude and Codex integrations, handoffs, hooks, direct reviews, or collaboration tooling are set up correctly.
---

# Agent Health

Read `C:\CRX_Manager\.claude\commands\agent-health.md` completely and use it as the source of truth.

Run `npm run test:agent-workflows` and `node scripts/agent-health-check.mjs`. Report required failures first, then warnings.

Do not push, deploy, apply live migrations, delete data, or commit.
