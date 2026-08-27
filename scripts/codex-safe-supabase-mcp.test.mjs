import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  applyReviewedMigration,
  buildAtomicMigrationSql,
  handleRpcMessage,
  transactionCompatibility,
} from "./codex-safe-supabase-mcp.mjs";
import { CRX_PRODUCTION_REF } from "../.claude/hooks/migration-apply-lib.mjs";

const MIGRATION = "20260827010101_test_gate";
const SQL = [
  "-- BEGIN in a comment is not transaction control",
  "CREATE TABLE public.gate_probe (note text DEFAULT 'COMMIT later');",
  "CREATE FUNCTION public.gate_probe_fn() RETURNS void LANGUAGE plpgsql AS $body$",
  "BEGIN",
  "  RAISE NOTICE 'ROLLBACK is text here';",
  "END",
  "$body$;",
  "",
].join("\n");
const HASH = createHash("sha256").update(SQL).digest("hex");

assert.deepEqual(transactionCompatibility(SQL), { ok: true });
for (const [sql, label] of [
  ["BEGIN; SELECT 1; COMMIT;", "transaction control"],
  ["VACUUM public.widgets;", "VACUUM"],
  ["ALTER SYSTEM SET work_mem = '1GB';", "ALTER SYSTEM"],
  ["CREATE INDEX CONCURRENTLY idx_x ON x(id);", "CONCURRENTLY"],
  ["SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;", "transaction control"],
  ["CREATE DATABASE shadow_copy;", "non-transactional database DDL"],
  ["CALL public.maybe_commits();", "CALL"],
]) {
  const result = transactionCompatibility(sql);
  assert.equal(result.ok, false, `${label} must be rejected`);
  assert.equal(result.reason, label);
}

const atomic = buildAtomicMigrationSql({ migrationName: MIGRATION, query: SQL, queryHash: HASH });
assert.ok(atomic.startsWith("BEGIN;\n"));
assert.ok(atomic.endsWith("COMMIT;\n"));
assert.ok(atomic.includes(SQL.trimEnd()));
assert.ok(atomic.includes("20260827010101"));
assert.ok(atomic.includes("test_gate"));
assert.ok(atomic.includes(HASH));
assert.ok(atomic.indexOf(SQL.trimEnd()) < atomic.indexOf("INSERT INTO supabase_migrations.schema_migrations"));

const root = mkdtempSync(path.join(tmpdir(), "crx-safe-mcp-test-"));
try {
  const migrations = path.join(root, "supabase", "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(path.join(migrations, `${MIGRATION}.sql`), SQL);

  let transmissionCalls = 0;
  const neverTransmit = () => { transmissionCalls += 1; throw new Error("unexpected transmission"); };
  const baseDeps = {
    repoRoot: root,
    linkRoot: root,
    evaluate: () => ({ decision: "allow" }),
    runQuery: neverTransmit,
    runPostApplyHooks: () => {},
  };

  assert.throws(
    () => applyReviewedMigration({ project_id: "wrong", migration_name: MIGRATION, query_sha256: HASH }, baseDeps),
    /project_id must exactly equal/,
  );
  assert.throws(
    () => applyReviewedMigration({ project_id: CRX_PRODUCTION_REF, migration_name: MIGRATION, query_sha256: "0".repeat(64) }, baseDeps),
    /does not match the exact repository file/,
  );
  assert.throws(
    () => applyReviewedMigration({ project_id: CRX_PRODUCTION_REF, migration_name: `${MIGRATION}.sql`, query_sha256: HASH }, baseDeps),
    /exact file stem/,
  );
  assert.throws(
    () => applyReviewedMigration({ project_id: CRX_PRODUCTION_REF, migration_name: "20260827010102_missing", query_sha256: HASH }, baseDeps),
    /does not exist/,
  );
  assert.equal(transmissionCalls, 0, "input failures must happen before transmission");

  let deniedCalls = 0;
  assert.throws(
    () => applyReviewedMigration(
      { project_id: CRX_PRODUCTION_REF, migration_name: MIGRATION, query_sha256: HASH },
      { ...baseDeps, evaluate: () => ({ decision: "block", reason: "review proof missing" }), runQuery: () => { deniedCalls += 1; } },
    ),
    /review proof missing/,
  );
  assert.equal(deniedCalls, 0, "proof denial must happen before transmission");

  const sqlFiles = [];
  let hooks = 0;
  const applied = applyReviewedMigration(
    { project_id: CRX_PRODUCTION_REF, migration_name: MIGRATION, query_sha256: HASH },
    {
      ...baseDeps,
      runQuery: ({ sqlFile }) => {
        sqlFiles.push({ path: sqlFile, body: readFileSync(sqlFile, "utf8") });
        return sqlFiles.length === 1 ? JSON.stringify({ rows: [] }) : JSON.stringify({ rows: [{ count: 1 }] });
      },
      runPostApplyHooks: () => { hooks += 1; },
    },
  );
  assert.deepEqual(applied, { applied: true, migration_name: MIGRATION, query_sha256: HASH, ledger_rows: 1 });
  assert.equal(sqlFiles.length, 2);
  assert.ok(sqlFiles[0].body.startsWith("BEGIN;\n"));
  assert.match(sqlFiles[1].body, /SELECT count\(\*\)::int AS count/);
  assert.equal(hooks, 1);
  assert.ok(sqlFiles.every((entry) => !existsSync(entry.path)), "temporary SQL files must be removed");

  const listed = handleRpcMessage({ method: "tools/list" });
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["apply_reviewed_migration"]);
  const deniedRpc = handleRpcMessage({
    method: "tools/call",
    params: { name: "apply_reviewed_migration", arguments: { project_id: "wrong" } },
  });
  assert.equal(deniedRpc.isError, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

const protocolInput = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  "",
].join("\n");
const child = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "codex-safe-supabase-mcp.mjs")], {
  cwd: process.cwd(), input: protocolInput, encoding: "utf8", timeout: 10_000,
});
assert.equal(child.status, 0, child.stderr);
const replies = child.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.equal(replies[0].result.protocolVersion, "2025-06-18");
assert.deepEqual(replies[1].result.tools.map((tool) => tool.name), ["apply_reviewed_migration"]);

console.log("codex-safe-supabase-mcp: 45 assertions passed; no live connection attempted");
