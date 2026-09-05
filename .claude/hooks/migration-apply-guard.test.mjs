#!/usr/bin/env node
// Tests for the migration-apply-guard: the proof gate (existing behavior) and
// the 2026-07-13 hands-free destructive carve-out (Mason's settled policy —
// an ARMED autopilot run may apply reviewed migrations autonomously, but a
// migration containing apply-time data destruction NEVER applies hands-free).
// Run: node .claude/hooks/migration-apply-guard.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { destructiveMigrationCheck, stripCommentsQuoteAware } from "./live-testdata-lib.mjs";

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
const bareCrExploit = "CREATE DOMAIN public.crx_probe AS text; -- review-only comment\rDELETE FROM public.customers;";
ok(destructiveMigrationCheck(bareCrExploit).destructive, "a lone carriage return ends a PostgreSQL line comment and exposes DELETE");
ok(/DELETE FROM public\.customers/i.test(stripCommentsQuoteAware(bareCrExploit)), "the destructive scanner terminates line comments on lone carriage returns");
const escapeStringExploit = "COMMENT ON TABLE public.customers IS E'escaped\\' quote /*'; DELETE FROM public.customers;";
ok(destructiveMigrationCheck(escapeStringExploit).destructive,
  "an escaped E-string quote cannot hide a following destructive statement");
