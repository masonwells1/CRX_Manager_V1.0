// Pure decision logic for worktree-cleanup.mjs — the SessionStart guard that
// auto-removes FINISHED worktrees/branches so they stop piling up (Mason,
// 2026-07-13: "make sessions clean up their own worktree when done").
//
// A session can't delete its OWN active worktree (it's standing in it), so the
// real contract is: each new session sweeps away the *previous* finished ones.
//
// This file is PURE (no git, no fs) so the safety boundary can be exhaustively
// unit-tested. The runner (worktree-cleanup.mjs) gathers git facts and feeds
// them in. The cardinal rule: a thing is removed ONLY when it is provably
// finished — fully merged into origin/main AND clean AND unlocked AND not the
// active session AND not a protected branch. Anything else is KEPT and reported.
// Every classification returns a reason code so the report can explain itself.

export const PROTECTED_BRANCHES = ["main", "master"];

// A worktree is treated as harness-managed (safe to auto-remove) only when it
// lives under `.claude/worktrees/`. Mason's long-lived manual checkouts
// (C:\CRX_Manager, C:\CRX_Layer2, …) live elsewhere and are never auto-removed.
export const HARNESS_MARKER = "/.claude/worktrees/";

// Normalize a filesystem path for comparison: forward slashes, no trailing
// slash, lowercased (Windows paths are case-insensitive).
export function normPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// Decide the fate of ONE worktree.
//   fact: { path, branch, detached, locked, dirty, merged }
//     - merged: true iff the branch has ZERO commits whose patch is not already
//       in origin/main (computed by the runner via `git cherry`, so squash/rebase
//       merges count as merged — a plain ancestor check would miss those).
//   ctx:  { currentPath, protectedBranches = PROTECTED_BRANCHES, harnessMarker = HARNESS_MARKER }
// Returns { action: "remove" | "keep", reason } where reason is a short code.
export function classifyWorktree(fact, ctx = {}) {
  const protectedBranches = ctx.protectedBranches || PROTECTED_BRANCHES;
  const harnessMarker = (ctx.harnessMarker || HARNESS_MARKER).toLowerCase();
  const path = normPath(fact.path);

  // 1. Never touch the worktree this very session is running in.
  if (path && path === normPath(ctx.currentPath)) return { action: "keep", reason: "active-session" };
  // 2. Detached HEAD or no branch — nothing to safely reason about; leave it.
  if (fact.detached || !fact.branch) return { action: "keep", reason: "detached" };
  // 3. Protected branches are never removed.
  if (protectedBranches.includes(fact.branch)) return { action: "keep", reason: "protected-branch" };
  // 4. A locked worktree = an active/held session; respect the lock.
  if (fact.locked) return { action: "keep", reason: "locked" };
  // 5. Uncommitted changes = unfinished work; never discard.
  if (fact.dirty) return { action: "keep", reason: "dirty" };
  // 6. Unmerged commits = real un-shipped work; leave for human triage.
  if (!fact.merged) return { action: "keep", reason: "unmerged" };
  // 7. Only auto-remove harness-managed worktrees, never manual long-lived ones.
  if (!path.includes(harnessMarker)) return { action: "keep", reason: "not-harness" };
  // All safety gates passed: provably finished.
  return { action: "remove", reason: "merged-clean" };
}

// Decide the fate of ONE local branch that is NOT checked out in any worktree
// (an "orphan" branch — the dead-branch pile).
//   fact: { branch, merged, checkedOut }
//   ctx:  { protectedBranches = PROTECTED_BRANCHES }
// Returns { action: "remove" | "keep", reason }.
export function classifyBranch(fact, ctx = {}) {
  const protectedBranches = ctx.protectedBranches || PROTECTED_BRANCHES;
  if (protectedBranches.includes(fact.branch)) return { action: "keep", reason: "protected-branch" };
  // Defensive: a branch attached to any worktree is handled by the worktree pass.
  if (fact.checkedOut) return { action: "keep", reason: "checked-out" };
  if (!fact.merged) return { action: "keep", reason: "unmerged" };
  return { action: "remove", reason: "merged" };
}

// Build a full cleanup plan from gathered facts.
//   worktrees: array of worktree facts (see classifyWorktree)
//   branches:  array of orphan-branch facts (see classifyBranch)
// Returns { removeWorktrees, removeBranches, keep } — `keep` carries reasons so
// the report can show WHY something was spared.
export function planCleanup({ worktrees = [], branches = [] } = {}, ctx = {}) {
  const removeWorktrees = [];
  const removeBranches = [];
  const keep = [];
  for (const wt of worktrees) {
    const verdict = classifyWorktree(wt, ctx);
    if (verdict.action === "remove") removeWorktrees.push({ ...wt, reason: verdict.reason });
    else keep.push({ kind: "worktree", ...wt, reason: verdict.reason });
  }
  for (const br of branches) {
    const verdict = classifyBranch(br, ctx);
    if (verdict.action === "remove") removeBranches.push({ ...br, reason: verdict.reason });
    else keep.push({ kind: "branch", ...br, reason: verdict.reason });
  }
  return { removeWorktrees, removeBranches, keep };
}
