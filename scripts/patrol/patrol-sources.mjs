#!/usr/bin/env node
// The three sources patrol v1 shipped as INCOMPLETE: loop liveness, parked-migration
// state, and review-gate health. All read-only.
//
// Parked-migration discovery deliberately reuses `.claude/hooks/worktree-awareness-lib.mjs`
// — the same library `/fleet` composes. Reimplementing it would give Mason two different
// parked counts and no way to tell which is right.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  parseWorktreePorcelain,
  isLedgerDoc,
  normRepoPath,
  createOwnDraftPathsReader,
  draftPathspec,
  parkedMainlineDiscoveryFrom,
  localCandidateMigrationPathsFromHistory,
  supersededDraftPathsFrom,
  originMainParkedMigrationGrepArgs,
  originMainParkedMigrationPrefilter,
  originMainSqlBlobMap as parseOriginMainSqlBlobMap,
  originMainForwardBlobPaths,
  ORIGIN_MAIN_CAT_FILE_MAX_BUFFER,
} from "../../.claude/hooks/worktree-awareness-lib.mjs";

// A ledger untouched this long, while something still claims to be running, is suspect.
export const LEDGER_STALL_MS = 30 * 60_000;
// Evidence older than this tells us nothing about a gate's health right now.
export const GATE_EVIDENCE_TTL_MS = 24 * 60 * 60_000;

const readTextSafe = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const mtimeOf = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };
const listDir = (d) => { try { return readdirSync(d); } catch { return []; } };

// ── loop liveness ───────────────────────────────────────────────────────────

// The probe's own process must appear in its own output. fleet.md records this the hard
// way: when the parent shell eats the filter, the probe returns nothing and reads as
// "no loops running" — a false all-clear about exactly the thing we are checking. Zero
// self-rows therefore means the PROBE broke, never that nothing is running.
export function probeProcesses(run = defaultProcessRun) {
  const raw = run();
  if (raw === null) return { ok: false, reason: "process probe could not be executed", rows: [] };
  let rows;
  try {
    const parsed = JSON.parse(raw || "null");
    rows = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return { ok: false, reason: "process probe returned unparseable output", rows: [] };
  }
  const selfRows = rows.filter((r) => /(^|\\)powershell\.exe$/i.test(String(r?.Name ?? "")));
  if (selfRows.length === 0) {
    return { ok: false, reason: "process probe returned no powershell row — the probe itself failed, so 'nothing running' cannot be concluded", rows: [] };
  }
  return { ok: true, rows };
}

function defaultProcessRun() {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(codex|claude|node|powershell)\\.exe$' } " +
    "| Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress";
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  return r.status === 0 ? String(r.stdout || "") : null;
}

const COMPLETION_MARKER = /\b(LOOP COMPLETE|MISSION COMPLETE|CLOSED OUT|FINAL ENTRY|COMPLETE\b.*\bno further)/i;

// A ledger nobody has touched in a week is history sitting in docs/loops, not a loop that
// died five minutes ago. Without this window the first live run called twelve ledgers from
// July "stalled" and put them all in front of Mason.
export const LEDGER_ARCHIVED_MS = 7 * 24 * 60 * 60_000;

export function classifyLedgerState(
  { ledgerAgeMs, hasCompletionMarker, processClaimsIt, probeOk },
  stallMs = LEDGER_STALL_MS,
  archivedMs = LEDGER_ARCHIVED_MS,
) {
  if (hasCompletionMarker) return "FINISHED";
  if (ledgerAgeMs !== null && ledgerAgeMs > archivedMs) return "ARCHIVED";
  // Without a trustworthy probe we cannot tell a dead loop from a slow one. Saying
  // INDETERMINATE keeps it visible; guessing ALIVE would hide a dead loop.
  if (!probeOk) return "INDETERMINATE";
  const stalled = ledgerAgeMs !== null && ledgerAgeMs > stallMs;
  if (processClaimsIt && stalled) return "STALLED";
  if (processClaimsIt) return "PROGRESSING";
  if (stalled) return "DEAD";
  // Fresh ledger, no process claiming it: the writer just exited, or the probe cannot see
  // it. Not enough to call it dead.
  return "INDETERMINATE";
}

