#!/usr/bin/env node
/**
 * Full-chain proof for the 2026-10-01 integrity-report fixes:
 *   20261007150000_record_deliveries_billed_outside_crx            (schema + guards + dashboard)
 *   20261007150100_mark_spring_2026_deliveries_billed_in_chem_man   (data: 53 deliveries)
 *   20261007150200_release_reservations_of_deleted_spring_orders    (data: stale reservations)
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container, replays every ordered post-baseline migration before the candidates, seeds a
 * fixture that mirrors the live rows these files target (the same delivery and order numbers,
 * and the live per-order/per-product reservation quantities of 2026-10-07 — stock units only),
 * and then proves:
 *   0. FIDELITY: get_dashboard_action_items replays with the live body (md5 pinned 2026-10-07).
 *   1. Each file run WITHOUT a transaction (psql -f, no -1) stops before changing anything.
 *   2. Schema file: a delivery can be recorded only when completed and not covered by an active
 *      CRX invoice; API roles cannot write the table, only admins can read it; CRX refuses an
 *      invoice for a recorded delivery and a whole-order invoice on its order, but still accepts
 *      an invoice for an unrecorded delivery and a whole-order invoice on an unrelated order;
 *      the dashboard's "Delivered, not invoiced" skips the recorded delivery only.
 *   3. MUTATION: without the invoice guard the double bill goes through, so step 2 tests it.
 *   4. Marking file: records exactly the 53 listed deliveries; re-applying changes nothing.
 *   5. Release file: every affected product's reservation ends equal to what live open orders
 *      owe, on-hand stock is untouched, one signed prebook_reconciliation row per order+product;
 *      re-applying is refused.
 * Never touches live: the container has no network and is removed at the end.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-billed-outside-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const SCHEMA = path.join(MIGRATIONS, '20261007150000_record_deliveries_billed_outside_crx.sql');
const LOCK = path.join(MIGRATIONS, '20261007150050_lock_soft_deleted_orders.sql');
const MARK = path.join(MIGRATIONS, '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql');
const RELEASE = path.join(MIGRATIONS, '20261007150200_release_reservations_of_deleted_spring_orders.sql');
const DASHBOARD = 'public.get_dashboard_action_items(integer)';
const DASHBOARD_LIVE_MD5 = 'd2fb4364e19598c3dbe9d998adae7fae';
// Same skip as the other real-schema provers: it rewrites storage policies the stub cannot host.
const PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);

const MASON = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'; // the recorder both data files pin
const REP = '6f000000-0000-4000-8000-00000000000b';
const DRIVER = '6f000000-0000-4000-8000-00000000000d';
const CUSTOMER = '6f000000-0000-4000-8000-0000000000c1';
const TEST_INVENTORY = '768ff8b5-dd45-4efa-b0b5-48b2c91036f2';
// Behaviour fixture: order P (deliveries P1, P2 completed; P3 scheduled), order Q (completed
// delivery covered by an active invoice), order R (unrelated, completed, nothing recorded).
const P = '6f000000-0000-4000-8000-0000000000e1';
const Q = '6f000000-0000-4000-8000-0000000000e2';
const R = '6f000000-0000-4000-8000-0000000000e3';
const P1 = '6f000000-0000-4000-8000-0000000000f1';
const P2 = '6f000000-0000-4000-8000-0000000000f2';
const P3 = '6f000000-0000-4000-8000-0000000000f3';
const Q1 = '6f000000-0000-4000-8000-0000000000f4';
const R1 = '6f000000-0000-4000-8000-0000000000f5';

// Live reservation shape, 2026-10-07 (product index, not identity): [order, product#, units].
const RELEASE_LINES = [
  ['ORD-2026-0181', 1, 20], ['ORD-2026-0181', 4, 17.5], ['ORD-2026-0181', 5, 45], ['ORD-2026-0181', 6, 6],
  ['ORD-2026-0181', 7, 17.5], ['ORD-2026-0181', 8, 45], ['ORD-2026-0181', 11, 84], ['ORD-2026-0181', 12, 131],
  ['ORD-2026-0181', 15, 1465], ['ORD-2026-0181', 16, 151], ['ORD-2026-0181', 20, 8], ['ORD-2026-0181', 21, 11],
  ['ORD-2026-0181', 22, 87], ['ORD-2026-0181', 23, 12.5], ['ORD-2026-0181', 24, 11], ['ORD-2026-0181', 25, 150],
  ['ORD-2026-0184', 2, 31.9], ['ORD-2026-0184', 9, 1049], ['ORD-2026-0184', 10, 60], ['ORD-2026-0184', 13, 63.8],
  ['ORD-2026-0184', 14, 37.2], ['ORD-2026-0184', 17, 175], ['ORD-2026-0184', 18, 87.5], ['ORD-2026-0184', 27, 8.5],
  ['ORD-2026-0185', 3, 27.4], ['ORD-2026-0185', 14, 31.3], ['ORD-2026-0185', 15, 500], ['ORD-2026-0185', 16, 62.5],
  ['ORD-2026-0185', 19, 62.5], ['ORD-2026-0185', 26, 125], ['ORD-2026-0187', 10, 24],
];
// What live open orders owed per product on 2026-10-07.
const LIVE_OPEN = {
  1: 191, 2: 0, 3: 175, 4: 157.53, 5: 121, 6: 0, 7: 64.5, 8: 0, 9: 0, 10: 0, 11: 2130, 12: 88.2, 13: 0, 14: 46,
  15: 19342, 16: 92, 17: 85, 18: 0, 19: 0, 20: 13, 21: 122.5, 22: 644.3, 23: 201.38, 24: 29.32, 25: 518, 26: 220, 27: 18.5,
};
const PARTIAL_ORDERS = new Set(['ORD-2026-0161', 'ORD-2026-0162', 'ORD-2026-0172', 'ORD-2026-0176', 'ORD-2026-0331', 'ORD-2026-0343']);

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') {
  return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
}
function psql(sql, options = {}) {
  return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure });
}
function scalar(sql) {
  return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  try {
    writeFileSync(staged, text, 'utf8');
    docker(['cp', staged, `${NAME}:/tmp/${name}`]);
  } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove staged file ${staged}: ${e.message}`); }
  }
}
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function apply(name, allowFailure = false) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function applyLoose(name) {
  const r = docker([...psqlArgs(), '-f', `/tmp/${name}`], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
function selected() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs', '--include-one-shot'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(SCHEMA);
  assert.ok(at >= 0, 'the schema candidate must be selected for post-baseline replay');
  assert.deepEqual(all.slice(at, at + 4), [SCHEMA, LOCK, MARK, RELEASE], 'the four candidates must replay consecutively, in order');
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/invoice|deliver|inventory|order_items|\borders\b/i.test(lf(file)), `${name} now touches the tables this proof covers; replay it or re-think the skip`);
  }
  return before.filter((f) => !PARKED.has(path.basename(f)));
}
// Live stores this one body with CRLF line endings, and a later migration pins that exact body.
function restoreLiveCrLfCloseRemainder() {
  const source = lf(path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const body = source.slice(bodyStart, source.indexOf(tag[0], bodyStart)).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}
function asUser(uid, role = 'authenticated') {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"${role}"}', true);\nSELECT set_config('request.jwt.claim.sub', '${uid}', true);\nSET LOCAL ROLE ${role};`;
}
/** Run `sql` (optionally as a user) in one transaction that is always ROLLED BACK. */
function probe(sql, uid = null) {
  const prefix = uid ? asUser(uid) : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${prefix}\n${sql}\nROLLBACK;\n`, allowFailure: true });
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { ok: r.status === 0, last: lines.at(-1) ?? '', error: r.stderr.trim() };
}
function expectRefused(result, pattern, label) {
  assert.equal(result.ok, false, `${label}: expected a refusal, but it succeeded (${result.last})`);
  assert.match(result.error, pattern, `${label}: refused for a different reason:\n${result.error}`);
}
function invoiceInsert(orderId, deliveryId, type = 'chemical_sale') {
  return `INSERT INTO public.invoices (invoice_number, created_by, customer_id, order_id, delivery_id, invoice_type, status)
    VALUES ('PROVER-INV-' || gen_random_uuid(), '${MASON}', '${CUSTOMER}', '${orderId}', ${deliveryId ? `'${deliveryId}'` : 'NULL'}, '${type}', 'draft') RETURNING 'inserted';`;
}
function markedPairs() {
  const src = lf(MARK);
  const pairs = [...src.matchAll(/\('(DEL-\d+)', '(ORD-2026-\d+)'\)/g)].map((m) => [m[1], m[2]]);
  assert.equal(pairs.length, 53, 'the marking file must list 53 deliveries');
  return pairs;
}

function seed() {
  const pairs = markedPairs();
  const orders = [...new Set(pairs.map(([, o]) => o))];
  const productRows = Object.keys(LIVE_OPEN).map((n) => {
    const released = RELEASE_LINES.filter(([, p]) => p === Number(n)).reduce((s, [, , q]) => s + q, 0);
    const id = `6f100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    return { n: Number(n), id, prebooked: Math.round((released + LIVE_OPEN[n]) * 100) / 100 };
  });
  const sql = [`
    INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${MASON}','billed-outside-prover-admin@example.invalid','{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
      ('${REP}','billed-outside-prover-rep@example.invalid','{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb),
      ('${DRIVER}','billed-outside-prover-driver@example.invalid','{"full_name":"[PROVER] Driver","role":"driver"}'::jsonb)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${MASON}','billed-outside-prover-admin@example.invalid','[PROVER] Admin','admin',true),
      ('${REP}','billed-outside-prover-rep@example.invalid','[PROVER] Rep','sales_rep',true),
      ('${DRIVER}','billed-outside-prover-driver@example.invalid','[PROVER] Driver','driver',true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
    INSERT INTO public.customers (id, farm_name, assigned_sales_rep, is_active) VALUES ('${CUSTOMER}', '[PROVER] Farm', '${REP}', true);
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, is_active) VALUES
      ${productRows.map((p) => `('${p.id}', '[PROVER] Product ${p.n}', 'GL', 6.00, 10.00, true)`).join(',\n      ')},
      ('6f100000-0000-4000-8000-0000000000ff', '1A TEST PRODUCT - FAKE PRODUCT', 'GL', 6.00, 10.00, false);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES
      ${productRows.map((p) => `('${p.id}', 'Main Warehouse', 100, ${p.prebooked}, 'GL')`).join(',\n      ')};
    INSERT INTO public.inventory (id, product_id, location, quantity_available, quantity_prebooked, unit_size)
      VALUES ('${TEST_INVENTORY}', '6f100000-0000-4000-8000-0000000000ff', 'Main Warehouse', 0, 36, 'GL');
  `];
  // The 33 spring orders and their 53 completed deliveries (same numbers as live).
  for (const o of orders) {
    sql.push(`INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${o}', '${CUSTOMER}', '2026-03-13', '${PARTIAL_ORDERS.has(o) ? 'partially_fulfilled' : 'fulfilled'}', false, '${REP}');`);
  }
  for (const [d, o] of pairs) {
    sql.push(`INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status, completed_at, signed_by)
      SELECT '${d}', o.id, '${CUSTOMER}', '${MASON}', 'completed', '2026-03-20T15:00:00Z', '[PROVER]' FROM public.orders o WHERE o.order_number = '${o}';`);
  }
  // Deleted orders still holding reservations (inserted already deleted: the soft-delete guard
  // that now prevents this only fires on UPDATE), plus one live open order per product.
  sql.push(`INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id, deleted_at) VALUES
      ('ORD-2026-0181', '${CUSTOMER}', '2026-03-13', 'confirmed', false, '${REP}', '2026-04-28T15:00:00Z'),
      ('ORD-2026-0184', '${CUSTOMER}', '2026-03-13', 'confirmed', false, '${REP}', '2026-04-28T15:00:00Z'),
      ('ORD-2026-0185', '${CUSTOMER}', '2026-03-13', 'confirmed', false, '${REP}', '2026-04-28T15:00:00Z'),
      ('ORD-2026-0187', '${CUSTOMER}', '2026-03-13', 'confirmed', false, '${REP}', '2026-03-27T15:00:00Z'),
      ('ORD-2026-0345', '${CUSTOMER}', '2026-03-19', 'partially_fulfilled', false, '${REP}', '2026-04-28T15:00:00Z'),
      ('PROVER-LIVE-OPEN', '${CUSTOMER}', current_date, 'confirmed', false, '${REP}', NULL);
    -- The deleted test order still has a completed delivery (as live ORD-2026-0345 does).
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status, completed_at, signed_by)
      SELECT 'PROVER-0345-D1', o.id, '${CUSTOMER}', '${MASON}', 'completed', '2026-03-20T15:00:00Z', '[PROVER]'
        FROM public.orders o WHERE o.order_number = 'ORD-2026-0345';`);
  const line = (orderNumber, n, q) => `INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
    SELECT o.id, '6f100000-0000-4000-8000-${String(n).padStart(12, '0')}', '[PROVER] line', 10, 6, ${q}, ${q} * 10, ${q} * 4, 40, 0, ${q}
      FROM public.orders o WHERE o.order_number = '${orderNumber}';`;
  for (const [o, n, q] of RELEASE_LINES) sql.push(line(o, n, q));
  for (const [n, q] of Object.entries(LIVE_OPEN)) if (q > 0) sql.push(line('PROVER-LIVE-OPEN', n, q));
  // Behaviour fixture.
  sql.push(`
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id) VALUES
      ('${P}', 'PROVER-P', '${CUSTOMER}', current_date, 'fulfilled', false, '${REP}'),
      ('${Q}', 'PROVER-Q', '${CUSTOMER}', current_date, 'fulfilled', false, '${REP}'),
      ('${R}', 'PROVER-R', '${CUSTOMER}', current_date, 'fulfilled', false, '${REP}');
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, completed_at, signed_by, scheduled_date) VALUES
      ('${P1}', 'PROVER-P1', '${P}', '${CUSTOMER}', '${MASON}', 'completed', now(), '[PROVER]', current_date),
      ('${P2}', 'PROVER-P2', '${P}', '${CUSTOMER}', '${MASON}', 'completed', now(), '[PROVER]', current_date),
      ('${P3}', 'PROVER-P3', '${P}', '${CUSTOMER}', '${MASON}', 'scheduled', NULL, NULL, current_date),
      ('${Q1}', 'PROVER-Q1', '${Q}', '${CUSTOMER}', '${MASON}', 'completed', now(), '[PROVER]', current_date),
      ('${R1}', 'PROVER-R1', '${R}', '${CUSTOMER}', '${MASON}', 'completed', now(), '[PROVER]', current_date);
    INSERT INTO public.invoices (invoice_number, created_by, customer_id, order_id, delivery_id, invoice_type, status)
      VALUES ('PROVER-INV-Q1', '${MASON}', '${CUSTOMER}', '${Q}', '${Q1}', 'chemical_sale', 'draft');
  `);
  psql(sql.join('\n'));
}

