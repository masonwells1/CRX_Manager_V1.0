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

// A worktree touched within this window is treated as a LIVE session and never
// auto-removed — even if it looks merged+clean+unlocked (2026-07-16 scaffolding
// review: a sibling session's SessionStart sweep deleted an actively-running,
// unlocked, merged-clean worktree because only the CURRENT session's own path was
// protected). "Touched" = the newest mtime of the worktree's git index/HEAD/reflog
// OR its .claude/session-state — including the SESSION-HEARTBEAT marker that
// session-heartbeat.mjs stamps on EVERY tool call, so even a long read-only
// session (which makes no git writes) stays live inside the window. Recoverable
// either way, but losing an in-use checkout mid-session is disruptive; locking is
// the belt, this heartbeat is the suspenders for sessions that didn't lock.
export const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours

// A worktree is treated as harness-managed (safe to auto-remove) only when it
// lives under `.claude/worktrees/`. Mason's long-lived manual checkouts
// (C:\CRX_Manager, C:\CRX_Layer2, …) live elsewhere and are never auto-removed.
export const HARNESS_MARKER = "/.claude/worktrees/";

// Machine-local file the Claude harness rewrites in every worktree (permission
// grants). It is harness noise, not work: a worktree whose ONLY dirt is this
// file is still "clean" for cleanup purposes. 2026-08-18 hook audit: 11 fully
// merged agent worktrees were unsweepable because each carried exactly one
// ` M .claude/settings.local.json` line.
export const IGNORABLE_DIRT_PATH = ".claude/settings.local.json";

// True iff one `git status --porcelain` line refers to the ignorable file.
// Rename lines (`R  old -> new`) never match: the arrow keeps the captured
// path from equaling IGNORABLE_DIRT_PATH exactly, so renames stay real dirt.
export function isIgnorableDirtLine(line) {
  const m = /^.{2} "?(.+?)"?$/.exec(String(line || "").replace(/\r$/, ""));
  if (!m) return false;
  return m[1].replace(/\\/g, "/") === IGNORABLE_DIRT_PATH;
}

// Filter `git status --porcelain` output down to the lines that represent REAL
// uncommitted work. Empty result = clean-for-cleanup.
export function meaningfulDirt(porcelainText) {
  return String(porcelainText || "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim())
    .filter((l) => !isIgnorableDirtLine(l));
}

// Does raw applied-source-ledger JSON text contain at least one REAL entry
// (an object with a non-empty string name — the only shape the recorder
// writes)? Pure so the parse/shape rules are unit-testable; the runner wraps
// the file read. Throws on unparseable text — ledgerKeepsWorktree below decides
// what an unreadable/malformed ledger means.
export function ledgerHasEntries(rawText) {
  const ledger = JSON.parse(String(rawText));
  return Array.isArray(ledger) && ledger.some((e) => e && typeof e.name === "string" && e.name.trim());
}

// Given the result of trying to read a worktree's applied-source ledger, decide
// whether that ledger's state should KEEP the worktree (block auto-cleanup).
//   arg: { readError?: Error|null, rawText?: string }
// Rules (fail toward KEEP on any doubt — CodeRabbit 2026-08-19):
//   - readError with code "ENOENT"  → ledger truly absent → nothing recorded → DON'T keep (false)
//   - any other readError (EACCES/EISDIR/I/O) → present but unreadable → KEEP (true)
//   - rawText that parses            → keep iff it has a real entry (ledgerHasEntries)
//   - rawText that fails to parse     → malformed, contents unknown → KEEP (true)
// The earlier "corrupt/unreadable reads as no entries → sweepable" stance was
// wrong: a read/parse failure is exactly when we can LEAST prove the worktree is
// safe to destroy, and sweeping it can erase the sole record of an un-committed
// live apply. Keeping costs only a manual cleanup.
export function ledgerKeepsWorktree({ readError = null, rawText } = {}) {
  if (readError) return Boolean(readError.code !== "ENOENT");
  try {
    return ledgerHasEntries(rawText);
  } catch {
    return true;
  }
}

// Normalize a filesystem path for comparison: forward slashes, no trailing
// slash, lowercased (Windows paths are case-insensitive).
export function normPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

// Decide the fate of ONE worktree.
//   fact: { path, branch, detached, locked, dirty, merged, lastActivityMs?,
//           hasAppliedLedgerEntries? }
//     - merged: true iff the branch has ZERO commits whose patch is not already
//       in origin/main (computed by the runner via `git cherry`, so squash/rebase
//       merges count as merged — a plain ancestor check would miss those).
//     - lastActivityMs: newest mtime (ms) of the worktree's git index/HEAD/reflog
//       or .claude/session-state; omit/0 if unknown.
//   ctx:  { currentPath, nowMs?, activeWindowMs?, protectedBranches, harnessMarker }
// Returns { action: "remove" | "keep", reason } where reason is a short code.
export function classifyWorktree(fact, ctx = {}) {
  const protectedBranches = ctx.protectedBranches || PROTECTED_BRANCHES;
  const harnessMarker = (ctx.harnessMarker || HARNESS_MARKER).toLowerCase();
  const nowMs = typeof ctx.nowMs === "number" ? ctx.nowMs : Date.now();
  const activeWindowMs = typeof ctx.activeWindowMs === "number" ? ctx.activeWindowMs : ACTIVE_WINDOW_MS;
  const path = normPath(fact.path);

  // 1. Never touch the worktree this very session is running in.
  if (path && path === normPath(ctx.currentPath)) return { action: "keep", reason: "active-session" };
  // 1b. Never touch a worktree with recent activity — a live SIBLING session,
  //     even if merged+clean+unlocked. Guards the observed failure where a
  //     sibling's SessionStart sweep deleted an in-use checkout.
  if (typeof fact.lastActivityMs === "number" && fact.lastActivityMs > 0 &&
      nowMs - fact.lastActivityMs < activeWindowMs) {
    return { action: "keep", reason: "recently-active" };
  }
  // 2. Detached HEAD or no branch — nothing to safely reason about; leave it.
  if (fact.detached || !fact.branch) return { action: "keep", reason: "detached" };
  // 3. Protected branches are never removed.
  if (protectedBranches.includes(fact.branch)) return { action: "keep", reason: "protected-branch" };
  // 4. A locked worktree = an active/held session; respect the lock.
  if (fact.locked) return { action: "keep", reason: "locked" };
  // 5. Uncommitted changes = unfinished work; never discard.
  if (fact.dirty) return { action: "keep", reason: "dirty" };
  // 5b. An unresolved applied-source ledger = a live apply recorded in this
  //     worktree whose committed source was never proven (stop-wrap C3 guard).
  //     The ledger lives in gitignored session-state, so "merged + clean"
  //     cannot see it — sweeping the worktree would destroy the only record of
  //     the un-contained apply (Opus review 2026-08-19). stop-wrap prunes the
  //     ledger once the source is committed, which releases this keep.
  if (fact.hasAppliedLedgerEntries) return { action: "keep", reason: "applied-ledger" };
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
