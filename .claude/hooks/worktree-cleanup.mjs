#!/usr/bin/env node
// SessionStart hook: auto-remove FINISHED worktrees/branches (Mason, 2026-07-13:
// "make sessions clean up their own worktree when done so we stop doing this by hand").
//
// A session can't delete its OWN active worktree (it's standing in it), so the
// contract is: each new session sweeps away the PREVIOUS finished ones. Net
// effect — worktrees and dead branches stop piling up, deferred by one session.
//
// SAFETY (the whole point): the pure classifier in worktree-cleanup-lib.mjs only
// ever marks something for removal when it is PROVABLY finished — fully merged
// into origin/main (via `git cherry`, so squash/rebase merges count), clean,
// unlocked, not the active session, not a protected branch, and (for worktrees)
// under .claude/worktrees/. Anything else is kept and reported. Every deletion
// prints a recovery SHA. Fail-open: any error → do nothing, emit nothing.
//
// Modes:
//   (hook / default)  perform cleanup, emit a SessionStart report only if it acted
//   --report          DRY RUN: print the plan in plain text, delete nothing
//   --write           perform cleanup and print a plain-text report (manual use)

import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { parseWorktreePorcelain } from "./worktree-awareness-lib.mjs";
import { planCleanup, HARNESS_MARKER } from "./worktree-cleanup-lib.mjs";

const argv = process.argv.slice(2);
const REPORT_ONLY = argv.includes("--report");
const HOOK_MODE = !argv.includes("--report") && !argv.includes("--write"); // default invocation = SessionStart hook

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function git(args, cwd, timeout = 6000) {
  return execFileSync("git", args, {
    encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], cwd: cwd || projectDir,
  });
}
function gitTry(args, cwd) { try { return { ok: true, out: git(args, cwd) }; } catch (e) { return { ok: false, out: "", err: e }; } }

// SessionStart passes a JSON payload on stdin; read & ignore so the pipe closes.
if (HOOK_MODE) { try { readFileSync(0, "utf8"); } catch { /* fine */ } }

function emitHook(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: extra },
    }));
  }
  process.exit(0);
}
// Unified "done, output nothing further" for whichever mode we're in.
function done(reportText) {
  if (HOOK_MODE) emitHook(reportText || null);
  if (reportText) process.stdout.write(reportText + "\n");
  process.exit(0);
}

