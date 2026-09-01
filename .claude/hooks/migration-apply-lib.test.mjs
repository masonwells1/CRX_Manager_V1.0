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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { evaluateMigrationApply, normalizeMigName, resolveMigrationSource } from "./migration-apply-lib.mjs";
import { checkWrappable } from "./migration-wrappability-lib.mjs";

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
  // The repository migration file the SQL must come from. Every real apply has
  // one — the source-provenance rule refuses SQL that is not the content of a
  // file under supabase/migrations/ — so the fixture writes it by default.
  // A case that means to break provenance passes `migrationFile: null`; a case
  // that applies DIFFERENT sql passes it here so the deny it asserts is still
  // its own check firing rather than provenance short-circuiting ahead of it.
  migrationFile = SQL,
  migrationName = MIG,
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "crx-applylib-"));
  roots.push(root);
  const stateDir = path.join(root, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  if (migrationFile !== null) {
    mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(root, "supabase", "migrations", `${migrationName}.sql`), migrationFile, "utf8");
  }
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
  evaluate(fixture({
    migrationName: "add_widgets",
    proof: { migration: "add_widgets", timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: HASH },
  }), { name: "add_widgets" }),
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
      migrationFile: DESTRUCTIVE,
      proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: destructiveHash },
      codexProof: { ...goodCodex, queryHash: destructiveHash },
    }),
    { query: DESTRUCTIVE }),
  "destructive statement", "armed run refuses a destructive migration even with a perfect proof");
const ESCAPED_DESTRUCTIVE = "COMMENT ON TABLE public.customers IS E'escaped\\' quote /*'; DELETE FROM public.customers;";
const escapedDestructiveHash = createHash("sha256").update(ESCAPED_DESTRUCTIVE).digest("hex");
denies(
  evaluate(
    fixture({
      autopilot: armed(),
      migrationFile: ESCAPED_DESTRUCTIVE,
      proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: escapedDestructiveHash },
      codexProof: { ...goodCodex, queryHash: escapedDestructiveHash },
    }),
    { query: ESCAPED_DESTRUCTIVE }),
  "destructive statement", "armed run refuses DELETE after an escaped E-string even with perfect proof");
