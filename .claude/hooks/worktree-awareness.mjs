#!/usr/bin/env node
// SessionStart hook: parallel-work awareness.
//
// Mason runs MULTIPLE concurrent sessions/worktrees on CRX. Claude repeatedly claims
// "everything is shipped / already fixed" while accounting only for the current session's
// branch — missing work in a sibling worktree, or re-doing a fix another session already
// landed. This hook injects, at the very start of every session, a list of the OTHER
// worktrees, each with its branch, whether that branch is merged into origin/main, and how
// many files are dirty — so Claude forms its plan already knowing it isn't the only session.
//
// It is silent when there are no sibling worktrees (a solo session), so it never nags.
// Fail-open: any error → emit nothing.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { parseWorktreePorcelain, siblingsOf, normPath } from "./worktree-awareness-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: extra },
    }));
  }
  process.exit(0);
}

// Read (and ignore) the payload; SessionStart provides cwd/source but we don't need it.
try { readFileSync(0, "utf8"); } catch { /* fine */ }

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function git(args, cwd) {
  return execFileSync("git", args, {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], cwd: cwd || projectDir,
  });
}

let porcelain = "";
try {
  porcelain = git(["worktree", "list", "--porcelain"]);
} catch {
  emit(); // not a git repo / git unavailable — stay silent
}

let entries;
try {
  entries = parseWorktreePorcelain(porcelain);
} catch {
  emit();
}

const siblings = siblingsOf(entries, projectDir);
if (siblings.length === 0) emit(); // solo session — nothing to warn about

// Does origin/main exist? If not, we can't compute merged-state; label it "unknown".
let hasOriginMain = false;
try { git(["rev-parse", "--verify", "--quiet", "origin/main"]); hasOriginMain = true; } catch { hasOriginMain = false; }

function mergedLabel(sha) {
  if (!hasOriginMain || !sha) return "merge-state unknown";
  const r = spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
    encoding: "utf8", timeout: 5000, cwd: projectDir,
  });
  if (r.status === 0) return "MERGED into origin/main";
  if (r.status === 1) return "UNMERGED (not in origin/main)";
  return "merge-state unknown";
}

function dirtyCount(wtPath) {
  try {
    if (!existsSync(wtPath)) return null; // stale worktree entry
    const out = git(["status", "--porcelain"], wtPath);
    return out.split("\n").filter((l) => l.trim()).length;
  } catch {
    return null;
  }
}

const lines = siblings.map((s) => {
  const branch = s.detached ? `(detached @ ${(s.head || "").slice(0, 8)})` : (s.branch || "(no branch)");
  const merged = s.detached ? "detached" : mergedLabel(s.head);
  const dc = dirtyCount(s.path);
  const dirty = dc === null ? "unreadable/absent" : `${dc} dirty file${dc === 1 ? "" : "s"}`;
  return `  • ${s.path}\n      branch: ${branch} — ${merged} — ${dirty}`;
});

emit(
  `═══ PARALLEL WORK DETECTED ═══\n\n` +
  `You are NOT the only session. Mason runs concurrent sessions/worktrees. ${siblings.length} other worktree(s):\n\n` +
  lines.join("\n") +
  `\n\nBEFORE building a feature or claiming a fix "done / already shipped / already fixed":\n` +
  `  1. Confirm your task isn't already being handled in one of these (git log that branch).\n` +
  `  2. Verify live ship-state — mcp list_migrations + git ancestry — don't trust this session's picture alone.\n` +
  `  3. Don't delete/modify a sibling's folder or branch without Mason's OK.\n` +
  `(From .claude/hooks/worktree-awareness.mjs. Worktrees churn — this is a snapshot; re-run \`git worktree list\` live.)`
);
