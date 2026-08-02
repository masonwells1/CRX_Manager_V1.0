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
function armAutopilot(stateDir, hoursFromNow) {
  writeFileSync(path.join(stateDir, "AUTOPILOT.on"), JSON.stringify({
    expires: new Date(Date.now() + hoursFromNow * 3600_000).toISOString(),
  }));
}

{
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mig-apply-guard-"));
  const stateDir = path.join(tmp, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  try {
    const call = (query) => ({ tool_name: "mcp__supabase__apply_migration", tool_input: { project_id: "x", name: MIG, query } });

    // 1. No proof → deny (existing behavior).
    let r = runHook(call(BENIGN_SQL), tmp);
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
    // Proof exists ONLY in the linked worktree; the primary has none.
    writeProof(linkedState, BENIGN_SQL);
    // CLAUDE_PROJECT_DIR stays pinned to `primary` in every call below — that is
    // what the real harness does. Only the session's reported cwd varies, which
    // is the whole behaviour under test.
    const callFrom = (cwd, query, name = MIG) =>
      ({ tool_name: "mcp__supabase__apply_migration", cwd, tool_input: { name, query } });

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

console.log(`migration-apply-guard: ${pass} assertions passed`);
