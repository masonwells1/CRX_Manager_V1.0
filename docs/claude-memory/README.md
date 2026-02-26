# Claude Code Memory Files

These are backup copies of the Claude Code auto-memory files. They get loaded into Claude's context across sessions.

## Do I Need These?

**Mostly no.** `CLAUDE.md` (which is in the repo and loads automatically) already has all the rules, red lines, patterns, and architecture info. These memory files just add extra convenience like your name, setup tips, and lessons learned.

## Setting Up a New Computer (One-Time)

Just open Claude Code in the repo folder and say:

> "Copy the files from docs/claude-memory/ into your memory directory"

That's it. Claude handles the rest. No terminal, no scripts, no commands to remember.

## What Syncs Automatically (no action needed)

These are IN the git repo and sync with `git pull`:
- `.claude/settings.json` — commit hook that auto-checks docs
- `.claude/skills/update-docs/SKILL.md` — doc audit skill
- `CLAUDE.md` — all project rules, red lines, patterns
- `docs/reference/` — 6 detailed reference docs

## What the One-Time Setup Copies

These are Claude Code system files that live OUTSIDE the repo:
- `MEMORY.md` — core context (user info, project basics)
- `lessons.md` — gotchas and key lessons
- `doc-rules.md` — pre-commit doc review checklist
- `setup-guide.md` — environment setup
- `project-details.md` — full feature map

## Alternative: Script or Manual Copy

If you prefer, there's also `scripts\sync-memory.bat` you can double-click, or manually copy all `.md` files (except this README) into `%USERPROFILE%\.claude\projects\C--\memory\`.

**Note:** Even without these memory files, Claude still has `CLAUDE.md` (loaded automatically from the repo) which covers all the critical rules, red lines, and patterns. The memory files just add convenience context.
