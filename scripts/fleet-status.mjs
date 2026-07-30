#!/usr/bin/env node
// Cross-worktree FLEET STATUS for Mason.
//
// Mason runs many parallel Claude sessions, each in its own worktree, and has to ask
// "where are we at?" in every window separately. This script answers it ONCE, across
// the whole fleet: for every worktree it reports the branch, whether that branch is
// already merged into live main, how many files are uncommitted, the newest loop
// ledger's last entry, and the newest mission doc — then lists every parked migration
// still waiting for Mason's OK to apply live.
//
// Run from ANY worktree:   node scripts/fleet-status.mjs
// Optional freshness:      node scripts/fleet-status.mjs --fetch   (one `git fetch origin main` first)
//
// Read-only, no network unless --fetch, degrades gracefully: a missing folder or a
// git error on one worktree is noted and the report continues.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorktreePorcelain, normPath,
  mergedLabelFromStatus, isLedgerDoc, isParkedMigrationFile, isDraftSqlName, isParkedFallbackFile,
  lastNonEmptyLine, firstCommentLine,
  draftPathspec, normRepoPath, createOwnDraftPathsReader, originMainDraftPathSet,
  fallbackPathsAgainstOrigin, parkedMainlineDiscoveryFrom,
  ORIGIN_MAIN_PARKED_MIGRATION_GREP_ARGS, originMainParkedMigrationPrefilter,
  ORIGIN_MAIN_CAT_FILE_MAX_BUFFER, originMainSqlBlobMap as parseOriginMainSqlBlobMap,
  originMainForwardBlobPaths,
} from "../.claude/hooks/worktree-awareness-lib.mjs";

// The repo root this script lives in (works no matter what cwd it's launched from).
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const notes = []; // degraded-mode notes, printed at the end

function git(args, cwd = repoRoot, timeout = 5000) {
  return execFileSync("git", args, {
    encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], cwd,
  });
}

// Read every prefiltered origin/main SQL blob in one bounded Git process. The
// shared parser validates echoed paths, record delimiters, and complete framing.
function originMainSqlBlobMap(paths) {
  return parseOriginMainSqlBlobMap(paths, (input) => {
    const result = spawnSync("git", ["cat-file", "--batch=%(objectname) %(objecttype) %(objectsize) %(rest)"], {
      cwd: repoRoot,
      input,
      timeout: 5000,
      maxBuffer: ORIGIN_MAIN_CAT_FILE_MAX_BUFFER,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout : null;
  });
}

function listDir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

// Recursively list files (depth-limited). Parked drafts live in NESTED audit
// folders like docs/audits/codex-driven-bug-hunt/PARKED-005-...draft.sql —
// a flat scan reported "0 parked" while drafts were waiting (Codex 2026-07-05).
function listFilesRecursive(dir, depth = 4) {
  if (depth < 0) return [];
  const out = [];
  for (const name of listDir(dir)) {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...listFilesRecursive(full, depth - 1));
    else out.push(full);
  }
  return out;
}

function mtimeOf(file) {
  try { return statSync(file).mtime; } catch { return null; }
}

function readTextSafe(file) {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

function fmtDate(d) {
  return d ? d.toISOString().slice(0, 10) : "date unknown";
}

// Newest file in `dir` whose name passes `filter`; returns { name, full, mtime } or null.
function newestMatching(dir, filter) {
  let best = null;
  for (const name of listDir(dir)) {
    if (!filter(name)) continue;
    const full = path.join(dir, name);
    const mt = mtimeOf(full);
    if (!mt) continue;
    if (!best || mt > best.mtime) best = { name, full, mtime: mt };
  }
  return best;
}

// ── 1. Optional fetch (the ONLY network call, and only with --fetch) ──
if (process.argv.includes("--fetch")) {
  try {
    git(["fetch", "origin", "main", "--quiet"], repoRoot, 20000);
  } catch {
    notes.push("`git fetch origin main` failed — merge-state below may be slightly stale.");
  }
}

// ── 2. List the fleet ──
let entries = [];
try {
  entries = parseWorktreePorcelain(git(["worktree", "list", "--porcelain"]));
} catch (err) {
  console.log("Could not list worktrees (git error) — no fleet report possible from here.");
  console.log(`Detail: ${err && err.message ? String(err.message).split("\n")[0] : "unknown git failure"}`);
  process.exit(1);
}

let hasOriginMain = false;
try { git(["rev-parse", "--verify", "--quiet", "origin/main"]); hasOriginMain = true; } catch { hasOriginMain = false; }
if (!hasOriginMain) notes.push("origin/main not found locally — merge-state is unknown and any degraded parked scan uses conservative all-disk discovery (inherited historical files may appear; try --fetch).");
const originMainDraftPaths = hasOriginMain ? originMainDraftPathSet((args) => {
  try { return git(args, repoRoot, 5000).split("\n"); } catch { return null; }
}) : null;
if (hasOriginMain && !originMainDraftPaths) notes.push("origin/main exists but its draft tree could not be read — degraded parked scans use conservative all-disk discovery and may include inherited historical files.");

// Which worktree is "this window"? The one containing cwd, else the script's own repo.
const cwdNorm = normPath(process.cwd());
let currentPath = normPath(repoRoot);
for (const e of entries) {
  const p = normPath(e.path);
  if (cwdNorm === p || cwdNorm.startsWith(p + "/")) currentPath = p;
}

function mergedLabel(sha) {
  if (!hasOriginMain || !sha) return mergedLabelFromStatus(null, false);
  const r = spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
    encoding: "utf8", timeout: 5000, cwd: repoRoot,
  });
  return mergedLabelFromStatus(r.status, true);
}

