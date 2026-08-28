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
    "VALUES ('20260827000000', ARRAY['local baseline'], '20260827000000_local_baseline');",
  ].join("\n"));

  psql("BEGIN;\n" + migrationSql + "\nCOMMIT;");

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
    "VALUES ('20260826000000', ARRAY['must roll back'], '20260826000000_replica_bypass_probe');",
    "COMMIT;",
  ].join("\n"), false);
  assert.notEqual(replicaAttempt.status, 0, "replica mode must not suppress the ordering trigger");
  assert.match(
    String(replicaAttempt.stdout) + "\n" + String(replicaAttempt.stderr),
    /CRX migration ledger ordering violation/,
    "replica-mode refusal must come from the ordering trigger",
  );

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

  process.stdout.write("global ledger guard local proof passed: replica mode blocked; WHEN (false) rejected\n");
} finally {
  docker(["rm", "--force", container], { timeout: 30_000 });
}
