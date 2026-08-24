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

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  parseWorktreePorcelain, siblingsOf, normPath,
  mergedLabelFromStatus, isLedgerDoc, isParkedMigrationFile, isDraftSqlName, createParkedFallbackClassifier, fleetSummaryLine,
  draftPathspec, normRepoPath, createOwnDraftPathsReader, originMainDraftPathSet,
  fallbackPathsAgainstOrigin, parkedMainlineDiscoveryFrom, localCandidateMigrationPathsFromHistory,
  originMainParkedMigrationGrepArgs, originMainParkedMigrationPrefilter,
  ORIGIN_MAIN_CAT_FILE_MAX_BUFFER, originMainSqlBlobMap as parseOriginMainSqlBlobMap,
  originMainForwardBlobPaths,
} from "./worktree-awareness-lib.mjs";

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

// Read every prefiltered origin/main SQL blob in one bounded Git process. The
// shared parser validates echoed paths, record delimiters, and complete framing.
function originMainSqlBlobMap(paths) {
  return parseOriginMainSqlBlobMap(paths, (input) => {
    const result = spawnSync("git", ["cat-file", "--batch=%(objectname) %(objecttype) %(objectsize) %(rest)"], {
      cwd: projectDir,
      input,
      timeout: 5000,
      maxBuffer: ORIGIN_MAIN_CAT_FILE_MAX_BUFFER,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout : null;
    // `originMainRev` is read at call time, long after it is resolved below.
  }, ORIGIN_MAIN_CAT_FILE_MAX_BUFFER, originMainRev);
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
// Pin origin/main to ONE object id for this whole run — see the matching note in
// scripts/fleet-status.mjs (Codex P1 on PR #437). The ref is shared with every other
// session; a concurrent fetch between two phases of one scan can otherwise hide a
// pending migration behind a confident "known" answer.
let hasOriginMain = false;
let originMainRev = "origin/main";
try {
  originMainRev = String(git(["rev-parse", "--verify", "--quiet", "origin/main"]) || "").trim() || "origin/main";
  hasOriginMain = true;
} catch { hasOriginMain = false; }

function mergedLabel(sha) {
  if (!hasOriginMain || !sha) return mergedLabelFromStatus(null, false);
  const r = spawnSync("git", ["merge-base", "--is-ancestor", sha, originMainRev], {
    encoding: "utf8", timeout: 5000, cwd: projectDir,
  });
  return mergedLabelFromStatus(r.status, true);
}

// Memoized: the sibling list and the parked scan both ask, and this is one git spawn.
const dirtyCache = new Map(); // wt path → count | null
function dirtyCount(wtPath) {
  if (dirtyCache.has(wtPath)) return dirtyCache.get(wtPath);
  let result = null;
  try {
    if (existsSync(wtPath)) {
      // -uall, not the default: a repo with status.showUntrackedFiles=no would report
      // an unwritten draft's checkout as CLEAN, and the clean path skips the untracked
      // scan — silently hiding pending work, the exact defect this file exists to fix.
      result = git(["status", "--porcelain", "-uall"], wtPath).split("\n").filter((l) => l.trim()).length;
    }
  } catch { result = null; }
  dirtyCache.set(wtPath, result);
  return result;
}

const lines = siblings.map((s) => {
  const branch = s.detached ? `(detached @ ${(s.head || "").slice(0, 8)})` : (s.branch || "(no branch)");
  const merged = s.detached ? "detached" : mergedLabel(s.head);
  const dc = dirtyCount(s.path);
  const dirty = dc === null ? "unreadable/absent" : `${dc} dirty file${dc === 1 ? "" : "s"}`;
  return `  • ${s.path}\n      branch: ${branch} — ${merged} — ${dirty}`;
});

// Cheap fleet summary: count loop ledgers + parked migrations across ALL worktrees
// (current included), deduped by filename — a tracked ledger exists in every checkout
// and must count once. Pure filesystem reads only (no extra git calls) so the hook
// stays fast; fail-open — any error just drops the line.
function listDir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
// Depth-limited recursive file listing — parked drafts live in NESTED audit
// folders (docs/audits/<hunt>/PARKED-*.sql); a flat scan here would contradict
// /fleet's recursive count (Codex 2026-07-05 P3).
// Returns { name, rel } per file, `rel` being the repo-relative path — the count is keyed
// by path, never by filename, because draft names repeat across hunts and two distinct
// pending drafts must not collapse into one. Used only for the fallback scan.
function listDraftsRecursive(dir, prefix, depth = 4) {
  if (depth < 0) return [];
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  let out = [];
  for (const ent of ents) {
    if (ent.isDirectory()) {
      out = out.concat(listDraftsRecursive(path.join(dir, ent.name), `${prefix}${ent.name}/`, depth - 1));
    } else {
      out.push({ name: ent.name, rel: `${prefix}${ent.name}` });
    }
  }
  return out;
}

// The draft paths a worktree is actually pending: what it changed since its branch point
// (committed or not) plus anything still untracked. Returns null when the branch point is
// unknown, and the caller then falls back to the full on-disk scan rather than hide work.
// The rule itself lives in the shared lib so this and /fleet cannot drift apart.

// ONE read of origin/main's shared history per run, shared by the per-worktree exemption
// and mainlineParkedDiscovery() below. Codex HIGH on PR #437: two independent resolutions
// of `origin/main` let a concurrent fetch put the phases on different commits, so mainline
// could report nothing while the exemption suppressed reconciliation against a newer tree
// — a confident zero over a pending migration.
let originMainHistoryText; // undefined = not read yet, null = unavailable
function originMainHistory() {
  if (originMainHistoryText !== undefined) return originMainHistoryText;
  if (!hasOriginMain) {
    originMainHistoryText = null;
    return originMainHistoryText;
  }
  try {
    originMainHistoryText = git(["show", `${originMainRev}:docs/reference/migration-history.md`]);
  } catch {
    originMainHistoryText = null;
  }
  return originMainHistoryText;
}

const ownDraftPaths = createOwnDraftPathsReader({
  repoRoot: projectDir,
  hasOriginMain,
  readOriginMainHistory: originMainHistory,
  originMainRev,
  dirtyCount,
  exists: (wtPath, rel) => existsSync(path.join(wtPath, ...rel.split("/"))),
  readText: (wtPath, rel) => {
    try { return readFileSync(path.join(wtPath, ...rel.split("/")), "utf8"); } catch { return ""; }
  },
  readHistory: (wtPath) => {
    try { return readFileSync(path.join(wtPath, "docs", "reference", "migration-history.md"), "utf8"); } catch { return null; }
  },
  // Git's default text clean-filter stores LF blobs even when a Windows checkout
  // materializes CRLF. Hash the bytes the candidate will have in Git, matching the
  // immutable origin/main verification path.
  sha256Text: (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex"),
  run: (args, cwd) => {
    const r = spawnSync("git", args, { encoding: "utf8", timeout: 5000, cwd });
    return r.status === 0 ? String(r.stdout || "").split("\n") : null;
  },
});

// The mainline backlog is read from one immutable origin/main tree. A forward SQL
// file counts only when migration-history.md names that exact LOCAL CANDIDATE file;
// an anchored status prefilter also catches orphans, with its blobs read in one batch.
function mainlineParkedDiscovery() {
  try {
    const tree = git(["ls-tree", "-r", "--name-only", originMainRev, "--", ...draftPathspec()]);
    // The SAME bytes the per-worktree exemption used — see originMainHistory() above.
    const history = originMainHistory();
    if (history === null) throw new Error("origin/main migration history is unreadable");
    const parkedPrefilter = originMainParkedMigrationPrefilter(
      () => git(originMainParkedMigrationGrepArgs(originMainRev)),
      originMainRev,
    );
    const mainlinePaths = tree.split("\n");
    const historyCandidates = localCandidateMigrationPathsFromHistory(history);
    const blobs = originMainSqlBlobMap(originMainForwardBlobPaths(
      mainlinePaths,
      parkedPrefilter.paths,
      historyCandidates.state === "known" ? historyCandidates.paths : [],
    ));
    return parkedMainlineDiscoveryFrom(
      mainlinePaths,
      history,
      (p) => blobs?.get(normRepoPath(p)) ?? null,
      parkedPrefilter.paths,
      (text) => createHash("sha256").update(text, "utf8").digest("hex"),
    );
  } catch {
    return { state: "unknown", paths: new Set(), reason: "origin/main parked-state metadata is unreadable" };
  }
}

const originMainDraftPaths = hasOriginMain ? originMainDraftPathSet((args) => {
  try { return git(args, projectDir).split("\n"); } catch { return null; }
}, originMainRev) : null;
const parkedFallbackNote = !hasOriginMain
  ? "\n\nPARKED-SCAN DEGRADED: origin/main is unavailable, so a fallback uses conservative all-disk discovery and may include inherited historical files."
  : !originMainDraftPaths
    ? "\n\nPARKED-SCAN DEGRADED: origin/main exists but its draft tree is unreadable, so a fallback uses conservative all-disk discovery and may include inherited historical files."
    : "";

let fleetLine = "";
try {
  const ledgerNames = new Set();
  const mainline = hasOriginMain
    ? mainlineParkedDiscovery()
    : { state: "unknown", paths: new Set(), reason: "origin/main is unavailable" };
  const parkedPaths = new Set([...mainline.paths].map((p) => normRepoPath(p)));
  const fallbackUnknownReasons = new Set();
  for (const e of entries) {
    if (!e.path || !existsSync(e.path)) continue;
    for (const f of listDir(path.join(e.path, "docs", "loops"))) {
      if (isLedgerDoc(f)) ledgerNames.add(f.toLowerCase());
    }
    // A worktree contributes only the drafts IT is pending — what it changed since its
    // branch point, plus untracked files. Frozen review snapshots changed nothing, so
    // they add nothing, which is what makes the SUPERSEDED- retirement clearable; a draft
    // genuinely being written in one still shows up as untracked. When the branch point
    // can't be read, fall back to the full on-disk scan rather than hide pending work.
    const own = ownDraftPaths(e);
    if (own) {
      for (const key of own.keys()) parkedPaths.add(key);
      if (own.unknownReason) fallbackUnknownReasons.add(`${e.path}: ${own.unknownReason}`);
      continue;
    }
    let fallbackChangedPaths = null;
    let fallbackHistory = null;
    try {
      fallbackHistory = readFileSync(path.join(e.path, "docs", "reference", "migration-history.md"), "utf8");
    } catch { /* discovery below reports the unreadable history as unknown */ }
    const classifyFallback = createParkedFallbackClassifier(
      fallbackHistory,
      (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex"),
    );
    if (originMainDraftPaths) {
      try {
        fallbackChangedPaths = git(["diff", "--name-only", originMainRev, "--", ...draftPathspec()], e.path).split("\n");
      } catch {
        fallbackUnknownReasons.add(`${e.path}: origin/main content comparison is unreadable`);
      }
    }
    const scans = [
      { root: "scripts/.staging-migrations/", filter: isParkedMigrationFile },
      { root: "docs/audits/", filter: isDraftSqlName },
      { root: "supabase/migrations/", filter: (name, rel) => {
        const discovery = classifyFallback(
          rel,
          name,
          () => {
            try { return readFileSync(path.join(e.path, ...rel.split("/")), "utf8"); } catch { return ""; }
          },
        );
        if (discovery.state === "unknown") {
          fallbackUnknownReasons.add(`${e.path}: ${discovery.reason}`);
        }
        return discovery.parked;
      } },
    ];
    for (const { root, filter } of scans) {
      for (const d of listDraftsRecursive(path.join(e.path, ...root.split("/").filter(Boolean)), root)) {
        const comparison = originMainDraftPaths
          ? fallbackPathsAgainstOrigin([d.rel], originMainDraftPaths, fallbackChangedPaths)
          : null;
        if (comparison?.state === "unknown") fallbackUnknownReasons.add(`${e.path}: ${comparison.reason}`);
        if (comparison && comparison.paths.length === 0) continue;
        if (filter(d.name, d.rel)) parkedPaths.add(normRepoPath(d.rel));
      }
    }
  }
  fleetLine = `\n\n${fleetSummaryLine(ledgerNames.size, parkedPaths.size)}` +
    (mainline.state === "unknown" || fallbackUnknownReasons.size > 0
      ? `\nPARKED STATE UNKNOWN: ${[mainline.state === "unknown" ? mainline.reason : "", ...fallbackUnknownReasons].filter(Boolean).join("; ")}. Do not treat the parked count as a clean zero.`
      : "");
} catch { fleetLine = ""; }

emit(
  `═══ PARALLEL WORK DETECTED ═══\n\n` +
  `You are NOT the only session. Mason runs concurrent sessions/worktrees. ${siblings.length} other worktree(s):\n\n` +
  lines.join("\n") +
  fleetLine +
  parkedFallbackNote +
  `\n\nBEFORE building a feature or claiming a fix "done / already shipped / already fixed":\n` +
  `  1. Confirm your task isn't already being handled in one of these (git log that branch).\n` +
  `  2. Verify live ship-state — mcp list_migrations + git ancestry — don't trust this session's picture alone.\n` +
  `  3. Don't delete/modify a sibling's folder or branch without Mason's OK.\n` +
  `(From .claude/hooks/worktree-awareness.mjs. Worktrees churn — this is a snapshot; re-run \`git worktree list\` live.)`
);
