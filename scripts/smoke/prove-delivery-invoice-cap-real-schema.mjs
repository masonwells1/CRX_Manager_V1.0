#!/usr/bin/env node
/**
 * Real-schema proof for 20261010120000_cap_delivery_invoice_at_delivered (Sol exact-SHA HIGH on
 * PR #889, 2026-10-10): a delivery invoice can bill only the products and quantities its delivery
 * delivered.
 *
 * Builds the checked-in production schema baseline in a network-disabled Supabase PostgreSQL 17
 * container, replays every ordered post-baseline schema migration (one-shot data files excluded),
 * applies the candidate, seeds one order with two completed deliveries (D1 delivered 6 of the 10
 * ordered units of product A; D2 delivered product B), creates D1's draft invoice through the real
 * create_invoice_for_unbilled_delivery, and then proves, through the real save_invoice as an admin
 * and as the customer's sales rep:
 *   REFUSED  applying the candidate before 20261007150200; raising D1's line above 6; adding product B (delivered by D2, so a double bill);
 *            adding a second unlinked line of A; linking D2's order line (even at quantity 0); a
 *            line with no product; a negative line; a second invoice for D1; a direct table write;
 *            posting or restoring an over-billed invoice; posting a quick delivery's invoice before
 *            the delivery is completed; the second of two concurrent transactions that together over-bill one delivery.
 *   ALLOWED  saving unchanged, lowering the quantity, changing the price; posting the valid invoice;
 *            lowering an over-billed draft; marking an already over-billed posted invoice overdue
 *            (never re-checked); batch_post_invoices posting the good invoice and reporting the bad
 *            one; a quick delivery's up-front invoice and its partial completion (cut down to what
 *            was delivered), even when the office split its line first (the driver is never
 *            blocked; posting is); complete_delivery's automatic invoice for an ordinary delivery.
 *   MUTATION without the two triggers the over-bill and the double bill go through; without the
 *            order lock, the concurrent over-bill goes through.
 * Every probe runs in one transaction that is rolled back; the concurrency proof commits. Never
 * touches live: the container has no network and is removed at the end.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-delivery-cap-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CAP = path.join(MIGRATIONS, '20261010120000_cap_delivery_invoice_at_delivered.sql');
// Same skip as the other real-schema provers: it rewrites storage policies the stub cannot host.
const PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);

const ADMIN = '6f200000-0000-4000-8000-00000000000a';
const REP = '6f200000-0000-4000-8000-00000000000b';
const CUSTOMER = '6f200000-0000-4000-8000-0000000000c1';
const PRODUCT_A = '6f200000-0000-4000-8000-0000000000a1';
const PRODUCT_B = '6f200000-0000-4000-8000-0000000000b1';
const ORDER = '6f200000-0000-4000-8000-0000000000e1';
const LINE_A = '6f200000-0000-4000-8000-0000000000e2';
const LINE_B = '6f200000-0000-4000-8000-0000000000e3';
const D1 = '6f200000-0000-4000-8000-0000000000f1';
const D2 = '6f200000-0000-4000-8000-0000000000f2';
const CAP_ERROR = /DELIVERY_INVOICE_EXCEEDS_DELIVERED/;

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
function apply(name) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure: true });
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
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  assert.equal(all.at(-1), CAP, 'the candidate must be the last schema migration in the replay plan');
  const before = all.slice(0, -1);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/invoice|deliver/i.test(lf(file)), `${name} now touches the tables this proof covers; replay it or re-think the skip`);
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
/** Run `sql` (optionally as a user) in one transaction, report the last value, and always ROLL BACK. */
function probe(sql, uid = null) {
  const prefix = uid ? asUser(uid) : '';
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${prefix}\n${sql}\nSELECT 'committed-ok';\nROLLBACK;\n`, allowFailure: true });
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { ok: r.status === 0 && lines.at(-1) === 'committed-ok', last: lines.at(-2) ?? '', error: r.stderr.trim() };
}
function expectRefused(result, pattern, label) {
  assert.equal(result.ok, false, `${label}: expected a refusal, but it succeeded (${result.last})`);
  assert.match(result.error, pattern, `${label}: refused for a different reason:\n${result.error}`);
}
function expectAllowed(result, label) {
  assert.equal(result.ok, true, `${label}: expected success, but it was refused:\n${result.error}`);
}

/**
 * The real save_invoice on invoice `number` as `uid`, with the lines rebuilt from the invoice's
 * current lines the way the editor sends them. The payload is read as postgres first, so the call
 * always happens; a successful save reports 'saved=true'.
 */
function saveInvoice(number, uid, { qty = 'ii.quantity', price = 'ii.unit_price_cents', extra = "'[]'::jsonb" } = {}) {
  const where = number.includes(' ') ? number : `i.invoice_number = '${number}'`;
  return `CREATE TEMP TABLE save_args ON COMMIT DROP AS SELECT
      jsonb_build_object('id', i.id, 'customer_id', i.customer_id, 'invoice_type', i.invoice_type,
        'order_id', i.order_id, 'delivery_id', i.delivery_id, 'invoice_date', i.invoice_date::text) AS inv,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', ii.id, 'order_item_id', ii.order_item_id,
          'product_id', ii.product_id, 'description', ii.description, 'quantity', ${qty},
          'unit_price_cents', ${price}, 'extended_cents', round((${qty}) * (${price}))::bigint,
          'cost_cents', ii.cost_cents, 'sort_order', ii.sort_order, 'unit_size', ii.unit_size) ORDER BY ii.sort_order)
        FROM public.invoice_items ii WHERE ii.invoice_id = i.id), '[]'::jsonb) || ${extra} AS items
    FROM public.invoices i WHERE ${where};
    GRANT SELECT ON save_args TO authenticated;
    ${asUser(uid)}
    SELECT 'saved=' || (public.save_invoice(inv, items, gen_random_uuid()::text) IS NOT NULL) FROM save_args;`;
}
/**
 * Two transactions each add a 3-unit invoice for D1 and commit: A holds its transaction open for
 * four seconds after writing; B starts while A is open. Returns both exit codes and B's errors.
 */
async function race(tag) {
  const invoice = (n) => `INSERT INTO public.invoices (id, invoice_number, created_by, customer_id, order_id, delivery_id, invoice_type, status)
      VALUES ('6f200000-0000-4000-8000-${String(n).padStart(12, '0')}', 'PROVER-CAP-RACE-${tag}${n}', '${ADMIN}', '${CUSTOMER}', '${ORDER}', '${D1}', 'chemical_sale', 'draft');
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents)
      VALUES ('6f200000-0000-4000-8000-${String(n).padStart(12, '0')}', '${PRODUCT_A}', '[PROVER] race', 3, 1000, 3000, 600);`;
  const base = { R: 901, C: 911, M: 921 }[tag];
  const a = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
  const aDone = new Promise((resolve) => a.on('close', resolve));
  a.stdin.end(`BEGIN;\n${invoice(base)}\nSELECT pg_sleep(4);\nCOMMIT;\n`);
  wait(1500);
  const b = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${invoice(base + 1)}\nCOMMIT;\n`, allowFailure: true });
  return { a: await aDone, b: b.status, bError: b.stderr };
}
function expectSaved(result, label) {
  expectAllowed(result, label);
  assert.equal(result.last, 'saved=true', `${label}: save_invoice did not run (${result.last})`);
}
function newLine(productId, qty, orderItemId = null) {
  return `jsonb_build_array(jsonb_build_object('product_id', '${productId}', ${orderItemId ? `'order_item_id', '${orderItemId}', ` : ''}'description', '[PROVER] added',
    'quantity', ${qty}, 'unit_price_cents', 1000, 'extended_cents', ${qty} * 1000, 'cost_cents', 600, 'sort_order', 99, 'unit_size', 'Gal'))`;
}
function lineQty(number) {
  return scalar(`SELECT string_agg(ii.quantity::numeric(12,2)::text, ',' ORDER BY ii.sort_order) FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.invoice_number = '${number}';`);
}

