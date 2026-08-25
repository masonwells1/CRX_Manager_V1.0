---
name: codex-gauntlet
description: "Run the CRX Codex Review Gauntlet: a per-change or foundation review loop where Codex reviews Claude's work, Claude verifies and fixes confirmed findings, and each confirmed bug class creates a durable prevention action."
---

Read `.claude/commands/codex-gauntlet.md` from the active repository root completely and use it as the source of truth.

Adapt Claude-specific tool names to Codex tools when running from Codex.

Remain read-only when the selected mode is review-only. Do not push, deploy, apply live migrations, delete data, or commit unrelated staged files without Mason's explicit approval in the current conversation.
