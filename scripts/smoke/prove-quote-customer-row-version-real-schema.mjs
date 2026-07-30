#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for the quote/customer row-version migration.
 * It restores the supported baseline, replays every ledger-selected migration
 * through this candidate, executes both real rollback-only smoke matrices, and
 * always removes its network-disabled container. It never reads a DB URL.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-row-version-schema-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const candidate = path.join(ROOT, 'supabase', 'migrations', '20260730031925_quote_customer_row_version_guard.sql');
const smokeFiles = [
  path.join(ROOT, 'scripts', 'smoke', 'smoke-save-quote-customer-row-version.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-planned-holds-drawn-sync.sql'),
];
const quoteLifecycleAnchors = [
  {
    label: 'draft-to-sent exact-version, sent_at, and commission-split',
    statement: "RAISE EXCEPTION 'SMOKE_FAIL: draft-to-sent save lost status, sent_at, commission split, or exact N+1 token';",
  },
  {
    label: 'repeated-sent exact-version, sent_at preservation, and commission-split preservation',
    statement: "RAISE EXCEPTION 'SMOKE_FAIL: repeated sent save reset sent_at, lost commission split, or missed exact N+1 token';",
  },
  {
    label: 'stale draft after sent resolves as row-version conflict before lifecycle validation',
    statement: "RAISE EXCEPTION 'SMOKE_FAIL: stale draft after sent raised % instead of QUOTE_STALE_WRITE', v_error;",
  },
];

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 60 * 1024 * 1024, ...options });
  if (result.error || (!options.allowFailure && result.status !== 0)) throw new Error(`${result.error?.message ?? ''}\n${result.stderr ?? result.stdout}`.trim());
  return result;
}
function psql(sql, options = {}) {
  return docker(['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, allowFailure: options.allowFailure });
}
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
function apply(name, user) { psql(`\\i /tmp/${name}`, { user }); }
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForDatabase() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0
      && docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'], { allowFailure: true }).stdout.trim() === '1') return;
    wait(500);
  }
  throw new Error(`disposable PostgreSQL failed readiness: ${docker(['logs', NAME], { allowFailure: true }).stderr}`);
}
function selectedMigrations() {
  const result = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  const migrations = result.stdout.split(/\r?\n/).filter(Boolean).map((relative) => path.join(ROOT, relative));
  assert.ok(migrations.includes(candidate), 'candidate migration is not in the ledger-selected post-baseline replay');
  return migrations;
}
function assertQuoteLifecycleCoverage(sql) {
  for (const anchor of quoteLifecycleAnchors) {
    assert.equal(
      sql.split(anchor.statement).length - 1,
      1,
      `quote lifecycle smoke must contain exactly one ${anchor.label} failure assertion`,
    );
  }
}
function proveQuoteLifecycleAnchorMutationResistance(sql) {
  for (const anchor of quoteLifecycleAnchors) {
    const mutations = [
      ['removing', sql.replace(anchor.statement, '')],
      ['renaming', sql.replace(anchor.statement, `${anchor.statement.slice(0, -2)} (renamed)';`)],
    ];
    for (const [action, mutated] of mutations) {
      assert.notEqual(mutated, sql, `failed to mutate ${anchor.label} assertion anchor`);
      assert.throws(
        () => assertQuoteLifecycleCoverage(mutated),
        new RegExp(`exactly one ${anchor.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failure assertion`),
        `${action} ${anchor.label} assertion anchor must fail closed`,
      );
    }
  }
}
function expectRollbackMarker(file) {
  const result = psql(`\\i /tmp/${path.basename(file)}`, { allowFailure: true });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `${path.basename(file)} unexpectedly committed instead of rolling back`);
  assert.match(output, /SMOKE_PASS_ROLLBACK/, `${path.basename(file)} did not execute to SMOKE_PASS_ROLLBACK:\n${output}`);
}

try {
  for (const file of [candidate, ...smokeFiles]) assert.ok(readFileSync(file, 'utf8').length > 0, `missing required artifact ${file}`);
  const quoteSmokeSql = readFileSync(smokeFiles[0], 'utf8');
  assertQuoteLifecycleCoverage(quoteSmokeSql);
  proveQuoteLifecycleAnchorMutationResistance(quoteSmokeSql);
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  waitForDatabase();
  const artifacts = ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql'];
  for (const artifact of artifacts) copy(path.join(BASELINE, artifact), artifact);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(`baseline decompression failed: ${schema.stderr.toString()}`);
  apply('20260727174805_extensions.sql');
  psql(schema.stdout.toString());
  // The supported Postgres image does not ship Storage DDL.  The platform
  // overlay owns CRX's policies/buckets, so provide only its platform tables
  // and helpers before applying that exact artifact.
  psql(`
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL,
      name text NOT NULL, owner_id text
    );
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
  `, { user: 'supabase_admin' });
  apply('20260727174805_acl_lockdown.sql');
  apply('20260727174805_platform_overlay.sql', 'supabase_admin');
  apply('20260727174805_cron_jobs.sql');
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  apply('20260727174805_migration_history.sql');
  const migrations = selectedMigrations();
  for (const [index, migration] of migrations.entries()) {
    const name = `migration-${index}.sql`;
    copy(migration, name);
    apply(name);
  }
  psql(`
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('00000000-0000-4000-8000-000000000001', 'row-version-admin@example.invalid', '{"full_name":"Row Version Admin","role":"admin"}'),
      ('00000000-0000-4000-8000-000000000002', 'row-version-sales@example.invalid', '{"full_name":"Row Version Sales","role":"sales_rep"}'),
      ('00000000-0000-4000-8000-000000000003', 'row-version-driver@example.invalid', '{"full_name":"Row Version Driver","role":"driver"}')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (id, email, role, is_active) VALUES
      ('00000000-0000-4000-8000-000000000001', 'row-version-admin@example.invalid', 'admin', true),
      ('00000000-0000-4000-8000-000000000002', 'row-version-sales@example.invalid', 'sales_rep', true),
      ('00000000-0000-4000-8000-000000000003', 'row-version-driver@example.invalid', 'driver', true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
  `);
  for (const file of smokeFiles) {
    copy(file, path.basename(file));
    expectRollbackMarker(file);
  }
  console.log('ROW_VERSION_REAL_SCHEMA_RESTORE_PASS baseline=20260727174805 post_baseline_replay=through_candidate smoke_quote_customer=SMOKE_PASS_ROLLBACK quote_lifecycle=draft-sent-sent stale_before_lifecycle=QUOTE_STALE_WRITE smoke_planned_holds=SMOKE_PASS_ROLLBACK');
} catch (error) {
  console.error(`ROW_VERSION_REAL_SCHEMA_RESTORE_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
