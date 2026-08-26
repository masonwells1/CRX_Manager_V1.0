#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-return-credit-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const EXTENSIONS = path.join(ROOT, 'supabase', 'baselines', '20260727174805_extensions.sql');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260812130145_bind_return_receipts_to_intent_and_restore_overdue.sql');
const REPORT_CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260825230150_align_recognized_invoice_report_statuses.sql');
const COGS_CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260825230209_rebuild_return_credit_cogs_reversal.sql');
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
function psqlAsync(sql, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'],
      { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(sql);
  });
}
function psqlValue(sql) {
  return docker(['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]).stdout.trim();
}
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
function apply(name, user) { psql(`BEGIN;\n\\i /tmp/${name}\nCOMMIT;`, { user }); }
function applyStandalone(name, user) { psql(`\\i /tmp/${name}`, { user }); }
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
async function waitForSqlSleep(marker) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const sleepers = psqlValue(`
      SELECT count(*)
      FROM pg_stat_activity
      WHERE datname = 'postgres'
        AND wait_event = 'PgSleep'
        AND query LIKE '%${marker}%';
    `);
    if (sleepers === '1') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for concurrent SQL marker ${marker}`);
}
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
  mkdirSync(path.dirname(LIVE_SCHEMA), { recursive: true });
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
function concurrencyFixture(slot) {
  const suffix = String(slot).padStart(2, '0');
  const ids = {
    product: `00000000-0000-4361-8000-0000000000${suffix}`,
    customer: `00000000-0000-4361-8001-0000000000${suffix}`,
    order: `00000000-0000-4361-8002-0000000000${suffix}`,
    orderItem: `00000000-0000-4361-8003-0000000000${suffix}`,
    sourceInvoice: `00000000-0000-4361-8004-0000000000${suffix}`,
    creditInvoice: `00000000-0000-4361-8005-0000000000${suffix}`,
  };
  const marker = `pr361_concurrency_${suffix}`;
  return {
    ids,
    marker,
    sql: `
      SET session_replication_role = replica;
      INSERT INTO public.customers (id, farm_name)
      VALUES ('${ids.customer}', '[SMOKE] PR361 concurrency ${suffix}');
      INSERT INTO public.products (id, product_name, current_cost)
      VALUES ('${ids.product}', '[SMOKE] PR361 concurrency product ${suffix}', 5.00);
      INSERT INTO public.orders (id, order_number, customer_id, salesman_id, status)
      VALUES ('${ids.order}', 'SMK-RCC-CONC-${suffix}', '${ids.customer}', '00000000-0000-4000-8000-000000000081', 'confirmed');
      INSERT INTO public.order_items (
        id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin,
        quantity_delivered, quantity_remaining, unit_size
      ) VALUES (
        '${ids.orderItem}', '${ids.order}', '${ids.product}', '[SMOKE] PR361 concurrency product ${suffix}',
        10, 5, 1, 10, 5, 50, 1, 0, 'gal'
      );
      INSERT INTO public.invoices (
        id, invoice_number, customer_id, order_id, invoice_type, status,
        invoice_date, due_date, total_amount_cents, total_cost_cents, created_by,
        posted_at, posted_by
      ) VALUES
        ('${ids.sourceInvoice}', 'SMK-RCC-CONC-SRC-${suffix}', '${ids.customer}', '${ids.order}',
         'chemical_sale', 'posted', current_date, current_date, 1000, 500, '00000000-0000-4000-8000-000000000081',
         now(), '00000000-0000-4000-8000-000000000081'),
        ('${ids.creditInvoice}', 'SMK-RCC-CONC-CM-${suffix}', '${ids.customer}', '${ids.order}',
         'credit_memo', 'posted', current_date, current_date, -1000, -500, '00000000-0000-4000-8000-000000000081',
         now(), '00000000-0000-4000-8000-000000000081');
      INSERT INTO public.invoice_items (
        invoice_id, order_item_id, product_id, description, quantity,
        unit_price_cents, extended_cents, cost_cents, unit_size
      ) VALUES (
        '${ids.sourceInvoice}', '${ids.orderItem}', '${ids.product}', '[SMOKE] PR361 concurrency source ${suffix}',
        1, 1000, 1000, 500, 'gal'
      );
      SET session_replication_role = origin;
    `,
    creditSql: `
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtextextended('${ids.orderItem}'::text, 361));
      SELECT '${marker}', pg_sleep(8);
      SELECT set_config('app.crx_return_credit_lineage', '1', true);
      INSERT INTO public.invoice_items (
        invoice_id, order_item_id, product_id, description, quantity,
        unit_price_cents, extended_cents, cost_cents, unit_size
      ) VALUES (
        '${ids.creditInvoice}', '${ids.orderItem}', '${ids.product}', '[SMOKE] PR361 concurrent credit ${suffix}',
        -1, 1000, -1000, 500, 'gal'
      );
      COMMIT;
    `,
    sourceVoidSql: `UPDATE public.invoices SET deleted_at = now() WHERE id = '${ids.sourceInvoice}';`,
  };
}

function postingConcurrencyFixture(slot) {
  const fixture = concurrencyFixture(slot);
  const zeroCostCreditSql = fixture.creditSql.replace(
    "-1, 1000, -1000, 500, 'gal'",
    "-1, 1000, -1000, 0, 'gal'",
  );
  assert.notEqual(zeroCostCreditSql, fixture.creditSql, 'posting fixture did not zero the latent credit cost');
  return {
    ...fixture,
    sql: `${fixture.sql}
      SET session_replication_role = replica;
      UPDATE public.invoices
         SET status = 'draft', posted_at = NULL, posted_by = NULL
       WHERE id = '${fixture.ids.sourceInvoice}';
      UPDATE public.invoices
         SET total_cost_cents = 0
       WHERE id = '${fixture.ids.creditInvoice}';
      SET session_replication_role = origin;
    `,
    creditSql: zeroCostCreditSql,
    creditWithoutDelaySql: zeroCostCreditSql.replace(
      `      SELECT '${fixture.marker}', pg_sleep(8);\n`,
      '',
    ),
    sourcePostSql: `
      UPDATE public.invoices
         SET status = 'posted',
             posted_at = now(),
             posted_by = '00000000-0000-4000-8000-000000000081'
       WHERE id = '${fixture.ids.sourceInvoice}';
    `,
  };
}
const expectedProofs = [
  'EXISTING_RETURN_CREDIT_REPORT_GUARD_REMOVAL_DETECTED',
  'CUTOVER_REPORT_POSTFLIGHT_GUARD_REMOVAL_DETECTED',
  'CUTOVER_BARRIER_REJECTED',
  'CUTOVER_BARRIER_NON_CREDIT_UPDATE_PROVEN',
  'CUTOVER_COGS_PREFLIGHT_GUARD_REMOVAL_DETECTED',
  'EXISTING_CREDIT_GUARD_REMOVAL_DETECTED',
  'RECEIVED_UNRESTOCKED_GUARD_REMOVAL_DETECTED',
  'PREFLIGHT_OVERLOAD_COLLISION_REJECTED',
  'POSTFLIGHT_OVERLOAD_COLLISION_REJECTED',
  'SOURCE_CREDIT_CONCURRENCY_RACE_DETECTED',
  'SOURCE_POST_AFTER_CREDIT_REJECTED',
  'SOURCE_POST_CREDIT_CONCURRENCY_RACE_DETECTED',
  'SOURCE_RECOGNITION_GUARD_REMOVAL_DETECTED',
  'RETURN_CREDIT_LEDGER_GUARD_REMOVAL_DETECTED',
  'ZERO_COST_LEDGER_MUTATION_DETECTED',
  'CREDIT_REVENUE_LEDGER_MUTATION_DETECTED',
  'CUSTOMER_SCOPE_DISCLOSURE_REJECTED',
  'UNLINKED_COST_GUARD_REMOVAL_DETECTED',
  'LINEAGE_CLEAR_REMOVAL_DETECTED',
  'CREDIT_CURRENT_SEASON_MUTATION_DETECTED',
  'GROUPED_COST_BUCKET_6601_REJECTED',
  'FRACTIONAL_REPORT_HALF_CENT_DETECTED',
  'FRACTIONAL_COGS_DOUBLE_ROUNDING_DETECTED',
  'CURRENT_SEASON_CREDIT_ATTRIBUTION_PROVEN',
];
const completedProofs = new Set();
try {
  assert.ok(readFileSync(CANDIDATE, 'utf8').length > 0, 'candidate migration is missing');
  assert.ok(readFileSync(COGS_CANDIDATE, 'utf8').length > 0, 'COGS candidate migration is missing');
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
      ('00000000-0000-4000-8000-000000000082', 'return-credit-admin-b@example.invalid', '{"full_name":"Return Credit Admin B","role":"admin"}'),
      ('00000000-0000-4000-8000-000000000083', 'return-credit-sales-rep@example.invalid', '{"full_name":"Return Credit Sales Rep","role":"sales_rep"}')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (id, email, role, is_active) VALUES
      ('00000000-0000-4000-8000-000000000081', 'return-credit-admin-a@example.invalid', 'admin', true),
      ('00000000-0000-4000-8000-000000000082', 'return-credit-admin-b@example.invalid', 'admin', true),
      ('00000000-0000-4000-8000-000000000083', 'return-credit-sales-rep@example.invalid', 'sales_rep', true)
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
      ('fad3ea45-cd8c-4bb8-b0ce-8a515941586c', 'Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal'),
      ('fad3ea45-cd8c-4bb8-b0ce-8a515941586d', '[SMOKE] Second source-free return product')
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
    ), (
      'c4f6cc7d-0bbd-4c25-8bc0-c2c9e84aaade', '0cb556ed-467a-4949-866d-8d9edbb09522', NULL,
      'fad3ea45-cd8c-4bb8-b0ce-8a515941586d', '[SMOKE] Second source-free return product',
      2.00, 'ea', 1000, 2000, 'unopened', false, false, 1, NULL,
      '2026-04-30 20:48:19.173027+00'
    );
    SELECT set_config('app.return_rpc', 'false', false);
  `);

  copy(REPORT_CANDIDATE, path.basename(REPORT_CANDIDATE));
  const reportMigrationSql = readFileSync(REPORT_CANDIDATE, 'utf8');
  const noExistingReturnCreditGuardReportMutant = reportMigrationSql.replace(
    /  IF EXISTS \(\r?\n    SELECT 1\r?\n    FROM public\.returns r\r?\n    JOIN public\.invoices i[\s\S]*?RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_PREFLIGHT_EXISTING_RETURN_CREDIT';\r?\n  END IF;\r?\n/,
    '',
  );
  assert.notEqual(noExistingReturnCreditGuardReportMutant, reportMigrationSql, 'existing return-credit report preflight mutant did not remove the guard');
  const existingReturnCreditPrefix = `
    BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.invoices (
      id, invoice_number, customer_id, invoice_type, status, season,
      invoice_date, due_date, total_amount_cents, total_cost_cents, created_by,
      posted_at, posted_by
    ) VALUES (
      'f3610000-0000-4000-8000-000000000001', 'SMK-RCC-HEADER-MISMATCH',
      'df6087cb-232f-4962-bb33-c74580a06935', 'credit_memo', 'posted',
      public.current_season(), current_date, current_date, 0, -100,
      '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f', now(),
      '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'
    );
    UPDATE public.returns
       SET status = 'credited',
           credit_invoice_id = 'f3610000-0000-4000-8000-000000000001'
     WHERE id = '0cb556ed-467a-4949-866d-8d9edbb09522';
    SET LOCAL session_replication_role = origin;
  `;
  const unguardedExistingReturnCreditReport = psql(`${existingReturnCreditPrefix}\n${noExistingReturnCreditGuardReportMutant}\nROLLBACK;`, { allowFailure: true });
  assert.equal(unguardedExistingReturnCreditReport.status, 0, `existing return-credit report mutant did not expose the unsafe acceptance path:\n${unguardedExistingReturnCreditReport.stderr || unguardedExistingReturnCreditReport.stdout}`);
  const guardedExistingReturnCreditReport = psql(`${existingReturnCreditPrefix}\n${reportMigrationSql}\nCOMMIT;`, { allowFailure: true });
  const guardedExistingReturnCreditOutput = `${guardedExistingReturnCreditReport.stdout}\n${guardedExistingReturnCreditReport.stderr}`;
  assert.notEqual(guardedExistingReturnCreditReport.status, 0, 'canonical report migration accepted a pre-existing recognized return credit');
  assert.match(guardedExistingReturnCreditOutput, /RECOGNIZED_INVOICE_REPORT_PREFLIGHT_EXISTING_RETURN_CREDIT/, `canonical report migration did not reach the existing return-credit guard:\n${guardedExistingReturnCreditOutput}`);
  completedProofs.add('EXISTING_RETURN_CREDIT_REPORT_GUARD_REMOVAL_DETECTED');
  const reportWithoutBarrierTrigger = reportMigrationSql.replace(
    /CREATE TRIGGER aa_crx_block_return_credit_during_cogs_cutover[\s\S]*?EXECUTE FUNCTION public\.block_return_credit_during_cogs_cutover\(\);\r?\n/,
    '',
  );
  assert.notEqual(reportWithoutBarrierTrigger, reportMigrationSql, 'cutover report mutant did not remove the trigger');
  const reportWithoutBarrierPostflightGuard = reportWithoutBarrierTrigger.replace(
    /  IF v_cutover_barrier IS NULL THEN\r?\n    RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_POSTFLIGHT_CUTOVER_BARRIER_MISSING';\r?\n  END IF;\r?\n  IF NOT EXISTS \([\s\S]*?RAISE EXCEPTION 'RECOGNIZED_INVOICE_REPORT_POSTFLIGHT_CUTOVER_BARRIER_DRIFTED';\r?\n  END IF;\r?\n/,
    '',
  );
  assert.notEqual(reportWithoutBarrierPostflightGuard, reportWithoutBarrierTrigger, 'cutover report mutant did not remove the postflight guard');
  const unguardedMissingReportBarrier = psql(`BEGIN;\n${reportWithoutBarrierPostflightGuard}\nROLLBACK;`, { allowFailure: true });
  assert.equal(unguardedMissingReportBarrier.status, 0, `cutover report postflight mutant did not expose the missing-trigger acceptance path:\n${unguardedMissingReportBarrier.stderr || unguardedMissingReportBarrier.stdout}`);
  const guardedMissingReportBarrier = psql(`BEGIN;\n${reportWithoutBarrierTrigger}\nCOMMIT;`, { allowFailure: true });
  const guardedMissingReportBarrierOutput = `${guardedMissingReportBarrier.stdout}\n${guardedMissingReportBarrier.stderr}`;
  assert.notEqual(guardedMissingReportBarrier.status, 0, 'canonical report postflight accepted a missing cutover trigger');
  assert.match(guardedMissingReportBarrierOutput, /RECOGNIZED_INVOICE_REPORT_POSTFLIGHT_CUTOVER_BARRIER/, `canonical report postflight did not reach the missing-barrier guard:\n${guardedMissingReportBarrierOutput}`);
  assert.equal(psqlValue("SELECT (to_regprocedure('public.block_return_credit_during_cogs_cutover()') IS NULL)::int;"), '1', 'cutover report mutant left the barrier function behind');
  completedProofs.add('CUTOVER_REPORT_POSTFLIGHT_GUARD_REMOVAL_DETECTED');
  apply(path.basename(REPORT_CANDIDATE));
  migrations.push(REPORT_CANDIDATE);
  const nonCreditBarrierProbe = psql(`
    BEGIN;
    SELECT set_config('app.return_rpc', 'true', true);
    UPDATE public.returns
       SET status = 'received',
           received_by = '00000000-0000-4000-8000-000000000081',
           received_at = now()
     WHERE id = '0cb556ed-467a-4949-866d-8d9edbb09522';
    ROLLBACK;
  `, { allowFailure: true });
  assert.equal(nonCreditBarrierProbe.status, 0, `cutover barrier blocked an ordinary non-credit lifecycle update:\n${nonCreditBarrierProbe.stderr || nonCreditBarrierProbe.stdout}`);
  completedProofs.add('CUTOVER_BARRIER_NON_CREDIT_UPDATE_PROVEN');
  const cutoverBarrierProbe = psql(`
    UPDATE public.returns
       SET status = 'credited'
     WHERE id = '0cb556ed-467a-4949-866d-8d9edbb09522';
  `, { allowFailure: true });
  const cutoverBarrierOutput = `${cutoverBarrierProbe.stdout}\n${cutoverBarrierProbe.stderr}`;
  assert.notEqual(cutoverBarrierProbe.status, 0, 'report migration left return-credit issuance open before the COGS cutover');
  assert.match(cutoverBarrierOutput, /RETURN_CREDIT_CUTOVER_IN_PROGRESS/, `cutover barrier raised the wrong error:\n${cutoverBarrierOutput}`);
  assert.equal(psqlValue("SELECT status FROM public.returns WHERE id = '0cb556ed-467a-4949-866d-8d9edbb09522';"), 'approved', 'cutover barrier probe changed the return');
  completedProofs.add('CUTOVER_BARRIER_REJECTED');
  const cogsSql = readFileSync(COGS_CANDIDATE, 'utf8');
  const cogsWithoutBarrierPreflight = cogsSql.replace(
    /DO \$cutover_barrier\$\r?\n[\s\S]*?\r?\n\$cutover_barrier\$;\r?\n/,
    '',
  );
  assert.notEqual(cogsWithoutBarrierPreflight, cogsSql, 'cutover COGS mutant did not remove the barrier preflight');
  const cogsWithoutBarrierGuard = cogsWithoutBarrierPreflight.replace(
    /\r?\n-- Removal is deliberately last[\s\S]*?DROP FUNCTION public\.block_return_credit_during_cogs_cutover\(\);\r?\n?$/,
    '',
  );
  assert.notEqual(cogsWithoutBarrierGuard, cogsWithoutBarrierPreflight, 'cutover COGS mutant did not remove the barrier cleanup contract');
  const missingCogsBarrierPrefix = `
    BEGIN;
    DROP TRIGGER aa_crx_block_return_credit_during_cogs_cutover ON public.returns;
    DROP FUNCTION public.block_return_credit_during_cogs_cutover();
  `;
  const unguardedMissingCogsBarrier = psql(`${missingCogsBarrierPrefix}\n${cogsWithoutBarrierGuard}\nROLLBACK;`, { allowFailure: true });
  assert.equal(unguardedMissingCogsBarrier.status, 0, `cutover COGS preflight mutant did not expose the missing-barrier acceptance path:\n${unguardedMissingCogsBarrier.stderr || unguardedMissingCogsBarrier.stdout}`);
  const guardedMissingCogsBarrier = psql(`${missingCogsBarrierPrefix}\n${cogsSql}\nCOMMIT;`, { allowFailure: true });
  const guardedMissingCogsBarrierOutput = `${guardedMissingCogsBarrier.stdout}\n${guardedMissingCogsBarrier.stderr}`;
  assert.notEqual(guardedMissingCogsBarrier.status, 0, 'canonical COGS migration accepted a missing cutover barrier');
  assert.match(guardedMissingCogsBarrierOutput, /RETURN_COGS_CUTOVER_BARRIER_MISSING/, `canonical COGS migration did not reach the missing-barrier guard:\n${guardedMissingCogsBarrierOutput}`);
  assert.equal(psqlValue("SELECT (to_regprocedure('public.block_return_credit_during_cogs_cutover()') IS NOT NULL)::int;"), '1', 'missing-barrier proof did not roll back the canonical barrier');
  completedProofs.add('CUTOVER_COGS_PREFLIGHT_GUARD_REMOVAL_DETECTED');
  const noExistingCreditGuardMutant = cogsSql.replace(
    /  IF EXISTS \(SELECT 1 FROM public\.returns WHERE status = 'credited'\) THEN\r?\n    RAISE EXCEPTION 'RETURN_COGS_PREEXISTING_CREDIT_REQUIRES_BACKFILL';\r?\n  END IF;\r?\n/,
    '',
  );
  assert.notEqual(noExistingCreditGuardMutant, cogsSql, 'existing-credit rollout mutant did not remove the guard');
  const creditedFixturePrefix = `
    BEGIN;
    SET LOCAL session_replication_role = replica;
    UPDATE public.returns
       SET status = 'credited'
     WHERE id = '0cb556ed-467a-4949-866d-8d9edbb09522';
    SET LOCAL session_replication_role = origin;
  `;
  const unguardedRollout = psql(`${creditedFixturePrefix}\n${noExistingCreditGuardMutant}\nROLLBACK;`, { allowFailure: true });
  assert.equal(unguardedRollout.status, 0, `existing-credit guard mutant did not expose the unsafe acceptance path:\n${unguardedRollout.stderr || unguardedRollout.stdout}`);
  const guardedRollout = psql(`${creditedFixturePrefix}\n${cogsSql}\nCOMMIT;`, { allowFailure: true });
  const guardedRolloutOutput = `${guardedRollout.stdout}\n${guardedRollout.stderr}`;
  assert.notEqual(guardedRollout.status, 0, 'canonical migration accepted a pre-existing credited return');
  assert.match(guardedRolloutOutput, /RETURN_COGS_PREEXISTING_CREDIT_REQUIRES_BACKFILL/, `canonical migration did not reach the existing-credit rollout guard:\n${guardedRolloutOutput}`);
  assert.equal(psqlValue("SELECT status FROM public.returns WHERE id = '0cb556ed-467a-4949-866d-8d9edbb09522';"), 'approved', 'existing-credit guard proof left fixture state behind');
  completedProofs.add('EXISTING_CREDIT_GUARD_REMOVAL_DETECTED');
  const noReceivedRestockGuardMutant = cogsSql.replace(
    /  IF EXISTS \(\r?\n    SELECT 1\r?\n    FROM public\.returns r\r?\n    WHERE r\.status = 'received'[\s\S]*?RAISE EXCEPTION 'RETURN_COGS_RECEIVED_UNRESTOCKED_REQUIRES_REPAIR';\r?\n  END IF;\r?\n/,
    '',
  );
  assert.notEqual(noReceivedRestockGuardMutant, cogsSql, 'received/unrestocked rollout mutant did not remove the guard');
  const receivedUnrestockedFixturePrefix = `
    BEGIN;
    SET LOCAL session_replication_role = replica;
    UPDATE public.returns
       SET status = 'received'
     WHERE id = '0cb556ed-467a-4949-866d-8d9edbb09522';
    UPDATE public.return_items
       SET restock = true, restocked = false
     WHERE return_id = '0cb556ed-467a-4949-866d-8d9edbb09522';
    SET LOCAL session_replication_role = origin;
  `;
  const unguardedReceivedRollout = psql(`${receivedUnrestockedFixturePrefix}\n${noReceivedRestockGuardMutant}\nROLLBACK;`, { allowFailure: true });
  assert.equal(unguardedReceivedRollout.status, 0, `received/unrestocked guard mutant did not expose the unsafe acceptance path:\n${unguardedReceivedRollout.stderr || unguardedReceivedRollout.stdout}`);
  const guardedReceivedRollout = psql(`${receivedUnrestockedFixturePrefix}\n${cogsSql}\nCOMMIT;`, { allowFailure: true });
  const guardedReceivedOutput = `${guardedReceivedRollout.stdout}\n${guardedReceivedRollout.stderr}`;
  assert.notEqual(guardedReceivedRollout.status, 0, 'canonical migration accepted a received return with unrestored inventory');
  assert.match(guardedReceivedOutput, /RETURN_COGS_RECEIVED_UNRESTOCKED_REQUIRES_REPAIR/, `canonical migration did not reach the received/unrestocked rollout guard:\n${guardedReceivedOutput}`);
  assert.equal(psqlValue("SELECT status FROM public.returns WHERE id = '0cb556ed-467a-4949-866d-8d9edbb09522';"), 'approved', 'received/unrestocked guard proof left return state behind');
  completedProofs.add('RECEIVED_UNRESTOCKED_GUARD_REMOVAL_DETECTED');

  // Overload-collision proof: an unexpected public overload must abort before
  // any reviewed helper is renamed or replaced.
  const overloadFixturePrefix = `
    BEGIN;
    CREATE FUNCTION public.issue_return_credit(text)
    RETURNS jsonb LANGUAGE sql SET search_path = public
    AS $$ SELECT '{}'::jsonb $$;
  `;
  const overloadGuardedRollout = psql(`
    ${overloadFixturePrefix}
    ${cogsSql}
    COMMIT;
  `, { allowFailure: true });
  const overloadGuardedOutput = `${overloadGuardedRollout.stdout}\n${overloadGuardedRollout.stderr}`;
  assert.notEqual(overloadGuardedRollout.status, 0, 'canonical migration accepted an unexpected issue_return_credit overload');
  assert.match(overloadGuardedOutput, /RETURN_COGS_PREFLIGHT_OVERLOAD_DRIFT:issue_return_credit/, `canonical migration did not reach the overload-collision guard:\n${overloadGuardedOutput}`);
  assert.equal(psqlValue("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'issue_return_credit';"), '1', 'overload-collision proof left an extra function behind');
  completedProofs.add('PREFLIGHT_OVERLOAD_COLLISION_REJECTED');

  const noPreflightOverloadGuardMutant = cogsSql
    .replace(
      /    IF \(SELECT count\(\*\) FROM pg_proc p JOIN pg_namespace n ON n\.oid = p\.pronamespace\r?\n        WHERE n\.nspname = 'public' AND p\.proname = v_name\) <> 1 THEN\r?\n      RAISE EXCEPTION 'RETURN_COGS_PREFLIGHT_OVERLOAD_DRIFT:%', v_name;\r?\n    END IF;\r?\n/,
      '',
    )
    .replace(
      /    WHERE n\.nspname = 'public' AND p\.proname = v_name;\r?\n    IF v_hash IS DISTINCT/,
      "    WHERE n.nspname = 'public' AND p.proname = v_name\n      AND (v_name <> 'issue_return_credit' OR p.proargtypes = '2950 2950 25'::oidvector);\n    IF v_hash IS DISTINCT",
    );
  assert.notEqual(noPreflightOverloadGuardMutant, cogsSql, 'preflight overload mutant did not remove the executable guard');
  const postflightOverloadGuardedRollout = psql(`
    ${overloadFixturePrefix}
    ${noPreflightOverloadGuardMutant}
    COMMIT;
  `, { allowFailure: true });
  const postflightOverloadGuardedOutput = `${postflightOverloadGuardedRollout.stdout}\n${postflightOverloadGuardedRollout.stderr}`;
  assert.notEqual(postflightOverloadGuardedRollout.status, 0, 'postflight accepted an unexpected issue_return_credit overload');
  assert.match(postflightOverloadGuardedOutput, /RETURN_COGS_POSTFLIGHT_CONTRACT_DRIFT:issue_return_credit/, `postflight did not reach the overload-collision guard:\n${postflightOverloadGuardedOutput}`);
  assert.equal(psqlValue("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'issue_return_credit';"), '1', 'postflight overload proof left an extra function behind');
  completedProofs.add('POSTFLIGHT_OVERLOAD_COLLISION_REJECTED');

  copy(COGS_CANDIDATE, path.basename(COGS_CANDIDATE));
  apply(path.basename(COGS_CANDIDATE));
  migrations.push(COGS_CANDIDATE);
  // The migration must accept multiple NULL-lineage items because PostgreSQL's
  // installed UNIQUE constraint does. Remove only the synthetic second item
  // after that apply proof so the later smoke can exercise the exact one-line
  // production RMA compatibility exception without widening it.
  psql(`
    SET session_replication_role = replica;
    DELETE FROM public.return_items
     WHERE id = 'c4f6cc7d-0bbd-4c25-8bc0-c2c9e84aaade';
    SET session_replication_role = origin;
  `);
  assert.equal(psqlValue(`SELECT count(*) FROM (${predicate}) AS violations;`), '0', 'return-credit invariant regressed after candidate apply');
  const postApplyLifecycleViolations = psqlValue(`SELECT violation_key || ': ' || reason FROM (${lifecyclePredicate}) AS violations ORDER BY violation_key;`);
  assert.equal(postApplyLifecycleViolations, '', `returns lifecycle invariant regressed after candidate apply:\n${postApplyLifecycleViolations}`);

  copy(SMOKE, path.basename(SMOKE));
  const sourceGuardStart = cogsSql.indexOf('CREATE FUNCTION public.guard_return_credit_source_recognition()');
  const sourceGuardEnd = cogsSql.indexOf('REVOKE ALL ON FUNCTION public.guard_return_credit_source_recognition()', sourceGuardStart);
  assert.ok(sourceGuardStart >= 0 && sourceGuardEnd > sourceGuardStart, 'source-recognition guard helper slice is missing');
  const canonicalSourceGuardHelper = cogsSql.slice(sourceGuardStart, sourceGuardEnd).replace(
    'CREATE FUNCTION public.guard_return_credit_source_recognition()',
    'CREATE OR REPLACE FUNCTION public.guard_return_credit_source_recognition()',
  );

  // Two-session protocol proof: a synthetic credit-side session holds the
  // same shared order-item advisory lock used by credit issuance
  // lock while the source invoice attempts to leave recognized status. The
  // source writer must wait, refresh visibility, and reject after the credit
  // line commits. Removing the source-side lock must expose the corrupt state.
  const canonicalConcurrency = concurrencyFixture(1);
  psql(canonicalConcurrency.sql);
  const canonicalCredit = psqlAsync(canonicalConcurrency.creditSql);
  await waitForSqlSleep(canonicalConcurrency.marker);
  const canonicalVoid = psqlAsync(canonicalConcurrency.sourceVoidSql);
  const [canonicalCreditResult, canonicalVoidResult] = await Promise.all([canonicalCredit, canonicalVoid]);
  assert.equal(canonicalCreditResult.status, 0, `canonical concurrent credit failed:\n${canonicalCreditResult.stderr || canonicalCreditResult.stdout}`);
  assert.notEqual(canonicalVoidResult.status, 0, 'canonical source void committed across a concurrent credit');
  assert.match(
    `${canonicalVoidResult.stdout}\n${canonicalVoidResult.stderr}`,
    /RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED/,
    'canonical concurrent source void did not reach the recognition guard',
  );
  assert.equal(
    psqlValue(`SELECT (deleted_at IS NULL)::int FROM public.invoices WHERE id = '${canonicalConcurrency.ids.sourceInvoice}';`),
    '1',
    'canonical concurrency proof left its source invoice unrecognized',
  );

  const sourceLockMutant = canonicalSourceGuardHelper.replace(
    /    -- Only the dangerous transition takes the shared lineage locks[\s\S]*?    END LOOP;\r?\n/,
    '',
  );
  assert.notEqual(sourceLockMutant, canonicalSourceGuardHelper, 'source-lock mutant did not remove the executable advisory lock');
  psql(sourceLockMutant);
  const mutantConcurrency = concurrencyFixture(2);
  psql(mutantConcurrency.sql);
  const mutantCredit = psqlAsync(mutantConcurrency.creditSql);
  await waitForSqlSleep(mutantConcurrency.marker);
  const mutantVoidPromise = psqlAsync(mutantConcurrency.sourceVoidSql);
  const mutantVoidEarly = await Promise.race([
    mutantVoidPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
  ]);
  assert.notEqual(mutantVoidEarly, null, 'source-lock mutant still blocked the source void while the credit lock was held');
  assert.equal(mutantVoidEarly.status, 0, `source-lock mutant unexpectedly rejected the racing source void:\n${mutantVoidEarly.stderr || mutantVoidEarly.stdout}`);
  const mutantCreditResult = await mutantCredit;
  assert.equal(mutantCreditResult.status, 0, `source-lock mutant concurrent credit failed:\n${mutantCreditResult.stderr || mutantCreditResult.stdout}`);
  assert.equal(
    psqlValue(`
      SELECT CASE WHEN s.deleted_at IS NOT NULL AND count(ii.id) = 1 THEN 1 ELSE 0 END
      FROM public.invoices s
      LEFT JOIN public.invoice_items ii ON ii.invoice_id = '${mutantConcurrency.ids.creditInvoice}'
      WHERE s.id = '${mutantConcurrency.ids.sourceInvoice}'
      GROUP BY s.deleted_at;
    `),
    '1',
    'source-lock mutant did not expose an unrecognized sale with an active cost credit',
  );
  completedProofs.add('SOURCE_CREDIT_CONCURRENCY_RACE_DETECTED');
  psql(canonicalSourceGuardHelper);

  // Sequential latent-defect proof: if a return credit was issued while its
  // source invoice was still a draft, later recognition must fail closed. A
  // zero-cost credit cannot be made correct after the immutable fact.
  const sequentialPosting = postingConcurrencyFixture(5);
  assert.notEqual(
    sequentialPosting.creditWithoutDelaySql,
    sequentialPosting.creditSql,
    'posting fixture did not remove its artificial race delay',
  );
  psql(sequentialPosting.sql);
  const sequentialCreditResult = psql(sequentialPosting.creditWithoutDelaySql, { allowFailure: true });
  assert.equal(
    sequentialCreditResult.status,
    0,
    `sequential latent credit setup failed:\n${sequentialCreditResult.stderr || sequentialCreditResult.stdout}`,
  );
  const sequentialPostResult = psql(sequentialPosting.sourcePostSql, { allowFailure: true });
  assert.notEqual(sequentialPostResult.status, 0, 'canonical guard allowed a draft source invoice to post after an active zero-cost credit');
  assert.match(
    `${sequentialPostResult.stdout}\n${sequentialPostResult.stderr}`,
    /RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED/,
    'post-after-credit rejection did not reach the source-recognition guard',
  );
  assert.equal(
    psqlValue(`SELECT status FROM public.invoices WHERE id = '${sequentialPosting.ids.sourceInvoice}';`),
    'draft',
    'post-after-credit rejection changed the source invoice status',
  );
  completedProofs.add('SOURCE_POST_AFTER_CREDIT_REJECTED');

  // Two-session posting race proof: whichever participant wins the shared
  // order-item lock determines a safe outcome. Here the credit wins, so the
  // posting session must wait for it and then reject. Removing the source-side
  // lock must expose a posted sale paired with the stale zero-cost credit.
  const canonicalPostingConcurrency = postingConcurrencyFixture(3);
  psql(canonicalPostingConcurrency.sql);
  const canonicalPostingCredit = psqlAsync(canonicalPostingConcurrency.creditSql);
  await waitForSqlSleep(canonicalPostingConcurrency.marker);
  const canonicalPost = psqlAsync(canonicalPostingConcurrency.sourcePostSql);
  const [canonicalPostingCreditResult, canonicalPostResult] = await Promise.all([
    canonicalPostingCredit,
    canonicalPost,
  ]);
  assert.equal(
    canonicalPostingCreditResult.status,
    0,
    `canonical concurrent latent credit failed:\n${canonicalPostingCreditResult.stderr || canonicalPostingCreditResult.stdout}`,
  );
  assert.notEqual(canonicalPostResult.status, 0, 'canonical source posting committed across a concurrent zero-cost credit');
  assert.match(
    `${canonicalPostResult.stdout}\n${canonicalPostResult.stderr}`,
    /RETURN_CREDIT_SOURCE_RECOGNITION_REQUIRED/,
    'canonical concurrent source posting did not reach the recognition guard',
  );
  assert.equal(
    psqlValue(`SELECT status FROM public.invoices WHERE id = '${canonicalPostingConcurrency.ids.sourceInvoice}';`),
    'draft',
    'canonical posting race left its source invoice recognized',
  );

  psql(sourceLockMutant);
  const mutantPostingConcurrency = postingConcurrencyFixture(4);
  psql(mutantPostingConcurrency.sql);
  const mutantPostingCredit = psqlAsync(mutantPostingConcurrency.creditSql);
  await waitForSqlSleep(mutantPostingConcurrency.marker);
  const mutantPostPromise = psqlAsync(mutantPostingConcurrency.sourcePostSql);
  const mutantPostEarly = await Promise.race([
    mutantPostPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
  ]);
  assert.notEqual(mutantPostEarly, null, 'source-lock mutant still blocked source posting while the credit lock was held');
  assert.equal(
    mutantPostEarly.status,
    0,
    `source-lock mutant unexpectedly rejected the racing source posting:\n${mutantPostEarly.stderr || mutantPostEarly.stdout}`,
  );
  const mutantPostingCreditResult = await mutantPostingCredit;
  assert.equal(
    mutantPostingCreditResult.status,
    0,
    `source-lock mutant concurrent latent credit failed:\n${mutantPostingCreditResult.stderr || mutantPostingCreditResult.stdout}`,
  );
  assert.equal(
    psqlValue(`
      SELECT CASE WHEN s.status = 'posted' AND count(ii.id) = 1 THEN 1 ELSE 0 END
      FROM public.invoices s
      LEFT JOIN public.invoice_items ii ON ii.invoice_id = '${mutantPostingConcurrency.ids.creditInvoice}'
      WHERE s.id = '${mutantPostingConcurrency.ids.sourceInvoice}'
      GROUP BY s.status;
    `),
    '1',
    'source-lock mutant did not expose a recognized sale with an active zero-cost credit',
  );
  completedProofs.add('SOURCE_POST_CREDIT_CONCURRENCY_RACE_DETECTED');
  psql(canonicalSourceGuardHelper);

  const allConcurrencyFixtures = [
    canonicalConcurrency,
    mutantConcurrency,
    canonicalPostingConcurrency,
    mutantPostingConcurrency,
    sequentialPosting,
  ];
  const fixtureIds = (key) => allConcurrencyFixtures.map((fixture) => `'${fixture.ids[key]}'`).join(', ');
  psql(`
    SET session_replication_role = replica;
    DELETE FROM public.invoice_items
     WHERE invoice_id IN (${fixtureIds('sourceInvoice')}, ${fixtureIds('creditInvoice')});
    DELETE FROM public.invoices
     WHERE id IN (${fixtureIds('sourceInvoice')}, ${fixtureIds('creditInvoice')});
    DELETE FROM public.order_items
     WHERE id IN (${fixtureIds('orderItem')});
    DELETE FROM public.orders
     WHERE id IN (${fixtureIds('order')});
    DELETE FROM public.products
     WHERE id IN (${fixtureIds('product')});
    DELETE FROM public.customers
     WHERE id IN (${fixtureIds('customer')});
    SET session_replication_role = origin;
  `);

  // Source-recognition mutation proof: without the source-sale branch, the
  // canonical smoke can soft-delete a recognized sale while its negative
  // return credit remains active; header immutability stays independently on.
  const sourceRecognitionMutant = canonicalSourceGuardHelper.replace(
    /  IF OLD\.invoice_type <> 'credit_memo'[\s\S]*?  END IF;\r?\n  RETURN/,
    '  RETURN',
  );
  assert.notEqual(sourceRecognitionMutant, canonicalSourceGuardHelper, 'source-recognition mutant did not alter the executable guard');
  psql(sourceRecognitionMutant);
  const sourceGuardMutantSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const sourceGuardMutantOutput = `${sourceGuardMutantSmoke.stdout}\n${sourceGuardMutantSmoke.stderr}`;
  assert.notEqual(sourceGuardMutantSmoke.status, 0, 'source-recognition guard mutant smoke unexpectedly committed');
  assert.match(sourceGuardMutantOutput, /SMOKE_FAIL: source sale with an active return credit was soft-deleted/, `source-recognition guard mutant did not reach the source-sale oracle:\n${sourceGuardMutantOutput}`);
  completedProofs.add('SOURCE_RECOGNITION_GUARD_REMOVAL_DETECTED');
  psql(canonicalSourceGuardHelper);

  // Return-credit ledger mutation proof: without the line guard, the smoke
  // can rewrite an active negative-cost credit line and make a later return
  // consume the same recognized source cost again.
  psql('DROP TRIGGER aa_crx_guard_return_credit_lineage ON public.invoice_items;');
  const lineageGuardMutantSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const lineageGuardMutantOutput = `${lineageGuardMutantSmoke.stdout}\n${lineageGuardMutantSmoke.stderr}`;
  assert.notEqual(lineageGuardMutantSmoke.status, 0, 'return-credit lineage guard mutant smoke unexpectedly committed');
  assert.match(lineageGuardMutantOutput, /SMOKE_FAIL: active return-credit cost line was mutated/, `lineage guard mutant did not reach the cost-line oracle:\n${lineageGuardMutantOutput}`);
  completedProofs.add('RETURN_CREDIT_LEDGER_GUARD_REMOVAL_DETECTED');
  psql(`
    CREATE TRIGGER aa_crx_guard_return_credit_lineage
      BEFORE UPDATE OF invoice_id, order_item_id, product_id, quantity, unit_price_cents, extended_cents, cost_cents, unit_size OR DELETE
      ON public.invoice_items
      FOR EACH ROW EXECUTE FUNCTION public.guard_return_credit_lineage();
  `);

  const lineageStart = cogsSql.indexOf('CREATE FUNCTION public.guard_return_credit_lineage()');
  const lineageEnd = cogsSql.indexOf('REVOKE ALL ON FUNCTION public.guard_return_credit_lineage()', lineageStart);
  assert.ok(lineageStart >= 0 && lineageEnd > lineageStart, 'return-credit lineage guard helper slice is missing');
  const canonicalLineageHelper = cogsSql.slice(lineageStart, lineageEnd).replace(
    'CREATE FUNCTION public.guard_return_credit_lineage()',
    'CREATE OR REPLACE FUNCTION public.guard_return_credit_lineage()',
  );
  const zeroCostLineMutant = canonicalLineageHelper.replace(
    "       AND OLD.quantity < 0 THEN",
    "       AND OLD.quantity < 0\n       AND OLD.cost_cents > 0 THEN",
  );
  assert.notEqual(zeroCostLineMutant, canonicalLineageHelper, 'zero-cost credit-line mutant did not alter the executable guard');
  psql(zeroCostLineMutant);
  const zeroCostLineMutantSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const zeroCostLineMutantOutput = `${zeroCostLineMutantSmoke.stdout}\n${zeroCostLineMutantSmoke.stderr}`;
  assert.notEqual(zeroCostLineMutantSmoke.status, 0, 'zero-cost credit-line guard mutant smoke unexpectedly committed');
  assert.match(zeroCostLineMutantOutput, /SMOKE_FAIL: active zero-cost return-credit line was costed later/, `zero-cost credit-line mutant did not reach the immutable-ledger oracle:\n${zeroCostLineMutantOutput}`);
  completedProofs.add('ZERO_COST_LEDGER_MUTATION_DETECTED');
  psql(canonicalLineageHelper);

  psql(`
    DROP TRIGGER aa_crx_guard_return_credit_lineage ON public.invoice_items;
    CREATE TRIGGER aa_crx_guard_return_credit_lineage
      BEFORE UPDATE OF invoice_id, order_item_id, product_id, quantity, cost_cents, unit_size OR DELETE
      ON public.invoice_items
      FOR EACH ROW EXECUTE FUNCTION public.guard_return_credit_lineage();
  `);
  const revenueFieldMutantSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const revenueFieldMutantOutput = `${revenueFieldMutantSmoke.stdout}\n${revenueFieldMutantSmoke.stderr}`;
  assert.notEqual(revenueFieldMutantSmoke.status, 0, 'return-credit revenue-field trigger mutant smoke unexpectedly committed');
  assert.match(revenueFieldMutantOutput, /SMOKE_FAIL: active return-credit revenue fields were mutated/, `revenue-field trigger mutant did not reach the immutable-ledger oracle:\n${revenueFieldMutantOutput}`);
  completedProofs.add('CREDIT_REVENUE_LEDGER_MUTATION_DETECTED');
  psql(`
    DROP TRIGGER aa_crx_guard_return_credit_lineage ON public.invoice_items;
    CREATE TRIGGER aa_crx_guard_return_credit_lineage
      BEFORE UPDATE OF invoice_id, order_item_id, product_id, quantity, unit_price_cents, extended_cents, cost_cents, unit_size OR DELETE
      ON public.invoice_items
      FOR EACH ROW EXECUTE FUNCTION public.guard_return_credit_lineage();
  `);

  // Authorization mutation proof: remove the assigned-customer predicate from
  // the executable year-end function. The same smoke must then catch the
  // cross-customer disclosure before any accounting assertion can pass.
  const reportSql = readFileSync(REPORT_CANDIDATE, 'utf8');
  const yearEndStart = reportSql.indexOf('CREATE OR REPLACE FUNCTION public.get_customer_year_end_summary(');
  const yearEndEnd = reportSql.indexOf('REVOKE ALL ON FUNCTION public.get_customer_year_end_summary', yearEndStart);
  assert.ok(yearEndStart >= 0 && yearEndEnd > yearEndStart, 'report migration year-end helper slice is missing');
  const canonicalYearEndHelper = reportSql.slice(yearEndStart, yearEndEnd);
  const scopeGuardMutant = canonicalYearEndHelper.replace(
    /  IF NOT public\.is_admin\(\)[\s\S]*?  END IF;\r?\n\r?\n  SELECT \* INTO v_cust/,
    '  SELECT * INTO v_cust',
  );
  assert.notEqual(scopeGuardMutant, canonicalYearEndHelper, 'customer-scope mutant did not alter the executable helper');
  psql(scopeGuardMutant);
  const scopeMutantSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const scopeMutantOutput = `${scopeMutantSmoke.stdout}\n${scopeMutantSmoke.stderr}`;
  assert.notEqual(scopeMutantSmoke.status, 0, 'customer-scope mutant smoke unexpectedly committed');
  assert.match(scopeMutantOutput, /SMOKE_FAIL: unassigned sales rep read another customer year-end summary/, `customer-scope mutant did not reach the deny-path oracle:\n${scopeMutantOutput}`);
  completedProofs.add('CUSTOMER_SCOPE_DISCLOSURE_REJECTED');
  psql(canonicalYearEndHelper);

  // Fractional accounting mutation proof: reverting P&L credit memos to the
  // raw unit-cost-times-quantity sum produces 250.5 cents after the first half
  // return. The canonical header-backed report must expose exactly 250 cents.
  const pnlStart = reportSql.indexOf('CREATE OR REPLACE FUNCTION public.get_bottom_line_pnl(');
  const pnlEnd = reportSql.indexOf('CREATE OR REPLACE FUNCTION public.get_monthly_summary(', pnlStart);
  assert.ok(pnlStart >= 0 && pnlEnd > pnlStart, 'P&L helper slice is missing');
  const canonicalPnlHelper = reportSql.slice(pnlStart, pnlEnd);
  const fractionalReportMutant = canonicalPnlHelper.replace(
    '        THEN i.total_cost_cents',
    '        THEN (SELECT COALESCE(SUM(ii.cost_cents * ii.quantity), 0) FROM public.invoice_items ii WHERE ii.invoice_id = i.id)',
  );
  assert.notEqual(fractionalReportMutant, canonicalPnlHelper, 'fractional report mutant did not alter the executable P&L helper');
  psql(fractionalReportMutant);
  const fractionalReportSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const fractionalReportOutput = `${fractionalReportSmoke.stdout}\n${fractionalReportSmoke.stderr}`;
  assert.notEqual(fractionalReportSmoke.status, 0, 'fractional report mutant smoke unexpectedly committed');
  assert.match(
    fractionalReportOutput,
    /SMOKE_FAIL: fractional credit A PNL COGS delta=250\.50* \(expected 250 whole cents\)/,
    `fractional report mutant did not reach the half-cent oracle:\n${fractionalReportOutput}`,
  );
  completedProofs.add('FRACTIONAL_REPORT_HALF_CENT_DETECTED');
  psql(canonicalPnlHelper);

  // Mutation proof: run the same real-schema smoke against a cost-bucket
  // mutant. Sorting by cost before date consumes both $5 lots and the $5.01
  // lot ahead of one $6 unit, producing 6601 instead of canonical 6700.
  const issueStart = cogsSql.indexOf('CREATE FUNCTION public._issue_return_credit_impl(');
  const issueEnd = cogsSql.indexOf('-- Credit dates can differ', issueStart);
  assert.ok(issueStart >= 0 && issueEnd > issueStart, 'COGS migration issue helper slice is missing');
  const canonicalIssueHelper = cogsSql.slice(issueStart, issueEnd).replace(
    'CREATE FUNCTION public._issue_return_credit_impl(',
    'CREATE OR REPLACE FUNCTION public._issue_return_credit_impl(',
  );
  const unlinkedCostGuardMutant = canonicalIssueHelper.replace(
    /  -- A manually created cost credit[\s\S]*?  \) THEN RAISE EXCEPTION 'RETURN_CREDIT_UNLINKED_COST_LINE'; END IF;\r?\n\r?\n/,
    '',
  );
  assert.notEqual(unlinkedCostGuardMutant, canonicalIssueHelper, 'unlinked-cost guard mutant did not alter the executable helper');
  psql(unlinkedCostGuardMutant);
  const unlinkedCostMutantSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const unlinkedCostMutantOutput = `${unlinkedCostMutantSmoke.stdout}\n${unlinkedCostMutantSmoke.stderr}`;
  assert.notEqual(unlinkedCostMutantSmoke.status, 0, 'unlinked-cost guard mutant smoke unexpectedly committed');
  assert.match(unlinkedCostMutantOutput, /SMOKE_FAIL: unlinked cost credit was ignored by return issuance/, `unlinked-cost guard mutant did not reach the ambiguous-credit oracle:\n${unlinkedCostMutantOutput}`);
  completedProofs.add('UNLINKED_COST_GUARD_REMOVAL_DETECTED');
  psql(canonicalIssueHelper);

  const unclearedLineageMutant = canonicalIssueHelper.replace(
    /  PERFORM set_config\('app\.crx_return_credit_lineage', '0', true\);\r?\n/,
    '',
  );
  assert.notEqual(unclearedLineageMutant, canonicalIssueHelper, 'lineage-clear mutant did not alter the executable helper');
  psql(unclearedLineageMutant);
  const unclearedLineageSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const unclearedLineageOutput = `${unclearedLineageSmoke.stdout}\n${unclearedLineageSmoke.stderr}`;
  assert.notEqual(unclearedLineageSmoke.status, 0, 'lineage-clear mutant smoke unexpectedly committed');
  assert.match(unclearedLineageOutput, /SMOKE_FAIL: active return-credit header ledger was mutated/, `lineage-clear mutant did not reach the header bypass-window oracle:\n${unclearedLineageOutput}`);
  completedProofs.add('LINEAGE_CLEAR_REMOVAL_DETECTED');
  psql(canonicalIssueHelper);

  const groupedCostBucketMutant = canonicalIssueHelper.replaceAll(
    'PARTITION BY al.id ORDER BY al.invoice_date, al.created_at, al.source_item_id, al.line_cost_cents',
    'PARTITION BY al.id ORDER BY al.line_cost_cents, al.invoice_date, al.created_at, al.source_item_id',
  );
  assert.notEqual(groupedCostBucketMutant, canonicalIssueHelper, 'grouped-cost-bucket mutant did not alter the executable helper');
  psql(groupedCostBucketMutant);
  const mutantSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const mutantOutput = `${mutantSmoke.stdout}\n${mutantSmoke.stderr}`;
  assert.notEqual(mutantSmoke.status, 0, 'grouped-cost-bucket mutant smoke unexpectedly committed');
  assert.match(mutantOutput, /SMOKE_FAIL: RETURN_COGS_EXPECTED_6700 got[\s\S]*6601/, `grouped-cost-bucket mutant did not reach the 6601 accounting oracle:\n${mutantOutput}`);
  completedProofs.add('GROUPED_COST_BUCKET_6601_REJECTED');
  psql(canonicalIssueHelper);

  const creditSeasonMutant = canonicalIssueHelper.replace(
    'SET total_cost_cents = -v_cogs, season = public.current_season()',
    'SET total_cost_cents = -v_cogs, season = public.current_season() - 1',
  );
  assert.notEqual(creditSeasonMutant, canonicalIssueHelper, 'credit-season mutant did not alter current-season attribution');
  psql(creditSeasonMutant);
  const creditSeasonSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const creditSeasonOutput = `${creditSeasonSmoke.stdout}\n${creditSeasonSmoke.stderr}`;
  assert.notEqual(creditSeasonSmoke.status, 0, 'credit-season mutant smoke unexpectedly committed');
  assert.match(
    creditSeasonOutput,
    /SMOKE_FAIL: credit memo wrong:[\s\S]*season=|SMOKE_FAIL: current-season year-end omitted posted return credit|SMOKE_FAIL: current-season credit usage/,
    `credit-season mutant did not reach the cross-season oracle:\n${creditSeasonOutput}`,
  );
  completedProofs.add('CREDIT_CURRENT_SEASON_MUTATION_DETECTED');
  psql(canonicalIssueHelper);

  const fractionalDoubleRoundMutant = canonicalIssueHelper.replace(
    `(ROUND(cp.line_cost_cents * (cp.posted_qty - cp.available_qty + cp.part_qty))
       - ROUND(cp.line_cost_cents * (cp.posted_qty - cp.available_qty)))::bigint AS part_cost_cents`,
    'ROUND(cp.line_cost_cents * cp.part_qty)::bigint AS part_cost_cents',
  );
  assert.notEqual(fractionalDoubleRoundMutant, canonicalIssueHelper, 'fractional double-round mutant did not alter the executable allocation');
  psql(fractionalDoubleRoundMutant);
  const fractionalDoubleRoundSmoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const fractionalDoubleRoundOutput = `${fractionalDoubleRoundSmoke.stdout}\n${fractionalDoubleRoundSmoke.stderr}`;
  assert.notEqual(fractionalDoubleRoundSmoke.status, 0, 'fractional double-round mutant smoke unexpectedly committed');
  assert.match(
    fractionalDoubleRoundOutput,
    /SMOKE_FAIL: FRACTIONAL_COGS_EXPECTED_250 got[\s\S]*251/,
    `fractional double-round mutant did not reach the second-half oracle:\n${fractionalDoubleRoundOutput}`,
  );
  completedProofs.add('FRACTIONAL_COGS_DOUBLE_ROUNDING_DETECTED');
  psql(canonicalIssueHelper);

  const smoke = psql(`\\i /tmp/${path.basename(SMOKE)}`, { allowFailure: true });
  const output = `${smoke.stdout}\n${smoke.stderr}`;
  assert.notEqual(smoke.status, 0, 'canonical return-credit smoke committed instead of forcing rollback');
  assert.match(output, /SMOKE_PASS_ROLLBACK/, `canonical smoke did not reach SMOKE_PASS_ROLLBACK:\n${output}`);
  assert.match(output, /CURRENT_SEASON_CREDIT_ATTRIBUTION_PROVEN/, `canonical smoke did not prove current-season credit attribution:\n${output}`);
  completedProofs.add('CURRENT_SEASON_CREDIT_ATTRIBUTION_PROVEN');
  assert.equal(psqlValue("SELECT count(*) FROM public.customers WHERE farm_name LIKE '[SMOKE] Return Credit Farm %';"), '0', 'customer fixture residue remained');
  assert.equal(psqlValue("SELECT count(*) FROM public.returns WHERE return_number LIKE 'SMK-%';"), '0', 'return fixture residue remained');
  assert.equal(psqlValue("SELECT count(*) FROM public.invoices WHERE invoice_number LIKE 'SMK-RCC-%';"), '0', 'invoice fixture residue remained');
  assert.equal(psqlValue("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key LIKE 'smk-rcc-%';"), '0', 'receipt residue remained');
  assert.deepEqual([...completedProofs].sort(), [...expectedProofs].sort(), 'proof marker set does not match the mutant and direct-branch proofs that actually completed');
  const passMarker = wasAlreadyInstalled ? 'RETURN_CREDIT_POSTAPPLY_LIVE_PASS' : 'RETURN_CREDIT_REAL_SCHEMA_PASS';
  console.log(`${passMarker} source=fresh-live-read-only-schema candidate_migrations=${migrations.length} proofs=${[...completedProofs].join(',')} smoke=SMOKE_PASS_ROLLBACK residue=0`);
} catch (error) {
  console.error(`RETURN_CREDIT_REAL_SCHEMA_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
