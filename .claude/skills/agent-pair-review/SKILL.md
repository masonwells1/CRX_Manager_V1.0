---
name: agent-pair-review
description: Use when Mason asks for both Claude and Codex to review, compare notes, challenge each other, or run a two-model review on CRX Manager work.
---

# Agent Pair Review

Read `C:\CRX_Manager\.claude\commands\agent-pair-review.md` completely and use it as the source of truth.

Natural-language triggers are enough: "both agents", "Claude and Codex", "pair review", "two-model review", "compare notes", or "make them disagree" should route here.

From Codex, run `node scripts/run-claude-review.mjs` for the Claude side and reconcile Claude's output against Codex's current position. From Claude, run `/codex-review` for the Codex side.

Do not push, deploy, apply live migrations, delete data, commit, or hide BLOCKER/HIGH disagreement.
