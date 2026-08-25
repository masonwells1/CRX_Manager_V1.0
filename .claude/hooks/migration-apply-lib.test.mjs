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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  evaluateMigrationApplyWithCachedTestEvidence,
} from "./migration-apply-lib.mjs";
import { checkWrappable } from "./migration-wrappability-lib.mjs";
import { scratchHookEnvironment } from "./git-test-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .claude/hooks/ → repo root → scripts/
const __scriptsDir = path.resolve(__dirname, "..", "..", "scripts");
const FANOUT_PRODUCER_SOURCES = [
  "scripts/generate-trigger-fanout.mjs",
  "scripts/supabase-linked-read.mjs",
  ".claude/hooks/apply-time-dml-lib.mjs",
];
const FANOUT_FIXTURE = JSON.parse(readFileSync(path.join(__scriptsDir, "trigger-fanout.json"), "utf8"));
FANOUT_FIXTURE._meta.captured_at = new Date().toISOString();
FANOUT_FIXTURE._meta.source_project = "rhyzpcqhnizqbxphqdkr";
FANOUT_FIXTURE.opaque_on_tables = [];
FANOUT_FIXTURE.fanout = {};
FANOUT_FIXTURE.event_triggers = [];

function gitBlob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function writeGuardFixtures(root) {
  const baselineDir = path.join(root, "supabase", "baselines");
  mkdirSync(baselineDir, { recursive: true });
  writeFileSync(path.join(baselineDir, "one-shot-migrations.json"), JSON.stringify({ one_shot: {} }));

  const manifestDir = path.join(root, "scripts");
  mkdirSync(manifestDir, { recursive: true });
  const manifestBytes = Buffer.from(JSON.stringify(FANOUT_FIXTURE));
  writeFileSync(path.join(manifestDir, "trigger-fanout.json"), manifestBytes);
  const sources = FANOUT_PRODUCER_SOURCES.map((relativePath) => {
    const sourcePath = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    const bytes = Buffer.from(`fixture source: ${relativePath}\n`);
    writeFileSync(sourcePath, bytes);
    return {
      path: relativePath,
      git_blob: gitBlob(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  writeFileSync(
    path.join(root, ".claude", "session-state", "trigger-fanout-attestation.json"),
    JSON.stringify({
      format_version: 1,
      kind: "crx-trigger-fanout-attestation",
      manifest: {
        path: "scripts/trigger-fanout.json",
        sha256: createHash("sha256").update(manifestBytes).digest("hex"),
      },
      source_project: FANOUT_FIXTURE._meta.source_project,
      captured_at: FANOUT_FIXTURE._meta.captured_at,
      producer: { wrapper: "scripts/generate-trigger-fanout.mjs", sources },
    }),
  );
}

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
  writeGuardFixtures(root);
  // A string snapshot is written VERBATIM so a case can supply genuinely
  // unparseable content; JSON.stringify would have turned "not json" into the
  // perfectly valid JSON document "\"not json\"" and tested the wrong branch.
  if (snapshot !== null) {
    const storedSnapshot = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? { project_id: "rhyzpcqhnizqbxphqdkr", ...snapshot }
      : snapshot;
    writeFileSync(
      path.join(stateDir, "applied-migrations.json"),
      typeof storedSnapshot === "string" ? storedSnapshot : JSON.stringify(storedSnapshot),
      "utf8");
  }
  if (proof !== null) writeFileSync(path.join(stateDir, `migration-review-${SAFE}.json`), JSON.stringify(proof), "utf8");
  if (codexProof !== null) writeFileSync(path.join(stateDir, `codex-review-mig-${SAFE}.json`), JSON.stringify(codexProof), "utf8");
  if (autopilot !== null) writeFileSync(path.join(stateDir, "AUTOPILOT.on"), autopilot, "utf8");
  return root;
}

const evaluate = (root, over = {}) => evaluateMigrationApplyWithCachedTestEvidence({
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
denies(evaluate(fixture({ snapshot: null })), "no trustworthy live applied-migration evidence was available",
  "missing applied-migration snapshot");
denies(evaluate(fixture({ snapshot: { captured_at: iso(0), applied: [] } })), "contains no rows",
  "empty snapshot (indistinguishable from 'nothing ever applied')");
denies(evaluate(fixture({ snapshot: { captured_at: iso(-48 * 3600 * 1000), applied: [{ version: "20260101000000", name: "20260101000000_baseline" }] } })),
  "h old (captured", "snapshot older than 24h");
denies(evaluate(fixture({ snapshot: { applied: [{ version: "20260101000000", name: "20260101000000_baseline" }] } })),
  "no usable captured_at", "snapshot with no captured_at (freshness unknowable)");
denies(evaluate(fixture({ snapshot: { captured_at: iso(0), applied: [{ version: "x", name: "no_timestamp_here" }] } })),
  "not one carries a 14-digit migration timestamp", "snapshot carrying no 14-digit timestamp to compare against");
denies(evaluate(fixture({ snapshot: "not json at all" })), "no trustworthy live applied-migration evidence was available",
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
  const viaScriptShape = evaluateMigrationApplyWithCachedTestEvidence({
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
  const scriptPath = path.resolve(__scriptsDir, "apply-migration-file-test-entry.mjs");
  const productionScriptPath = path.resolve(__scriptsDir, "apply-migration-file.mjs");

  const runScript = (root, args = []) => {
    const migFile = path.join(root, "supabase", "migrations", `${MIG}.sql`);
    return spawnSync(process.execPath, [scriptPath, migFile, ...args], {
      encoding: "utf8",
      env: { ...scratchHookEnvironment(root), SUPABASE_ACCESS_TOKEN: "" },
    });
  };

  const runProductionScript = (root, args = []) => {
    const migFile = path.join(root, "supabase", "migrations", `${MIG}.sql`);
    return spawnSync(process.execPath, [productionScriptPath, migFile, ...args], {
      encoding: "utf8",
      env: { ...scratchHookEnvironment(root), SUPABASE_ACCESS_TOKEN: "" },
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

  // Production cannot select cached fixture evidence: the same fixture that
  // passes the regression entry must attempt a fixed linked read and refuse.
  const productionDry = runProductionScript(okRoot);
  ok(productionDry.status === 2, "production dry run refuses local cached evidence");
  ok(productionDry.stderr.includes("linked production query (in memory)"),
    "production refusal proves it attempted the fixed live-evidence path");

  // Even a perfect cached fixture can never turn the regression wrapper into a
  // live apply channel.
  const cachedConfirm = runScript(okRoot, ["--confirm"]);
  ok(cachedConfirm.status === 2, "cached regression entry refuses --confirm");
  ok(cachedConfirm.stderr.includes("cached regression entry cannot transmit"),
    "cached regression refusal names its structural no-transmission boundary");
  ok(!cachedConfirm.stdout.includes("Transmitting"), "cached regression entry never transmits");

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

  // --project is refused outright. The snapshot, the proofs and the autopilot flag
  // are all checkout-wide and assume ONE project; pointing this script at another
  // ref would overwrite the snapshot production ordering is judged against with a
  // foreign ledger, and CRX-local proofs would authorize a target they never
  // reviewed. (Codex P1, PR #460 round 4.)
  const otherProject = runScript(okRoot, ["--project", "someotherprojectref"]);
  ok(otherProject.status === 1, `--project is refused (got ${otherProject.status})`);
  ok(otherProject.stderr.includes("--project is not supported"), "the refusal names the flag");
  ok(!otherProject.stdout.includes("Transmitting"), "--project never reaches transmission");
  const otherProjectConfirm = runScript(okRoot, ["--project", "someotherprojectref", "--confirm"]);
  ok(otherProjectConfirm.status === 1, "--project is refused even with --confirm");
}

// ── WRAPPABILITY: the precondition the atomicity promise depends on ─────────
// CodeRabbit (Major) and Codex (P2) both caught that the first revision only
// DOCUMENTED "no transaction control, nothing non-transactional" and never
// enforced it. These pin the enforcement, including the false positives that
// would make it useless: a PL/pgSQL body legitimately contains BEGIN/END, and a
// comment or string literal naming COMMIT is not transaction control.
{
  const wrappable = (sql, m) => { ok(checkWrappable(sql).wrappable === true, `${m} — expected wrappable, got: ${checkWrappable(sql).reason}`); };
  const notWrappable = (sql, fragment, m) => {
    const v = checkWrappable(sql);
    assert.equal(v.wrappable, false, `${m} — expected NOT wrappable`);
    assert.ok(String(v.reason).includes(fragment), `${m} — reason did not mention ${JSON.stringify(fragment)}; got: ${v.reason}`);
    pass++;
  };

  wrappable("CREATE TABLE public.t (id bigint);\nALTER TABLE public.t ENABLE ROW LEVEL SECURITY;\n",
    "an ordinary additive migration is wrappable");

  notWrappable("CREATE TABLE public.t (id bigint);\nCOMMIT;\n", "COMMIT", "a top-level COMMIT is refused");
  notWrappable("BEGIN;\nCREATE TABLE public.t (id bigint);\n", "BEGIN", "a top-level BEGIN is refused");
  notWrappable("START TRANSACTION;\nCREATE TABLE public.t (id bigint);\n", "START TRANSACTION", "START TRANSACTION is refused");
  notWrappable("CREATE TABLE public.t (id bigint);\nROLLBACK;\n", "ROLLBACK", "a top-level ROLLBACK is refused");
  notWrappable("SAVEPOINT s1;\nCREATE TABLE public.t (id bigint);\n", "SAVEPOINT", "a SAVEPOINT is refused");
  notWrappable("CREATE INDEX CONCURRENTLY idx_t ON public.t (id);\n", "CONCURRENTLY",
    "CREATE INDEX CONCURRENTLY is refused — Postgres cannot run it in a transaction block");
  notWrappable("DROP INDEX CONCURRENTLY idx_t;\n", "CONCURRENTLY", "DROP INDEX CONCURRENTLY is refused");
  notWrappable("VACUUM ANALYZE public.t;\n", "VACUUM", "VACUUM is refused");
  notWrappable("ALTER SYSTEM SET work_mem = '64MB';\n", "ALTER SYSTEM", "ALTER SYSTEM is refused");
  notWrappable("CLUSTER public.t USING idx_t;\n", "CLUSTER", "CLUSTER is refused");
  // ALTER TYPE … ADD VALUE has been transaction-safe since PostgreSQL 12 (live
  // server verified: 17.6). The blanket rejection was wrong and its advice was
  // impossible — the "split it out" file hit the same rule. (Codex P2, round 3.)
  wrappable("ALTER TYPE public.order_status ADD VALUE 'archived';\n",
    "an isolated enum addition is wrappable on PostgreSQL 12+");
  // DROP OWNED is destructive but perfectly transactional; destruction is the
  // destructive-content gate's job, not a transaction-block restriction.
  wrappable("DROP OWNED BY some_role;\n", "DROP OWNED is transactional, so wrappability does not reject it");
  notWrappable("   \n", "empty", "an empty migration is refused");
  // Each TXN_CONTROL rule gets a standalone case so it is exercised on its own
  // rather than only via a rule that happens to match first (CodeRabbit round 2).
  notWrappable("CREATE TABLE public.t (id bigint);\nEND;\n", "END", "a top-level END is refused");
  notWrappable("PREPARE TRANSACTION 'tx1';\n", "PREPARE TRANSACTION", "PREPARE TRANSACTION is refused");
  notWrappable("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nCREATE TABLE public.t (id bigint);\n",
    "SET TRANSACTION", "SET TRANSACTION is refused");
  notWrappable("COMMIT TRANSACTION;\n", "COMMIT", "COMMIT TRANSACTION is refused");
  notWrappable("ROLLBACK TO SAVEPOINT s1;\n", "ROLLBACK", "ROLLBACK TO SAVEPOINT is refused");
  notWrappable("BEGIN TRANSACTION;\nCREATE TABLE public.t (id bigint);\n", "BEGIN", "BEGIN TRANSACTION is refused");
  notWrappable("RELEASE SAVEPOINT s1;\n", "SAVEPOINT", "RELEASE SAVEPOINT is refused");
  // A migration with no statements is a no-op that would still write a ledger row.
  notWrappable("-- just a comment, no statements\n", "no SQL statements", "a comment-only migration is refused");
  notWrappable(";;;\n", "no SQL statements", "a semicolon-only migration is refused");
  notWrappable("/* block comment only */\n", "no SQL statements", "a block-comment-only migration is refused");

  // The false positives that would make this check unusable.
  wrappable(
    "CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $$\nBEGIN\n  INSERT INTO public.t VALUES (1);\nEND\n$$ LANGUAGE plpgsql;\n",
    "a PL/pgSQL body's BEGIN/END is not transaction control");
  wrappable(
    "DO $do$\nBEGIN\n  PERFORM 1;\nEND\n$do$;\n",
    "a DO block's BEGIN/END is not transaction control");
  // REGRESSION (found by running the real 162KB migration, not by a unit test):
  // the first implementation reused live-testdata-lib's stripDollarQuoted, which
  // strips DO bodies but deliberately KEEPS CREATE FUNCTION bodies visible. A
  // body ending `END;` therefore read as top-level transaction control and the
  // real migration was refused. These pin the terminated-`END;` forms — the
  // earlier "$$ BEGIN … END $$" case passed only because no `;` followed END.
  wrappable(
    "CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $function$\nBEGIN\n  PERFORM 1;\nEND;\n$function$ LANGUAGE plpgsql;\n",
    "a function body ending END; is not transaction control");
  wrappable(
    "CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $function$\nBEGIN\n  BEGIN\n    PERFORM 1;\n  EXCEPTION WHEN others THEN\n    RAISE;\n  END;\nEND;\n$function$ LANGUAGE plpgsql;\n",
    "nested PL/pgSQL BEGIN/EXCEPTION/END; blocks are not transaction control");
  wrappable(
    "DO $preflight$\nBEGIN\n  IF true THEN\n    RAISE NOTICE 'ok';\n  END IF;\nEND;\n$preflight$;\nDO $postflight$\nBEGIN\n  PERFORM 1;\nEND;\n$postflight$;\n",
    "custom-tagged DO blocks with END; are not transaction control");
  wrappable(
    "CREATE FUNCTION public.g() RETURNS void AS $qty_check$\nBEGIN\n  -- COMMIT; ROLLBACK; inside a body comment\n  PERFORM 1;\nEND;\n$qty_check$ LANGUAGE plpgsql;\n",
    "transaction keywords inside a function body are not top-level");
  // Unterminated bodies cannot be classified, so they must refuse.
  notWrappable("CREATE FUNCTION public.f() RETURNS void AS $function$\nBEGIN\n  PERFORM 1;\n", "UNKNOWN",
    "an unterminated dollar-quoted body is refused, not assumed safe");
  notWrappable("SELECT 'unterminated;\n", "UNKNOWN", "an unterminated string literal is refused");
  wrappable(
    "-- this migration does not COMMIT on its own; the caller wraps it\nCREATE TABLE public.t (id bigint);\n",
    "a comment naming COMMIT is not transaction control");
  wrappable(
    "INSERT INTO public.audit (note) VALUES ('COMMIT was requested');\n",
    "a string literal naming COMMIT is not transaction control");
  wrappable(
    "CREATE TABLE public.commit_log (id bigint, rollback_reason text);\n",
    "identifiers containing commit/rollback are not transaction control");

  // And the script must refuse a non-wrappable file end-to-end, before the gate.
  const wRoot = fixture();
  mkdirSync(path.join(wRoot, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(wRoot, "supabase", "migrations", `${MIG}.sql`), "CREATE TABLE public.t (id bigint);\nCOMMIT;\n", "utf8");
  const res = spawnSync(process.execPath, [
    path.resolve(__scriptsDir, "apply-migration-file.mjs"),
    path.join(wRoot, "supabase", "migrations", `${MIG}.sql`),
    "--confirm",
  ], { encoding: "utf8", env: { ...scratchHookEnvironment(wRoot), SUPABASE_ACCESS_TOKEN: "" } });
  ok(res.status === 2, `a transaction-managing migration is refused by the script (got ${res.status})`);
  ok(res.stderr.includes("NOT WRAPPABLE"), "the script names the wrappability precondition in its refusal");
  ok(!res.stdout.includes("Transmitting"), "a non-wrappable migration is never transmitted");

  // The snapshot must survive a REFUSAL — invalidation belongs to an apply that
  // actually transmits, not to every invocation.
  ok(existsSync(path.join(wRoot, ".claude", "session-state", "applied-migrations.json")),
    "a refused run leaves the applied-migration snapshot intact");
}

// ── STALE SNAPSHOT CANNOT SURVIVE AN APPLY ──────────────────────────────────
// Codex exercised the hole (apply 200, ledger re-read 503): the script exited 0
// and the OLD snapshot survived, still "fresh" by the clock but missing the row
// just written — so the next apply could pass the ordering gate for a migration
// older than the one just applied. The snapshot is now deleted BEFORE the fetch,
// so no apply outcome, network failure, or crash can leave a stale one.
{
  const root = fixture();
  mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(root, "supabase", "migrations", `${MIG}.sql`), SQL, "utf8");
  const snapshot = path.join(root, ".claude", "session-state", "applied-migrations.json");
  ok(existsSync(snapshot), "fixture starts with a snapshot present");

  // --confirm with an unreachable endpoint: the gate passes, wrappability passes,
  // the snapshot is invalidated, and transmission then fails. The snapshot must
  // NOT come back.
  const res = spawnSync(process.execPath, [
    path.resolve(__scriptsDir, "apply-migration-file-failed-transmission-test-entry.mjs"),
    path.join(root, "supabase", "migrations", `${MIG}.sql`),
    "--confirm",
  ], {
    encoding: "utf8",
    env: {
      ...scratchHookEnvironment(root),
      SUPABASE_ACCESS_TOKEN: "not-a-real-token-transmission-must-fail",
      // Force the request through a dead local proxy so this test NEVER touches
      // the real management API. Node's fetch ignores proxy env vars unless
      // NODE_USE_ENV_PROXY is set (Node 24), so without this the run would have
      // gone out to api.supabase.com with a junk token — offline-by-accident is
      // not offline.
      NODE_USE_ENV_PROXY: "1",
      https_proxy: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "",
      no_proxy: "",
    },
  });
  ok(res.stdout.includes("Invalidated the applied-migration snapshot"),
    "the snapshot is invalidated before transmission");
  ok(!existsSync(snapshot),
    "after an apply attempt the stale snapshot is GONE — the next apply blocks on missing evidence");
  ok(res.status !== 0, `a failed transmission exits non-zero (got ${res.status})`);
}

for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`migration-apply-lib: ${pass} assertions passed`);
