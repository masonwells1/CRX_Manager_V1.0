#!/usr/bin/env node
/**
 * Full-chain proof for the 20261016140000 candidate: thirteen stock RPCs replay a stored
 * idempotency receipt only for the same person and the exact same request (batch 2 of the
 * replay-binding fix, KNOWN_ISSUES.md; batch 1 is 20261016060000).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as batch 1's prover; batch 1 itself replays as an ordinary migration), then:
 *   0. FIDELITY: every body the candidate's preflight pins (the thirteen, check_idempotency_intent,
 *      batch 1's three helpers, revert_quote_status, _reverse_completed_cycle_count_impl) replayed
 *      with its live md5 of 2026-10-16;
 *   1. BEFORE: the new chain fails first at its step 1 (release_inventory_hold hands hold A's
 *      receipt back as success for hold B), and every covering chain that passes is recorded;
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the file stops at its preflight;
 *      PREFLIGHT: a drifted release_inventory_hold, a drifted batch-1 guard trigger, or an
 *      unexpired receipt for one of the thirteen operations aborts the candidate before any change;
 *   3. the candidate applies and prints POSTFLIGHT_OK;
 *   4. AFTER: the new chain passes and rolls back; the only document-number sequence it moves is
 *      order_number_seq, by exactly 2 (create_direct_order and create_rush_order draw their own
 *      order numbers; the chain header and the spec say so); every covering chain that passed
 *      BEFORE still passes; batch 1's chain still passes; an unbound receipt for a batch-2
 *      operation never commits (autocommit insert, a real COMMIT of a stripped binding, and a
 *      COMMIT under the authenticated role);
 *   5. RE-APPLY: refused by the preflight's own pins;
 *   6. MUTATION: with each wrapper's target (and reconcile's quantity) taken out of its fingerprint, its key
 *      requirement removed, its no-op exemption or binder call removed, batch 1's binder broken,
 *      or one batch-2 operation dropped from the commit-time guard's list, the new chain fails at
 *      the step that proves it.
 *
 * Run: node scripts/smoke/prove-stock-replay-binding-batch2-real-schema.mjs   (needs Docker)
 * Prints STOCK_REPLAY_BINDING_BATCH2_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-stock-replay-batch2-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261016140000_bind_stock_replay_receipts_batch2.sql');
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
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const CHAIN = path.join(SMOKE, 'smoke-stock-replay-binding-batch2.sql');
const BATCH1_CHAIN = path.join(SMOKE, 'smoke-money-replay-binding-batch1.sql');
// Every other non-container-prover chain under scripts/smoke that calls one of the thirteen RPCs
// (or revert_quote_status, which rebuilds planned holds through the private create_planned_holds body). Each must keep passing after
// the candidate if it passed before it (some need live data this database lacks; those are
// reported, not required).
const COVERING_CHAINS = [
  'smoke-blend-ticket-fractional-cents.sql',
  'smoke-gauntlet-core-blend-guards.sql',
  'smoke-orders-blend-tickets-rep-own-name.sql',
  'smoke-create-direct-order-po.sql',
  'smoke-cycle-count-concurrency-guards.sql',
  'smoke-draw-ledger-reversal.sql',
  'smoke-planned-holds-drawn-sync.sql',
  'smoke-revert-quote-escape-hatch.sql',
];
const WRAPPED = [
  'release_inventory_hold', 'retire_inventory_item', 'reconcile_negative_inventory', 'manual_inventory_add',
  'create_order_from_blend_ticket', 'create_direct_order', 'create_rush_order', 'close_quote_as_applied',
  'close_quote_as_short', 'create_application_record_from_blend_ticket', 'batch_cancel_deliveries',
  'reverse_completed_cycle_count', 'create_planned_holds',
];
// The receipt operation each wrapper binds (the application-record RPC's is shorter).
const OP = Object.fromEntries(WRAPPED.map((w) => [w, w === 'create_application_record_from_blend_ticket' ? 'create_app_record_from_bt' : w]));
const BATCH1_OPS = [
  'void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off', 'reverse_write_off',
  'apply_prepay_to_invoice', 'create_prepay_check_splits', 'batch_apply_prepayments', 'batch_void_invoices',
];
const ORDER_NUMBER_SEQ = 'public.order_number_seq';
const ORDER_NUMBERS_DRAWN = 2;

const id = (n) => `7b610000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_B: id('a2'), REP: id('b1') };

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
// Record a migration in the ledger by NAME (later preflights look names up), versioned by its own
// stamp: an older file's high-water check compares versions, so only stamps are used.
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
  assert.ok(before.some((f) => path.basename(f) === '20261016060000_bind_money_replay_receipts_batch1.sql'),
    'batch 1 (20261016060000) must replay before the candidate: its helpers and guard are what the candidate builds on');
  const touched = new RegExp([...WRAPPED, 'idempotency_keys', '_replay_receipt_20261015', 'revert_quote_status'].join('|'));
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!touched.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
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
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// ------------------------------------------------------------------------------------------------
// FIDELITY: every md5 pin the candidate's preflight checks, read from the candidate file itself.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  // The thirteen: ('name', '_impl', 'args (may contain doubled quotes)', 'ret', 'md5').
  const pins = [...sql.matchAll(/\('([a-z_]+)', '(_[a-z0-9_]+)', '(?:[^']|'')*', '[a-z[\]]+', '([0-9a-f]{32})'\)/g)]
    .map((m) => [`public.${m[1]}`, m[3], `proname = '${m[1]}'`]);
  assert.deepEqual(pins.map(([n]) => n.slice('public.'.length)).sort(), [...WRAPPED].sort(), 'the preflight pins exactly the thirteen wrapped bodies');
  const single = (label, re) => {
    const m = re.exec(sql);
    assert.ok(m, `the preflight pins ${label}`);
    pins.push([`public.${label}`, m[1], `proname = '${label}'`]);
  };
  single('check_idempotency_intent', /p\.proname = 'check_idempotency_intent'[\s\S]*?= '([0-9a-f]{32})'/);
  single('revert_quote_status', /p\.proname = 'revert_quote_status'[\s\S]*?= '([0-9a-f]{32})'/);
  single('_reverse_completed_cycle_count_impl', /p\.proname = '_reverse_completed_cycle_count_impl'[\s\S]*?= '([0-9a-f]{32})'/);
  const helpers = [...sql.matchAll(/\('(public\.[a-z0-9_]+\([a-z,]*\))', '([0-9a-f]{32})', (?:true|false)\)/g)];
  assert.equal(helpers.length, 3, 'the preflight pins batch 1\'s three helpers');
  for (const [, sig, md5] of helpers) pins.push([sig, md5, `oid = to_regprocedure('${sig}')`]);
  for (const [label, pin, where] of pins) {
    const rows = scalar(`SELECT count(*) || ':' || COALESCE(max(md5(replace(p.prosrc, chr(13), ''))), '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.${where};`);
    assert.equal(rows, `1:${pin}`, `${label} replayed with a body that differs from the live pin (count:md5 = ${rows})`);
  }
  console.log(`[prover] FIDELITY: all ${pins.length} pinned bodies match the live pins of 2026-10-16`);
}

// ------------------------------------------------------------------------------------------------
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN_B, 'admin', 'Admin B', 8], [U.REP, 'sales_rep', 'Rep', 7]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'replay-batch2-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7b610000-%';`),
    'admin:true,admin:true,sales_rep:true', 'the seeded roles are not what the proof needs');
  // The chains borrow real priced catalog rows without changing them; this database is
  // schema-only, so seed two (the governed-pricing trigger is off for this one statement only).
  psql(`BEGIN;
ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
INSERT INTO public.products (product_name, unit_size, current_cost, tier1_price)
VALUES ('[PROVER] Stock Replay Priced A', 'gal', 3.00, 10.00),
       ('[PROVER] Stock Replay Priced B', 'gal', 4.00, 8.00);
ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
COMMIT;`);
  assert.equal(scalar("SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname = 'trigger_y_require_governed_product_pricing';"),
    'O', 'the governed-pricing trigger was not re-enabled after the seed');
}

/** Run a chain file; `prefix` runs first in the same transaction (a mutation). */
function chain(file, prefix = '', user = 'postgres') {
  stageText('chain.sql', lf(file));
  const r = docker([...psqlArgs(user)], { input: `BEGIN;\n${prefix}\n\\i /tmp/chain.sql\nROLLBACK;\n`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = /SMOKE_PASS_ROLLBACK/.test(out);
  const fail = /SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? (pass ? '' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-400)));
  return { pass, fail };
}
function covering(phase, required) {
  const passed = new Set();
  for (const name of COVERING_CHAINS) {
    const r = chain(path.join(SMOKE, name));
    if (r.pass) passed.add(name);
    else if (required?.has(name)) assert.fail(`${phase}: ${name} passed before the candidate and fails after it: ${r.fail}`);
    else console.log(`[prover] ${phase}: ${name} does not pass in this database (not required): ${r.fail}`);
  }
  console.log(`[prover] ${phase}: ${passed.size}/${COVERING_CHAINS.length} covering chains pass and roll back: ${[...passed].join(', ') || 'none'}`);
  return passed;
}
/** Each sequence's position: last_value, or one step before start_value when never called. */
function sequences() {
  const rows = docker([...psqlArgs(), '-A', '-t', '-F', '|'], {
    input: "SELECT schemaname || '.' || sequencename, COALESCE(last_value, start_value - increment_by)::text, increment_by::text FROM pg_sequences ORDER BY 1;",
  }).stdout.trim().split(/\r?\n/).filter(Boolean);
  return new Map(rows.map((r) => { const [k, v, inc] = r.split('|'); return [k, { at: BigInt(v), inc: BigInt(inc) }]; }));
}
function movedSequences(before, after) {
  return new Map([...after.keys()].filter((k) => after.get(k).at !== before.get(k)?.at)
    .map((k) => [k, Number((after.get(k).at - (before.get(k)?.at ?? 0n)) / after.get(k).inc)]));
}
// A rollback does not return sequence values. Surrogate row-id sequences moving is harmless; a
// document-number sequence (invoice, order, account numbers) moving leaves a visible gap on live.
function documentNumberSequences() {
  return new Set(docker([...psqlArgs(), '-A', '-t'], {
    input: `SELECT DISTINCT s.schemaname || '.' || s.sequencename
              FROM pg_sequences s
             WHERE s.sequencename ~ '(number|_no|_num)'
                OR EXISTS (SELECT 1 FROM pg_proc p
                            WHERE p.prosrc ILIKE '%nextval(%' || s.sequencename || '%'
                              AND (p.proname ~ '^next_.*_number$' OR p.proname ~ '^generate_.*_number$'));`,
  }).stdout.trim().split(/\r?\n/).filter(Boolean));
}