function recordedCount() { return scalar('SELECT count(*) FROM public.delivery_external_billings;'); }
function prebookedSnapshot() {
  return scalar(`SELECT string_agg(i.product_id || '=' || i.quantity_prebooked || '/' || i.quantity_available, ',' ORDER BY i.product_id) FROM public.inventory i;`);
}

async function main() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  if (scalar("SELECT count(*) FROM pg_roles WHERE rolname = 'metabase_ro';") === '0') psql('CREATE ROLE metabase_ro NOLOGIN;');

  const migrations = selected();
  for (const [i, file] of migrations.entries()) {
    if (path.basename(file) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name, true);
    if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} post-baseline migrations before the candidates`);

  // 0. FIDELITY.
  assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('${DASHBOARD}');`), DASHBOARD_LIVE_MD5, 'the dashboard function replayed with a body that differs from live');
  console.log('[prover] FIDELITY: get_dashboard_action_items matches the live body pin');

  seed();
  console.log('[prover] seeded 33 spring orders / 53 deliveries, the deleted-order reservations, and the behaviour fixture');

  // 1a + 2. Schema file.
  stageText('schema.sql', lf(SCHEMA)); stageText('lock.sql', lf(LOCK)); stageText('mark.sql', lf(MARK)); stageText('release.sql', lf(RELEASE));
  const schemaApplied = apply('schema.sql', true);
  assert.equal(schemaApplied.status, 0, `the schema file did not apply:\n${schemaApplied.output}`);

  expectRefused(probe(`INSERT INTO public.delivery_external_billings (delivery_id, reason) VALUES ('${P3}', 'x');`), /EXTERNAL_BILLING_REQUIRES_COMPLETED_ORDER_DELIVERY/, 'record a scheduled delivery');
  expectRefused(probe(`INSERT INTO public.delivery_external_billings (delivery_id, reason) VALUES ('${Q1}', 'x');`), /DELIVERY_ALREADY_INVOICED_IN_CRX/, 'record an invoiced delivery');
  expectRefused(probe(`INSERT INTO public.delivery_external_billings (delivery_id, reason) VALUES ('${P1}', '   ');`), /delivery_external_billings_reason_chk/, 'blank reason');
  expectRefused(probe(`INSERT INTO public.delivery_external_billings (delivery_id, reason) VALUES ('${P1}', 'x');`, MASON), /permission denied/, 'admin API write');
  psql(`INSERT INTO public.delivery_external_billings (delivery_id, reason, recorded_by) VALUES ('${P1}', '[PROVER] billed elsewhere', '${MASON}');`);
  assert.equal(probe('SELECT count(*) FROM public.delivery_external_billings;', MASON).last, '1', 'an admin must read the record');
  assert.equal(probe('SELECT count(*) FROM public.delivery_external_billings;', REP).last, '1', 'a sales rep must read the record (Office Cockpit)');
  assert.equal(probe('SELECT count(*) FROM public.delivery_external_billings;', DRIVER).last, '0', 'a driver must not read the record');
  console.log('[prover] RECORDING: only completed, uninvoiced deliveries; no API writes; admins and sales reps read, drivers do not');

  expectRefused(probe(invoiceInsert(P, P1)), /DELIVERY_BILLED_OUTSIDE_CRX: this delivery was billed outside CRX/, 'invoice a recorded delivery');
  expectRefused(probe(invoiceInsert(P, null)), /DELIVERY_BILLED_OUTSIDE_CRX: this order has deliveries billed outside CRX/, 'whole-order invoice on its order');
  expectRefused(probe(invoiceInsert(P, null, 'misc_charge')), /DELIVERY_BILLED_OUTSIDE_CRX/, 'whole-order misc charge on its order');
  assert.equal(probe(invoiceInsert(P, P2)).last, 'inserted', 'an unrecorded delivery on the same order must still be billable');
  assert.equal(probe(invoiceInsert(R, null)).last, 'inserted', 'a whole-order invoice on an unrelated order must still work');
  // A soft-deleted invoice does not block recording its delivery; restoring it afterwards must be refused.
  expectRefused(probe(`INSERT INTO public.invoices (invoice_number, created_by, customer_id, order_id, delivery_id, invoice_type, status, deleted_at)
      VALUES ('PROVER-INV-R1', '${MASON}', '${CUSTOMER}', '${R}', '${R1}', 'chemical_sale', 'draft', now());
    INSERT INTO public.delivery_external_billings (delivery_id, reason) VALUES ('${R1}', '[PROVER] billed elsewhere');
    UPDATE public.invoices SET deleted_at = NULL WHERE invoice_number = 'PROVER-INV-R1';`), /DELIVERY_BILLED_OUTSIDE_CRX: this delivery was billed outside CRX/, 'restore an invoice for a recorded delivery');
  console.log('[prover] GUARD: CRX refuses to bill a recorded delivery or its whole order; other billing still works');

  // A recorded delivery cannot leave its order (Sol, 2026-10-09): a move would hide it from the
  // whole-order check on the original order.
  expectRefused(probe(`UPDATE public.deliveries SET order_id = '${R}' WHERE id = '${P1}';`, MASON), /BILLED_OUTSIDE_DELIVERY_ORDER_LOCKED/, 'move a recorded delivery to another order');
  expectRefused(probe(`UPDATE public.deliveries SET order_id = '${R}' WHERE id = '${P1}';`), /BILLED_OUTSIDE_DELIVERY_ORDER_LOCKED/, 'move a recorded delivery as postgres');
  expectRefused(probe(`UPDATE public.deliveries SET order_id = NULL WHERE id = '${P1}';`), /BILLED_OUTSIDE_DELIVERY_ORDER_LOCKED/, 'detach a recorded delivery from its order');
  assert.equal(probe(`UPDATE public.deliveries SET order_id = order_id WHERE id = '${P1}'; SELECT 'updated';`).last, 'updated', 'an update that keeps the order must still work');
  // A driver may edit their own completed delivery but cannot read the records (RLS), so the lock
  // must run as its owner: refused as SECURITY DEFINER, allowed when flipped to INVOKER.
  const driverMove = (extra = '') => probe(`${extra}
    UPDATE public.deliveries SET assigned_driver = '${DRIVER}' WHERE id = '${P1}';
    ${asUser(DRIVER)}
    UPDATE public.deliveries SET order_id = '${R}' WHERE id = '${P1}' RETURNING 'moved';`);
  expectRefused(driverMove(), /BILLED_OUTSIDE_DELIVERY_ORDER_LOCKED/, 'an assigned driver moves a recorded delivery');
  const invokerMutant = driverMove('ALTER FUNCTION public.refuse_billed_outside_delivery_reparent() SECURITY INVOKER;');
  assert.equal(invokerMutant.last, 'moved', `MUTATION: as SECURITY INVOKER the driver cannot see the record, so the move should go through:\n${invokerMutant.error}`);
  const reparentMutant = probe(`DROP TRIGGER guard_billed_outside_delivery_order_locked ON public.deliveries;
    UPDATE public.deliveries SET order_id = '${R}' WHERE id = '${P1}';
    ${invoiceInsert(P, null)}`);
  assert.equal(reparentMutant.last, 'inserted', `MUTATION: without the order lock a moved delivery should let the original order be billed whole:\n${reparentMutant.error}`);
  console.log('[prover] ORDER LOCK: a recorded delivery cannot be moved or detached (admin, driver, postgres); as INVOKER a driver could move it; without the lock the original order bills whole again');

  const dashboard = probe(`SELECT (SELECT string_agg(x->>'primary_text', ',' ORDER BY x->>'primary_text') FROM jsonb_array_elements(public.get_dashboard_action_items(500)->'unbilled_deliveries') x);`, MASON).last;
  assert.ok(!dashboard.split(',').includes('PROVER-P1'), `the dashboard still lists the recorded delivery: ${dashboard}`);
  assert.ok(dashboard.split(',').includes('PROVER-P2') && dashboard.split(',').includes('PROVER-R1'), `the dashboard dropped an unbilled delivery: ${dashboard}`);
  console.log('[prover] DASHBOARD: "Delivered, not invoiced" skips only the recorded delivery');

  // 3. MUTATION.
  const mutant = probe(`DROP TRIGGER zz_guard_invoice_delivery_billed_outside_crx ON public.invoices;\n${invoiceInsert(P, P1)}`);
  assert.equal(mutant.last, 'inserted', `without the guard the double bill should go through:\n${mutant.error}`);
  console.log('[prover] MUTATION: without the guard trigger the double bill succeeds - the guard is what stops it');

  // 1b + 4. Marking file.
  const before = recordedCount();
  const looseMark = applyLoose('mark.sql');
  assert.notEqual(looseMark.status, 0, 'the marking file ran outside a transaction');
  assert.equal(recordedCount(), before, 'the loose marking run changed data');
  const marked = apply('mark.sql', true);
  assert.equal(marked.status, 0, `the marking file did not apply:\n${marked.output}`);
  assert.equal(recordedCount(), String(Number(before) + 53), 'the marking file must record exactly 53 deliveries');
  assert.equal(apply('mark.sql', true).status, 0, 'a re-apply of the marking file must be a no-op');
  assert.equal(recordedCount(), String(Number(before) + 53), 'a re-apply changed the records');
  console.log('[prover] MARK: exactly 53 deliveries recorded; loose run refused; re-apply is a no-op');

  // 4b. Deleted-order lock (schema). The release refuses until it is installed.
  const early = apply('release.sql', true);
  assert.notEqual(early.status, 0, 'the release applied before the deleted-order lock');
  assert.match(early.output, /apply 20261007150050_lock_soft_deleted_orders first/, `wrong early-release refusal:\n${early.output}`);
  stageText('lock-bad.sql', `INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status, scheduled_date)
    SELECT 'PROVER-STRANDED', o.id, '${CUSTOMER}', '${MASON}', 'scheduled', current_date FROM public.orders o WHERE o.order_number = 'ORD-2026-0181';
${lf(LOCK)}`);
  const stranded = apply('lock-bad.sql', true);
  assert.notEqual(stranded.status, 0, 'the lock installed over a deleted order with an open delivery');
  assert.match(stranded.output, /DELETED_ORDER_LOCK_PREFLIGHT: a soft-deleted order still has an open delivery/, `wrong stranded-delivery refusal:\n${stranded.output}`);
  const locked = apply('lock.sql', true);
  assert.equal(locked.status, 0, `the lock file did not apply:\n${locked.output}`);
  const deletedLines = "(SELECT id FROM public.orders WHERE order_number = 'ORD-2026-0181')";
  expectRefused(probe(`UPDATE public.order_items SET quantity_remaining = 0 WHERE order_id = ${deletedLines};`), /ORDER_DELETED_LINES_LOCKED/, 'edit a deleted order line');
  expectRefused(probe(`DELETE FROM public.order_items WHERE order_id = ${deletedLines};`), /ORDER_DELETED_LINES_LOCKED/, 'remove a deleted order line');
  expectRefused(probe("UPDATE public.orders SET deleted_at = NULL WHERE order_number = 'ORD-2026-0181';"), /ORDER_DELETED_STATUS_LOCKED/, 'un-delete a deleted order');
  expectRefused(probe("SELECT set_config('app.admin_override', 'true', true); UPDATE public.deliveries SET status = 'voided' WHERE delivery_number = 'PROVER-0345-D1';"), /ORDER_DELETED_DELIVERIES_LOCKED/, 'void a delivery of a deleted order');
  expectRefused(probe(`INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status, scheduled_date)
    SELECT 'PROVER-NEW-ON-DELETED', o.id, '${CUSTOMER}', '${MASON}', 'scheduled', current_date FROM public.orders o WHERE o.order_number = 'ORD-2026-0345';`), /ORDER_DELETED_DELIVERIES_LOCKED/, 'schedule a delivery on a deleted order');
  const voidMutant = probe("SELECT set_config('app.admin_override', 'true', true); DROP TRIGGER guard_deleted_order_deliveries_locked ON public.deliveries; UPDATE public.deliveries SET status = 'voided' WHERE delivery_number = 'PROVER-0345-D1'; SELECT 'voided';");
  assert.equal(voidMutant.last, 'voided', `MUTATION: without the delivery lock the void should go through:\n${voidMutant.error}`);
  const otherDelivery = probe("SELECT set_config('app.admin_override', 'true', true); UPDATE public.deliveries SET status = 'voided' WHERE id = '" + P2 + "'; SELECT 'voided';");
  assert.equal(otherDelivery.last, 'voided', `a delivery on a live order must still change status:\n${otherDelivery.error}`);
  const liveEdit = probe("UPDATE public.order_items SET quantity_remaining = quantity_remaining WHERE order_id = (SELECT id FROM public.orders WHERE order_number = 'PROVER-LIVE-OPEN'); SELECT 'updated';");
  assert.equal(liveEdit.last, 'updated', `a live order line must stay editable:\n${liveEdit.error}`);
  console.log("[prover] LOCK FILE: refuses to strand an open delivery; deleted orders cannot be un-deleted and their lines and deliveries are frozen (without the delivery lock a void goes through), live ones are not; the release waits for it");

  // 1c + 5. Release file.
  const snapshot = prebookedSnapshot();
  const looseRelease = applyLoose('release.sql');
  assert.notEqual(looseRelease.status, 0, 'the release file ran outside a transaction');
  assert.equal(prebookedSnapshot(), snapshot, 'the loose release run changed inventory');
  const released = apply('release.sql', true);
  assert.equal(released.status, 0, `the release file did not apply:\n${released.output}`);
  const mismatched = scalar(`SELECT count(*) FROM public.inventory i
    WHERE i.quantity_prebooked <> coalesce((SELECT sum(oi.quantity_remaining) FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
      WHERE oi.product_id = i.product_id AND oi.quantity_remaining > 0 AND o.deleted_at IS NULL AND o.status IN ('confirmed','partially_fulfilled')), 0);`);
  assert.equal(mismatched, '0', 'after the release every reservation must equal what live open orders owe');
  assert.equal(scalar('SELECT count(*) FROM public.inventory WHERE quantity_available <> CASE WHEN id = \'' + TEST_INVENTORY + '\' THEN 0 ELSE 100 END;'), '0', 'the release changed on-hand stock');
  assert.equal(scalar("SELECT count(*) || '|' || sum(quantity) FROM public.inventory_transactions WHERE transaction_type = 'prebook_reconciliation';"), '32|-4643.1', 'expected 32 signed ledger rows totalling -4643.1');
  const again = apply('release.sql', true);
  assert.notEqual(again.status, 0, 'the release file applied twice');
  assert.match(again.output, /RELEASE_PREFLIGHT: already applied/, `wrong second-run refusal:\n${again.output}`);
  console.log('[prover] RELEASE: 28 reservations now match live open orders, on-hand untouched, 32 ledger rows; a second run is refused');

  // 6. A released deleted order can never release again through cancel_order.
  const cancelDeleted = (extra = '') => probe(`${extra}
    SELECT public.cancel_order((SELECT id FROM public.orders WHERE order_number = 'ORD-2026-0181'), '${MASON}', 'prover-cancel-deleted');
    SELECT sum(quantity_prebooked) FROM public.inventory;`, MASON);
  const afterRelease = scalar('SELECT sum(quantity_prebooked) FROM public.inventory;');
  expectRefused(cancelDeleted(), /ORDER_DELETED_(STATUS|LINES)_LOCKED/, 'cancel a deleted order');
  assert.equal(scalar('SELECT sum(quantity_prebooked) FROM public.inventory;'), afterRelease, 'a refused cancel changed reservations');
  const liveCancel = probe(`SELECT public.cancel_order((SELECT id FROM public.orders WHERE order_number = 'PROVER-LIVE-OPEN'), '${MASON}', 'prover-cancel-live');
    SELECT status FROM public.orders WHERE order_number = 'PROVER-LIVE-OPEN';`, MASON);
  assert.equal(liveCancel.last, 'cancelled', `cancelling a live order must still work:\n${liveCancel.error}`);
  const mutantCancel = probe(`SET LOCAL ROLE postgres; DROP TRIGGER guard_deleted_order_status_locked ON public.orders; DROP TRIGGER guard_deleted_order_lines_locked ON public.order_items; RESET ROLE;
    ${asUser(MASON)}
    SELECT public.cancel_order((SELECT id FROM public.orders WHERE order_number = 'ORD-2026-0181'), '${MASON}', 'prover-cancel-mutant');
    SELECT sum(quantity_prebooked) FROM public.inventory;`);
  assert.equal(mutantCancel.ok, true, `MUTATION: without the lock the deleted-order cancel should go through:\n${mutantCancel.error}`);
  assert.ok(Number(mutantCancel.last) < Number(afterRelease), 'MUTATION: without the lock the cancel should release reservations again');
  console.log('[prover] LOCK: cancelling a released deleted order is refused (reservations unchanged); live orders still cancel; without the lock it double-releases');

  console.log('BILLED_OUTSIDE_CRX_PROOF_PASS recording=guarded guard=refuses_double_bill order_lock=enforced dashboard=excludes mutation=detected mark=53 release=reconciled rerun=safe deleted_order_lock=enforced');
}

try { await main(); }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
