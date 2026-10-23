#!/usr/bin/env node
/**
 * Full-chain proof for the 20261022100000 candidate: the bulk purchase-order import's content
 * fingerprint leaves out cost (unit_cost, unit_cost_cents) for everyone, so an admin importing a
 * vendor document a sales rep already imported gets "already_imported" instead of
 * BULK_PO_DOCUMENT_CONTENT_CONFLICT (Mason, 2026-10-22).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate, checks
 * the candidate's md5 pin against the replayed body, seeds an admin and a sales rep and two products
 * (no stored import claim, as live), then runs one matrix BEFORE and AFTER the candidate. Each scenario is one transaction that always rolls back; each step runs as a
 * PostgREST session (request.jwt.claims + SET LOCAL ROLE authenticated) or the owner.
 *   1. Rep imports a document without cost, then an admin imports it WITH cost under another key:
 *      before CONTENT_CONFLICT, after already_imported on the rep's PO; still one PO, the rep line's
 *      cost untouched by the second import.
 *   2. Admin first with cost, then the rep: before CONTENT_CONFLICT, after already_imported.
 *   3. Real content changes still conflict for an admin sending cost: quantity, invoice date,
 *      product, unit.
 *   4. Same-key retries (the idempotency replay path): an exact retry replays "saved" with the same
 *      PO; a retry with a changed quantity or date conflicts; an admin's retry with only a changed
 *      cost conflicts before and after (after, through the cost-inclusive receipt binding); the same
 *      key without the bulk-import marker replays before and is refused after; a rep's retries replay
 *      (the wrapper strips any cost a rep sends).
 *   5. Stored fingerprints: the same lines and date with and without cost store the same fingerprint
 *      after (two different documents), different before.
 *   6. Grants and security of the replaced writer; the preflight refuses a drifted body, a stored
 *      import claim (fingerprinted by the old rule) and a second apply; MUTATIONS: stripping only
 *      unit_cost_cents (not unit_cost) brings the conflict back; skipping the receipt check replays
 *      an admin's cost-only retry as saved.
 *
 * Run: node scripts/smoke/prove-bulk-po-fingerprint-ignores-cost-real-schema.mjs   (needs Docker)
 * Prints BULK_PO_FINGERPRINT_IGNORES_COST_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a fresh, network-disabled container this run creates: the proof seeds and applies the
// candidate, so it never runs against an existing database.
const NAME = `crx-po-fp-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022100000_bulk_po_fingerprint_ignores_cost.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// A later or parked file that (re)defines anything on the bulk-import path or its claim table.
const TOUCHED = /(FUNCTION\s+(public\.)?"?(save_purchase_order|_save_purchase_order_\w+_impl|_section9_save_purchase_order_serialized|_purchase_order_item_unit_cost_cents|_require_bulk_po_content_fingerprint|check_idempotency|save_idempotency)\b|purchase_order_import_intents)/i;
const PIN = 'f5b2c9e81df528a449881ecd339ee54a';
const SIG = 'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)';
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

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
  const before = all.slice(0, at);
  for (const file of all.slice(at + 1)) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it changes; re-think this proof`);
  }
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
}
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// FIDELITY: the candidate's pin is in its preflight and matches the replayed body (live, 2026-10-22).
function fidelity() {
  assert.ok(lf(CANDIDATE).split('$preflight$')[1].includes(`'${PIN}'`), 'the candidate preflight must pin the live body');
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${SIG}'::regprocedure;`), PIN,
    `${SIG} replayed with a body that differs from the live pin of 2026-10-22`);
  console.log('[prover] FIDELITY: the replayed writer matches the live md5 pin of 2026-10-22');
}

// ------------------------------------------------------------------------------------------------
const id = (n) => `7c720000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1') };
const PROD = id('f1'); // current_cost 22.50 per gal
const PROD_B = id('f2');
const VENDOR = '[PROVER] Fingerprint Vendor';
const DATE = '2026-10-20';
// Whole cents as a dollars literal, by integer arithmetic only (no float rounding).
function dollarsText(cents) {
  assert.ok(Number.isSafeInteger(cents) && cents >= 0, `cents must be a non-negative safe integer: ${cents}`);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
// One line exactly as BulkPOImport.tsx sends it; an admin's line adds both cost representations.
function line({ product = PROD, name = '[PROVER] Chem', qty = 10, unit = 'gal', cents = null } = {}) {
  const base = `'product_id', '${product}', 'product_name', '${name}', 'quantity_ordered', ${qty}, 'unit_size', '${unit}', 'quantity_received', 0, 'notes', NULL`;
  return cents === null ? `jsonb_build_object(${base})`
    : `jsonb_build_object(${base}, 'unit_cost', ${dollarsText(cents)}, 'unit_cost_cents', ${cents})`;
}
function bulkImport(actor, ref, key, lines, date = DATE) {
  return `public.save_purchase_order(NULL, jsonb_build_object('po_number', NULL, 'vendor', '${VENDOR}', 'status', 'draft',
    'submitted_date', NULL, 'expected_delivery_date', NULL, 'notes', 'Imported from PDF: prover.pdf',
    'bulk_import_intent_key', 'server-derived', 'bulk_import_vendor_reference', '${ref}', 'bulk_import_invoice_date', '${date}'),
    jsonb_build_array(${lines.join(', ')}), '${actor}', '${key}')`;
}
// "<status>:<the returned PO is the one claimed for the reference>". The claim table is not readable
// by API roles, so the lookup goes through the prover-only definer helper _prover_claim_po.
// The lookup takes the result as its argument, so it runs after the import and sees its claim row.
const imp = (actor, ref, key, lines, date) => `(SELECT (r->>'status') || ':' || public._prover_same_po(r, '${ref}')
  FROM (SELECT ${bulkImport(actor, ref, key, lines, date)} AS r) s)`;
// Purchase orders for VENDOR created in this scenario's transaction (now() is its start time).
const NEW_POS = `(SELECT count(*)::text FROM public.purchase_orders WHERE vendor = '${VENDOR}' AND created_at = now())`;
const LINECOST = (ref) => `(SELECT string_agg(poi.quantity_ordered::int || ':' || poi.unit_cost_cents, ',') FROM public.purchase_order_items poi
    JOIN public.purchase_order_import_intents i ON i.purchase_order_id = poi.purchase_order_id WHERE i.intent_key = public._prover_intent('${ref}'))`;
const FP = (ref) => `(SELECT content_fingerprint FROM public.purchase_order_import_intents WHERE intent_key = public._prover_intent('${ref}'))`;

function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'po-fp-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Chem', 'gal', 22.50, 30.00, 'liquid', true),
      ('${PROD_B}', '[PROVER] Chem B', 'gal', 7.25, 12.00, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    -- The server-derived claim key for a reference under VENDOR (the writer's own formula).
    CREATE FUNCTION public._prover_intent(p_ref text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
      SELECT 'bulk-po-document:' || encode(extensions.digest(convert_to(
        normalize(lower(normalize('${VENDOR}', NFKC)), NFKC) || chr(31) || normalize(lower(normalize(p_ref, NFKC)), NFKC), 'UTF8'), 'sha256'), 'hex') $f$;
    -- Prover-only lookups for steps that run as an API role (which cannot read the claim table).
    -- VOLATILE so each call reads a fresh snapshot that includes rows written earlier in the statement.
    CREATE FUNCTION public._prover_claim_po(p_ref text) RETURNS uuid LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT purchase_order_id FROM public.purchase_order_import_intents WHERE intent_key = public._prover_intent(p_ref) $f$;
    CREATE FUNCTION public._prover_claim_line(p_ref text) RETURNS uuid LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      SELECT poi.id FROM public.purchase_order_items poi WHERE poi.purchase_order_id = public._prover_claim_po(p_ref) $f$;
    CREATE FUNCTION public._prover_same_po(p_result jsonb, p_ref text) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $f$
      BEGIN RETURN COALESCE((p_result->>'po_id')::uuid = public._prover_claim_po(p_ref), false)::text; END $f$;
    GRANT EXECUTE ON FUNCTION public._prover_intent(text), public._prover_claim_po(text), public._prover_claim_line(text), public._prover_same_po(jsonb, text) TO authenticated;
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7c720000-%';`),
    'admin:true,sales_rep:true', 'the seeded roles are not what the proof needs');
  assert.equal(scalar('SELECT count(*) FROM public.purchase_order_import_intents;'), '0', 'the candidate needs no stored import claim');
  console.log('[prover] seeded an admin, a sales rep and two products (no stored import claim, as live)');
}

// ------------------------------------------------------------------------------------------------
// Probes: one transaction per scenario, always rolled back. A step yields "ok|<value>" or
// "<sqlstate>|<message>".
function who(as) {
  if (as === 'owner') return `RESET ROLE;\n${claims(U.ADMIN)}`;
  return `RESET ROLE;\n${claims(as)}\nSET LOCAL ROLE authenticated;`;
}
function scenario(steps, fixture = '') {
  const sql = ['BEGIN;', fixture];
  for (const s of steps) {
    sql.push(who(s.as), `DO $probe$
DECLARE v text;
BEGIN
  v := (${s.call})::text;
  RAISE NOTICE 'RESULT|${s.key}|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|${s.key}|%|%', SQLSTATE, replace(SQLERRM, chr(10), ' ');
END
$probe$;`);
  }
  sql.push('ROLLBACK;');
  const text = sql.join('\n');
  const r = docker([...psqlArgs(), '-A', '-t'], { input: text, allowFailure: true });
  assert.equal(r.status, 0, `scenario failed to run:\n${r.stderr}\n--- SQL ---\n${text}`);
  const out = {};
  for (const m of r.stderr.matchAll(/RESULT\|([^|\n]+)\|([^\n]*)/g)) out[m[1]] = m[2].trimEnd();
  for (const s of steps) assert.ok(s.key in out, `step ${s.key} printed no RESULT:\n${r.stderr}`);
  return out;
}

const CONFLICT = /^P0001\|BULK_PO_DOCUMENT_CONTENT_CONFLICT$/;
const COST = 333;

/** Each step: [key, as, call, before, after]. before/after: a RegExp, an exact string, or 'same'. */
const SCENARIOS = [
  { name: '1. rep then admin with cost', steps: [
    ['rep imports without cost', U.REP, imp(U.REP, 'D1', 'k1-rep', [line()]), 'ok|saved:true', 'same'],
    ['admin imports the same document with cost', U.ADMIN, imp(U.ADMIN, 'D1', 'k1-admin', [line({ cents: COST })]), CONFLICT, 'ok|already_imported:true'],
    ['one PO for the document', 'owner', NEW_POS, 'ok|1', 'same'],
    ['the rep line keeps its catalog cost', 'owner', LINECOST('D1'), 'ok|10:2250', 'same'],
    ['the admin prices it on the existing PO', U.ADMIN, `(SELECT r->>'lines_changed' FROM (SELECT public.set_purchase_order_item_costs(public._prover_claim_po('D1'),
        jsonb_build_array(jsonb_build_object('id', public._prover_claim_line('D1'), 'unit_cost_cents', ${COST})),
        NULL, '${U.ADMIN}', 'k1-cost') AS r) s)`, 'ok|1', 'same'],
    ['the line now has the admin cost', 'owner', LINECOST('D1'), `ok|10:${COST}`, 'same'],
    ['the admin re-imports with cost after pricing', U.ADMIN, imp(U.ADMIN, 'D1', 'k1-admin-2', [line({ cents: COST })]), CONFLICT, 'ok|already_imported:true'],
  ] },
  { name: '2. admin with cost then rep', steps: [
    ['admin imports with cost', U.ADMIN, imp(U.ADMIN, 'D2', 'k2-admin', [line({ cents: COST })]), 'ok|saved:true', 'same'],
    ['rep imports the same document', U.REP, imp(U.REP, 'D2', 'k2-rep', [line()]), CONFLICT, 'ok|already_imported:true'],
    ['an admin with another cost', U.ADMIN, imp(U.ADMIN, 'D2', 'k2-admin-b', [line({ cents: 999 })]), CONFLICT, 'ok|already_imported:true'],
    ['one PO, the first admin cost', 'owner', `${NEW_POS} || '|' || ${LINECOST('D2')}`, `ok|1|10:${COST}`, 'same'],
  ] },
  { name: '3. real content changes still conflict', steps: [
    ['rep imports', U.REP, imp(U.REP, 'D3', 'k3-rep', [line()]), 'ok|saved:true', 'same'],
    ['admin with cost, other quantity', U.ADMIN, imp(U.ADMIN, 'D3', 'k3-qty', [line({ qty: 11, cents: COST })]), CONFLICT, 'same'],
    ['admin with cost, other invoice date', U.ADMIN, imp(U.ADMIN, 'D3', 'k3-date', [line({ cents: COST })], '2026-10-21'), CONFLICT, 'same'],
    ['admin with cost, other product', U.ADMIN, imp(U.ADMIN, 'D3', 'k3-prod', [line({ product: PROD_B, name: '[PROVER] Chem B', cents: COST })]), CONFLICT, 'same'],
    ['admin with cost, other unit', U.ADMIN, imp(U.ADMIN, 'D3', 'k3-unit', [line({ unit: 'qt', cents: COST })]), CONFLICT, 'same'],
    ['admin with cost, an extra line', U.ADMIN, imp(U.ADMIN, 'D3', 'k3-extra', [line({ cents: COST }), line({ product: PROD_B, name: '[PROVER] Chem B', cents: COST })]), CONFLICT, 'same'],
    ['rep, other quantity', U.REP, imp(U.REP, 'D3', 'k3-rep-qty', [line({ qty: 11 })]), CONFLICT, 'same'],
    ['still one PO', 'owner', NEW_POS, 'ok|1', 'same'],
  ] },
  { name: '4. same-key retries', steps: [
    ['admin imports with cost', U.ADMIN, imp(U.ADMIN, 'D4', 'k4', [line({ cents: COST })]), 'ok|saved:true', 'same'],
    ['exact retry, same key', U.ADMIN, imp(U.ADMIN, 'D4', 'k4', [line({ cents: COST })]), 'ok|saved:true', 'same'],
    ['retry, same key, other quantity', U.ADMIN, imp(U.ADMIN, 'D4', 'k4', [line({ qty: 12, cents: COST })]), CONFLICT, 'same'],
    ['retry, same key, other date', U.ADMIN, imp(U.ADMIN, 'D4', 'k4', [line({ cents: COST })], '2026-10-19'), CONFLICT, 'same'],
    // The receipt binds the exact request, cost included: a lost-response retry with another cost is
    // refused, not replayed as "saved" while the PO keeps the first cost.
    ['retry, same key, only the cost changed', U.ADMIN, imp(U.ADMIN, 'D4', 'k4', [line({ cents: 444 })]), CONFLICT, 'same'],
    // The same key without the bulk-import marker: before, the cached result replays as saved; after, a
    // bound bulk receipt refuses it.
    ['same key, no bulk-import marker', U.ADMIN, `(SELECT r->>'status' FROM (SELECT public.save_purchase_order(NULL, jsonb_build_object('vendor', '${VENDOR}', 'status', 'draft'),
        jsonb_build_array(${line({ qty: 12, cents: COST })}), '${U.ADMIN}', 'k4') AS r) s)`, 'ok|saved', /^P0001\|IDEMPOTENCY_PAYLOAD_CONFLICT$/],
    ['the receipt carries a request fingerprint', 'owner', "(SELECT (request_fingerprint ~ '^[0-9a-f]{64}$')::text || ':' || (request_actor_id IS NOT NULL)::text FROM public.idempotency_keys WHERE idempotency_key = 'k4')",
      'ok|<null>', 'ok|true:true'],
    ['the stored cost is the first one', 'owner', `${NEW_POS} || '|' || ${LINECOST('D4')}`, `ok|1|10:${COST}`, 'same'],
    ['rep imports another document', U.REP, imp(U.REP, 'D5', 'k5', [line()]), 'ok|saved:true', 'same'],
    ['rep exact retry, same key', U.REP, imp(U.REP, 'D5', 'k5', [line()]), 'ok|saved:true', 'same'],
    ['rep retry sending a cost (stripped by the wrapper)', U.REP, imp(U.REP, 'D5', 'k5', [line({ cents: 1 })]), 'ok|saved:true', 'same'],
  ] },
  { name: '5. stored fingerprints', steps: [
    ['admin imports document A with cost', U.ADMIN, imp(U.ADMIN, 'D6-A', 'k6a', [line({ cents: COST })]), 'ok|saved:true', 'same'],
    ['rep imports document B, same lines and date', U.REP, imp(U.REP, 'D6-B', 'k6b', [line()]), 'ok|saved:true', 'same'],
    ['the two fingerprints are equal', 'owner', `(${FP('D6-A')} = ${FP('D6-B')})::text`, 'ok|false', 'ok|true'],
    ['a fingerprint is 64 hex characters', 'owner', `(${FP('D6-A')} ~ '^[0-9a-f]{64}$')::text`, 'ok|true', 'same'],
  ] },
];

