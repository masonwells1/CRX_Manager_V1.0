#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 proof for the parked pricing-audit migrations.
 * Restores the supported baseline, replays the ledger-selected migrations
 * through 20260810180002, executes the registered rollback smokes, and always
 * removes its disposable container. It never reads a database URL.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-pricing-audit-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const migrationsDir = path.join(ROOT, 'supabase', 'migrations');
const candidates = [
  '20260810180000_snapshot_cost_reporting.sql',
  '20260810180001_quote_items_cost_at_quote_snapshot.sql',
  '20260810180002_enforce_below_cost_admin_approval.sql',
].map((name) => path.join(migrationsDir, name));
const smokeFiles = [
  'smoke-below-cost-admin-wall.sql',
  'smoke-below-cost-quote-lifecycle.sql',
  'smoke-remaining-money-inventory-hardening.sql',
].map((name) => path.join(ROOT, 'scripts', 'smoke', name));
const unrelatedReplayExclusions = new Map([
  [
    path.join(migrationsDir, '20260810010308_active_team_note_assignment_actor.sql'),
    'already-live Team Board follow-up is pinned to an exact live predecessor body hash that the July baseline does not reconstruct',
  ],
]);

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 60 * 1024 * 1024,
    ...options,
  });
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    throw new Error(`${result.error?.message ?? ''}\n${result.stderr || result.stdout}`.trim());
  }
  return result;
}

function psql(sql, options = {}) {
  return docker(
    [
      'exec', '-i', NAME, 'psql', '-h', '127.0.0.1', '-U', options.user ?? 'postgres',
      '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
    ],
    { input: sql, allowFailure: options.allowFailure },
  );
}

function copy(local, name) {
  docker(['cp', local, `${NAME}:/tmp/${name}`]);
}

function apply(name, user) {
  psql(`\\i /tmp/${name}`, { user });
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForDatabase() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const ready = docker(
      ['exec', NAME, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres'],
      { allowFailure: true },
    );
    const probe = docker(
      ['exec', NAME, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'],
      { allowFailure: true },
    );
    if (ready.status === 0 && probe.stdout.trim() === '1') return;
    wait(500);
  }
  const logs = docker(['logs', NAME], { allowFailure: true });
  throw new Error(`disposable PostgreSQL failed readiness: ${logs.stderr || logs.stdout}`);
}

function selectedMigrations() {
  const result = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  const migrations = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((relative) => path.join(ROOT, relative));
  const finalIndex = migrations.indexOf(candidates.at(-1));
  assert.notEqual(finalIndex, -1, 'final pricing migration is absent from the ledger-selected replay');
  const throughPricing = migrations.slice(0, finalIndex + 1);
  for (const excluded of unrelatedReplayExclusions.keys()) {
    assert.ok(throughPricing.includes(excluded), `expected replay exclusion is absent: ${excluded}`);
  }
  const selected = throughPricing.filter((migration) => !unrelatedReplayExclusions.has(migration));
  assert.deepEqual(selected.slice(-3), candidates, 'pricing migrations must be the final ordered replay slice');
  return selected;
}

function expectRollbackMarker(file) {
  const result = psql(`\\i /tmp/${path.basename(file)}`, { allowFailure: true });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `${path.basename(file)} unexpectedly committed`);
  assert.match(output, /SMOKE_PASS_ROLLBACK/, `${path.basename(file)} missed SMOKE_PASS_ROLLBACK:\n${output}`);
}

function proveNonEmptyApprovedSetDrift() {
  const snapshot = path.basename(candidates[1]);
  const result = psql(
    `BEGIN;
     INSERT INTO public.customers (farm_name)
     VALUES ('[PROOF] approved-set drift') RETURNING id \\gset proof_customer_
     ALTER TABLE public.products DISABLE TRIGGER USER;
     INSERT INTO public.products (product_name, current_cost)
     VALUES ('[PROOF] approved-set drift', 1.00) RETURNING id \\gset proof_product_
     INSERT INTO public.quotes (
       quote_number, customer_id, created_by, tier, status,
       commission_split, total_price, total_cost, total_profit,
       total_margin_pct, valid_days, expires_at
     ) VALUES (
       '[PROOF] approved-set drift', :'proof_customer_id',
       '00000000-0000-4000-8000-000000000001', 1, 'sent',
       '{"splits":[]}'::jsonb, 1, 1, 0, 0, 15, CURRENT_DATE + 15
     ) RETURNING id \\gset proof_quote_
     INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
     VALUES (:'proof_quote_id', 'Proof', 0) RETURNING id \\gset proof_section_
     ALTER TABLE public.quote_items DISABLE TRIGGER USER;
     INSERT INTO public.quote_items (
       quote_id, section_id, product_id, sort_order, price_per_unit,
       current_cost, total_units_needed, total_price, profit, net_margin,
       cost_at_quote_cents
     ) VALUES (
       :'proof_quote_id', :'proof_section_id', :'proof_product_id', 0, 1,
       1, 1, 1, 0, 0, NULL
     );
     \\i /tmp/${snapshot}
     ROLLBACK;`,
    { allowFailure: true },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, 'non-empty unapproved quote-item population passed the migration guard');
  assert.match(output, /APPROVED_SET_DRIFTED/, `drift control missed APPROVED_SET_DRIFTED:\n${output}`);
}

