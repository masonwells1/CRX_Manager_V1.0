#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-return-credit-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const EXTENSIONS = path.join(ROOT, 'supabase', 'baselines', '20260727174805_extensions.sql');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260812130145_bind_return_receipts_to_intent_and_restore_overdue.sql');
const HELPER_GUARD = path.join(ROOT, 'supabase', 'migrations', '20260813070000_pin_return_idempotency_helper_contract.sql');
const FORWARD_COMPATIBILITY_REPLAY = [
  '20260813060000_require_completed_delivery_before_invoice_post.sql',
].map((name) => path.join(ROOT, 'scripts', '.staging-migrations', name));
const SMOKE = path.join(ROOT, 'scripts', 'smoke', 'smoke-return-credit-chain.sql');
const PREDICATE = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'return-credit-intent-binding.sql');
const LIFECYCLE_PREDICATE = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates', 'returns-lifecycle-rpc-owned.sql');
const LIVE_SCHEMA = path.join(ROOT, '.claude', 'session-state', 'section08-live-schema.sql');

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 80 * 1024 * 1024, ...options });
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    throw new Error(`${result.error?.message ?? ''}\n${result.stderr || result.stdout}`.trim());
  }
  return result;
}
function psql(sql, options = {}) {
  return docker(
    ['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, allowFailure: options.allowFailure },
  );
}
function psqlValue(sql) {
  return docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]).stdout.trim();
}
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
function apply(name, user) { psql(`BEGIN;\n\\i /tmp/${name}\nCOMMIT;`, { user }); }
function applyStandalone(name, user) { psql(`\\i /tmp/${name}`, { user }); }
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForDatabase() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const ready = docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'], { allowFailure: true });
    if (ready.status === 0 && ready.stdout.trim() === '1') return;
    wait(500);
  }
  throw new Error(`disposable PostgreSQL failed readiness: ${docker(['logs', NAME], { allowFailure: true }).stderr}`);
}
function sanitizeCliOutput(value) {
  let safe = String(value || '');
  for (const secret of [process.env.SUPABASE_ACCESS_TOKEN, process.env.SUPABASE_DB_PASSWORD]) {
    if (secret) safe = safe.split(secret).join('[REDACTED]');
  }
  return safe
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:sbp|sb_secret)_[A-Za-z0-9._-]+\b/g, '[REDACTED]')
    .slice(0, 4000);
}
function refreshLiveSchema() {
  const commonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' });
  if (commonDir.status !== 0) throw new Error(`cannot locate linked checkout: ${commonDir.stderr}`);
  const linkedRoot = path.dirname(path.resolve(ROOT, commonDir.stdout.trim()));
  // `supabase db dump --file` appends when the target already exists. Replace
  // the disposable snapshot so an interrupted/repeated proof cannot replay a
  // duplicated schema and report a false database failure.
  rmSync(LIVE_SCHEMA, { force: true });
  const dump = spawnSync(
    'supabase',
    ['db', 'dump', '--linked', '--workdir', linkedRoot, '--schema', 'public,auth', '--file', LIVE_SCHEMA, '--keep-comments'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  if (dump.status !== 0) {
    throw new Error(`fresh read-only live schema dump failed: ${sanitizeCliOutput(dump.stderr || dump.stdout)}`);
  }
}
function forwardReplayState(migration) {
  const name = path.basename(migration);
  if (name !== '20260813060000_require_completed_delivery_before_invoice_post.sql') {
    throw new Error(`no installed-state detector for forward replay migration: ${name}`);
  }
  return psqlValue(`
    SELECT CASE
      WHEN bool_or(position('WAVE-A-DELIVERY-BEFORE-BILLING-2026-08-11' in p.prosrc) > 0)
       AND count(*) = 1
       AND bool_and(
         p.pronargs = 2
         AND p.proargtypes[0] = 'uuid'::regtype
         AND p.proargtypes[1] = 'text'::regtype
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
         AND NOT EXISTS (
           SELECT 1 FROM pg_roles r
            WHERE r.rolname IN ('anon', 'authenticated', 'service_role', 'metabase_ro')
              AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
         )
       ) THEN 'installed'
      WHEN bool_or(position('WAVE-A-DELIVERY-BEFORE-BILLING-2026-08-11' in p.prosrc) > 0)
        THEN 'drifted'
      ELSE 'pending'
    END
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = '_post_invoice_impl_20260714';
  `);
}
try {
  assert.ok(readFileSync(CANDIDATE, 'utf8').length > 0, 'candidate migration is missing');
  assert.ok(readFileSync(HELPER_GUARD, 'utf8').length > 0, 'helper guard migration is missing');
  for (const migration of FORWARD_COMPATIBILITY_REPLAY) {
    assert.ok(readFileSync(migration, 'utf8').length > 0, `forward replay migration is missing: ${path.basename(migration)}`);
  }
  assert.match(readFileSync(SMOKE, 'utf8'), /SMOKE_PASS_ROLLBACK/, 'canonical smoke lacks its rollback marker');
  refreshLiveSchema();
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  waitForDatabase();
  wait(2000);
  waitForDatabase();

  assert.ok(existsSync(LIVE_SCHEMA), 'fresh read-only live schema dump is required at .claude/session-state/section08-live-schema.sql');
  copy(EXTENSIONS, 'extensions.sql');
  apply('extensions.sql');
  psql('DROP SCHEMA auth CASCADE;', { user: 'supabase_admin' });
  psql('DROP SCHEMA public CASCADE;');
  const liveSchema = readFileSync(LIVE_SCHEMA, 'utf8')
    .replace(/OWNER TO "[^"]+";/g, 'OWNER TO postgres;')
    .replace(/FOR ROLE "[^"]+"/g, 'FOR ROLE "postgres"');
  psql(liveSchema);
  const predicate = readFileSync(PREDICATE, 'utf8').trim().replace(/;$/, '');
  const preApplyViolations = psqlValue(`SELECT count(*) FROM (${predicate}) AS violations;`);
  const wasAlreadyInstalled = preApplyViolations === '0';
  const migrations = [];
  if (preApplyViolations !== '0') {
    copy(CANDIDATE, 'candidate.sql');
    apply('candidate.sql');
    migrations.push(CANDIDATE);
  }
  const pendingForwardMigrations = [];
  for (const migration of FORWARD_COMPATIBILITY_REPLAY) {
    const forwardState = forwardReplayState(migration);
    assert.notEqual(forwardState, 'drifted', `installed forward migration contract drifted: ${path.basename(migration)}`);
    assert.ok(['installed', 'pending'].includes(forwardState), `unknown forward migration state ${forwardState}: ${path.basename(migration)}`);
    if (forwardState === 'pending') pendingForwardMigrations.push(migration);
  }
  // 060000 carries an apply-time behavioural probe that requires one active
  // admin and one postable delivery-linked draft. The live-schema dump is
  // intentionally schema-only, so create an isolated synthetic row chain.
  // The disposable container is destroyed in finally; no production row is read
  // or written and none of these fixed UUIDs can leave residue.
  if (pendingForwardMigrations.length > 0) psql(`
    INSERT INTO auth.users (id, email, created_at, updated_at, raw_user_meta_data)
    VALUES (
      '00000000-0000-4000-8000-000000000091',
      'forward-replay-admin@example.invalid', now(), now(),
      '{"full_name":"Forward Replay Admin","role":"admin"}'::jsonb
    );
    -- handle_new_user creates the matching active admin profile from metadata.
    -- Do not update that row afterward: the profile-role lock correctly refuses
    -- out-of-session identity edits even in this disposable database.
    SELECT set_config(
      'request.jwt.claims',
      '{"sub":"00000000-0000-4000-8000-000000000091","role":"authenticated"}',
      false
    );
    INSERT INTO public.customers (id, farm_name)
    VALUES ('00000000-0000-4000-8000-000000000092', '[SMOKE] Forward Replay Farm');
    INSERT INTO public.products (id, product_name, unit_size)
    VALUES (
      '00000000-0000-4000-8000-000000000093', '[SMOKE] Forward Replay Product', 'GL'
    );
    DO $fixture_pricing$
    DECLARE
      v_preview jsonb;
    BEGIN
      v_preview := public.preview_product_pricing_changes(
        'product_page', NULL,
        jsonb_build_array(jsonb_build_object(
          'product_id', '00000000-0000-4000-8000-000000000093',
          'row_version', 1, 'pricing_mode', 'price_driven',
          'new_cost', '6.00', 'tier1_price', '10.00',
          'tier2_price', '10.00', 'tier3_price', '10.00'
        )),
        '00000000-0000-4000-8000-000000000091',
        'smk-forward-replay-pricing-preview'
      );
      PERFORM public.apply_product_pricing_change_set(
        (v_preview->>'change_set_id')::uuid,
        v_preview->>'request_fingerprint',
        '00000000-0000-4000-8000-000000000091',
        'smk-forward-replay-pricing-apply'
      );
    END
    $fixture_pricing$;
    INSERT INTO public.inventory (
      product_id, location, quantity_available, quantity_prebooked, unit_size
    ) VALUES (
      '00000000-0000-4000-8000-000000000093', 'Main Warehouse', 50, 1, 'GL'
    );
    INSERT INTO public.orders (
      id, order_number, customer_id, salesman_id, order_date, status, booking_draw
    ) VALUES (
      '00000000-0000-4000-8000-000000000094', 'SMK-FORWARD-REPLAY',
      '00000000-0000-4000-8000-000000000092',
      '00000000-0000-4000-8000-000000000091', current_date, 'confirmed', false
    );
    INSERT INTO public.order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining, unit_size
    ) VALUES (
      '00000000-0000-4000-8000-000000000095',
      '00000000-0000-4000-8000-000000000094',
      '00000000-0000-4000-8000-000000000093', '[SMOKE] Forward Replay Product',
      10, 6, 1, 10, 4, 40, 0, 1, 'GL'
    );
    INSERT INTO public.deliveries (
      id, delivery_number, order_id, customer_id, scheduled_date, status, created_by
    ) VALUES (
      '00000000-0000-4000-8000-000000000096', 'SMK-FORWARD-REPLAY-D',
      '00000000-0000-4000-8000-000000000094',
      '00000000-0000-4000-8000-000000000092', current_date, 'scheduled',
      '00000000-0000-4000-8000-000000000091'
    );
    INSERT INTO public.delivery_items (
      delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size
    ) VALUES (
      '00000000-0000-4000-8000-000000000096',
      '00000000-0000-4000-8000-000000000095',
      '00000000-0000-4000-8000-000000000093', 1, 1, 'GL'
    );
    UPDATE public.invoices
       SET delivery_id = '00000000-0000-4000-8000-000000000096'
     WHERE order_id = '00000000-0000-4000-8000-000000000094'
       AND status = 'draft';
    UPDATE public.deliveries
       SET status = 'in_progress'
     WHERE id = '00000000-0000-4000-8000-000000000096';
    UPDATE public.deliveries
       SET status = 'completed', completed_at = now(), signed_by = '[SMOKE] Forward Replay Receiver'
     WHERE id = '00000000-0000-4000-8000-000000000096';
    INSERT INTO public.invoices (
      id, invoice_number, customer_id, order_id, delivery_id, invoice_type,
      status, invoice_date, due_date, total_amount_cents, total_cost_cents,
      created_by
    ) VALUES (
      '00000000-0000-4000-8000-000000000097', 'SMK-FORWARD-REPLAY-I',
      '00000000-0000-4000-8000-000000000092',
      '00000000-0000-4000-8000-000000000094',
      '00000000-0000-4000-8000-000000000096', 'chemical_sale',
      'draft', current_date, current_date + 30, 1000, 600,
      '00000000-0000-4000-8000-000000000091'
    );
    INSERT INTO public.invoice_items (
      invoice_id, product_id, description, quantity, unit_price_cents,
      extended_cents, cost_cents
    ) VALUES (
      '00000000-0000-4000-8000-000000000097',
      '00000000-0000-4000-8000-000000000093', '[SMOKE] Forward Replay Product',
      1, 1000, 1000, 600
    );
    SELECT set_config('request.jwt.claims', '', false);
  `);
  // Targeted rebuild-order proof for the one later migration that inspects the
  // reversal helper. The five earlier Wave A files are unrelated parked drafts
  // with independent stale preconditions; treating them as apply-ready here
  // would silently widen this remediation. This file remains unapplied live.
  for (const migration of pendingForwardMigrations) {
    const name = path.basename(migration);
    copy(migration, name);
    applyStandalone(name);
    migrations.push(migration);
  }
  copy(HELPER_GUARD, 'helper-guard.sql');
  apply('helper-guard.sql');
  migrations.push(HELPER_GUARD);
  assert.equal(psqlValue(`SELECT count(*) FROM (${predicate}) AS violations;`), '0', 'return-credit invariant reported candidate-state drift');
  const lifecyclePredicate = readFileSync(LIFECYCLE_PREDICATE, 'utf8').trim().replace(/;$/, '');
  const lifecycleViolations = psqlValue(`SELECT violation_key || ': ' || reason FROM (${lifecyclePredicate}) AS violations ORDER BY violation_key;`);
  assert.equal(lifecycleViolations, '', `existing returns lifecycle invariant reported candidate-state drift:\n${lifecycleViolations}`);
  psql(`
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('00000000-0000-4000-8000-000000000081', 'return-credit-admin-a@example.invalid', '{"full_name":"Return Credit Admin A","role":"admin"}'),
      ('00000000-0000-4000-8000-000000000082', 'return-credit-admin-b@example.invalid', '{"full_name":"Return Credit Admin B","role":"admin"}')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (id, email, role, is_active) VALUES
      ('00000000-0000-4000-8000-000000000081', 'return-credit-admin-a@example.invalid', 'admin', true),
      ('00000000-0000-4000-8000-000000000082', 'return-credit-admin-b@example.invalid', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f', 'legacy-return-actor@example.invalid', '{"full_name":"Legacy Return Actor","role":"admin"}')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (id, email, role, is_active) VALUES
      ('22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f', 'legacy-return-actor@example.invalid', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
    INSERT INTO public.customers (id, farm_name) VALUES
      ('df6087cb-232f-4962-bb33-c74580a06935', '[SMOKE] Exact Legacy Return Customer')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.products (id, product_name) VALUES
      ('fad3ea45-cd8c-4bb8-b0ce-8a515941586c', 'Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal')
    ON CONFLICT (id) DO NOTHING;
    SELECT set_config('app.return_rpc', 'true', false);
    INSERT INTO public.returns (
      id, return_number, customer_id, order_id, reason, requested_by,
      approved_by, status, created_at, requested_at, approved_at, total_credit_cents
    ) VALUES (
      '0cb556ed-467a-4949-866d-8d9edbb09522', 'RMA-2026-0001',
      'df6087cb-232f-4962-bb33-c74580a06935', NULL, 'overstock',
      '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f', '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f',
      'approved', '2026-04-30 20:48:18.967975+00', '2026-04-30 20:48:18.967975+00',
      '2026-07-10 16:45:29.044351+00', 0
    );
    INSERT INTO public.return_items (
      id, return_id, order_item_id, product_id, product_name, quantity, unit,
      unit_price_cents, extended_cents, condition, restock, restocked,
      sort_order, notes, created_at
    ) VALUES (
      'c4f6cc7d-0bbd-4c25-8bc0-c2c9e84aaadd', '0cb556ed-467a-4949-866d-8d9edbb09522', NULL,
      'fad3ea45-cd8c-4bb8-b0ce-8a515941586c', 'Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal',
      15.00, 'ea', 7597, 113955, 'unopened', true, false, 0, NULL,
      '2026-04-30 20:48:19.173027+00'
    );
    SELECT set_config('app.return_rpc', 'false', false);
  `);

  copy(SMOKE, path.basename(SMOKE));
  const smoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const output = `${smoke.stdout}\n${smoke.stderr}`;
  assert.notEqual(smoke.status, 0, 'canonical return-credit smoke committed instead of forcing rollback');
  assert.match(output, /SMOKE_PASS_ROLLBACK/, `canonical smoke did not reach SMOKE_PASS_ROLLBACK:\n${output}`);
  assert.equal(psqlValue("SELECT count(*) FROM public.customers WHERE farm_name LIKE '[SMOKE] Return Credit Farm %';"), '0', 'customer fixture residue remained');
  assert.equal(psqlValue("SELECT count(*) FROM public.returns WHERE return_number LIKE 'SMK-%';"), '0', 'return fixture residue remained');
  assert.equal(psqlValue("SELECT count(*) FROM public.invoices WHERE invoice_number LIKE 'SMK-RCC-%';"), '0', 'invoice fixture residue remained');
  assert.equal(psqlValue("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key LIKE 'smk-rcc-%';"), '0', 'receipt residue remained');
  const passMarker = wasAlreadyInstalled ? 'RETURN_CREDIT_POSTAPPLY_LIVE_PASS' : 'RETURN_CREDIT_REAL_SCHEMA_PASS';
  console.log(`${passMarker} source=fresh-live-read-only-schema candidate_migrations=${migrations.length} invariant_violations=0 smoke=SMOKE_PASS_ROLLBACK residue=0`);
} catch (error) {
  console.error(`RETURN_CREDIT_REAL_SCHEMA_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
