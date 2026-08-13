#!/usr/bin/env node
// Tests for the migration-apply-guard: the proof gate (existing behavior) and
// the 2026-07-13 hands-free destructive carve-out (Mason's settled policy —
// an ARMED autopilot run may apply reviewed migrations autonomously, but a
// migration containing apply-time data destruction NEVER applies hands-free).
// Run: node .claude/hooks/migration-apply-guard.test.mjs

import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { destructiveMigrationCheck } from "./live-testdata-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

// ── pure classifier: what counts as apply-time destruction ──────────────────
ok(destructiveMigrationCheck("DROP TABLE customers;").destructive, "DROP TABLE is destructive");
ok(destructiveMigrationCheck('drop table if exists "public"."old_orders";').destructive, "quoted/IF EXISTS DROP TABLE is destructive");
ok(destructiveMigrationCheck("ALTER TABLE invoices DROP COLUMN notes;").destructive, "DROP COLUMN is destructive");
ok(destructiveMigrationCheck("TRUNCATE inventory_transactions;").destructive, "TRUNCATE is destructive");
ok(destructiveMigrationCheck("DELETE FROM payments WHERE id = 1;").destructive, "DELETE FROM a financial table is destructive");
ok(destructiveMigrationCheck('DELETE FROM "public"."customers" WHERE id = 1;').destructive, "qualified DELETE FROM a business table is destructive");
eq(destructiveMigrationCheck("ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;").destructive, false, "DROP CONSTRAINT is routine, not destructive");
ok(destructiveMigrationCheck("ALTER TABLE invoices DROP legacy_amount_cents;").destructive, "COLUMN keyword is optional — ALTER TABLE ... DROP <col> is destructive (Codex R4)");
eq(destructiveMigrationCheck("ALTER TABLE invoices ALTER COLUMN notes DROP NOT NULL;").destructive, false, "ALTER COLUMN ... DROP NOT NULL is routine");
eq(destructiveMigrationCheck("ALTER TABLE invoices ALTER COLUMN notes DROP DEFAULT;").destructive, false, "ALTER COLUMN ... DROP DEFAULT is routine");
ok(destructiveMigrationCheck("DROP TYPE order_status CASCADE;").destructive, "DROP TYPE can cascade into data-bearing columns — destructive (Codex R4)");
ok(destructiveMigrationCheck("DROP DOMAIN money_amount CASCADE;").destructive, "DROP DOMAIN can cascade into data-bearing columns — destructive (Codex R4)");
eq(destructiveMigrationCheck("DROP POLICY p ON customers; DROP INDEX idx_x; DROP TRIGGER t ON jobs; DROP FUNCTION f();").destructive, false, "DROP POLICY/INDEX/TRIGGER/FUNCTION are not destructive");
eq(destructiveMigrationCheck("CREATE TABLE new_thing (id bigint); ALTER TABLE new_thing ENABLE ROW LEVEL SECURITY;").destructive, false, "ordinary additive migration is not destructive");
ok(destructiveMigrationCheck("DELETE FROM migration_scratch_map WHERE 1=1;").destructive, "ANY top-level DELETE is destructive — no table allowlist (Codex R2: hard-coded lists missed live tables)");
ok(destructiveMigrationCheck("DELETE FROM invoice_shares;").destructive, "DELETE FROM invoice_shares (was missed by the old table list) is destructive");
eq(
  destructiveMigrationCheck("CREATE OR REPLACE FUNCTION cleanup() RETURNS void AS $$ BEGIN DELETE FROM invoices WHERE is_active = false; END $$ LANGUAGE plpgsql;").destructive,
  false,
  "DELETE inside a CREATE FUNCTION body does not execute at apply time — not destructive"
);
ok(
  destructiveMigrationCheck("DO $$ BEGIN DELETE FROM invoices WHERE is_active = false; END $$;").destructive,
  "DELETE inside a DO block EXECUTES at apply time — destructive"
);
ok(
  destructiveMigrationCheck("DO /* cleanup */ $$ BEGIN DELETE FROM customers; END $$;").destructive,
  "block comment between DO and $$ cannot hide the executable body (Codex R4)"
);
ok(
  destructiveMigrationCheck("DO -- note\n$$ BEGIN DELETE FROM customers; END $$;").destructive,
  "line comment between DO and $$ cannot hide the executable body (Codex R4)"
);
ok(
  destructiveMigrationCheck("DO /* note */ LANGUAGE plpgsql $$ BEGIN DELETE FROM customers; END $$;").destructive,
  "comment between DO and LANGUAGE cannot hide the body — default-keep stripping (Codex R4)"
);
ok(destructiveMigrationCheck("DROP SCHEMA archive CASCADE;").destructive, "DROP SCHEMA is destructive (Codex R3)");
ok(destructiveMigrationCheck("MERGE INTO customers USING dup ON customers.id=dup.id WHEN MATCHED THEN DELETE;").destructive, "MERGE INTO is destructive (can delete matched rows)");
eq(destructiveMigrationCheck("-- never DROP TABLE by hand\nSELECT 1;").destructive, false, "line comment mentioning DROP TABLE is not destructive");
eq(destructiveMigrationCheck("/* TRUNCATE would be bad */ SELECT 1;").destructive, false, "block comment mentioning TRUNCATE is not destructive");
ok(
  destructiveMigrationCheck("SELECT '/*'; DELETE FROM customers; SELECT '*/';").destructive,
  "comment markers inside string literals cannot form a fake comment span that hides a DELETE (Codex R5)"
);
ok(
  destructiveMigrationCheck("SELECT '-- note', 1; DROP TABLE customers;").destructive,
  "a -- inside a string literal cannot line-comment away a DROP TABLE on the same line (Codex R5)"
);
ok(
  destructiveMigrationCheck("SELECT $x$/*$x$; DELETE FROM customers; SELECT $x$*/$x$;").destructive,
  "comment markers inside dollar-quoted literals cannot hide a DELETE either (Codex R5)"
);
eq(destructiveMigrationCheck("").destructive, false, "empty SQL is not destructive");

// ── live hook: proof gate + armed-run destructive carve-out ─────────────────
const HOOK = path.join(__dirname, "migration-apply-guard.mjs");
// Git exports GIT_DIR/GIT_INDEX_FILE to every hook it runs, and this suite runs
// inside pre-commit. Inheriting those redirects every fixture git command at the
// REAL repository: `git init` on an inherited GIT_DIR rewrites the shared config
// to `bare = true`, which breaks every worktree in the checkout until repaired.
// Strip the whole GIT_* namespace so fixtures only ever touch their own temp dir.
function hermeticEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  return env;
}
function runHook(payload, projectDir) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: projectDir,
    env: hermeticEnv({ CLAUDE_PROJECT_DIR: projectDir }),
  });
}
const isDeny = (r) => r.stdout.includes('"permissionDecision":"deny"');
const sha = (s) => createHash("sha256").update(s).digest("hex");

const BENIGN_SQL = "CREATE TABLE widgets (id bigint primary key); ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;";
const DESTRUCTIVE_SQL = "DROP TABLE customers;";
const MIG = "20990101000000_test_mig";