const ESCAPED_DOLLAR_QUOTE_DESTRUCTIVE = "COMMENT ON TABLE public.customers IS E'foo\\' AS $x$ junk'; DELETE FROM public.customers; -- $x$\nSELECT 1;";
const escapedDollarQuoteDestructiveHash = createHash("sha256").update(ESCAPED_DOLLAR_QUOTE_DESTRUCTIVE).digest("hex");
denies(
  evaluate(
    fixture({
      autopilot: armed(),
      migrationFile: ESCAPED_DOLLAR_QUOTE_DESTRUCTIVE,
      proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: escapedDollarQuoteDestructiveHash },
      codexProof: { ...goodCodex, queryHash: escapedDollarQuoteDestructiveHash },
    }),
    { query: ESCAPED_DOLLAR_QUOTE_DESTRUCTIVE }),
  "destructive statement", "armed run refuses DELETE after a dollar-quote marker inside an escaped E-string");

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
    proof: { migration: MIG, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: "0".repeat(64) },
    codexProof: goodCodex,
  })),
  "not content-bound", "armed run identifies a reviewer proof bound to different SQL");

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

  // --name is refused for the same reason: it was caller-controlled input that TWO
  // checks trusted. An alias like `99999999999999_alias_<oldstamp>_old_migration`
  // still matches the reviewer proof by substring, while the ordering gate reads the
  // FIRST 14-digit stamp and rules the stale SQL newer than everything applied —
  // the out-of-order replay the gate exists to stop. (Codex P1, PR #460 round 5.)
  const aliased = runScript(okRoot, ["--name", `99999999999999_alias_${MIG}`]);
  ok(aliased.status === 1, `--name is refused (got ${aliased.status})`);
  ok(aliased.stderr.includes("--name is not supported"), "the refusal names the flag");
  ok(!aliased.stdout.includes("Transmitting"), "--name never reaches transmission");
  const aliasedConfirm = runScript(okRoot, ["--name", `99999999999999_alias_${MIG}`, "--confirm"]);
  ok(aliasedConfirm.status === 1, "--name is refused even with --confirm");
  // `argv.includes` matched only a standalone token, so the `=` spelling slipped
  // through; and the check ran after file resolution, so a missing file reported a
  // path error instead of the refusal. (CodeRabbit, PR #470.)
  const aliasedEquals = runScript(okRoot, [`--name=99999999999999_alias_${MIG}`]);
  ok(aliasedEquals.status === 1, "--name=alias is refused too");
  ok(aliasedEquals.stderr.includes("--name is not supported"), "the = spelling gets the same refusal");
  const projectEquals = runScript(okRoot, ["--project=someotherref"]);
  ok(projectEquals.status === 1, "--project=ref is refused too");
  const nameNoFile = spawnSync(process.execPath, [
    path.resolve(__scriptsDir, "apply-migration-file.mjs"), "--name", "whatever",
  ], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: okRoot, SUPABASE_ACCESS_TOKEN: "" } });
  ok(nameNoFile.stderr.includes("--name is not supported"),
    "the flag refusal fires BEFORE file resolution, not a path error");

  // REMOVING THE FLAG WAS HALF A FIX. The filename is caller-controlled too: copy an
  // old reviewed migration to `99999999999999_alias_<old-name>.sql` and the proof
  // still matches by substring, the queryHash still matches, and ordering reads the
  // alias's FIRST stamp as newest. Codex reproduced the full replay (P1, PR #470).
  // A canonical name — exactly one 14-digit stamp, at the start — kills it by
  // construction, because an alias needs a second stamp to carry the original name.
  {
    const aliasRoot = fixture();
    mkdirSync(path.join(aliasRoot, "supabase", "migrations"), { recursive: true });
    const aliasName = `99999999999999_alias_${MIG}`;
    writeFileSync(path.join(aliasRoot, "supabase", "migrations", `${aliasName}.sql`), SQL, "utf8");
    const res = spawnSync(process.execPath, [
      path.resolve(__scriptsDir, "apply-migration-file.mjs"),
      path.join(aliasRoot, "supabase", "migrations", `${aliasName}.sql`),
      "--confirm",
    ], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: aliasRoot, SUPABASE_ACCESS_TOKEN: "" } });
    ok(res.status === 1, `an aliased FILENAME is refused (got ${res.status})`);
    ok(res.stderr.includes("not a canonical migration name"), "the refusal names the canonical-name rule");
    ok(!res.stdout.includes("Transmitting"), "an aliased filename never transmits");
    ok(existsSync(path.join(aliasRoot, ".claude", "session-state", "applied-migrations.json")),
      "a refused aliased filename leaves the snapshot intact");
  }
  // A real repository migration name still passes unchanged.
  ok(dry.status === 0, "the canonical-name rule does not reject a real migration filename");

  // ROUND 7: the stamp-count rule closed a SHAPE, not the mechanism. A legacy
  // 8-digit name (`20260210_fix_rls_critical_issues`) aliased to
  // `99999999999999_alias_20260210_fix_rls_critical_issues` has exactly ONE 14-digit
  // stamp, so it passed — while substring proof-matching still handed it the old
  // migration's proof. Codex reproduced APPLY GATE PASSED. Exact proof-name equality
  // is the actual fix.
  {
    const legacy = "20260210_fix_rls_critical_issues";
    const alias = `99999999999999_alias_${legacy}`;
    const legacySql = "ALTER TABLE public.t ENABLE ROW LEVEL SECURITY;\n";
    const legacyHash = createHash("sha256").update(legacySql).digest("hex");
    const root = mkdtempSync(path.join(os.tmpdir(), "crx-alias8-"));
    roots.push(root);
    const stateDir = path.join(root, ".claude", "session-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "applied-migrations.json"),
      JSON.stringify({ captured_at: iso(0), applied: [{ version: "20270101000000", name: "20270101000000_much_newer" }] }), "utf8");
    // A genuine, fresh, clean proof for the LEGACY migration — nothing forged.
    writeFileSync(path.join(stateDir, `migration-review-${legacy}.json`),
      JSON.stringify({ migration: legacy, timestamp: iso(0), reviewers: ["rls-security-reviewer", "migration-drift-reviewer"], findings: "clean", queryHash: legacyHash }), "utf8");
    // The alias file is written to the PERMITTED directory on purpose. That is
    // literally what the PR #470 attack did — `cp <reviewed>.sql <alias>.sql` — so
    // source provenance alone does NOT stop it, and these cases must keep proving
    // that exact proof-name matching is the thing doing the work. Without the file
    // here, every assertion below would pass for the wrong reason.
    mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(root, "supabase", "migrations", `${alias}.sql`), legacySql, "utf8");
    writeFileSync(path.join(root, "supabase", "migrations", `${legacy}.sql`), legacySql, "utf8");

    // FIXED (PR: exact proof-name on the MCP path). requireExactProofName now
    // DEFAULTS to true, so the hook — which passes no such flag — refuses the alias.
    // This assertion used to read "substring matching DOES let the alias inherit the
    // proof (the bug)" and was a characterization test for a known-open hole.
    const byDefault = evaluateMigrationApply({
      name: alias, query: legacySql, projectId: "rhyzpcqhnizqbxphqdkr",
      projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
    });
    denies(byDefault, "without subagent review proof", "the DEFAULT now refuses the aliased legacy name (was the bug)");

    // The lenient mode still behaves the old way when a caller explicitly opts in.
    // Kept deliberately: it documents WHY the default was flipped, and it fails loudly
    // if anyone ever reintroduces substring matching as the default.
    const lenient = evaluateMigrationApply({
      name: alias, query: legacySql, projectId: "rhyzpcqhnizqbxphqdkr",
      projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
      requireExactProofName: false,
    });
    ok(lenient.decision === "allow", "opt-in substring matching is still the vulnerable behaviour (no longer the default)");

    // Exact matching refuses it.
    const strict = evaluateMigrationApply({
      name: alias, query: legacySql, projectId: "rhyzpcqhnizqbxphqdkr",
      projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
      requireExactProofName: true,
    });
    denies(strict, "without subagent review proof", "exact proof-name matching refuses the aliased legacy name");

    // Worth stating plainly, because it sharpens the bug: the legacy name cannot be
    // applied HONESTLY either — the ordering guard refuses any candidate without a
    // 14-digit stamp. So the only thing its proof was ever good for was being
    // inherited by an alias that DID carry one. Exact matching removes that.
    const honest = evaluateMigrationApply({
      name: legacy, query: legacySql, projectId: "rhyzpcqhnizqbxphqdkr",
      projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
      requireExactProofName: true,
    });
    denies(honest, "MIGRATION ORDERING GUARD",
      "the legacy 8-digit name is refused by ordering regardless — its proof was only ever useful to an alias");

    // Exact matching must not break the ordinary case: a canonical name whose proof
    // names it exactly still passes.
    allows(evaluate(fixture(), { requireExactProofName: true }),
      "exact proof-name matching still allows a normal, correctly-named migration");
  }
  // The derived name still works — the removal must not break the normal path.
  ok(dry.stdout.includes(`migration : ${MIG}`), "the ledger name is derived from the filename");

  // AN OUT-OF-TREE COPY WITH IDENTICAL BYTES IS NOT THE APPROVED FILE.
  // (CodeRabbit, PR #533.) Content binding already refuses a copy whose content
  // DIFFERS, so this is hardening rather than a demonstrated bypass — the bytes
  // that would run were identical either way. It is closed anyway so that
  // "apply this file" and "apply the reviewed migration" cannot be two different
  // statements that merely happen to agree.
  {
    const okRoot2 = fixture();
    mkdirSync(path.join(okRoot2, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(okRoot2, "supabase", "migrations", `${MIG}.sql`), SQL, "utf8");
    const outside = mkdtempSync(path.join(os.tmpdir(), "crx-copy-"));
    roots.push(outside);
    const copy = path.join(outside, `${MIG}.sql`);
    writeFileSync(copy, SQL, "utf8");
    const res = spawnSync(process.execPath, [scriptPath, copy, "--confirm"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: okRoot2, SUPABASE_ACCESS_TOKEN: "" },
    });
    ok(res.status === 2, `an identical-content copy outside the checkout is refused (got ${res.status})`);
    ok(res.stderr.includes("it is not that file"),
      "the refusal says the passed file is not the approved artifact");
    ok(!res.stdout.includes("Transmitting"), "an out-of-tree copy never transmits");
    // Load-bearing pair: the repository file itself still applies, so the rule is
    // about identity and not about refusing everything.
    const realFile = path.join(okRoot2, "supabase", "migrations", `${MIG}.sql`);
    const viaRepo = spawnSync(process.execPath, [scriptPath, realFile], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: okRoot2, SUPABASE_ACCESS_TOKEN: "" },
    });
    ok(viaRepo.status === 0, `the repository file itself still passes (got ${viaRepo.status}: ${viaRepo.stderr})`);
    ok(viaRepo.stdout.includes("APPLY GATE PASSED"), "the repository file reaches and passes the gate");
  }

  // SOURCE PROVENANCE THROUGH THE FILE-BYTES DOOR. This script takes a PATH, and
  // the canonical-name rule above only constrains what the file is CALLED — so it
  // would read a parked or REJECTED draft out of scripts/.staging-migrations/ as
  // long as the filename looked right. The name is canonical and the proof matches
  // the bytes; only the location is wrong.
  {
    const parkedRoot = fixture({ migrationFile: null });
    const parkedDir = path.join(parkedRoot, "scripts", ".staging-migrations");
    mkdirSync(parkedDir, { recursive: true });
    const parkedFile = path.join(parkedDir, `${MIG}.sql`);
    writeFileSync(parkedFile, SQL, "utf8");
    const res = spawnSync(process.execPath, [scriptPath, parkedFile, "--confirm"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: parkedRoot, SUPABASE_ACCESS_TOKEN: "" },
    });
    ok(res.status === 2, `a parked migration file is refused (got ${res.status})`);
    ok(res.stderr.includes("NOT A PERMITTED MIGRATION SOURCE"),
      "the refusal names the source rule, not a proof or ordering problem");
    ok(!res.stdout.includes("Transmitting"), "a parked migration file never transmits");
    ok(!res.stdout.includes("APPLY GATE PASSED"), "a parked file does not reach the gate's pass message");

    // The same bytes under the same name, moved into the permitted directory,
    // apply normally — the rule is about location, and it must not be refusing
    // everything. This is the honest way to ship a parked migration.
    mkdirSync(path.join(parkedRoot, "supabase", "migrations"), { recursive: true });
    const permittedFile = path.join(parkedRoot, "supabase", "migrations", `${MIG}.sql`);
    writeFileSync(permittedFile, SQL, "utf8");
    const moved = spawnSync(process.execPath, [scriptPath, permittedFile], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: parkedRoot, SUPABASE_ACCESS_TOKEN: "" },
    });
    ok(moved.status === 0, `the same migration under supabase/migrations/ passes (got ${moved.status}: ${moved.stderr})`);
    ok(moved.stdout.includes("APPLY GATE PASSED"), "the moved migration reaches the gate and passes it");
  }
}

