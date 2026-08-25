#!/usr/bin/env node
// Patrol renderer — deterministic. This file, not a language model, produces every
// safety-critical line of the report: the lanes, the counts, the emergency text, and
// the all-clear phrase.
//
// Why deterministic: rev 2 of the plan relied on instructing the reporting agent not to
// summarize around errors. An instruction is not a mechanism — an LLM handed a snapshot
// can omit a lane, soften an error, or paraphrase an all-clear. Here the agent receives
// this rendered block and may add one clearly labelled explanatory paragraph after it;
// it cannot edit, reorder, or suppress anything above.

import { SNAPSHOT_TTL_MS, rankItems } from "./patrol-classify.mjs";

export const SCHEMA_VERSION = 1;
export const ALL_CLEAR = "Nothing waiting on you";
export const DEFAULT_LANE_CAP = 5;

export const EXIT = Object.freeze({
  OK: 0,
  SNAPSHOT_INVALID: 3,
  SNAPSHOT_EXPIRED: 4,
  SNAPSHOT_INCOMPLETE: 5,
  INTERNAL: 6,
});

// ── untrusted text ──────────────────────────────────────────────────────────
// PR titles, branch names and failure text are attacker-influenceable. Containment does
// not rest on escaping alone (the report structure is deterministic), but a title must
// not be able to forge a line, a lane header, or the all-clear phrase.
const MAX_LABEL = 160;

