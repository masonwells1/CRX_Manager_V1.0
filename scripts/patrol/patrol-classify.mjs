#!/usr/bin/env node
// Patrol classifier — pure, deterministic, no I/O.
//
// Implements scripts/patrol/classifier-contract.md v1 exactly. The contract is the
// specification; this file must not encode a rule the contract does not state, and
// CONTRACT_VERSION must match the contract's heading.
//
// Two invariants carry the whole safety argument, and both are enforced here rather
// than described in prose (Codex rev-2 review: "prose assertion without a mechanism"):
//
//   1. EXHAUSTIVE FALLBACK. Every rule set ends in a `*.fallback` rule returning
//      INDETERMINATE. There is no implicit default and IDLE is never a fallback, so an
//      unanticipated condition combination surfaces as "I could not determine this"
//      rather than silently as "nothing to do".
//
//   2. IDLE IS EARNED. `finalize()` downgrades any IDLE carrying a blocker or an
//      actionable alert to INDETERMINATE. A rule cannot accidentally emit an all-clear
//      for an item that also recorded a problem.

export const CONTRACT_VERSION = "1";

export const STALE_DAYS = 14;
export const MIN_STABLE_INTERVAL_MS = 2_000;
export const SNAPSHOT_TTL_MS = 900_000; // 15 min
export const HEARTBEAT_OVERDUE_MS = 5_400_000; // 90 min = 3x the 30-min cadence

export const DISPOSITIONS = Object.freeze([
  "NEEDS_MASON",
  "AGENT_OWNS",
  "WAITING_EXTERNAL",
  "INDETERMINATE",
  "SCAN_ERROR",
  "IDLE",
]);

export const SEVERITY = Object.freeze({
  critical: 90,
  high: 70,
  normal: 50,
  low: 30,
  info: 10,
});

// ── helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export function isStale(lastHumanActivityAt, nowMs, staleDays = STALE_DAYS) {
  // Unknown human activity is NOT treated as fresh. An item whose activity we could
  // not resolve must not silently escape the abandonment question; callers route it
  // through the unstable/unknown paths instead.
  if (!lastHumanActivityAt) return null;
  const t = Date.parse(lastHumanActivityAt);
  if (!Number.isFinite(t)) return null;
  return nowMs - t > staleDays * DAY_MS;
}

// A merge state is fresh only if two reads, far enough apart to defeat a shared cache,
// agree on every field that could have moved, AND an independent compare observation
// backs them. Two reads served from one cache agree trivially and prove nothing.
export function isMergeStateStable(observation, minIntervalMs = MIN_STABLE_INTERVAL_MS) {
  if (!observation) return false;
  const { readA, readB, compareObserved } = observation;
  if (!readA || !readB || compareObserved !== true) return false;
  const ta = Date.parse(readA.observedAt);
  const tb = Date.parse(readB.observedAt);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  if (Math.abs(tb - ta) < minIntervalMs) return false;
  return (
    readA.headRefOid === readB.headRefOid &&
    readA.baseRefOid === readB.baseRefOid &&
    readA.mergeable === readB.mergeable &&
    readA.mergeStateStatus === readB.mergeStateStatus
  );
}

function item(fields) {
  return {
    kind: fields.kind,
    id: fields.id,
    label: fields.label ?? "", // UNTRUSTED remote text; escaped by the renderer
    rule: fields.rule,
    disposition: fields.disposition,
    severity: fields.severity ?? SEVERITY.normal,
    firstSeenAt: fields.firstSeenAt ?? null,
    reasons: fields.reasons ?? [],
    blockers: fields.blockers ?? [],
    alerts: fields.alerts ?? [],
    nonActionableAlerts: fields.nonActionableAlerts ?? [],
    recommendation: fields.recommendation ?? null,
  };
}

