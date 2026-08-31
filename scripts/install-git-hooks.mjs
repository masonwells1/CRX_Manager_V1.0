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
import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

try {
  // Exits 5 when there is nothing to remove, and errors when worktreeConfig is off.
  // Neither is a failure — both mean there is no override to clear.
  try {
    git(["config", "--worktree", "--unset-all", "core.hooksPath"]);
  } catch {
    /* no worktree-scoped override, or worktree config is not enabled */
  }
  git(["config", "core.hooksPath", ".husky"]);
} catch {
  // No git on PATH, not a repository, or an unwritable config. An install must not
  // fail over this; `npm run agent-health` reports the resulting state as a FAIL.
}
