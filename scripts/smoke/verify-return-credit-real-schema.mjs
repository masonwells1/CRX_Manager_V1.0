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
try {
  assert.ok(readFileSync(CANDIDATE, 'utf8').length > 0, 'candidate migration is missing');
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
  const migrations = [];
  if (preApplyViolations !== '0') {
    copy(CANDIDATE, 'candidate.sql');
    apply('candidate.sql');
    migrations.push(CANDIDATE);
  }
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
  const passMarker = migrations.length === 0 ? 'RETURN_CREDIT_POSTAPPLY_LIVE_PASS' : 'RETURN_CREDIT_REAL_SCHEMA_PASS';
  console.log(`${passMarker} source=fresh-live-read-only-schema candidate_migrations=${migrations.length} invariant_violations=0 smoke=SMOKE_PASS_ROLLBACK residue=0`);
} catch (error) {
  console.error(`RETURN_CREDIT_REAL_SCHEMA_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