// The mechanism behind "IDLE is earned". Applied to every item the classifier returns.
function finalize(it) {
  if (!DISPOSITIONS.includes(it.disposition)) {
    return { ...it, disposition: "INDETERMINATE", rule: `${it.rule}!invalid_disposition` };
  }
  if (it.disposition === "IDLE" && (it.blockers.length > 0 || it.alerts.length > 0)) {
    return {
      ...it,
      disposition: "INDETERMINATE",
      rule: `${it.rule}!idle_with_open_items`,
      reasons: [...it.reasons, "downgraded from IDLE: item carries a blocker or actionable alert"],
    };
  }
  return it;
}

// Blockers are recorded independently of which rule matched, so an earlier-matching
// rule can never hide a missing review gate.
function prBlockers(pr) {
  const out = [];
  if (pr.checks === "unknown") out.push("required checks could not be resolved at the head commit");
  if (pr.coderabbit === "missing") out.push("no CodeRabbit review recorded at the head commit");
  if (pr.solProof === "stale") out.push("Sol proof is stale — reviewed base no longer matches the live base");
  if (pr.solProof === "missing" && pr.requiresSolProof) out.push("no valid Sol proof at the head commit");
  return out;
}

// ── pull requests ───────────────────────────────────────────────────────────

export function classifyPullRequest(pr, nowMs) {
  const base = {
    kind: "pr",
    id: `pr:${pr.number}`,
    label: pr.title,
    firstSeenAt: pr.firstSeenAt ?? null,
    blockers: prBlockers(pr),
  };
  const stale = isStale(pr.lastHumanActivityAt, nowMs);

  if (pr.observationError) {
    return finalize(item({
      ...base, rule: "pr.scan_error", disposition: "SCAN_ERROR", severity: SEVERITY.critical,
      reasons: [`could not observe this pull request: ${pr.observationError}`],
    }));
  }

  if (pr.state !== "OPEN") {
    return finalize(item({
      ...base, rule: "pr.not_open", disposition: "IDLE", severity: SEVERITY.info,
      blockers: [], reasons: [`state is ${pr.state}`],
    }));
  }

  // A PR held by a deliberate decision must not be nagged about. Patrol can only see
  // markers that exist ON GitHub — a "hold"/"parked" label, or a PARKED marker in the
  // title. A decision recorded anywhere else is invisible to it, which is exactly why
  // parking something needs a marker here rather than only in notes.
  if (pr.parked) {
    return finalize(item({
      ...base, rule: "pr.parked", disposition: "WAITING_EXTERNAL", severity: SEVERITY.low,
      reasons: ["explicitly parked by a marker on the pull request — not raised until the marker is removed"],
    }));
  }

  if (!isMergeStateStable(pr.mergeStateObservation) || pr.mergeStateStatus === "UNKNOWN") {
    return finalize(item({
      ...base, rule: "pr.unstable", disposition: "INDETERMINATE", severity: SEVERITY.normal,
      reasons: ["GitHub has not settled this pull request's merge state — this is not a clean bill of health"],
    }));
  }

  if (pr.mergeStateStatus === "DIRTY") {
    return finalize(item({
      ...base, rule: "pr.conflicted", disposition: "AGENT_OWNS", severity: SEVERITY.high,
      reasons: ["merge conflicts with main"],
    }));
  }

  if (pr.isDraft && stale === true) {
    return finalize(item({
      ...base, rule: "pr.draft_stale", disposition: "NEEDS_MASON", severity: SEVERITY.low,
      reasons: [`draft with no human activity for over ${STALE_DAYS} days`],
      recommendation: "abandon it or revive it — it has been parked long enough to decide",
    }));
  }
  if (pr.isDraft) {
    return finalize(item({
      ...base, rule: "pr.draft_active", disposition: "AGENT_OWNS", severity: SEVERITY.low,
      reasons: ["draft, recently active"],
    }));
  }

  if (pr.checks === "failing") {
    return finalize(item({
      ...base, rule: "pr.checks_failing", disposition: "AGENT_OWNS", severity: SEVERITY.high,
      reasons: ["a required check is failing at the head commit"],
    }));
  }
  if (pr.checks === "pending") {
    return finalize(item({
      ...base, rule: "pr.checks_pending", disposition: "WAITING_EXTERNAL", severity: SEVERITY.low,
      reasons: ["required checks are still running"],
    }));
  }
  if (pr.coderabbit === "in_flight") {
    return finalize(item({
      ...base, rule: "pr.review_pending", disposition: "WAITING_EXTERNAL", severity: SEVERITY.low,
      reasons: ["CodeRabbit review is in flight at the head commit"],
    }));
  }
  if (pr.checks === "unknown") {
    return finalize(item({
      ...base, rule: "pr.checks_unknown", disposition: "INDETERMINATE", severity: SEVERITY.normal,
      reasons: ["required checks could not be resolved — failing closed rather than assuming green"],
    }));
  }

  if (pr.mergeStateStatus === "BEHIND") {
    return finalize(item({
      ...base, rule: "pr.behind", disposition: "NEEDS_MASON", severity: SEVERITY.normal,
      reasons: ["main has moved ahead of this branch"],
      recommendation: "click “Update branch” on the pull request — it also unblocks the final review, which cannot run on a behind branch",
    }));
  }

  if (pr.mergeStateStatus === "BLOCKED") {
    return finalize(item({
      ...base, rule: "pr.blocked", disposition: "NEEDS_MASON", severity: SEVERITY.normal,
      reasons: ["GitHub reports the merge is blocked by a branch rule"],
      recommendation: "open the pull request and read which rule is unsatisfied — patrol does not model every ruleset",
    }));
  }

  if (stale === true) {
    return finalize(item({
      ...base, rule: "pr.stale", disposition: "NEEDS_MASON", severity: SEVERITY.low,
      reasons: [`no human activity for over ${STALE_DAYS} days`],
      recommendation: "abandon it or revive it",
    }));
  }

  if (pr.mergeStateStatus === "CLEAN") {
    return finalize(item({
      ...base, rule: "pr.no_blockers_found", disposition: "NEEDS_MASON", severity: SEVERITY.normal,
      reasons: ["no blockers found from what patrol can see"],
      // Deliberately a negative claim. Patrol does not model org rulesets, required
      // deployments, or merge-queue semantics, so it never asserts "ready to merge".
      recommendation: "the merge decision is yours — GitHub's merge button is the authority on whether it is actually mergeable",
    }));
  }

  return finalize(item({
    ...base, rule: "pr.fallback", disposition: "INDETERMINATE", severity: SEVERITY.normal,
    reasons: [`unrecognized combination (mergeStateStatus=${pr.mergeStateStatus}, checks=${pr.checks})`],
  }));
}