const escapeStringDollarQuoteExploit = "COMMENT ON TABLE public.customers IS E'foo\\' AS $x$ junk'; DELETE FROM public.customers; -- $x$\nSELECT 1;";
ok(destructiveMigrationCheck(escapeStringDollarQuoteExploit).destructive,
  "a dollar-quote marker inside an escaped E-string cannot hide a following destructive statement");
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
const CRX_PROJECT = "rhyzpcqhnizqbxphqdkr";

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
function writeAppliedSnapshot(stateDir, { applied = ["20260808150400_round_money_to_whole_cents"], ageHours = 0 } = {}) {
  writeFileSync(path.join(stateDir, "applied-migrations.json"), JSON.stringify({
    captured_at: new Date(Date.now() - ageHours * 3600_000).toISOString(),
    count: applied.length,
    applied,
  }));
}
// The source-provenance rule refuses SQL that is not the content of a file under
// <checkout>/supabase/migrations/. Every real apply has that file, so a fixture
// that means to exercise a LATER check must supply it — otherwise provenance
// short-circuits first and the assertion passes for the wrong reason.
function writeMigrationFile(root, name, sql) {
  const dir = path.join(root, "supabase", "migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.sql`), sql);
}
// The pending-set preflight (2026-08-26) asks the question the ordering check
// never did: is an OLDER tracked migration still waiting? It reads the schema
// baseline for its floor and origin/main for the tracked set, and refuses when it
// cannot read either. Both are real files/refs — the hook is a subprocess, so
// there is nothing to inject — and every fixture that expects to reach the proof
// gate has to supply them. hermeticEnv() keeps `git init` off the real repository.
function makePendingSetInputs(root) {
  mkdirSync(path.join(root, "supabase", "baselines"), { recursive: true });
  writeFileSync(
    path.join(root, "supabase", "baselines", "manifest.json"),
    JSON.stringify({ format_version: 3, migrations_high_water: "20260727174805" }));
  mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(root, "supabase", "migrations", `${MIG}.sql`), BENIGN_SQL);
  const git = (...args) => spawnSync("git", [
    "-c", "user.name=fixture",
    "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=",
    "-C", root, ...args,
  ], { encoding: "utf8", env: hermeticEnv() });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const ref = git("update-ref", "refs/remotes/origin/main", "HEAD");
  ok(ref.status === 0, `fixture origin/main is created (git said: ${ref.stderr})`);
  // The freshness gate reads FETCH_HEAD's mtime. `git init` never writes one, so
  // without this the fixture looks like a checkout that has never fetched — which
  // the guard correctly refuses. This stands in for a just-completed fetch.
  writeFileSync(path.join(root, ".git", "FETCH_HEAD"), "fixture\n");
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
  // Both: the pending-set inputs (baseline manifest + origin/main + FETCH_HEAD) and
  // the migration file source provenance requires. makePendingSetInputs already
  // writes the file, but the explicit call keeps the provenance precondition visible
  // at the fixture site rather than depending on a side effect of the other helper.
  makePendingSetInputs(tmp);
  writeMigrationFile(tmp, MIG, BENIGN_SQL);
  try {
    const call = (query, projectId = CRX_PROJECT) => ({
      tool_name: "mcp__supabase__apply_migration",
      tool_input: { project_id: projectId, name: MIG, query },
    });

    let r = runHook(call(BENIGN_SQL, "other-project"), tmp);
    ok(isDeny(r), "wrong project_id is denied before any migration evidence is consulted");
    ok(r.stdout.includes(CRX_PROJECT), "wrong-project denial names the fixed CRX target");
    r = runHook({ tool_name: "mcp__supabase__apply_migration", tool_input: { name: MIG, query: BENIGN_SQL } }, tmp);
    ok(isDeny(r), "missing project_id is denied");
    r = runHook(call(""), tmp);
    ok(isDeny(r), "missing transmitted SQL is denied before proof lookup");

    // 0. Ordering evidence is required BEFORE anything else is considered.
    //    Missing evidence must not be read as "ordering is fine".
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "no applied-migration snapshot → apply denied");
    ok(r.stdout.includes("MIGRATION ORDERING GUARD"), "missing-snapshot deny names the ordering guard");
    // The recapture instructions must name the project THIS apply targets.
    // Reading it from the environment printed a literal placeholder in every
    // normal hook run, and a stray env value could aim the operator at another
    // project's ledger. (Codex P2, PR #354.)
    ok(
      r.stdout.includes(`execute_sql on ${CRX_PROJECT}`),
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

    writeProof(stateDir, BENIGN_SQL, { queryHash: undefined });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "interactive proof without queryHash is denied");
    writeProof(stateDir, BENIGN_SQL);

    // 3. Proof whose queryHash doesn't match the transmitted SQL → deny.
    //    The migration FILE is edited too, which is what really happens: someone
    //    changes the migration after review and re-applies without re-minting.
    //    Writing the edit to disk keeps source provenance satisfied, so the deny
    //    has to come from content binding — the check this case is about.
    const EDITED_SQL = BENIGN_SQL + " -- edited after review";
    writeMigrationFile(tmp, MIG, EDITED_SQL);
    r = runHook(call(EDITED_SQL), tmp);
    ok(isDeny(r), "edited-after-review SQL (hash mismatch) → denied");
    ok(!/MIGRATION SOURCE GUARD/.test(r.stdout),
      "the edited-after-review deny is content binding, not source provenance short-circuiting it");
    writeMigrationFile(tmp, MIG, BENIGN_SQL);

    // 3b. FUTURE-dated reviewer proof → deny (Codex R5 P2: a negative age
    //     must not count as fresh — it would stay "valid" for years).
    writeProof(stateDir, BENIGN_SQL, { timestamp: new Date(Date.now() + 3600_000).toISOString() });
    r = runHook(call(BENIGN_SQL), tmp);
    ok(isDeny(r), "future-dated reviewer proof → denied");

    // 4. No flag file at all + destructive + valid proof → allowed (Mason is
    //    present; his in-chat OK is the gate — prose, the hook doesn't block).
    writeProof(stateDir, DESTRUCTIVE_SQL);
    writeMigrationFile(tmp, MIG, DESTRUCTIVE_SQL);
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
    writeMigrationFile(tmp, MIG, BENIGN_SQL);
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
    //    The migration FILE must hold the destructive SQL too. Codex caught this
    //    (2026-08-31, exact-SHA review of f498c473): with the file still holding
    //    BENIGN_SQL, source provenance refused on content-mismatch BEFORE the
    //    autopilot rule was ever reached — so both cases below passed for the
    //    wrong reason and would have stayed green through an autopilot
    //    regression. The deny reason is now asserted, not just the deny.
    armAutopilot(stateDir, -1);
    writeMigrationFile(tmp, MIG, DESTRUCTIVE_SQL);
    writeProof(stateDir, DESTRUCTIVE_SQL, { codexVerdict: "clean" });
    r = runHook(call(DESTRUCTIVE_SQL), tmp);
    ok(isDeny(r), "EXPIRED autopilot flag: destructive apply still denied (fail closed)");
    ok(/LAPSED/i.test(r.stdout),
      "the EXPIRED-flag deny is the lapsed-authorization rule, not provenance short-circuiting it");

    // 7b. MALFORMED flag file → same fail-closed treatment.
    writeFileSync(path.join(stateDir, "AUTOPILOT.on"), "not json at all");
    r = runHook(call(DESTRUCTIVE_SQL), tmp);
    ok(isDeny(r), "malformed autopilot flag: destructive apply denied (fail closed)");
    ok(/LAPSED/i.test(r.stdout),
      "the malformed-flag deny is also the lapsed-authorization rule");
    writeMigrationFile(tmp, MIG, BENIGN_SQL);

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
    writeMigrationFile(tmp, MIG, DESTRUCTIVE_SQL);
    r = runHook(call(DESTRUCTIVE_SQL), tmp);
    ok(!isDeny(r), "flag deleted by explicit disarm → interactive rules apply again");
    writeMigrationFile(tmp, MIG, BENIGN_SQL);

    // 8. Unrelated tools must receive NO decision, not an overriding allow.
    r = runHook({ tool_name: "mcp__supabase__execute_sql", tool_input: { query: "DROP TABLE customers;" } }, tmp);
    eq(r.stdout, "", "other tools defer to their own permission checks");
    r = runHook({ tool_name: "mcp__permission_probe__write_marker", tool_input: {} }, tmp);
    eq(r.stdout, "", "an unlisted named connector mutation is not approved by the migration guard");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── EVERY MCP apply spelling routes through the same gate ───────────────────
// .claude/settings.json permits apply_migration under three distinct MCP server
// names, and the hook is registered once against matcher "mcp__.*", filtering
// in-script on a tool name CONTAINING "apply_migration". That is what makes the
// three spellings equivalent — so it is asserted, not assumed. A per-spelling
// registration would be the thing that lets one door drift open; if a fourth
// server name is ever added to settings.json, it is covered automatically and
// this case is what proves the mechanism still holds.
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mig-apply-guard-aliases-"));
  const stateDir = path.join(tmp, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  try {
    writeAppliedSnapshot(stateDir);
    // Deliberately NO migration file on disk: source provenance is the check
    // being exercised through each spelling.
    const PARKED = "CREATE TABLE public.parked_thing (id bigint primary key);";
    writeProof(stateDir, PARKED);

    const SPELLINGS = [
      "mcp__supabase__apply_migration",
      "mcp__claude_ai_Supabase__apply_migration",
      "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__apply_migration",
    ];
    for (const tool_name of SPELLINGS) {
      const r = runHook({
        tool_name,
        tool_input: { project_id: CRX_PROJECT, name: MIG, query: PARKED },
      }, tmp);
      ok(isDeny(r), `${tool_name}: SQL with no repository migration file is denied`);
      ok(/MIGRATION SOURCE GUARD/.test(r.stdout),
        `${tool_name}: the denial is the source-provenance rule, identically to every other spelling`);
    }

    // The mirror: with the file present, every spelling reaches allow. Without
    // this, a hook that denied everything would satisfy the loop above.
    //
    // The pending-set inputs are created HERE rather than at the top of the fixture:
    // makePendingSetInputs writes a migration file, which would have satisfied source
    // provenance and gutted the deny loop above. Order matters, so it is explicit.
    makePendingSetInputs(tmp);
    writeMigrationFile(tmp, MIG, PARKED);
    for (const tool_name of SPELLINGS) {
      const r = runHook({
        tool_name,
        tool_input: { project_id: CRX_PROJECT, name: MIG, query: PARKED },
      }, tmp);
      ok(!isDeny(r), `${tool_name}: a genuine repository migration is allowed through the same gate`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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
// harmless, but migration evidence is session-owned and must not be borrowed
// from another checkout, so any-worktree scanning would let one of Mason's
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
    // The pending-set preflight reads the schema baseline and origin/main from
    // CLAUDE_PROJECT_DIR, which stays pinned to `primary` throughout. Seed both
    // there, or it blocks before the proof-scoping behaviour under test is reached.
    mkdirSync(path.join(primary, "supabase", "baselines"), { recursive: true });
    writeFileSync(
      path.join(primary, "supabase", "baselines", "manifest.json"),
      JSON.stringify({ format_version: 3, migrations_high_water: "20260727174805" }));
    mkdirSync(path.join(primary, "supabase", "migrations"), { recursive: true });
    writeFileSync(path.join(primary, "supabase", "migrations", `${MIG}.sql`), BENIGN_SQL);
    git(["add", "-A"], primary);
    git(["commit", "-qm", "seed"], primary);
    const originRef = git(["update-ref", "refs/remotes/origin/main", "HEAD"], primary);
    ok(originRef.status === 0, `fixture origin/main is created (git said: ${originRef.stderr})`);
    // Stands in for a just-completed fetch; see makePendingSetInputs.
    writeFileSync(path.join(primary, ".git", "FETCH_HEAD"), "fixture\n");
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
    // Proof exists ONLY in the linked worktree; the primary has none.
    writeProof(linkedState, BENIGN_SQL);
    // The migration file exists in BOTH checkouts on purpose. Source provenance is
    // satisfied either way, so the ONLY thing that can differ between the calls
    // below is where the PROOF was minted — which is the behaviour under test.
    // Seeding it in just one checkout would make a proof-scoping assertion pass on
    // a provenance refusal instead.
    writeMigrationFile(primary, MIG, BENIGN_SQL);
    writeMigrationFile(linked, MIG, BENIGN_SQL);
    // CLAUDE_PROJECT_DIR stays pinned to `primary` in every call below — that is
    // what the real harness does. Only the session's reported cwd varies, which
    // is the whole behaviour under test.
    const callFrom = (cwd, query, name = MIG) =>
      ({ tool_name: "mcp__supabase__apply_migration", cwd, tool_input: { project_id: CRX_PROJECT, name, query } });

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

    // Both cases below must SEED THE MIGRATION FILE, or source provenance refuses
    // first and neither test exercises the check it names. Codex caught this
    // (minor, exact-SHA review of b7ac7a8f) — the second time in this PR that a
    // newly-inserted early gate quietly disarmed downstream tests, which is why
    // each one now asserts its intended denial REASON rather than just a denial.
    const EDITED = BENIGN_SQL + " -- edited after review";
    writeMigrationFile(linked, MIG, EDITED);
    r = runHook(callFrom(linked, EDITED), primary);
    ok(isDeny(r), "the session's own worktree proof does NOT excuse a queryHash mismatch — content binding survives");
    ok(r.stdout.includes("without subagent review proof"),
      "the queryHash mismatch is refused by the proof gate, not by provenance short-circuiting it");
    writeMigrationFile(linked, MIG, BENIGN_SQL);

    // MIG must read as APPLIED before this sub-case, or the merged pending-set guard
    // legitimately refuses first: applying a 2099-dated migration while a tracked
    // 2026 one is still unapplied would strand it. That is correct behaviour, but it
    // is not the rule under test here — the third distinct gate to shadow these
    // assertions, which is why each pins its reason.
    const OTHER = "20990101000001_other_mig";
    for (const s of [linkedState, path.join(primary, ".claude", "session-state")]) {
      writeAppliedSnapshot(s, { applied: ["20260808150400_round_money_to_whole_cents", MIG] });
    }
    writeMigrationFile(linked, OTHER, BENIGN_SQL);
    r = runHook(callFrom(linked, BENIGN_SQL, OTHER), primary);
    ok(isDeny(r), "the session's own worktree proof does NOT cover a different migration name");
    ok(r.stdout.includes("without subagent review proof"),
      "the wrong-name case is refused by the proof gate, not by provenance or the pending-set guard");

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
    rmSync(tmp, { recursive: true, force: true });
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
      // A real repository migration file under this exact name, so source
      // provenance is satisfied and cannot mask the check under test. This is also
      // the honest version of the attack: renaming the FILE is what a caller would
      // actually do to defeat the ordering comparison.
      writeMigrationFile(tmp, name, BENIGN_SQL);
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
        tool_input: { project_id: CRX_PROJECT, name, query: BENIGN_SQL },
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
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`migration-apply-guard: ${pass} assertions passed`);