function runMatrix(phase, fixture = '') {
  const out = {};
  for (const sc of SCENARIOS) {
    const res = scenario(sc.steps.map(([key, as, call]) => ({ key, as, call })), fixture);
    for (const [key] of sc.steps) out[`${sc.name} / ${key}`] = res[key];
  }
  console.log(`[prover] ${phase}: ${Object.keys(out).length} steps run`);
  return out;
}
function check(phase, results, pick = phase) {
  const failures = [];
  const lines = [];
  for (const sc of SCENARIOS) {
    for (const step of sc.steps) {
      const label = `${sc.name} / ${step[0]}`;
      let want = pick === 'before' ? step[3] : step[4];
      if (want === 'same') want = step[3];
      const got = results[label];
      const ok = want instanceof RegExp ? want.test(got) : got === want;
      if (!ok) failures.push(`${label}: got "${got}", expected ${want instanceof RegExp ? want : `"${want}"`}`);
      lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${label} -> ${got}`);
    }
  }
  if (process.env.CRX_PROVER_VERBOSE === '1' || failures.length) console.log(lines.join('\n'));
  assert.deepEqual(failures, [], `${phase.toUpperCase()} failed:\n  ${failures.join('\n  ')}`);
  console.log(`[prover] ${phase.toUpperCase()}: all ${lines.length} steps as expected`);
}

function security() {
  const [anon, auth, svc, secdef, cfg] = docker([...psqlArgs(), '-A', '-t', '-F', '|'], { input: `SELECT has_function_privilege('anon', p.oid, 'EXECUTE'),
      has_function_privilege('authenticated', p.oid, 'EXECUTE'), has_function_privilege('service_role', p.oid, 'EXECUTE'),
      p.prosecdef, array_to_string(p.proconfig, ';') FROM pg_proc p WHERE p.oid = '${SIG}'::regprocedure;` }).stdout.trim().split('|');
  assert.deepEqual([anon, auth, svc], ['f', 'f', 'f'], 'the internal writer is executable by an API role');
  assert.equal(secdef, 't', 'the internal writer must stay SECURITY DEFINER');
  assert.equal(cfg, 'search_path=public, pg_temp', 'the internal writer must pin search_path');
  assert.equal(scalar("SELECT has_function_privilege('authenticated', 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)', 'EXECUTE')::text;"), 'true',
    'the public wrapper must stay executable by authenticated');
  console.log('[prover] SECURITY: the writer stays SECURITY DEFINER with a pinned search_path and no API-role EXECUTE');
}

function preflightRefuses(phase) {
  stageText('cand.sql', lf(CANDIDATE));
  const DRIFT = /BULK_PO_FINGERPRINT_PREFLIGHT: public\._save_purchase_order_ascii_identity_impl\(uuid,jsonb,jsonb,uuid,text\) changed since 2026-10-22/;
  const cases = phase === 'before' ? [
    ['a drifted body', `CREATE OR REPLACE FUNCTION ${SIG.replace('(uuid,jsonb,jsonb,uuid,text)', '(p_po_id uuid, p_po_payload jsonb, p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)')} RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;`, DRIFT],
    // A claim stored under the old rule (here a rep import in the same transaction) refuses the apply.
    ['a stored import claim', `${claims(U.REP)}\nSET LOCAL ROLE authenticated;\nSELECT ${bulkImport(U.REP, 'PF-1', 'k-pf', [line()])};\nRESET ROLE;`,
      /BULK_PO_FINGERPRINT_PREFLIGHT: 1 stored import claim\(s\) were fingerprinted by the old rule/],
  ] : [
    ['a second apply', 'SELECT 1;', DRIFT],
  ];
  for (const [label, setup, refusal] of cases) {
    const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over ${label}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${label}:\n${d.stderr}`);
  }
  console.log(`[prover] PREFLIGHT (${phase}): ${cases.map(([label]) => label).join(' and ')} ${cases.length > 1 ? 'each abort' : 'is refused by'} the candidate`);
}

