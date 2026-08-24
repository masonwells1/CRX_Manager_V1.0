#!/usr/bin/env node
// Mutation tests for the shared migration-apply rule book.
//
// These are deliberately NOT "does it say yes when everything is fine" tests. A
// guard that has only ever been observed passing has not been tested — the thing
// that matters is that each check REFUSES when the condition it exists to detect
// is present. So every case below starts from a known-good fixture, breaks
// exactly one thing, and asserts the refusal.
//
// The one ALLOW assertion per rule-set is load-bearing too: without it a guard
// that refuses everything unconditionally would pass every deny case and still be
// broken (and would quietly make the second door useless).
//
// Run: node .claude/hooks/migration-apply-lib.test.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { evaluateMigrationApply } from "./migration-apply-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .claude/hooks/ → repo root → scripts/
const __scriptsDir = path.resolve(__dirname, "..", "..", "scripts");

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function denies(verdict, fragment, m) {
  assert.equal(verdict.decision, "block", `${m} — expected a refusal, got ${verdict.decision}`);
  assert.ok(
    String(verdict.reason || "").includes(fragment),
    `${m} — refusal did not mention ${JSON.stringify(fragment)}; got: ${String(verdict.reason).slice(0, 200)}`);
  pass++;
}
function allows(verdict, m) {
  assert.equal(verdict.decision, "allow", `${m} — expected allow, got block: ${String(verdict.reason).slice(0, 300)}`);
  pass++;
}

const SQL = "CREATE TABLE public.widgets (id bigint primary key);\nALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;\n";
const HASH = createHash("sha256").update(SQL).digest("hex");
const MIG = "20260816120000_add_widgets";
const SAFE = MIG.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
// `git worktree list` is stubbed to empty so proof lookup stays inside the
// fixture directory and never touches the real repo.
const noWorktrees = () => "";

const roots = [];
/** Build a fixture project dir. Pass overrides to break exactly one thing. */
function fixture({
  snapshot = { captured_at: iso(0), applied: [{ version: "20260101000000", name: "20260101000000_baseline" }] },
  proof = {
    migration: MIG,
    timestamp: iso(0),
    reviewers: ["rls-security-reviewer", "migration-drift-reviewer"],
    findings: "clean",
    queryHash: HASH,
  },
  codexProof = null,
  autopilot = null,
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "crx-applylib-"));
  roots.push(root);
  const stateDir = path.join(root, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  // A string snapshot is written VERBATIM so a case can supply genuinely
  // unparseable content; JSON.stringify would have turned "not json" into the
  // perfectly valid JSON document "\"not json\"" and tested the wrong branch.
  if (snapshot !== null) {
    writeFileSync(
      path.join(stateDir, "applied-migrations.json"),
      typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
      "utf8");
  }
  if (proof !== null) writeFileSync(path.join(stateDir, `migration-review-${SAFE}.json`), JSON.stringify(proof), "utf8");
  if (codexProof !== null) writeFileSync(path.join(stateDir, `codex-review-mig-${SAFE}.json`), JSON.stringify(codexProof), "utf8");
  if (autopilot !== null) writeFileSync(path.join(stateDir, "AUTOPILOT.on"), autopilot, "utf8");
  return root;
}

const evaluate = (root, over = {}) => evaluateMigrationApply({
  name: MIG,
  query: SQL,
  projectId: "rhyzpcqhnizqbxphqdkr",
  projectDir: root,
  cwd: root,
  gitWorktreeList: noWorktrees,
  ...over,
});

// ── BASELINE: the fixture must ALLOW, or every deny below proves nothing ─────
allows(evaluate(fixture()), "known-good interactive fixture is allowed");

// ── CHECK 1: ordering preflight ─────────────────────────────────────────────
// Each case asserts the SPECIFIC message for its condition, not just the guard
// banner. Mutation testing earned this: disabling the missing-snapshot check
// still produced a refusal (the read then threw and the catch failed closed), so
// a banner-only assertion stayed green while the check it named was gone.
denies(evaluate(fixture({ snapshot: null })), "no applied-migration snapshot at",
  "missing applied-migration snapshot");
denies(evaluate(fixture({ snapshot: { captured_at: iso(0), applied: [] } })), "contains no rows",
  "empty snapshot (indistinguishable from 'nothing ever applied')");