export function escapeUntrusted(raw) {
  if (typeof raw !== "string") return "";
  // Code-point filter rather than a control-character regex literal: the literal form
  // is easy to corrupt in transit (and unreadable in review), and a silently broken
  // strip would let a crafted title forge report structure.
  let s = Array.from(raw)
    .map((ch) => {
      const c = ch.codePointAt(0);
      return c <= 0x1f || (c >= 0x7f && c <= 0x9f) ? " " : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  // The reserved phrase may never appear in text patrol did not author.
  s = s.replace(new RegExp(ALL_CLEAR, "gi"), "[redacted]");
  if (s.length > MAX_LABEL) s = `${s.slice(0, MAX_LABEL - 1)}…`;
  return s;
}

// ── snapshot validation ─────────────────────────────────────────────────────
// A failed scan must never fall back to a previous successful snapshot, so every
// invalidity is an error with a non-zero exit, not a degraded render.
export function validateSnapshot(snapshot, { nowMs, expectedRunId, expectedRepoId }) {
  if (!snapshot || typeof snapshot !== "object") return { ok: false, code: EXIT.SNAPSHOT_INVALID, reason: "no snapshot was produced" };
  if (snapshot.schemaVersion !== SCHEMA_VERSION) return { ok: false, code: EXIT.SNAPSHOT_INVALID, reason: `snapshot schema version ${snapshot.schemaVersion} is not the expected ${SCHEMA_VERSION}` };
  if (expectedRunId && snapshot.runId !== expectedRunId) return { ok: false, code: EXIT.SNAPSHOT_INVALID, reason: "snapshot is from a different run than the one requested" };
  if (expectedRepoId && snapshot.repoId !== expectedRepoId) return { ok: false, code: EXIT.SNAPSHOT_INVALID, reason: "snapshot belongs to a different repository" };
  if (!snapshot.collectorCommit) return { ok: false, code: EXIT.SNAPSHOT_INVALID, reason: "snapshot does not record which collector build produced it" };
  const gen = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(gen)) return { ok: false, code: EXIT.SNAPSHOT_INVALID, reason: "snapshot has no usable generation time" };
  if (gen - nowMs > 60_000) return { ok: false, code: EXIT.SNAPSHOT_INVALID, reason: "snapshot is dated in the future — check the system clock" };
  // Re-checked at emission, not only at load: a snapshot can expire while the report
  // is being assembled.
  if (nowMs - gen > SNAPSHOT_TTL_MS) return { ok: false, code: EXIT.SNAPSHOT_EXPIRED, reason: "snapshot is older than its 15-minute freshness window" };
  if (snapshot.complete !== true) return { ok: false, code: EXIT.SNAPSHOT_INCOMPLETE, reason: "scan did not complete — at least one source failed" };
  return { ok: true };
}

export function renderEmergency(reason, code) {
  return {
    exitCode: code,
    allClear: false,
    text: [
      "PATROL COULD NOT PRODUCE A REPORT",
      "",
      `Reason: ${reason}`,
      "",
      "This is NOT an all-clear. Patrol does not know what is waiting on you right now.",
      "Do not treat this run as a clean check.",
    ].join("\n"),
  };
}

// ── report ──────────────────────────────────────────────────────────────────

const LANES = [
  { key: "NEEDS_MASON", title: "NEEDS MASON", dispositions: ["NEEDS_MASON"] },
  { key: "AGENT_OWNS", title: "AGENT OWNS NEXT", dispositions: ["AGENT_OWNS"] },
  // INDETERMINATE and SCAN_ERROR live here on purpose: "I could not tell" is a thing
  // Mason must see, never something absorbed into silence.
  { key: "WAITING", title: "WAITING ON / COULD NOT DETERMINE", dispositions: ["WAITING_EXTERNAL", "INDETERMINATE", "SCAN_ERROR"] },
];

function laneLine(it) {
  const label = escapeUntrusted(it.label);
  const head = `  - ${escapeUntrusted(it.id)} ${label}`.trimEnd();
  const parts = [head];
  for (const r of it.reasons) parts.push(`      ${escapeUntrusted(r)}`);
  for (const b of it.blockers) parts.push(`      BLOCKER: ${escapeUntrusted(b)}`);
  for (const a of it.alerts) parts.push(`      ALERT: ${escapeUntrusted(a)}`);
  if (it.recommendation) parts.push(`      -> ${escapeUntrusted(it.recommendation)}`);
  return parts.join("\n");
}

export function renderReport(snapshot, items, { nowMs, expectedRunId, expectedRepoId, laneCap = DEFAULT_LANE_CAP } = {}) {
  const v = validateSnapshot(snapshot, { nowMs, expectedRunId, expectedRepoId });
  if (!v.ok) return renderEmergency(v.reason, v.code);

  const ranked = rankItems(items, nowMs);

  const counts = { NEEDS_MASON: 0, AGENT_OWNS: 0, WAITING_EXTERNAL: 0, INDETERMINATE: 0, SCAN_ERROR: 0, IDLE: 0 };
  for (const it of ranked) counts[it.disposition] = (counts[it.disposition] ?? 0) + 1;

  const actionableBlockers = ranked.reduce((n, it) => n + it.blockers.length, 0);
  const actionableAlerts = ranked.reduce((n, it) => n + it.alerts.length, 0);

  const lines = [];
  let hiddenTotal = 0;
  let highestHiddenSeverity = 0;

  for (const lane of LANES) {
    const all = ranked.filter((it) => lane.dispositions.includes(it.disposition));
    const shown = all.slice(0, laneCap);
    const hidden = all.length - shown.length;
    hiddenTotal += hidden;
    for (const it of all.slice(laneCap)) highestHiddenSeverity = Math.max(highestHiddenSeverity, it.rankSeverity);

    lines.push(`${lane.title}  (${all.length} total, ${shown.length} shown, ${hidden} hidden)`);
    if (all.length === 0) lines.push("  (none)");
    else for (const it of shown) lines.push(laneLine(it));
    lines.push("");
  }

  // Every condition in §10 of the classifier contract. All must hold.
  //
  // `sources` is checked HERE as well as by the classifier's SCAN_ERROR items. In the real
  // pipeline a failed source produces such an item and that alone suppresses the phrase —
  // but the renderer owns the all-clear, and a check that depends on another layer having
  // done its job is two checks that do not bind. `complete` covers only REQUIRED sources,
  // so an ERROR in an optional one would otherwise slip through here.
  const allSourcesOk = (snapshot.sources ?? []).every((s) => s?.status === "OK");
  const allClear =
    snapshot.complete === true &&
    allSourcesOk &&
    counts.NEEDS_MASON === 0 &&
    counts.SCAN_ERROR === 0 &&
    counts.INDETERMINATE === 0 &&
    hiddenTotal === 0 &&
    actionableBlockers === 0 &&
    actionableAlerts === 0;

  const header = [
    `PATROL — ${snapshot.generatedAt} (collector ${String(snapshot.collectorCommit).slice(0, 12)})`,
    `items ${ranked.length} · needs you ${counts.NEEDS_MASON} · agent ${counts.AGENT_OWNS} · waiting ${counts.WAITING_EXTERNAL} · undetermined ${counts.INDETERMINATE} · scan errors ${counts.SCAN_ERROR} · idle ${counts.IDLE}`,
    "",
  ];

  const footer = [];
  if (allClear) {
    footer.push(ALL_CLEAR);
  } else {
    const why = [];
    if (counts.NEEDS_MASON > 0) why.push(`${counts.NEEDS_MASON} item(s) need your decision`);
    if (counts.SCAN_ERROR > 0) why.push(`${counts.SCAN_ERROR} source(s) could not be read`);
    if (counts.INDETERMINATE > 0) why.push(`${counts.INDETERMINATE} item(s) could not be determined`);
    if (!allSourcesOk) {
      const bad = (snapshot.sources ?? []).filter((s) => s?.status !== "OK").map((s) => `${s?.name}=${s?.status}`);
      why.push(`source(s) not fully read: ${bad.join(", ")}`);
    }
    if (hiddenTotal > 0) why.push(`${hiddenTotal} item(s) hidden by the display cap (highest hidden severity ${highestHiddenSeverity})`);
    if (actionableBlockers > 0) why.push(`${actionableBlockers} open blocker(s)`);
    if (actionableAlerts > 0) why.push(`${actionableAlerts} open alert(s)`);
    footer.push(`NOT an all-clear: ${why.join("; ")}.`);
    if (hiddenTotal > 0) footer.push(`Full queue: ${snapshot.queuePath ?? "(queue path not recorded)"}`);
  }

  return { exitCode: EXIT.OK, allClear, text: [...header, ...lines, ...footer].join("\n") };
}
