#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const migrationPath = path.join(repoRoot, "supabase", "migrations", "20260827223000_enforce_global_migration_ledger_order.sql");
const migrationSql = readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n");
const dollar = String.fromCharCode(36);
const verifyStartMarker = "DO " + dollar + "verify" + dollar;
const verifyEndMarker = dollar + "verify" + dollar + ";";
const verifyStart = migrationSql.indexOf(verifyStartMarker);
const verifyEnd = migrationSql.indexOf(verifyEndMarker, verifyStart);
assert.ok(verifyStart >= 0 && verifyEnd > verifyStart, "migration catalog verification block must be present");
const verifyBlock = migrationSql.slice(verifyStart, verifyEnd + verifyEndMarker.length);
const container = "crx-ledger-guard-" + process.pid + "-" + Date.now();

function docker(args, options = {}) {
  return spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
    input: options.input,
  });
}

function psql(sql, expectSuccess = true) {
  const result = docker(
    ["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql },
  );
  if (expectSuccess && result.status !== 0) {
    throw new Error("psql failed:\n" + result.stdout + "\n" + result.stderr);
  }
  return result;
}

try {
  const started = docker([
    "run", "--detach", "--rm", "--name", container,
    "--env", "POSTGRES_PASSWORD=crx-local-proof",
    "postgres:15-alpine",
  ]);
  if (started.status !== 0) throw new Error("docker run failed: " + started.stderr);

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = docker(["exec", container, "pg_isready", "-U", "postgres"], { timeout: 10_000 });
    if (probe.status === 0) { ready = true; break; }
  }
  assert.equal(ready, true, "temporary PostgreSQL container did not become ready");

  psql([
    "CREATE ROLE anon;",
    "CREATE ROLE authenticated;",
    "CREATE SCHEMA supabase_migrations;",
    "CREATE TABLE supabase_migrations.schema_migrations (",
    "  version varchar(255) PRIMARY KEY,",
    "  statements text[],",
    "  name varchar(255)",
    ");",
    "INSERT INTO supabase_migrations.schema_migrations(version, statements, name)",
    "VALUES ('20230101000000', ARRAY['local baseline'], '20230101000000_local_baseline');",
  ].join("\n"));

  psql("BEGIN;\n" + migrationSql + "\nCOMMIT;");

  const invalidTimestampAttempt = psql([
    "BEGIN;",
    "INSERT INTO supabase_migrations.schema_migrations(version, statements, name)",
    "VALUES ('20269901000000', ARRAY['invalid timestamp probe'], '20269901000000_invalid_timestamp_probe');",
    "COMMIT;",
  ].join("\n"), false);
  assert.notEqual(invalidTimestampAttempt.status, 0, "ledger rows must reject non-calendar authored timestamps");
  assert.match(
    String(invalidTimestampAttempt.stdout) + "\n" + String(invalidTimestampAttempt.stderr),
    /valid calendar timestamp/,
    "invalid authored timestamps must be rejected by the ledger trigger",
  );

  const dstGapAttempt = psql([
    "BEGIN;",
    "SET LOCAL TimeZone = 'America/Chicago';",
    "INSERT INTO supabase_migrations.schema_migrations(version, statements, name)",
    "VALUES ('20240310023000', ARRAY['DST gap timestamp probe'], '20240310023000_dst_gap_timestamp_probe');",
    "COMMIT;",
  ].join("\n"));
  assert.equal(dstGapAttempt.status, 0,
    "the ledger trigger must validate zone-less authored timestamps in UTC, not the caller session zone");

  const shape = psql([
    "SELECT t.tgenabled::text || '|' || (t.tgqual IS NULL)::text || '|' || t.tgnargs::text",
    "FROM pg_catalog.pg_trigger t",
    "WHERE t.tgrelid = 'supabase_migrations.schema_migrations'::regclass",
    "  AND t.tgname = 'crx_enforce_monotonic_migration_ledger';",
  ].join("\n")).stdout;
  assert.match(shape, /A\|true\|0/, "installed trigger must be ALWAYS, unconditional, and zero-argument");

  const replicaAttempt = psql([
    "BEGIN;",
    "SET LOCAL session_replication_role = replica;",
    "INSERT INTO supabase_migrations.schema_migrations(version, statements, name)",
    "VALUES ('20220101000000', ARRAY['must roll back'], '20220101000000_replica_bypass_probe');",
    "COMMIT;",
  ].join("\n"), false);
  assert.notEqual(replicaAttempt.status, 0, "replica mode must not suppress the ordering trigger");
  assert.match(
    String(replicaAttempt.stdout) + "\n" + String(replicaAttempt.stderr),
    /CRX migration ledger ordering violation/,
    "replica-mode refusal must come from the ordering trigger",
  );

  psql([
    "CREATE TRIGGER crx_unreviewed_second_ledger_trigger",
    "BEFORE INSERT ON supabase_migrations.schema_migrations",
    "FOR EACH ROW EXECUTE FUNCTION supabase_migrations.crx_enforce_monotonic_migration_ledger();",
  ].join("\n"));
  const secondTriggerAttempt = psql("BEGIN;\n" + migrationSql + "\nCOMMIT;", false);
  assert.notEqual(secondTriggerAttempt.status, 0, "migration must reject a second non-internal ledger trigger");
  assert.match(
    String(secondTriggerAttempt.stdout) + "\n" + String(secondTriggerAttempt.stderr),
    /CRX global migration ledger ordering guard verification failed/,
  );
  psql("DROP TRIGGER crx_unreviewed_second_ledger_trigger ON supabase_migrations.schema_migrations;");

  psql([
    "DROP TRIGGER crx_enforce_monotonic_migration_ledger ON supabase_migrations.schema_migrations;",
    "CREATE TRIGGER crx_enforce_monotonic_migration_ledger",
    "BEFORE INSERT ON supabase_migrations.schema_migrations",
    "FOR EACH ROW WHEN (false)",
    "EXECUTE FUNCTION supabase_migrations.crx_enforce_monotonic_migration_ledger();",
    "ALTER TABLE supabase_migrations.schema_migrations",
    "  ENABLE ALWAYS TRIGGER crx_enforce_monotonic_migration_ledger;",
  ].join("\n"));
  const conditionedTrigger = psql(verifyBlock, false);
  assert.notEqual(conditionedTrigger.status, 0, "catalog verification must reject WHEN (false)");
  assert.match(
    String(conditionedTrigger.stdout) + "\n" + String(conditionedTrigger.stderr),
    /CRX global migration ledger ordering guard verification failed/,
  );

  process.stdout.write("global ledger guard local proof passed: replica mode blocked; second trigger and WHEN (false) rejected\n");
} finally {
  docker(["rm", "--force", container], { timeout: 30_000 });
}
