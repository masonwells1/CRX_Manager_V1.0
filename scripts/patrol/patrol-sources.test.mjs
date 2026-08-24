#!/usr/bin/env node
// Tests for the loop / parked-migration / gate-health sources and the dead-man monitor.
//
// The recurring hazard in all four is the same: a probe or a piece of evidence that
// FAILS OPEN, so "I could not tell" gets reported as "everything is fine". Most of these
// assertions exist to pin that shut.
import assert from "node:assert/strict";
import {
  LEDGER_STALL_MS,
  LEDGER_ARCHIVED_MS,
  GATE_EVIDENCE_TTL_MS,
  probeProcesses,
  attributeProcess,
  classifyLedgerState,
  judgeCodexGate,
  judgeCodeRabbitGate,
  collectGateHealth,
} from "./patrol-sources.mjs";
import { judgeHeartbeat, alarmText, ALARM_EXIT } from "./patrol-monitor.mjs";
import { checksVerdict, coderabbitStateFrom } from "./patrol-scan.mjs";
import { HEARTBEAT_OVERDUE_MS, prBlockers as prBlockersFor } from "./patrol-classify.mjs";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++; };

const NOW = Date.parse("2026-08-24T20:00:00Z");

// ── the process probe must not fail open ────────────────────────────────────
{
  // fleet.md records this exact failure: the parent shell eats the filter, the probe
  // returns nothing, and it reads as "no loops running" — a false all-clear about the
  // very thing being checked.
  const r = probeProcesses(() => "[]");
  eq(r.ok, false, "an empty probe result is a BROKEN PROBE, never 'nothing is running'");
  ok(/probe itself failed/.test(r.reason), "and says the probe failed rather than reporting quiet");
}
{
  const r = probeProcesses(() => null);
  eq(r.ok, false, "a probe that could not execute is not ok");
}
{
  const r = probeProcesses(() => "not json");
  eq(r.ok, false, "unparseable probe output is not ok");
}
{
  // The probe is itself a powershell process, so at least one such row must come back.
  const rows = JSON.stringify([{ Name: "powershell.exe", ProcessId: 1, CommandLine: "probe" }]);
  eq(probeProcesses(() => rows).ok, true, "a probe that can see itself is trustworthy");
}
{
  // A single object rather than an array: ConvertTo-Json collapses one row.
  const one = JSON.stringify({ Name: "powershell.exe", ProcessId: 1, CommandLine: "probe" });
  eq(probeProcesses(() => one).ok, true, "a single-row probe result is handled, not treated as broken");
}
{
  const rows = JSON.stringify([{ Name: "node.exe", ProcessId: 2, CommandLine: "loop" }]);
  eq(probeProcesses(() => rows).ok, false, "node rows without a powershell self-row still mean the probe broke");
}

// ── ledger state ────────────────────────────────────────────────────────────
const st = (over) => classifyLedgerState({ ledgerAgeMs: 0, hasCompletionMarker: false, processClaimsIt: true, probeOk: true, ...over });
eq(st({ hasCompletionMarker: true }), "FINISHED", "a ledger marked complete is finished");
eq(st({ probeOk: false }), "INDETERMINATE", "without a trustworthy probe a loop is undetermined, never assumed alive");
eq(st({ ledgerAgeMs: LEDGER_STALL_MS + 1 }), "STALLED", "alive process + stale ledger = stalled");
eq(st({ ledgerAgeMs: LEDGER_STALL_MS + 1, processClaimsIt: false }), "DEAD", "no process + stale ledger = dead");
eq(st({}), "PROGRESSING", "alive process + fresh ledger = progressing");
eq(st({ processClaimsIt: false }), "INDETERMINATE", "fresh ledger with no matching process is undetermined, not dead");
eq(st({ ledgerAgeMs: null, processClaimsIt: false }), "INDETERMINATE", "an unreadable ledger age is undetermined");
// The important negative: nothing here can return a state that reads as "fine" when the
// probe is untrustworthy.
for (const claims of [true, false]) {
  ok(st({ probeOk: false, processClaimsIt: claims }) === "INDETERMINATE", "a broken probe always yields INDETERMINATE regardless of what it seemed to see");
}

