#!/usr/bin/env node
// Tests for the patrol classifier (scripts/patrol/patrol-classify.mjs).
//
// The whole point of patrol is that it cannot fake an all-clear, so these tests are
// weighted toward the paths that would produce one wrongly: the exhaustive fallback,
// the IDLE downgrade, unstable merge state, and failed sources.
import assert from "node:assert/strict";
import {
  CONTRACT_VERSION,
  STALE_DAYS,
  MIN_STABLE_INTERVAL_MS,
  classifyPullRequest,
  classifyLoop,
  classifyWorktree,
  classifyParkedMigrations,
  classifyGate,
  classifySnapshot,
  isMergeStateStable,
  isStale,
  rankItems,
} from "./patrol-classify.mjs";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++; };

const NOW = Date.parse("2026-08-24T20:00:00Z");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// A stable observation: two reads far enough apart, agreeing, with a compare backing them.
function stableObs(over = {}) {
  const read = { headRefOid: "h1", baseRefOid: "b1", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", ...over };
  return {
    readA: { ...read, observedAt: iso(NOW - 10_000) },
    readB: { ...read, observedAt: iso(NOW - 10_000 + MIN_STABLE_INTERVAL_MS + 1) },
    compareObserved: true,
  };
}

function pr(over = {}) {
  return {
    number: 1, title: "a pull request", state: "OPEN", isDraft: false,
    mergeStateStatus: "CLEAN", checks: "green", coderabbit: "complete",
    solProof: "valid", requiresSolProof: false,
    lastHumanActivityAt: iso(NOW - DAY),
    mergeStateObservation: stableObs(),
    ...over,
  };
}

// ── isStale ─────────────────────────────────────────────────────────────────
eq(isStale(iso(NOW - DAY), NOW), false, "recent human activity is not stale");
eq(isStale(iso(NOW - (STALE_DAYS + 1) * DAY), NOW), true, `no activity for over ${STALE_DAYS} days is stale`);
eq(isStale(null, NOW), null, "UNKNOWN human activity returns null, never false — it must not silently read as fresh");
eq(isStale("not-a-date", NOW), null, "unparseable activity returns null");

// ── merge-state stability ───────────────────────────────────────────────────
ok(isMergeStateStable(stableObs()), "two agreeing reads far enough apart with a compare are stable");
{
  const o = stableObs();
  o.readB.observedAt = o.readA.observedAt; // same instant
  ok(!isMergeStateStable(o), "two reads at the same instant could share one cache — not stable");
}
{
  const o = stableObs();
  o.readB.headRefOid = "h2";
  ok(!isMergeStateStable(o), "reads disagreeing on head are not stable");
}
{
  const o = stableObs();
  o.readB.baseRefOid = "b2";
  ok(!isMergeStateStable(o), "reads disagreeing on base are not stable — a base advance can stale a proof");
}
{
  const o = stableObs();
  o.compareObserved = false;
  ok(!isMergeStateStable(o), "without an independent compare observation, agreement proves nothing");
}
ok(!isMergeStateStable(null), "a missing observation is not stable");

// ── pull request decision table: every rule reachable ───────────────────────
const prCases = [
  ["pr.scan_error", pr({ observationError: "api 500" }), "SCAN_ERROR"],
  ["pr.not_open", pr({ state: "MERGED" }), "IDLE"],
  ["pr.parked", pr({ parked: true }), "WAITING_EXTERNAL"],
  ["pr.unstable", pr({ mergeStateStatus: "UNKNOWN", mergeStateObservation: stableObs({ mergeStateStatus: "UNKNOWN" }) }), "INDETERMINATE"],
  ["pr.conflicted", pr({ mergeStateStatus: "DIRTY", mergeStateObservation: stableObs({ mergeStateStatus: "DIRTY" }) }), "AGENT_OWNS"],
  ["pr.draft_stale", pr({ isDraft: true, lastHumanActivityAt: iso(NOW - (STALE_DAYS + 1) * DAY) }), "NEEDS_MASON"],
  ["pr.draft_active", pr({ isDraft: true }), "AGENT_OWNS"],
  ["pr.checks_failing", pr({ checks: "failing" }), "AGENT_OWNS"],
  ["pr.checks_pending", pr({ checks: "pending" }), "WAITING_EXTERNAL"],
  ["pr.review_pending", pr({ coderabbit: "in_flight" }), "WAITING_EXTERNAL"],
  ["pr.checks_unknown", pr({ checks: "unknown" }), "INDETERMINATE"],
  ["pr.behind", pr({ mergeStateStatus: "BEHIND", mergeStateObservation: stableObs({ mergeStateStatus: "BEHIND" }) }), "NEEDS_MASON"],
  ["pr.blocked", pr({ mergeStateStatus: "BLOCKED", mergeStateObservation: stableObs({ mergeStateStatus: "BLOCKED" }) }), "NEEDS_MASON"],
  ["pr.stale", pr({ lastHumanActivityAt: iso(NOW - (STALE_DAYS + 1) * DAY) }), "NEEDS_MASON"],
  ["pr.no_blockers_found", pr(), "NEEDS_MASON"],
  ["pr.fallback", pr({ mergeStateStatus: "SOMETHING_NEW", mergeStateObservation: stableObs({ mergeStateStatus: "SOMETHING_NEW" }) }), "INDETERMINATE"],
];
for (const [rule, input, disposition] of prCases) {
  const r = classifyPullRequest(input, NOW);
  eq(r.rule, rule, `rule ${rule} is reachable`);
  eq(r.disposition, disposition, `${rule} yields ${disposition}`);
}

// The single most important guarantee: an unrecognized combination must not become IDLE.
for (const status of ["SOMETHING_NEW", "", "clean", "UNSTABLE_FUTURE_VALUE"]) {
  const r = classifyPullRequest(pr({ mergeStateStatus: status, mergeStateObservation: stableObs({ mergeStateStatus: status }) }), NOW);
  ok(r.disposition !== "IDLE", `unrecognized merge status "${status}" never falls through to IDLE`);
}

// Patrol makes negative claims only.
{
  const r = classifyPullRequest(pr(), NOW);
  ok(!/ready to merge/i.test(r.recommendation ?? ""), "a clean PR is never described as ready to merge");
  ok(/authorit/i.test(r.recommendation ?? ""), "it defers to GitHub and the Sol gate as the authorities");
}
// An UNSUPPORTED check must read as unchecked, never as silence. Before this, a risky
// money/RLS/migration PR with no Sol proof reached "no blockers found" and was handed to
// Mason as his call while CRX's hard gate had never been looked at.
{
  const r = classifyPullRequest(pr({ solProof: "unknown" }), NOW);
  ok(r.blockers.some((b) => /cannot check the Sol review gate/.test(b)),
    "an unevaluable Sol gate is reported as UNVERIFIED, not omitted");
  ok(r.disposition !== "IDLE", "and such a PR can never be idle");
  ok(!/^no blockers found$/.test(r.reasons[0] ?? ""), "the reason no longer claims a bare 'no blockers found'");
}
{
  // The all-clear must be unreachable while the Sol gate cannot be evaluated.
  const r = classifyPullRequest(pr({ solProof: "unknown" }), NOW);
  ok(r.blockers.length > 0, "a blocker is always present, so the renderer's all-clear condition cannot hold");
}

// ── blockers accumulate regardless of the matching rule ────────────────────
{
  const r = classifyPullRequest(pr({ mergeStateStatus: "BEHIND", mergeStateObservation: stableObs({ mergeStateStatus: "BEHIND" }), coderabbit: "missing", solProof: "stale" }), NOW);
  eq(r.rule, "pr.behind", "an earlier rule still matches");
  eq(r.blockers.length, 2, "but the missing review and stale proof are still recorded as blockers");
  ok(r.blockers.some((b) => /stale/.test(b)), "a proof whose reviewed base moved is reported stale");
}
{
  const r = classifyPullRequest(pr({ solProof: "missing", requiresSolProof: true }), NOW);
  ok(r.blockers.some((b) => /no valid Sol proof/.test(b)), "a required-but-missing Sol proof is a blocker");
}

// ── the IDLE downgrade (mechanism, not prose) ──────────────────────────────
{
  // A closed PR normally goes IDLE; force a blocker onto the same path.
  const r = classifyPullRequest(pr({ state: "CLOSED", checks: "unknown" }), NOW);
  eq(r.disposition, "IDLE", "pr.not_open clears blockers deliberately, since a closed PR's checks are moot");
}
{
  const r = classifyWorktree({ path: "/w", branch: "b", dirtyCount: 0, merged: true, hasOpenPr: false, lastHumanActivityAt: iso(NOW - DAY) }, NOW);
  eq(r.disposition, "IDLE", "a merged clean worktree is IDLE");
  eq(r.alerts.length, 0, "its cleanup note is non-actionable");
  eq(r.nonActionableAlerts.length, 1, "and is recorded separately so it cannot block the all-clear");
}

// ── loops ───────────────────────────────────────────────────────────────────
const loopCases = [
  ["loop.scan_error", { name: "l", observationError: "x" }, "SCAN_ERROR"],
  ["loop.dead", { name: "l", state: "DEAD" }, "NEEDS_MASON"],
  ["loop.stalled", { name: "l", state: "STALLED" }, "NEEDS_MASON"],
  ["loop.orphaned", { name: "l", state: "ORPHANED" }, "INDETERMINATE"],
  ["loop.progressing", { name: "l", state: "PROGRESSING" }, "WAITING_EXTERNAL"],
  ["loop.alive", { name: "l", state: "ALIVE" }, "WAITING_EXTERNAL"],
  ["loop.finished", { name: "l", state: "FINISHED" }, "IDLE"],
  ["loop.fallback", { name: "l", state: "WAT" }, "INDETERMINATE"],
];
for (const [rule, input, disposition] of loopCases) {
  const r = classifyLoop(input);
  eq(r.rule, rule, `loop rule ${rule} is reachable`);
  eq(r.disposition, disposition, `${rule} yields ${disposition}`);
}
ok(/never restarts/.test(classifyLoop({ name: "l", state: "DEAD" }).recommendation), "a dead loop is reported, never auto-restarted");

// ── worktrees ───────────────────────────────────────────────────────────────
const wtCases = [
  ["worktree.scan_error", { path: "/w", branch: "b", observationError: "x" }, "SCAN_ERROR"],
  ["worktree.dirty", { path: "/w", branch: "b", dirtyCount: 3, merged: false, hasOpenPr: false }, "AGENT_OWNS"],
  ["worktree.unmerged_stale", { path: "/w", branch: "b", dirtyCount: 0, merged: false, hasOpenPr: false, lastHumanActivityAt: iso(NOW - (STALE_DAYS + 1) * DAY) }, "NEEDS_MASON"],
  ["worktree.unmerged_active", { path: "/w", branch: "b", dirtyCount: 0, merged: false, hasOpenPr: false, lastHumanActivityAt: iso(NOW - DAY) }, "AGENT_OWNS"],
  ["worktree.merged_clean", { path: "/w", branch: "b", dirtyCount: 0, merged: true, hasOpenPr: false, lastHumanActivityAt: iso(NOW - DAY) }, "IDLE"],
  ["worktree.unmerged_tracked", { path: "/w", branch: "b", dirtyCount: 0, merged: false, hasOpenPr: true, lastHumanActivityAt: iso(NOW - DAY) }, "IDLE"],
  ["worktree.fallback", { path: "/w", branch: "b", dirtyCount: 0, merged: false, hasOpenPr: false, lastHumanActivityAt: null }, "INDETERMINATE"],
];
for (const [rule, input, disposition] of wtCases) {
  const r = classifyWorktree(input, NOW);
  eq(r.rule, rule, `worktree rule ${rule} is reachable`);
  eq(r.disposition, disposition, `${rule} yields ${disposition}`);
}
ok(classifyWorktree({ path: "/w", branch: "b", dirtyCount: 0, merged: false, hasOpenPr: false, lastHumanActivityAt: null }, NOW).disposition === "INDETERMINATE",
  "an unmerged worktree with unknown activity is undetermined, not idle");

// ── parked migrations ───────────────────────────────────────────────────────
{
  const r = classifyParkedMigrations({ count: 17, names: ["a.sql", "b.sql"] });
  eq(r.rule, "parked.present", "parked migrations present");
  eq(r.disposition, "NEEDS_MASON", "they are an owner decision");
  eq(r.id, "parked:aggregate", "reported as ONE aggregate item, not 17 — 17 entries would flood the report");
  ok(!/ready to apply/i.test(r.recommendation), "patrol never claims a migration is ready to apply");
}
eq(classifyParkedMigrations({ count: 0, names: [] }).disposition, "IDLE", "no parked migrations is idle");
eq(classifyParkedMigrations({ observationError: "x" }).disposition, "SCAN_ERROR", "unreadable parked state is a scan error");

// ── gates ───────────────────────────────────────────────────────────────────
eq(classifyGate({ name: "codex", state: "DOWN", detail: "credits exhausted" }).disposition, "NEEDS_MASON", "a down gate needs Mason");
eq(classifyGate({ name: "codex", state: "HEALTHY" }).disposition, "IDLE", "a healthy gate is idle");
eq(classifyGate({ name: "codex", state: "WAT" }).disposition, "INDETERMINATE", "unknown gate health is never assumed healthy");
eq(classifyGate({ name: "codex", observationError: "timeout" }).disposition, "SCAN_ERROR", "an unprobeable gate is a scan error");

// ── snapshot-level: a failed source cannot look like an empty list ─────────
{
  const snap = {
    sources: [
      { name: "pullRequests", status: "ERROR", detail: "rate limited" },
      { name: "worktrees", status: "OK" },
      { name: "loops", status: "OK" },
      { name: "parkedMigrations", status: "OK" },
      { name: "gateHealth", status: "OK" },
    ],
    pullRequests: [], worktrees: [], loops: [],
    parkedMigrations: { count: 0, names: [] }, gateHealth: [],
  };
  const items = classifySnapshot(snap, NOW);
  const errs = items.filter((i) => i.disposition === "SCAN_ERROR");
  eq(errs.length, 1, "a failed source produces an explicit SCAN_ERROR item");
  ok(/pullRequests/.test(errs[0].reasons[0]), "and names the source that failed");
}
{
  // The dangerous inverse: a source that failed must not have its (empty) list classified.
  const snap = {
    sources: [{ name: "pullRequests", status: "INCOMPLETE", detail: "pagination stopped" }],
    pullRequests: [pr({ number: 9 })],
  };
  const items = classifySnapshot(snap, NOW);
  ok(!items.some((i) => i.id === "pr:9"), "items from a non-OK source are not classified as if fully observed");
}

// ── ranking determinism ─────────────────────────────────────────────────────
{
  const items = [
    { id: "b", severity: 50, firstSeenAt: iso(NOW - 2 * DAY), disposition: "NEEDS_MASON", blockers: [], alerts: [] },
    { id: "a", severity: 50, firstSeenAt: iso(NOW - 2 * DAY), disposition: "NEEDS_MASON", blockers: [], alerts: [] },
    { id: "c", severity: 90, firstSeenAt: null, disposition: "SCAN_ERROR", blockers: [], alerts: [] },
  ];
  const r1 = rankItems(items, NOW).map((i) => i.id);
  const r2 = rankItems([...items].reverse(), NOW).map((i) => i.id);
  eq(r1, r2, "ranking is deterministic regardless of input order");
  eq(r1[0], "c", "highest severity ranks first");
  eq(r1.slice(1), ["a", "b"], "ties break by id after age, so ordering is total");
}
{
  const young = { id: "y", severity: 50, firstSeenAt: iso(NOW), disposition: "NEEDS_MASON", blockers: [], alerts: [] };
  const old = { id: "o", severity: 50, firstSeenAt: iso(NOW - 10 * DAY), disposition: "NEEDS_MASON", blockers: [], alerts: [] };
  eq(rankItems([young, old], NOW)[0].id, "o", "an item hidden longer ages upward so it cannot starve");
}

eq(CONTRACT_VERSION, "1", "contract version matches the shipped contract document");

console.log(`patrol-classify: ${pass} assertions passed`);
