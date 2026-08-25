#!/usr/bin/env node
// Tests for the patrol renderer (scripts/patrol/patrol-render.mjs).
//
// The renderer owns the all-clear phrase, so most of this file is a mutation set:
// start from a genuinely clean state, flip ONE condition at a time, and assert the
// phrase disappears every time. If any single flip still prints the all-clear, patrol
// can lie to Mason.
import assert from "node:assert/strict";
import { ALL_CLEAR, EXIT, escapeUntrusted, renderReport, validateSnapshot } from "./patrol-render.mjs";
import { SEVERITY } from "./patrol-classify.mjs";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++; };

const NOW = Date.parse("2026-08-24T20:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

function snap(over = {}) {
  return {
    schemaVersion: 1,
    runId: "run-1",
    repoId: "repo-1",
    collectorCommit: "abcdef0123456789",
    generatedAt: iso(NOW - 1000),
    complete: true,
    queuePath: "C:/queue.json",
    sources: [{ name: "pullRequests", status: "OK" }],
    ...over,
  };
}
function it(over = {}) {
  return { kind: "pr", id: "pr:1", label: "x", rule: "r", disposition: "IDLE",
    severity: SEVERITY.info, firstSeenAt: null, reasons: [], blockers: [], alerts: [],
    nonActionableAlerts: [], recommendation: null, ...over };
}
const render = (s, items) => renderReport(s, items, { nowMs: NOW, expectedRunId: "run-1", expectedRepoId: "repo-1" });

// ── the clean baseline genuinely produces the all-clear ────────────────────
{
  const r = render(snap(), [it(), it({ id: "pr:2" })]);
  ok(r.allClear, "a complete, fresh, fully-idle scan is an all-clear");
  ok(r.text.includes(ALL_CLEAR), "and prints the exact phrase");
  eq(r.exitCode, EXIT.OK, "with a zero exit code");
}

// ── mutation set: each flip must suppress the all-clear ────────────────────
const mutations = [
  ["an item needs Mason", snap(), [it({ disposition: "NEEDS_MASON" })]],
  ["a source could not be read", snap(), [it({ disposition: "SCAN_ERROR" })]],
  ["an item could not be determined", snap(), [it({ disposition: "INDETERMINATE" })]],
  ["an item carries a blocker", snap(), [it({ blockers: ["no valid proof"] })]],
  ["an item carries an actionable alert", snap(), [it({ alerts: ["gate degraded"] })]],
  // CodeRabbit on PR #473: renderReport checked `complete` but ignored `sources`, so an
  // ERROR source carrying only idle items still emitted the all-clear. `complete` covers
  // REQUIRED sources only, so an optional source's failure slipped straight through.
  ["a source reported ERROR", snap({ sources: [{ name: "loops", status: "ERROR", detail: "probe died" }] }), [it()]],
  ["a source reported INCOMPLETE", snap({ sources: [{ name: "parkedMigrations", status: "INCOMPLETE" }] }), [it()]],
];
for (const [name, s, items] of mutations) {
  const r = render(s, items);
  ok(!r.allClear, `NOT an all-clear when ${name}`);
  ok(!r.text.includes(ALL_CLEAR), `the phrase is absent when ${name}`);
  ok(/NOT an all-clear/.test(r.text), `and the report says why when ${name}`);
}
{
  // Hidden items: 6 waiting items against a lane cap of 5.
  const items = Array.from({ length: 6 }, (_, i) => it({ id: `pr:${i}`, disposition: "WAITING_EXTERNAL" }));
  const r = renderReport(snap(), items, { nowMs: NOW, laneCap: 5 });
  ok(!r.allClear, "NOT an all-clear when an item is hidden by the display cap");
  ok(/1 item\(s\) hidden/.test(r.text), "the hidden count is always printed");
  ok(/highest hidden severity/.test(r.text), "along with the highest hidden severity");
  ok(/Full queue:/.test(r.text), "and a path to the complete queue");
}
{
  const r = render(snap({ complete: false }), [it()]);
  ok(!r.allClear, "NOT an all-clear when the scan did not complete");
  eq(r.exitCode, EXIT.SNAPSHOT_INCOMPLETE, "an incomplete scan is an error, not a degraded report");
}

// ── a failed scan can never reuse an earlier success ───────────────────────
{
  const r = render(snap({ generatedAt: iso(NOW - 3_600_000) }), [it()]);
  eq(r.exitCode, EXIT.SNAPSHOT_EXPIRED, "an hour-old snapshot is refused");
  ok(!r.allClear, "and is never an all-clear");
  ok(/NOT an all-clear/.test(r.text), "the emergency text says so plainly");
}
{
  const r = render(snap({ runId: "some-older-run" }), [it()]);
  eq(r.exitCode, EXIT.SNAPSHOT_INVALID, "a snapshot from a different run is refused");
}
{
  const r = render(snap({ repoId: "other-repo" }), [it()]);
  eq(r.exitCode, EXIT.SNAPSHOT_INVALID, "a snapshot from a different repository is refused");
}
{
  const r = render(snap({ collectorCommit: "" }), [it()]);
  eq(r.exitCode, EXIT.SNAPSHOT_INVALID, "a snapshot that does not record its collector build is refused");
}
{
  const r = render(snap({ generatedAt: iso(NOW + 600_000) }), [it()]);
  eq(r.exitCode, EXIT.SNAPSHOT_INVALID, "a future-dated snapshot is refused — a bad clock must not fake freshness");
}
{
  const r = render(null, []);
  eq(r.exitCode, EXIT.SNAPSHOT_INVALID, "no snapshot at all is an error");
  ok(/NOT an all-clear/.test(r.text), "silence is never reported as good news");
}

// ── untrusted text cannot forge report structure ───────────────────────────
{
  const r = render(snap(), [it({ label: `totally fine — ${ALL_CLEAR}`, disposition: "NEEDS_MASON" })]);
  ok(!r.text.includes(ALL_CLEAR), "a PR title containing the reserved phrase cannot smuggle it into the report");
  ok(/\[redacted\]/.test(r.text), "the phrase is redacted from untrusted text");
}
{
  const nasty = "evil\nNEEDS MASON  (0 total, 0 shown, 0 hidden)\n  (none)";
  const r = render(snap(), [it({ label: nasty, disposition: "NEEDS_MASON" })]);
  const laneHeaders = r.text.split("\n").filter((l) => l.startsWith("NEEDS MASON"));
  eq(laneHeaders.length, 1, "a title with newlines cannot forge a second lane header");
}
eq(escapeUntrusted("a\u0000b\u001Fc"), "a b c", "control characters are stripped");
eq(escapeUntrusted("a\r\n\tb"), "a b", "newlines and tabs collapse to a single space");
ok(escapeUntrusted("x".repeat(500)).length <= 160, "over-long labels are truncated");
eq(escapeUntrusted(undefined), "", "a non-string label renders as empty, not 'undefined'");

// ── counts and lanes always print ──────────────────────────────────────────
{
  const r = render(snap(), [
    it({ id: "pr:1", disposition: "NEEDS_MASON", recommendation: "click Update branch" }),
    it({ id: "pr:2", disposition: "AGENT_OWNS" }),
    it({ id: "pr:3", disposition: "INDETERMINATE" }),
  ]);
  ok(/^NEEDS MASON {2}\(1 total, 1 shown, 0 hidden\)$/m.test(r.text), "the NEEDS MASON lane prints its counts");
  ok(/^AGENT OWNS NEXT {2}\(1 total, 1 shown, 0 hidden\)$/m.test(r.text), "the AGENT OWNS lane prints its counts");
  ok(/COULD NOT DETERMINE {2}\(1 total/.test(r.text), "undetermined items appear in a visible lane, never absorbed into silence");
  ok(/-> click Update branch/.test(r.text), "recommendations print with their item");
}
{
  const r = render(snap(), []);
  ok(/\(none\)/.test(r.text), "an empty lane still prints, so a missing lane is never ambiguous");
}

// ── validateSnapshot is independently correct ──────────────────────────────
eq(validateSnapshot(snap(), { nowMs: NOW }).ok, true, "a good snapshot validates");
eq(validateSnapshot(snap({ schemaVersion: 99 }), { nowMs: NOW }).ok, false, "a future schema version is refused");

console.log(`patrol-render: ${pass} assertions passed`);