try {
  for (const file of [...candidates, ...smokeFiles]) {
    assert.ok(readFileSync(file, 'utf8').length > 0, `missing required artifact ${file}`);
  }

  docker([
    'run', '-d', '--name', NAME, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m',
    '-e', 'POSTGRES_PASSWORD=postgres', IMAGE,
  ]);
  waitForDatabase();

  const artifacts = [
    '20260727174805_extensions.sql',
    '20260727174805_acl_lockdown.sql',
    '20260727174805_platform_overlay.sql',
    '20260727174805_cron_jobs.sql',
    '20260727174805_migration_history.sql',
  ];
  for (const artifact of artifacts) copy(path.join(BASELINE, artifact), artifact);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], {
    cwd: ROOT,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (schema.status !== 0) throw new Error(`baseline decompression failed: ${schema.stderr.toString()}`);

  apply('20260727174805_extensions.sql');
  // The live Supabase project supplies moddatetime in extensions. The July
  // restore artifact predates that prerequisite even though later migrations
  // use it, so install the same bundled extension in the disposable catalog.
  psql('CREATE EXTENSION IF NOT EXISTS moddatetime WITH SCHEMA extensions;');
  psql(schema.stdout.toString());
  psql(
    `CREATE SCHEMA IF NOT EXISTS storage;
     CREATE TABLE IF NOT EXISTS storage.buckets (
       id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
       file_size_limit bigint, allowed_mime_types text[]
     );
     CREATE TABLE IF NOT EXISTS storage.objects (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL,
       name text NOT NULL, owner_id text
     );
     CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
       LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
     CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text
       LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`,
    { user: 'supabase_admin' },
  );
  apply('20260727174805_acl_lockdown.sql');
  apply('20260727174805_platform_overlay.sql', 'supabase_admin');
  apply('20260727174805_cron_jobs.sql');
  psql(
    `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
     CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
       version text PRIMARY KEY, name text NOT NULL, statements text[]
     );`,
  );
  apply('20260727174805_migration_history.sql');

  const migrations = selectedMigrations();
  for (const [index, migration] of migrations.entries()) {
    const name = `migration-${index}.sql`;
    copy(migration, name);
    // Supabase applies each migration in its own transaction. Mirror that
    // contract so SET LOCAL, transaction-scoped advisory locks, and explicit
    // LOCK TABLE guards execute exactly as they do in the managed runner.
    psql(`BEGIN;\n\\i /tmp/${name}\nCOMMIT;`);
  }

  psql(
    `ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
     CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
     CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
     GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;`,
    { user: 'supabase_admin' },
  );
  psql(
    `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
       ('00000000-0000-4000-8000-000000000001', 'pricing-admin@example.invalid', '{"full_name":"Below Cost Admin","role":"admin"}'),
       ('00000000-0000-4000-8000-000000000002', 'pricing-sales@example.invalid', '{"full_name":"Below Cost Sales","role":"sales_rep"}'),
       ('00000000-0000-4000-8000-000000000003', 'pricing-backup-admin@example.invalid', '{"full_name":"Pricing Backup Admin","role":"admin"}')
     ON CONFLICT (id) DO NOTHING;
     INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES
       ('00000000-0000-4000-8000-000000000001', 'pricing-admin@example.invalid', 'Below Cost Admin', 'admin', true),
       ('00000000-0000-4000-8000-000000000002', 'pricing-sales@example.invalid', 'Below Cost Sales', 'sales_rep', true),
       ('00000000-0000-4000-8000-000000000003', 'pricing-backup-admin@example.invalid', 'Pricing Backup Admin', 'admin', true)
     ON CONFLICT (id) DO UPDATE
       SET full_name = EXCLUDED.full_name, role = EXCLUDED.role, is_active = true;`,
  );

  for (const candidate of candidates) copy(candidate, path.basename(candidate));
  proveNonEmptyApprovedSetDrift();
  for (const file of smokeFiles) {
    copy(file, path.basename(file));
    expectRollbackMarker(file);
  }

  const residue = psql(
    `\\pset tuples_only on
     \\pset format unaligned
     SELECT count(*) FROM (
       SELECT id FROM public.customers WHERE farm_name LIKE '[SMOKE]%' OR farm_name LIKE '[PROOF]%'
       UNION ALL
       SELECT id FROM public.products WHERE product_name LIKE '[SMOKE]%' OR product_name LIKE '[PROOF]%'
     ) AS residue;`,
  ).stdout.trim();
  assert.equal(residue, '0', 'rollback smoke/proof fixtures left durable residue');

  console.log(
    `PRICING_AUDIT_REAL_SCHEMA_PASS migrations=${migrations.length} ` +
    `unrelated_live_bound_exclusions=${unrelatedReplayExclusions.size} ` +
    'approved_set_empty=PASS approved_set_nonempty_drift=APPROVED_SET_DRIFTED ' +
    'smoke_below_cost_admin=SMOKE_PASS_ROLLBACK ' +
    'smoke_quote_lifecycle=SMOKE_PASS_ROLLBACK ' +
    'smoke_profitability_inventory=SMOKE_PASS_ROLLBACK residue=0',
  );
} catch (error) {
  console.error(`PRICING_AUDIT_REAL_SCHEMA_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