// The drafts a worktree is actually pending: everything it changed since its branch
// point (committed or still in the working tree) plus anything untracked. Frozen review
// snapshots changed nothing, so they contribute nothing — that is what made the fleet
// count clearable — while a draft genuinely being written in one still shows up as
// untracked. Returns null when the branch point is unknown; the caller then falls back
// to the full on-disk scan rather than hide pending work.
//
// The rule itself lives in the shared lib, not here, so this report and the SessionStart
// banner cannot drift apart — the whole point of the 2026-07-29 fix is that they agree.
const ownDraftPaths = createOwnDraftPathsReader({
  repoRoot,
  hasOriginMain,
  dirtyCount,
  exists: (wtPath, rel) => existsSync(path.join(wtPath, ...rel.split("/"))),
  readText: (wtPath, rel) => readTextSafe(path.join(wtPath, ...rel.split("/"))),
  run: (args, cwd) => {
    const r = spawnSync("git", args, { encoding: "utf8", timeout: 5000, cwd });
    return r.status === 0 ? String(r.stdout || "").split("\n") : null;
  },
});

// Memoized: the report line and the parked scan both ask, and this is one git spawn.
const dirtyCache = new Map(); // wt path → count | null
function dirtyCount(wtPath) {
  if (dirtyCache.has(wtPath)) return dirtyCache.get(wtPath);
  let result = null;
  try {
    // -uall, not the default: a repo with status.showUntrackedFiles=no would report an
    // unwritten draft's checkout as CLEAN, and the clean path skips the untracked scan —
    // silently hiding pending work, the exact defect this change exists to fix.
    result = git(["status", "--porcelain", "-uall"], wtPath, 5000).split("\n").filter((l) => l.trim()).length;
  } catch { result = null; }
  dirtyCache.set(wtPath, result);
  return result;
}

// ── 3. Per-worktree report + parked-migration collection ──
// Keyed by repo-relative PATH, never by filename: draft names repeat across hunts, so a
// filename key would silently merge two different pending drafts into one entry. The same
// draft checked out in 42 worktrees sits at the same relative path in each, so it still
// collapses to one row (with every worktree listed under `where`).
const parked = new Map(); // repo-relative path → { name, where: [labels], mtime, comment }
let supersededSkipped = 0;
let degradedFallbackUnknown = false;
const wtLines = [];

function addParked(rel, full, label) {
  const key = normRepoPath(rel);
  const hit = parked.get(key);
  if (hit) {
    if (!hit.where.includes(label)) hit.where.push(label);
    return;
  }
  parked.set(key, {
    name: rel,
    where: [label],
    mtime: mtimeOf(full),
    comment: firstCommentLine(readTextSafe(full), 120),
  });
}

