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

import { readFileSync, existsSync, statSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { parseWorktreePorcelain } from "./worktree-awareness-lib.mjs";
import { planCleanup, meaningfulDirt, ledgerKeepsWorktree, IGNORABLE_DIRT_PATH, HARNESS_MARKER } from "./worktree-cleanup-lib.mjs";

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

  // Best-effort refresh of origin/main — at most once per 30 minutes. This hook
  // fires on session startup, and a network fetch every time made session starts
  // slow and timeout-prone (2026-08-18 hook audit: SessionStart p90 ~11s). A
  // ≤30-min-old FETCH_HEAD is fresh enough here, and skipping is safe for the
  // same reason a failed fetch is: a STALE origin/main can only make us MORE
  // conservative (fewer things look merged), never less.
  const FETCH_TTL_MS = 30 * 60 * 1000;
  let fetchedRecently = false;
  const fetchHeadPath = gitTry(["rev-parse", "--git-path", "FETCH_HEAD"]);
  if (fetchHeadPath.ok) {
    try {
      fetchedRecently = Date.now() - statSync(path.resolve(projectDir, fetchHeadPath.out.trim())).mtimeMs < FETCH_TTL_MS;
    } catch { /* no FETCH_HEAD yet → fetch below */ }
  }
  if (!fetchedRecently) gitTry(["fetch", "origin", "--quiet"]);

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
  function porcelain(wtPath) {
    const r = gitTry(["status", "--porcelain"], wtPath);
    return r.ok ? r.out : null; // null = unreadable
  }
  // "Dirty" = has MEANINGFUL uncommitted work. A harness-touched
  // .claude/settings.local.json as the sole dirt does not count (see
  // IGNORABLE_DIRT_PATH in worktree-cleanup-lib.mjs) — that one file kept 11
  // fully-merged worktrees alive forever.
  function dirty(wtPath) {
    if (!existsSync(wtPath)) return false; // absent dir → let `git worktree remove` handle/prune it
    const out = porcelain(wtPath);
    return out === null ? true : meaningfulDirt(out).length > 0; // unreadable → assume dirty (keep)
  }

  // Newest mtime (ms) among a worktree's live-activity markers: its git index,
  // HEAD, reflog (touched on every commit/checkout/merge), and anything under
  // .claude/session-state (hook state an active session writes continuously).
  // A recent value means a LIVE session — the classifier keeps it. Best-effort;
  // any error contributes nothing (0), so a worktree is never KEPT-forever on a
  // read error, only removed when it also looks provably finished.
  function lastActivityMs(wtPath) {
    if (!wtPath || !existsSync(wtPath)) return 0;
    const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
    let newest = 0;
    for (const rel of ["index", "HEAD", "logs/HEAD"]) {
      const gp = gitTry(["rev-parse", "--git-path", rel], wtPath);
      if (gp.ok) newest = Math.max(newest, mtime(path.resolve(wtPath, gp.out.trim())));
    }
    const stateDir = path.join(wtPath, ".claude", "session-state");
    try {
      newest = Math.max(newest, mtime(stateDir));
      for (const name of readdirSync(stateDir)) newest = Math.max(newest, mtime(path.join(stateDir, name)));
    } catch { /* no session-state → contributes nothing */ }
    return newest;
  }

  // Unresolved applied-source ledger = a recorded live apply whose committed
  // source stop-wrap never proved. Gitignored, so merged+clean can't see it;
  // sweeping the worktree would destroy the only record (Opus review
  // 2026-08-19). Fail toward KEEP on any doubt (CodeRabbit 2026-08-19): ENOENT
  // (truly absent) is the ONLY sweepable case — unreadable or malformed keeps
  // the worktree. The full decision lives in ledgerKeepsWorktree
  // (worktree-cleanup-lib.mjs), where every branch is unit-tested.
  function hasAppliedLedgerEntries(wtPath) {
    let rawText;
    let readError = null;
    try {
      rawText = readFileSync(path.join(wtPath, ".claude", "session-state", "applied-source-ledger.json"), "utf8");
    } catch (err) {
      readError = err;
    }
    return ledgerKeepsWorktree({ readError, rawText });
  }

  // Build worktree facts.
  const worktreeFacts = entries.map((e) => ({
    path: e.path,
    branch: e.branch,
    detached: e.detached,
    locked: lockedPaths.has(e.path),
    dirty: e.detached || !e.branch ? false : dirty(e.path),
    merged: e.detached || !e.branch ? false : isMerged(e.branch),
    lastActivityMs: lastActivityMs(e.path),
    hasAppliedLedgerEntries: hasAppliedLedgerEntries(e.path),
  }));
  const worktreeBranches = new Set(entries.map((e) => e.branch).filter(Boolean));

  // Orphan branches = local branches not checked out in any worktree.
  const allBranches = (gitTry(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).out || "")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const branchFacts = allBranches
    .filter((b) => !worktreeBranches.has(b))
    .map((b) => ({ branch: b, checkedOut: false, merged: isMerged(b) }));

  const plan = planCleanup({ worktrees: worktreeFacts, branches: branchFacts }, { currentPath: currentTop, nowMs: Date.now() });

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
      let rm = gitTry(["worktree", "remove", w.path]);
      if (!rm.ok) {
        // git refuses when the ONLY dirt is the ignorable harness file too. In
        // exactly that case (re-checked NOW, not at classification time — the
        // race safety net stays intact), restore/drop that one file and retry
        // plain remove once. Never --force: any other dirt still blocks.
        const out = existsSync(w.path) ? porcelain(w.path) : null;
        const lines = out === null ? [] : out.split("\n").filter((l) => l.trim());
        const onlyIgnorableDirt = lines.length > 0 && meaningfulDirt(out).length === 0;
        if (onlyIgnorableDirt) {
          // Save the file's bytes first: if the retry ALSO fails, the worktree
          // survives, and having reverted/deleted its permission grants without
          // removing it would be a destructive edit with no payoff (Opus
          // review 2026-08-19). Restore is best-effort.
          const dirtAbs = path.join(w.path, IGNORABLE_DIRT_PATH);
          const existedBefore = existsSync(dirtAbs);
          let savedDirt = null;
          if (existedBefore) { try { savedDirt = readFileSync(dirtAbs); } catch { /* present but unreadable */ } }
          const co = gitTry(["checkout", "HEAD", "--", IGNORABLE_DIRT_PATH], w.path); // tracked → restore index+worktree
          if (!co.ok) { try { rmSync(dirtAbs); } catch { /* untracked/missing */ } }
          rm = gitTry(["worktree", "remove", w.path]);
          if (!rm.ok) {
            // Retry failed → the worktree survives, so leave it in its ORIGINAL
            // state rather than whatever `checkout HEAD` re-materialized. If the
            // file EXISTED and we snapshotted it, restore those bytes. If it was
            // ABSENT originally (a deletion the user made, or genuinely missing),
            // the checkout may have re-created it from HEAD — remove it so the
            // surviving worktree isn't silently modified back to a file the user
            // had deleted (CodeRabbit PR #423). A present-but-unsnapshotted file
            // (read failed) is left as checked out — the best available state.
            if (existedBefore) {
              if (savedDirt !== null) { try { writeFileSync(dirtAbs, savedDirt); } catch { /* best-effort restore */ } }
            } else {
              try { rmSync(dirtAbs); } catch { /* nothing to undo */ }
            }
          }
        }
      }
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
