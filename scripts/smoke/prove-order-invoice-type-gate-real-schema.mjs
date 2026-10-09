#!/usr/bin/env node
/**
 * Full-chain proof for 20261006200000_refuse_field_invoice_through_order_rpcs
 * (CRX-LIFE-001: the order pipeline must never create a field_application
 * invoice).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a
 * network-disabled Supabase PostgreSQL 17 container, replays every ordered
 * post-baseline migration before the candidate, and then, as the
 * `authenticated` role exactly like a browser session through PostgREST:
 *   0. FIDELITY: the replayed order-path function bodies hash to the values
 *      read from live on 2026-10-07 UTC (2026-10-06 Chicago), so this is the code production runs;
 *   1. THE BUG, BEFORE: a sales rep turns an order into a field_application
 *      invoice through create_invoice_from_order, and both registered chains
 *      fail first with their CRX-LIFE-001 SMOKE_FAIL (the split engine makes
 *      order-backed field invoices too);
 *   2. AUTOCOMMIT: run statement by statement with ON_ERROR_STOP (psql -f, no
 *      -1), the file stops at its preflight before changing anything;
 *      PREFLIGHT: with such a row present in the same transaction the
 *      candidate refuses to apply and changes nothing;
 *   3. the candidate applies;
 *   4. THE FIX: the rep's field_application, credit_memo and NULL-typed calls
 *      and an admin's field_application call are ORDER_INVOICE_TYPE_NOT_ALLOWED
 *      (23514) with nothing written; the rep's chemical_sale and an admin's
 *      misc_charge still work; the table refuses an order-backed
 *      field_application row from the owner and still accepts an orderless
 *      one; anon still cannot execute and the ACL is unchanged;
 *   5. the registered chains covering create_invoice_from_order and the
 *      split-billing chain pass and roll back, as does a real field-invoice
 *      creator's chain (save_field_app_invoice) as a positive control;
 *   6. re-applying fails closed on its own pins and changes nothing;
 *   7. MUTATION: without the CHECK the split chain fails; with the old wrapper
 *      body the order chain fails - so each chain really tests its layer - and
 *      a re-apply over the old wrapper trips the existing-CHECK preflight.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-order-invoice-type-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20261006200000_refuse_field_invoice_through_order_rpcs.sql');
const WRAPPER = 'public.create_invoice_from_order(uuid,uuid,text,text)';
const CHECK_NAME = 'invoices_field_application_has_no_order';
const CHAINS = {
  order: path.join(ROOT, 'scripts', 'smoke', 'smoke-order-invoice-type-gate.sql'),
  split: path.join(ROOT, 'scripts', 'smoke', 'smoke-backfill-refuse-split-billing.sql'),
  fieldApp: path.join(ROOT, 'scripts', 'smoke', 'smoke-field-app-split-penny-exact.sql'),
  // The other two registered chains that cover create_invoice_from_order.
  lifecycle: path.join(ROOT, 'scripts', 'smoke', 'smoke-govern-invoice-order-money-lifecycle.sql'),
  keys: path.join(ROOT, 'scripts', 'smoke', 'smoke-money-lifecycle-idempotency-required.sql'),
};
// md5(replace(prosrc, chr(13), '')) read from live (project rhyzpcqhnizqbxphqdkr)
// on 2026-10-07 UTC (2026-10-06 Chicago). Live stores the idem impl's body with CRLF line endings (raw
// md5 7cbf7aef577c10b16c45070da68edb33) and replay stores LF, so fidelity is
// compared with carriage returns removed; the other four bodies have none, so
// for them this IS the raw md5 (the wrapper's raw pin in the candidate holds).
const LIVE_BODY_MD5 = {
  'public.create_invoice_from_order(uuid,uuid,text,text)': '9ef2d1f8fd901ff7979487d3d60d4d71',
  'public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)': '3d393fb8639dbcb2aa38574ca9679eee',
  'public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)': '454e04c4e199549a4f5be9975e397e17',
  'public.create_split_invoices_from_order(uuid,uuid,text,text)': '398030fbb64006b4750e7e89a61b6cb9',
  'public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)': 'f671f1a3f5406cff52aedd8a5fb40b31',
};
const NEW_WRAPPER_MD5 = 'a1a91643bd8866823ae359f7e0ec290e';
// 20260914100700 is live but cannot replay here: it rewrites storage.objects
// policies the stub storage schema cannot host. It must not touch invoices.
const PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);

const ADMIN = '6e000000-0000-4000-8000-00000000000a';
const REP = '6e000000-0000-4000-8000-00000000000b';
const CUSTOMER = '6e000000-0000-4000-8000-0000000000c1';
const PRODUCT = '6e000000-0000-4000-8000-0000000000a1';
const ORDER = '6e000000-0000-4000-8000-0000000000d1';

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
  const candidate = all.indexOf(CANDIDATE);
  assert.ok(candidate >= 0, 'the candidate must be selected for post-baseline replay');
  const before = all.slice(0, candidate);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(
      !/invoice|idempotency_keys|order_items|\borders\b|split_invoice/i.test(lf(file)),
      `${name} now touches invoices, orders or receipts; skipping it would change this proof - replay it or re-think the skip`,
    );
  }
  return before.filter((f) => !PARKED.has(path.basename(f)));
}

// Same replay repair the other real-schema provers use: live stores this one
// body with CRLF line endings, and a later migration pins that exact body.
function restoreLiveCrLfCloseRemainder() {
  const definingPath = path.join(ROOT, 'supabase', 'migrations', '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql');
  const source = lf(definingPath);
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  assert.ok(tag, 'close-remainder body has no dollar quote');
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  assert.ok(bodyEnd > bodyStart, 'close-remainder body is unterminated');
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}

/** The single `CREATE ... FUNCTION public.create_invoice_from_order(...) ... $function$;` statement in a file. */
function wrapperStatement(file, head) {
  const source = lf(file);
  const start = source.indexOf(head);
  assert.ok(start >= 0 && source.indexOf(head, start + 1) < 0, `${path.basename(file)} must define the wrapper exactly once`);
  const end = source.indexOf('$function$;', start);
  assert.ok(end > start, `${path.basename(file)} wrapper definition is unterminated`);
  return `${source.slice(start, end + '$function$;'.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION')}\n`;
}