// ── SOURCE PROVENANCE ───────────────────────────────────────────────────────
// The gap CodeRabbit flagged on PR #525: every other check reasons about
// caller-supplied values, so nothing ever asked whether the SQL is a migration
// this repository actually holds. Parked/rejected SQL submitted under a
// canonical-looking name, with proofs minted against that same text, satisfied
// every binding — because the bindings all agreed with each other and none of
// them was anchored to disk.
//
// Attack cases are seeded from the pinned alias cases above, per the 2026-08-31
// bash-safety lesson: three hand-written parsers each opened a real bypass before
// an allowlist held, and each round's suite was green over the next round's hole.
{
  const PARKED_SQL = "CREATE OR REPLACE FUNCTION public.enforce_global_ledger_order() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;\n";
  const parkedHash = createHash("sha256").update(PARKED_SQL).digest("hex");
  // A perfect, self-consistent proof set for the parked body under a canonical
  // name. Nothing here is forged or malformed — that is the whole point.
  const parkedProof = {
    migration: MIG,
    timestamp: iso(0),
    reviewers: ["rls-security-reviewer", "migration-drift-reviewer"],
    findings: "clean",
    queryHash: parkedHash,
  };

  // THE HEADLINE CASE. The body is parked; the name is canonical; the proofs are
  // internally consistent. Before this rule every check passed.
  denies(
    evaluate(fixture({ migrationFile: null, proof: parkedProof }), { query: PARKED_SQL }),
    "MIGRATION SOURCE GUARD",
    "parked SQL under a canonical name with matching proofs is refused — the pre-existing PR #525 gap");
  denies(
    evaluate(fixture({ migrationFile: null, proof: parkedProof }), { query: PARKED_SQL }),
    "no such file exists in the permitted directory",
    "the refusal says the SQL is not a migration this repository holds");

  // Same, ARMED and fully proved — a complete hands-free evidence set must not
  // buy provenance. This is the state an unattended run would actually be in.
  denies(
    evaluate(fixture({
      migrationFile: null,
      autopilot: armed(),
      proof: parkedProof,
      codexProof: { ...goodCodex, queryHash: parkedHash },
    }), { query: PARKED_SQL }),
    "MIGRATION SOURCE GUARD",
    "an armed run with reviewer AND Codex proofs still cannot apply SQL that is not in the repository");

  // NAME/BODY DISAGREEMENT. The file exists under this name, but holds different
  // SQL — the apply is presenting one migration's identity with another's body.
  // Content binding would also refuse this; provenance refuses it earlier and says
  // why, and the two are independent.
  denies(
    evaluate(fixture({ proof: parkedProof }), { query: PARKED_SQL }),
    "its content is not the SQL being transmitted",
    "a real repository filename cannot lend its identity to a different body");

  // THE PARKED DIRECTORY IS NOT A SOURCE. Written where parked migrations really
  // live, under its real name, with a matching proof. scripts/.staging-migrations/
  // is never named by the rule — it fails because it is not the permitted
  // directory, which is what makes this an allowlist rather than a blocklist.
  {
    const parkedName = "20260827223000_enforce_global_migration_ledger_order";
    const root = fixture({
      migrationFile: null,
      proof: { ...parkedProof, migration: parkedName },
    });
    mkdirSync(path.join(root, "scripts", ".staging-migrations"), { recursive: true });
    writeFileSync(path.join(root, "scripts", ".staging-migrations", `${parkedName}.sql`), PARKED_SQL, "utf8");
    denies(
      evaluateMigrationApply({
        name: parkedName, query: PARKED_SQL, projectId: "rhyzpcqhnizqbxphqdkr",
        projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
      }),
      "MIGRATION SOURCE GUARD",
      "a migration parked in scripts/.staging-migrations/ cannot be applied from there");

    // And the suffix spellings a blocklist would have had to enumerate one at a
    // time. None of these is special-cased anywhere in the rule.
    for (const suffix of [".REJECTED", ".rejected", ".REJECTED.sql", ".bak", ".sql.REJECTED"]) {
      writeFileSync(path.join(root, "scripts", ".staging-migrations", `${parkedName}.sql${suffix}`), PARKED_SQL, "utf8");
      denies(
        evaluateMigrationApply({
          name: `${parkedName}.sql${suffix}`, query: PARKED_SQL, projectId: "rhyzpcqhnizqbxphqdkr",
          projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
        }),
        "MIGRATION SOURCE GUARD",
        `a "${suffix}" draft is refused without the rule ever naming that suffix`);
    }
  }

  // PATH TRAVERSAL through the caller-supplied name. normalizeMigName() reduces to
  // a basename, so the traversal cannot survive; asserted directly because the
  // 2026-08-31 lesson is that path text has unbounded ways to spell one location.
  {
    const root = fixture({ migrationFile: null, proof: parkedProof });
    mkdirSync(path.join(root, "scripts", ".staging-migrations"), { recursive: true });
    writeFileSync(path.join(root, "scripts", ".staging-migrations", "evil.sql"), PARKED_SQL, "utf8");
    for (const name of [
      "../scripts/.staging-migrations/evil",
      "../../scripts/.staging-migrations/evil",
      "..\\scripts\\.staging-migrations\\evil",
      "supabase/migrations/../../scripts/.staging-migrations/evil",
      "/etc/passwd",
      "..",
      ".",
      "",
    ]) {
      denies(
        evaluateMigrationApply({
          name, query: PARKED_SQL, projectId: "rhyzpcqhnizqbxphqdkr",
          projectDir: root, cwd: root, gitWorktreeList: noWorktrees,
        }),
        "MIGRATION SOURCE GUARD",
        `a name spelled ${JSON.stringify(name)} cannot reach outside the permitted directory`);
    }
  }

  // A SIBLING WORKTREE IS NOT A SOURCE — same scoping the proof lookup uses. A
  // file sitting in a different concurrent session's checkout is not this
  // session's reviewed work, and Mason runs dozens of worktrees at once.
  {
    const mine = fixture({ migrationFile: null });
    const sibling = mkdtempSync(path.join(os.tmpdir(), "crx-sibling-"));
    roots.push(sibling);
    mkdirSync(path.join(sibling, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(sibling, "supabase", "migrations", `${MIG}.sql`), SQL, "utf8");
    denies(
      evaluateMigrationApply({
        name: MIG, query: SQL, projectId: "rhyzpcqhnizqbxphqdkr",
        projectDir: mine, cwd: mine,
        gitWorktreeList: () => `worktree ${mine}\n\nworktree ${sibling}\n`,
      }),
      "MIGRATION SOURCE GUARD",
      "a migration file in a sibling worktree does not satisfy provenance for this session");
  }

  // THE SESSION'S OWN WORKTREE DOES satisfy it. The mirror of the case above, and
  // load-bearing: without it a rule that refused every worktree would pass every
  // deny case here and quietly break the way migrations are actually built.
  {
    const primary = fixture({ migrationFile: null });
    const linked = mkdtempSync(path.join(os.tmpdir(), "crx-linked-"));
    roots.push(linked);
    mkdirSync(path.join(linked, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(linked, "supabase", "migrations", `${MIG}.sql`), SQL, "utf8");
    allows(
      evaluateMigrationApply({
        name: MIG, query: SQL, projectId: "rhyzpcqhnizqbxphqdkr",
        projectDir: primary, cwd: linked,
        gitWorktreeList: () => `worktree ${primary}\n\nworktree ${linked}\n`,
      }),
      "a migration built in the worktree the session is working in satisfies provenance");
  }

  // CRLF ON DISK must not refuse a legitimate apply. A worktree checked out before
  // the .gitattributes eol=lf pin holds CRLF; write-apply-proofs.mjs and
  // apply-migration-file.mjs both normalize to LF, so the transmitted body is LF.
  allows(
    evaluate(fixture({ migrationFile: SQL.replace(/\n/g, "\r\n") })),
    "a CRLF working copy of the same migration still satisfies provenance");

  // …and normalizing line endings must not become a way to smuggle other changes.
  denies(
    evaluate(fixture({ migrationFile: SQL.replace(/\n/g, "\r\n") + "DROP TABLE public.customers;\n" })),
    "its content is not the SQL being transmitted",
    "CRLF tolerance does not extend to content that differs by more than line endings");

  // SYMLINK ESCAPE. A link planted at the permitted path would import content
  // from outside the permitted directory while looking like it lives inside it.
  // The changelog claimed this case was covered before it was — Codex caught the
  // overclaim on the exact-SHA review of f498c473, which is exactly the kind of
  // unearned confidence a guard's evidence must not carry.
  //
  // Windows needs Developer Mode or elevation to create a symlink, so a failure
  // to create one SKIPS rather than silently passing: a case that cannot run must
  // not be counted as a case that succeeded.
  {
    const root = fixture({ migrationFile: null });
    mkdirSync(path.join(root, "scripts", ".staging-migrations"), { recursive: true });
    const parked = path.join(root, "scripts", ".staging-migrations", `${MIG}.sql`);
    writeFileSync(parked, SQL, "utf8");
    mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
    const linkPath = path.join(root, "supabase", "migrations", `${MIG}.sql`);
    let linked = false;
    try { symlinkSync(parked, linkPath, "file"); linked = true; } catch { linked = false; }
    if (linked) {
      denies(evaluate(root), "MIGRATION SOURCE GUARD",
        "a symlink in the permitted directory pointing at parked SQL does not satisfy provenance");
      // Load-bearing pair: the SAME bytes as a REAL file in that directory are
      // allowed, so the refusal above is about the link escaping the directory
      // and not about the content being rejected for some other reason.
      rmSync(linkPath);
      writeFileSync(linkPath, SQL, "utf8");
      allows(evaluate(root), "the same bytes as a real file in the permitted directory are allowed");
    } else {
      console.log("  SKIP symlink-escape case — this platform/account cannot create symlinks");
    }
  }

  // REDIRECTED MIGRATIONS DIRECTORY — the hole Codex found (High, exact-SHA review
  // of 6be98280). The first version resolved the directory AND the file and asked
  // whether the file was inside the directory; make the DIRECTORY itself a
  // junction/symlink to somewhere else and both resolve outside together, so
  // containment holds and parked SQL is admitted. The boundary is now anchored at
  // the checkout ROOT instead.
  //
  // A Windows JUNCTION needs no elevation, unlike a file symlink, so unlike the
  // case above this one really executes on this machine.
  {
    const root = fixture({ migrationFile: null });
    const outside = mkdtempSync(path.join(os.tmpdir(), "crx-outside-"));
    roots.push(outside);
    writeFileSync(path.join(outside, `${MIG}.sql`), SQL, "utf8");
    mkdirSync(path.join(root, "supabase"), { recursive: true });
    const dirLink = path.join(root, "supabase", "migrations");
    let linked = false;
    try { symlinkSync(outside, dirLink, "junction"); linked = true; } catch { linked = false; }
    if (linked) {
      denies(evaluate(root), "MIGRATION SOURCE GUARD",
        "a migrations DIRECTORY redirected outside the checkout does not satisfy provenance");
      denies(evaluate(root), "resolves OUTSIDE the permitted directory",
        "the refusal names the redirection, not a missing file");
    } else {
      console.log("  SKIP redirected-directory case — this platform cannot create a junction");
    }
  }

  // THE VALIDATED LIST IS THE AUTHORIZED SET. resolveMigrationSource() must return
  // every file that passed root-anchor + direct-child + content, and NOTHING else —
  // callers must never re-derive candidates from `dirs`.
  //
  // Codex and CodeRabbit each found one direction of this on the same line: too
  // STRICT (the primary's copy shadowed the worktree's own valid file) and too LOOSE
  // (a re-derived candidate list admitted a root the resolver rejects as
  // escapes-dir). Both cases are asserted here, because fixing either direction
  // alone silently reopens the other.
  {
    // Two permitted checkouts, same migration name. The first holds the real file;
    // the second holds a link to an OUTSIDE file with identical bytes — the resolver
    // must return only the first.
    const primary = fixture({ migrationFile: SQL });
    const second = fixture({ migrationFile: null });
    mkdirSync(path.join(second, "supabase", "migrations"), { recursive: true });
    const outside = mkdtempSync(path.join(os.tmpdir(), "crx-ext-"));
    roots.push(outside);
    const external = path.join(outside, `${MIG}.sql`);
    writeFileSync(external, SQL, "utf8"); // IDENTICAL content — content binding cannot catch this
    const escapePath = path.join(second, "supabase", "migrations", `${MIG}.sql`);
    let linked = false;
    try { symlinkSync(external, escapePath, "file"); linked = true; } catch { linked = false; }

    const bothRoots = () => `worktree ${primary}\n\nworktree ${second}\n`;
    const res = resolveMigrationSource({
      name: MIG, query: SQL, projectDir: primary, cwd: second, gitWorktreeList: bothRoots,
    });
    ok(res.ok === true, "the real file in a permitted checkout still resolves");
    ok(Array.isArray(res.files), "resolveMigrationSource returns a validated file list");
    ok(res.files.every((f) => f !== escapePath),
      "the validated list never contains a path the resolver itself rejects as escapes-dir");
    if (linked) {
      ok(res.files.length === 1,
        `only the validated file is authorized (got ${res.files.length}: ${res.files.join(", ")})`);
    } else {
      console.log("  SKIP escape-link half of the validated-list case — cannot create a file symlink here");
    }
  }

  // The same invariant WITHOUT needing a symlink, so it actually runs on Windows:
  // a candidate that EXISTS at the permitted path but fails validation (here, on
  // content) must not appear in the authorized set. A caller that re-derived
  // candidates from `dirs` would authorize it; one that uses the validated list
  // cannot. This is the platform-independent guard on the loose direction, since the
  // escape-link half above skips without elevation.
  {
    const primary = fixture({ migrationFile: SQL });
    const second = fixture({ migrationFile: null });
    mkdirSync(path.join(second, "supabase", "migrations"), { recursive: true });
    const decoy = path.join(second, "supabase", "migrations", `${MIG}.sql`);
    writeFileSync(decoy, "SELECT 'not the reviewed migration';\n", "utf8");
    const bothRoots = () => `worktree ${primary}\n\nworktree ${second}\n`;
    const res = resolveMigrationSource({
      name: MIG, query: SQL, projectDir: primary, cwd: second, gitWorktreeList: bothRoots,
    });
    ok(res.ok === true, "the validated file still resolves when a decoy shares its name elsewhere");
    ok(res.files.length === 1 && res.files[0] !== decoy,
      `a same-named file that fails content validation is NOT authorized (got ${res.files.join(", ") || "none"})`);
  }

  // …and both permitted copies ARE authorized when both genuinely validate. This is
  // the too-strict direction Codex found: the primary's copy must not shadow the
  // session worktree's own identical file.
  {
    const primary = fixture({ migrationFile: SQL });
    const second = fixture({ migrationFile: SQL });
    const bothRoots = () => `worktree ${primary}\n\nworktree ${second}\n`;
    const res = resolveMigrationSource({
      name: MIG, query: SQL, projectDir: primary, cwd: second, gitWorktreeList: bothRoots,
    });
    ok(res.files.length === 2,
      `both validated copies are authorized, so neither checkout shadows the other (got ${res.files.length})`);
  }

  // …and the mirror that keeps the fix honest: a checkout reached THROUGH a
  // junction must still pass. Anchoring at the root is what absorbs that, and
  // without this case a rule that simply refused every resolved path would satisfy
  // the deny above while breaking the layout this machine actually uses.
  {
    const real = fixture({ migrationFile: SQL });
    const viaJunction = path.join(mkdtempSync(path.join(os.tmpdir(), "crx-jctparent-")), "checkout");
    roots.push(path.dirname(viaJunction));
    let linked = false;
    try { symlinkSync(real, viaJunction, "junction"); linked = true; } catch { linked = false; }
    if (linked) {
      allows(
        evaluateMigrationApply({
          name: MIG, query: SQL, projectId: "rhyzpcqhnizqbxphqdkr",
          projectDir: viaJunction, cwd: viaJunction, gitWorktreeList: noWorktrees,
        }),
        "a checkout reached through a junction still satisfies provenance");
    } else {
      console.log("  SKIP junctioned-checkout case — this platform cannot create a junction");
    }
  }

  // A DESCENDANT of the permitted directory is not "directly inside" it. Codex
  // (minor, review of a8efe218) found the containment check admitted a symlink whose
  // target sat in a SUBDIRECTORY while the comment claimed direct containment. Not a
  // bypass — the target stayed in the allowlisted tree and content binding held — but
  // the check now matches its own sentence. Uses a junction, so it runs on Windows.
  {
    const root = fixture({ migrationFile: null });
    mkdirSync(path.join(root, "supabase", "migrations", "nested"), { recursive: true });
    const nestedDir = path.join(root, "supabase", "migrations", "nested");
    writeFileSync(path.join(nestedDir, `${MIG}.sql`), SQL, "utf8");
    const linkPath = path.join(root, "supabase", "migrations", `${MIG}.sql`);
    let linked = false;
    try { symlinkSync(nestedDir, path.join(root, "supabase", "migrations", "lnk"), "junction"); linked = true; } catch { linked = false; }
    if (linked) {
      // Reach the nested file through the junction, so the resolved target is a
      // descendant of the permitted directory rather than a direct child.
      try { symlinkSync(path.join(root, "supabase", "migrations", "lnk", `${MIG}.sql`), linkPath, "file"); } catch { linked = false; }
    }
    if (linked && existsSync(linkPath)) {
      denies(evaluate(root), "MIGRATION SOURCE GUARD",
        "a link resolving to a DESCENDANT of the permitted directory is not 'directly inside' it");
    } else {
      console.log("  SKIP descendant-target case — this platform/account cannot create the link");
    }
  }

  // A DIRECTORY at the permitted path is not a file. Fails closed rather than
  // throwing out of the read.
  {
    const root = fixture({ migrationFile: null });
    mkdirSync(path.join(root, "supabase", "migrations", `${MIG}.sql`), { recursive: true });
    denies(evaluate(root), "MIGRATION SOURCE GUARD",
      "a directory sitting at the permitted path does not satisfy provenance");
  }

  // The resolver is exported and used by BOTH doors; assert its verdicts directly
  // so a future refactor cannot quietly change what the script and the hook share.
  {
    const root = fixture();
    const found = resolveMigrationSource({ name: MIG, query: SQL, projectDir: root, cwd: root, gitWorktreeList: noWorktrees });
    ok(found.ok === true, "resolveMigrationSource finds the repository migration");
    ok(found.file === path.join(root, "supabase", "migrations", `${MIG}.sql`),
      "resolveMigrationSource returns the permitted path it matched");
    const missing = resolveMigrationSource({ name: MIG, query: "SELECT 1;", projectDir: root, cwd: root, gitWorktreeList: noWorktrees });
    ok(missing.ok === false && missing.code === "content-differs",
      "resolveMigrationSource reports content-differs when the name exists but the content does not match");
  }
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
  notWrappable("COMMIT AND CHAIN;\n", "COMMIT", "COMMIT AND CHAIN is refused");
  notWrappable("COMMIT WORK AND NO CHAIN;\n", "COMMIT", "COMMIT WORK AND NO CHAIN is refused");
  notWrappable("ROLLBACK AND CHAIN;\n", "ROLLBACK", "ROLLBACK AND CHAIN is refused");
  notWrappable("ABORT TRANSACTION AND NO CHAIN;\n", "ROLLBACK", "ABORT transaction syntax is refused");
  notWrappable("END AND CHAIN;\n", "END", "END AND CHAIN is refused");
  notWrappable("END WORK AND NO CHAIN;\n", "END", "END WORK AND NO CHAIN is refused");
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
    "INSERT INTO public.audit (note) VALUES (E'escaped\\' quote; COMMIT is text');\nSELECT 1;\n",
    "an escape-string literal cannot desynchronize transaction-control scanning");
  notWrappable(
    "INSERT INTO public.audit (note) VALUES (E'escaped\\' quote');\nCOMMIT AND CHAIN;\n",
    "COMMIT",
    "a real COMMIT after an escape-string literal is still refused");
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
  ], { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: wRoot, SUPABASE_ACCESS_TOKEN: "" } });
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
    path.resolve(__scriptsDir, "apply-migration-file.mjs"),
    path.join(root, "supabase", "migrations", `${MIG}.sql`),
    "--confirm",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: root,
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

