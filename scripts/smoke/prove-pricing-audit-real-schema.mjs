#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 proof for the applied pricing-audit migrations.
 * Restores the supported baseline, replays the exact captured live ledger in
 * assigned-version order through the captured high-water. The snapshot pins every
 * post-baseline ledger row to Supabase's stored SQL hash; the current release
 * tail is also required to match repository source byte-for-byte. The proof
 * runs the registered rollback smokes and always removes its disposable
 * container. It never reads a database URL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-pricing-audit-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const migrationsDir = path.join(ROOT, 'supabase', 'migrations');
const ledgerSnapshotFile = path.join(ROOT, 'scripts', 'smoke', 'pricing-audit-live-ledger.json');
const schemaRegistryFile = path.join(ROOT, '.claude', 'schema-registry.json');
const exactLiveSourceRequiredSince = '20260809130108';
// The live cent repair contains a private 35-row production preimage that must
// not be published in this public repository. Its replacement is not a loose
// exemption: both the applied private payload and the reviewed public replay
// source are exact byte/hash-bound here, and the latter is executed below.
const sensitiveAppliedReplaySubstitutions = new Map([
  ['20260812154757', {
    appliedBytes: 18770,
    appliedSha256: '7498b0befab4cd6355560cf9dc29c270a3e0098d2327d24d7eb7ab13d0d927ca',
    publicBytes: 13823,
    publicSha256: '7e101fd6aba776732676df3989be5429e5e4bd09d939d11f62e738d390444a49',
  }],
]);
const appliedPricingMigrations = [
  '20260812145628_snapshot_cost_reporting.sql',
  '20260812151606_quote_items_cost_at_quote_snapshot.sql',
  '20260812154028_enforce_below_cost_admin_approval.sql',
  '20260812154757_repair_historical_order_line_cents.sql',
].map((name) => path.join(migrationsDir, name));
const smokeFiles = [
  'smoke-below-cost-admin-wall.sql',
  'smoke-below-cost-quote-lifecycle.sql',
  'smoke-remaining-money-inventory-hardening.sql',
].map((name) => path.join(ROOT, 'scripts', 'smoke', name));
const oneShotDataReplayExclusions = new Map([
  [
    '20260810025159',
    'already-live row rewrite is registered as one-shot data; a schema-only disposable has no approved production population to rewrite',
  ],
]);
const pendingCandidateMigrationExclusions = new Map([
  ['20260813015000_wave_a_order_cost_authority_and_finiteness.sql', 'Wave A money candidate'],
  ['20260813020000_round_order_header_money.sql', 'Wave A money candidate'],
  ['20260813030000_reject_non_finite_money_and_quantities.sql', 'Wave A money candidate'],
  ['20260813040000_clamp_negative_commission_remainder.sql', 'Wave A money candidate'],
  ['20260813050000_guard_job_commission_split_immutable.sql', 'Wave A money candidate'],
  [
    '20260813053545_allocate_multi_price_quote_draws.sql',
    'pricing follow-up: cent-exact same-product multi-price partial draws',
  ],
  ['20260813060000_require_completed_delivery_before_invoice_post.sql', 'Wave A money candidate'],
]);
const pendingCandidateMigrations = [...pendingCandidateMigrationExclusions.keys()]
  .map((name) => path.join(migrationsDir, name));

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