for (const e of entries) {
  const label = path.basename(e.path.replace(/[\\/]+$/, "")) || e.path;
  const isCurrent = normPath(e.path) === currentPath;

  if (!e.path || !existsSync(e.path)) {
    wtLines.push(`• ${label} — folder missing on disk (stale worktree entry — skip it)`);
    continue;
  }

  const branch = e.detached ? `(detached @ ${(e.head || "").slice(0, 8)})` : (e.branch || "(no branch)");
  const merged = e.detached ? "detached" : mergedLabel(e.head);
  const dc = dirtyCount(e.path);
  const dirty = dc === null ? "git status unreadable" : dc === 0 ? "clean" : `${dc} changed file${dc === 1 ? "" : "s"}`;

  const head = `• ${label}${isCurrent ? " (this window)" : ""} — branch ${branch} — ${merged} — ${dirty}`;
  const sub = [];

  // Newest loop ledger: what did that session last log?
  const loopsDir = path.join(e.path, "docs", "loops");
  const ledger = newestMatching(loopsDir, isLedgerDoc);
  if (ledger) {
    const tail = lastNonEmptyLine(readTextSafe(ledger.full), 120);
    sub.push(`last ledger entry (${ledger.name}, ${fmtDate(ledger.mtime)}): ${tail || "(empty file)"}`);
  }

  // Newest mission doc (loop docs that aren't ledgers) — name only.
  const mission = newestMatching(loopsDir, (n) => /\.md$/i.test(n) && !isLedgerDoc(n));
  if (mission) sub.push(`newest mission doc: ${mission.name}`);

  // Parked migrations in THIS worktree: only the drafts it is itself pending. Every
  // checkout holds drafts main has since retired; counting those made the fleet number
  // un-clearable. What a worktree changed since its branch point is exactly its own work.
  const own = ownDraftPaths(e);
  if (own) {
    for (const rel of own.values()) addParked(rel, path.join(e.path, ...rel.split("/")), label);
  } else {
    // Branch point unreadable (no origin/main, or the checkout is mid-delete by another
    // session) — scan the whole checkout rather than risk reporting nothing. That can
    // re-surface drafts main has already retired, so say so instead of letting the number
    // move unexplained.
    let fallbackChangedPaths = null;
    if (originMainDraftPaths) {
      try {
        fallbackChangedPaths = git(["diff", "--name-only", "origin/main", "--", ...draftPathspec()], e.path, 5000).split("\n");
      } catch { /* the comparison below becomes PARKED STATE UNKNOWN */ }
    }
    notes.push(`${label}: could not read its branch point, so it uses a degraded disk scan${originMainDraftPaths ? " with an exact origin/main content comparison" : " with no inherited-path filter"}.`);
    if (originMainDraftPaths && fallbackChangedPaths === null) {
      degradedFallbackUnknown = true;
      notes.push(`PARKED STATE UNKNOWN: ${label} could not compare its draft content to origin/main, so inherited paths were retained conservatively.`);
    }
    for (const { root, filter } of [
      { root: "scripts/.staging-migrations", filter: isParkedMigrationFile },
      { root: "docs/audits", filter: isDraftSqlName },
      { root: "supabase/migrations", filter: (name, full, rel) => isParkedFallbackFile(rel, name, () => readTextSafe(full)) },
    ]) {
      const dir = path.join(e.path, ...root.split("/"));
      for (const full of listFilesRecursive(dir)) {
        const name = path.basename(full);
        if (/^superseded/i.test(name) && /\.sql$/i.test(name)) { supersededSkipped++; continue; }
        const rel = `${root}/${path.relative(dir, full).replace(/\\/g, "/")}`;
        if (originMainDraftPaths && fallbackPathsAgainstOrigin([rel], originMainDraftPaths, fallbackChangedPaths).paths.length === 0) continue;
        if (!filter(name, full, rel)) continue;
        // Display path keeps its real casing — addParked lower-cases the KEY itself, and
        // normalizing here too would print Mason a lower-cased filename that no longer
        // matches what is on disk (CodeRabbit on #279).
        addParked(rel, full, label);
      }
    }
  }

  wtLines.push([head, ...sub.map((s) => `    ${s}`)].join("\n"));
}