// Attribute a process to the LONGEST worktree path it names, at a path boundary.
// A bare substring test is wrong here: the main checkout `C:/CRX_Manager` is a prefix of
// every nested worktree `C:/CRX_Manager/.claude/worktrees/...`, so any node process
// anywhere in the repo matched the main worktree and marked all of its ledgers as live.
export function attributeProcess(commandLine, worktreePaths) {
  const cl = String(commandLine ?? "").replace(/\\/g, "/").toLowerCase();
  let best = null;
  for (const wt of worktreePaths) {
    const norm = String(wt).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!norm) continue;
    const at = cl.indexOf(norm);
    if (at === -1) continue;
    const next = cl.charAt(at + norm.length);
    if (next && !/[/\\"'\s;,)]/.test(next)) continue; // not a path boundary
    if (!best || norm.length > best.length) best = { path: wt, length: norm.length };
  }
  return best ? best.path : null;
}

export function collectLoops(repoRoot, { run = defaultProcessRun, nowMs = Date.now() } = {}) {
  const src = { name: "loops", required: false, status: "OK", expected: null, received: 0 };
  const loops = [];
  try {
    const probe = probeProcesses(run);
    if (!probe.ok) { src.status = "INCOMPLETE"; src.detail = probe.reason; }

    const entries = parseWorktreePorcelain(gitOut(["worktree", "list", "--porcelain"], repoRoot));
    const wtPaths = entries.map((e) => e.path).filter(Boolean);
    // Resolve each process to exactly one worktree first, so a nested worktree's process
    // is never also credited to its parent checkout.
    const claimedPaths = new Set();
    if (probe.ok) {
      for (const r of probe.rows) {
        const owner = attributeProcess(r?.CommandLine, wtPaths);
        if (owner) claimedPaths.add(owner);
      }
    }

    const seen = new Set();
    for (const e of entries) {
      if (!e.path || !existsSync(e.path)) continue;
      const loopsDir = path.join(e.path, "docs", "loops");
      for (const name of listDir(loopsDir)) {
        if (!isLedgerDoc(name)) continue;
        const full = path.join(loopsDir, name);
        const key = `${name}`;
        if (seen.has(key)) continue; // the same ledger is checked out in many worktrees
        seen.add(key);
        const mt = mtimeOf(full);
        const text = readTextSafe(full);
        const claimed = claimedPaths.has(e.path);
        loops.push({
          name,
          worktree: e.path,
          ledgerAgeMs: mt === null ? null : nowMs - mt,
          state: classifyLedgerState({
            ledgerAgeMs: mt === null ? null : nowMs - mt,
            hasCompletionMarker: COMPLETION_MARKER.test(text.slice(-4000)),
            processClaimsIt: claimed,
            probeOk: probe.ok,
          }),
        });
      }
    }
    src.expected = seen.size;
    src.received = loops.length;
  } catch (e) {
    src.status = "ERROR";
    src.detail = String(e.message).slice(0, 200);
  }
  return { src, loops };
}

// ── parked migrations ───────────────────────────────────────────────────────

export function collectParkedMigrations(repoRoot) {
  const src = { name: "parkedMigrations", required: false, status: "OK", expected: null, received: 0 };
  try {
    let originMainRev = "origin/main";
    let hasOriginMain = false;
    try {
      originMainRev = String(gitOut(["rev-parse", "--verify", "--quiet", "origin/main"], repoRoot)).trim() || "origin/main";
      hasOriginMain = Boolean(originMainRev);
    } catch { hasOriginMain = false; }

    let historyText;
    const readOriginMainHistory = () => {
      if (historyText !== undefined) return historyText;
      try { historyText = gitOut(["show", `${originMainRev}:docs/reference/migration-history.md`], repoRoot); }
      catch { historyText = null; }
      return historyText;
    };

    const dirtyCache = new Map();
    const dirtyCount = (wtPath) => {
      if (dirtyCache.has(wtPath)) return dirtyCache.get(wtPath);
      let n = null;
      try { n = gitOut(["status", "--porcelain", "-uall"], wtPath).split("\n").filter((l) => l.trim()).length; } catch { n = null; }
      dirtyCache.set(wtPath, n);
      return n;
    };

    const ownDraftPaths = createOwnDraftPathsReader({
      repoRoot, hasOriginMain, readOriginMainHistory, originMainRev, dirtyCount,
      exists: (wtPath, rel) => existsSync(path.join(wtPath, ...rel.split("/"))),
      readText: (wtPath, rel) => readTextSafe(path.join(wtPath, ...rel.split("/"))),
      readHistory: (wtPath) => readTextSafe(path.join(wtPath, "docs", "reference", "migration-history.md")) || null,
      // Hash the bytes Git stores (LF), not what a Windows checkout materializes.
      sha256Text: (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex"),
      run: (args, cwd) => {
        const r = spawnSync("git", args, { encoding: "utf8", timeout: 5000, cwd });
        return r.status === 0 ? String(r.stdout || "").split("\n") : null;
      },
    });

    const names = new Set();
    const unknown = [];
    for (const e of parseWorktreePorcelain(gitOut(["worktree", "list", "--porcelain"], repoRoot))) {
      if (!e.path || !existsSync(e.path)) continue;
      const own = ownDraftPaths(e);
      if (!own) { unknown.push(`${path.basename(e.path)}: branch point unreadable`); continue; }
      for (const rel of own.values()) names.add(normRepoPath(rel));
      if (own.unknownReason) unknown.push(`${path.basename(e.path)}: ${own.unknownReason}`);
    }

    // Worktree-owned discovery deliberately EXEMPTS drafts inherited from origin/main, so
    // it alone can return zero while an unapplied mainline migration still waits on Mason.
    // /fleet runs a second, separate mainline pass for exactly this reason; without it
    // patrol could report "no parked migrations" and contribute to a false all-clear.
    let mainlineState = hasOriginMain ? "known" : "unknown";
    let mainlineReason = hasOriginMain ? "" : "origin/main is unavailable";
    if (hasOriginMain) {
      try {
        const tree = gitOut(["ls-tree", "-r", "--name-only", originMainRev, "--", ...draftPathspec()], repoRoot);
        const history = readOriginMainHistory();
        if (history === null) throw new Error("origin/main migration history is unreadable");
        const prefilter = originMainParkedMigrationPrefilter(
          () => gitOut(originMainParkedMigrationGrepArgs(originMainRev), repoRoot),
          originMainRev,
        );
        const mainlinePaths = tree.split("\n");
        for (const rel of supersededDraftPathsFrom(mainlinePaths, () => true).values()) names.delete(normRepoPath(rel));
        const historyCandidates = localCandidateMigrationPathsFromHistory(history);
        const blobs = parseOriginMainSqlBlobMap(
          originMainForwardBlobPaths(
            mainlinePaths,
            prefilter.paths,
            historyCandidates.state === "known" ? historyCandidates.paths : [],
          ),
          (input) => {
            const r = spawnSync("git", ["cat-file", "--batch=%(objectname) %(objecttype) %(objectsize) %(rest)"], {
              cwd: repoRoot, input, timeout: 20_000, maxBuffer: ORIGIN_MAIN_CAT_FILE_MAX_BUFFER, stdio: ["pipe", "pipe", "ignore"],
            });
            return r.status === 0 ? r.stdout : null;
          },
          ORIGIN_MAIN_CAT_FILE_MAX_BUFFER,
          originMainRev,
        );
        const discovery = parkedMainlineDiscoveryFrom(
          mainlinePaths,
          history,
          (p) => blobs?.get(normRepoPath(p)) ?? null,
          prefilter.paths,
          (text) => createHash("sha256").update(text, "utf8").digest("hex"),
        );
        mainlineState = discovery.state;
        mainlineReason = discovery.reason;
        for (const p of discovery.paths) names.add(normRepoPath(p));
      } catch (e) {
        mainlineState = "unknown";
        mainlineReason = `origin/main parked-state metadata is unreadable: ${String(e.message).slice(0, 120)}`;
      }
    }

    if (!hasOriginMain) { src.status = "INCOMPLETE"; src.detail = "origin/main not available locally — parked discovery would be unreliable"; }
    else if (mainlineState === "unknown") {
      src.status = "INCOMPLETE";
      src.detail = `mainline parked state unknown: ${mainlineReason}`;
    }
    else if (unknown.length) {
      // /fleet says "do not treat the parked count as a clean zero" in this case. Patrol
      // says the same thing by refusing to call the source OK.
      src.status = "INCOMPLETE";
      src.detail = `parked state unknown for ${unknown.length} worktree(s): ${unknown.slice(0, 3).join("; ")}`;
    }
    src.expected = names.size;
    src.received = names.size;
    return { src, parked: { count: names.size, names: [...names].sort() } };
  } catch (e) {
    src.status = "ERROR";
    src.detail = String(e.message).slice(0, 200);
    return { src, parked: null };
  }
}

// ── review-gate health ──────────────────────────────────────────────────────

// Anchored to an actual error LINE, not a substring anywhere in the capture. The capture
// embeds the reviewed diff, so an unanchored match reported the gate as down whenever the
// reviewed code merely mentioned a usage limit — which is what happened the first time
// patrol reviewed this very file. Same trap as a guard that matches text instead of effect.
const USAGE_LIMIT = /^\s*(?:ERROR|error)\b[^\n]*(?:usage limit|quota exceeded|insufficient (?:credits|quota)|rate limit)/m;
const CLEAN_VERDICT = /^CODEX_PROOF_VERDICT:\s*CLEAN\s*$/m;

// Health is judged from evidence, never assumed. Proving Codex healthy would mean
// spending a review, so "no recent evidence" stays UNKNOWN rather than becoming HEALTHY.
export function judgeCodexGate({ captureText, captureAgeMs }, ttlMs = GATE_EVIDENCE_TTL_MS) {
  if (captureText === null || captureAgeMs === null) return { state: "UNKNOWN", detail: "no recent Codex run to judge from" };
  if (captureAgeMs > ttlMs) return { state: "UNKNOWN", detail: "the most recent Codex evidence is over a day old" };
  if (USAGE_LIMIT.test(captureText)) return { state: "DOWN", detail: "the last Codex run stopped on a usage limit — the gate did not run, which is not the same as the gate saying no" };
  if (CLEAN_VERDICT.test(captureText)) return { state: "HEALTHY", detail: "the last Codex run returned a verdict" };
  return { state: "UNKNOWN", detail: "the last Codex run produced no parseable verdict" };
}

export function judgeCodeRabbitGate(descriptions) {
  const blocked = descriptions.filter((d) => /rate limit|spending|budget|quota/i.test(String(d ?? "")));
  if (blocked.length) return { state: "DOWN", detail: `CodeRabbit reported a limit on ${blocked.length} pull request(s): ${blocked[0]}` };
  if (descriptions.length === 0) return { state: "UNKNOWN", detail: "no recent CodeRabbit status to judge from" };
  return { state: "HEALTHY", detail: "CodeRabbit is posting statuses normally" };
}

export function collectGateHealth(repoRoot, { coderabbitDescriptions = [], nowMs = Date.now() } = {}) {
  const src = { name: "gateHealth", required: false, status: "OK", expected: 2, received: 0 };
  const gates = [];
  try {
    const capturePath = path.join(repoRoot, ".claude", "session-state", "codex-review-latest.txt");
    const mt = mtimeOf(capturePath);
    const codex = judgeCodexGate({
      captureText: mt === null ? null : readTextSafe(capturePath),
      captureAgeMs: mt === null ? null : nowMs - mt,
    });
    gates.push({ name: "codex-sol-gate", ...codex });
    gates.push({ name: "coderabbit", ...judgeCodeRabbitGate(coderabbitDescriptions) });
    src.received = gates.length;
  } catch (e) {
    src.status = "ERROR";
    src.detail = String(e.message).slice(0, 200);
  }
  return { src, gates };
}

function gitOut(args, cwd) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
}
