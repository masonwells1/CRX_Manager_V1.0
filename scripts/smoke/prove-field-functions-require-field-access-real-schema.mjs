#!/usr/bin/env node
/**
 * Real-schema proof for the 20261023090000 candidate: field functions require field access
 * (To-Do row 11.4, part A).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), seeds office staff, applicators reached by every
 * route (per-field dispatch, whole-job, ground crew), a driver, an entity_recipient profile and an
 * inactive applicator, nine fields and the dispatches that do and do not reach them, then, each call
 * made as that signed-in user (role authenticated, JWT claims) and rolled back:
 *   0. FIDELITY: the eighteen replayed bodies are the live ones the preflight pins;
 *   1. BEFORE: every field role, the entity_recipient, the inactive applicator and a signed-in
 *      caller with no profile read all nine
 *      fields, every office-only function, global search and every team note; the container chain
 *      smoke-field-functions-require-field-access.sql fails;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight, nothing changed;
 *   3. the candidate applies and prints POSTFLIGHT_OK; owners, ACLs and search_path unchanged;
 *   4. AFTER: each applicator sees only the fields assigned to them (dispatch open or completed in
 *      the last 7 days, never cancelled, never on a deleted job; crew only while crew and membership
 *      are active), everyone else none; office-only functions refuse them; global search returns
 *      nothing to them; notes follow the linked record; active admin and sales rep get exactly
 *      what they got before; the chain passes and rolls back;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: dropping any one check reopens its gap.
 *
 * Run: node scripts/smoke/prove-field-functions-require-field-access-real-schema.mjs   (needs Docker)
 * Prints FIELD_FUNCTIONS_FIELD_ACCESS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-field-access-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261023090000_field_functions_require_field_access.sql');
// Live but not replayable here (storage.objects policies, storage.buckets settings); it must not touch what this proves.
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const COVERED = /_can_see_field|get_fields_with_geojson|get_fields_geojson_by_ids|get_field_geojson|get_field_polygons|get_field_dashboard|derive_customer_shares_from_fields|get_customer_farm_group|get_field_billing_splits_for_|get_customer_summary|check_customer_credit_limit|get_dashboard_action_items|global_search|get_notes_for_entity|operational_dashboard_summary/i;


// ------------------------------------------------------------------------------------------------
// Container plumbing (the shared real-schema harness).
function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
function scalar(sql) { return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  writeFileSync(staged, text, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove ${staged}: ${e.message}`); }
  }
}
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
function ledger(stem) {
  psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    SELECT '${stem.slice(0, 14)}', '${stem}', ARRAY[]::text[]
     WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '${stem}')
    ON CONFLICT (version) DO NOTHING;`);
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${stem}';`), '1', `${stem} is not in the ledger`);
}
function restoreLiveCrLfCloseRemainder() {
  const source = lf(path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  assert.equal(at, all.length - 1, 'the candidate must be the last migration in the replay plan');
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!COVERED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  // storage.objects carries metadata and a (bucket_id, name) key, and postgres may read it, as live
  // has them: 20261022075000 (replayed before the candidate) checks that shape in its preflight.
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}


// ------------------------------------------------------------------------------------------------
// Fixture and probes.
// The live bodies of 2026-10-23 (md5 of prosrc without CR), as the candidate's preflight pins them.
const FNS = [
  ['get_fields_geojson_by_ids(uuid[])', 'f764ceff8af270c717038e45bc4818e9'],
  ['get_field_geojson(uuid)', '5422a5b8550b18e80c840ea98faf2424'],
  ['get_fields_with_geojson(uuid)', '2ab8cb993757a803fa41fc108a1c37c8'],
  ['get_field_polygons(uuid)', '2f95e990cd78ef8c34b082811dc71d40'],
  ['get_customer_farm_group(uuid)', 'b02461f51a28aff92a6616d5493a7f1a'],
  ['get_field_dashboard(uuid,integer)', '46e563a5903e0bfcd22832c27150f0c3'],
  ['derive_customer_shares_from_fields(uuid[],jsonb)', '6c0dc7a1e2f43a7fad03e5a248cdd9bb'],
  ['get_field_billing_splits_for_order(uuid)', 'cfd939349a42addacb54714f7288ce0b'],
  ['get_field_billing_splits_for_blend_ticket(uuid)', '33b8b51ac86ba86b3ff71df9911240b0'],
  ['get_customer_summary(uuid)', '0c62f7918b943433e972dd7885a64249'],
  ['check_customer_credit_limit(uuid)', '3adc17f7fa1612df87264a4702d72858'],
  ['get_dashboard_action_items(integer)', '7098f5204a98631d48b0018559af19f7'],
  ['_check_credit_limit(uuid,bigint)', 'a2dabc88b5b048aac831663c483df8bb'],
  ['get_customer_delivery_remainders(uuid)', '5114589c721170e7e3496309a664af51'],
  ['check_duplicate_delivery(uuid)', '475c6d2c251ef31637a2f5df3e8c02a2'],
  ['global_search(text,integer)', '8b52e155e2d36ac7e83001c02e943822'],
  ['get_notes_for_entity(text,uuid)', '53ff9cf1f416bb8eac2875ccda300a70'],
  ['operational_dashboard_summary()', '77655108c73c1a98d826a21d55d7739d'],
];
const id = (n) => `7a550000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = {
  ADMIN: id(1), REP: id(2),
  APP_A: id(3), // per-field dispatches (open, cancelled, expired, recent, on a deleted job)
  APP_W: id(4), // whole-job applicator (jobs.applicator_id), one live job and one deleted job
  APP_C: id(5), // member of an active and an inactive ground crew
  DRIVER: id(6), ENTITY: id(7),
  IN_APP: id(8), // inactive applicator with an open dispatch
  APP_X: id(9), // active applicator assigned nothing
  NO_PROFILE: id(99), // a signed-in JWT with no profile row
};
const C = { PARENT: id(101), CHILD: id(102), OTHER: id(103) };
const F = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`F${n}`, id(200 + n)]));
const J = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`J${n}`, id(300 + n)]));
const JF = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`JF${n}`, id(400 + n)]));
const CREW = { ON: id(501), OFF: id(502) };
const ORDER = id(601); const QUOTE = id(602); const SECTION = id(603); const DELIVERY = id(604); const TICKET = id(605);

function seed() {
  // Users through the direct-SQL path of handle_new_user (metadata role honoured), then one
  // deactivated. banned_until: live's auth.users has it and the deactivation trigger writes it;
  // deactivation also clears refresh tokens and sessions, tables the image's auth schema lacks.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  const users = [['ADMIN', 'admin'], ['REP', 'sales_rep'], ['APP_A', 'applicator'], ['APP_W', 'applicator'], ['APP_C', 'applicator'],
    ['DRIVER', 'driver'], ['ENTITY', 'entity_recipient'], ['IN_APP', 'applicator'], ['APP_X', 'applicator']];
  psql(users.map(([k, role]) => `INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${U[k]}', 'field-access-${k.toLowerCase().replace('_', '-')}@example.invalid', '{"full_name":"[PROVER] ${k}","role":"${role}"}'::jsonb);`).join('\n'));
  // The role is set directly too, in case handle_new_user no longer honours the metadata role.
  psql(`SET session_replication_role = replica;
    ${users.map(([k, role]) => `UPDATE public.profiles SET role = '${role}', is_active = true WHERE id = '${U[k]}';`).join('\n    ')}
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  // _guard_profile_role_lock lets only an admin change is_active: deactivate as the seeded admin.
  psql(`BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"${U.ADMIN}","role":"authenticated"}', true);
    UPDATE public.profiles SET is_active = false WHERE id = '${U.IN_APP}';
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY id) FROM public.profiles WHERE id::text LIKE '7a550000-%';`),
    'admin:true,sales_rep:true,applicator:true,applicator:true,applicator:true,driver:true,entity_recipient:true,applicator:false,applicator:true',
    'seeded profiles are not as intended');

  // Business rows with triggers off (supabase_admin, replica): these functions only read them.
  const fieldRows = Object.entries(F).map(([k, v]) => `('${v}', '${k === 'F3' ? C.OTHER : C.PARENT}', '[PROVER] ${k}', 10, true)`).join(',\n      ');
  const jf = [['JF1', 'J1', 'F1'], ['JF2', 'J1', 'F2'], ['JF3', 'J2', 'F3'], ['JF4', 'J3', 'F4'], ['JF5', 'J4', 'F5'], ['JF6', 'J5', 'F6'], ['JF7', 'J6', 'F7'], ['JF8', 'J7', 'F8'], ['JF9', 'J8', 'F9']];
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, account_number, contact_name, is_active, parent_customer_id, credit_limit_cents) VALUES
      ('${C.PARENT}', '[PROVER] Parent Farm', 'PRV-1', '[PROVER] Contact', true, NULL, 1000),
      ('${C.CHILD}',  '[PROVER] Child Farm',  'PRV-2', NULL, true, '${C.PARENT}', NULL),
      ('${C.OTHER}',  '[PROVER] Other Farm',  'PRV-3', NULL, true, NULL, NULL);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ${fieldRows};
    INSERT INTO public.field_polygons (field_id, polygon_geojson, label, sort_order) VALUES ('${F.F1}', '{"type":"Polygon","coordinates":[]}', 'A', 1);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ('${F.F1}', '${C.PARENT}', 60, true, 1500), ('${F.F1}', '${C.CHILD}', 40, false, NULL), ('${F.F2}', '${C.PARENT}', 100, true, NULL);
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id, deleted_at) VALUES
      ('${J.J1}', 'PRV-J1', '${C.PARENT}', current_date, 'scheduled', NULL, NULL),
      ('${J.J2}', 'PRV-J2', '${C.OTHER}',  current_date, 'scheduled', '${U.APP_W}', NULL),
      ('${J.J3}', 'PRV-J3', '${C.PARENT}', current_date, 'scheduled', '${U.APP_W}', now()),
      ('${J.J4}', 'PRV-J4', '${C.PARENT}', current_date, 'scheduled', NULL, NULL),
      ('${J.J5}', 'PRV-J5', '${C.PARENT}', current_date - 10, 'completed', NULL, NULL),
      ('${J.J6}', 'PRV-J6', '${C.PARENT}', current_date, 'scheduled', NULL, NULL),
      ('${J.J7}', 'PRV-J7', '${C.PARENT}', current_date - 2, 'completed', NULL, NULL),
      ('${J.J8}', 'PRV-J8', '${C.PARENT}', current_date, 'scheduled', NULL, NULL);
    INSERT INTO public.job_fields (id, job_id, field_id) VALUES
      ${jf.map(([a, b, c]) => `('${JF[a]}', '${J[b]}', '${F[c]}')`).join(',\n      ')};
    INSERT INTO public.ground_crews (id, name, is_active) VALUES ('${CREW.ON}', '[PROVER] Crew on', true), ('${CREW.OFF}', '[PROVER] Crew off', false);
    INSERT INTO public.ground_crew_members (crew_id, name, profile_id, is_active) VALUES
      ('${CREW.ON}', '[PROVER] C', '${U.APP_C}', true), ('${CREW.OFF}', '[PROVER] C', '${U.APP_C}', true);
    INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, crew_id, dispatch_status, updated_at) VALUES
      ('${JF.JF1}', '${J.J1}', '${U.APP_A}', NULL, 'dispatched', now()),
      ('${JF.JF2}', '${J.J1}', '${U.APP_A}', NULL, 'cancelled', now()),
      ('${JF.JF4}', '${J.J3}', '${U.APP_A}', NULL, 'dispatched', now()),
      ('${JF.JF5}', '${J.J4}', NULL, '${CREW.ON}', 'dispatched', now()),
      ('${JF.JF6}', '${J.J5}', '${U.APP_A}', NULL, 'completed', now() - interval '8 days'),
      ('${JF.JF7}', '${J.J6}', '${U.IN_APP}', NULL, 'dispatched', now()),
      ('${JF.JF8}', '${J.J7}', '${U.APP_A}', NULL, 'completed', now() - interval '2 days'),
      ('${JF.JF9}', '${J.J8}', NULL, '${CREW.OFF}', 'dispatched', now());
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by) VALUES ('${QUOTE}', 'PRV-Q1', '${C.PARENT}', '${U.ADMIN}');
    INSERT INTO public.quote_sections (id, quote_id, field_id) VALUES ('${SECTION}', '${QUOTE}', '${F.F1}');
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, salesman_id, quote_id)
      VALUES ('${ORDER}', 'PRV-ORD', '${C.PARENT}', current_date, 'confirmed', '${U.REP}', '${QUOTE}');
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver)
      VALUES ('${DELIVERY}', 'PRV-DEL', '${ORDER}', '${C.PARENT}', '${U.ADMIN}', 'scheduled', current_date, '${U.DRIVER}');
    INSERT INTO public.blend_tickets (id, ticket_number, uploaded_by, field_id) VALUES ('${TICKET}', 'PRV-BT', '${U.ADMIN}', '${F.F2}');
    INSERT INTO public.invoices (invoice_number, customer_id, created_by, invoice_type, status, total_amount_cents, invoice_date, due_date, posted_at)
      VALUES ('PRV-INV', '${C.PARENT}', '${U.ADMIN}', 'chemical_sale', 'overdue', 12345, current_date - 60, current_date - 30, now() - interval '60 days');
    INSERT INTO public.team_notes (created_by, title, content, note_type, linked_entity_type, linked_entity_id) VALUES
      ('${U.ADMIN}', '[PROVER] J1', 'note', 'note', 'job', '${J.J1}'),
      ('${U.ADMIN}', '[PROVER] J2', 'note', 'note', 'job', '${J.J2}'),
      ('${U.ADMIN}', '[PROVER] J6', 'note', 'note', 'job', '${J.J6}'),
      ('${U.ADMIN}', '[PROVER] DEL', 'note', 'note', 'delivery', '${DELIVERY}'),
      ('${U.ADMIN}', '[PROVER] CUST', 'note', 'note', 'customer', '${C.PARENT}'),
      ('${U.ADMIN}', '[PROVER] ORD', 'note', 'note', 'order', '${ORDER}'),
      ('${U.ADMIN}', '[PROVER] OTHER', 'note', 'note', 'other', '${C.PARENT}');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
}

/** `sql` as a signed-in user in a rolled-back transaction, after an optional `prefix` run as
 * postgres. Returns the last output line, or ERR:<message>. */
