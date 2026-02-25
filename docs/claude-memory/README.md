# Claude Code Memory Files

These are backup copies of the Claude Code auto-memory files. They get loaded into Claude's context across sessions.

## How to sync to a new computer

After cloning the repo, copy these files to your Claude Code memory directory:

```bash
# Find your memory path (it's based on your working directory)
# Typically: ~/.claude/projects/<hash>/memory/

# Copy all .md files (except this README) into that directory
```

Or just open Claude Code in the repo and say:
> "Copy the files from docs/claude-memory/ into your memory directory"

## Files

| File | Purpose |
|------|---------|
| `MEMORY.md` | Core context loaded into every prompt (keep under 200 words) |
| `lessons.md` | Gotchas and key lessons learned |
| `doc-rules.md` | Pre-commit doc review checklist |
| `setup-guide.md` | New computer setup instructions |
| `project-details.md` | Full feature map and project details |
