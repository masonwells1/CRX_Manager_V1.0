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
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorktreePorcelain, normPath,
  mergedLabelFromStatus, isLedgerDoc, isParkedMigrationFile, isDraftSqlName, createParkedFallbackClassifier,
  lastNonEmptyLine, firstCommentLine,
  draftPathspec, normRepoPath, createOwnDraftPathsReader, originMainDraftPathSet,
  fallbackPathsAgainstOrigin, parkedMainlineDiscoveryFrom, localCandidateMigrationPathsFromHistory,
  supersededDraftPathsFrom,
  originMainParkedMigrationGrepArgs, originMainParkedMigrationPrefilter,
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
    // `originMainRev` is read at call time, long after it is resolved below (line ~132).
  }, ORIGIN_MAIN_CAT_FILE_MAX_BUFFER, originMainRev);
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

// Pin origin/main to ONE object id for this entire run. Codex P1 on PR #437: the ref is
// shared with every other session, so a concurrent `git fetch` can advance it between two
// phases of one scan. If the fetch adds a SHA-pinned LOCAL CANDIDATE whose SQL carries no
// parked header, the old history does not name it, the new tree contains it, and the grep
// never sees it — mainline discovery returns "known" while omitting a pending migration.
// Every mainline read below (history, tree, grep, blobs, mtime, merge-base, fallback diff)
// names `originMainRev`, never the moving `origin/main`, so the phases cannot disagree.
let hasOriginMain = false;
let originMainRev = "origin/main";
try {
  originMainRev = String(git(["rev-parse", "--verify", "--quiet", "origin/main"]) || "").trim() || "origin/main";
  hasOriginMain = true;
} catch { hasOriginMain = false; }
if (!hasOriginMain) notes.push("origin/main not found locally — merge-state is unknown and any degraded parked scan uses conservative all-disk discovery (inherited historical files may appear; try --fetch).");
const originMainDraftPaths = hasOriginMain ? originMainDraftPathSet((args) => {
  try { return git(args, repoRoot, 5000).split("\n"); } catch { return null; }
}, originMainRev) : null;
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
  // Pinned like every other mainline read: `--is-ancestor <sha> <rev>` tests sha against rev,
  // so leaving rev symbolic lets a concurrent fetch label one worktree against a newer main
  // than the rest of the same snapshot — and the merge labels against a newer main than the
  // parked scan. Codex P2 on PR #437; the SessionStart hook already pinned its copy.
  const r = spawnSync("git", ["merge-base", "--is-ancestor", sha, originMainRev], {
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

// ONE read of origin/main's shared history for this whole run, shared by the per-worktree
// exemption below and the mainline discovery pass further down. Codex HIGH on PR #437:
// when those two phases each resolved `origin/main` independently, a concurrent fetch
// between them let mainline inspect commit A and report nothing while the exemption saw a
// candidate registered in commit B and suppressed reconciliation — a confident zero over a
// pending migration. Reading once removes the divergence rather than narrowing the window.
let originMainHistoryText; // undefined = not read yet, null = unavailable
function originMainHistory() {
  if (originMainHistoryText !== undefined) return originMainHistoryText;
  if (!hasOriginMain) {
    originMainHistoryText = null;
    return originMainHistoryText;
  }
  try {
    originMainHistoryText = git(["show", `${originMainRev}:docs/reference/migration-history.md`], repoRoot, 5000);
  } catch {
    originMainHistoryText = null;
  }
  return originMainHistoryText;
}

const ownDraftPaths = createOwnDraftPathsReader({
  repoRoot,
  hasOriginMain,
  readOriginMainHistory: originMainHistory,
  originMainRev,
  dirtyCount,
  exists: (wtPath, rel) => existsSync(path.join(wtPath, ...rel.split("/"))),
  readText: (wtPath, rel) => readTextSafe(path.join(wtPath, ...rel.split("/"))),
  readHistory: (wtPath) => {
    const text = readTextSafe(path.join(wtPath, "docs", "reference", "migration-history.md"));
    return text || null;
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
const supersededSkipped = new Set();
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
    for (const rel of own.supersededPaths?.values() || []) supersededSkipped.add(normRepoPath(rel));
    if (own.unknownReason) {
      degradedFallbackUnknown = true;
      notes.push(`PARKED STATE UNKNOWN: ${label}: ${own.unknownReason}.`);
    }
  } else {
    // Branch point unreadable (no origin/main, or the checkout is mid-delete by another
    // session) — scan the whole checkout rather than risk reporting nothing. That can
    // re-surface drafts main has already retired, so say so instead of letting the number
    // move unexplained.
    let fallbackChangedPaths = null;
    const fallbackHistoryText = readTextSafe(path.join(e.path, "docs", "reference", "migration-history.md")) || null;
    const fallbackDiscoveryUnknownReasons = new Set();
    const classifyFallback = createParkedFallbackClassifier(
      fallbackHistoryText,
      (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex"),
    );
    if (originMainDraftPaths) {
      try {
        fallbackChangedPaths = git(["diff", "--name-only", originMainRev, "--", ...draftPathspec()], e.path, 5000).split("\n");
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
      { root: "supabase/migrations", filter: (name, full, rel) => {
        const discovery = classifyFallback(
          rel,
          name,
          () => readTextSafe(full),
        );
        if (discovery.state === "unknown") {
          degradedFallbackUnknown = true;
          fallbackDiscoveryUnknownReasons.add(discovery.reason);
        }
        return discovery.parked;
      } },
    ]) {
      const dir = path.join(e.path, ...root.split("/"));
      for (const full of listFilesRecursive(dir)) {
        const name = path.basename(full);
        const rel = `${root}/${path.relative(dir, full).replace(/\\/g, "/")}`;
        if (originMainDraftPaths && fallbackPathsAgainstOrigin([rel], originMainDraftPaths, fallbackChangedPaths).paths.length === 0) continue;
        if (/^superseded/i.test(name) && /\.sql$/i.test(name)) {
          supersededSkipped.add(normRepoPath(rel));
          continue;
        }
        if (!filter(name, full, rel)) continue;
        // Display path keeps its real casing — addParked lower-cases the KEY itself, and
        // normalizing here too would print Mason a lower-cased filename that no longer
        // matches what is on disk (CodeRabbit on #279).
        addParked(rel, full, label);
      }
    }
    for (const reason of fallbackDiscoveryUnknownReasons) {
      notes.push(`PARKED STATE UNKNOWN: ${label}: ${reason}.`);
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
    const tree = git(["ls-tree", "-r", "--name-only", originMainRev, "--", ...draftPathspec()], repoRoot, 5000);
    // The SAME bytes the per-worktree exemption used — see originMainHistory() above.
    const history = originMainHistory();
    if (history === null) throw new Error("origin/main migration history is unreadable");
    const parkedPrefilter = originMainParkedMigrationPrefilter(
      () => git(originMainParkedMigrationGrepArgs(originMainRev), repoRoot, 5000),
      originMainRev,
    );
    const mainlinePaths = tree.split("\n");
    for (const rel of supersededDraftPathsFrom(mainlinePaths, () => true).values()) {
      supersededSkipped.add(normRepoPath(rel));
    }
    const historyCandidates = localCandidateMigrationPathsFromHistory(history);
    const blobs = originMainSqlBlobMap(originMainForwardBlobPaths(
      mainlinePaths,
      parkedPrefilter.paths,
      historyCandidates.state === "known" ? historyCandidates.paths : [],
    ));
    for (const [key, text] of blobs || []) mainlineBlobCache.set(key, text);
    const discovery = parkedMainlineDiscoveryFrom(
      mainlinePaths,
      history,
      (p) => blobs?.get(normRepoPath(p)) ?? null,
      parkedPrefilter.paths,
      (text) => createHash("sha256").update(text, "utf8").digest("hex"),
    );
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
          text = git(["show", `${originMainRev}:${p}`], repoRoot, 5000);
          mainlineBlobCache.set(key, text);
        } catch { text = ""; }
      }
      let mtime = null;
      try {
        const parsed = new Date(git(["log", "-1", "--format=%aI", originMainRev, "--", p], repoRoot, 5000).trim());
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
if (supersededSkipped.size > 0) {
  console.log(`  (${supersededSkipped.size} SUPERSEDED draft${supersededSkipped.size === 1 ? "" : "s"} ignored — already replaced, not waiting on anyone)`);
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
