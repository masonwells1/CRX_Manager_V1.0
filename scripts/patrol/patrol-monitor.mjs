#!/usr/bin/env node
// Dead-man monitor for patrol.
//
// Patrol cannot report its own death: if the loop stops, the laptop sleeps, or auth
// expires, it simply goes quiet — and quiet is indistinguishable from "nothing needs
// you". This process is the thing that notices.
//
// It is deliberately NOT a Claude hook. An earlier design hung the alarm on SessionStart,
// which fails twice over: the hook lives in a worktree the evaluated branch can edit, and
// it only fires when someone starts a session — so the exact deaths it claimed to catch
// (nobody working, machine asleep) produced no alarm at all. This runs from the OS
// scheduler, independent of any agent session.
//
// Usage:
//   node scripts/patrol/patrol-monitor.mjs           # exit 0 healthy, 7 overdue/invalid
//   node scripts/patrol/patrol-monitor.mjs --quiet   # print only when something is wrong
//
// Exit codes: 0 healthy · 7 alarm (overdue, missing, malformed, or future-dated).

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HEARTBEAT_OVERDUE_MS } from "./patrol-classify.mjs";

export const ALARM_EXIT = 7;
const SCHEMA_VERSION = 1;

export function judgeHeartbeat(raw, nowMs, overdueMs = HEARTBEAT_OVERDUE_MS) {
  if (raw === null) {
    return { healthy: false, reason: "no patrol heartbeat exists — patrol has never completed a scan on this machine, or its state directory was removed" };
  }
  let hb;
  try { hb = JSON.parse(raw); } catch {
    return { healthy: false, reason: "the patrol heartbeat is unreadable — treat patrol as not running" };
  }
  if (hb?.schemaVersion !== SCHEMA_VERSION) {
    return { healthy: false, reason: `the patrol heartbeat is schema version ${hb?.schemaVersion}, not ${SCHEMA_VERSION} — it cannot be trusted` };
  }
  if (!hb.runId) return { healthy: false, reason: "the patrol heartbeat names no run — it was not written by a completed scan" };
  const at = Date.parse(hb.at);
  if (!Number.isFinite(at)) return { healthy: false, reason: "the patrol heartbeat has no usable timestamp" };
  // A future-dated heartbeat means a bad clock or a forged file. Either way it must not
  // be able to keep the monitor quiet forever.
  if (at - nowMs > 60_000) {
    return { healthy: false, reason: "the patrol heartbeat is dated in the future — check the system clock; a skewed clock could keep this alarm silent indefinitely" };
  }
  const ageMs = nowMs - at;
  if (ageMs > overdueMs) {
    const mins = Math.round(ageMs / 60_000);
    return { healthy: false, reason: `patrol has not completed a scan in ${mins} minutes — it is not watching your queue right now` };
  }
  return { healthy: true, ageMs, runId: hb.runId };
}

export function alarmText(reason) {
  return [
    "PATROL IS NOT RUNNING",
    "",
    reason,
    "",
    "Silence from patrol is NOT an all-clear. Nothing is currently checking which pull",
    "requests, worktrees, or loops need you.",
    "",
    "Restart it with:  /loop 30m /patrol",
  ].join("\n");
}

function main() {
  const stateDir = path.join(process.env.LOCALAPPDATA || process.env.TMPDIR || ".", "crx-patrol");
  const hbPath = path.join(stateDir, "heartbeat.json");
  let raw = null;
  try { raw = readFileSync(hbPath, "utf8"); } catch { raw = null; }

  const verdict = judgeHeartbeat(raw, Date.now());
  if (verdict.healthy) {
    if (!process.argv.includes("--quiet")) {
      process.stdout.write(`patrol healthy — last completed scan ${Math.round(verdict.ageMs / 60_000)} minute(s) ago (run ${verdict.runId})\n`);
    }
    process.exit(0);
  }
  process.stdout.write(`${alarmText(verdict.reason)}\n`);
  process.exit(ALARM_EXIT);
}

// pathToFileURL, not string surgery — see the same note in patrol-scan.mjs. A monitor
// whose main() silently never runs is the worst possible bug in a dead-man switch.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