function writeProof(stateDir, query, extra = {}) {
  writeFileSync(path.join(stateDir, `migration-review-${MIG}.json`), JSON.stringify({
    migration: MIG,
    timestamp: new Date().toISOString(),
    reviewers: ["rls-security-reviewer", "migration-drift-reviewer"],
    findings: "clean",
    queryHash: sha(query),
    ...extra,
  }));
}
// The ordering preflight (2026-08-08) requires evidence of what the database
// has already applied, and treats missing/stale evidence as a BLOCK rather than
// a pass — a gitignored snapshot means a clean checkout would otherwise skip the
// check exactly when it matters (Codex P1, PR #348). Every fixture that expects
// to reach the proof gate must therefore supply a fresh snapshot first.
// `project` defaults to the fixture calls' own project_id ("x"): a snapshot is
// evidence about ONE database, and since round 10 the guard refuses one that
// does not say which (Codex High, PR #364).
function writeAppliedSnapshot(
  stateDir,
  { applied = ["20260808150400_round_money_to_whole_cents"], ageHours = 0, project = "x" } = {},
) {
  const snap = {
    captured_at: new Date(Date.now() - ageHours * 3600_000).toISOString(),
    count: applied.length,
    applied,
  };
  if (project !== null) snap.project_id = project;
  writeFileSync(path.join(stateDir, "applied-migrations.json"), JSON.stringify(snap));
}
// supabase/baselines/one-shot-migrations.json is tracked in git and ships
// beside the hook, so the hook fails CLOSED when it is missing — every fixture
// must therefore seed one, exactly as a real checkout has one.
function writeOneShotRegistry(projectDir, oneShot = {}) {
  const dir = path.join(projectDir, "supabase", "baselines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "one-shot-migrations.json"), JSON.stringify({ one_shot: oneShot }));
}
function armAutopilot(stateDir, hoursFromNow) {
  writeFileSync(path.join(stateDir, "AUTOPILOT.on"), JSON.stringify({
    expires: new Date(Date.now() + hoursFromNow * 3600_000).toISOString(),
  }));
}

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mig-apply-guard-"));
  const stateDir = path.join(tmp, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  writeOneShotRegistry(tmp);
  try {
    const call = (query) => ({ tool_name: "mcp__supabase__apply_migration", tool_input: { project_id: "x", name: MIG, query } });

    // 0. Ordering evidence is required BEFORE anything else is considered.
    //    Missing evidence must not be read as "ordering is fine".
    let r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "no applied-migration snapshot → apply denied");
    ok(r.stdout.includes("MIGRATION ORDERING GUARD"), "missing-snapshot deny names the ordering guard");
    // The recapture instructions must name the project THIS apply targets.
    // Reading it from the environment printed a literal placeholder in every
    // normal hook run, and a stray env value could aim the operator at another
    // project's ledger. (Codex P2, PR #354.)
    ok(
      r.stdout.includes("execute_sql on x"),
      "recapture instructions name the apply's own project_id",
    );
    ok(
      !r.stdout.includes("<your project ref>"),
      "recapture instructions never print a placeholder ref",
    );

    writeAppliedSnapshot(stateDir, { ageHours: 48 });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "stale (48h) snapshot → apply denied");
    ok(r.stdout.includes("MIGRATION ORDERING GUARD"), "stale-snapshot deny names the ordering guard");

    // Every remaining fail-closed branch. A regression in any of these opens the
    // guard silently, which is worse than it never having existed.
    writeAppliedSnapshot(stateDir, { applied: [] });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "empty snapshot → apply denied");

    writeFileSync(path.join(stateDir, "applied-migrations.json"), JSON.stringify({ applied: ["20260808150400_x"] }));
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "snapshot with no captured_at → apply denied");

    writeFileSync(path.join(stateDir, "applied-migrations.json"), "{not json");
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "unparseable snapshot → apply denied");

    // A ledger is evidence about the database it was read FROM. Production's
    // snapshot carried to a restored copy or a staging branch would otherwise
    // report one-shot money repairs as already applied against a database that
    // has never run them (Codex High, PR #364 round 10).
    writeAppliedSnapshot(stateDir, { project: null });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "snapshot with no project_id → apply denied");
    ok(
      r.stdout.includes("does not record"),
      "unbound-snapshot deny explains that the database is unnamed",
    );

    writeAppliedSnapshot(stateDir, { project: "some_other_project" });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "snapshot captured from a DIFFERENT project → apply denied");
    ok(
      r.stdout.includes("some_other_project") && /targets\s*\\?"x\\?"/.test(r.stdout),
      "cross-project deny names both the snapshot's project and the apply target",
    );

    // A bare array cannot carry the binding at all, so it is no longer evidence.
    writeFileSync(
      path.join(stateDir, "applied-migrations.json"),
      JSON.stringify(["20260808150400_round_money_to_whole_cents"]),
    );
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "bare-array snapshot (cannot name a project) → apply denied");

    // The subtle one: present, fresh, non-empty — but nothing is timestamped, so
    // no ordering verdict is possible. That must not read as a pass.
    writeAppliedSnapshot(stateDir, { applied: ["deactivation_revokes_auth_access", "initial_schema"] });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "fresh snapshot with no parseable timestamps → apply denied");
    ok(r.stdout.includes("MIGRATION ORDERING GUARD"), "timestamp-less snapshot deny names the ordering guard");

    // A fresh snapshot from here on: MIG is dated 20990101000000, so it is
    // newer than everything applied and the ordering check passes cleanly.
    writeAppliedSnapshot(stateDir);

    // 1. No proof → deny (existing behavior).
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "no proof file → apply denied");
    ok(r.stdout.includes("MIGRATION APPLY GUARD"), "deny message names the guard");

    // 2. Valid proof, unarmed, benign → allow.
    writeProof(stateDir, BENIGN_SQL);
    r = runHook(call(BENIGN_SQL), tmp);
    ok(!isDeny(r), "valid proof + benign migration → allowed");

    // 3. Proof whose queryHash doesn't match the transmitted SQL → deny.
    r = runHook(call(BENIGN_SQL + " -- edited after review"), tmp);
    ok(isDeny(r), "edited-after-review SQL (hash mismatch) → denied");

    // 3b. FUTURE-dated reviewer proof → deny (Codex R5 P2: a negative age
    //     must not count as fresh — it would stay "valid" for years).
    writeProof(stateDir, BENIGN_SQL, { timestamp: new Date(Date.now() + 3600_000).toISOString() });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "future-dated reviewer proof → denied");

    // 4. No flag file at all + destructive + valid proof → allowed (Mason is
    //    present; his in-chat OK is the gate — prose, the hook doesn't block).
    writeProof(stateDir, DESTRUCTIVE_SQL);
    r = runHook(call(DESTRUCTIVE_SQL), tmp);
    ok(!isDeny(r), "interactive session (no autopilot flag): destructive migration with proof is not hook-blocked");

    // 5. ARMED + destructive + valid proof → DENIED (the 2026-07-13 carve-out).
    armAutopilot(stateDir, 8);
    r = runHook(call(DESTRUCTIVE_SQL), tmp);
    ok(isDeny(r), "ARMED hands-free run: destructive migration denied even with clean proof");
    ok(/hands-free/i.test(r.stdout), "deny message says it's the hands-free rule");
    ok(/PARK/i.test(r.stdout), "deny message tells the loop to park it for Mason");

    // 6. ARMED + benign + reviewer proof but NO Codex proof file → DENIED
    //    (the second-model gate must prove it actually ran).
    writeProof(stateDir, BENIGN_SQL);
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: no Codex proof file → denied — the Codex gate is enforced");
    ok(/codex/i.test(r.stdout), "deny message names the Codex gate");

    // Helper: write the separate content-bound Codex proof (R4 mechanism).
    const codexProofPath = path.join(stateDir, `codex-review-mig-${MIG}.json`);
    const writeCodexProof = (query, overrides = {}) =>
      writeFileSync(codexProofPath, JSON.stringify({
        queryHash: sha(query),
        verdict: "clean",
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        timestamp: new Date().toISOString(),
        ...overrides,
      }));

    // 6b. Codex proof with a NEEDS-WORK verdict → DENIED (Codex R4 P1: a run
    //     that happened but did not pass must not unlock the apply).
    writeCodexProof(BENIGN_SQL, { verdict: "needs-work" });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: Codex proof with needs-work verdict is denied");

    // 6c. Codex proof bound to DIFFERENT SQL → DENIED (unrelated review must
    //     not satisfy the gate).
    writeCodexProof("SELECT 1;");
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: Codex proof whose queryHash doesn't match the transmitted SQL is denied");

    // 6d. STALE Codex proof (>30 min) → DENIED.
    writeCodexProof(BENIGN_SQL, { timestamp: new Date(Date.now() - 31 * 60_000).toISOString() });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: Codex proof older than 30 min is denied");

    // 6e. A clean proof from an unrecorded or weaker reviewer identity cannot
    //     satisfy the newly pinned Sol/high gate.
    writeCodexProof(BENIGN_SQL, { model: undefined, reasoning_effort: undefined });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: proof missing Sol/high identity is denied");
    writeCodexProof(BENIGN_SQL, { model: "gpt-5.6-terra", reasoning_effort: "xhigh" });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: non-Sol/non-high proof identity is denied");

    // 6f. Fresh, content-bound, clean Sol/high proof → allowed (the point of arming).
    writeCodexProof(BENIGN_SQL);
    r = runHook(call(BENIGN_SQL), tmp);
    ok(!isDeny(r), "ARMED run: reviewer proof + fresh content-bound clean Codex proof applies hands-free");

    // 6g. Reviewer proof lacking queryHash → DENIED even with a good Codex
    //     proof (hands-free applies must be content-bound end to end).
    writeFileSync(path.join(stateDir, `migration-review-${MIG}.json`), JSON.stringify({
      migration: MIG,
      timestamp: new Date().toISOString(),
      reviewers: ["rls-security-reviewer", "migration-drift-reviewer"],
      findings: "clean",
      // queryHash deliberately omitted
    }));
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: reviewer proof without queryHash is denied — content binding required");
    ok(/queryHash/i.test(r.stdout), "deny message names the missing queryHash");

    // 6h. Reviewer proof missing a required reviewer name → DENIED (Codex R5
    //     P1: a minimal hand-written proof with no reviewers array reached
    //     allow even though neither reviewer ran).
    writeProof(stateDir, BENIGN_SQL, { reviewers: ["rls-security-reviewer"] });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: reviewer proof missing migration-drift-reviewer is denied");
    ok(/migration-drift-reviewer/.test(r.stdout), "deny message names the missing reviewer");
    writeProof(stateDir, BENIGN_SQL, { reviewers: undefined });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: reviewer proof with NO reviewers array is denied");

    // 6i. FUTURE-dated Codex proof → DENIED (Codex R5 P2).
    writeProof(stateDir, BENIGN_SQL);
    writeCodexProof(BENIGN_SQL, { timestamp: new Date(Date.now() + 600_000).toISOString() });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "ARMED run: future-dated Codex proof is denied");
    writeCodexProof(BENIGN_SQL); // restore a good one so later sections start clean
    r = runHook(call(BENIGN_SQL), tmp);
    ok(!isDeny(r), "ARMED run: restored fresh proofs allow again (sanity)");

    // 7. EXPIRED arm flag + destructive + proof → STILL DENIED (Codex R2 P1:
    //    a run that outlives its arming window fails CLOSED — the flag file
    //    existing at all means hands-free context until explicitly disarmed).
    armAutopilot(stateDir, -1);
    writeProof(stateDir, DESTRUCTIVE_SQL, { codexVerdict: "clean" });
    r = runHook(call(DESTRUCTIVE_SQL), tmp);
    ok(isDeny(r), "EXPIRED autopilot flag: destructive apply still denied (fail closed)");

    // 7b. MALFORMED flag file → same fail-closed treatment.
    writeFileSync(path.join(stateDir, "AUTOPILOT.on"), "not json at all");
    r = runHook(call(DESTRUCTIVE_SQL), tmp);
    ok(isDeny(r), "malformed autopilot flag: destructive apply denied (fail closed)");

    // 7b2. STALE flag blocks BENIGN applies too, even with a fully-bound proof
    //      (Codex R3 P1: a lapsed authorization must not keep authorizing).
    writeProof(stateDir, BENIGN_SQL, { codexVerdict: "clean" });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "stale autopilot flag: even a benign, fully-proved migration is parked");
    ok(/LAPSED/i.test(r.stdout), "deny message says the authorization lapsed");

    // 7c. Explicit disarm (flag DELETED, as autopilot-arm.mjs --off does) →
    //     interactive rules return.
    rmSync(path.join(stateDir, "AUTOPILOT.on"));
    writeProof(stateDir, DESTRUCTIVE_SQL);
    r = runHook(call(DESTRUCTIVE_SQL), tmp);
    ok(!isDeny(r), "flag deleted by explicit disarm → interactive rules apply again");

    // 8. Non-apply_migration tool → instant allow, no interference.
    r = runHook({ tool_name: "mcp__supabase__execute_sql", tool_input: { query: "DROP TABLE customers;" } }, tmp);
    ok(!isDeny(r), "other tools pass through untouched");
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// ── proofs follow THIS SESSION's checkout, and only it (2026-07-29) ─────────
// The harness pins CLAUDE_PROJECT_DIR to the primary checkout even when the
// session works inside a linked worktree, while scripts/write-apply-proofs.mjs
// writes under process.cwd() — the worktree holding the migration. Before this,
// a migration built in a worktree could never be applied: every proof landed
// somewhere the guard did not look. Same root cause as pr-merge-guard (PR
// #252/#255).
//
// The merge guard's fix — scan EVERY sibling checkout — was tried here first and
// Codex blocked it: bound to exact head/base SHAs a sibling's merge proof is
// harmless, but an apply proof is weaker (interactive queryHash is optional,
// names match by substring), so any-worktree scanning would let one of Mason's
// dozens of concurrent sessions unlock a live apply another never reviewed. The
// lookup follows the session's reported cwd instead. Both halves are asserted:
// the session's OWN worktree counts, a SIBLING's does not.
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mig-apply-guard-wt-"));
  const primary = path.join(tmp, "primary");
  const linked = path.join(tmp, "linked");
  const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8", env: hermeticEnv() });
  try {
    mkdirSync(primary, { recursive: true });
    git(["init", "-q", "-b", "main"], primary);
    git(["config", "user.email", "test@example.com"], primary);
    git(["config", "user.name", "test"], primary);
    writeFileSync(path.join(primary, "seed.txt"), "seed\n");
    git(["add", "seed.txt"], primary);
    git(["commit", "-qm", "seed"], primary);
    const added = git(["worktree", "add", "-q", "-b", "wt", linked], primary);
    // Asserted, never skipped. An `if (added.status === 0)` guard here would let
    // the whole worktree regression disappear silently the day `git worktree add`
    // stops working, and the suite would still print green.
    ok(
      added.status === 0,
      `git worktree add succeeded (status=${added.status}): ${(added.stderr || "").trim()}`,
    );

    const linkedState = path.join(linked, ".claude", "session-state");
    mkdirSync(linkedState, { recursive: true });
    writeAppliedSnapshot(linkedState);
    // The ordering snapshot is read from CLAUDE_PROJECT_DIR, which the harness
    // pins to `primary` throughout this fixture even when the session's cwd is
    // the linked worktree. Seed it there too, or the ordering guard blocks
    // before the proof-scoping behaviour under test is ever reached.
    mkdirSync(path.join(primary, ".claude", "session-state"), { recursive: true });
    writeAppliedSnapshot(path.join(primary, ".claude", "session-state"));
    writeOneShotRegistry(primary);
    // Proof exists ONLY in the linked worktree; the primary has none.
    writeProof(linkedState, BENIGN_SQL);
    // CLAUDE_PROJECT_DIR stays pinned to `primary` in every call below — that is
    // what the real harness does. Only the session's reported cwd varies, which
    // is the whole behaviour under test.
    const callFrom = (cwd, query, name = MIG) =>
      // project_id must match the snapshot's project ("x", writeAppliedSnapshot's
      // default) or the ordering guard blocks on the database binding before the
      // proof-scoping behaviour under test is ever reached.
      ({ tool_name: "mcp__supabase__apply_migration", cwd, tool_input: { project_id: "x", name, query } });

    let r = runHook(callFrom(linked, BENIGN_SQL), primary);
    ok(!isDeny(r), "a proof minted in the worktree the session is working in satisfies the gate");

    // Codex's blocker on the first version of this fix. Same proof, same
    // migration, same 30-minute window — only the session's checkout differs.
    r = runHook(callFrom(primary, BENIGN_SQL), primary);
    ok(isDeny(r), "a concurrent sibling session's proof does NOT authorize an apply from another checkout");

    // A cwd outside the repo cannot manufacture a search directory; the guard
    // falls back to the primary alone, which holds no proof.
    r = runHook(callFrom(path.join(tmp, "not-a-checkout"), BENIGN_SQL), primary);
    ok(isDeny(r), "a cwd that is not a checkout of this repository is ignored, not trusted");

    // Mason's worktrees live INSIDE the primary checkout
    // (C:/CRX_Manager/.claude/worktrees/*), and `git worktree list` prints the
    // primary first — so resolving the cwd to the first checkout that contains
    // it would pick the primary and reproduce the original bug for exactly the
    // layout he actually uses. The most specific checkout has to win.
    const nested = path.join(primary, ".claude", "worktrees", "nested");
    const addedNested = git(["worktree", "add", "-q", "-b", "wt-nested", nested], primary);
    ok(addedNested.status === 0, `nested git worktree add succeeded (status=${addedNested.status}): ${(addedNested.stderr || "").trim()}`);
    const nestedState = path.join(nested, ".claude", "session-state");
    mkdirSync(nestedState, { recursive: true });
    writeAppliedSnapshot(nestedState);
    writeProof(nestedState, BENIGN_SQL);
    r = runHook(callFrom(nested, BENIGN_SQL), primary);
    ok(!isDeny(r), "a worktree nested inside the primary checkout resolves to itself, not to its parent");
    git(["worktree", "remove", "--force", nested], primary);

    r = runHook(callFrom(linked, BENIGN_SQL + " -- edited after review"), primary);
    ok(isDeny(r), "the session's own worktree proof does NOT excuse a queryHash mismatch — content binding survives");

    r = runHook(callFrom(linked, BENIGN_SQL, "20990101000001_other_mig"), primary);
    ok(isDeny(r), "the session's own worktree proof does NOT cover a different migration name");

    // AUTOPILOT.on is narrower still — pinned to the primary checkout even when
    // the session's proofs are read from its worktree. It is authorization state
    // for this project, not evidence about a migration. A malformed flag is the
    // loudest observable signal: it forces flagState "stale", which parks every
    // apply with a LAPSED message. Planted in the worktree it must change
    // nothing; planted in the primary it must block. The second half proves the
    // first is not passing vacuously.
    const primaryState = path.join(primary, ".claude", "session-state");
    mkdirSync(primaryState, { recursive: true });
    writeAppliedSnapshot(primaryState);
    writeFileSync(path.join(linkedState, "AUTOPILOT.on"), "not json at all");
    r = runHook(callFrom(linked, BENIGN_SQL), primary);
    ok(!isDeny(r), "a flag Mason never armed here, sitting in the session's worktree, does not change the rule-set");
    ok(!/LAPSED/i.test(r.stdout), "worktree AUTOPILOT.on is not read as this checkout's authorization state");

    writeFileSync(path.join(primaryState, "AUTOPILOT.on"), "not json at all");
    r = runHook(callFrom(linked, BENIGN_SQL), primary);
    ok(isDeny(r) && /LAPSED/i.test(r.stdout), "the same flag in the PRIMARY checkout still parks the apply");
    rmSync(path.join(primaryState, "AUTOPILOT.on"));

    git(["worktree", "remove", "--force", linked], primary);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// The ordering guard must not be escapable by RENAMING the candidate.
// `apply_migration`'s `name` is caller-controlled, and the ordering check
// abstains on a name it cannot timestamp. The guard used to convert an
// abstention into a block only when the name carried a 14-digit timestamp —
// exactly backwards, since the untimestamped case is the one the snapshot
// checks cannot catch. Stripping the timestamp therefore bought an
// unconditional pass for an out-of-order replay: the same class of hole that
// removed the prepayment actor guard. (Codex High, PR #354.)
//
// Full-hook, both directions: the timestamped replay must still be denied (so
// the fixture genuinely IS out of order), and the renamed one must be denied
// too (so the fix is what is doing the work).
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mig-apply-guard-rename-"));
  const stateDir = path.join(tmp, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  try {
    // Everything in the ledger is dated 2099, so any 2026-dated apply is a replay.
    writeAppliedSnapshot(stateDir, { applied: ["20990101000000_already_applied"] });

    const attempt = (name) => {
      // A full, valid, hash-matching review proof for this exact name — so the
      // ONLY thing that can stop the apply is the ordering guard.
      writeFileSync(path.join(stateDir, `migration-review-${name}.json`), JSON.stringify({
        migration: name,
        timestamp: new Date().toISOString(),
        reviewers: ["rls-security-reviewer", "migration-drift-reviewer"],
        findings: "clean",
        queryHash: sha(BENIGN_SQL),
      }));
      return runHook({
        tool_name: "mcp__supabase__apply_migration",
        tool_input: { project_id: "x", name, query: BENIGN_SQL },
      }, tmp);
    };

    let r = attempt("20260101000000_old_mig");
    ok(isDeny(r), "out-of-order migration under its real timestamped name → denied");
    ok(r.stdout.includes("MIGRATION ORDERING GUARD"), "the timestamped replay is denied BY the ordering guard");

    r = attempt("old_mig");
    ok(isDeny(r), "the same out-of-order SQL with the timestamp stripped from the name → still denied");
    ok(
      r.stdout.includes("MIGRATION ORDERING GUARD"),
      "the renamed replay is denied by the ordering guard, not incidentally by some other gate",
    );
    ok(
      /no 14-digit timestamp/.test(r.stdout),
      "the deny explains that an untimestamped, caller-supplied name cannot skip the ordering comparison",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// ── ONE-SHOT REPLAY GUARD (2026-08-10, Codex High round 8) ─────────────────
// A one-shot DATA migration authorizes itself against the live population that
// existed when it was written. Registering it in
// supabase/baselines/one-shot-migrations.json taught the replay PLANNER to
// withhold it — but the SQL file is still on disk, and an ordinary apply
// against a restored or drifted database still saw it. The containment was
// advisory; it is now enforced at the apply.
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mig-apply-guard-oneshot-"));
  const stateDir = path.join(tmp, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  const STEM = "20990601000000_backfill_fixture";
  const ONE_SHOT_SQL = "UPDATE public.orders SET total_profit = 1 WHERE id = 2;";
  const REASON = "fixture: population-bound money repair";
  const isOneShotDeny = (r) => r.stdout.includes("ONE-SHOT REPLAY GUARD");
  try {
    writeAppliedSnapshot(stateDir, { applied: ["20990101000000_already_applied"] });
    writeOneShotRegistry(tmp, { [STEM]: REASON });
    // A full, valid, hash-matching review proof, so nothing else can be what
    // stops the apply.
    const proofFor = (name, query) => writeFileSync(
      path.join(stateDir, `migration-review-${name}.json`),
      JSON.stringify({
        migration: name,
        timestamp: new Date().toISOString(),
        reviewers: ["rls-security-reviewer", "migration-drift-reviewer"],
        findings: "clean",
        queryHash: sha(query),
      }),
    );
    const apply = (name, query) => {
      proofFor(name, query);
      return runHook({
        tool_name: "mcp__supabase__apply_migration",
        tool_input: { project_id: "x", name, query },
      }, tmp);
    };

    // 1. Registered, and the ledger does not have it → refused.
    let r = apply(STEM, ONE_SHOT_SQL);
    ok(isDeny(r), "registered one-shot missing from the ledger → apply denied");
    ok(isOneShotDeny(r), "the deny is the one-shot replay guard, not an incidental gate");
    ok(r.stdout.includes(REASON), "the deny quotes why the migration is registered");

    // 2. An unregistered migration is untouched by this guard.
    r = apply("20990601000001_ordinary_schema_change", BENIGN_SQL);
    ok(!isOneShotDeny(r), "an unregistered migration is not caught by the one-shot guard");

    // 3. The MCP `name` is caller-controlled, so renaming it must not be an
    //    escape hatch — the SQL body is checked against the registered file.
    mkdirSync(path.join(tmp, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(tmp, "supabase", "migrations", `${STEM}.sql`), `-- header\n${ONE_SHOT_SQL}\n`);
    r = apply("20990601000002_totally_innocent_name", ONE_SHOT_SQL);
    ok(isDeny(r), "the same one-shot body under a different name → apply denied");
    ok(isOneShotDeny(r), "the body match, not the name, is what catches the renamed replay");

    // 3b. ROUND 20 (Codex High). The body match normalized comments away with a
    //     regex that only understood `--` line comments. A `/* */` block comment
    //     survived normalization on ONE side of the comparison, so both
    //     containment tests went false and the renamed replay sailed through.
    //     A single inserted comment defeated the whole control, which is why the
    //     normalizer is now a scanner rather than a pattern.
    const COMMENTED_ONE_SHOT =
      "UPDATE public.orders /* harmless */ SET total_profit = 1 WHERE id = 2;";
    r = apply("20990601000003_comment_disguised", COMMENTED_ONE_SHOT);
    ok(isDeny(r), "round-20: a block comment inserted into the one-shot body → still denied");
    ok(isOneShotDeny(r), "round-20: comments are stripped by a scanner, so the disguise does not break the body match");

    // 3c. …and the same is true one step further out. Whole-body containment
    //     only holds while one side is a substring of the other. A real repair
    //     is several statements; carry over just its money write, wrap that in
    //     different ones, and neither string contains the other. The write
    //     statements are now compared individually, so the money write is caught
    //     no matter what is packed around it.
    writeFileSync(
      path.join(tmp, "supabase", "migrations", `${STEM}.sql`),
      `CREATE TEMP TABLE approved_ids (id int);\n${ONE_SHOT_SQL}\nDROP TABLE approved_ids;\n`,
    );
    const PADDED_ONE_SHOT =
      "CREATE TABLE IF NOT EXISTS public.scratch_note (id int);\n" +
      `${ONE_SHOT_SQL}\n` +
      "ANALYZE public.orders;";
    r = apply("20990601000004_padded_replay", PADDED_ONE_SHOT);
    ok(isDeny(r), "round-20: the one-shot write padded with extra statements → still denied");
    ok(isOneShotDeny(r), "round-20: the write statement itself is matched, not just the whole body");

    // …and the padding trick must not turn the guard into a blunt instrument:
    // an ordinary migration that merely mentions the same table is untouched.
    r = apply("20990601000005_unrelated_index", "CREATE INDEX IF NOT EXISTS idx_orders_scratch ON public.orders (id);");
    ok(!isOneShotDeny(r), "round-20: an unrelated statement against the same table is not a replay");

    // 3d. ROUND 22 (Codex High). Rounds 20-21 compared collapsed whitespace with
    //     comments removed, which still left three spellings that change no rows
    //     and break every comparison. Each one below rewrites the registered
    //     money repair into text PostgreSQL treats as identical, under a fresh
    //     caller-controlled name — so before this round each walked past the
    //     one-shot override the same way the block comment did in round 20.
    r = apply("20990601000006_only_replay", "UPDATE ONLY public.orders SET total_profit = 1 WHERE id = 2;");
    ok(isDeny(r) && isOneShotDeny(r), "round-22: ONLY inserted before the target → still denied");

    r = apply("20990601000007_aliased_replay", "UPDATE public.orders o SET total_profit = 1 WHERE o.id = 2;");
    ok(isDeny(r) && isOneShotDeny(r), "round-22: a table alias on the target and its column → still denied");

    r = apply("20990601000008_as_aliased_replay", "UPDATE public.orders AS o SET total_profit = 1 WHERE o.id = 2;");
    ok(isDeny(r) && isOneShotDeny(r), "round-22: the same alias spelled with AS → still denied");

    r = apply(
      "20990601000009_cte_replay",
      "WITH approved AS (SELECT 2 AS id) UPDATE public.orders SET total_profit = 1 WHERE id = 2;",
    );
    ok(isDeny(r) && isOneShotDeny(r), "round-22: the money write wrapped behind a leading CTE → still denied");

    // …and all three normalizations together, which is what an author actually
    // reaching for the bypass would submit.
    r = apply(
      "20990601000010_combined_replay",
      "WITH approved AS (SELECT 2 AS id) UPDATE ONLY public.orders AS o SET total_profit = 1 WHERE o.id = 2;",
    );
    ok(isDeny(r) && isOneShotDeny(r), "round-22: CTE + ONLY + alias combined → still denied");

    // REVERSED IN ROUND 23, DELIBERATELY. This assertion used to read
    // `ok(!isOneShotDeny(r), ...)`, on the reasoning that a write to the same
    // column on a DIFFERENT population is a different repair, and that refusing
    // it "would put an override prompt in front of every future migration that
    // touches orders.total_profit."
    //
    // The row-set binding is exactly what round 23 broke: `WHERE id = ANY(...)`
    // is text, and `SET total_price = (total_price)` under a fresh name walked
    // through every text check while writing the same rows. Distinguishing
    // repairs by their WHERE clause is the same losing race one level down.
    //
    // The friction argument was also measured and does not hold. 29 migrations
    // in this repository write order_items.total_price, but almost all do it
    // inside a CREATE FUNCTION body, which writes nothing when the migration
    // applies. Counting only apply-time writes, ZERO of the 881 non-registered
    // migrations overlap the registered repair's targets. So the guard now
    // refuses on the write target regardless of population, the operator
    // records a digest-bound override for a genuinely different repair, and the
    // measured cost of that across the repo's entire history is nothing.
    r = apply("20990601000011_different_population", "UPDATE public.orders SET total_profit = 1 WHERE id = 999;");
    ok(isDeny(r) && isOneShotDeny(r),
      "round-23: the same apply-time write target is a replay even on a different row set");

    // 3e. …and the CTE matters in the other direction, which is the one that was
    //     actually open. Wrapping the SUBMITTED write in a CTE never evaded
    //     anything — the registered write is still a substring of it. But when
    //     the REGISTERED FILE carries the CTE, its statement no longer starts
    //     with a write verb, so it was dropped from the comparison set entirely
    //     and padding on both sides defeated whole-body containment too. The
    //     write verb is now found at paren depth zero instead of assumed first.
    writeFileSync(
      path.join(tmp, "supabase", "migrations", `${STEM}.sql`),
      "CREATE TEMP TABLE approved_ids (id int);\n" +
        "WITH approved AS (SELECT 2 AS id) UPDATE public.orders SET total_profit = 1 WHERE id = 2;\n" +
        "DROP TABLE approved_ids;\n",
    );
    r = apply(
      "20990601000012_cte_registered_file",
      "CREATE TABLE IF NOT EXISTS public.scratch_note2 (id int);\n" +
        "UPDATE public.orders SET total_profit = 1 WHERE id = 2;\n" +
        "ANALYZE public.orders;",
    );
    ok(
      isDeny(r) && isOneShotDeny(r),
      "round-22: a registered write wrapped in a CTE is still matched when it is replayed bare",
    );

    // Put the fixture back so the cases below see the file they were written
    // against rather than this one.
    writeFileSync(
      path.join(tmp, "supabase", "migrations", `${STEM}.sql`),
      `CREATE TEMP TABLE approved_ids (id int);\n${ONE_SHOT_SQL}\nDROP TABLE approved_ids;\n`,
    );

    // 3f. ROUND 23 (Codex High). The three checks above compare TEXT, and the
    //     set of texts performing one write is infinite, so each round found
    //     another spelling. The reported break was a single pair of
    //     parentheses: `SET total_profit = (total_profit)` under a fresh name.
    //     Normalizing parentheses would have invited round 24, so the guard now
    //     also compares what the SQL WRITES when it applies — every case below
    //     changes the text and none of them change the write.
    let labelIdx = 0;
    for (const [label, sql] of [
      ["parenthesized self-assignment (the reported break)",
        "UPDATE public.orders SET total_profit = (total_profit) WHERE id = 2;"],
      ["doubled parentheses",
        "UPDATE public.orders SET total_profit = ((total_profit)) WHERE id = 2;"],
      ["a redundant cast on the value",
        "UPDATE public.orders SET total_profit = total_profit::numeric WHERE id = 2;"],
      ["quoted identifiers",
        'UPDATE public."orders" SET "total_profit" = 1 WHERE id = 2;'],
      ["a comment wedged inside the SET clause",
        "UPDATE public.orders SET /* nothing to see */ total_profit = 1 WHERE id = 2;"],
      ["the write buried in a DO block",
        "DO $$ BEGIN UPDATE public.orders SET total_profit = 1 WHERE id = 2; END $$;"],
      ["an upsert reaching the column through ON CONFLICT",
        "INSERT INTO public.orders (id) VALUES (2) ON CONFLICT (id) DO UPDATE SET total_profit = 1;"],
      ["the tuple form of SET",
        "UPDATE public.orders SET (total_profit) = ROW(1) WHERE id = 2;"],
      ["a whole-row delete, which takes the column with it",
        "DELETE FROM public.orders WHERE id = 2;"],
      ["dynamic SQL naming the table in a literal",
        "DO $$ BEGIN EXECUTE 'UPDATE public.orders SET total_profit = 1'; END $$;"],
      ["dynamic SQL choosing the table at runtime",
        "DO $$ BEGIN EXECUTE format('UPDATE %I SET total_profit = 1', v_t); END $$;"],
    ]) {
      r = apply(`20990601${String(20 + labelIdx++).padStart(6, "0")}_r23`, sql);
      ok(isDeny(r) && isOneShotDeny(r), `round-23: ${label} → still denied`);
    }

    // The semantic layer must stay a scalpel. A migration that DEFINES a
    // routine writing the same column writes nothing when it applies — 29
    // migrations here do exactly that — and counting them would put an override
    // prompt in front of nearly every RPC change, which is how a guard gets
    // switched off.
    //
    // The body below writes the registered COLUMN but is not the registered
    // STATEMENT, so the text layers have nothing to match and this case tests
    // the semantic layer on its own. (A routine body that did quote the
    // registered statement verbatim is still refused by the round-20 shared-
    // statement check, which cannot tell a routine body from a DO body — that
    // is pre-existing behavior and deliberately not relaxed here.)
    r = apply(
      "20990601000040_defines_a_writer",
      "CREATE OR REPLACE FUNCTION public.recalc(p_id bigint) RETURNS void LANGUAGE plpgsql AS $$\n" +
        "BEGIN UPDATE public.orders SET total_profit = compute_profit(p_id) WHERE id = p_id; END;\n$$;",
    );
    ok(!isOneShotDeny(r), "round-23: defining a function that writes the column is not an apply-time replay");

    r = apply("20990601000041_grants", "GRANT UPDATE ON public.orders TO authenticated;");
    ok(!isOneShotDeny(r), "round-23: granting UPDATE on the table is not a write");

    r = apply(
      "20990601000042_trigger",
      "CREATE TRIGGER t AFTER UPDATE OF total_profit ON public.orders FOR EACH ROW EXECUTE FUNCTION f();",
    );
    ok(!isOneShotDeny(r), "round-23: a trigger definition naming the column is not a write");

    // REVERSED IN ROUND 27, DELIBERATELY. This read `ok(!isOneShotDeny(r), ...)`
    // — "a different column of the same table is not the registered repair" —
    // and round 27 proved that sentence false wherever a trigger recomputes one
    // money column from its siblings, which is the exact shape this guard exists
    // to contain. See the round-27 block below for the live proof.
    r = apply("20990601000043_other_column", "UPDATE public.orders SET status = 'x' WHERE id = 2;");
    ok(isDeny(r) && isOneShotDeny(r),
      "round-27: any write to a table the registered repair wrote is a replay candidate — a trigger can carry it");

    r = apply("20990601000044_other_table", "UPDATE public.invoices SET total_profit = 1 WHERE id = 2;");
    ok(!isOneShotDeny(r), "round-23: the same column name on a different table is not the registered repair");

    // ROUND 24 (Codex High). Round 23 made "defining a routine writes nothing"
    // load-bearing, and that is exactly the sentence to attack: define the
    // repair in a helper, run the helper, drop it. The file contains no
    // apply-time UPDATE, every text layer sees nothing, and the column is
    // rewritten anyway. A body is deferred only until something calls it.
    {
      const REPAIR = "UPDATE public.orders SET total_profit = 111 WHERE id = ANY(ARRAY[1,2]);";
      const CALLED = [
        ["a helper defined and SELECTed",
         `CREATE FUNCTION public.tmp_fix() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${REPAIR} END; $$;\n` +
         "SELECT public.tmp_fix();\nDROP FUNCTION public.tmp_fix();"],
        ["a procedure defined and CALLed",
         `CREATE PROCEDURE public.tmp_fix() LANGUAGE plpgsql AS $$ BEGIN ${REPAIR} END; $$;\nCALL public.tmp_fix();`],
        ["a helper PERFORMed from a DO block",
         `CREATE FUNCTION public.h() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${REPAIR} END; $$;\n` +
         "DO $$ BEGIN PERFORM public.h(); END $$;"],
        ["a helper that calls another helper",
         `CREATE FUNCTION public.i() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${REPAIR} END; $$;\n` +
         "CREATE FUNCTION public.o() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM public.i(); END; $$;\n" +
         "SELECT public.o();"],
        ["a routine this migration never defines",
         "CALL public.repair_all_the_profit();"],
      ];
      let idx = 0;
      for (const [label, sql] of CALLED) {
        r = apply(`20990601${String(50 + idx++).padStart(6, "0")}_r24`, sql);
        ok(isDeny(r) && isOneShotDeny(r), `round-24: ${label} → denied`);
      }
    }

    // …while the ordinary shape stays free. Every RPC migration in this
    // repository defines a routine and grants EXECUTE on it; charging those for
    // their bodies would demand an override on nearly all of them, and a guard
    // that fires constantly is a guard someone turns off.
    r = apply(
      "20990601000060_define_and_grant",
      "CREATE OR REPLACE FUNCTION public.recalc(p_id bigint) RETURNS void LANGUAGE plpgsql AS $$\n" +
        "BEGIN UPDATE public.orders SET total_profit = compute_profit(p_id) WHERE id = p_id; END;\n$$;\n" +
        "GRANT EXECUTE ON FUNCTION public.recalc(bigint) TO authenticated;",
    );
    ok(!isOneShotDeny(r), "round-24: defining a routine and granting EXECUTE is not running it");

    r = apply(
      "20990601000061_drop_and_redefine",
      "DROP FUNCTION IF EXISTS public.recalc(bigint);\n" +
        "CREATE FUNCTION public.recalc(p_id bigint) RETURNS void LANGUAGE plpgsql AS $$\n" +
        "BEGIN UPDATE public.orders SET total_profit = compute_profit(p_id) WHERE id = p_id; END;\n$$;",
    );
    ok(!isOneShotDeny(r), "round-24: drop-and-redefine names the routine without calling it");

    // ROUND 25 (Codex High, two findings). Every round so far found one more
    // spelling of a write that the reader scored as zero writes, so this round
    // fixes the six it named AND changes the default: a write verb the reader
    // cannot pin to a table now refuses instead of passing silently. These run
    // end to end through the guard, not against the parser, because that is
    // where a regression would actually bite.
    {
      let idx = 0;
      for (const [label, sql] of [
        // Finding 1 — the statement is assembled from fragments, so no single
        // literal contains both the verb and the table.
        ["dynamic SQL concatenated from two literals",
         "DO $$ BEGIN EXECUTE 'UPDATE ' || 'public.orders SET total_profit = 1'; END $$;"],
        ["dynamic SQL built into a variable first",
         "DO $$ DECLARE v text := 'UPDATE public.orders SET total_profit = 1';\n" +
         "BEGIN EXECUTE v; END $$;"],
        ["dynamic SQL returned by a function call",
         "DO $$ BEGIN EXECUTE public.build_repair_sql(); END $$;"],
        // Finding 2a — a harmless overload shadowing a mutating one.
        ["a harmless overload hiding a mutating one of the same name",
         "CREATE FUNCTION public.helper() RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;\n" +
         "CREATE FUNCTION public.helper(p int) RETURNS void LANGUAGE plpgsql AS $$\n" +
         "BEGIN UPDATE public.orders SET total_profit = 9 WHERE id = p; END; $$;\n" +
         "SELECT public.helper(1);"],
        ["the same shadowing with the mutating overload declared first",
         "CREATE FUNCTION public.helper(p int) RETURNS void LANGUAGE plpgsql AS $$\n" +
         "BEGIN UPDATE public.orders SET total_profit = 9 WHERE id = p; END; $$;\n" +
         "CREATE FUNCTION public.helper() RETURNS void LANGUAGE sql AS $$ SELECT 1; $$;\n" +
         "SELECT public.helper();"],
        // Finding 2b — SELECT runs a routine exactly as CALL does.
        ["a pre-existing routine invoked with SELECT rather than CALL",
         "SELECT public.repair_all_the_profit();"],
        ["a pre-existing routine invoked from the FROM clause",
         "SELECT * FROM public.repair_all_the_profit();"],
        ["a pre-existing routine invoked from inside a defined helper",
         "CREATE FUNCTION public.w() RETURNS void LANGUAGE plpgsql AS $$\n" +
         "BEGIN PERFORM public.repair_all_the_profit(); END; $$;\nSELECT public.w();"],
        // TRUNCATE — absent from the write-verb set entirely until this round.
        ["TRUNCATE, which empties every column at once",
         "TRUNCATE TABLE public.orders;"],
        ["TRUNCATE reaching the table from the second position of a list",
         "TRUNCATE TABLE public.scratch_pad, public.orders RESTART IDENTITY CASCADE;"],
        // A column type change rewrites values without any write verb.
        ["a column type change rewriting the values through USING",
         "ALTER TABLE public.orders ALTER COLUMN total_profit TYPE numeric USING round(total_profit);"],
        // The new default: a write shape the reader cannot resolve.
        ["a write verb whose relation the reader cannot read",
         "DO $$ BEGIN UPDATE (public.orders) SET total_profit = 1; END $$;"],
      ]) {
        r = apply(`20990601${String(70 + idx++).padStart(6, "0")}_r25`, sql);
        ok(isDeny(r) && isOneShotDeny(r), `round-25: ${label} → denied`);
      }
    }

    let idx2 = 0;
    // …and the shapes that must stay free. The first two are not hypothetical:
    // a REVOKE TRUNCATE over 114 relations is queued in this repository, and
    // reading its relation list as a truncation would have refused it.
    for (const [label, sql] of [
      ["revoking the TRUNCATE privilege is not a truncation",
       "REVOKE TRUNCATE ON public.orders FROM authenticated;"],
      ["granting TRUNCATE over a list is not a truncation",
       "GRANT TRUNCATE ON public.scratch_pad, public.orders TO service_role;"],
      ["SELECT ... FOR UPDATE is a row lock, not a write",
       "SELECT id FROM public.orders WHERE id = 2 FOR UPDATE;"],
      ["a trigger fired BEFORE INSERT OR UPDATE is a definition, not a write",
       "CREATE TRIGGER t2 BEFORE INSERT OR UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION f();"],
      ["adding a column does not rewrite the existing ones",
       "ALTER TABLE public.orders ADD COLUMN note text;"],
      ["reading the table with built-in functions is not a call to an unknown routine",
       "SELECT count(*), md5(string_agg(id::text, ',')) FROM public.orders;"],
      ["a set-returning function's column alias is not a routine call",
       "SELECT * FROM unnest(ARRAY[1,2]) AS ta(n);"],
    ]) {
      r = apply(`20990601${String(90 + (idx2 += 1)).padStart(6, "0")}_r25ok`, sql);
      ok(!isOneShotDeny(r), `round-25: ${label} → not a replay`);
    }

    // ROUND 26 (Codex High). Round 25 treated `format(...)` as a readable
    // operand, on the reasoning that its placeholders were handled. They were
    // handled only where a placeholder names the RELATION, after a write verb
    // the scanner had already recognised in the literal. A placeholder can just
    // as easily split the verb itself, and then the literal contains no write
    // verb at all — so the reader produced neither a target nor `unresolved`,
    // and round 25's whole inversion never fired. `format` is now unreadable in
    // every shape, which costs the column-level precision of a constant format
    // string and keeps the refusal.
    {
      let idx = 0;
      for (const [label, sql] of [
        ["a placeholder splitting the write verb in half",
         "DO $$ BEGIN EXECUTE format('UP%sATE public.orders SET total_profit = 0', 'D'); END $$;"],
        ["a placeholder standing in for the verb entirely",
         "DO $$ BEGIN EXECUTE format('%s public.orders SET total_profit = 0', 'UPDATE'); END $$;"],
        ["a placeholder standing in for the table name",
         "DO $$ BEGIN EXECUTE format('UPDATE public.%I SET total_profit = 0', 'orders'); END $$;"],
        ["a placeholder splitting the schema-qualified identifier",
         "DO $$ BEGIN EXECUTE format('UPDATE pub%sic.orders SET total_profit = 0', 'l'); END $$;"],
        ["concatenation inside the format string, splitting the verb",
         "DO $$ BEGIN EXECUTE FORMAT('UPD' || '%sTE public.orders SET total_profit = 0', 'A'); END $$;"],
        ["a constant format string, which is now unresolved rather than precise",
         "DO $$ BEGIN EXECUTE format('UPDATE public.orders SET total_profit = 0'); END $$;"],
        ["the same split verb reached through a defined helper body",
         "CREATE FUNCTION public.r26() RETURNS void LANGUAGE plpgsql AS $$\n" +
         "BEGIN EXECUTE format('UP%sATE public.orders SET total_profit = 0', 'D'); END; $$;\n" +
         "SELECT public.r26();"],
      ]) {
        r = apply(`20990601${String(120 + idx++).padStart(6, "0")}_r26`, sql);
        ok(isDeny(r) && isOneShotDeny(r), `round-26: ${label} → denied`);
      }
    }

    let idx3 = 0;
    for (const [label, sql] of [
      // A plain string literal is still readable — narrowing the rule to
      // `format` must not turn every EXECUTE into a refusal.
      ["a plain literal EXECUTE that only reads is still read, not refused",
       "DO $$ BEGIN EXECUTE 'SELECT count(*) FROM public.orders'; END $$;"],
      // Making `format` unreadable must not make it guilty everywhere. Outside
      // an EXECUTE operand it is an ordinary value expression and stays silent.
      ["format used to build an identifier, with no statement in it at all",
       "SELECT format('%I_%s', 'orders', 'backup') AS proposed_name;"],
    ]) {
      r = apply(`20990601${String(140 + (idx3 += 1)).padStart(6, "0")}_r26ok`, sql);
      ok(!isOneShotDeny(r), `round-26: ${label} → not a replay`);
    }

    // The price of the narrowing, stated rather than hidden: an EXECUTE whose
    // operand is a format call now reaches the override prompt even when the
    // statement it assembles only reads. The reader cannot tell the two apart
    // without evaluating the placeholders, and round 25 settled which way it
    // guesses. This test exists so that cost cannot be paid by accident — if a
    // later round makes reads precise again, it must delete this line
    // deliberately, and prove the split-verb attacks above still deny.
    r = apply("20990601150000_r26cost",
      "DO $$ DECLARE c text := 'total_profit';\n" +
      "BEGIN EXECUTE format('SELECT %I FROM public.orders', c); END $$;");
    ok(isOneShotDeny(r), "round-26: even a format-assembled READ asks for an override — the accepted cost");

    // And the registered repair itself must still read exactly as it did — the
    // inversion is worthless if it refuses the one migration it exists to guard.
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isOneShotDeny(r), "round-26: the registered one-shot is still recognised as itself");

    // ROUND 27 (Codex High). Every round up to here compared `(table, column)`
    // pairs, and Codex broke that with the database rather than with the parser:
    // the real registered repair, `20260810025159_backfill_stale_line_profit`,
    // writes `order_items.total_price`, and the canonical profit trigger is
    // scoped `BEFORE INSERT OR UPDATE OF total_price, profit, cost_per_unit,
    // total_units_needed`. So `SET profit = profit` re-fires the identical money
    // correction that `SET total_price = total_price` did, while sharing no
    // column with the registration. Its read-only probe returned `overlaps: []`,
    // `unresolved: false` — straight through.
    //
    // The fix is table-level comparison, not a longer column list: a column list
    // would have to name every trigger-watched column of every registered table
    // and stay correct as triggers change, and a silently stale list there is a
    // replayed money repair.
    //
    // These use the REAL registered file shape, with each trigger-watched column
    // substituted for the registered one.
    {
      const REAL_STEM = "20260810025159_backfill_stale_line_profit";
      const REAL_WRITE = "UPDATE public.order_items SET total_price = total_price WHERE id = 7;";
      writeOneShotRegistry(tmp, {
        [STEM]: REASON,
        [REAL_STEM]: "fixture mirror of the live population-bound line-profit repair",
      });
      writeFileSync(
        path.join(tmp, "supabase", "migrations", `${REAL_STEM}.sql`),
        `-- population-bound repair\n${REAL_WRITE}\n`,
      );
      let idx = 0;
      for (const col of ["profit", "cost_per_unit", "total_units_needed"]) {
        r = apply(
          `20990601${String(160 + idx++).padStart(6, "0")}_r27`,
          `UPDATE public.order_items SET ${col} = ${col} WHERE id = 7;`,
        );
        ok(isDeny(r) && isOneShotDeny(r),
          `round-27: a self-assignment of trigger-watched ${col} re-runs the registered repair → denied`);
      }
      // …and the same write reached the long way round, since the trigger does
      // not care how the row was touched.
      r = apply("20990601000170_r27_delete",
        "DELETE FROM public.order_items WHERE id = 7;");
      ok(isDeny(r) && isOneShotDeny(r), "round-27: a whole-row write to the registered table is a replay candidate");

      // The widening stops at the table. A different table is still a different
      // repair — without this the rule would be "any DML anywhere needs an
      // override", which is how a guard gets switched off.
      r = apply("20990601000171_r27_other_table",
        "UPDATE public.invoices SET total_price = total_price WHERE id = 7;");
      ok(!isOneShotDeny(r), "round-27: a different table is still not the registered repair");

      // And defining a routine that writes the registered TABLE is still not
      // running it — the round-23/24 apply-time distinction is untouched.
      r = apply("20990601000172_r27_define",
        "CREATE OR REPLACE FUNCTION public.recalc_line(p_id bigint) RETURNS void LANGUAGE plpgsql AS $$\n" +
        "BEGIN UPDATE public.order_items SET profit = 0 WHERE id = p_id; END;\n$$;");
      ok(!isOneShotDeny(r), "round-27: widening to the table did not widen past apply-time writes");

      writeOneShotRegistry(tmp, { [STEM]: REASON });
      rmSync(path.join(tmp, "supabase", "migrations", `${REAL_STEM}.sql`), { force: true });
    }

    // ROUND 28 (Codex High). Round 24 established that `CREATE TRIGGER ...
    // EXECUTE FUNCTION f()` is not an invocation, and that is correct about the
    // CREATE statement — attaching a trigger runs nothing. It is false about the
    // migration, because the NEXT statement can fire it. Attach a mutating
    // function to a scratch table nobody cares about, insert one row, and the
    // body runs against live money rows while the analyzer reports only
    // `scratch.id`. Codex's probe confirmed it: unresolved false, no unknown
    // calls, no invocation of the function, straight through.
    //
    // End-to-end here, through the real hook, using the review's own scratch
    // table — the module-level cases live in apply-time-dml-lib.test.mjs.
    {
      const REAL_STEM = "20260810025159_backfill_stale_line_profit";
      writeOneShotRegistry(tmp, {
        [STEM]: REASON,
        [REAL_STEM]: "fixture mirror of the live population-bound line-profit repair",
      });
      writeFileSync(
        path.join(tmp, "supabase", "migrations", `${REAL_STEM}.sql`),
        "-- population-bound repair\nUPDATE public.order_items SET total_price = total_price WHERE id = 7;\n",
      );

      const FIX = "CREATE FUNCTION public.tmp_fix() RETURNS trigger LANGUAGE plpgsql\n" +
        "SECURITY DEFINER SET search_path = public, pg_temp AS $$\nBEGIN\n" +
        "  UPDATE public.order_items SET profit = (profit);\n  RETURN NEW;\nEND $$;";
      const ATTACH = "CREATE TEMP TABLE scratch(id integer);\n" +
        "CREATE TRIGGER run_fix AFTER INSERT ON scratch\n" +
        "  FOR EACH ROW EXECUTE FUNCTION public.tmp_fix();";

      r = apply("20990601000180_r28_repro", `${FIX}\n${ATTACH}\nINSERT INTO scratch(id) VALUES (1);`);
      ok(isDeny(r) && isOneShotDeny(r),
        "round-28: a trigger fired through a scratch table replays the registered repair → denied");

      // The false-positive boundary Codex named in the same finding. If this
      // turns red, every migration that adds an updated_at trigger starts
      // demanding an override, which is how a guard gets switched off.
      r = apply("20990601000181_r28_attach_only", `${FIX}\n${ATTACH}`);
      ok(!isOneShotDeny(r), "round-28: attaching a trigger without firing it is not a write");

      // A trigger on a real table, fired by this file's own DML on that table.
      r = apply("20990601000182_r28_real_table",
        "CREATE FUNCTION public.carry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN\n" +
        "  UPDATE public.order_items SET profit = (profit); RETURN NEW; END $$;\n" +
        "CREATE TRIGGER t_carry AFTER UPDATE ON public.customers FOR EACH ROW\n" +
        "  EXECUTE FUNCTION public.carry();\nUPDATE public.customers SET note = 'x';");
      ok(isDeny(r) && isOneShotDeny(r),
        "round-28: the scratch table is incidental — any fired attachment counts");

      // …and an ordinary trigger whose body writes nothing protected stays
      // silent, so the common shape costs nothing.
      r = apply("20990601000183_r28_benign",
        "CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN\n" +
        "  NEW.updated_at = now(); RETURN NEW; END $$;\n" +
        "CREATE TRIGGER t_touch BEFORE UPDATE ON public.customers FOR EACH ROW\n" +
        "  EXECUTE FUNCTION public.touch();\nUPDATE public.customers SET note = 'x';");
      ok(!isOneShotDeny(r), "round-28: an updated_at trigger on an unrelated table is silent");

      writeOneShotRegistry(tmp, { [STEM]: REASON });
      rmSync(path.join(tmp, "supabase", "migrations", `${REAL_STEM}.sql`), { force: true });
    }

    // 4. ROUND 12 (Codex High) reversed this case. Round 8 let a one-shot
    //    through whenever the ledger already contained it, reasoning that such a
    //    database IS the population the repair was approved against. True at the
    //    instant of the first apply, false a day later: orders get edited,
    //    returned, re-invoiced, and a count-bound money repair re-run against
    //    that drifted population rewrites rows nobody approved. The ordering
    //    guard cannot catch the duplicate either — it deliberately excludes a
    //    migration's own timestamp — so ledger presence was a hole in BOTH gates.
    writeAppliedSnapshot(stateDir, { applied: ["20990101000000_already_applied", STEM] });
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isOneShotDeny(r), "round-12: a one-shot already in the ledger is still refused — a re-apply needs its own override");
    ok(/REPEAT apply/.test(r.stdout), "round-12: the deny says plainly that this repair has already run once");

    // …and the override is what releases it, exactly as on a first apply.
    writeFileSync(
      path.join(stateDir, "one-shot-replay-override.json"),
      JSON.stringify({
        migration: STEM, queryHash: sha(ONE_SHOT_SQL), project: "x", issuedAt: new Date().toISOString(),
      }),
    );
    r = apply(STEM, ONE_SHOT_SQL);
    ok(!isOneShotDeny(r), "round-12: a fresh bound override authorizes a deliberate re-apply of an already-applied one-shot");
    writeAppliedSnapshot(stateDir, { applied: ["20990101000000_already_applied"] });

    // 5. The override is bound to the exact SQL, not to a name. A flag keyed on
    //    the migration alone would authorize any body someone put under it.
    //
    //    Round 11 (Codex High) added the other two axes: an override bound only
    //    to stem+hash stayed valid across DATABASES and across TIME, so one
    //    approved replay released the identical money write days later against a
    //    restored or different project. It must now also name the target and be
    //    fresh, and it is consumed on sight.
    const ovPath = path.join(stateDir, "one-shot-replay-override.json");
    const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
    // `apply()` transmits project_id "x", so that is the target this override
    // has to name.
    const goodOverride = (extra = {}) => JSON.stringify({
      migration: STEM,
      queryHash: sha(ONE_SHOT_SQL),
      project: "x",
      issuedAt: iso(0),
      ...extra,
    });

    writeFileSync(ovPath, goodOverride({ queryHash: sha("some other sql") }));
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isOneShotDeny(r), "an override whose queryHash does not match the transmitted SQL does not authorize it");

    writeFileSync(ovPath, JSON.stringify({ migration: STEM, queryHash: sha(ONE_SHOT_SQL) }));
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isOneShotDeny(r), "round-11: an override naming no project does not authorize a replay on any database");

    writeFileSync(ovPath, goodOverride({ project: "some-other-project-ref" }));
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isOneShotDeny(r), "round-11: an override issued for a different project does not authorize this one");

    writeFileSync(ovPath, goodOverride({ issuedAt: undefined }));
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isOneShotDeny(r), "round-11: an override with no issuedAt cannot be shown to be fresh, so it is refused");

    writeFileSync(ovPath, goodOverride({ issuedAt: iso(31 * 60 * 1000) }));
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isOneShotDeny(r), "round-11: an override older than the 30-minute window no longer authorizes the replay");

    writeFileSync(ovPath, goodOverride({ issuedAt: iso(-10 * 60 * 1000) }));
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isOneShotDeny(r), "round-11: a future-dated override cannot buy extra window and is refused");

    // Every one of those refusals must ALSO have spent the override — a file
    // that survives its own rejection is a file someone can leave lying around.
    ok(!existsSync(ovPath), "round-11: a refused override is consumed, not left on disk for the next attempt");

    writeFileSync(ovPath, goodOverride());
    r = apply(STEM, ONE_SHOT_SQL);
    ok(!isOneShotDeny(r), "a fully bound override — exact SQL, this project, freshly issued — releases the refusal");
    ok(!existsSync(ovPath), "round-11: an ACCEPTED override is consumed too, so it authorizes exactly one attempt");

    // Consumed means the very next identical apply is refused again. Before
    // round 11 this second attempt sailed through on the same file.
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isOneShotDeny(r), "round-11: replaying the same approved SQL a second time needs a second override");

    // The same override must not release a DIFFERENT body.
    writeFileSync(ovPath, goodOverride());
    r = apply(STEM, `${ONE_SHOT_SQL} -- edited`);
    ok(isOneShotDeny(r), "the override authorizes that exact text and nothing else");
    rmSync(ovPath, { force: true });

    // Consumption that FAILED is not consumption (Codex Medium, round 13; in
    // round 15 the consumption became a rename, so the same rule now governs
    // the CLAIM). Spending the override used to be wrapped in a bare `catch {}`,
    // so an override the guard could not remove stayed valid for the rest of its
    // 30-minute window and released every apply in it. Two failure shapes,
    // tested separately because only one of them is portable.
    //
    // A. Spendable but unusable — a directory sitting at that path. The holder
    //    removes it, so the override IS spent, but nothing readable comes
    //    back and the apply is refused rather than released on a guess.
    mkdirSync(ovPath, { recursive: true });
    r = apply(STEM, ONE_SHOT_SQL);
    ok(isDeny(r), "round-13: an override that cannot be read blocks the apply");
    ok(/could not be read/.test(r.stdout),
       "round-13: the deny says the override was consumed without releasing anything");
    rmSync(ovPath, { recursive: true, force: true });
    // The holder must not leave its lock behind on a refused apply either: a
    // stray lock fails closed and would wedge every later case in this fixture.
    ok(!existsSync(`${ovPath}.lock`),
       "round-16: the holder releases its lock even when the override is unreadable");

    // B. Not spendable at all — the claim cannot be taken and the override is
    //    STILL THERE. That is the dangerous shape: reading it would not have
    //    spent it, so it must be refused outright rather than honoured.
    //
    //    Round 15 armed this by making a rename fail, which is platform
    //    dependent — a read-only parent does it on POSIX and is a no-op on
    //    Windows — so on the machine this guard actually runs on the case
    //    printed "skipped" and asserted nothing. Now that the claim is an
    //    exclusive create, the fault arms the same way everywhere: an existing
    //    lock file IS an unclaimable override. No platform gate, no vacuous
    //    pass, and it exercises the real stale-holder path an operator hits
    //    when an apply dies mid-claim.
    proofFor(STEM, ONE_SHOT_SQL);
    writeFileSync(ovPath, goodOverride());
    const heldLock = `${ovPath}.lock`;
    writeFileSync(heldLock, "");
    r = runHook({
      tool_name: "mcp__supabase__apply_migration",
      tool_input: { project_id: "x", name: STEM, query: ONE_SHOT_SQL },
    }, tmp);
    ok(isDeny(r), "round-16: an override whose claim is already held blocks the apply");
    ok(/could not be claimed/.test(r.stdout),
       "round-16: the deny says the override was not spent, and names the lock to clear by hand");
    ok(existsSync(ovPath),
       "round-16: a refused claim does NOT consume the override — it is still there for the operator");
    ok(existsSync(heldLock),
       "round-16: a losing apply does not release a lock it never held");
    rmSync(heldLock, { recursive: true, force: true });
    rmSync(ovPath, { recursive: true, force: true });

    // 6. Fail closed. The registry is tracked in git; unreadable or absent means
    //    the checkout is broken or the file was removed — the two states in
    //    which a silent pass is most dangerous.
    writeFileSync(path.join(tmp, "supabase", "baselines", "one-shot-migrations.json"), "{not json");
    r = apply("20990601000003_anything", BENIGN_SQL);
    ok(isDeny(r) && isOneShotDeny(r), "unparseable one-shot registry → apply denied (fail closed)");

    rmSync(path.join(tmp, "supabase", "baselines", "one-shot-migrations.json"), { force: true });
    r = apply("20990601000004_anything", BENIGN_SQL);
    ok(isDeny(r) && isOneShotDeny(r), "missing one-shot registry → apply denied (fail closed)");
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// ── ONE-SHOT EVIDENCE FOLLOWS THE ACTIVE CHECKOUT (Codex High, round 12) ────
// CLAUDE_PROJECT_DIR pins to the PRIMARY checkout even when the session works
// inside a linked worktree. Rounds 8-11 read the one-shot registry and the
// migration body from that primary path only, so a one-shot registered on a
// feature branch — a fresh, unmerged money repair, the most dangerous kind —
// was invisible to this guard until the branch landed. Evidence now comes from
// both verified checkouts, and the union is what counts.
{
  const root = mkdtempSync(path.join(os.tmpdir(), "mig-apply-guard-wt-"));
  const primary = path.join(root, "primary");
  const worktree = path.join(root, "feature-wt");
  const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8", env: hermeticEnv() });
  try {
    mkdirSync(primary, { recursive: true });
    git(["init", "-b", "main"], primary);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "base"], primary);
    const added = git(["worktree", "add", "-b", "feature", worktree], primary);
    // If git cannot make a worktree here, the fixture proves nothing — say so
    // out loud rather than passing vacuously.
    ok(added.status === 0, "round-12 fixture: a linked worktree was created for the evidence test");

    const STEM = "20990701000000_worktree_only_repair";
    const SQL = "UPDATE public.orders SET total_profit = 7 WHERE id = 3;";
    const REASON = "fixture: registered only on the feature branch";
    for (const dir of [primary, worktree]) {
      mkdirSync(path.join(dir, ".claude", "session-state"), { recursive: true });
    }
    // The PRIMARY registry is deliberately empty — it is the pre-merge state of
    // main. Only the worktree knows about this repair.
    writeOneShotRegistry(primary, {});
    writeOneShotRegistry(worktree, { [STEM]: REASON });
    mkdirSync(path.join(worktree, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(worktree, "supabase", "migrations", `${STEM}.sql`), `-- header\n${SQL}\n`);

    const primaryState = path.join(primary, ".claude", "session-state");
    writeAppliedSnapshot(primaryState, { applied: ["20990101000000_already_applied"] });
    const runFrom = (cwd, name) => {
      writeFileSync(path.join(primaryState, `migration-review-${name}.json`), JSON.stringify({
        migration: name,
        timestamp: new Date().toISOString(),
        reviewers: ["rls-security-reviewer", "migration-drift-reviewer"],
        findings: "clean",
        queryHash: sha(SQL),
      }));
      return spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          tool_name: "mcp__supabase__apply_migration",
          tool_input: { project_id: "x", name, query: SQL },
        }),
        encoding: "utf8",
        cwd,
        env: hermeticEnv({ CLAUDE_PROJECT_DIR: primary }),
      });
    };
    const isOneShotDeny = (r) => r.stdout.includes("ONE-SHOT REPLAY GUARD");

    let r = runFrom(worktree, STEM);
    ok(isOneShotDeny(r), "round-12: a one-shot registered only in the active worktree still stops the apply");
    ok(r.stdout.includes(REASON), "round-12: the deny quotes the worktree registry's own reason");

    // Renaming still cannot dodge it — the body is matched against the SQL file
    // that likewise exists only in the worktree.
    r = runFrom(worktree, "20990701000001_innocent_name");
    ok(isOneShotDeny(r), "round-12: the worktree's migration file catches the same body under a different name");

    // Control: from the primary checkout the registry really is empty, so this
    // apply is NOT one-shot-denied. That is what makes the two assertions above
    // evidence of the fix rather than of some unrelated refusal — before round
    // 12 every one of these ran against the primary registry and passed.
    r = runFrom(primary, STEM);
    ok(!isOneShotDeny(r), "round-12 control: from the primary checkout the empty registry genuinely says nothing");
  } finally {
    // Detach the worktree admin files before deleting, or git leaves the
    // fixture repo pointing at a path that no longer exists.
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: primary, env: hermeticEnv() });
    rmSync(root, { recursive: true, force: true });
  }
}

