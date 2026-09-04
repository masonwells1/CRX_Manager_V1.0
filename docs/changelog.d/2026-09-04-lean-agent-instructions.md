## 2026-09-04 - Make shared agent instructions lean and task-routed

- Reduced the always-loaded `AGENTS.md` from 140 to 80 lines while preserving owner communication, Codex autonomy, Claude's existing plan checkpoint, hard gates, CRX non-negotiables, and completion standards.
- Reduced `CLAUDE.md` from 68 to 49 lines and moved model/effort/reviewer tuning to the on-demand `docs/reference/claude-model-tuning.md` reference.
- Added explicit simplicity guidance: prefer the simplest complete implementation, readable focused code, existing patterns, and no speculative abstractions or unrelated cleanup.
- Changed Claude startup routing to load only task-relevant workflow and reference documents instead of the full safe-development rulebook on every session.
- Added a focused startup-hook regression test so the lean routing and Mason's non-coder contract cannot silently drift.
- Expanded the detailed safe-development and collaboration documents so offloaded rules remain discoverable to both Claude and Codex.
- Tightened automated guidance limits to 90 lines / 12 KB for `AGENTS.md` and 60 lines / 6 KB for `CLAUDE.md`, and pinned Mason's non-coder communication contract plus the new simplicity rules.
- Added a plain-English instruction architecture review with current OpenAI and Anthropic documentation sources.
- Replaced stale, approval-heavy prompt templates with short plain-English request examples so Mason never has to name files, choose an implementation, or repeatedly tell an agent to continue.
- Rewrote the active coding guide around simple, surgical, goal-driven work while preserving Mason's earlier third-party source text in `docs/research/2026-06-15-coding-principles-source.md` as historical background.
- On Mason's workstation, separately reduced the global Codex `AGENTS.md` from 9,488 to 6,509 bytes while retaining cross-project merge conditions and delegation limits; the repository contract is now the source for CRX-specific rules. Pre/post snapshots are preserved under `C:\Users\mason\.codex\backups\20260904-codex-behavior\`.
- Replaced the stale `.cursorrules` project snapshot and volatile counts with an eight-line router to the canonical shared contract.
- Removed a duplicated 122-line hook-reference block and refreshed its startup-reminder description.
