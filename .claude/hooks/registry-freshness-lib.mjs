// Shared helpers for the REGISTRY-STALE.flag cross-worktree problem (FIX 4,
// 2026-07-13). Pure-ish functions (git call is injectable) so they can be
// unit-tested without a real multi-worktree repo — see registry-freshness.test.mjs.
//
// PROBLEM: registry-freshness.mjs (PostToolUse) writes the flag to
// <projectDir>/.claude/session-state/REGISTRY-STALE.flag, and sql-safety.mjs
// (PreToolUse) reads it from that same projectDir-relative path. CRX Manager
// routinely runs several sessions in parallel, each in its own git WORKTREE
// (see docs — "Shared-tree parallel-session mechanics" / "Parallel-sessions
// collision check"). Each worktree checkout has its OWN .claude/session-state/
// directory, so a flag written after a live apply in worktree A is invisible
// to a session running in worktree B, or in the main checkout.
//
// FIX: resolve the flag directory via `git rev-parse --git-common-dir`, which
// always points at the ONE shared .git directory no matter which
// worktree/checkout invoked git. Its parent directory is the main checkout's
// working-tree root. Write the flag to BOTH the common (main-checkout)
// location and the local (projectDir) location — transition safety, so a
// session that hasn't picked up this fix yet still sees a flag written the
// old way, and vice versa. Read from EITHER location — a flag present in
// either counts as stale.
//
// Falls back to the local-only path when git resolution fails for any reason
// (non-git directory, git not installed, spawn error, timeout) — this stays
// fail-open, matching every other guard in this repo.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const FLAG_RELATIVE = [".claude", "session-state", "REGISTRY-STALE.flag"];

// Resolve the main checkout's working-tree root via `git rev-parse
// --git-common-dir`, run from `projectDir`. Returns an absolute path, or null
// if git resolution fails for any reason (non-git dir, git missing, timeout).
// `execFileSyncFn` is injectable for tests.
export function resolveMainCheckoutRoot(projectDir, execFileSyncFn = execFileSync) {
  try {
    const out = execFileSyncFn("git", ["rev-parse", "--git-common-dir"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (!out) return null;
    // `--git-common-dir` can print an absolute path or one relative to cwd
    // (typically ".git" when not in a worktree — i.e. this checkout IS the
    // main one, and common == local, which is fine, just redundant).
    const gitCommonDir = path.isAbsolute(out) ? out : path.resolve(projectDir, out);
    return path.dirname(gitCommonDir);
  } catch {
    return null;
  }
}

// The candidate flag paths for a given projectDir: the shared (main-checkout)
// path and the local (projectDir-relative) path. commonPath is null when git
// resolution fails.
export function flagCandidatePaths(projectDir, execFileSyncFn = execFileSync) {
  const localPath = path.join(projectDir, ...FLAG_RELATIVE);
  const mainRoot = resolveMainCheckoutRoot(projectDir, execFileSyncFn);
  const commonPath = mainRoot ? path.join(mainRoot, ...FLAG_RELATIVE) : null;
  return { commonPath, localPath };
}

// Write the flag to BOTH the common (main-checkout) location and the local
// (projectDir) location. Fail-open per location — a write failure at one
// location does not prevent the other, and never throws.
export function writeStaleFlag(projectDir, flagData, execFileSyncFn = execFileSync) {
  const { commonPath, localPath } = flagCandidatePaths(projectDir, execFileSyncFn);
  const body = JSON.stringify(flagData, null, 2) + "\n";
  const written = [];
  // Write to EVERY checkout's local path, not just common+ours — a sibling
  // worktree still running the pre-2026-07-13 hook reads only its own local
  // flag and would miss a common-only write (Codex P2 round 3, mixed-version
  // transition safety).
  const targetSet = new Set([localPath]);
  if (commonPath) targetSet.add(commonPath);
  for (const root of listWorktreeRoots(projectDir, execFileSyncFn)) {
    targetSet.add(path.join(root, ...FLAG_RELATIVE));
  }
  for (const p of targetSet) {
    try {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, body);
      written.push(p);
    } catch {
      /* fail-open per location */
    }
  }
  return { written, commonPath, localPath };
}

// Enumerate every checkout (main + all linked worktrees) via
// `git worktree list --porcelain`. Returns [] on any git failure — callers
// treat that as "only the known common/local paths".
export function listWorktreeRoots(projectDir, execFileSyncFn = execFileSync) {
  try {
    const out = execFileSyncFn("git", ["worktree", "list", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return String(out)
      .split(/\r?\n/)
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Clear the flag EVERYWHERE it can live (Codex P1+P2 2026-07-13):
//  - the shared/common (main-checkout) path and this checkout's local path, AND
//  - every sibling worktree's local path (an apply in worktree A leaves A's
//    local copy, which clearing from B used to miss — A stayed blocked forever).
// opts.cutoffIso (optional but recommended): only delete a flag whose
// `created` timestamp is <= the cutoff — a flag written AFTER the refresh
// started belongs to a NEWER apply the refreshed registry doesn't include, and
// deleting it would silently un-stale a genuinely stale registry (Codex P2
// concurrent-refresh race). Flags with no parseable `created` are deleted
// (junk can't be adjudicated). Never throws.
export function clearStaleFlag(projectDir, opts = {}, execFileSyncFn = execFileSync) {
  const { cutoffIso = null } = opts && typeof opts === "object" ? opts : {};
  const { commonPath, localPath } = flagCandidatePaths(projectDir, execFileSyncFn);
  const candidateSet = new Set([localPath]);
  if (commonPath) candidateSet.add(commonPath);
  for (const root of listWorktreeRoots(projectDir, execFileSyncFn)) {
    candidateSet.add(path.join(root, ...FLAG_RELATIVE));
  }
  const removed = [];
  const kept = [];
  for (const p of candidateSet) {
    try {
      if (!existsSync(p)) continue;
      if (cutoffIso) {
        let created = null;
        try { created = JSON.parse(readFileSync(p, "utf8"))?.created || null; } catch { /* unparseable = junk */ }
        if (created && Date.parse(created) > Date.parse(cutoffIso)) {
          kept.push(p); // newer than the refresh — a later apply re-staled the registry; leave it
          continue;
        }
      }
      unlinkSync(p);
      removed.push(p);
    } catch {
      /* fail-open per location */
    }
  }
  return { removed, kept, commonPath, localPath };
}

// Read the flag from EITHER location — present in either counts as stale.
// Returns { stale: boolean, path: string|null, flag: object|null }.
export function readStaleFlag(projectDir, execFileSyncFn = execFileSync) {
  const { commonPath, localPath } = flagCandidatePaths(projectDir, execFileSyncFn);
  // Scan every checkout's local flag too — a flag written by a sibling still
  // running the OLD (local-only) hook must still stale THIS session (Codex P2
  // round 3, mixed-version transition safety).
  const candidateSet = new Set([localPath]);
  if (commonPath) candidateSet.add(commonPath);
  for (const root of listWorktreeRoots(projectDir, execFileSyncFn)) {
    candidateSet.add(path.join(root, ...FLAG_RELATIVE));
  }
  const candidates = [...candidateSet];
  for (const p of candidates) {
    if (existsSync(p)) {
      let flag = null;
      try {
        flag = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        /* present but unparseable — still counts as stale */
      }
      return { stale: true, path: p, flag };
    }
  }
  return { stale: false, path: null, flag: null };
}