// ── ONE OVERRIDE RELEASES ONE APPLY, EVEN UNDER CONCURRENCY (Codex High, r15) ─
// Rounds 11-13 spent the override by reading it and THEN deleting it. That is
// one-shot only if nothing else is running. Two apply hooks at once both passed
// the exists check and both read the same bytes; one delete won, the loser got
// ENOENT, and the loser's guard only refused when the path still existed — by
// then it did not — so it proceeded on the copy it had already read. One
// authorization, two live applies of a population-bound money repair.
//
// Making that race show up reliably takes two things. First a start gate: the
// hook blocks on stdin, so eight processes are spawned, given a moment to boot,
// and then released in one tight loop, which puts them at the override check
// within a hair of each other. Second a wide window: the override carries a
// multi-megabyte padding field, so the READ takes long enough that concurrent
// readers overlap. Under the old code that combination lets several of them
// through. Under a claim-before-read only the holder of the exclusive lock may
// read and spend the override, so the count is exactly one.
//
// This test earned its keep: it is what caught round 15's rename-based claim
// double-releasing on Windows. Note that it reproduces probabilistically — it
// failed roughly one run in six — so a green run here is NOT by itself proof
// that a claim primitive is exclusive. The deterministic guarantee lives in the
// held-lock case above; this one is the end-to-end backstop.
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mig-apply-guard-race-"));
  const stateDir = path.join(tmp, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  const STEM = "20990801000000_concurrent_replay_fixture";
  const SQL = "UPDATE public.orders SET total_profit = 5 WHERE id = 9;";
  try {
    writeAppliedSnapshot(stateDir, { applied: ["20990101000000_already_applied"] });
    writeOneShotRegistry(tmp, { [STEM]: "fixture: population-bound money repair" });
    writeFileSync(path.join(stateDir, `migration-review-${STEM}.json`), JSON.stringify({
      migration: STEM,
      timestamp: new Date().toISOString(),
      reviewers: ["rls-security-reviewer", "migration-drift-reviewer"],
      findings: "clean",
      queryHash: sha(SQL),
    }));

    // ONE override, fully bound and freshly issued — the only thing standing
    // between these applies and a release.
    const ovPath = path.join(stateDir, "one-shot-replay-override.json");
    writeFileSync(ovPath, JSON.stringify({
      migration: STEM,
      queryHash: sha(SQL),
      project: "x",
      issuedAt: new Date().toISOString(),
      // Ignored by the guard; it exists only to make the read slow enough that
      // a read-then-delete consumption has a window worth racing for.
      _padding: "x".repeat(4 * 1024 * 1024),
    }));

    const RACERS = 8;
    const racePayload = JSON.stringify({
      tool_name: "mcp__supabase__apply_migration",
      tool_input: { project_id: "x", name: STEM, query: SQL },
    });
    const racers = [];
    for (let i = 0; i < RACERS; i++) {
      const child = spawn(process.execPath, [HOOK], {
        cwd: tmp,
        env: hermeticEnv({ CLAUDE_PROJECT_DIR: tmp }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.resume();
      racers.push({
        child,
        out: () => stdout,
        closed: new Promise((resolve) => child.on("close", resolve)),
      });
    }
    // Every racer is now parked on its stdin read. Release them together.
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const r of racers) r.child.stdin.end(racePayload);
    await Promise.all(racers.map((r) => r.closed));

    const released = racers.filter((r) => r.out().includes('"permissionDecision":"allow"')).length;
    const oneShotDenied = racers.filter((r) => r.out().includes("ONE-SHOT REPLAY GUARD")).length;
    eq(released, 1,
       `round-15: one override releases exactly ONE of ${RACERS} concurrent applies, not several`);
    // …and every loser lost HERE, at the one-shot gate. Without this the count
    // above could be satisfied by racers that some earlier gate turned away,
    // which would make the race untested rather than won.
    eq(oneShotDenied, RACERS - 1,
       "round-15: every racer that did not win the claim is refused by the one-shot guard itself");
    ok(!existsSync(ovPath),
       "round-15: the shared override is gone after the race — the winner spent it");
    // The claim is a private rename, so it must not litter the state directory
    // with files a later reader could mistake for evidence.
    const leftovers = readdirSync(stateDir).filter((f) => f.startsWith("one-shot-replay-override.json."));
    eq(leftovers.length, 0,
       "round-16: every racer releases its lock, leaving no stray state that would wedge later applies");
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

console.log(`migration-apply-guard: ${pass} assertions passed`);