function as(user, sql, { prefix = '' } = {}) {
  const jwt = JSON.stringify({ sub: U[user], role: 'authenticated' });
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
    ${prefix}
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claims', '${jwt}', true);
    SELECT 'OUT=' || COALESCE((${sql})::text, '<null>');
    ROLLBACK;` });
  if (r.status !== 0) {
    const m = /ERROR:\s+([^\n]*)/.exec(r.stderr);
    return `ERR:${m ? m[1].trim() : r.stderr.trim()}`;
  }
  return /OUT=(.*)/.exec(r.stdout)?.[1] ?? `(no output) ${r.stdout}`;
}
const ALL_FIELD_IDS = `ARRAY[${Object.values(F).map((v) => `'${v}'`).join(',')}]::uuid[]`;
const FIELD_VALUES = Object.entries(F).map(([k, v]) => `('${k}', '${v}'::uuid)`).join(',');
const CALLS = {
  // Field-scoped: the names of the fields the caller gets back.
  byIds: `SELECT COALESCE(string_agg(replace(field_name, '[PROVER] ', ''), ',' ORDER BY field_name), '') FROM public.get_fields_geojson_by_ids(${ALL_FIELD_IDS})`,
  geo: `SELECT COALESCE(string_agg(v.n, ',' ORDER BY v.n), '') FROM (VALUES ${FIELD_VALUES}) v(n, i) WHERE EXISTS (SELECT 1 FROM public.get_field_geojson(v.i))`,
  // Office-only.
  withGeo: 'SELECT count(*) FROM public.get_fields_with_geojson(NULL)',
  polygons: `SELECT count(*) FROM public.get_field_polygons('${F.F1}')`,
  dashboard: `SELECT md5(public.get_field_dashboard('${F.F1}', NULL)::text)`,
  derive: `SELECT md5(public.derive_customer_shares_from_fields(ARRAY['${F.F1}']::uuid[], NULL)::text)`,
  farmGroup: `SELECT string_agg(farm_name, ',' ORDER BY farm_name) FROM public.get_customer_farm_group('${C.CHILD}')`,
  splitsOrder: `SELECT count(*) FROM public.get_field_billing_splits_for_order('${ORDER}')`,
  splitsTicket: `SELECT count(*) FROM public.get_field_billing_splits_for_blend_ticket('${TICKET}')`,
  summary: `SELECT public.get_customer_summary('${C.PARENT}')->>'ar_balance_cents'`,
  credit: `SELECT public.check_customer_credit_limit('${C.PARENT}')->>'outstanding_ar'`,
  actions: 'SELECT md5(public.get_dashboard_action_items(10)::text)',
  // The child farm has no credit limit, so the check returns (void) instead of raising.
  creditCheck: `SELECT public._check_credit_limit('${C.CHILD}', 0)::text`,
  remainders: 'SELECT jsonb_array_length(public.get_customer_delivery_remainders(NULL))',
  dupDelivery: `SELECT jsonb_array_length(public.check_duplicate_delivery('${ORDER}'))`,
  opsSummary: "SELECT md5((public.operational_dashboard_summary() - 'generated_at')::text)",
  // Returns nothing to field roles.
  search: "SELECT count(*) FROM public.global_search('PROVER', 5)",
  // Notes follow the linked record.
  noteJ1: `SELECT count(*) FROM public.get_notes_for_entity('job', '${J.J1}')`,
  noteJ2: `SELECT count(*) FROM public.get_notes_for_entity('job', '${J.J2}')`,
  noteJ6: `SELECT count(*) FROM public.get_notes_for_entity('job', '${J.J6}')`,
  noteDel: `SELECT count(*) FROM public.get_notes_for_entity('delivery', '${DELIVERY}')`,
  noteCust: `SELECT count(*) FROM public.get_notes_for_entity('customer', '${C.PARENT}')`,
  noteOrder: `SELECT count(*) FROM public.get_notes_for_entity('order', '${ORDER}')`,
  noteOther: `SELECT count(*) FROM public.get_notes_for_entity('other', '${C.PARENT}')`,
};
const FIELD_CALLS = ['byIds', 'geo'];
const OFFICE_CALLS = ['withGeo', 'polygons', 'dashboard', 'derive', 'farmGroup', 'splitsOrder', 'splitsTicket', 'summary', 'credit', 'actions', 'creditCheck', 'remainders', 'dupDelivery'];
const NOTE_CALLS = ['noteJ1', 'noteJ2', 'noteJ6', 'noteDel', 'noteCust', 'noteOrder', 'noteOther'];
const OFFICE = ['ADMIN', 'REP'];
const FIELD_ROLES = ['APP_A', 'APP_W', 'APP_C', 'DRIVER', 'ENTITY', 'IN_APP', 'APP_X', 'NO_PROFILE'];
const ALL_FIELDS = 'F1,F2,F3,F4,F5,F6,F7,F8,F9';
const OFFICE_REFUSAL = /Permission denied: requires admin or sales_rep role/;
// After the candidate: the fields each field role may see.
const SEES = { APP_A: 'F1,F8', APP_W: 'F3', APP_C: 'F5', DRIVER: '', ENTITY: '', IN_APP: '', APP_X: '', NO_PROFILE: '' };
// After the candidate: which notes each field role still reads (1) or no longer reads (0).
const NOTES_AFTER = {
  //        J1   J2   J6   Del  Cust Order Other
  APP_A:  [1,   0,   0,   0,   1,   0,   0], // J1 by dispatch; its customer through the dispatchee policy
  // J2 as whole-job applicator; the parent farm through customers_select's applicator leg, which
  // still counts the deleted J3 (part C adds the deleted_at test there).
  APP_W:  [0,   1,   0,   0,   1,   0,   0],
  APP_C:  [0,   0,   0,   0,   1,   0,   0], // J4's customer through the crew dispatch
  DRIVER: [0,   0,   0,   1,   1,   0,   0], // own delivery and its customer
  ENTITY: [0,   0,   0,   0,   0,   0,   0],
  IN_APP: [0,   0,   0,   0,   0,   0,   0],
  APP_X:  [0,   0,   0,   0,   0,   0,   0],
  NO_PROFILE: [0, 0,   0,   0,   0,   0,   0],
};

/** Everything office staff get; must be identical before and after. */
function officeSnapshot() {
  const out = {};
  for (const u of OFFICE) for (const c of [...FIELD_CALLS, ...OFFICE_CALLS, 'opsSummary', 'search', ...NOTE_CALLS]) out[`${u}.${c}`] = as(u, CALLS[c]);
  return out;
}

function candidateFunction(header) {
  const s = lf(CANDIDATE);
  const start = s.indexOf(header);
  assert.ok(start > 0, `candidate function ${header} not found`);
  const end = s.indexOf('$function$;', s.indexOf('$function$', start) + 10) + '$function$;'.length;
  return s.slice(start, end);
}
const CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-field-functions-require-field-access.sql');
/** Run the container chain in a rolled-back transaction: PASS only on SMOKE_PASS_ROLLBACK. */
function chain() {
  stageText('chain.sql', lf(CHAIN));
  const r = docker([...psqlArgs()], { input: 'BEGIN;\n\\i /tmp/chain.sql\nROLLBACK;\n', allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  return { pass: /SMOKE_PASS_ROLLBACK/.test(out), fail: /ERROR:\s+([^\n]*)/.exec(out)?.[1] ?? out.trim() };
}
const md5Of = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);
const attrsOf = (sig) => scalar(`SELECT proacl::text || ' ' || pg_get_userbyid(proowner) || ' ' || array_to_string(proconfig, ';') || ' ' || provolatile::text || ' ' || prorettype::regtype::text FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);

