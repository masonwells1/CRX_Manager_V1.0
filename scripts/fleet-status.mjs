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
  mergedLabelFromStatus, isLedgerDoc, isParkedMigrationFile, isDraftSqlName,
  lastNonEmptyLine, firstCommentLine,
} from "../.claude/hooks/worktree-awareness-lib.mjs";

// The repo root this script lives in (works no matter what cwd it's launched from).
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const notes = []; // degraded-mode notes, printed at the end

function git(args, cwd = repoRoot, timeout = 5000) {
  return execFileSync("git", args, {
    encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], cwd,
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
if (!hasOriginMain) notes.push("origin/main not found locally — merge-state shown as unknown (try --fetch).");

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

function dirtyCount(wtPath) {
  try {
    const out = git(["status", "--porcelain"], wtPath, 5000);
    return out.split("\n").filter((l) => l.trim()).length;
  } catch {
    return null;
  }
}

// ── 3. Per-worktree report + parked-migration collection ──
const parked = new Map(); // lower-cased filename → { name, where: [labels], mtime, comment }
let supersededSkipped = 0;
const wtLines = [];

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

  // Parked migrations in THIS worktree: staged drafts + audit drafts.
  const parkedDirs = [
    { dir: path.join(e.path, "scripts", ".staging-migrations"), filter: isParkedMigrationFile },
    { dir: path.join(e.path, "docs", "audits"), filter: isDraftSqlName },
  ];
  for (const { dir, filter } of parkedDirs) {
    for (const full of listFilesRecursive(dir)) {
      const name = path.basename(full);
      if (/^superseded/i.test(name) && /\.sql$/i.test(name)) { supersededSkipped++; continue; }
      if (!filter(name)) continue;
      const key = name.toLowerCase();
      if (parked.has(key)) {
        // Same draft checked out in several worktrees — count it once.
        if (!parked.get(key).where.includes(label)) parked.get(key).where.push(label);
        continue;
      }
      parked.set(key, {
        name,
        where: [label],
        mtime: mtimeOf(full),
        comment: firstCommentLine(readTextSafe(full), 120),
      });
    }
  }

  wtLines.push([head, ...sub.map((s) => `    ${s}`)].join("\n"));
}

// ── 4. Print the report ──
const now = new Date();
console.log(`CRX FLEET STATUS — ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`);
console.log(`${entries.length} worktree${entries.length === 1 ? "" : "s"} (parallel work folders). "MERGED into origin/main" = that branch's commits are already in live main.`);
console.log("");
console.log(wtLines.join("\n"));
console.log("");

const parkedList = [...parked.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
console.log(`Parked migrations awaiting apply: ${parkedList.length}`);
for (const p of parkedList) {
  console.log(`  • ${p.name} — in ${p.where.join(", ")} — last touched ${fmtDate(p.mtime)}${p.comment ? ` — ${p.comment}` : ""}`);
}
if (supersededSkipped > 0) {
  console.log(`  (${supersededSkipped} SUPERSEDED draft${supersededSkipped === 1 ? "" : "s"} ignored — already replaced, not waiting on anyone)`);
}
console.log("");

if (parkedList.length > 0) {
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