// ── loops ───────────────────────────────────────────────────────────────────

export function classifyLoop(loop) {
  const base = { kind: "loop", id: `loop:${loop.name}`, label: loop.name, firstSeenAt: loop.firstSeenAt ?? null };

  if (loop.observationError) {
    return finalize(item({ ...base, rule: "loop.scan_error", disposition: "SCAN_ERROR", severity: SEVERITY.critical,
      reasons: [`could not observe this loop: ${loop.observationError}`] }));
  }
  if (loop.state === "DEAD") {
    return finalize(item({ ...base, rule: "loop.dead", disposition: "NEEDS_MASON", severity: SEVERITY.critical,
      reasons: ["the ledger says it is running, but no matching process exists and its heartbeat is overdue"],
      recommendation: "read what it was doing before restarting it — patrol never restarts a loop" }));
  }
  if (loop.state === "STALLED") {
    return finalize(item({ ...base, rule: "loop.stalled", disposition: "NEEDS_MASON", severity: SEVERITY.critical,
      reasons: ["the process is alive but its ledger has stopped advancing"],
      recommendation: "read what it was doing before restarting it" }));
  }
  if (loop.state === "ORPHANED") {
    return finalize(item({ ...base, rule: "loop.orphaned", disposition: "INDETERMINATE", severity: SEVERITY.normal,
      reasons: ["a matching process exists but belongs to no known ledger"] }));
  }
  if (loop.state === "PROGRESSING") {
    return finalize(item({ ...base, rule: "loop.progressing", disposition: "WAITING_EXTERNAL", severity: SEVERITY.info,
      reasons: ["running and advancing"] }));
  }
  if (loop.state === "ALIVE") {
    return finalize(item({ ...base, rule: "loop.alive", disposition: "WAITING_EXTERNAL", severity: SEVERITY.info,
      reasons: ["running; no advance observed yet"] }));
  }
  if (loop.state === "FINISHED") {
    return finalize(item({ ...base, rule: "loop.finished", disposition: "IDLE", severity: SEVERITY.info,
      reasons: ["complete; nothing claims to be running"] }));
  }
  return finalize(item({ ...base, rule: "loop.fallback", disposition: "INDETERMINATE", severity: SEVERITY.normal,
    reasons: [`unrecognized loop state (${loop.state})`] }));
}