// Archived ledgers: the first live run called twelve July ledgers "stalled".
eq(st({ ledgerAgeMs: LEDGER_ARCHIVED_MS + 1 }), "ARCHIVED", "a ledger untouched for over a week is history, not a loop that just died");
eq(st({ ledgerAgeMs: LEDGER_ARCHIVED_MS + 1, processClaimsIt: false }), "ARCHIVED", "archived wins even with no process");
eq(st({ ledgerAgeMs: LEDGER_ARCHIVED_MS + 1, probeOk: false }), "ARCHIVED", "archived is decided before the probe matters");
ok(st({ ledgerAgeMs: LEDGER_ARCHIVED_MS - 1 }) !== "ARCHIVED", "a ledger inside the window is still a live candidate");
eq(st({ hasCompletionMarker: true, ledgerAgeMs: LEDGER_ARCHIVED_MS + 1 }), "FINISHED", "an explicit completion marker still wins over age");

// ── process attribution must respect path boundaries ────────────────────────
{
  const paths = ["C:/CRX_Manager", "C:/CRX_Manager/.claude/worktrees/alpha"];
  // The bug this pins: the main checkout is a prefix of every nested worktree, so a bare
  // substring test credited every nested process to the parent and marked its ledgers live.
  eq(attributeProcess("node C:/CRX_Manager/.claude/worktrees/alpha/run.mjs", paths),
    "C:/CRX_Manager/.claude/worktrees/alpha", "a nested worktree's process belongs to the NESTED worktree, not its parent");
  eq(attributeProcess("node C:/CRX_Manager/run.mjs", paths), "C:/CRX_Manager", "a parent-checkout process belongs to the parent");
  eq(attributeProcess("node C:/Other/run.mjs", paths), null, "an unrelated process is attributed to nothing");
  eq(attributeProcess("node C:/CRX_Manager_V2/run.mjs", paths), null, "a path that merely starts with the same characters is not a match");
  eq(attributeProcess(undefined, paths), null, "a missing command line attributes to nothing");
  eq(attributeProcess("node C:\\CRX_Manager\\run.mjs", paths), "C:/CRX_Manager", "backslash command lines match too");
  eq(attributeProcess('node "C:/CRX_Manager"', paths), "C:/CRX_Manager", "a quoted path terminates at the quote boundary");
}

// ── Codex gate health ───────────────────────────────────────────────────────
eq(judgeCodexGate({ captureText: null, captureAgeMs: null }).state, "UNKNOWN", "no evidence means unknown, never healthy");
eq(judgeCodexGate({ captureText: "CODEX_PROOF_VERDICT: CLEAN", captureAgeMs: GATE_EVIDENCE_TTL_MS + 1 }).state, "UNKNOWN", "stale evidence cannot prove health now");
{
  const r = judgeCodexGate({ captureText: "some output\nERROR: You've hit your usage limit\n", captureAgeMs: 1000 });
  eq(r.state, "DOWN", "a usage-limit ERROR line means the gate is down");
  ok(/not the same as the gate saying no/.test(r.detail), "and distinguishes 'gate down' from 'gate found problems' — only one has something to fix");
}
{
  // The capture embeds the reviewed diff. Reviewing code that merely TALKS about usage
  // limits must not make patrol report the gate as down — this actually happened.
  const capture = [
    "CODEX_PROOF_VERDICT: CLEAN",
    "diff --git a/scripts/patrol/patrol-sources.mjs",
    "+const USAGE_LIMIT = /you've hit your usage limit|quota exceeded/i;",
    "+// a comment mentioning rate limit handling",
  ].join("\n");
  eq(judgeCodexGate({ captureText: capture, captureAgeMs: 1000 }).state, "HEALTHY",
    "reviewed code that merely mentions a usage limit does not mark the gate down");
}
eq(judgeCodexGate({ captureText: "CODEX_PROOF_VERDICT: CLEAN", captureAgeMs: 1000 }).state, "HEALTHY", "a recent real verdict means healthy");
eq(judgeCodexGate({ captureText: "some unrelated noise", captureAgeMs: 1000 }).state, "UNKNOWN", "a capture with no parseable verdict is unknown, not healthy");
{
  // A capture that BOTH ran and hit a limit must read as DOWN, not HEALTHY.
  const mixed = "CODEX_PROOF_VERDICT: CLEAN\nERROR: you've hit your usage limit";
  eq(judgeCodexGate({ captureText: mixed, captureAgeMs: 1000 }).state, "DOWN", "a real usage-limit error line wins over an earlier clean verdict");
}