// ── name normalization: tolerate .sql and paths, never tolerate an alias ─────
// Substring matching used to absorb the ".sql vs no .sql" difference between what
// write-apply-proofs.mjs records and what an apply_migration call carries. Naive
// exact equality would have broken those legitimate applies, which is why the fix
// normalizes both sides instead of comparing raw strings.
ok(normalizeMigName("20260820120000_foo") === "20260820120000_foo", "bare name is unchanged");
ok(normalizeMigName("20260820120000_foo.sql") === "20260820120000_foo", "a .sql suffix is stripped");
ok(normalizeMigName("20260820120000_foo.SQL") === "20260820120000_foo", "the suffix strip is case-insensitive");
ok(normalizeMigName("supabase/migrations/20260820120000_foo.sql") === "20260820120000_foo", "a posix path is reduced to its stem");
ok(normalizeMigName("supabase" + String.fromCharCode(92) + "migrations" + String.fromCharCode(92) + "20260820120000_foo.sql")
  === "20260820120000_foo", "a windows path is reduced to its stem");
ok(normalizeMigName("  20260820120000_foo.sql  ") === "20260820120000_foo", "surrounding whitespace is ignored");
ok(normalizeMigName(null) === "", "null normalizes to empty, never throws");
ok(normalizeMigName(undefined) === "", "undefined normalizes to empty, never throws");
// The whole point: an alias differs in its STEM, so normalization cannot rescue it.
ok(normalizeMigName("99999999999999_alias_20260820120000_foo") !== normalizeMigName("20260820120000_foo"),
  "an aliased name never normalizes onto the migration it wraps");
