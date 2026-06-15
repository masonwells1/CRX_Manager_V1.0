---
name: agent-pr-comment
description: Use when Mason explicitly asks to post or attach an agent review, handoff, audit, Claude review, Codex review, or pair review to a GitHub pull request.
---

# Agent PR Comment

Read `C:\CRX_Manager\.claude\commands\agent-pr-comment.md` completely and use it as the source of truth.

Default to dry-run with `node scripts/post-agent-review-to-pr.mjs --pr <number> --file <path> --dry-run`.

Only use `--confirm` after Mason explicitly confirms the PR number and tells you to post in the current conversation.

Do not post secrets, push, deploy, apply live migrations, delete data, or commit.
