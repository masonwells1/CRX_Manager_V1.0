#!/usr/bin/env node
// PostToolUse(*) + SessionStart hook: stamp a liveness marker into THIS
// worktree's .claude/session-state so worktree-cleanup can tell an actively-used
// checkout from a finished one.
//
// Why this exists (Codex review of the 2026-07-16 worktree-cleanup heartbeat):
// the cleanup guard keeps a worktree touched recently (git index/HEAD/reflog or
// session-state mtime), but NOTHING refreshed those during a long *read-only*
// session — a session that only reads makes no commits/checkouts, so its git
// timestamps go stale and its merged-clean worktree could still be swept after
// the activity window. This hook fixes that at the source: it runs on every tool
// call (and at session start) and touches SESSION-HEARTBEAT, which the cleanup's
// mtime scan already picks up. A genuinely idle session (no tool calls for the
// whole window) still ages out — that's intended; only ACTIVE sessions stay live.
//
// Fail-open and silent: any error → do nothing, emit nothing. Never block a tool
// call or a session start over a heartbeat write.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

try {
  // The tool ran in THIS worktree; CLAUDE_PROJECT_DIR is that worktree's root
  // (falls back to cwd). The marker must live in the worktree the session is
  // using, not the primary checkout, so a sibling session's cleanup sees it.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const stateDir = path.join(projectDir, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  // Content is just the timestamp; the mtime is what matters to the cleanup scan.
  writeFileSync(path.join(stateDir, "SESSION-HEARTBEAT"), new Date().toISOString(), "utf8");
} catch {
  /* fail-open: a missed heartbeat only risks a recoverable cleanup, never data */
}
// PostToolUse hooks that emit nothing are treated as pass-through.
process.exit(0);