try {
  // Must be a git repo.
  const wtList = gitTry(["worktree", "list", "--porcelain"]);
  if (!wtList.ok) done(null);

  // Parse worktrees (path/branch/head/detached) + capture the `locked` flag,
  // which the shared parser doesn't track. A locked worktree = a held/active
  // session; we never remove it.
  const entries = parseWorktreePorcelain(wtList.out);
  const lockedPaths = new Set();
  {
    let curPath = null;
    for (const raw of wtList.out.split("\n")) {
      const line = raw.replace(/\r/g, "");
      if (line.startsWith("worktree ")) curPath = line.slice("worktree ".length).trim();
      else if (line === "locked" || line.startsWith("locked ")) { if (curPath) lockedPaths.add(curPath); }
    }
  }

  // Best-effort refresh of origin/main. If it fails we proceed anyway: a STALE
  // origin/main can only make us MORE conservative (fewer things look merged),
  // never less — so acting on it is still safe.
  gitTry(["fetch", "origin", "--quiet"]);

  // Need origin/main to judge "merged". Without it, do nothing (fail safe).
  if (!gitTry(["rev-parse", "--verify", "--quiet", "origin/main"]).ok) done(null);

  const currentTop = (gitTry(["rev-parse", "--show-toplevel"]).out || projectDir).trim();

  // A branch is "merged" iff `git cherry origin/main <branch>` reports no '+'
  // lines (every commit's patch is already upstream — catches rebase/squash).
  function isMerged(branch) {
    const r = spawnSync("git", ["cherry", "origin/main", branch], {
      encoding: "utf8", timeout: 8000, cwd: projectDir,
    });
    if (r.status !== 0 || r.error) return false; // unknown → treat as NOT merged (safe)
    return !r.stdout.split("\n").some((l) => l.startsWith("+"));
  }
  function dirty(wtPath) {
    if (!existsSync(wtPath)) return false; // absent dir → let `git worktree remove` handle/prune it
    const r = gitTry(["status", "--porcelain"], wtPath);
    return r.ok ? r.out.split("\n").some((l) => l.trim()) : true; // unreadable → assume dirty (keep)
  }

  // Build worktree facts.
  const worktreeFacts = entries.map((e) => ({
    path: e.path,
    branch: e.branch,
    detached: e.detached,
    locked: lockedPaths.has(e.path),
    dirty: e.detached || !e.branch ? false : dirty(e.path),
    merged: e.detached || !e.branch ? false : isMerged(e.branch),
  }));
  const worktreeBranches = new Set(entries.map((e) => e.branch).filter(Boolean));

  // Orphan branches = local branches not checked out in any worktree.
  const allBranches = (gitTry(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).out || "")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const branchFacts = allBranches
    .filter((b) => !worktreeBranches.has(b))
    .map((b) => ({ branch: b, checkedOut: false, merged: isMerged(b) }));

  const plan = planCleanup({ worktrees: worktreeFacts, branches: branchFacts }, { currentPath: currentTop });

  // Snapshot recovery SHAs BEFORE deleting anything.
  const shaOf = (ref) => (gitTry(["rev-parse", "--short", ref]).out || "").trim();
  for (const w of plan.removeWorktrees) w.sha = shaOf(w.branch);
  for (const b of plan.removeBranches) b.sha = shaOf(b.branch);

  const removed = [];
  const failed = [];

  if (!REPORT_ONLY) {
    for (const w of plan.removeWorktrees) {
      // Plain `remove` (no --force): git itself refuses if the tree became dirty
      // or locked in a race — a second safety net under the classifier.
      const rm = gitTry(["worktree", "remove", w.path]);
      if (!rm.ok) { failed.push({ ...w, kind: "worktree" }); continue; }
      gitTry(["branch", "-D", w.branch]); // free branch now that its worktree is gone
      removed.push({ kind: "worktree", ...w });
    }
    for (const b of plan.removeBranches) {
      const del = gitTry(["branch", "-D", b.branch]);
      if (!del.ok) { failed.push({ ...b, kind: "branch" }); continue; }
      removed.push({ kind: "branch", ...b });
    }
    if (removed.length) gitTry(["worktree", "prune"]); // tidy admin entries
  }

  // ── Build report ──
  const keptUnmerged = plan.keep.filter((k) => k.reason === "unmerged")
    .map((k) => `${k.branch}`);

  if (REPORT_ONLY) {
    const wLines = plan.removeWorktrees.map((w) => `  • ${w.path}  (branch ${w.branch} — merged, clean)`);
    const bLines = plan.removeBranches.map((b) => `  • branch ${b.branch}  (merged)`);
    const body = [
      `🧹 worktree-cleanup DRY RUN — would remove ${plan.removeWorktrees.length} worktree(s) + ${plan.removeBranches.length} branch(es):`,
      ...wLines, ...bLines,
      keptUnmerged.length ? `Kept (unmerged work): ${keptUnmerged.join(", ")}` : "Kept: nothing has unmerged work.",
      `(Nothing deleted — this is --report. Run without --report to execute.)`,
    ].join("\n");
    done(body);
  }

  if (removed.length === 0 && failed.length === 0) done(null); // stay silent when there was nothing to do

  const rLines = removed.map((r) =>
    r.kind === "worktree"
      ? `  ✓ removed ${r.path} (branch ${r.branch} — merged; recover: git branch ${r.branch} ${r.sha})`
      : `  ✓ deleted branch ${r.branch} (merged; recover: git branch ${r.branch} ${r.sha})`);
  const fLines = failed.map((f) => `  ⚠ could not remove ${f.kind} ${f.branch || f.path} (skipped — investigate)`);

  const report =
    `🧹 AUTO-CLEANED ${removed.length} finished item(s) (fully merged into origin/main, clean, recoverable):\n` +
    rLines.join("\n") +
    (fLines.length ? `\n${fLines.join("\n")}` : "") +
    (keptUnmerged.length ? `\n\nKept — real unmerged work (untouched): ${keptUnmerged.join(", ")}` : "") +
    `\n(From .claude/hooks/worktree-cleanup.mjs. Only provably-finished worktrees are removed; a session never removes its own. Dry-run: \`node .claude/hooks/worktree-cleanup.mjs --report\`.)`;

  done(report);
} catch (err) {
  // Absolute fail-open: never let cleanup brick a session start.
  if (!HOOK_MODE) process.stderr.write(`worktree-cleanup: skipped (${err && err.message})\n`);
  done(null);
}