function seed() {
  psql(`BEGIN;
    INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${ADMIN}','delivery-cap-prover-admin@example.invalid','{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb),
      ('${REP}','delivery-cap-prover-rep@example.invalid','{"full_name":"[PROVER] Rep","role":"sales_rep"}'::jsonb)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${ADMIN}','delivery-cap-prover-admin@example.invalid','[PROVER] Admin','admin',true),
      ('${REP}','delivery-cap-prover-rep@example.invalid','[PROVER] Rep','sales_rep',true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
    INSERT INTO public.customers (id, farm_name, assigned_sales_rep, assigned_tier, is_active) VALUES ('${CUSTOMER}', '[PROVER] Farm', '${REP}', 1, true);
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, tier2_price, tier3_price, is_active) VALUES
      ('${PRODUCT_A}', '[PROVER] Product A', 'Gal', 6.00, 10.00, 10.00, 10.00, true),
      ('${PRODUCT_B}', '[PROVER] Product B', 'Gal', 6.00, 10.00, 10.00, 10.00, true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES
      ('${PRODUCT_A}', 'Main Warehouse', 1000, 0, 'Gal'), ('${PRODUCT_B}', 'Main Warehouse', 1000, 0, 'Gal');
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${ORDER}', 'PROVER-CAP-ORDER', '${CUSTOMER}', current_date, 'partially_fulfilled', false, '${REP}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining) VALUES
      ('${LINE_A}', '${ORDER}', '${PRODUCT_A}', '[PROVER] Product A', 'Gal', 10, 6, 10, 100, 40, 40, 6, 4),
      ('${LINE_B}', '${ORDER}', '${PRODUCT_B}', '[PROVER] Product B', 'Gal', 10, 6, 5, 50, 20, 40, 5, 0);
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, completed_at, signed_by, scheduled_date) VALUES
      ('${D1}', 'PROVER-CAP-D1', '${ORDER}', '${CUSTOMER}', '${ADMIN}', 'completed', now(), '[PROVER]', current_date),
      ('${D2}', 'PROVER-CAP-D2', '${ORDER}', '${CUSTOMER}', '${ADMIN}', 'completed', now(), '[PROVER]', current_date);
    -- Completed deliveries as complete_delivery leaves them (their items are locked once completed).
    ALTER TABLE public.delivery_items DISABLE TRIGGER enforce_delivery_items_parent_lock;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size) VALUES
      ('${D1}', '${LINE_A}', '${PRODUCT_A}', 10, 6, 'Gal'),
      ('${D2}', '${LINE_B}', '${PRODUCT_B}', 5, 5, 'Gal');
    ALTER TABLE public.delivery_items ENABLE TRIGGER enforce_delivery_items_parent_lock;
    COMMIT;`);
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} post-baseline schema migrations before the candidate`);

  seed();
  // D1's draft invoice, through the real backfill RPC, committed before the candidate exists.
  psql(`${'BEGIN;'}\n${asUser(ADMIN)}\nSELECT public.create_invoice_for_unbilled_delivery('${D1}', '${ADMIN}', 'prover-cap-d1');\nCOMMIT;`);
  const INV1 = scalar(`SELECT invoice_number FROM public.invoices WHERE delivery_id = '${D1}';`);
  assert.ok(INV1, 'the backfill must create D1\'s invoice');
  assert.equal(lineQty(INV1), '6.00', 'D1\'s invoice must bill the 6 delivered units');

  // The defect, before the candidate: a rep raises the quantity and adds D2's product.
  const before = probe(saveInvoice(INV1, REP, { qty: '10', extra: newLine(PRODUCT_B, 5) }));
  expectSaved(before, 'BEFORE the candidate the over-bill must go through (defect reproduced)');
  console.log('[prover] DEFECT: before the candidate a rep can bill 10 of 6 delivered and add a product another delivery carried');

  stageText('cap.sql', lf(CAP));
  // ORDERING: refused until the owner-approved 20261007150200 is in the ledger (one-shot data files
  // are not replayed here, so its ledger row is recorded by hand).
  const early = apply('cap.sql');
  assert.notEqual(early.status, 0, 'the candidate applied before 20261007150200');
  assert.match(early.output, /apply 20261007150200_release_reservations_of_deleted_spring_orders first/, `wrong ordering refusal:\n${early.output}`);
  psql("INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261007150200', '20261007150200_release_reservations_of_deleted_spring_orders');");
  const applied = apply('cap.sql');
  assert.equal(applied.status, 0, `the candidate did not apply:\n${applied.output}`);
  assert.equal(apply('cap.sql').status, 0, 'the candidate must re-apply cleanly');

  // REFUSED, through the real save_invoice.
  for (const [who, uid] of [['admin', ADMIN], ['sales rep', REP]]) {
    expectRefused(probe(saveInvoice(INV1, uid, { qty: '10' })), /bills 10\.0+ of \[PROVER\] Product A, but delivery PROVER-CAP-D1 allows 6/, `${who} raises the quantity`);
    expectRefused(probe(saveInvoice(INV1, uid, { extra: newLine(PRODUCT_B, 5) })), CAP_ERROR, `${who} adds a product another delivery carried`);
    expectRefused(probe(saveInvoice(INV1, uid, { extra: newLine(PRODUCT_A, 1) })), /bills 7\.0+ of \[PROVER\] Product A/, `${who} adds an unlinked line of the same product`);
  }
  // save_invoice drops the order link of a new line, so a linked line arrives only by a direct write.
  expectRefused(probe(saveInvoice(INV1, ADMIN, { extra: newLine(PRODUCT_B, 1, LINE_B) })), /bills 1\.0+ of \[PROVER\] Product B, but delivery PROVER-CAP-D1 allows 0/, 'save a line for D2\'s order line');
  expectRefused(probe(`INSERT INTO public.invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents)
      SELECT i.id, '${LINE_B}', '${PRODUCT_B}', '[PROVER] linked', 1, 1000, 1000, 600 FROM public.invoices i WHERE i.invoice_number = '${INV1}';`),
    /bills \[PROVER\] linked from an order line delivery PROVER-CAP-D1 did not carry/, 'link D2\'s order line');
  expectRefused(probe(`INSERT INTO public.invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents)
      SELECT i.id, '${LINE_B}', '${PRODUCT_B}', '[PROVER] linked', 0, 1000, 0, 600 FROM public.invoices i WHERE i.invoice_number = '${INV1}';`),
    /did not carry/, 'link D2\'s order line at quantity 0');
  assert.equal(lineQty(INV1), '6.00', 'refused saves changed nothing');
  console.log('[prover] SAVE_INVOICE: admin and rep cannot raise the quantity, add another delivery\'s product, add a second line, or link another delivery\'s order line');

  const inv1Id = `(SELECT id FROM public.invoices WHERE invoice_number = '${INV1}')`;
  expectRefused(probe(`INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents)
      VALUES (${inv1Id}, '[PROVER] fee', 1, 5000, 5000, 0);`), /no product or a negative quantity/, 'a line with no product');
  expectRefused(probe(`INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents)
      VALUES (${inv1Id}, '${PRODUCT_A}', '[PROVER] negative', -1, 1000, -1000, 600);`), /no product or a negative quantity/, 'a negative line');
  expectRefused(probe(`INSERT INTO public.invoices (id, invoice_number, created_by, customer_id, order_id, delivery_id, invoice_type, status)
      VALUES ('6f200000-0000-4000-8000-0000000000d2', 'PROVER-CAP-SECOND', '${ADMIN}', '${CUSTOMER}', '${ORDER}', '${D1}', 'chemical_sale', 'draft');
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents)
      VALUES ('6f200000-0000-4000-8000-0000000000d2', '${PRODUCT_A}', '[PROVER] second', 1, 1000, 1000, 600);`), /bills 7\.0+ of \[PROVER\] Product A/, 'a second invoice for the same delivery');
  // A real transaction that tries to COMMIT: the write is refused and nothing persists.
  const committed = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\nUPDATE public.invoice_items SET quantity = 9 WHERE invoice_id = ${inv1Id};\nCOMMIT;\n`, allowFailure: true });
  assert.notEqual(committed.status, 0, 'a direct over-billing write must be refused');
  assert.match(committed.stderr, CAP_ERROR, `the write failed for a different reason:\n${committed.stderr}`);
  assert.equal(lineQty(INV1), '6.00', 'the refused write persisted');
  console.log('[prover] TABLE: no product-less or negative lines, no second invoice past the delivery, and a direct write is refused');

  // An order is billed per delivery OR whole-order, never both (the cap cannot see an order-level invoice).
  const wholeOrderSave = `CREATE TEMP TABLE save_args ON COMMIT DROP AS SELECT
      jsonb_build_object('customer_id', '${CUSTOMER}', 'invoice_type', 'chemical_sale', 'order_id', '${ORDER}',
        'invoice_date', current_date::text) AS inv,
      ${newLine(PRODUCT_A, 6)} AS items;
    GRANT SELECT ON save_args TO authenticated;
    ${asUser(ADMIN)}
    SELECT 'saved=' || (public.save_invoice(inv, items, gen_random_uuid()::text) IS NOT NULL) FROM save_args;`;
  expectRefused(probe(wholeOrderSave), /ORDER_INVOICE_OVERLAPS_DELIVERY_INVOICE: this order is already billed per delivery/, 'save a whole-order invoice on an order billed per delivery');
  const orderLevel = (orderId, number) => `INSERT INTO public.invoices (invoice_number, created_by, customer_id, order_id, invoice_type, status)
      VALUES ('${number}', '${ADMIN}', '${CUSTOMER}', '${orderId}', 'chemical_sale', 'draft');`;
  expectRefused(probe(orderLevel(ORDER, 'PROVER-CAP-WHOLE')), /already billed per delivery \(invoice /, 'insert a whole-order invoice on an order billed per delivery');
  const otherOrder = '6f200000-0000-4000-8000-0000000000e9';
  const otherDelivery = '6f200000-0000-4000-8000-0000000000f9';
  expectRefused(probe(`INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
      VALUES ('${otherOrder}', 'PROVER-CAP-ORDER-2', '${CUSTOMER}', current_date, 'fulfilled', false, '${REP}');
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, completed_at, signed_by, scheduled_date)
      VALUES ('${otherDelivery}', 'PROVER-CAP-D9', '${otherOrder}', '${CUSTOMER}', '${ADMIN}', 'completed', now(), '[PROVER]', current_date);
    ${orderLevel(otherOrder, 'PROVER-CAP-WHOLE-2')}
    INSERT INTO public.invoices (invoice_number, created_by, customer_id, order_id, delivery_id, invoice_type, status)
      VALUES ('PROVER-CAP-PER-DELIVERY-2', '${ADMIN}', '${CUSTOMER}', '${otherOrder}', '${otherDelivery}', 'chemical_sale', 'draft');`),
    /already has a whole-order invoice \(PROVER-CAP-WHOLE-2\)/, 'insert a delivery invoice on an order with a whole-order invoice');
  const overlapMutant = probe(`DROP TRIGGER zz_refuse_overlapping_order_delivery_invoices ON public.invoices;\n${orderLevel(ORDER, 'PROVER-CAP-WHOLE-M')}\nSELECT 'inserted';`);
  assert.equal(overlapMutant.last, 'inserted', `MUTATION: without the overlap trigger the whole-order invoice should go through:\n${overlapMutant.error}`);
  console.log('[prover] OVERLAP: an order billed per delivery cannot get a whole-order invoice (save_invoice or direct), nor the reverse; without the trigger it can');

  // Posting and restoring re-check; an invoice that got over-billed with the guard off cannot be posted.
  const overBilled = `ALTER TABLE public.invoice_items DISABLE TRIGGER zz_cap_delivery_invoice_items;
    UPDATE public.invoice_items SET quantity = 9 WHERE invoice_id = ${inv1Id};
    ALTER TABLE public.invoice_items ENABLE TRIGGER zz_cap_delivery_invoice_items;`;
  expectRefused(probe(`${overBilled}\nUPDATE public.invoices SET status = 'posted', posted_at = now(), posted_by = '${ADMIN}' WHERE id = ${inv1Id};`), /bills 9\.0+ of/, 'post an over-billed invoice');
  expectRefused(probe(`${overBilled}\nUPDATE public.invoices SET deleted_at = now() WHERE id = ${inv1Id};\nUPDATE public.invoices SET deleted_at = NULL WHERE id = ${inv1Id};`), /bills 9\.0+ of/, 'restore an over-billed invoice');
  expectAllowed(probe(`${overBilled}\nUPDATE public.invoice_items SET quantity = 8 WHERE invoice_id = ${inv1Id};`), 'lowering an over-billed draft');
  expectRefused(probe(`${overBilled}\nUPDATE public.invoice_items SET quantity = 10 WHERE invoice_id = ${inv1Id};`), /bills 10\.0+ of/, 'raising an over-billed draft further');
  // The cap relies on a delivery invoice never leaving its delivery or order (trg_guard_invoice_terminal_order).
  expectRefused(probe(`${overBilled}\nUPDATE public.invoices SET delivery_id = NULL, status = 'posted', posted_at = now(), posted_by = '${ADMIN}' WHERE id = ${inv1Id};`),
    /INVOICE_SOURCE_LINEAGE_IMMUTABLE/, 'detach an over-billed invoice from its delivery and post it');
  expectRefused(probe(`${overBilled}\nUPDATE public.invoices SET order_id = NULL WHERE id = ${inv1Id};`),
    /INVOICE_SOURCE_LINEAGE_IMMUTABLE|INVOICE_ORDER_IMMUTABLE/, 'detach a delivery invoice from its order');
  console.log('[prover] HEADER: posting or restoring an over-billed delivery invoice is refused, and it cannot be detached from its delivery or order to dodge the check; lowering it is allowed');

  // ALLOWED.
  expectSaved(probe(saveInvoice(INV1, REP)), 'a rep saves the invoice unchanged');
  expectSaved(probe(saveInvoice(INV1, ADMIN, { qty: '4' })), 'an admin lowers the quantity');
  expectSaved(probe(saveInvoice(INV1, ADMIN, { price: '1200' })), 'an admin changes the price');
  const posted = probe(`${asUser(ADMIN)}\nSELECT public.post_invoice(${inv1Id}, 'prover-cap-post') IS NOT NULL;\nSELECT 'status=' || status FROM public.invoices WHERE id = ${inv1Id};`);
  expectAllowed(posted, 'posting the valid invoice');
  assert.equal(posted.last, 'status=posted', `post_invoice did not post: ${posted.last}`);
  expectAllowed(probe(`ALTER TABLE public.invoices DISABLE TRIGGER zz_cap_delivery_invoice_header;
    ${overBilled}
    UPDATE public.invoices SET status = 'posted', posted_at = now(), posted_by = '${ADMIN}' WHERE id = ${inv1Id};
    ALTER TABLE public.invoices ENABLE TRIGGER zz_cap_delivery_invoice_header;
    UPDATE public.invoices SET status = 'overdue' WHERE id = ${inv1Id};`), 'marking an already over-billed posted invoice overdue');
  console.log('[prover] ALLOWED: unchanged save, lower quantity, new price, posting; an over-billed posted invoice can still go overdue');

  // Quick delivery: billed up front at the planned quantity, then cut to what was delivered.
  const quick = probe(`${asUser(ADMIN)}
    CREATE TEMP TABLE quick ON COMMIT DROP AS
      SELECT public.create_quick_delivery('${CUSTOMER}', jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT_A}', 'quantity', 8)),
        NULL, current_date, '[PROVER] quick', '${ADMIN}', 'prover-cap-quick', false) AS r;
    SELECT public.confirm_delivery((SELECT (r->>'delivery_id')::uuid FROM quick), '${ADMIN}', 'prover-cap-quick-confirm') IS NOT NULL;
    SELECT public.complete_delivery(d.id, '[PROVER] signer', '${ADMIN}',
        jsonb_build_object((SELECT di.id FROM public.delivery_items di WHERE di.delivery_id = d.id)::text, 3),
        NULL, NULL, 'prover-cap-quick-complete', NULL) IS NOT NULL
      FROM public.deliveries d WHERE d.id = (SELECT (r->>'delivery_id')::uuid FROM quick);
    SELECT 'quick=' || (SELECT string_agg(ii.quantity::numeric(12,2)::text, ',') FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.delivery_id = (SELECT (r->>'delivery_id')::uuid FROM quick));`);
  expectAllowed(quick, 'a quick delivery and its partial completion');
  assert.equal(quick.last, 'quick=3.00', `a partial completion must cut the quick invoice to the 3 delivered: ${quick.last}`);
  const quickDelivery = (key) => `${asUser(ADMIN)}
    CREATE TEMP TABLE quick ON COMMIT DROP AS
      SELECT public.create_quick_delivery('${CUSTOMER}', jsonb_build_array(jsonb_build_object('product_id', '${PRODUCT_A}', 'quantity', 8)),
        NULL, current_date, '[PROVER] quick', '${ADMIN}', '${key}', false) AS r;
    GRANT SELECT ON quick TO authenticated;`;
  const quickInvoice = "(SELECT i.id FROM public.invoices i WHERE i.delivery_id = (SELECT (r->>'delivery_id')::uuid FROM quick))";
  expectRefused(probe(`${quickDelivery('prover-cap-quick-post')}
    SELECT public.post_invoice(${quickInvoice}, 'prover-cap-quick-early-post') IS NOT NULL;`), /cannot be posted before delivery \S+ is completed/, 'post a quick delivery\'s invoice before the delivery is completed');
  // The office splits the up-front line (5 linked + 3 unlinked = 8 planned); the driver delivers 6.
  const split = probe(`${quickDelivery('prover-cap-quick-split')}
    ${saveInvoice(`i.id = ${quickInvoice}`, ADMIN, { qty: '5', extra: newLine(PRODUCT_A, 3) })}
    SELECT public.confirm_delivery((SELECT (r->>'delivery_id')::uuid FROM quick), '${ADMIN}', 'prover-cap-split-confirm') IS NOT NULL;
    SELECT public.complete_delivery(d.id, '[PROVER] signer', '${ADMIN}',
        jsonb_build_object((SELECT di.id FROM public.delivery_items di WHERE di.delivery_id = d.id)::text, 6),
        NULL, NULL, 'prover-cap-split-complete', NULL) IS NOT NULL
      FROM public.deliveries d WHERE d.id = (SELECT (r->>'delivery_id')::uuid FROM quick);
    SELECT 'split=' || (SELECT d.status FROM public.deliveries d WHERE d.id = (SELECT (r->>'delivery_id')::uuid FROM quick))
      || ':' || (SELECT string_agg(ii.quantity::numeric(12,2)::text, ',' ORDER BY ii.sort_order) FROM public.invoice_items ii WHERE ii.invoice_id = ${quickInvoice});`);
  expectAllowed(split, 'a driver completes a short delivery whose up-front invoice the office split');
  assert.equal(split.last, 'split=completed:6.00,3.00', `the completion must succeed and trim the linked line to 6: ${split.last}`);
  expectRefused(probe(`${quickDelivery('prover-cap-quick-split2')}
    ${saveInvoice(`i.id = ${quickInvoice}`, ADMIN, { qty: '5', extra: newLine(PRODUCT_A, 3) })}
    SELECT public.confirm_delivery((SELECT (r->>'delivery_id')::uuid FROM quick), '${ADMIN}', 'prover-cap-split2-confirm') IS NOT NULL;
    SELECT public.complete_delivery(d.id, '[PROVER] signer', '${ADMIN}',
        jsonb_build_object((SELECT di.id FROM public.delivery_items di WHERE di.delivery_id = d.id)::text, 6),
        NULL, NULL, 'prover-cap-split2-complete', NULL) IS NOT NULL
      FROM public.deliveries d WHERE d.id = (SELECT (r->>'delivery_id')::uuid FROM quick);
    SELECT public.post_invoice(${quickInvoice}, 'prover-cap-split2-post') IS NOT NULL;`), /bills 9\.0+ of \[PROVER\] Product A, but delivery \S+ allows 6/, 'post the split invoice after the short delivery');
  console.log('[prover] QUICK DELIVERY: billed 8 up front while scheduled and cut to the 3 delivered; not postable before completion; a split, short delivery still completes but cannot be posted over');

  // Batch posting one good and one over-billed invoice.
  const d2Invoice = `${asUser(ADMIN)}
    SELECT public.create_invoice_for_unbilled_delivery('${D2}', '${ADMIN}', 'prover-cap-d2') IS NOT NULL;`;
  const d2Id = `(SELECT id FROM public.invoices WHERE delivery_id = '${D2}' AND status <> 'cancelled')`;
  const batch = probe(`${overBilled}
    ${d2Invoice}
    SELECT public.batch_post_invoices(ARRAY[${inv1Id}, ${d2Id}], 'prover-cap-batch') IS NOT NULL;
    SELECT 'batch=' || (SELECT status FROM public.invoices WHERE id = ${inv1Id}) || ',' || (SELECT status FROM public.invoices WHERE id = ${d2Id});`);
  expectAllowed(batch, 'batch posting with one over-billed invoice');
  assert.equal(batch.last, 'batch=draft,posted', `the batch must post the good invoice and leave the over-billed one: ${batch.last}`);
  console.log('[prover] BATCH: a batch posts the good invoice and leaves the over-billed one unposted');

  // An ordinary delivery: complete_delivery drafts its own invoice for what was delivered.
  const ordinary = probe(`INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date)
      VALUES ('6f200000-0000-4000-8000-0000000000f3', 'PROVER-CAP-D3', '${ORDER}', '${CUSTOMER}', '${ADMIN}', 'scheduled', current_date);
    INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
      VALUES ('6f200000-0000-4000-8000-0000000000f4', '6f200000-0000-4000-8000-0000000000f3', '${LINE_A}', '${PRODUCT_A}', 4, 0, 'Gal');
    ${asUser(ADMIN)}
    SELECT public.confirm_delivery('6f200000-0000-4000-8000-0000000000f3', '${ADMIN}', 'prover-cap-d3-confirm') IS NOT NULL;
    SELECT public.complete_delivery('6f200000-0000-4000-8000-0000000000f3', '[PROVER] signer', '${ADMIN}',
      '{"6f200000-0000-4000-8000-0000000000f4": 3}'::jsonb, NULL, NULL, 'prover-cap-d3-complete', NULL) IS NOT NULL;
    SELECT 'auto=' || (SELECT string_agg(ii.quantity::numeric(12,2)::text, ',') FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.delivery_id = '6f200000-0000-4000-8000-0000000000f3');`);
  expectAllowed(ordinary, 'completing an ordinary delivery with its automatic invoice');
  assert.equal(ordinary.last, 'auto=3.00', `complete_delivery must invoice the 3 delivered: ${ordinary.last}`);
  console.log('[prover] COMPLETE_DELIVERY: an ordinary partial delivery still gets its automatic invoice for the 3 delivered');

  // MUTATION: the two triggers are what stop it.
  const mutant = probe(`DROP TRIGGER zz_cap_delivery_invoice_items ON public.invoice_items;
    DROP TRIGGER zz_cap_delivery_invoice_header ON public.invoices;
    ${saveInvoice(INV1, REP, { qty: '10', extra: newLine(PRODUCT_B, 5) })}`);
  expectSaved(mutant, 'MUTATION: without the triggers the over-bill and double bill should go through');
  console.log('[prover] MUTATION: without the triggers the over-bill and the double bill succeed - the triggers are what stop them');

  // CONCURRENCY: D1's invoice drops to 2 (committed); two transactions each add a 3-unit invoice for
  // D1 at the same time. Together they would bill 8 of the 6 delivered.
  psql(`UPDATE public.invoice_items SET quantity = 2 WHERE invoice_id = ${inv1Id};`);
  // The other order-locking guards (they already lock the order on every invoice and line write).
  const otherLocks = (on) => psql(`ALTER TABLE public.invoices ${on} TRIGGER trg_guard_invoice_terminal_order;
    ALTER TABLE public.invoices ${on} TRIGGER zz_guard_invoice_delivery_billed_outside_crx;
    ALTER TABLE public.invoices ${on} TRIGGER zz_refuse_overlapping_order_delivery_invoices;
    ALTER TABLE public.invoice_items ${on} TRIGGER trg_guard_terminal_order_invoice_items;`);
  const expectSecondRefused = (result, label) => {
    assert.equal(result.a, 0, `${label}: the first concurrent invoice must commit`);
    assert.notEqual(result.b, 0, `${label}: the second concurrent invoice must be refused`);
    assert.match(result.bError, /bills 8\.0+ of \[PROVER\] Product A, but delivery PROVER-CAP-D1 allows 6/, `${label}: refused for a different reason:\n${result.bError}`);
    psql(`UPDATE public.invoices SET deleted_at = now() WHERE invoice_number LIKE 'PROVER-CAP-RACE-%' AND deleted_at IS NULL;`);
  };
  expectSecondRefused(await race('R'), 'as deployed');
  otherLocks('DISABLE');
  expectSecondRefused(await race('C'), 'with only the candidate\'s order lock');
  // MUTATION: without any order lock both transactions check before either commits.
  const lockStatement = `    PERFORM 1 FROM public.orders o
     WHERE o.id = (SELECT d.order_id FROM public.deliveries d WHERE d.id = v_delivery_id)
       FOR UPDATE;`;
  assert.equal(lf(CAP).split(lockStatement).length, 2, 'the candidate must take the order lock exactly once');
  stageText('cap-no-lock.sql', lf(CAP).replace(lockStatement, '    NULL;'));
  assert.equal(apply('cap-no-lock.sql').status, 0, 'the no-lock mutant must apply');
  const raced = await race('M');
  otherLocks('ENABLE');
  assert.deepEqual([raced.a, raced.b], [0, 0], `MUTATION: without the order lock both concurrent over-bills should commit:\n${raced.bError}`);
  const reinstall = apply('cap.sql');
  assert.notEqual(reinstall.status, 0, 'the preflight must refuse to re-install over the mutant\'s over-bill');
  assert.match(reinstall.output, /DELIVERY_INVOICE_CAP_PREFLIGHT: active delivery invoices already break the delivery cap: .*invoice PROVER-CAP-RACE-M921 bills 8\.0+ of/, `wrong preflight refusal:\n${reinstall.output}`);
  console.log('[prover] CONCURRENCY: two transactions over-billing one delivery at once - the second is refused, also with only the candidate\'s order lock; without any order lock both commit (and the preflight then refuses to install)');

  console.log('DELIVERY_INVOICE_CAP_PROOF_PASS defect=reproduced save_invoice=capped table=capped header=rechecked allowed=unchanged quick_delivery=ok complete_delivery=ok ordering=enforced overlap=refused batch=isolated concurrency=serialized mutation=detected');
}

try { await main(); }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