ok(normalizeMigName("99999999999999_alias_20260210_fix_rls.sql") !== normalizeMigName("20260210_fix_rls"),
  "the legacy 8-digit alias shape never normalizes onto its target either");

// ── the widening is bounded and INTENTIONAL, and is pinned here ─────────────
// The first draft of this change claimed it could "only refuse, never permit".
// That was false: normalization ACCEPTS spelling variants that substring matching
// refused, because substring matching fails once the case differs. These cases are
// the widening. They are safe only because the proof must still be <30min old, carry
// clean findings, and match the transmitted SQL by queryHash — so a widened NAME
// match can never authorise different CONTENT. If anyone narrows normalizeMigName
// again, these go red and the changelog's claim must be revisited with them.
{
  const oldMatch = (mig, proof) => mig.includes(proof) || proof.includes(mig) || mig === proof;
  const widened = [
    ["20260820120000_foo.sql", "20260820120000_foo.SQL"],
    ["20260820120000_foo.sql", "supabase/migrations/20260820120000_foo"],
    ["20260820120000_foo.SQL", "20260820120000_foo.Sql"],
  ];
  for (const [mig, proof] of widened) {
    ok(!oldMatch(mig, proof), `substring matching REFUSED ${JSON.stringify(mig)} vs ${JSON.stringify(proof)}`);
    ok(normalizeMigName(mig) === normalizeMigName(proof),
      `normalization ACCEPTS it — a deliberate, bounded widening, not a fail-closed change`);
  }
}

for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } }
console.log(`migration-apply-lib: ${pass} assertions passed`);