denies(evaluate(fixture({ snapshot: { captured_at: iso(-48 * 3600 * 1000), applied: [{ version: "20260101000000", name: "20260101000000_baseline" }] } })),
  "h old (captured", "snapshot older than 24h");
denies(evaluate(fixture({ snapshot: { applied: [{ version: "20260101000000", name: "20260101000000_baseline" }] } })),
  "no usable captured_at", "snapshot with no captured_at (freshness unknowable)");
denies(evaluate(fixture({ snapshot: { captured_at: iso(0), applied: [{ version: "x", name: "no_timestamp_here" }] } })),
  "not one carries a 14-digit migration timestamp", "snapshot carrying no 14-digit timestamp to compare against");
denies(evaluate(fixture({ snapshot: "not json at all" })), "could not read the applied-migration snapshot",
  "unreadable snapshot fails closed");
// The replay case this guard was built for: candidate OLDER than the high-water.
denies(
  evaluate(fixture({
    snapshot: { captured_at: iso(0), applied: [{ version: "20270101000000", name: "20270101000000_much_newer" }] },
  })),
  "MIGRATION ORDERING GUARD", "out-of-order replay behind the applied high-water");
// An untimestamped (caller-controlled) name must not buy a skip.
denies(
  evaluate(fixture({ proof: { migration: "add_widgets", timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: HASH } }),
    { name: "add_widgets" }),
  "MIGRATION ORDERING GUARD", "untimestamped migration name is refused, not abstained");

// ── CHECK 2: autopilot flag state ───────────────────────────────────────────
denies(evaluate(fixture({ autopilot: JSON.stringify({ expires: iso(-60 * 60 * 1000) }) })),
  "LAPSED", "EXPIRED autopilot flag parks ALL applies");
denies(evaluate(fixture({ autopilot: "{ not valid json" })),
  "LAPSED", "malformed autopilot flag parks ALL applies");

// ── CHECK 3: destructive content (hands-free only) ──────────────────────────
const armed = () => JSON.stringify({ expires: iso(4 * 3600 * 1000) });
const goodCodex = { queryHash: HASH, verdict: "clean", model: "gpt-5.6-sol", reasoning_effort: "high", timestamp: iso(0) };
const DESTRUCTIVE = "DROP TABLE public.customers;\n";
const destructiveHash = createHash("sha256").update(DESTRUCTIVE).digest("hex");
denies(
  evaluate(
    fixture({
      autopilot: armed(),
      proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: destructiveHash },
      codexProof: { ...goodCodex, queryHash: destructiveHash },
    }),
    { query: DESTRUCTIVE }),
  "destructive statement", "armed run refuses a destructive migration even with a perfect proof");

// ── CHECK 4: reviewer proof ─────────────────────────────────────────────────
denies(evaluate(fixture({ proof: null })), "without subagent review proof",
  "no reviewer proof at all");
denies(evaluate(fixture({ proof: { migration: MIG, timestamp: iso(-31 * 60 * 1000), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: HASH } })),
  "without subagent review proof", "reviewer proof older than 30 minutes");
denies(evaluate(fixture({ proof: { migration: MIG, timestamp: iso(60 * 60 * 1000), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: HASH } })),
  "without subagent review proof", "FUTURE-dated reviewer proof is not 'fresh forever'");
denies(evaluate(fixture({ proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "blockers", queryHash: HASH } })),
  "without subagent review proof", "reviewer proof whose findings are not clean/blockers-fixed");
// The edited-after-review case: proof is fresh and clean but bound to other SQL.
denies(evaluate(fixture({ proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: "0".repeat(64) } })),
  "without subagent review proof", "reviewer proof bound to DIFFERENT SQL (edited after review)");

// ── CHECK 5: hands-free extras (content binding, reviewers, Codex gate) ─────
allows(evaluate(fixture({ autopilot: armed(), codexProof: goodCodex })),
  "known-good ARMED fixture is allowed");

denies(
  evaluate(fixture({
    autopilot: armed(),
    proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean" },
    codexProof: goodCodex,
  })),
  "not content-bound", "armed run refuses a reviewer proof with no queryHash");