// ── CodeRabbit gate health ──────────────────────────────────────────────────
eq(judgeCodeRabbitGate([]).state, "UNKNOWN", "no statuses means unknown, never healthy");
eq(judgeCodeRabbitGate(["Review in progress"]).state, "HEALTHY", "normal statuses mean healthy");
eq(judgeCodeRabbitGate(["Rate limit reached, try later"]).state, "DOWN", "a rate-limit description means down");
eq(judgeCodeRabbitGate(["monthly spending cap reached"]).state, "DOWN", "a reached spend cap means down");
eq(judgeCodeRabbitGate(["Review in progress", "quota exceeded"]).state, "DOWN", "one limited PR is enough to call the gate down");

// ── gate collection reports both gates ──────────────────────────────────────
{
  const { src, gates } = collectGateHealth("C:/nonexistent-repo", { coderabbitDescriptions: [], nowMs: NOW });
  eq(src.status, "OK", "gate collection succeeds even with no evidence available");
  eq(gates.length, 2, "both gates are always reported");
  eq(gates.filter((g) => g.state === "HEALTHY").length, 0, "with no evidence, neither gate is claimed healthy");
}

// ── required-check producer binding (Codex HIGH #1) ─────────────────────────
// Matching a required check by NAME alone lets any integration with status-write access
// post a lookalike success and make patrol report green.
{
  const required = [{ context: "Lint, Type Check, Test, Build", appId: 15368 }];
  const good = [{ name: "Lint, Type Check, Test, Build", conclusion: "success", app: { id: 15368 }, started_at: "2026-08-24T20:00:00Z" }];
  const forged = [{ name: "Lint, Type Check, Test, Build", conclusion: "success", app: { id: 9999 }, started_at: "2026-08-24T20:00:00Z" }];

  eq(checksVerdict({ required, checkRuns: good, statuses: [] }), "green", "a check run from the required app counts");
  eq(checksVerdict({ required, checkRuns: forged, statuses: [] }), "unknown",
    "a successful check with the RIGHT NAME from the WRONG APP is not green — it fails closed");
  eq(checksVerdict({ required, checkRuns: [...forged, ...good], statuses: [] }), "green",
    "a forged run alongside a genuine one does not prevent the genuine one from counting");
  eq(checksVerdict({ required: [], checkRuns: good, statuses: [] }), "unknown",
    "if the required set could not be resolved, nothing is green");
  eq(checksVerdict({ required, checkRuns: [], statuses: [] }), "unknown", "a required context with no run at all is unknown");
}
{
  // Vercel arrives as a commit status, which carries no app id, so its producer is pinned.
  const required = [{ context: "Vercel", appId: 8329 }];
  const real = [{ context: "Vercel", state: "success", creator: { id: 35613825 }, created_at: "2026-08-24T20:00:00Z" }];
  const impostor = [{ context: "Vercel", state: "success", creator: { id: 1 }, created_at: "2026-08-24T20:00:00Z" }];
  eq(checksVerdict({ required, checkRuns: [], statuses: real }), "green", "the pinned Vercel producer counts");
  eq(checksVerdict({ required, checkRuns: [], statuses: impostor }), "unknown", "a status from an unpinned account is not trusted");
}
{
  // Newest verified run wins, so a stale green cannot outlive a fresh failure.
  const required = [{ context: "c", appId: 1 }];
  const runs = [
    { name: "c", conclusion: "success", app: { id: 1 }, started_at: "2026-08-24T19:00:00Z" },
    { name: "c", conclusion: "failure", app: { id: 1 }, started_at: "2026-08-24T20:00:00Z" },
  ];
  eq(checksVerdict({ required, checkRuns: runs, statuses: [] }), "failing", "the newest verified run decides, not the friendliest one");
  const rerun = [
    { name: "c", conclusion: "failure", app: { id: 1 }, started_at: "2026-08-24T19:00:00Z" },
    { name: "c", conclusion: "success", app: { id: 1 }, started_at: "2026-08-24T20:00:00Z" },
  ];
  eq(checksVerdict({ required, checkRuns: rerun, statuses: [] }), "green", "a passing rerun supersedes an earlier failure");
}
for (const state of ["neutral", "skipped", "stale", ""]) {
  const required = [{ context: "c", appId: 1 }];
  const runs = [{ name: "c", conclusion: state, app: { id: 1 }, started_at: "2026-08-24T20:00:00Z" }];
  eq(checksVerdict({ required, checkRuns: runs, statuses: [] }), "unknown", `a "${state}" conclusion fails closed rather than passing`);
}
{
  const required = [{ context: "c", appId: 1 }];
  const runs = [{ name: "c", status: "in_progress", app: { id: 1 }, started_at: "2026-08-24T20:00:00Z" }];
  eq(checksVerdict({ required, checkRuns: runs, statuses: [] }), "pending", "a running required check is pending");
}

