#!/usr/bin/env node
// Point git at the TRACKED .husky directory. Run from package.json's `prepare`,
// so every `npm install` / `npm ci` re-establishes it.
//
// Why not `husky`: husky sets core.hooksPath to .husky/_, which it generates during
// install and gitignores. Any worktree created without an install in it then resolves
// the setting to a directory that is not there, and git skips a missing hook in
// SILENCE — commit and push run with no guard and report nothing unusual. 14 of 44
// worktrees were in that state on 2026-08-31. `.husky` is tracked, so it is present
// in every checkout at every commit, and a relative value resolves against each
// worktree's own root.
//
// Why the unset comes first: with extensions.worktreeConfig enabled (it is here), a
// per-worktree core.hooksPath OUTRANKS the shared local value. Writing the shared
// value alone leaves a stale foreign override effective, so `npm install` would
// report success while repairing nothing. Clear the worktree scope, then set shared.
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// Only two outcomes mean "there was nothing to clear": exit 5 (the key is not set in
// this scope) and a repository without extensions.worktreeConfig (no per-worktree
// scope exists). Anything else — an unwritable config, a locked index, a git that
// does not understand --worktree — left a REAL override in place, and staying quiet
// about it is what makes a stale foreign hooks path survive an install unnoticed.
export function clearWorktreeOverride(run = spawnSync) {
  const result = run("git", ["config", "--worktree", "--unset-all", "core.hooksPath"], { encoding: "utf8" });
  if (result.error) return { cleared: false, reason: result.error.message };
  if (result.status === 0 || result.status === 5) return { cleared: true };
  const stderr = String(result.stderr || "").trim();
  if (/worktreeConfig/i.test(stderr)) return { cleared: true };
  return { cleared: false, reason: stderr || `git config --worktree exited ${result.status}` };
}

function main() {
  const outcome = clearWorktreeOverride();
  if (!outcome.cleared) {
    // Do not fail the install, but do not pretend either. A worktree-scoped value
    // OUTRANKS the shared one set below, so the guards may still be wrong here.
    console.warn(
      `git hooks: could not clear the worktree-scoped core.hooksPath — ${outcome.reason}. ` +
        "A stale override still outranks the shared value; run `npm run agent-health` and check the " +
        "`Git hooks installed` row before trusting this checkout's commit and push guards.",
    );
  }
  try {
    git(["config", "core.hooksPath", ".husky"]);
  } catch (error) {
    // No git on PATH, not a repository, or an unwritable config. An install must not
    // fail over this; `npm run agent-health` reports the resulting state as a FAIL.
    console.warn(`git hooks: could not set core.hooksPath to .husky — ${error.message}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