function normalizedSql(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function sourceFingerprint(file) {
  const sql = normalizedSql(file);
  return {
    bytes: Buffer.byteLength(sql, 'utf8'),
    sha256: createHash('sha256').update(sql, 'utf8').digest('hex'),
  };
}

function resolveLiveSource(entry, migrationNames) {
  const submittedFilename = /^\d{14}_.+/.test(entry.name) ? `${entry.name}.sql` : null;
  const suffix = entry.name.replace(/^\d{14}_/, '');
  const candidatesForEntry = new Set([
    submittedFilename,
    `${entry.version}_${suffix}.sql`,
    ...migrationNames.filter((name) => name.startsWith(`${entry.version}_`)),
  ].filter(Boolean));
  const matches = [...candidatesForEntry].filter((name) => migrationNames.includes(name));
  assert.equal(
    matches.length,
    1,
    `live migration ${entry.version}/${entry.name} must resolve to exactly one immutable repository source`,
  );
  return path.join(migrationsDir, matches[0]);
}

function selectedMigrations() {
  const ledger = JSON.parse(readFileSync(ledgerSnapshotFile, 'utf8'));
  const registry = JSON.parse(readFileSync(schemaRegistryFile, 'utf8'));
  assert.equal(ledger.project_id, 'rhyzpcqhnizqbxphqdkr', 'live-ledger snapshot targets the wrong project');
  assert.equal(
    ledger.baseline_high_water,
    '20260727174805',
    'live-ledger snapshot no longer matches the restored baseline',
  );
  assert.equal(ledger.entries.length, 56, 'captured post-baseline live ledger row count drifted');
  assert.equal(
    ledger.entries.at(-1)?.version,
    ledger.live_high_water,
    'captured live high-water is not the final ordered ledger entry',
  );
  assert.equal(
    registry._meta?.migrations_high_water,
    ledger.live_high_water,
    'schema registry and captured live ledger high-water differ; refresh both before proving pricing',
  );

  const appliedNames = new Set(registry._meta?.applied_migration_names ?? []);
  const migrationNames = readdirSync(migrationsDir)
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .sort();
  for (const [filename, purpose] of pendingCandidateMigrationExclusions) {
    assert.ok(migrationNames.includes(filename), `${purpose} exclusion is missing: ${filename}`);
    const stem = path.basename(filename, '.sql');
    assert.ok(!appliedNames.has(stem), `${purpose} exclusion is now applied and must join the captured ledger: ${filename}`);
    assert.ok(
      filename.slice(0, 14) > ledger.live_high_water,
      `${purpose} exclusion is not ordered above the captured live high-water: ${filename}`,
    );
  }
  const ordered = ledger.entries.map((entry, index) => {
    if (index > 0) {
      assert.ok(
        ledger.entries[index - 1].version < entry.version,
        `captured live ledger is not strictly ordered at ${entry.version}`,
      );
    }
    assert.ok(appliedNames.has(entry.name), `schema registry is missing live migration ${entry.name}`);
    assert.match(entry.statement_sha256, /^[0-9a-f]{64}$/, `${entry.version} has an invalid live SQL hash`);
    assert.ok(entry.statement_bytes > 0, `${entry.version} has an invalid live SQL byte length`);
    const file = resolveLiveSource(entry, migrationNames);
    const fingerprint = sourceFingerprint(file);
    const replaySubstitution = sensitiveAppliedReplaySubstitutions.get(entry.version);
    if (replaySubstitution) {
      assert.equal(entry.statement_bytes, replaySubstitution.appliedBytes,
        `${entry.version} captured applied byte length drifted`);
      assert.equal(entry.statement_sha256, replaySubstitution.appliedSha256,
        `${entry.version} captured applied hash drifted`);
      assert.equal(fingerprint.bytes, replaySubstitution.publicBytes,
        `${path.basename(file)} public replay byte length drifted`);
      assert.equal(fingerprint.sha256, replaySubstitution.publicSha256,
        `${path.basename(file)} public replay hash drifted`);
    } else if (entry.version >= exactLiveSourceRequiredSince) {
      assert.equal(
        fingerprint.bytes,
        entry.statement_bytes,
        `${path.basename(file)} byte length differs from Supabase's stored live statement`,
      );
      assert.equal(
        fingerprint.sha256,
        entry.statement_sha256,
        `${path.basename(file)} SHA-256 differs from Supabase's stored live statement`,
      );
    }
    return { ...entry, file };
  });

  for (const version of [
    ...oneShotDataReplayExclusions.keys(),
  ]) {
    assert.ok(ordered.some((entry) => entry.version === version), `replay exclusion ${version} is not live`);
  }

  const oneShotRegistry = JSON.parse(
    readFileSync(path.join(BASELINE, 'one-shot-migrations.json'), 'utf8'),
  ).one_shot ?? {};
  for (const version of oneShotDataReplayExclusions.keys()) {
    const entry = ordered.find((candidate) => candidate.version === version);
    const stem = path.basename(entry.file, '.sql');
    assert.equal(
      typeof oneShotRegistry[stem],
      'string',
      `${stem} is excluded as one-shot data but is absent from the one-shot registry`,
    );
  }

  const result = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr);
  const selected = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((relative) => path.basename(relative))
    .sort();
  const expectedSelected = [
    ...ordered
      .filter((entry) => !oneShotDataReplayExclusions.has(entry.version))
      .map((entry) => path.basename(entry.file)),
    ...pendingCandidateMigrationExclusions.keys(),
  ].sort();
  assert.deepEqual(
    selected,
    expectedSelected,
    'post-baseline selector contains an unknown pending migration or omits a captured live/candidate source',
  );

  return { ledger, ordered };
}

function recordLedgerEntry(entry) {
  const name = entry.name.replaceAll("'", "''");
  psql(
    `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
     VALUES ('${entry.version}', '${name}', ARRAY[]::text[])
     ON CONFLICT (version) DO NOTHING;`,
  );
}

function expectRollbackMarker(file) {
  const result = psql(`\\i /tmp/${path.basename(file)}`, { allowFailure: true });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `${path.basename(file)} unexpectedly committed`);
  assert.match(output, /SMOKE_PASS_ROLLBACK/, `${path.basename(file)} missed SMOKE_PASS_ROLLBACK:\n${output}`);
}