// MUTATION 1: strip only unit_cost_cents. An admin line still carries unit_cost, so the conflict
// returns: both keys must go for the rep-then-admin import to match.
// MUTATION 2: skip the receipt's request-fingerprint check. A same-key retry that changed only the
// cost then replays "saved": the receipt binding is what refuses it.
function mutation() {
  const candidateBody = lf(CANDIDATE).split('$preflight$;')[1].split('REVOKE ALL ON FUNCTION')[0];
  const body = candidateBody.replace("raw.value - 'unit_cost' - 'unit_cost_cents'", "raw.value - 'unit_cost_cents'");
  assert.ok(body.includes("raw.value - 'unit_cost_cents'") && !body.includes("- 'unit_cost' -"), 'mutation 1 did not apply');
  const out = scenario([
    { key: 'rep imports', as: U.REP, call: imp(U.REP, 'M1', 'km-rep', [line()]) },
    { key: 'admin with cost', as: U.ADMIN, call: imp(U.ADMIN, 'M1', 'km-admin', [line({ cents: COST })]) },
  ], body);
  assert.equal(out['rep imports'], 'ok|saved:true');
  assert.match(out['admin with cost'], CONFLICT, `MUTATION 1: with unit_cost kept the admin import should conflict, got ${out['admin with cost']}`);

  const unbound = candidateBody.replace('IF v_existing_request_fingerprint IS DISTINCT FROM v_request_fingerprint THEN',
    'IF false AND v_existing_request_fingerprint IS DISTINCT FROM v_request_fingerprint THEN');
  assert.notEqual(unbound, candidateBody, 'mutation 2 did not apply');
  const out2 = scenario([
    { key: 'admin imports', as: U.ADMIN, call: imp(U.ADMIN, 'M2', 'km2', [line({ cents: COST })]) },
    { key: 'same key, other cost', as: U.ADMIN, call: imp(U.ADMIN, 'M2', 'km2', [line({ cents: 444 })]) },
  ], unbound);
  assert.equal(out2['admin imports'], 'ok|saved:true');
  assert.equal(out2['same key, other cost'], 'ok|saved:true', `MUTATION 2: without the receipt check a cost-only retry should replay, got ${out2['same key, other cost']}`);
  console.log('[prover] MUTATION: stripping only unit_cost_cents brings the conflict back; skipping the receipt check replays a cost-only retry as saved -- so each behaviour comes from the code it names');
}

function main() {
  const started = Date.now();
  buildContainer();
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7c720000-%';") === '0') seed();

  check('before', runMatrix('before'));
  preflightRefuses('before');

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  check('after', runMatrix('after'));
  security();
  preflightRefuses('after');
  mutation();

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('BULK_PO_FINGERPRINT_IGNORES_COST_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
