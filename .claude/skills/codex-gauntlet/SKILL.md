---
name: codex-gauntlet
description: "Run the CRX Codex Review Gauntlet: a per-change or foundation review loop where Codex reviews Claude's work, Claude verifies and fixes confirmed findings, and each confirmed bug class creates a durable prevention action."
---

Read `.claude/commands/codex-gauntlet.md` from the active repository root completely and use it as the source of truth.

Adapt Claude-specific tool names to Codex tools when running from Codex.

Remain read-only when the selected mode is review-only. The gauntlet never pushes or deploys; landing a reviewed change follows `.claude/commands/ship.md`, and the hard gates in `AGENTS.md` always apply. Never commit unrelated staged files.