function proveNonEmptyApprovedSetDrift() {
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
     ${normalizedSql(appliedPricingMigrations[1])}
     ROLLBACK;`,
    { allowFailure: true },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, 'non-empty unapproved quote-item population passed the migration guard');
  assert.match(output, /APPROVED_SET_DRIFTED/, `drift control missed APPROVED_SET_DRIFTED:\n${output}`);
}

try {
  for (const file of [...appliedPricingMigrations, ...pendingCandidateMigrations, ...smokeFiles]) {
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

  const plan = selectedMigrations();
  let replayedLiveMigrations = 0;
  for (const [index, entry] of plan.ordered.entries()) {
    if (
      oneShotDataReplayExclusions.has(entry.version)
    ) {
      recordLedgerEntry(entry);
      continue;
    }
    // Supabase applies each migration in its own transaction. Mirror that
    // contract so SET LOCAL, transaction-scoped advisory locks, and explicit
    // LOCK TABLE guards execute exactly as they do in the managed runner. Feed
    // canonical LF bytes directly so Windows checkout line endings cannot
    // change pg_proc.prosrc hashes inside the disposable database.
    psql(`BEGIN;\n${normalizedSql(entry.file)}\nCOMMIT;`);
    recordLedgerEntry(entry);
    replayedLiveMigrations += 1;
  }

  const reconstructedLedger = psql(
    `\\pset tuples_only on
     \\pset format unaligned
     SELECT count(*) || ':' || max(version)
       FROM supabase_migrations.schema_migrations;`,
  ).stdout.trim();
  assert.equal(
    reconstructedLedger,
    `${plan.ledger.live_ledger_rows}:${plan.ledger.live_high_water}`,
    'reconstructed disposable ledger does not match the captured live count/high-water',
  );

  // The four pricing/cent-repair migrations are part of the captured live
  // ledger above and were replayed in their server-assigned order. The repair
  // takes its schema-only no-op path in this data-free reconstruction and must
  // still install its validated constraint.
  const centRepairConstraint = psql(
    `\\pset tuples_only on
     \\pset format unaligned
     SELECT count(*)
       FROM pg_constraint
      WHERE conrelid = 'public.order_items'::regclass
        AND conname = 'order_items_total_price_whole_cents_chk'
        AND contype = 'c'
        AND convalidated;`,
  ).stdout.trim();
  assert.equal(
    centRepairConstraint,
    '1',
    'schema-only cent-repair path did not install its validated constraint',
  );

  // The Wave A migration postconditions deliberately execute real allow and
  // deny paths. A schema-only reconstruction has no office data to select, so
  // install the smallest finite, whole-cent fixture set that can exercise those
  // paths. The fixed ids keep failures reproducible. session_replication_role is
  // used only while constructing the fixture: in particular, it preserves the
  // historical NULL job-split shape that the new immutable-split guard must
  // prove it can fill. Every migration and every behavioural probe below runs
  // with ordinary triggers enabled.
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
       ('00000000-0000-4000-8000-000000000003', 'pricing-backup-admin@example.invalid', '{"full_name":"Pricing Backup Admin","role":"admin"}'),
       ('00000000-0000-4000-8000-000000000004', 'pricing-backup-sales@example.invalid', '{"full_name":"Pricing Backup Sales","role":"sales_rep"}')
     ON CONFLICT (id) DO NOTHING;

     INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES
       ('00000000-0000-4000-8000-000000000001', 'pricing-admin@example.invalid', 'Below Cost Admin', 'admin', true),
       ('00000000-0000-4000-8000-000000000002', 'pricing-sales@example.invalid', 'Below Cost Sales', 'sales_rep', true),
       ('00000000-0000-4000-8000-000000000003', 'pricing-backup-admin@example.invalid', 'Pricing Backup Admin', 'admin', true),
       ('00000000-0000-4000-8000-000000000004', 'pricing-backup-sales@example.invalid', 'Pricing Backup Sales', 'sales_rep', true)
     ON CONFLICT (id) DO UPDATE
       SET full_name = EXCLUDED.full_name, role = EXCLUDED.role, is_active = true;

     BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO public.customers (id, farm_name)
     VALUES ('00000000-0000-4000-9000-000000000010', '[CHAIN] Wave A proof customer');
     INSERT INTO public.quotes (
       id, quote_number, customer_id, created_by, status, commission_split
     ) VALUES (
       '00000000-0000-4000-9000-000000000011', '[CHAIN]-QUOTE',
       '00000000-0000-4000-9000-000000000010',
       '00000000-0000-4000-8000-000000000001', 'draft', NULL
     );
     INSERT INTO public.orders (
       id, order_number, customer_id, status, pricing_status, order_date
     ) VALUES (
       '00000000-0000-4000-9000-000000000012', '[CHAIN]-ORDER',
       '00000000-0000-4000-9000-000000000010', 'confirmed', 'priced', CURRENT_DATE
     );
     INSERT INTO public.jobs (
       id, job_number, customer_id, job_date, quote_id, commission_split
     ) VALUES
       (
         '00000000-0000-4000-9000-000000000013', '[CHAIN]-JOB-SET',
         '00000000-0000-4000-9000-000000000010', CURRENT_DATE, NULL,
         '{"splits":[{"recipient":"Below Cost Admin","recipient_user_id":"00000000-0000-4000-8000-000000000001","percentage":100}]}'::jsonb
       ),
       (
         '00000000-0000-4000-9000-000000000014', '[CHAIN]-JOB-NULL',
         '00000000-0000-4000-9000-000000000010', CURRENT_DATE,
         '00000000-0000-4000-9000-000000000011', NULL
       );
     INSERT INTO public.deliveries (
       id, delivery_number, order_id, customer_id, created_by,
       scheduled_date, status, completed_at, signed_by
     ) VALUES (
       '00000000-0000-4000-9000-000000000015', '[CHAIN]-DELIVERY',
       '00000000-0000-4000-9000-000000000012',
       '00000000-0000-4000-9000-000000000010',
       '00000000-0000-4000-8000-000000000001',
       CURRENT_DATE, 'completed', now(), 'Below Cost Admin'
     );
     INSERT INTO public.invoices (
       id, invoice_number, order_id, customer_id, delivery_id,
       invoice_type, status, created_by, invoice_date,
       total_amount_cents, total_cost_cents, pricing_pending
     ) VALUES (
       '00000000-0000-4000-9000-000000000016', '[CHAIN]-INVOICE',
       '00000000-0000-4000-9000-000000000012',
       '00000000-0000-4000-9000-000000000010',
       '00000000-0000-4000-9000-000000000015',
       'chemical_sale', 'draft',
       '00000000-0000-4000-8000-000000000001', CURRENT_DATE,
       0, 0, false
     );
     SET LOCAL session_replication_role = origin;
     COMMIT;`,
  );

  // Prove the complete next ordered migration slice against the pricing schema,
  // even though Wave A and the pricing follow-up are deliberately absent from
  // the captured live ledger.
  // This catches name/body overlaps that isolated candidate proofs miss (for
  // example, replacing a governed public wrapper instead of its private impl).
  for (const file of pendingCandidateMigrations) {
    try {
      psql(`BEGIN;\n${normalizedSql(file)}\nCOMMIT;`);
    } catch (error) {
      throw new Error(`pending ordered migration failed: ${path.basename(file)}\n${error.message}`);
    }
  }
  const waveAWrapperCompatibility = psql(
    `\\pset tuples_only on
     \\pset format unaligned
     SELECT count(*)
       FROM pg_proc wrapper
       JOIN pg_namespace wrapper_ns ON wrapper_ns.oid = wrapper.pronamespace
      WHERE wrapper_ns.nspname = 'public'
        AND wrapper.proname = 'create_direct_order'
        AND position('_begin_below_cost_money_write' in wrapper.prosrc) > 0
        AND position('_create_direct_order_below_cost_impl_20260810' in wrapper.prosrc) > 0
        AND EXISTS (
          SELECT 1
            FROM pg_proc impl
            JOIN pg_namespace impl_ns ON impl_ns.oid = impl.pronamespace
           WHERE impl_ns.nspname = 'public'
             AND impl.proname = '_create_direct_order_below_cost_impl_20260810'
             AND position('v_norm_items' in impl.prosrc) > 0
        );`,
  ).stdout.trim();
  assert.equal(
    waveAWrapperCompatibility,
    '1',
    'Wave A did not preserve the governed below-cost wrapper over its authoritative-cost implementation',
  );

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
    `PRICING_AUDIT_CAPTURED_LIVE_LEDGER_SCHEMA_PASS captured_live_high_water=${plan.ledger.live_high_water} ` +
    `live_ledger_rows=${plan.ledger.live_ledger_rows} live_statement_hashes=${plan.ordered.length} ` +
    `recent_exact_sources=${plan.ordered.filter((entry) => entry.version >= exactLiveSourceRequiredSince).length} ` +
    `live_replayed=${replayedLiveMigrations} pricing_applied=${appliedPricingMigrations.length} ` +
    `pending_candidates_applied=${pendingCandidateMigrations.length} ` +
    `one_shot_data_exclusions=${oneShotDataReplayExclusions.size} ` +
    `sensitive_replay_substitutions=${sensitiveAppliedReplaySubstitutions.size} ` +
    'wave_a_below_cost_wrapper=PASS approved_set_empty=PASS cent_repair_empty=PASS approved_set_nonempty_drift=APPROVED_SET_DRIFTED ' +
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