denies(
  evaluate(fixture({
    autopilot: armed(),
    proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer"], findings: "clean", queryHash: HASH },
    codexProof: goodCodex,
  })),
  "does not record the required reviewers", "armed run refuses when only one reviewer is named");

denies(evaluate(fixture({ autopilot: armed(), codexProof: null })),
  "Sol high-effort gate", "armed run refuses with no Codex proof file");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, verdict: "blockers" } })),
  "Sol high-effort gate", "armed run refuses a non-clean Codex verdict");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, queryHash: "0".repeat(64) } })),
  "Sol high-effort gate", "armed run refuses a Codex proof bound to different SQL");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, model: "gpt-5.6-terra" } })),
  "Sol high-effort gate", "armed run refuses the wrong Codex model");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, reasoning_effort: "medium" } })),
  "Sol high-effort gate", "armed run refuses the wrong reasoning effort");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, timestamp: iso(-31 * 60 * 1000) } })),
  "Sol high-effort gate", "armed run refuses a stale Codex proof");
denies(evaluate(fixture({ autopilot: armed(), codexProof: { ...goodCodex, timestamp: iso(60 * 60 * 1000) } })),
  "Sol high-effort gate", "armed run refuses a FUTURE-dated Codex proof");

// ── The second door must not be a weaker door ───────────────────────────────
// Same inputs the PreToolUse hook would pass vs. what apply-migration-file.mjs
// passes: identical verdicts, because it is the same function. Guards against a
// future refactor quietly special-casing one caller.
{
  const root = fixture();
  const viaHookShape = evaluate(root);
  const viaScriptShape = evaluateMigrationApply({
    name: MIG, query: SQL, projectId: "rhyzpcqhnizqbxphqdkr",
    projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
  });
  ok(viaHookShape.decision === viaScriptShape.decision, "both doors reach the identical verdict");
}

// ── THE SECOND DOOR ITSELF: scripts/apply-migration-file.mjs ────────────────
// The lib cases above prove the RULES. These prove the file-bytes caller obeys
// them: that it refuses when the gate refuses, and — the branch that actually
// matters — that on a PASSING gate it stops at the edge without transmitting
// unless --confirm was given. A dry run that silently applied would be the worst
// possible bug in this script, so it gets an explicit assertion.
{
  const scriptPath = path.resolve(__scriptsDir, "apply-migration-file.mjs");

  const runScript = (root, args = []) => {
    const migFile = path.join(root, "supabase", "migrations", `${MIG}.sql`);
    return spawnSync(process.execPath, [scriptPath, migFile, ...args], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, SUPABASE_ACCESS_TOKEN: "" },
    });
  };

  // Gate passes → dry run stops before the network, exit 0.
  const okRoot = fixture();
  mkdirSync(path.join(okRoot, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(okRoot, "supabase", "migrations", `${MIG}.sql`), SQL, "utf8");
  const dry = runScript(okRoot);
  ok(dry.status === 0, `dry run on a passing gate exits 0 (got ${dry.status}: ${dry.stderr})`);
  ok(dry.stdout.includes("APPLY GATE PASSED"), "dry run reports the gate passed");
  ok(dry.stdout.includes("DRY RUN"), "dry run says it is a dry run");
  ok(!dry.stdout.includes("Transmitting"), "dry run does NOT transmit without --confirm");
  ok(!dry.stdout.includes("APPLY OK"), "dry run does not report an apply");

  // Gate refuses → the script refuses too, non-zero, and never reaches the network.
  const badRoot = fixture({ proof: null });
  mkdirSync(path.join(badRoot, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(badRoot, "supabase", "migrations", `${MIG}.sql`), SQL, "utf8");
  const refused = runScript(badRoot);
  ok(refused.status === 2, `refused apply exits 2 (got ${refused.status})`);
  ok(refused.stderr.includes("APPLY GATE REFUSED"), "refusal is reported as a gate refusal");
  ok(!refused.stdout.includes("Transmitting"), "a refused apply never transmits");

  // Even WITH --confirm, a refused gate must not transmit.
  const refusedConfirm = runScript(badRoot, ["--confirm"]);
  ok(refusedConfirm.status === 2, "--confirm does not override a gate refusal");
  ok(!refusedConfirm.stdout.includes("Transmitting"), "--confirm on a refused gate never transmits");
}

for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`migration-apply-lib: ${pass} assertions passed`);