// ── CodeRabbit completion (Codex HIGH #2) ───────────────────────────────────
const crStatus = (state) => [{ context: "CodeRabbit", state, creator: { id: 136622811 }, updated_at: "2026-08-24T20:00:00Z", description: "d" }];
eq(coderabbitStateFrom(crStatus("success")).state, "complete", "only a successful review is complete");
eq(coderabbitStateFrom(crStatus("pending")).state, "in_flight", "a pending review is in flight");
eq(coderabbitStateFrom(crStatus("failure")).state, "failed", "a FAILED review is not a completed review");
eq(coderabbitStateFrom(crStatus("error")).state, "failed", "an ERRORED review is not a completed review");
eq(coderabbitStateFrom([]).state, "missing", "no status at all is missing");
eq(coderabbitStateFrom([{ context: "CodeRabbit", state: "success", creator: { id: 1 }, updated_at: "2026-08-24T20:00:00Z" }]).state, "missing",
  "a CodeRabbit-looking status from another account does not count");
{
  const both = [
    { context: "CodeRabbit", state: "success", creator: { id: 136622811 }, updated_at: "2026-08-24T19:00:00Z" },
    { context: "CodeRabbit", state: "error", creator: { id: 136622811 }, updated_at: "2026-08-24T20:00:00Z" },
  ];
  eq(coderabbitStateFrom(both).state, "failed", "the newest status decides, so a later error is not masked by an earlier success");
}
// And the classifier must turn that into a visible blocker.
{
  const blockers = prBlockersFor({ checks: "green", coderabbit: "failed", solProof: "unknown", requiresSolProof: false });
  ok(blockers.some((b) => /did not succeed/.test(b)), "a failed review becomes an explicit blocker, so it cannot yield 'no blockers found'");
}

// ── dead-man monitor ────────────────────────────────────────────────────────
const hb = (over = {}) => JSON.stringify({ schemaVersion: 1, runId: "r1", at: new Date(NOW - 60_000).toISOString(), ...over });

eq(judgeHeartbeat(hb(), NOW).healthy, true, "a recent heartbeat from a completed run is healthy");
{
  const v = judgeHeartbeat(null, NOW);
  eq(v.healthy, false, "a MISSING heartbeat is an alarm — this is the case where patrol never ran at all");
  ok(/never completed a scan/.test(v.reason), "and says so plainly");
}
{
  const v = judgeHeartbeat(hb({ at: new Date(NOW - HEARTBEAT_OVERDUE_MS - 60_000).toISOString() }), NOW);
  eq(v.healthy, false, "an overdue heartbeat is an alarm");
  ok(/not watching your queue/.test(v.reason), "and says patrol is not watching right now");
}
{
  const v = judgeHeartbeat(hb({ at: new Date(NOW + 3_600_000).toISOString() }), NOW);
  eq(v.healthy, false, "a FUTURE-dated heartbeat is an alarm — a skewed clock must not silence this forever");
}
eq(judgeHeartbeat("{ not json", NOW).healthy, false, "an unreadable heartbeat is an alarm");
eq(judgeHeartbeat(hb({ schemaVersion: 99 }), NOW).healthy, false, "a wrong-schema heartbeat is not trusted");
eq(judgeHeartbeat(hb({ runId: undefined }), NOW).healthy, false, "a heartbeat naming no run was not written by a completed scan");
{
  // Boundary: exactly at the threshold is still healthy; one ms past is not.
  eq(judgeHeartbeat(hb({ at: new Date(NOW - HEARTBEAT_OVERDUE_MS).toISOString() }), NOW).healthy, true, "exactly at the overdue threshold is still healthy");
  eq(judgeHeartbeat(hb({ at: new Date(NOW - HEARTBEAT_OVERDUE_MS - 1).toISOString() }), NOW).healthy, false, "one millisecond past the threshold alarms");
}
ok(/NOT an all-clear/.test(alarmText("x")), "the alarm text says explicitly that silence is not an all-clear");
ok(/loop 30m \/patrol/.test(alarmText("x")), "and tells Mason how to restart it");
eq(ALARM_EXIT, 7, "the alarm exit code is stable for the scheduler");

console.log(`patrol-sources: ${pass} assertions passed`);
