---
name: claude-review
description: Use when Mason asks Codex to have Claude directly review, challenge, double-check, or give a second opinion on CRX Manager work.
---

# Claude Review

Read `C:\CRX_Manager\.claude\commands\claude-review.md` completely and use it as the source of truth.

Natural-language triggers are enough. If Mason says "let Claude review", "have Claude look at this", "ask Claude to double-check", "Claude's opinion", or similar wording, use this skill automatically unless the request is clearly for a durable handoff packet.

Use `node scripts/run-claude-review.mjs` for direct review. It keeps Claude read-only by default and writes the result to `.claude/session-state/claude-review-latest.txt`.

Fallback to `codex-to-claude-handoff` when the Claude CLI is unavailable, Mason wants Claude to continue in a separate session, or a permanent handoff file is the deliverable.

Do not push, deploy, apply live migrations, delete data, commit, or expose secrets.