// ── worktrees ───────────────────────────────────────────────────────────────

export function classifyWorktree(wt, nowMs) {
  const base = { kind: "worktree", id: `worktree:${wt.path}`, label: wt.branch, firstSeenAt: wt.firstSeenAt ?? null };
  const stale = isStale(wt.lastHumanActivityAt, nowMs);

  if (wt.observationError) {
    return finalize(item({ ...base, rule: "worktree.scan_error", disposition: "SCAN_ERROR", severity: SEVERITY.critical,
      reasons: [`could not observe this worktree: ${wt.observationError}`] }));
  }
  if (wt.dirtyCount > 0) {
    return finalize(item({ ...base, rule: "worktree.dirty", disposition: "AGENT_OWNS", severity: SEVERITY.low,
      reasons: [`${wt.dirtyCount} uncommitted file(s)`] }));
  }
  if (!wt.merged && !wt.hasOpenPr && stale === true) {
    return finalize(item({ ...base, rule: "worktree.unmerged_stale", disposition: "NEEDS_MASON", severity: SEVERITY.low,
      reasons: [`unmerged, no open pull request, no human activity for over ${STALE_DAYS} days`],
      recommendation: "abandon it or turn it into a pull request" }));
  }
  // Ordinary in-progress work: a branch someone is actively building in a worktree that
  // has not become a pull request yet. Without this rule the live run put nine such
  // worktrees into the fallback, which is the fallback behaving correctly on an
  // incomplete table rather than the table being right.
  if (!wt.merged && !wt.hasOpenPr && stale === false) {
    return finalize(item({ ...base, rule: "worktree.unmerged_active", disposition: "AGENT_OWNS", severity: SEVERITY.low,
      reasons: ["unmerged and recently worked on, with no pull request open yet"] }));
  }
  if (wt.merged) {
    // Non-actionable on purpose: cleanup deletions while work is in flight are
    // forbidden, so merged worktrees batch into one deliberate pass. A non-actionable
    // alert does not block the all-clear.
    return finalize(item({ ...base, rule: "worktree.merged_clean", disposition: "IDLE", severity: SEVERITY.info,
      reasons: ["already merged into origin/main and clean"],
      nonActionableAlerts: ["candidate for the next batched worktree cleanup"] }));
  }
  if (!wt.merged && wt.hasOpenPr) {
    return finalize(item({ ...base, rule: "worktree.unmerged_tracked", disposition: "IDLE", severity: SEVERITY.info,
      reasons: ["unmerged, but tracked by an open pull request"] }));
  }
  return finalize(item({ ...base, rule: "worktree.fallback", disposition: "INDETERMINATE", severity: SEVERITY.normal,
    reasons: ["unrecognized worktree combination"] }));
}

// ── parked migrations (one aggregate item, never one per migration) ─────────

export function classifyParkedMigrations(parked) {
  const base = { kind: "parkedMigration", id: "parked:aggregate", label: "parked migrations" };
  if (parked.observationError) {
    return finalize(item({ ...base, rule: "parked.scan_error", disposition: "SCAN_ERROR", severity: SEVERITY.critical,
      reasons: [`could not read parked migrations: ${parked.observationError}`] }));
  }
  if (parked.count > 0) {
    return finalize(item({
      ...base, rule: "parked.present", disposition: "NEEDS_MASON", severity: SEVERITY.normal,
      label: `${parked.count} parked migration(s)`,
      // Names only. Patrol has no evidence with which to judge apply-readiness.
      reasons: [`written and waiting on an apply decision: ${parked.names.join(", ")}`],
      recommendation: "run /parked to review them — patrol cannot tell you whether any is safe to apply",
    }));
  }
  return finalize(item({ ...base, rule: "parked.none", disposition: "IDLE", severity: SEVERITY.info,
    reasons: ["no parked migrations"] }));
}

