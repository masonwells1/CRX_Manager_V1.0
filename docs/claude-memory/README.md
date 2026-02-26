# Claude Code Memory Files

These are backup copies of the Claude Code auto-memory files. They get loaded into Claude's context across sessions.

## How to Sync to a New Computer

**Option 1: Run the script (easiest)**
```
scripts\sync-memory.bat
```
Double-click it or run it from the terminal. It copies all memory files to the right place.

**Option 2: Tell Claude**
Open Claude Code in the repo and say:
> "Copy the files from docs/claude-memory/ into your memory directory"

**Option 3: Manual copy**
Copy all `.md` files (except this README) into:
```
%USERPROFILE%\.claude\projects\C--\memory\
```
(If `C--` doesn't exist, check `%USERPROFILE%\.claude\projects\` for the correct folder name)

## What Syncs Automatically (no action needed)

These are IN the git repo and sync with `git pull`:
- `.claude/settings.json` — commit hook that auto-checks docs
- `.claude/skills/update-docs/SKILL.md` — doc audit skill
- `CLAUDE.md` — all project rules, red lines, patterns
- `docs/reference/` — 6 detailed reference docs

## What Needs the One-Time Sync (above)

These are Claude Code system files that live OUTSIDE the repo:
- `MEMORY.md` — core context (user info, project basics)
- `lessons.md` — gotchas and key lessons
- `doc-rules.md` — pre-commit doc review checklist
- `setup-guide.md` — environment setup
- `project-details.md` — full feature map

**Note:** Even without these memory files, Claude still has `CLAUDE.md` (loaded automatically from the repo) which covers all the critical rules, red lines, and patterns. The memory files just add convenience context.