function main() {
  buildContainer();
  // 0. FIDELITY.
  for (const [sig, pin] of FNS) {
    assert.equal(md5Of(sig), pin, `replayed ${sig} differs from the live pin`);
    assert.ok(lf(CANDIDATE).includes(`'${pin}'`), `the preflight does not pin ${sig}`);
  }
  console.log(`[prover] FIDELITY: the ${FNS.length} replayed bodies match the live pins of 2026-10-23`);
  seed();

  // 1. BEFORE.
  const before = officeSnapshot();
  for (const u of OFFICE) {
    for (const c of FIELD_CALLS) assert.equal(before[`${u}.${c}`], ALL_FIELDS, `BEFORE: ${u} ${c}`);
    for (const c of [...OFFICE_CALLS, 'opsSummary']) assert.doesNotMatch(before[`${u}.${c}`], /^ERR:/, `BEFORE: ${u} ${c}`);
    for (const c of NOTE_CALLS) assert.equal(before[`${u}.${c}`], '1', `BEFORE: ${u} ${c}`);
    assert.notEqual(before[`${u}.search`], '0', `BEFORE: ${u} search found nothing`);
  }
  assert.equal(before['ADMIN.withGeo'], '9'); assert.equal(before['ADMIN.splitsOrder'], '2'); assert.equal(before['ADMIN.splitsTicket'], '1');
  assert.equal(before['ADMIN.summary'], '12345'); assert.equal(before['ADMIN.farmGroup'], '[PROVER] Child Farm,[PROVER] Parent Farm');
  let gaps = 0;
  for (const u of FIELD_ROLES) {
    for (const c of FIELD_CALLS) { assert.equal(as(u, CALLS[c]), ALL_FIELDS, `BEFORE: ${u} ${c} did not return every field`); gaps += 1; }
    for (const c of OFFICE_CALLS) { const got = as(u, CALLS[c]); assert.doesNotMatch(got, /^ERR:/, `BEFORE: ${u} ${c} was already refused: ${got}`); gaps += 1; }
    assert.notEqual(as(u, CALLS.search), '0', `BEFORE: ${u} search found nothing`); gaps += 1;
    for (const c of NOTE_CALLS) { assert.equal(as(u, CALLS[c]), '1', `BEFORE: ${u} ${c}`); gaps += 1; }
    // operational_dashboard_summary already refuses every field role on live; it must stay so.
    assert.match(as(u, CALLS.opsSummary), /Not authorized/, `BEFORE: ${u} reached operational_dashboard_summary`);
  }
  console.log(`[prover] BEFORE: ${FIELD_ROLES.length} non-office callers (incl. an inactive applicator and an entity_recipient) read all nine fields, every office-only function, search and every note (${gaps} calls)`);
  const chainBefore = chain();
  assert.ok(!chainBefore.pass, 'BEFORE: the smoke chain passed without the candidate');
  assert.match(chainBefore.fail, /SMOKE_FAIL: a\./, `BEFORE: the chain failed at the wrong step: ${chainBefore.fail}`);
  console.log(`[prover] BEFORE: the smoke chain fails first: ${chainBefore.fail.slice(0, 120)}`);

  // 2. AUTOCOMMIT.
  stageText('candidate.sql', lf(CANDIDATE));
  const pre = FNS.map(([sig]) => md5Of(sig)).join(',');
  const ac = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(ac.status, 0, 'autocommit apply did not stop');
  assert.match(`${ac.stdout}\n${ac.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit stopped for the wrong reason');
  assert.equal(FNS.map(([sig]) => md5Of(sig)).join(','), pre, 'autocommit changed a function');
  assert.equal(scalar("SELECT to_regprocedure('public._can_see_field(uuid)') IS NULL;"), 't', 'autocommit created _can_see_field');
  console.log('[prover] AUTOCOMMIT: refused by the preflight, nothing changed');

  // 3. APPLY.
  const attrs = FNS.map(([sig]) => attrsOf(sig));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `no POSTFLIGHT_OK:\n${a.output}`);
  assert.deepEqual(FNS.map(([sig]) => attrsOf(sig)), attrs, 'an owner, ACL, search_path, volatility or return type changed');
  assert.equal(scalar("SELECT string_agg(proname || ':' || prosecdef, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('get_notes_for_entity', '_can_see_field', 'get_field_dashboard');"),
    '_can_see_field:true,get_field_dashboard:true,get_notes_for_entity:false', 'definer/invoker modes are not as intended');
  assert.equal(scalar("SELECT has_function_privilege('anon', 'public._can_see_field(uuid)', 'EXECUTE')::text || has_function_privilege('authenticated', 'public._can_see_field(uuid)', 'EXECUTE')::text;"), 'falsetrue', '_can_see_field grants');
  console.log(`[prover] candidate applied; POSTFLIGHT_OK; owners, ACLs, search_path, volatility and return types unchanged (${attrs[0]})`);

  // 4. AFTER.
  for (const u of FIELD_ROLES) {
    for (const c of FIELD_CALLS) assert.equal(as(u, CALLS[c]), SEES[u], `AFTER: ${u} ${c} sees the wrong fields`);
    for (const c of OFFICE_CALLS) assert.match(as(u, CALLS[c]), OFFICE_REFUSAL, `AFTER: ${u} ${c} was not refused`);
    assert.match(as(u, CALLS.opsSummary), /Not authorized/, `AFTER: ${u} reached operational_dashboard_summary`);
    assert.equal(as(u, CALLS.search), '0', `AFTER: ${u} search returned rows`);
    const notes = NOTE_CALLS.map((c) => Number(as(u, CALLS[c])));
    assert.deepEqual(notes, NOTES_AFTER[u], `AFTER: ${u} notes ${NOTE_CALLS.join(',')}`);
    console.log(`[prover] AFTER: ${u.padEnd(6)} fields=[${SEES[u]}] office functions refused, search 0, notes ${notes.join('')}`);
  }
  assert.deepEqual(officeSnapshot(), before, 'AFTER: an office user got something different');
  console.log('[prover] AFTER: active admin and sales rep get exactly what they got before');
  const chainAfter = chain();
  assert.ok(chainAfter.pass, `AFTER: the smoke chain failed: ${chainAfter.fail}`);
  console.log('[prover] AFTER: the smoke chain passes and rolls back (SMOKE_PASS_ROLLBACK)');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /FIELD_ACCESS_BASELINE_DRIFT/, `re-apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight');

  // 6. MUTATION: each check is load-bearing.
  const HELPER = 'CREATE FUNCTION public._can_see_field(';
  const helper = () => candidateFunction(HELPER).replace(HELPER, 'CREATE OR REPLACE FUNCTION public._can_see_field(');
  for (const [label, base, user, call, expect, edit] of [
    ['dispatch leg without the deleted-job test', helper, 'APP_A', 'byIds', 'F1,F4,F8',
      (b) => b.replace("           WHERE jf.field_id = p_field_id\n             AND j.deleted_at IS NULL\n             AND (\n", "           WHERE jf.field_id = p_field_id\n             AND (\n")],
    ['dispatch leg matched by job instead of field', helper, 'APP_A', 'byIds', 'F1,F2,F8',
      (b) => b.replace('JOIN public.job_fields jf ON jf.id = d.job_field_id AND jf.job_id = d.job_id', 'JOIN public.job_fields jf ON jf.job_id = d.job_id')],
    ['dispatch leg without the status window', helper, 'APP_A', 'byIds', 'F1,F2,F6,F8',
      (b) => b.replace("               d.dispatch_status = 'dispatched'\n               OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')\n", '               true\n')],
    ['crew leg without the active-crew test', helper, 'APP_C', 'byIds', 'F5,F9',
      (b) => b.replace('                      AND gcm.is_active\n                      AND gc.is_active\n', '                      AND gcm.is_active\n')],
    ['helper without the active-profile test', helper, 'IN_APP', 'byIds', 'F7',
      (b) => b.replace('  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active)\n  AND (', '  SELECT (')],
    ['whole-job leg without the deleted-job test', helper, 'APP_W', 'byIds', 'F3,F4',
      (b) => b.replace('             AND j.applicator_id = (SELECT auth.uid())\n             AND j.deleted_at IS NULL))', '             AND j.applicator_id = (SELECT auth.uid())))')],
    ['get_field_geojson without the field check', () => candidateFunction('CREATE OR REPLACE FUNCTION public.get_field_geojson('), 'DRIVER', 'geo', ALL_FIELDS,
      (b) => b.replace('  WHERE f.id = p_field_id\n    -- Only a field this caller may see (office staff, or assigned to them; row 11.4).\n    AND public._can_see_field(f.id);', '  WHERE f.id = p_field_id;')],
    ['get_field_dashboard without the office gate', () => candidateFunction('CREATE OR REPLACE FUNCTION public.get_field_dashboard('), 'APP_A', 'dashboard', null,
      (b) => b.replace('  PERFORM public.require_admin_or_sales_rep();\n', '')],
    ['get_customer_farm_group without the office gate', () => candidateFunction('CREATE OR REPLACE FUNCTION public.get_customer_farm_group('), 'DRIVER', 'farmGroup', '[PROVER] Child Farm,[PROVER] Parent Farm',
      (b) => b.replace('  PERFORM public.require_admin_or_sales_rep();\n', '')],
    ['check_duplicate_delivery without the office gate', () => candidateFunction('CREATE OR REPLACE FUNCTION public.check_duplicate_delivery('), 'DRIVER', 'dupDelivery', '1',
      (b) => b.replace('  PERFORM public.require_admin_or_sales_rep();\n', '')],
    ['global_search without the office test', () => candidateFunction('CREATE OR REPLACE FUNCTION public.global_search('), 'DRIVER', 'search', null,
      (b) => b.replace('  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN\n    RETURN;\n  END IF;\n', '')],
    ['get_notes_for_entity as SECURITY DEFINER', () => candidateFunction('CREATE OR REPLACE FUNCTION public.get_notes_for_entity('), 'DRIVER', 'noteOrder', '1',
      (b) => b.replace(' SECURITY INVOKER\n', ' SECURITY DEFINER\n')],
    ['get_notes_for_entity without the record check', () => candidateFunction('CREATE OR REPLACE FUNCTION public.get_notes_for_entity('), 'APP_A', 'noteJ2', '1',
      (b) => b.replace('  IF v_can_read_record IS NOT TRUE THEN\n    RETURN;\n  END IF;\n', '')],
  ]) {
    const original = base();
    const mutated = edit(original);
    assert.notEqual(mutated, original, `MUTATION ${label}: the edit did not apply`);
    const got = as(user, CALLS[call], { prefix: mutated });
    if (expect === null) {
      assert.doesNotMatch(got, /^ERR:|^0$/, `MUTATION ${label}: expected the gap to reopen, got ${got}`);
    } else {
      assert.equal(got, expect, `MUTATION ${label}: expected ${expect}, got ${got}`);
    }
    console.log(`[prover] MUTATION: ${label}: ${user} ${call} -> ${got}`);
  }

  console.log('FIELD_FUNCTIONS_FIELD_ACCESS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