// ── review gate health ──────────────────────────────────────────────────────

export function classifyGate(gate) {
  const base = { kind: "gate", id: `gate:${gate.name}`, label: gate.name };
  if (gate.observationError) {
    return finalize(item({ ...base, rule: "gate.scan_error", disposition: "SCAN_ERROR", severity: SEVERITY.critical,
      reasons: [`could not probe ${gate.name}: ${gate.observationError}`] }));
  }
  if (gate.state === "DOWN") {
    return finalize(item({ ...base, rule: "gate.down", disposition: "NEEDS_MASON", severity: SEVERITY.critical,
      reasons: [gate.detail ?? "the review gate is unavailable"],
      // "gate down" and "gate says no" are different outcomes; only one has something to fix.
      recommendation: "this blocks reviews from running at all — it is not a review finding" }));
  }
  if (gate.state === "HEALTHY") {
    return finalize(item({ ...base, rule: "gate.healthy", disposition: "IDLE", severity: SEVERITY.info,
      reasons: ["probe fresh and healthy"] }));
  }
  return finalize(item({ ...base, rule: "gate.unknown", disposition: "INDETERMINATE", severity: SEVERITY.normal,
    reasons: ["gate health could not be determined — not assumed healthy"] }));
}

// ── whole-snapshot classification ───────────────────────────────────────────

export function classifySnapshot(snapshot, nowMs) {
  const items = [];
  const sourceStatus = new Map((snapshot.sources ?? []).map((s) => [s.name, s]));

  // A source that failed produces ONE explicit SCAN_ERROR item. Without this an empty
  // list from a broken source is indistinguishable from a genuinely empty list.
  for (const src of snapshot.sources ?? []) {
    if (src.status !== "OK") {
      items.push(finalize(item({
        kind: "source", id: `source:${src.name}`, label: src.name,
        rule: "source.not_ok", disposition: "SCAN_ERROR", severity: SEVERITY.critical,
        reasons: [`source "${src.name}" reported ${src.status}: ${src.detail ?? "no detail"}`],
      })));
    }
  }

  const ok = (name) => sourceStatus.get(name)?.status === "OK";

  if (ok("pullRequests")) for (const pr of snapshot.pullRequests ?? []) items.push(classifyPullRequest(pr, nowMs));
  if (ok("loops")) for (const l of snapshot.loops ?? []) items.push(classifyLoop(l));
  if (ok("worktrees")) for (const w of snapshot.worktrees ?? []) items.push(classifyWorktree(w, nowMs));
  if (ok("parkedMigrations") && snapshot.parkedMigrations) items.push(classifyParkedMigrations(snapshot.parkedMigrations));
  if (ok("gateHealth")) for (const g of snapshot.gateHealth ?? []) items.push(classifyGate(g));

  return items;
}

// Deterministic ordering: severity desc, then oldest first, then id. Hidden items gain
// +1 severity per full day hidden so nothing starves behind the display cap.
export function rankItems(items, nowMs) {
  const aged = items.map((it) => {
    let sev = it.severity;
    if (it.firstSeenAt) {
      const t = Date.parse(it.firstSeenAt);
      if (Number.isFinite(t)) sev += Math.max(0, Math.floor((nowMs - t) / DAY_MS));
    }
    return { ...it, rankSeverity: sev };
  });
  return aged.sort((a, b) => {
    if (b.rankSeverity !== a.rankSeverity) return b.rankSeverity - a.rankSeverity;
    const ta = a.firstSeenAt ? Date.parse(a.firstSeenAt) : Number.POSITIVE_INFINITY;
    const tb = b.firstSeenAt ? Date.parse(b.firstSeenAt) : Number.POSITIVE_INFINITY;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
