# Agent Instruction Architecture Review

**Date:** 2026-09-04
**Scope:** CRX Manager guidance shared by Codex and Claude

## Recommendation

Keep the root instruction files small and use them as a routing layer. Put detailed procedures where an agent loads them only for the task that needs them. Put rules that must never be bypassed in hooks and automated checks instead of relying only on prose.

This matters especially for Mason: he cannot read code or reliably judge a diff. The system must make agents own technical decisions, show business impact and proof in plain English, continue without nudging after any tool-specific plan checkpoint, and clearly identify the rare action only Mason can take. Codex proceeds after its plan; Claude retains Mason's existing one-time pre-code approval checkpoint for multi-file or risk-sensitive work.

## What Was Already Good

- `AGENTS.md` was the single shared contract.
- `CLAUDE.md` imported `AGENTS.md` instead of maintaining a second copy.
- Detailed workflows, reference material, skills, and deterministic hooks already existed.
- Volatile counts had already been removed from startup instructions.

## Problems Found

- Codex’s machine-wide `~/.codex/AGENTS.md` had grown to 9,488 bytes and repeated CRX-specific delivery, model, and workflow instructions that belong in this repository.
- `AGENTS.md` still carried long delivery, money-exception, collaboration, and maintenance procedures that were already documented elsewhere.
- `CLAUDE.md` loaded model-selection and reviewer-prompt details on sessions that did not use them.
- Claude’s startup hook told every session to load the full safe-development rulebook, even for a tiny documentation question.
- Some supporting documents still described `CLAUDE.md` or `AGENTS.md` as the location of detailed technical rules after those responsibilities had moved.
- The automated “lean” limit allowed `AGENTS.md` to grow to 140 lines, which encouraged gradual prompt bloat.

## Target Structure

| Layer | Purpose | Examples |
|---|---|---|
| Always loaded | Owner communication, autonomy, task routing, true non-negotiables, verification and closeout | `AGENTS.md`, short `CLAUDE.md` import/routing |
| On demand | Procedures, domain rules, examples, model tuning, known quirks | `docs/workflows/`, `docs/reference/`, `.claude/commands/`, `.claude/skills/` |
| Deterministic | Rules that must execute or block regardless of model judgment | `.claude/hooks/`, `.codex/hooks.json`, CI and guidance checks |
| Historical | Why a decision was made and what changed | `docs/manual/DECISION_LOG.md`, `docs/changelog.d/` |

The machine-wide Codex contract was reduced from 9,488 to 6,509 bytes and now contains only owner behavior, cross-project authority, baseline merge conditions, delegation limits, hard gates, and proof standards. CRX details route to this repository. The exact recoverable snapshots are `~/.codex/backups/20260904-codex-behavior/AGENTS.md` (before, SHA-256 `B8715E9934B4161838C6153448C8AD0730D5E31EBA104C762A7D37E721A6777C`) and `~/.codex/backups/20260904-codex-behavior/AGENTS.after-lean-20260904.md` (after, SHA-256 `870CAAD0F309757A6D5205A0F91C7C0B91D57604BF7427A5670428B8703EC94D`). Claude’s 66-line global file retained its behavior; one stale pointer was updated to the new on-demand model-tuning reference.

## Writing Rules

- Keep instructions concrete and testable. “Use `ConfirmModal`” is useful; “write clean code” is not.
- Prefer the simplest complete implementation. Avoid clever compression, speculative abstractions, new dependencies, and unrelated cleanup.
- Keep one canonical statement of each rule. Other files link to it instead of paraphrasing it.
- Link to details without importing them into every startup context. An import can organize a file while still consuming the same context.
- Route task-specific work to a skill or workflow and let automation enforce hard boundaries.
- Review instruction files like code: prune duplication, test the loaded behavior, and keep automated size limits.

## Why Not Use Claude-Only Rules for Shared Policy

Claude supports `.claude/rules/`, including rules scoped to file paths. Codex does not use that directory as its native shared instruction source. CRX therefore keeps cross-agent policy in `AGENTS.md` and shared workflow documents. Claude-only model behavior stays in `CLAUDE.md` or a Claude reference file; generated `.agents/` adapters expose canonical workflows to Codex.

## External Sources

All four links below were reopened successfully on 2026-09-04 before this review closed.

- OpenAI documents hierarchical `AGENTS.md` discovery, a default combined size ceiling, and concise repository-level instructions: `https://learn.chatgpt.com/docs/agent-configuration/agents-md`.
- OpenAI recommends auditing instruction files for conflict, stating autonomy clearly, and calibrating verification to risk: `https://developers.openai.com/api/docs/guides/latest-model`.
- Anthropic recommends a short human-readable `CLAUDE.md`, skills for task-specific procedures, and hooks for actions that must always occur: `https://code.claude.com/docs/en/best-practices`.
- Anthropic documents that `@` imports still load into startup context and recommends keeping each `CLAUDE.md` concise: `https://code.claude.com/docs/en/memory`.
- Cursor documents that it automatically loads a root `AGENTS.md` and treats `.cursorrules` as a legacy format. That supports keeping `.cursorrules` as a tiny compatibility router instead of duplicating CRX rules: `https://prod.cursor.com/docs/rules`.
