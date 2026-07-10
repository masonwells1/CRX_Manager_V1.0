# Codex Agent Workflows

This directory is generated from `.claude/skills/` and `.claude/commands/`.

- Edit the Claude source files.
- Run `node scripts/sync-agent-workflows.mjs --write`.
- Verify with `node scripts/sync-agent-workflows.mjs --check`.
- Shared hook implementations stay in `.claude/hooks/`; Codex invokes them through `.codex/hooks.json`.