function bodyMd5(signature) {
  return scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('${signature}');`);
}
function lfBodyMd5(signature) {
  return scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${signature}');`);
}
function wrapperAcl() {
  return scalar(`SELECT array_to_string(ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
    FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure('${WRAPPER}'))) a
    WHERE a.privilege_type = 'EXECUTE' ORDER BY 1), ',') || '|' || has_function_privilege('anon', to_regprocedure('${WRAPPER}'), 'EXECUTE')::text;`);
}
function checkInstalled() {
  return scalar(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.invoices'::regclass AND conname = '${CHECK_NAME}' AND convalidated;`);
}
function orderInvoices() {
  return scalar(`SELECT count(*) FROM public.invoices WHERE order_id = '${ORDER}';`);
}

// The image's auth.uid() may read request.jwt.claim.sub before request.jwt.claims; set both.
function asUser(uid, role = 'authenticated') {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"${role}"}', true);\nSELECT set_config('request.jwt.claim.sub', '${uid}', true);\nSET LOCAL ROLE ${role};`;
}
/** Run `sql` as `uid` in one transaction that is always ROLLED BACK. */
function probeAs(uid, sql, role = 'authenticated') {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${asUser(uid, role)}\n${sql}\nROLLBACK;\n`, allowFailure: true });
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  return { ok: r.status === 0, lines, last: lines.at(-1) ?? '', error: r.stderr.trim() };
}
function createAs(uid, type, key, salesman = 'NULL') {
  const typeSql = type === null ? 'NULL' : `'${type}'`;
  return probeAs(uid, `SELECT public.create_invoice_from_order('${ORDER}'::uuid, ${salesman}, ${typeSql}, '${key}') AS invoice_id \\gset
SELECT i.invoice_type || '|' || coalesce(i.order_id::text, 'none') || '|' || i.created_by::text FROM public.invoices i WHERE i.id = :'invoice_id';`);
}
function expectTypeRefusal(call, label) {
  assert.equal(call.ok, false, `${label}: expected ORDER_INVOICE_TYPE_NOT_ALLOWED, got ${call.last}`);
  assert.match(call.error, /ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge/, `${label}: wrong refusal:\n${call.error}`);
}

function runChain(file, name) {
  stageText(name, lf(file));
  const r = docker([...psqlArgs(), '-f', `/tmp/${name}`], { allowFailure: true });
  return `${r.stdout}\n${r.stderr}`;
}
function expectChainPass(file, name) {
  const output = runChain(file, name);
  assert.match(output, /SMOKE_PASS_ROLLBACK/, `${path.basename(file)} did not pass:\n${output}`);
  assert.doesNotMatch(output, /SMOKE_FAIL|SMOKE_SETUP/, `${path.basename(file)} reported a failure:\n${output}`);
}
function expectChainFail(file, name, failure, label) {
  const output = runChain(file, name);
  assert.doesNotMatch(output, /SMOKE_PASS_ROLLBACK/, `${label}: ${path.basename(file)} PASSED, so it does not detect this:\n${output}`);
  assert.match(output, failure, `${label}: ${path.basename(file)} failed for a different reason:\n${output}`);
}

function seed() {
  psql(`
    INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${ADMIN}','order-type-prover-admin@example.invalid','{"full_name":"[PROVER] Order Type Admin","role":"admin"}'::jsonb),
      ('${REP}','order-type-prover-rep@example.invalid','{"full_name":"[PROVER] Order Type Rep","role":"sales_rep"}'::jsonb)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${ADMIN}','order-type-prover-admin@example.invalid','[PROVER] Order Type Admin','admin',true),
      ('${REP}','order-type-prover-rep@example.invalid','[PROVER] Order Type Rep','sales_rep',true)
    ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name, role=EXCLUDED.role, is_active=EXCLUDED.is_active;
    INSERT INTO public.customers (id, farm_name, assigned_sales_rep, is_active)
    VALUES ('${CUSTOMER}', '[PROVER] Order Type Farm', '${REP}', true);
    -- Order lines need a priced product (COST_BASIS_REQUIRED), and prices may only
    -- be written through the governed pricing path. This schema-only container has
    -- no catalog, so seed one priced product with that trigger briefly disabled
    -- (the same seeding prove-quote-customer-row-version-real-schema.mjs uses) for the
    -- prover's own probes; the chains price their own products. Never touches live.
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price)
    VALUES ('${PRODUCT}', '[PROVER] Order Type Product', 'GL', 6.00, 10.00);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
    VALUES ('${PRODUCT}', 'Main Warehouse', 50, 0, 'GL');
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
    VALUES ('${ORDER}', 'PROVER-ORDER-TYPE-1', '${CUSTOMER}', current_date, 'confirmed', false, '${REP}');
    INSERT INTO public.order_items (
      order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining
    ) VALUES ('${ORDER}', '${PRODUCT}', '[PROVER] order type line', 10, 6, 2, 20, 8, 40, 0, 2);
  `);
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

  const migrations = selected();
  for (const [i, file] of migrations.entries()) {
    if (path.basename(file) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name, true);
    if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')})`);

  // 0. FIDELITY.
  for (const [signature, md5] of Object.entries(LIVE_BODY_MD5)) {
    assert.equal(lfBodyMd5(signature), md5, `${signature} replayed with a body that differs from live; this proof would not test production's code`);
  }
  assert.equal(checkInstalled(), '0', `${CHECK_NAME} must not exist before the candidate`);
  const aclBefore = wrapperAcl();
  assert.equal(aclBefore, 'authenticated,postgres,service_role|false', `unexpected wrapper ACL before the candidate: ${aclBefore}`);
  console.log('[prover] FIDELITY: all five order-path function bodies match the live md5 pins of 2026-10-07');

  seed();

  // 1. THE BUG, BEFORE.
  const bug = createAs(REP, 'field_application', 'prover-bug-1');
  assert.ok(bug.ok, `the pre-fix field_application call failed, so the bug did not reproduce:\n${bug.error}`);
  assert.equal(bug.last, `field_application|${ORDER}|${REP}`, `pre-fix call did not write an order-backed field invoice: ${bug.last}`);
  assert.equal(orderInvoices(), '0', 'the bug probe was not rolled back');
  expectChainFail(CHAINS.order, 'order-before.sql', /SMOKE_FAIL: a sales rep created a field_application invoice from an order/, 'BEFORE');
  expectChainFail(CHAINS.split, 'split-before.sql', /SMOKE_FAIL: create_split_invoices_from_order created field_application invoices from an order/, 'BEFORE');
  console.log('[prover] BEFORE: a sales rep turned an order into a field_application invoice; both registered chains fail first on it');

  // 2a. AUTOCOMMIT: run statement by statement (psql -f without -1), the file refuses
  // before any change, because the ON COMMIT DROP marker is gone by its preflight.
  stageText('candidate.sql', lf(CANDIDATE));
  const looseRun = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  const loose = `${looseRun.stdout}\n${looseRun.stderr}`;
  assert.notEqual(looseRun.status, 0, 'the candidate applied without a transaction');
  assert.match(loose, /CRX_LIFE_001_NOT_IN_TRANSACTION/, `wrong autocommit refusal:\n${loose}`);
  assert.equal(checkInstalled(), '0', 'an autocommit run left the CHECK behind');
  assert.equal(bodyMd5(WRAPPER), LIVE_BODY_MD5[WRAPPER], 'an autocommit run changed the wrapper');
  console.log('[prover] AUTOCOMMIT: applied outside one transaction by a client that stops on the first error, the file stops before changing anything');

  // 2b. PREFLIGHT: an order-backed field invoice in the same transaction blocks the apply.
  const blocked = docker([...psqlArgs()], {
    input: `BEGIN;\n${asUser(REP)}\nSELECT public.create_invoice_from_order('${ORDER}'::uuid, NULL, 'field_application', 'prover-preflight-1');\nRESET ROLE;\n\\i /tmp/candidate.sql\nCOMMIT;\n`,
    allowFailure: true,
  });
  assert.notEqual(blocked.status, 0, 'the candidate applied over an order-backed field invoice');
  assert.match(`${blocked.stdout}\n${blocked.stderr}`, /PREFLIGHT_ORDER_BACKED_FIELD_INVOICE_EXISTS/, `wrong preflight refusal:\n${blocked.stderr}`);
  assert.equal(checkInstalled(), '0', 'a refused apply left the CHECK behind');
  assert.equal(bodyMd5(WRAPPER), LIVE_BODY_MD5[WRAPPER], 'a refused apply changed the wrapper');
  assert.equal(orderInvoices(), '0', 'a refused apply kept the order-backed field invoice');
  console.log('[prover] PREFLIGHT: an order-backed field invoice blocks the apply; nothing changed');

  // 3. Apply.
  const applied = apply('candidate.sql', true);
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  assert.match(applied.output, /POSTFLIGHT_OK/, `candidate applied without its postflight notice:\n${applied.output}`);
  assert.equal(bodyMd5(WRAPPER), NEW_WRAPPER_MD5, 'applied wrapper body differs from the reviewed one');
  assert.equal(checkInstalled(), '1', `${CHECK_NAME} is not installed and validated`);
  assert.equal(wrapperAcl(), aclBefore, 'the apply changed the wrapper ACL');
  for (const [signature, md5] of Object.entries(LIVE_BODY_MD5)) {
    if (signature !== WRAPPER) assert.equal(lfBodyMd5(signature), md5, `the candidate changed ${signature}`);
  }

  // 4. THE FIX.
  expectTypeRefusal(createAs(REP, 'field_application', 'prover-fix-field'), 'rep field_application');
  expectTypeRefusal(createAs(REP, 'credit_memo', 'prover-fix-credit'), 'rep credit_memo');
  expectTypeRefusal(createAs(REP, null, 'prover-fix-null'), 'rep NULL type');
  expectTypeRefusal(createAs(ADMIN, 'field_application', 'prover-fix-admin', `'${ADMIN}'::uuid`), 'admin field_application');
  const sqlstate = probeAs(REP, `DO $$ BEGIN
    PERFORM public.create_invoice_from_order('${ORDER}'::uuid, NULL, 'field_application', 'prover-fix-state');
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'STATE_OK';
  END $$;
  SELECT 'done';`);
  assert.ok(sqlstate.ok && /STATE_OK/.test(sqlstate.error), `the refusal is not SQLSTATE 23514 (check_violation):\n${sqlstate.error}`);
  assert.equal(orderInvoices(), '0', 'a refused call wrote an invoice');
  const repChemical = createAs(REP, 'chemical_sale', 'prover-fix-chemical');
  assert.ok(repChemical.ok, `the rep's chemical_sale order invoice broke:\n${repChemical.error}`);
  assert.equal(repChemical.last, `chemical_sale|${ORDER}|${REP}`);
  const repDefault = probeAs(REP, `SELECT public.create_invoice_from_order('${ORDER}'::uuid, NULL, p_idempotency_key => 'prover-fix-default') AS invoice_id \\gset
SELECT invoice_type FROM public.invoices WHERE id = :'invoice_id';`);
  assert.ok(repDefault.ok && repDefault.last === 'chemical_sale', `the default-typed call the app makes broke:\n${repDefault.error}`);
  const adminMisc = createAs(ADMIN, 'misc_charge', 'prover-fix-misc', `'${ADMIN}'::uuid`);
  assert.ok(adminMisc.ok, `an admin's misc_charge order invoice broke:\n${adminMisc.error}`);
  assert.equal(adminMisc.last, `misc_charge|${ORDER}|${ADMIN}`);
  const direct = psql(`BEGIN;
    INSERT INTO public.invoices (invoice_number, order_id, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by)
    VALUES ('PROVER-DIRECT-1', '${ORDER}', '${CUSTOMER}', 'field_application', 'draft', current_date, current_date + 30, 0, '${ADMIN}');
    ROLLBACK;`, { allowFailure: true });
  assert.notEqual(direct.status, 0, 'the owner inserted an order-backed field_application invoice');
  assert.match(direct.stderr, new RegExp(`violates check constraint "${CHECK_NAME}"`), `wrong direct-insert refusal:\n${direct.stderr}`);
  const orderless = psql(`BEGIN;
    INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by)
    VALUES ('PROVER-DIRECT-2', '${CUSTOMER}', 'field_application', 'draft', current_date, current_date + 30, 0, '${ADMIN}');
    ROLLBACK;`, { allowFailure: true });
  assert.equal(orderless.status, 0, `the CHECK refused an orderless field_application invoice:\n${orderless.stderr}`);
  const anon = probeAs(REP, `SELECT public.create_invoice_from_order('${ORDER}'::uuid, NULL, 'chemical_sale', 'prover-anon');`, 'anon');
  assert.ok(!anon.ok && /permission denied for function create_invoice_from_order/.test(anon.error), `anon could execute the wrapper:\n${anon.error}`);
  console.log('[prover] FIX: rep/admin field_application, credit_memo and NULL refused (23514), nothing written; rep chemical_sale, default type and admin misc_charge work; owner insert of an order-backed field invoice refused, orderless one accepted; anon denied');

  // 5. Registered chains.
  expectChainPass(CHAINS.order, 'order-after.sql');
  expectChainPass(CHAINS.split, 'split-after.sql');
  expectChainPass(CHAINS.lifecycle, 'lifecycle-after.sql');
  expectChainPass(CHAINS.keys, 'keys-after.sql');
  expectChainPass(CHAINS.fieldApp, 'field-app-after.sql');
  console.log('[prover] the three registered chains covering create_invoice_from_order (type gate, order lifecycle, required keys) and the split-billing chain pass and roll back, plus the real field-invoice creator (save_field_app_invoice)');

  // 6. Re-apply fails closed on its own pins.
  const reapplied = apply('candidate.sql', true);
  assert.notEqual(reapplied.status, 0, 'the candidate re-applied over itself');
  assert.match(reapplied.output, /PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT/, `wrong re-apply refusal:\n${reapplied.output}`);
  assert.equal(bodyMd5(WRAPPER), NEW_WRAPPER_MD5, 'a refused re-apply changed the wrapper');
  assert.equal(checkInstalled(), '1', 'a refused re-apply removed the CHECK');
  console.log('[prover] re-apply refuses on its own pins and changes nothing');

  // 7. MUTATIONS.
  psql(`ALTER TABLE public.invoices DROP CONSTRAINT ${CHECK_NAME};`);
  expectChainFail(CHAINS.split, 'split-mutant.sql', /SMOKE_FAIL: create_split_invoices_from_order created field_application invoices from an order/, 'MUTATION (no CHECK)');
  expectChainFail(CHAINS.order, 'order-mutant-check.sql', /SMOKE_FAIL: invoices accepted an order-backed field_application row/, 'MUTATION (no CHECK)');
  psql(`ALTER TABLE public.invoices ADD CONSTRAINT ${CHECK_NAME} CHECK (invoice_type <> 'field_application' OR order_id IS NULL);`);
  assert.equal(checkInstalled(), '1');
  console.log('[prover] MUTATION: without the CHECK the split and direct-insert steps fail - the chains test it');

  const oldWrapper = wrapperStatement(path.join(ROOT, 'supabase', 'migrations', '20260721145936_require_money_lifecycle_idempotency_keys.sql'), 'CREATE FUNCTION public.create_invoice_from_order(');
  const newWrapper = wrapperStatement(CANDIDATE, 'CREATE OR REPLACE FUNCTION public.create_invoice_from_order(');
  stageText('old-wrapper.sql', oldWrapper);
  assert.equal(apply('old-wrapper.sql').status, 0);
  assert.equal(bodyMd5(WRAPPER), LIVE_BODY_MD5[WRAPPER], 'the old wrapper was not restored for the mutation');
  expectChainFail(CHAINS.order, 'order-mutant-wrapper.sql', /SMOKE_FAIL: wrong rep order-invoice type refusal for field_application/, 'MUTATION (old wrapper)');
  // With the original wrapper back, the wrapper pin passes, so a re-apply reaches and
  // trips the next preflight branch: the CHECK already exists.
  const checkExists = apply('candidate.sql', true);
  assert.notEqual(checkExists.status, 0, 'the candidate re-applied over an existing CHECK');
  assert.match(checkExists.output, /PREFLIGHT_FIELD_INVOICE_ORDER_CHECK_EXISTS/, `wrong existing-CHECK refusal:\n${checkExists.output}`);
  assert.equal(bodyMd5(WRAPPER), LIVE_BODY_MD5[WRAPPER], 'a refused re-apply changed the wrapper');
  stageText('new-wrapper.sql', newWrapper);
  assert.equal(apply('new-wrapper.sql').status, 0);
  assert.equal(bodyMd5(WRAPPER), NEW_WRAPPER_MD5, 'the reviewed wrapper was not restored after the mutation');
  expectChainPass(CHAINS.order, 'order-restored.sql');
  console.log('[prover] MUTATION: with the old wrapper the order chain fails - it tests the type gate, not just the CHECK; a re-apply then trips the existing-CHECK preflight');

  console.log('ORDER_INVOICE_TYPE_GATE_PROOF_PASS before=bug_reproduced preflight=blocks fix=refused allowed=chemical_sale,misc_charge check=enforced chains=pass mutation=detected');
}

try { await main(); }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