/** Insert an unbound receipt for `op` and force the deferred guard to run now. */
function unboundReceipt(op, prefix = '') {
  const r = docker([...psqlArgs()], {
    input: `BEGIN;
${prefix}
INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
VALUES ('prover-unbound-' || gen_random_uuid(), '${op}', '{"success":true}'::jsonb);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'UNBOUND_RECEIPT_ACCEPTED';
ROLLBACK;`,
    allowFailure: true,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  return /UNBOUND_RECEIPT_ACCEPTED/.test(out) ? 'accepted' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-300));
}
/**
 * An unbound receipt queued by the owner, then COMMITted while the session role is authenticated
 * (as after a browser RPC returns). On PostgreSQL 17 the deferred guard runs under that role.
 */
function unboundReceiptCommittedAsAuthenticated(op) {
  const key = `prover-unbound-as-authenticated-${op}-${Date.now()}`;
  const r = docker([...psqlArgs()], {
    input: `BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
VALUES ('${key}', '${op}', '{"success":true}'::jsonb);
SELECT set_config('request.jwt.claims', json_build_object('sub', '${U.ADMIN}', 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
COMMIT;`,
    allowFailure: true,
  });
  const committed = scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = '${key}';`);
  psql(`DELETE FROM public.idempotency_keys WHERE idempotency_key = '${key}';`);
  return { refused: /REPLAY_RECEIPT_UNBOUND/.test(`${r.stdout}\n${r.stderr}`), committed };
}

function candidateBody(fn) {
  const sql = lf(CANDIDATE);
  const start = sql.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  assert.ok(start >= 0, `${fn} is not created by the candidate`);
  const tag = /AS (\$[a-z_]*\$)/.exec(sql.slice(start))[1];
  const a = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const header = sql.slice(start, a).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  return { header, body: sql.slice(a, sql.indexOf(`${tag};`, a)), tag };
}
/** A batch-1 helper's live body (it is not created by the candidate): read it from the database. */
function liveFunction(sig) {
  const def = docker([...psqlArgs(), '-A', '-t'], {
    input: `SELECT pg_get_functiondef(to_regprocedure('${sig}'));`,
  }).stdout.replace(/\s+$/, '');
  assert.match(def, /^CREATE OR REPLACE FUNCTION/, `${sig} is not installed`);
  return def;
}
function mutate(fn, find, replacement, label) {
  const { header, body, tag } = candidateBody(fn);
  assert.equal(body.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once`);
  return `${header}${body.replace(find, replacement)}${tag};`;
}
function mutateLive(sig, find, replacement, label) {
  const def = liveFunction(sig);
  assert.equal(def.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once`);
  return `${def.replace(find, replacement)};`;
}
/** The guard trigger recreated over a different operation list (a mutation prefix). */
function guardOver(ops) {
  return `DROP TRIGGER require_bound_replay_receipt_20261015 ON public.idempotency_keys;
CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015
  AFTER INSERT OR UPDATE ON public.idempotency_keys
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.operation IN (${ops.map((o) => `'${o}'`).join(', ')}))
  EXECUTE FUNCTION public._require_bound_replay_receipt_20261015();`;
}
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function main() {
  buildContainer();
  fidelity();
  seed();

  // 1. BEFORE.
  const before = chain(CHAIN);
  assert.ok(!before.pass, 'BEFORE: the replay-binding chain passed on the unbound bodies');
  assert.match(before.fail, /SMOKE_FAIL: release_inventory_hold handed hold A's receipt back as success for hold B/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: the chain fails first at step 1: ${before.fail}`);
  const passedBefore = covering('BEFORE');
  const batch1Before = chain(BATCH1_CHAIN);
  assert.ok(batch1Before.pass, `BEFORE: batch 1's chain does not pass on its own migration: ${batch1Before.fail}`);

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /STOCK_REPLAY_BINDING_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  // No batch-2 renamed body exists until the candidate applies.
  const implNames = Object.values(OP).map((op) => `'_${op}_replay_impl_20261015'`).join(', ');
  const unchanged = () => scalar(`SELECT count(*) FROM pg_proc WHERE proname IN (${implNames});`);
  assert.equal(unchanged(), '0', 'AUTOCOMMIT: a refused apply left a renamed body behind');
  const drift = docker([...psqlArgs()], {
    input: `BEGIN;
CREATE OR REPLACE FUNCTION public.release_inventory_hold(p_hold_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(drift.status, 0, 'PREFLIGHT: the candidate applied over a drifted body');
  assert.match(drift.stderr, /PREFLIGHT_STOCK_REPLAY_BODY_DRIFT: [^\n]*release_inventory_hold/, `PREFLIGHT: wrong refusal:\n${drift.stderr}`);
  const guardDrift = docker([...psqlArgs()], {
    input: `BEGIN;
${guardOver(BATCH1_OPS.slice(1))}
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(guardDrift.status, 0, 'PREFLIGHT: the candidate applied over a drifted batch-1 guard trigger');
  assert.match(guardDrift.stderr, /PREFLIGHT_RECEIPT_GUARD_DRIFT/, `PREFLIGHT: wrong refusal for a drifted guard:\n${guardDrift.stderr}`);
  // An unexpired receipt for one of the thirteen operations (an old body's, unbound) blocks the apply.
  const pending = docker([...psqlArgs()], {
    input: `BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('prover-pending-receipt', 'create_app_record_from_bt', '[]'::jsonb);
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(pending.status, 0, 'PREFLIGHT: the candidate applied with an unexpired receipt for a wrapped operation');
  assert.match(pending.stderr, /PREFLIGHT_UNEXPIRED_RECEIPTS/, `PREFLIGHT: wrong refusal for a pending receipt:\n${pending.stderr}`);
  assert.equal(unchanged(), '0', 'PREFLIGHT: a refused apply left a renamed body behind');
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, over a drifted body or guard trigger, or with an unexpired receipt for a wrapped operation, the candidate stops before any change');

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  console.log('[prover] candidate applied; POSTFLIGHT_OK');

  // 4. AFTER.
  const seqBefore = sequences();
  const after = chain(CHAIN);
  assert.ok(after.pass, `AFTER: the replay-binding chain failed: ${after.fail}`);
  const moved = movedSequences(seqBefore, sequences());
  const docNumbers = documentNumberSequences();
  assert.ok(docNumbers.has(ORDER_NUMBER_SEQ), `AFTER: ${ORDER_NUMBER_SEQ} is not recognized as a document-number sequence`);
  const movedDoc = [...moved].filter(([s]) => docNumbers.has(s));
  // Honest, not weakened: exactly order_number_seq, by exactly the two order numbers the header
  // documents (create_direct_order + create_rush_order first calls). Any other document sequence,
  // or a third order number, fails.
  assert.deepEqual(movedDoc, [[ORDER_NUMBER_SEQ, ORDER_NUMBERS_DRAWN]],
    `AFTER: the chain moved document-number sequences other than the documented ${ORDER_NUMBERS_DRAWN} order numbers: ${JSON.stringify(movedDoc)}`);
  console.log(`[prover] AFTER: the chain passes and rolls back; of ${docNumbers.size} document-number sequences only ${ORDER_NUMBER_SEQ} moved, by exactly ${ORDER_NUMBERS_DRAWN} (documented); surrogate id sequences moved: ${[...moved.keys()].filter((s) => !docNumbers.has(s)).join(', ') || 'none'}`);
  covering('AFTER', passedBefore);
  const batch1After = chain(BATCH1_CHAIN);
  assert.ok(batch1After.pass, `AFTER: batch 1's chain fails after the candidate: ${batch1After.fail}`);
  console.log('[prover] AFTER: batch 1\'s chain still passes and rolls back');
  for (const op of [...Object.values(OP), 'apply_write_off']) {
    const g = unboundReceipt(op);
    assert.match(g, /REPLAY_RECEIPT_UNBOUND/, `AFTER: an unbound ${op} receipt was not refused by the guard: ${g}`);
  }
  // Operations nobody wraps are still free.
  assert.equal(unboundReceipt('cancel_delivery'), 'accepted', 'AFTER: the guard now refuses an operation outside the two batches');
  const autocommit = docker([...psqlArgs()], {
    input: "INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('prover-unbound-autocommit', 'release_inventory_hold', '{\"status\":\"released\"}'::jsonb);",
    allowFailure: true,
  });
  assert.match(autocommit.stderr, /REPLAY_RECEIPT_UNBOUND/, `AFTER: an autocommit unbound receipt was not refused:\n${autocommit.stderr}`);
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'prover-unbound-autocommit';"), '0', 'AFTER: the refused unbound receipt was committed');
  const asAuth = unboundReceiptCommittedAsAuthenticated('create_planned_holds');
  assert.ok(asAuth.refused && asAuth.committed === '0',
    `AFTER: an unbound receipt committed under the authenticated role was not refused: ${JSON.stringify(asAuth)}`);
  const strippedAtCommit = docker([...psqlArgs()], {
    input: `BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
VALUES ('prover-strip-binding-at-commit', 'batch_cancel_deliveries', '{"count":1}'::jsonb, '${U.ADMIN}', repeat('a', 64));
UPDATE public.idempotency_keys SET request_fingerprint = NULL WHERE idempotency_key = 'prover-strip-binding-at-commit';
COMMIT;`,
    allowFailure: true,
  });
  assert.match(`${strippedAtCommit.stdout}\n${strippedAtCommit.stderr}`, /REPLAY_RECEIPT_UNBOUND/,
    `AFTER: COMMIT of a stripped receipt was not refused:\n${strippedAtCommit.stderr}`);
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'prover-strip-binding-at-commit';"), '0',
    'AFTER: the stripped receipt was committed');
  console.log('[prover] AFTER: an unbound receipt for each batch-2 operation (and batch 1\'s) is refused by the guard; at a real COMMIT (autocommit insert, a stripped binding, a COMMIT under the authenticated role) it never commits; an unwrapped operation is still free');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_STOCK_REPLAY_BODY_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION: each wrapper's TARGET field (plus reconcile's new_quantity), key requirement,
  // no-op exemption, binder call and guard entry is what its chain step proves. The other payload
  // fields (notes, items, dates, PO numbers, reasons) are not mutated one by one; the drift and
  // security reviews checked each fingerprint lists every argument.
  const fp = (fn, field, last = false) => (last
    ? [`${fn} ${field}`, fn, `,\n    '${field}', p_${field}\n`, '\n']
    : [`${fn} ${field}`, fn, `    '${field}', p_${field},\n`, '']);
  const mutations = [
    [...fp('release_inventory_hold', 'hold_id', true), /SMOKE_FAIL: release_inventory_hold handed hold A's receipt back/],
    [...fp('retire_inventory_item', 'inventory_id', true), /SMOKE_FAIL: retire_inventory_item replayed row 1's receipt/],
    [...fp('reconcile_negative_inventory', 'inventory_id'), /SMOKE_FAIL: reconcile_negative_inventory replayed row 1's receipt/],
    [...fp('reconcile_negative_inventory', 'new_quantity'), /SMOKE_FAIL: reconcile_negative_inventory replayed a receipt for a changed quantity/],
    [...fp('manual_inventory_add', 'product_id'), /SMOKE_FAIL: manual_inventory_add replayed product 1's receipt/],
    [...fp('create_order_from_blend_ticket', 'blend_ticket_id'), /SMOKE_FAIL: create_order_from_blend_ticket replayed ticket 1's order/],
    [...fp('create_direct_order', 'customer_id'), /SMOKE_FAIL: create_direct_order replayed customer A's order/],
    [...fp('create_rush_order', 'customer_id'), /SMOKE_FAIL: create_rush_order replayed customer A's order/],
    [...fp('close_quote_as_applied', 'quote_id', true), /SMOKE_FAIL: close_quote_as_applied replayed quote 1's close/],
    [...fp('close_quote_as_short', 'quote_id', true), /SMOKE_FAIL: close_quote_as_short replayed quote 3's close/],
    [...fp('create_application_record_from_blend_ticket', 'blend_ticket_id', true), /SMOKE_FAIL: create_application_record_from_blend_ticket replayed ticket 3's records/],
    ['batch_cancel_deliveries delivery set', 'batch_cancel_deliveries',
      "    'delivery_ids', to_jsonb(ARRAY(SELECT DISTINCT u.id FROM unnest(p_delivery_ids) AS u(id) ORDER BY u.id)),\n", '',
      /SMOKE_FAIL: batch_cancel_deliveries replayed batch 1's count/],
    // The set normalization: hashing the ids in the order sent refuses the same set reordered.
    ['batch_cancel_deliveries set normalization', 'batch_cancel_deliveries',
      'to_jsonb(ARRAY(SELECT DISTINCT u.id FROM unnest(p_delivery_ids) AS u(id) ORDER BY u.id))', 'to_jsonb(p_delivery_ids)',
      /SMOKE_FAIL: the exact batch_cancel_deliveries retry \(same set, other order\) was refused: IDEMPOTENCY_INTENT_MISMATCH/],
    [...fp('reverse_completed_cycle_count', 'cycle_count_id', true), /SMOKE_FAIL: reverse_completed_cycle_count replayed count 1's reversal/],
    [...fp('create_planned_holds', 'quote_id', true), /SMOKE_FAIL: create_planned_holds replayed quote 5's receipt/],
  ];
  // Each key requirement (twelve here; create_planned_holds' is mutated below, with step 13).
  for (const fn of WRAPPED.filter((w) => w !== 'create_planned_holds')) {
    mutations.push([`${fn} key requirement`, fn,
      `    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: ${fn} requires p_idempotency_key' USING ERRCODE = '22023';\n`, '    NULL;\n',
      new RegExp(`SMOKE_FAIL: (a keyless call ran|wrong keyless refusal for) SELECT public\\.${fn}\\(`)]);
  }
  // create_planned_holds' key requirement: with a keyless path back, an outside keyless call runs.
  mutations.push(['create_planned_holds key requirement', 'create_planned_holds',
    "    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_planned_holds requires p_idempotency_key' USING ERRCODE = '22023';\n",
    '    RETURN public._create_planned_holds_replay_impl_20261015(p_quote_id, p_performed_by, NULL);\n',
    /SMOKE_FAIL: a keyless create_planned_holds ran/]);
  // revert_quote_status' key requirement: without it, a keyless revert runs.
  mutations.push(['revert_quote_status key requirement', 'revert_quote_status',
    "    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: revert_quote_status requires p_idempotency_key' USING ERRCODE = '22023';\n",
    '    NULL;\n',
    /SMOKE_FAIL: (a keyless revert_quote_status ran|wrong keyless revert_quote_status refusal)/]);
  // revert_quote_status' retargeted call: pointed back at the public wrapper, its rebuild is refused.
  mutations.push(['revert_quote_status private-body call', 'revert_quote_status',
    '    PERFORM public._create_planned_holds_replay_impl_20261015(p_quote_id, v_actor, NULL);\n',
    '    PERFORM create_planned_holds(p_quote_id, v_actor, NULL);\n',
    /SMOKE_FAIL: revert_quote_status \(its planned-holds rebuild through the private body\) was refused/]);
  // The four no-receipt no-op exemptions: binding them would raise IDEMPOTENCY_RECEIPT_MISSING.
  mutations.push(
    ['release_inventory_hold already_released exemption', 'release_inventory_hold',
      "  IF v_replay IS NULL AND v_result ->> 'status' IS DISTINCT FROM 'already_released' THEN\n", '  IF v_replay IS NULL THEN\n',
      /SMOKE_FAIL: the already_released no-op was refused: IDEMPOTENCY_RECEIPT_MISSING/],
    ['close_quote_as_applied already_closed exemption', 'close_quote_as_applied',
      "  IF v_replay IS NULL AND (v_result -> 'already_closed') IS DISTINCT FROM 'true'::jsonb THEN\n", '  IF v_replay IS NULL THEN\n',
      /SMOKE_FAIL: the already_closed no-op \(applied\) was refused: IDEMPOTENCY_RECEIPT_MISSING/],
    ['close_quote_as_short already_closed exemption', 'close_quote_as_short',
      "  IF v_replay IS NULL AND (v_result -> 'already_closed') IS DISTINCT FROM 'true'::jsonb THEN\n", '  IF v_replay IS NULL THEN\n',
      /SMOKE_FAIL: the already_closed no-op \(short\) was refused: IDEMPOTENCY_RECEIPT_MISSING/],
    ['create_order_from_blend_ticket success:false exemption', 'create_order_from_blend_ticket',
      "  IF v_replay IS NULL AND (v_result::jsonb -> 'success') IS DISTINCT FROM 'false'::jsonb THEN\n", '  IF v_replay IS NULL THEN\n',
      /SMOKE_FAIL: the success:false no-op was refused: IDEMPOTENCY_RECEIPT_MISSING/],
  );
  // Each wrapper's binder call: an unbound receipt is a legacy receipt, so its own exact retry is refused.
  for (const fn of WRAPPED) {
    const retry = fn === 'batch_cancel_deliveries' ? 'the exact batch_cancel_deliveries retry \\(same set, other order\\)' : `the exact ${fn} retry`;
    mutations.push([`${fn} receipt binding`, fn,
      `    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, '${OP[fn]}', v_fingerprint);\n`, '    NULL;\n',
      new RegExp(`SMOKE_FAIL: ${retry} was refused: IDEMPOTENCY_INTENT_MISMATCH`)]);
  }
  for (const [label, fn, find, replacement, expected] of mutations) {
    const r = chain(CHAIN, mutate(fn, find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} hunk the chain fails: ${r.fail}`);
  }
  // Batch 1's binder (shared): left unbound, the exact retry is refused; stamped with someone
  // else's id, the author's own exact retry is refused as another actor's.
  const binder = 'public._bind_replay_receipt_20261015(text,text,text)';
  const binderMutations = [
    ['receipt binder stamp', mutateLive(binder, '     SET request_actor_id = v_actor,\n         request_fingerprint = p_fingerprint\n',
      '     SET request_actor_id = NULL,\n         request_fingerprint = NULL\n', 'receipt binder stamp'),
    /SMOKE_FAIL: the exact release_inventory_hold retry was refused: IDEMPOTENCY_INTENT_MISMATCH/],
    ['receipt binder actor', mutateLive(binder, '     SET request_actor_id = v_actor,\n',
      "     SET request_actor_id = '00000000-0000-0000-0000-000000000000'::uuid,\n", 'receipt binder actor'),
    // Step 1 tries the different-hold call first, which now meets a receipt bound to someone else.
    /SMOKE_FAIL: wrong release_inventory_hold refusal: IDEMPOTENCY_ACTOR_MISMATCH/],
  ];
  for (const [label, prefix, expected] of binderMutations) {
    const r = chain(CHAIN, prefix);
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} hunk the chain fails: ${r.fail}`);
  }
  // The commit-time guard's list: drop each batch-2 operation in turn.
  const guardOps = [...BATCH1_OPS, ...Object.values(OP)];
  for (const op of Object.values(OP)) {
    const r = chain(CHAIN, guardOver(guardOps.filter((o) => o !== op)));
    assert.ok(!r.pass, `MUTATION guard without ${op}: the chain still passed`);
    assert.match(r.fail, new RegExp(`SMOKE_FAIL: the commit-time guard accepted an unbound ${escapeRe(op)} receipt`), `MUTATION guard without ${op}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: with ${op} dropped from the commit-time guard the chain fails: ${r.fail}`);
  }

  console.log('STOCK_REPLAY_BINDING_BATCH2_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