// The mainline backlog is read from one immutable origin/main tree. Forward SQL must
// agree with migration-history.md; an anchored status prefilter catches orphaned
// explicit status headers while a batched blob read avoids per-file Git spawns.
const mainlineBlobCache = new Map();
let mainlineParkedState = hasOriginMain ? "known" : "unknown";
let mainlineParkedReason = hasOriginMain ? "" : "origin/main is unavailable";
if (hasOriginMain) {
  try {
    const tree = git(["ls-tree", "-r", "--name-only", "origin/main", "--", ...draftPathspec()], repoRoot, 5000);
    const history = git(["show", "origin/main:docs/reference/migration-history.md"], repoRoot, 5000);
    const parkedPrefilter = originMainParkedMigrationPrefilter(
      () => git(ORIGIN_MAIN_PARKED_MIGRATION_GREP_ARGS, repoRoot, 5000),
    );
    const mainlinePaths = tree.split("\n");
    const blobs = originMainSqlBlobMap(originMainForwardBlobPaths(mainlinePaths, parkedPrefilter.paths));
    for (const [key, text] of blobs || []) mainlineBlobCache.set(key, text);
    const discovery = parkedMainlineDiscoveryFrom(mainlinePaths, history, (p) => blobs?.get(normRepoPath(p)) ?? null, parkedPrefilter.paths);
    mainlineParkedState = discovery.state;
    mainlineParkedReason = discovery.reason;
    for (const p of discovery.paths) {
      const key = normRepoPath(p);
      const hit = parked.get(key);
      if (hit) {
        if (!hit.where.includes("origin/main")) hit.where.push("origin/main");
        continue;
      }
      let text = mainlineBlobCache.get(key);
      if (text === undefined) {
        try {
          text = git(["show", `origin/main:${p}`], repoRoot, 5000);
          mainlineBlobCache.set(key, text);
        } catch { text = ""; }
      }
      let mtime = null;
      try {
        const parsed = new Date(git(["log", "-1", "--format=%aI", "origin/main", "--", p], repoRoot, 5000).trim());
        if (!Number.isNaN(parsed.valueOf())) mtime = parsed;
      } catch { /* report the source path even if its Git date is unavailable */ }
      parked.set(key, { name: p, where: ["origin/main"], mtime, comment: firstCommentLine(text, 120) });
    }
  } catch {
    mainlineParkedState = "unknown";
    mainlineParkedReason = "origin/main parked-state metadata is unreadable";
  }
}
if (mainlineParkedState === "unknown") {
  notes.push(`PARKED STATE UNKNOWN: ${mainlineParkedReason}. Resolve the origin/main migration-history/SQL cross-reference before treating the parked count as clear.`);
}

// ── 4. Print the report ──
const now = new Date();
console.log(`CRX FLEET STATUS — ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`);
console.log(`${entries.length} worktree${entries.length === 1 ? "" : "s"} (parallel work folders). "MERGED into origin/main" = that branch's commits are already in live main.`);
console.log("");
console.log(wtLines.join("\n"));
console.log("");

const parkedList = [...parked.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
const parkedStateUnknown = mainlineParkedState === "unknown" || degradedFallbackUnknown;
console.log(`Parked migrations awaiting apply: ${parkedStateUnknown ? "PARKED STATE UNKNOWN" : parkedList.length}`);
for (const p of parkedList) {
  console.log(`  • ${p.name} — in ${p.where.join(", ")} — last touched ${fmtDate(p.mtime)}${p.comment ? ` — ${p.comment}` : ""}`);
}
if (supersededSkipped > 0) {
  console.log(`  (${supersededSkipped} SUPERSEDED draft${supersededSkipped === 1 ? "" : "s"} ignored — already replaced, not waiting on anyone)`);
}
console.log("");

if (parkedStateUnknown) {
  console.log("PARKED STATE UNKNOWN — do not treat this report as a clean zero until the origin/main migration-history/SQL cross-reference is repaired.");
} else if (parkedList.length > 0) {
  console.log("WAITING ON YOU (Mason):");
  console.log(`  • ${parkedList.length} parked migration${parkedList.length === 1 ? "" : "s"} need${parkedList.length === 1 ? "s" : ""} your OK before touching the live database — say "/parked" to walk through them safely (plain-English explanation + review first; nothing applies without you).`);
} else {
  console.log("Nothing waiting on you — no parked migrations found across the fleet.");
}

if (notes.length > 0) {
  console.log("");
  console.log("Notes:");
  for (const n of notes) console.log(`  - ${n}`);
}
