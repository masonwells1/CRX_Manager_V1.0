---
name: codex-to-claude-handoff
description: Use when Mason asks Codex (or Claude, in the mirrored role) to create a durable handoff packet, context file, continuation task, or fallback review packet for the other agent in CRX Manager.
---

# Codex To Claude Handoff

Read `.claude/commands/codex-to-claude-handoff.md` from the active repository root completely and use it as the source of truth.

Natural-language triggers are enough when Mason asks to "send this to Claude", "make a Claude handoff", "give Claude the context", "write a file Claude can read", or "set this up so Claude can continue".

For direct review phrasing such as "let Claude review", "have Claude look at this", or "ask Claude to double-check", prefer the `claude-review` skill first. Fall back to this durable handoff when the Claude CLI is unavailable, Mason wants a separate Claude session to continue, or a permanent audit packet is the deliverable.

Adapt Claude-specific wording to Codex tools when running from Codex. Write the packet as a file under `docs/audits/` in the current repository/worktree (per the command's Step 3) unless Mason explicitly names a different destination.

Remain read-only except for the handoff packet and workflow-maintenance files needed for this request. Do not push, deploy, apply live migrations, delete data, commit, or edit app code unless Mason explicitly changes scope in the current conversation.
