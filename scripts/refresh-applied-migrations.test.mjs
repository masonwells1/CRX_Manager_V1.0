#!/usr/bin/env node
// Regression tests for scripts/refresh-applied-migrations.mjs.
//
// This script writes the ONLY evidence the migration ordering guard has about
// what the database actually applied. Every failure mode here ends the same
// way: the guard reads confident-looking evidence that answers no question, and
// an out-of-order migration lands. So the script must refuse to write rather
// than write something plausible.
//
// Run against the real script as a subprocess — its refusals are exit codes and
// stderr, not return values, and that is the contract the caller depends on.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "refresh-applied-migrations.mjs");

let passed = 0;

// Each run gets its own CLAUDE_PROJECT_DIR so a test can never touch the real
// session-state snapshot.
function run(input) {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-applied-"));
  try {
    const res = spawnSync(process.execPath, [script], {
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    const out = path.join(dir, ".claude", "session-state", "applied-migrations.json");
    return {
      status: res.status,
      stderr: res.stderr || "",
      written: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(label, fn) {
  fn();
  passed += 1;
  void label;
}

// ---------------------------------------------------------------------------
// The defect this file was added for (CodeRabbit, PR #354)
// ---------------------------------------------------------------------------
check("an unrelated string array carrying a 14-digit value is NOT ledger evidence", () => {
  // ["note", "20260808170000"] previously satisfied looksLikeLedgerRows (all
  // strings) AND the has-a-timestamp check, so findRows could adopt some
  // unrelated list and write it out as the applied-migration set.
  const res = run({ result: ["note", "20260808170000"] });
  assert.notEqual(res.status, 0, "must refuse");
  assert.equal(res.written, null, "must not write a snapshot");
});

check("a nested unrelated array does not win over the real ledger rows", () => {
  const res = run({
    notes: ["something", "20260808170000"],
    result: [
      { version: "20260807220323", name: "log_customer_fact_rpc" },
      { version: "20260808150400", name: "round_money_to_whole_cents" },
    ],
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.written.applied, [
    "20260807220323_log_customer_fact_rpc",
    "20260808150400_round_money_to_whole_cents",
  ]);
});

check("objects without a ledger-shaped version or name are rejected", () => {
  const res = run({ result: [{ name: "not a migration" }, { name: "also not one" }] });
  assert.notEqual(res.status, 0);
  assert.equal(res.written, null);
});

// ---------------------------------------------------------------------------
// Shapes that MUST still be accepted — a predicate that is too strict silently
// disables the guard just as effectively as one that is too loose.
// ---------------------------------------------------------------------------
check("accepts a bare array of migration-shaped strings", () => {
  const res = run(["20260807220323_log_customer_fact_rpc", "20260808150400_round_money.sql"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.written.count, 2);
});

check("accepts the real ledger shape with timestamp-less names", () => {
  // version 20260727174805 / name deactivation_revokes_auth_access — the row
  // shape that must keep constraining ordering via its version.
  const res = run({
    result: [{ version: "20260727174805", name: "deactivation_revokes_auth_access" }],
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.written.applied, ["20260727174805_deactivation_revokes_auth_access"]);
});

check("accepts a path-shaped ledger name", () => {
  const res = run(["supabase/migrations/20260714220000_hardening.sql"]);
  assert.equal(res.status, 0, res.stderr);
});

// ---------------------------------------------------------------------------
// The earlier refusals stay refusals
// ---------------------------------------------------------------------------
check("refuses empty stdin", () => {
  const res = run("");
  assert.notEqual(res.status, 0);
  assert.equal(res.written, null);
});

check("refuses invalid JSON", () => {
  const res = run("not json");
  assert.notEqual(res.status, 0);
  assert.equal(res.written, null);
});

check("refuses a snapshot where nothing carries a timestamp", () => {
  const res = run({ result: [{ version: "abc", name: "initial_schema" }] });
  assert.notEqual(res.status, 0);
  assert.equal(res.written, null);
});

console.log(`refresh-applied-migrations: ${passed} assertions passed`);
