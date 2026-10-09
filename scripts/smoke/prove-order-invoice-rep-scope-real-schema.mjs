#!/usr/bin/env node
/**
 * Full-chain proof for 20261008120000_scope_order_invoices_to_rep (rep scoping
 * for order invoices, Mason 2026-10-06: a sales rep bills only customers
 * assigned to them and only under their own name; admins are unrestricted).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a
 * network-disabled Supabase PostgreSQL 17 container, replays every ordered
 * post-baseline migration before the candidate plus PR #889's schema
 * migrations (which must be applied live first; all four #889 migrations are
 * recorded in the container ledger, which the candidate's preflight requires),
 * and then, as the `authenticated` role exactly like a browser session through
 * PostgREST:
 *   0. FIDELITY: the replayed order-path bodies hash to the values read from
 *      live on 2026-10-08/09, so this is the code production runs;
 *   1. BEFORE (the bug): a rep invoices another rep's customer; a rep names
 *      another rep as salesman and that rep can then read the invoice; a rep
 *      splits another rep's allocated order; an admin field_application split
 *      is refused but draws an invoice number; the new chain fails at step 1
 *      and the updated split chain fails on the burned number;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight;
 *      PREFLIGHT: a drifted split wrapper in the same transaction blocks it, and
 *      so does a drift of every other pin group (delegates, role helper,
 *      complete_delivery, the wrapper ACLs and attributes, the scope columns,
 *      PR #889 missing from the ledger); POSTFLIGHT: a wrong body pin or a
 *      late split type gate makes the postflight roll the apply back;
 *   3. APPLY: POSTFLIGHT_OK, the new md5s, OIDs, ACLs and delegates;
 *   4. FIX: every refusal of chain steps 1-7 as `authenticated`, with no
 *      invoice number drawn; the same refusals again while a second session
 *      holds the order row lock and the key's idempotency advisory lock, which
 *      proves they come before the claim and the lock (a refused call's own
 *      writes roll back with its subtransaction, so row counts alone cannot);
 *      the allowed cases (incl. misc_charge splits and an admin split replay);
 *      anon denied;
 *   5. DELIVERIES: complete_delivery by an admin, a rep (own / other rep's /
 *      mixed-owner order), the assigned driver and on a non-allocated order,
 *      plus the exact auto-split call repeated directly to show WHY it fell back;
 *   6. CHAINS: the registered chains around these RPCs;
 *   7. RE-APPLY: refused on its own pins, nothing changed;
 *   8. MUTATIONS (a)-(v): each removed or moved layer or pre-check leg makes its
 *      check fail for the stated reason, including four real two-session
 *      interleavings that show what the post-checks (customer and salesman legs)
 *      catch and a replay whose salesman changed; each restored body re-passes.
 * Two registered chains (financial-scope, split jsonb) fail on main before
 * reaching any changed RPC: they assert nothing about this change, and are only
 * checked to fail identically before and after.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-order-rep-scope-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261008120000_scope_order_invoices_to_rep.sql');
const CIFO = 'public.create_invoice_from_order(uuid,uuid,text,text)';
const SPLIT = 'public.create_split_invoices_from_order(uuid,uuid,text,text)';
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const CHAINS = {
  repScope: path.join(SMOKE, 'smoke-order-invoice-rep-scope.sql'),
  typeGate: path.join(SMOKE, 'smoke-order-invoice-type-gate.sql'),
  split: path.join(SMOKE, 'smoke-backfill-refuse-split-billing.sql'),
  lifecycle: path.join(SMOKE, 'smoke-govern-invoice-order-money-lifecycle.sql'),
  keys: path.join(SMOKE, 'smoke-money-lifecycle-idempotency-required.sql'),
  periodGuard: path.join(SMOKE, 'smoke-delivery-accounting-period-guard.sql'),
  // These two fail on main for reasons unrelated to this change (see STALE_CHAINS below).
  financialScope: path.join(SMOKE, 'smoke-financial-scope-and-delivery-aggregate.sql'),
  splitJsonb: path.join(SMOKE, 'smoke-split_invoices_jsonb_fix.sql'),
};
// DEVIATION from the design (section 5.4.6, which asks both to pass): these two chains fail
// on main before they reach any changed RPC, so they prove nothing about this change; this
// prover only checks they fail identically before and after. Repairing them is a separate
// follow-up. The admin split replay path the jsonb chain exists to cover is asserted directly
// in FIX (an admin's exact split replay with no salesman).
// Pre-existing failures, identical before and after the candidate (checked below):
//  - financial-scope: its save_invoice replay step expects CUSTOMER_SCOPE_DENIED but the
//    current save_invoice answers a cross-actor key with IDEMPOTENCY_ACTOR_MISMATCH first;
//  - split_invoices_jsonb_fix: it inserts a priced product directly, which the governed
//    pricing trigger refuses (PRODUCT_PRICING_GOVERNED_PATH_REQUIRED).
const STALE_CHAINS = {
  financialScope: /SMOKE_FAIL: wrong invoice replay scope error: IDEMPOTENCY_ACTOR_MISMATCH/,
  splitJsonb: /PRODUCT_PRICING_GOVERNED_PATH_REQUIRED/,
};
// PR #889's 20261007150050 locks soft-deleted orders, and the order money-lifecycle chain plants a
// line and a delivery on a soft-deleted order as a fixture, so on #889's schema that chain stops at
// ORDER_DELETED_LINES_LOCKED - identically before and after this candidate (#889's problem, not
// this change's). To keep its coverage of these RPCs, it is ALSO run with #889's three
// deleted-order lock triggers disabled inside the chain's own rolled-back transaction.
const PR889_LOCK_TRIGGERS = ['guard_deleted_order_status_locked', 'guard_deleted_order_lines_locked', 'guard_deleted_order_deliveries_locked'];
const LIFECYCLE_PR889_FAILURE = /ORDER_DELETED_LINES_LOCKED/;
function withoutPr889Locks(source) {
  return `BEGIN;
DO $unlock$
DECLARE r record;
BEGIN
  FOR r IN SELECT tgrelid::regclass AS rel, tgname FROM pg_trigger
            WHERE tgname IN (${PR889_LOCK_TRIGGERS.map((t) => `'${t}'`).join(', ')}) AND NOT tgisinternal LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.rel, r.tgname);
  END LOOP;
END
$unlock$;
${source}
ROLLBACK;
`;
}
// md5(replace(prosrc, chr(13), '')) read from live (project rhyzpcqhnizqbxphqdkr) on
// 2026-10-08. Live stores the idem impl's body with CRLF (raw md5 7cbf7aef577c10b16c45070da68edb33)
// and replay stores LF; the others have no carriage returns, so this IS their raw md5.
const LIVE_BODY_MD5 = {
  [CIFO]: 'a1a91643bd8866823ae359f7e0ec290e',
  'public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)': '3d393fb8639dbcb2aa38574ca9679eee',
  'public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)': '454e04c4e199549a4f5be9975e397e17',
  [SPLIT]: '398030fbb64006b4750e7e89a61b6cb9',
  'public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)': 'f671f1a3f5406cff52aedd8a5fb40b31',
  'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)': 'f8de9f000e40f7bfd8f792012f04fee0',
  'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)': 'a1e9a043f27d3566f8ecf6d5e3a809ab',
  'public.is_sales_rep()': 'fcb3133010fe3f4f56e3be31f709d102',
  // The order-invoice customer-lineage guard (INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID).
  'public.guard_invoice_terminal_order()': 'd2ce62f92956ccd651f570a94ce3f1dc',
  // The two helpers whose advisory-lock key ('crx:idempotency:' || key) heldAttempt holds;
  // read from live 2026-10-09 (check_idempotency's raw md5 is 2c93efc82ad63c906eab944e8b70c88e).
  'public.check_idempotency(text,text)': 'cb810b6f78d587b8e0f2869f87ded757',
  'public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)': '0d6fe6c0c9ea71f11ce8cc233665eba2',
};
// PR #889 (unmerged when this was written) must be applied live BEFORE the candidate, and the
// candidate's preflight refuses unless all four of its migrations are in the ledger. Its two
// schema migrations are replayed here - from disk once #889 is on this branch's base, else
// from #889's reviewed head - and all four are then recorded in the container ledger. Its two
// data migrations change only specific live rows (their preflights expect them), so they are
// not replayed; they add no schema. Re-pin PR889_HEAD if #889 changes before it merges.
const PR889_HEAD = '6f05ddbe37f807b1c763d470b1651809dacfc0ff';
const PR889_SCHEMA = ['20261007150000_record_deliveries_billed_outside_crx', '20261007150050_lock_soft_deleted_orders'];
const PR889_DATA = ['20261007150100_mark_spring_2026_deliveries_billed_in_chem_man', '20261007150200_release_reservations_of_deleted_spring_orders'];
const NEW_CIFO_MD5 = '78c3444e301aec889d39dac8dceeb11c';
const NEW_SPLIT_MD5 = 'adf183df988ab9507f845fbccd91a8ee';
// The image's auth.uid() reads only request.jwt.claim.sub. Live's (md5 below, read
// 2026-10-08) falls back to request.jwt.claims ->> 'sub', which the registered chains
// rely on; install live's exact body so they resolve the caller the way production does.
// Spelled with explicit \n so no editor can strip the trailing space live has after `select`.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
// 20260914100700 is live but cannot replay here: it rewrites storage.objects
// policies the stub storage schema cannot host. It must not touch invoices.
const PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);
const SEQUENCES = ['cm_invoice_number_seq', 'cs_invoice_number_seq', 'invoice_number_seq', 'mc_invoice_number_seq'];

const id = (n) => `6f100000-0000-4000-8000-${n.padStart(12, '0')}`;
const ADMIN = id('a1');
const ADMIN2 = id('a2');
const REP_A = id('b1');
const REP_B = id('b2');
const DRIVER = id('d1');
const APPLICATOR = id('e1');
const C_A = id('c1');
const C_B = id('c2');
const C_U = id('c3');
const PRODUCT = id('f1');
const F_MIXED = id('1001');
const F_OWN = id('1002');
const F_B = id('1003');
const F_G1 = id('1004');
const F_G2 = id('1005');
// Orders. O_* are plain, S_* are allocated, R_* are interleaving fixtures (one per run,
// because the admin side of an interleaving commits), D_* carry an in-progress delivery.
const O = {
  A: id('2001'), A_OTHER: id('2002'), B: id('2003'), U: id('2004'),
  S_MIXED: id('2005'), S_OWN: id('2006'), S_B: id('2007'),
  R_C1: id('2008'), R_C2: id('2009'), R_G1: id('200a'), R_G2: id('200b'),
  D_OWN: id('200c'), D_B: id('200d'), D_MIXED: id('200e'), D_DRV: id('200f'), D_MONO: id('2010'),
  // S_FIELD_B: rep A's order whose line is allocated to a field owned by rep B's customer.
  // R_S*: salesman interleavings (cifo); R_SS*: salesman interleavings (split).
  S_FIELD_B: id('2011'), R_S1: id('2012'), R_S2: id('2013'), R_SS1: id('2014'), R_SS2: id('2015'),
  // S_OVR: rep A's order on a field owned by rep B's customer but billed 100% to rep A's
  // customer through field_billing_defaults (allowed). S_T: rep B's customer's order allocated
  // to rep A's own field (refused only by the order-customer leg of the split owner set).
  S_OVR: id('2016'), S_T: id('2017'),
  MISSING: id('2fff'),
};
const F_OVR = id('1006');
const DEL = { D_OWN: id('3001'), D_B: id('3002'), D_MIXED: id('3003'), D_DRV: id('3004'), D_MONO: id('3005') };

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
function applyText(name, sql) {
  stageText(name, sql);
  const r = apply(name, true);
  assert.equal(r.status, 0, `${name} failed to apply:\n${r.output}`);
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }
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
      !/invoice|idempotency_keys|order_items|\borders\b|split_invoice|deliver/i.test(lf(file)),
      `${name} now touches invoices, orders, deliveries or receipts; skipping it would change this proof - replay it or re-think the skip`,
    );
  }
  return before.filter((f) => !PARKED.has(path.basename(f)) && !PR889_DATA.includes(path.basename(f, '.sql')));
}

/** Replay #889's schema migrations (if not already replayed from disk) and record all four in the ledger. */
function replayPr889(replayed) {
  for (const stem of PR889_SCHEMA) {
    if (replayed.some((f) => path.basename(f, '.sql') === stem)) continue;
    const r = spawnSync('git', ['show', `${PR889_HEAD}:supabase/migrations/${stem}.sql`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`PR #889's ${stem} is not on disk and its reviewed head ${PR889_HEAD} is not available here (git fetch origin):\n${r.stderr}`);
    const name = `pr889-${stem}.sql`;
    stageText(name, r.stdout.replaceAll('\r\n', '\n'));
    const a = apply(name, true);
    if (a.status !== 0) throw new Error(`PR #889 replay failed at ${stem}:\n${a.output}`);
  }
  assert.equal(scalar(`SELECT to_regclass('public.delivery_external_billings') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoices'::regclass AND tgname = 'zz_guard_invoice_delivery_billed_outside_crx' AND NOT tgisinternal)
    AND (SELECT count(*) FROM pg_trigger WHERE tgname IN ('guard_deleted_order_status_locked', 'guard_deleted_order_lines_locked', 'guard_deleted_order_deliveries_locked') AND NOT tgisinternal) = 3;`),
  't', 'PR #889\'s schema (external-billing table and invoice guard, deleted-order lock triggers) is not in place');
  psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES
    ${[...PR889_SCHEMA, ...PR889_DATA].map((stem, i) => `('2026100900000${i + 1}', '${stem}', ARRAY[]::text[])`).join(',\n    ')};`);
}

// Same replay repair the other real-schema provers use: live stores this one
// body with CRLF line endings, and a later migration pins that exact body.
function restoreLiveCrLfCloseRemainder() {
  const definingPath = path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql');
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

/** The single `CREATE [OR REPLACE] FUNCTION <head>... $function$;` statement in a file. */
function functionStatement(file, head) {
  const source = lf(file);
  const start = source.indexOf(head);
  assert.ok(start >= 0 && source.indexOf(head, start + 1) < 0, `${path.basename(file)} must define ${head} exactly once`);
  const end = source.indexOf('$function$;', start);
  assert.ok(end > start, `${path.basename(file)} ${head} definition is unterminated`);
  return `${source.slice(start, end + '$function$;'.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION')}\n`;
}
/** Remove exactly one span that starts at `from` and ends after `through`; refuses an ambiguous cut. */
function cut(statement, from, through, label) {
  const start = statement.indexOf(from);
  assert.ok(start >= 0 && statement.indexOf(from, start + 1) < 0, `${label}: the cut start must occur exactly once`);
  const end = statement.indexOf(through, start);
  assert.ok(end > start, `${label}: the cut end was not found after its start`);
  const mutant = statement.slice(0, start) + statement.slice(end + through.length);
  assert.notEqual(mutant, statement, `${label}: the cut removed nothing`);
  return mutant;
}
/** Move exactly one span (`from` .. `through`) to just before the single `beforeAnchor`. */
function move(statement, from, through, beforeAnchor, label) {
  const start = statement.indexOf(from);
  assert.ok(start >= 0 && statement.indexOf(from, start + 1) < 0, `${label}: the moved span must start exactly once`);
  const end = statement.indexOf(through, start);
  assert.ok(end > start, `${label}: the moved span's end was not found after its start`);
  const block = statement.slice(start, end + through.length);
  const rest = statement.slice(0, start) + statement.slice(end + through.length);
  const at = rest.indexOf(beforeAnchor);
  assert.ok(at >= 0 && rest.indexOf(beforeAnchor, at + 1) < 0, `${label}: the anchor must occur exactly once`);
  assert.ok(at > start, `${label}: the span must move LATER in the body`);
  return rest.slice(0, at) + block + rest.slice(at);
}

function lfBodyMd5(signature) {
  return scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${signature}');`);
}
function oid(signature) { return scalar(`SELECT to_regprocedure('${signature}')::oid;`); }
function acl(signature) {
  return scalar(`SELECT array_to_string(ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
    FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid = to_regprocedure('${signature}'))) a
    WHERE a.privilege_type = 'EXECUTE' ORDER BY 1), ',') || '|' || has_function_privilege('anon', to_regprocedure('${signature}'), 'EXECUTE')::text;`);
}
function sequences() {
  return scalar(`SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename)
    FROM pg_sequences WHERE schemaname = 'public' AND sequencename IN (${SEQUENCES.map((s) => `'${s}'`).join(', ')});`);
}
function wrappersUnchanged(cifoMd5, splitMd5, label) {
  assert.equal(lfBodyMd5(CIFO), cifoMd5, `${label}: create_invoice_from_order changed`);
  assert.equal(lfBodyMd5(SPLIT), splitMd5, `${label}: create_split_invoices_from_order changed`);
}

/** md5 of a `CREATE ... AS $function$<body>$function$;` statement's body: what pg_proc.prosrc stores. */
function statementBodyMd5(statement) {
  const open = '$function$';
  const start = statement.indexOf(open);
  const end = statement.lastIndexOf(open);
  assert.ok(start >= 0 && end > start, 'statement has no $function$ body');
  return createHash('md5').update(statement.slice(start + open.length, end), 'utf8').digest('hex');
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
function call(kind, order, salesman, type, key) {
  const s = salesman ? `'${salesman}'::uuid` : 'NULL::uuid';
  const t = type === null ? 'NULL::text' : `'${type}'`;
  return kind === 'cifo'
    ? `public.create_invoice_from_order('${order}'::uuid, ${s}, ${t}, '${key}')`
    : `public.create_split_invoices_from_order('${order}'::uuid, ${s}, ${t}, '${key}')`;
}
/**
 * One call as `uid`, its outcome caught in the same transaction (RESULT|ok or
 * RESULT|<sqlstate>|<message>), then - still inside it, as the owner - the
 * invoices on the order, the key's receipts and the split creation claims.
 * The sequence counters are read before and after (they are not transactional).
 */
function attempt(uid, kind, order, salesman, type, key, { lockTimeout } = {}) {
  const before = sequences();
  const r = probeAs(uid, `${lockTimeout ? `SET LOCAL lock_timeout = '${lockTimeout}';\n` : ''}DO $attempt$
BEGIN
  PERFORM ${call(kind, order, salesman, type, key)};
  RAISE NOTICE 'RESULT|ok';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, SQLERRM;
END
$attempt$;
RESET ROLE;
SELECT 'ROWS|' || (SELECT count(*) FROM public.invoices WHERE order_id = '${order}')
  || '|' || (SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = '${key}')
  || '|' || (SELECT count(*) FROM public.split_invoice_creation_claims WHERE order_id = '${order}')
  || '|' || COALESCE((SELECT string_agg(customer_id::text || ':' || COALESCE(salesman_id::text, 'none') || ':' || created_by::text, ',' ORDER BY customer_id)
                        FROM public.invoices WHERE order_id = '${order}'), '');`);
  assert.ok(r.ok, `attempt probe failed to run:\n${r.error}`);
  const result = /RESULT\|([^\n]*)/.exec(r.error)?.[1];
  assert.ok(result, `attempt probe printed no RESULT:\n${r.error}`);
  const [, invoices, keys, claims, detail] = r.last.split('|');
  return { result, invoices: Number(invoices), keys: Number(keys), claims: Number(claims), detail, seqBefore: before, seqAfter: sequences() };
}
function expectRefused(a, expected, label) {
  assert.match(a.result, expected, `${label}: wrong outcome ${a.result}`);
  assert.equal(a.seqAfter, a.seqBefore, `${label}: the refused call drew an invoice number`);
  // Weak by construction: the call's own writes roll back with the DO block's subtransaction.
  // The ordering evidence is heldAttempt below; this only shows nothing else was left.
  assert.deepEqual([a.invoices, a.keys, a.claims], [0, 0, 0], `${label}: the refused call left an invoice, key or claim`);
}

/**
 * The salesman leg of the cifo post-check on the REPLAY path: rep A creates their own order
 * invoice with key K (no salesman); the invoice's salesman is then changed to rep B (an admin
 * can do this through save_invoice; here the owner sets it directly, inside the same rolled-back
 * transaction); rep A replays K. The pre-check passes (the order names no salesman and neither
 * does the call), so only the post-check can refuse. Returns ok or <sqlstate>|<message>.
 */
function replayAfterSalesmanChange(key) {
  const r = probeAs(REP_A, `SELECT ${call('cifo', O.A, null, 'chemical_sale', key)} AS first \\gset
RESET ROLE;
UPDATE public.invoices SET salesman_id = '${REP_B}' WHERE id = :'first';
SET LOCAL ROLE authenticated;
DO $replay$
BEGIN
  PERFORM ${call('cifo', O.A, null, 'chemical_sale', key)};
  RAISE NOTICE 'REPLAY|ok';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'REPLAY|%|%', SQLSTATE, SQLERRM;
END
$replay$;`);
  assert.ok(r.ok, `the salesman-change replay probe failed to run:\n${r.error}`);
  const result = /REPLAY\|([^\n]*)/.exec(r.error)?.[1];
  assert.ok(result, `the salesman-change replay probe printed no result:\n${r.error}`);
  return result;
}

function runChain(file, name, source = lf(file)) {
  stageText(name, source);
  const r = docker([...psqlArgs(), '-f', `/tmp/${name}`], { allowFailure: true });
  return `${r.stdout}\n${r.stderr}`;
}
function expectChainPass(file, name, source) {
  const output = runChain(file, name, source);
  assert.match(output, /SMOKE_PASS_ROLLBACK/, `${path.basename(file)} did not pass:\n${output}`);
  assert.doesNotMatch(output, /SMOKE_FAIL|SMOKE_SETUP/, `${path.basename(file)} reported a failure:\n${output}`);
  return output;
}
// The split-billing chain accepts the CHECK refusal (with a number drawn) ONLY for the exact
// pre-candidate split wrapper body, and says so with this note; any other body is strict.
const SPLIT_PRE_GATE_NOTE = /SMOKE_NOTE: the split wrapper predates 20261008120000/;
function expectChainFail(file, name, failure, label) {
  const output = runChain(file, name);
  assert.doesNotMatch(output, /SMOKE_PASS_ROLLBACK/, `${label}: ${path.basename(file)} PASSED, so it does not detect this:\n${output}`);
  assert.match(output, failure, `${label}: ${path.basename(file)} failed for a different reason:\n${output}`);
}
function firstError(output) { return /ERROR:\s+([^\n]*)/.exec(output)?.[1] ?? '(no error)'; }

function orderSql(orderId, customer, salesman, number) {
  return `INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw, salesman_id)
    VALUES ('${orderId}', 'PROVER-REP-SCOPE-${number}', '${customer}', (now() AT TIME ZONE 'America/Chicago')::date, 'confirmed', false, ${salesman ? `'${salesman}'` : 'NULL'});
  INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
    VALUES ('${orderId.slice(0, -4)}9${orderId.slice(-3)}', '${orderId}', '${PRODUCT}', '[PROVER] rep scope line ${number}', 10, 6, 10, 100, 40, 40, 0, 10, 'GL');`;
}
function itemOf(orderId) { return `${orderId.slice(0, -4)}9${orderId.slice(-3)}`; }
function allocateSql(orderId, fieldId) {
  return `INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres) VALUES ('${itemOf(orderId)}', '${fieldId}', 10);`;
}
function deliverySql(deliveryId, orderId, customer, driver, number) {
  return `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, created_by)
    VALUES ('${deliveryId}', 'PROVER-REP-SCOPE-DEL-${number}', '${orderId}', '${customer}', ${driver ? `'${driver}'` : 'NULL'}, (now() AT TIME ZONE 'America/Chicago')::date, 'scheduled', '${ADMIN}');
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES ('${deliveryId}', '${itemOf(orderId)}', '${PRODUCT}', 10, 0, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${deliveryId}';`;
}

function seed() {
  const users = [
    [ADMIN, 'admin', 'Admin', 6], [ADMIN2, 'admin', 'Admin Two', 5], [REP_A, 'sales_rep', 'Rep A', 4],
    [REP_B, 'sales_rep', 'Rep B', 3], [DRIVER, 'driver', 'Driver', 2], [APPLICATOR, 'applicator', 'Applicator', 1],
  ];
  psql(`
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'rep-scope-prover-${role}-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')}
    ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id, email, full_name, role, is_active) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'rep-scope-prover-${role}-${u.slice(-2)}@example.invalid', '[PROVER] ${label}', '${role}', true)`).join(',\n      ')}
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, role = EXCLUDED.role, is_active = EXCLUDED.is_active;
    -- The chains pick "the first" admin and sales rep by created_at: make that order explicit.
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    INSERT INTO public.customers (id, farm_name, assigned_sales_rep, is_active) VALUES
      ('${C_A}', '[PROVER] Rep A Farm', '${REP_A}', true),
      ('${C_B}', '[PROVER] Rep B Farm', '${REP_B}', true),
      ('${C_U}', '[PROVER] Unassigned Farm', NULL, true);
    -- Order lines need a priced product (COST_BASIS_REQUIRED), and prices may only be
    -- written through the governed pricing path. This schema-only container has no
    -- catalog, so seed one priced product with that trigger briefly disabled (the
    -- prove-order-invoice-type-gate-real-schema.mjs seeding) for the prover's own
    -- fixtures; the chains price their own products. Never touches live.
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price)
    VALUES ('${PRODUCT}', '[PROVER] Rep Scope Product', 'GL', 6.00, 10.00);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
    VALUES ('${PRODUCT}', 'Main Warehouse', 500, 0, 'GL');
    INSERT INTO public.fields (id, customer_id, field_name, crop_type, total_acres) VALUES
      ('${F_MIXED}', '${C_A}', '[PROVER] Mixed Field', 'corn', 100),
      ('${F_OWN}', '${C_A}', '[PROVER] Rep A Field', 'corn', 100),
      ('${F_B}', '${C_B}', '[PROVER] Rep B Field', 'corn', 100),
      ('${F_G1}', '${C_A}', '[PROVER] Race Field 1', 'corn', 100),
      ('${F_G2}', '${C_A}', '[PROVER] Race Field 2', 'corn', 100),
      ('${F_OVR}', '${C_B}', '[PROVER] Rep B Field Billed To Rep A', 'corn', 100);
  `);
  psql(`BEGIN;
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES
      ('${F_MIXED}', '${C_A}', 50, true), ('${F_MIXED}', '${C_B}', 50, false),
      ('${F_OVR}', '${C_A}', 100, true);
    COMMIT;`);
  psql(`
    ${orderSql(O.A, C_A, null, 'A')}
    ${orderSql(O.A_OTHER, C_A, REP_B, 'A-OTHER')}
    ${orderSql(O.B, C_B, null, 'B')}
    ${orderSql(O.U, C_U, null, 'U')}
    ${orderSql(O.S_MIXED, C_A, null, 'S-MIXED')} ${allocateSql(O.S_MIXED, F_MIXED)}
    ${orderSql(O.S_OWN, C_A, null, 'S-OWN')} ${allocateSql(O.S_OWN, F_OWN)}
    ${orderSql(O.S_B, C_B, null, 'S-B')} ${allocateSql(O.S_B, F_B)}
    ${orderSql(O.R_C1, C_A, null, 'R-C1')}
    ${orderSql(O.R_C2, C_A, null, 'R-C2')}
    ${orderSql(O.R_G1, C_A, null, 'R-G1')} ${allocateSql(O.R_G1, F_G1)}
    ${orderSql(O.R_G2, C_A, null, 'R-G2')} ${allocateSql(O.R_G2, F_G2)}
    ${orderSql(O.D_OWN, C_A, null, 'D-OWN')} ${allocateSql(O.D_OWN, F_OWN)} ${deliverySql(DEL.D_OWN, O.D_OWN, C_A, null, 'OWN')}
    ${orderSql(O.D_B, C_B, null, 'D-B')} ${allocateSql(O.D_B, F_B)} ${deliverySql(DEL.D_B, O.D_B, C_B, null, 'B')}
    ${orderSql(O.D_MIXED, C_A, null, 'D-MIXED')} ${allocateSql(O.D_MIXED, F_MIXED)} ${deliverySql(DEL.D_MIXED, O.D_MIXED, C_A, null, 'MIXED')}
    ${orderSql(O.D_DRV, C_A, null, 'D-DRV')} ${allocateSql(O.D_DRV, F_OWN)} ${deliverySql(DEL.D_DRV, O.D_DRV, C_A, DRIVER, 'DRV')}
    ${orderSql(O.D_MONO, C_B, null, 'D-MONO')} ${deliverySql(DEL.D_MONO, O.D_MONO, C_B, null, 'MONO')}
    ${orderSql(O.S_FIELD_B, C_A, null, 'S-FIELD-B')} ${allocateSql(O.S_FIELD_B, F_B)}
    ${orderSql(O.R_S1, C_A, null, 'R-S1')}
    ${orderSql(O.R_S2, C_A, null, 'R-S2')}
    ${orderSql(O.R_SS1, C_A, null, 'R-SS1')} ${allocateSql(O.R_SS1, F_OWN)}
    ${orderSql(O.R_SS2, C_A, null, 'R-SS2')} ${allocateSql(O.R_SS2, F_OWN)}
    ${orderSql(O.S_OVR, C_A, null, 'S-OVR')} ${allocateSql(O.S_OVR, F_OVR)}
    ${orderSql(O.S_T, C_B, null, 'S-T')} ${allocateSql(O.S_T, F_OWN)}
  `);
}

/**
 * Complete one delivery as `uid` in a rolled-back transaction and report what it left:
 * delivery status, the order's split flag, fallback activity and notification rows, and
 * every invoice on the order (customer:salesman:creator), plus the sequence counters.
 */
function completeAs(uid, deliveryId, orderId, key, { directSplit = false } = {}) {
  const before = sequences();
  // complete_delivery's fallback records no error text, so (when asked) repeat the exact
  // auto-split call it makes - same caller, order, NULL salesman, type and ':autosplit' key -
  // in the same transaction, and report why it is refused.
  const direct = directSplit ? `DO $direct$
BEGIN
  PERFORM public.create_split_invoices_from_order('${orderId}'::uuid, NULL, 'chemical_sale', '${key}:autosplit');
  RAISE NOTICE 'DIRECT|ok';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'DIRECT|%|%', SQLSTATE, SQLERRM;
END
$direct$;
` : '';
  const r = probeAs(uid, `SELECT public.complete_delivery('${deliveryId}'::uuid, '[PROVER] Receiver', '${uid}'::uuid, NULL, NULL, NULL, '${key}', NULL) IS NOT NULL;
${direct}RESET ROLE;
SELECT 'FACTS|' || (SELECT status FROM public.deliveries WHERE id = '${deliveryId}')
  || '|' || COALESCE((SELECT needs_split_billing FROM public.orders WHERE id = '${orderId}')::text, 'null')
  || '|' || (SELECT count(*) FROM public.activity_feed WHERE related_entity_id = '${orderId}' AND event_type = 'order_needs_split_billing')
  || '|' || (SELECT count(*) FROM public.notifications WHERE related_entity_id = '${orderId}' AND notification_type = 'split_billing')
  || '|' || COALESCE((SELECT string_agg(customer_id::text || ':' || COALESCE(salesman_id::text, 'none') || ':' || created_by::text, ',' ORDER BY customer_id)
                        FROM public.invoices WHERE order_id = '${orderId}'), '');`);
  assert.ok(r.ok, `complete_delivery as ${uid} on ${deliveryId} failed - a delivery must always complete:\n${r.error}`);
  const [, status, flagged, activity, notifications, invoices] = r.last.split('|');
  const directResult = directSplit ? /DIRECT\|([^\n]*)/.exec(r.error)?.[1] : undefined;
  if (directSplit) assert.ok(directResult, `the direct auto-split repeat printed no result:\n${r.error}`);
  return { status, flagged, activity: Number(activity), notifications: Number(notifications), invoices, drew: sequences() !== before, direct: directResult };
}
function activeAdmins() {
  return Number(scalar("SELECT count(*) FROM public.profiles WHERE role = 'admin' AND is_active = true;"));
}
function expectFallback(f, label, { drew = false } = {}) {
  const admins = activeAdmins();
  assert.ok(admins >= 2, `${label}: expected at least the two seeded active admins, found ${admins}`);
  assert.equal(f.status, 'completed', `${label}: the delivery did not complete`);
  assert.equal(f.flagged, 'true', `${label}: the order was not flagged needs_split_billing`);
  assert.equal(f.activity, 1, `${label}: expected one order_needs_split_billing activity row`);
  assert.equal(f.notifications, admins, `${label}: expected one split_billing notification per active admin (${admins})`);
  assert.equal(f.invoices, '', `${label}: the fallback left an invoice: ${f.invoices}`);
  assert.equal(f.drew, drew, `${label}: ${drew ? 'expected the pre-fix refusal to draw an invoice number' : 'the refused auto-split drew an invoice number'}`);
}
function deliveries(phase) {
  const fixed = phase === 'after';
  // (a) An admin completes the last delivery of an allocated order: split drafts auto-created.
  const a = completeAs(ADMIN, DEL.D_OWN, O.D_OWN, `prover-del-a-${phase}`);
  assert.equal(a.status, 'completed', `${phase} (a): the admin's delivery did not complete`);
  assert.equal(a.invoices, `${C_A}:none:${ADMIN}`, `${phase} (a): the admin's auto-split did not draft the owner's invoice`);
  // (a') The mixed-owner order falls back even for an admin, before and after: the existing
  // lineage guard refuses an order invoice for a customer other than the order's.
  const aMixed = completeAs(ADMIN, DEL.D_MIXED, O.D_MIXED, `prover-del-a-mixed-${phase}`);
  assert.equal(aMixed.status, 'completed');
  assert.equal(aMixed.flagged, 'true', `${phase} (a'): expected the pre-existing mixed-owner fallback`);
  assert.equal(aMixed.invoices, '', `${phase} (a'): the mixed-owner auto-split billed someone`);
  // (b) Rep A completes the last delivery of rep B's allocated order.
  const b = completeAs(REP_A, DEL.D_B, O.D_B, `prover-del-b-${phase}`, { directSplit: fixed });
  if (fixed) {
    expectFallback(b, 'after (b) rep A on rep B\'s order');
    assert.equal(b.direct, 'P0001|CUSTOMER_SCOPE_DENIED', `after (b): the auto-split fell back for the wrong reason: ${b.direct}`);
  } else {
    assert.equal(b.status, 'completed');
    assert.equal(b.invoices, `${C_B}:none:${REP_A}`, `before (b): the bug did not reproduce - rep A's completion should have auto-billed rep B's customer: ${b.invoices}`);
  }
  // (b') Rep A completes the mixed-owner order: fallback both times; before, the refused
  // split had already drawn a number; after, it is refused before any number.
  const bMixed = completeAs(REP_A, DEL.D_MIXED, O.D_MIXED, `prover-del-b-mixed-${phase}`, { directSplit: fixed });
  expectFallback(bMixed, `${phase} (b') rep A on the mixed-owner order`, { drew: !fixed });
  if (fixed) assert.equal(bMixed.direct, 'P0001|CUSTOMER_SCOPE_DENIED', `after (b'): the auto-split fell back for the wrong reason: ${bMixed.direct}`);
  // (c) Rep A completes their own allocated order: auto-split succeeds, salesman NULL.
  const c = completeAs(REP_A, DEL.D_OWN, O.D_OWN, `prover-del-c-${phase}`);
  assert.equal(c.status, 'completed');
  assert.equal(c.invoices, `${C_A}:none:${REP_A}`, `${phase} (c): rep A's own auto-split did not draft their customer's invoice: ${c.invoices}`);
  // (d) The assigned driver: already refused by the split role gate, so the same fallback,
  // with no number drawn, before and after.
  const d = completeAs(DRIVER, DEL.D_DRV, O.D_DRV, `prover-del-d-${phase}`, { directSplit: fixed });
  expectFallback(d, `${phase} (d) assigned driver`);
  if (fixed) assert.match(d.direct, /^P0001\|Not authorized: admin or sales role required/, `after (d): the driver's auto-split fell back for the wrong reason: ${d.direct}`);
  // (e) Rep A completes a NON-allocated delivery of rep B's customer: the mono auto-invoice is
  // created directly by complete_delivery, outside both wrappers - a known, separately
  // tracked gap (KNOWN_ISSUES), documented here so this change does not claim it.
  const e = completeAs(REP_A, DEL.D_MONO, O.D_MONO, `prover-del-e-${phase}`);
  assert.equal(e.status, 'completed');
  assert.equal(e.invoices, `${C_B}:none:${REP_A}`, `${phase} (e): the mono auto-invoice changed: ${e.invoices}`);
}

/** Start a psql session whose stdin stays open; resolves `done` with its exit code. */
function session(appName, user = 'postgres') {
  const child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${appName}`, NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { cwd: ROOT });
  const s = { child, out: '', err: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { s.out += d; });
  child.stderr.on('data', (d) => { s.err += d; });
  s.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return s;
}
async function until(check, label, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}
/**
 * The two-session interleaving: an admin session locks the order FOR UPDATE and makes
 * `adminChanges` without committing; rep A's call (in its own transaction, always rolled
 * back) runs its unlocked pre-check against the committed rows and then blocks on the
 * order lock - observed through pg_stat_activity/pg_blocking_pids, not a sleep; the admin
 * commits; the rep resumes against the changed rows. Returns the rep's outcome.
 */
async function interleave(orderId, adminChanges, repIdsExpr, label) {
  const tag = `${label}`.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const admin = session(`crx_scope_admin_${tag}`);
  admin.child.stdin.write(`BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
SELECT 'ADMIN_PID=' || pg_backend_pid();
SELECT 1 FROM public.orders WHERE id = '${orderId}' FOR UPDATE;
${adminChanges}
\\echo ADMIN_HOLDING
`);
  await until(() => admin.out.includes('ADMIN_HOLDING') || admin.err.includes('ERROR'), `${label}: admin session holding the order lock`);
  assert.doesNotMatch(admin.err, /ERROR/, `${label}: the admin session failed:\n${admin.err}`);
  const adminPid = /ADMIN_PID=(\d+)/.exec(admin.out)?.[1];
  assert.ok(adminPid, `${label}: no admin backend pid`);

  const repApp = `crx_scope_rep_${tag}`;
  const rep = session(repApp);
  rep.child.stdin.end(`BEGIN;
${asUser(REP_A)}
SELECT ${repIdsExpr} AS ids \\gset
RESET ROLE;
SELECT 'RACE_RESULT|' || COALESCE((SELECT string_agg(i.customer_id::text || ':' || COALESCE(i.salesman_id::text, 'none'), ',' ORDER BY i.customer_id) FROM public.invoices i
  WHERE i.id::text = ANY (string_to_array(:'ids', ','))), 'none');
ROLLBACK;
`);
  await until(() => scalar(`SELECT count(*) FROM pg_stat_activity
      WHERE application_name = '${repApp}' AND wait_event_type = 'Lock'
        AND ${adminPid} = ANY (pg_blocking_pids(pid));`) === '1' || rep.err.includes('ERROR'),
    `${label}: rep A blocked behind the admin's order lock`);
  assert.doesNotMatch(rep.err, /ERROR/, `${label}: rep A's call ended before it reached the order lock (the pre-check must pass on the committed rows):\n${rep.err}`);
  admin.child.stdin.end('COMMIT;\n\\echo ADMIN_COMMITTED\n');
  assert.equal(await admin.done, 0, `${label}: the admin session failed to commit:\n${admin.err}`);
  const code = await rep.done;
  return { ok: code === 0, result: /RACE_RESULT\|([^\n]*)/.exec(rep.out)?.[1] ?? '', error: rep.err.trim() };
}

/**
 * The ordering proof for a refusal. A second session holds the order row FOR UPDATE and the
 * idempotency advisory lock every claim of this key takes (_claim_bound_lifecycle_idempotency:
 * pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || key, 0))), while the caller runs
 * with a short lock_timeout. A refusal that comes before the claim and the order lock returns
 * its own error; one placed after either of them waits and ends in 55P03 (lock timeout).
 * `hold` = 'claim' or 'order' holds only that one lock, so an ordering mutation can be shown to
 * be caught by the order lock on its own (the claim comes first, so holding both would always
 * stop a late check at the claim).
 */
async function heldAttempt(uid, kind, order, salesman, type, key, label, { hold = 'both' } = {}) {
  assert.ok(['both', 'claim', 'order'].includes(hold), `heldAttempt: unknown hold ${hold}`);
  const tag = `${label}`.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const holder = session(`crx_scope_hold_${tag}`);
  holder.child.stdin.write(`BEGIN;
${hold !== 'claim' ? `SELECT 1 FROM public.orders WHERE id = '${order}' FOR UPDATE;` : ''}
${hold !== 'order' ? `SELECT pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || '${key}', 0));` : ''}
\\echo HOLDING
`);
  try {
    await until(() => holder.out.includes('HOLDING') || holder.err.includes('ERROR'), `${label}: holder session`);
    assert.doesNotMatch(holder.err, /ERROR/, `${label}: the holder session failed:\n${holder.err}`);
    return attempt(uid, kind, order, salesman, type, key, { lockTimeout: '3s' });
  } finally {
    holder.child.stdin.end('ROLLBACK;\n');
    await holder.done;
  }
}
const LOCK_TIMEOUT = /^55P03\|/;

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
  replayPr889(migrations);
  console.log(`[prover] PR #889: schema migrations ${PR889_SCHEMA.join(', ')} replayed and all four #889 migrations recorded in the ledger (the candidate's apply-order preflight requires them)`);
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;`), LIVE_AUTH_UID_MD5, 'auth.uid() is not live\'s body');

  // 0. FIDELITY.
  for (const [signature, md5] of Object.entries(LIVE_BODY_MD5)) {
    assert.equal(lfBodyMd5(signature), md5, `${signature} replayed with a body that differs from live; this proof would not test production's code`);
  }
  const oids = { cifo: oid(CIFO), split: oid(SPLIT) };
  for (const signature of [CIFO, SPLIT]) {
    assert.equal(acl(signature), 'authenticated,postgres,service_role|false', `unexpected ${signature} ACL before the candidate`);
  }
  console.log('[prover] FIDELITY: the order-path bodies (wrappers, implementations, complete_delivery, is_sales_rep, lineage guard) and auth.uid() match the live md5 pins of 2026-10-08');

  seed();

  // 1. BEFORE: the bug.
  const otherCustomer = attempt(REP_A, 'cifo', O.B, null, 'chemical_sale', 'prover-before-1');
  assert.equal(otherCustomer.result, 'ok', `before: rep A could not invoice rep B's customer, so the bug did not reproduce: ${otherCustomer.result}`);
  assert.equal(otherCustomer.detail, `${C_B}:none:${REP_A}`);
  // The read leak, with a negative control in the same session: an invoice rep A made with no
  // salesman must stay invisible to rep B, so a failed claim switch or an RLS bypass cannot
  // pass for the leak.
  const leak = probeAs(REP_A, `SELECT ${call('cifo', O.A, REP_B, 'chemical_sale', 'prover-before-leak')} AS invoice_id \\gset
SELECT ${call('cifo', O.U, null, 'chemical_sale', 'prover-before-leak-control')} AS control_id \\gset
SELECT set_config('request.jwt.claims', '{"sub":"${REP_B}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${REP_B}', true);
SELECT 'VISIBLE_TO_B|' || (SELECT count(*) FROM public.invoices WHERE id = :'invoice_id')
  || '|' || (SELECT count(*) FROM public.invoices WHERE id = :'control_id');`);
  assert.ok(leak.ok, `before: rep A could not name rep B as salesman:\n${leak.error}`);
  assert.equal(leak.last, 'VISIBLE_TO_B|1|0', `before: expected rep B to read the invoice recorded under their name (1) and not the control invoice (0): ${leak.last}`);
  // The misc_charge split outcome before the candidate (the allow path the new gate must keep).
  const miscBefore = attempt(ADMIN, 'split', O.S_OWN, ADMIN, 'misc_charge', 'prover-before-misc');
  const burn = attempt(ADMIN, 'split', O.S_OWN, ADMIN, 'field_application', 'prover-before-burn');
  assert.match(burn.result, /^23514\|new row for relation "invoices" violates check constraint "invoices_field_application_has_no_order"/, `before: unexpected field_application split outcome: ${burn.result}`);
  assert.notEqual(burn.seqAfter, burn.seqBefore, 'before: the refused field_application split did not draw an invoice number, so the burn did not reproduce');
  const repSplit = attempt(REP_A, 'split', O.S_B, REP_A, 'chemical_sale', 'prover-before-split');
  assert.equal(repSplit.result, 'ok', `before: rep A could not split rep B's allocated order: ${repSplit.result}`);
  assert.equal(repSplit.detail, `${C_B}:${REP_A}:${REP_A}`);
  const mixedAdmin = attempt(ADMIN, 'split', O.S_MIXED, ADMIN, 'chemical_sale', 'prover-before-mixed');
  assert.match(mixedAdmin.result, /^P0001\|INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID/, `before: the mixed-owner split's pre-existing lineage refusal changed: ${mixedAdmin.result}`);
  deliveries('before');
  expectChainFail(CHAINS.repScope, 'rep-scope-before.sql', /SMOKE_FAIL: step 1: a sales rep created an order invoice the scope rule forbids/, 'BEFORE');
  // The split-billing chain is kept runnable against live before the apply: for the exact
  // pre-candidate wrapper it accepts the known CHECK refusal (number drawn) and says so. Its
  // fail-first on a gate-less wrapper is MUTATION (e) below; the burn itself is proven above.
  assert.match(expectChainPass(CHAINS.split, 'split-before.sql'), SPLIT_PRE_GATE_NOTE, 'BEFORE: the split chain did not take its pre-candidate branch');
  const staleBefore = {};
  for (const [key, failure] of Object.entries(STALE_CHAINS)) {
    const output = runChain(CHAINS[key], `${key}-before.sql`);
    assert.doesNotMatch(output, /SMOKE_PASS_ROLLBACK/, `${key} now passes on main; move it to the passing CHAINS`);
    assert.match(output, failure, `${key} fails on main for a reason this prover does not know:\n${output}`);
    staleBefore[key] = firstError(output);
  }
  const lifecycleBeforeOutput = runChain(CHAINS.lifecycle, 'lifecycle-before.sql');
  assert.doesNotMatch(lifecycleBeforeOutput, /SMOKE_PASS_ROLLBACK/, 'the lifecycle chain now passes on #889\'s schema; drop the #889 lock carve-out');
  assert.match(lifecycleBeforeOutput, LIFECYCLE_PR889_FAILURE, `the lifecycle chain fails on #889's schema for a reason this prover does not know:\n${lifecycleBeforeOutput}`);
  // The chain's order numbers carry a random suffix; compare the error with it masked.
  const maskSuffix = (error) => error.replace(/E2E-LIFE-DELETED-[0-9a-f]+/g, 'E2E-LIFE-DELETED-<suffix>');
  const lifecycleBefore = maskSuffix(firstError(lifecycleBeforeOutput));
  expectChainPass(CHAINS.lifecycle, 'lifecycle-before-unlocked.sql', withoutPr889Locks(lf(CHAINS.lifecycle)));
  console.log('[prover] BEFORE: rep A invoiced rep B\'s customer, recorded rep B as salesman (rep B can then read it), split rep B\'s allocated order and auto-billed rep B\'s customer by completing a delivery; an admin field_application split was refused but drew a number; the new chain fails at step 1; the split chain passes on its pre-candidate branch (SMOKE_NOTE) so it stays runnable against live before the apply');

  // 2a. AUTOCOMMIT.
  stageText('candidate.sql', lf(CANDIDATE));
  const looseRun = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  const loose = `${looseRun.stdout}\n${looseRun.stderr}`;
  assert.notEqual(looseRun.status, 0, 'the candidate applied without a transaction');
  assert.match(loose, /CRX_REP_SCOPE_NOT_IN_TRANSACTION/, `wrong autocommit refusal:\n${loose}`);
  wrappersUnchanged(LIVE_BODY_MD5[CIFO], LIVE_BODY_MD5[SPLIT], 'AUTOCOMMIT');
  console.log('[prover] AUTOCOMMIT: applied outside one transaction by a client that stops on the first error, the file stops before changing anything');

  // 2b. PREFLIGHT: a split wrapper that drifted by one comment blocks the apply.
  const liveSplit = functionStatement(path.join(MIGRATIONS, '20260719060256_allow_governed_split_terminal_lifecycle.sql'), 'CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(');
  const drifted = liveSplit.replace('\nBEGIN\n  IF v_actor IS NULL THEN', '\nBEGIN\n  -- prover drift\n  IF v_actor IS NULL THEN');
  assert.notEqual(drifted, liveSplit);
  stageText('drifted-split.sql', drifted);
  const blocked = docker([...psqlArgs()], { input: 'BEGIN;\n\\i /tmp/drifted-split.sql\n\\i /tmp/candidate.sql\nCOMMIT;\n', allowFailure: true });
  assert.notEqual(blocked.status, 0, 'the candidate applied over a drifted split wrapper');
  assert.match(`${blocked.stdout}\n${blocked.stderr}`, /PREFLIGHT_SPLIT_INVOICE_WRAPPER_DRIFT/, `wrong preflight refusal:\n${blocked.stderr}`);
  wrappersUnchanged(LIVE_BODY_MD5[CIFO], LIVE_BODY_MD5[SPLIT], 'PREFLIGHT');
  // 2c. Every other pin group refuses on its own drift, inside one transaction that rolls back.
  const commentDrift = (signature) => `DO $drift$
BEGIN
  EXECUTE regexp_replace(pg_get_functiondef('${signature}'::regprocedure), '[$]function[$]\\s*$', '-- prover drift' || chr(10) || '$function$');
END
$drift$;`;
  const pinDrifts = [
    ['idem impl body', commentDrift('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)'), 'PREFLIGHT_ORDER_INVOICE_DELEGATE_DRIFT'],
    ['impl0718 body', commentDrift('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'), 'PREFLIGHT_ORDER_INVOICE_DELEGATE_DRIFT'],
    ['idem impl ACL', 'GRANT EXECUTE ON FUNCTION public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text) TO authenticated;', 'PREFLIGHT_ORDER_INVOICE_DELEGATE_DRIFT'],
    ['split provenance impl body', commentDrift('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)'), 'PREFLIGHT_SPLIT_INVOICE_DELEGATE_DRIFT'],
    ['is_sales_rep body', commentDrift('public.is_sales_rep()'), 'PREFLIGHT_ROLE_HELPER_DRIFT'],
    ['is_sales_rep SECURITY INVOKER', 'ALTER FUNCTION public.is_sales_rep() SECURITY INVOKER;', 'PREFLIGHT_ROLE_HELPER_DRIFT'],
    ['complete_delivery impl body', commentDrift('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'), 'PREFLIGHT_COMPLETE_DELIVERY_DRIFT'],
    ['cifo wrapper granted to anon', `GRANT EXECUTE ON FUNCTION ${CIFO} TO anon;`, 'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT'],
    ['split wrapper revoked from service_role', `REVOKE EXECUTE ON FUNCTION ${SPLIT} FROM service_role;`, 'PREFLIGHT_SPLIT_INVOICE_WRAPPER_DRIFT'],
    ['scope column renamed', 'ALTER TABLE public.field_billing_defaults RENAME COLUMN customer_id TO customer_id_prover_drift;', 'PREFLIGHT_SCOPE_COLUMNS_MISSING'],
    ['invoice scope column renamed', 'ALTER TABLE public.invoices RENAME COLUMN salesman_id TO salesman_id_prover_drift;', 'PREFLIGHT_SCOPE_COLUMNS_MISSING'],
    ['PR #889 data migration missing from the ledger', `DELETE FROM supabase_migrations.schema_migrations WHERE name = '${PR889_DATA[1]}';`, 'PREFLIGHT_PR889_NOT_APPLIED'],
    ['PR #889 schema migration missing from the ledger', `DELETE FROM supabase_migrations.schema_migrations WHERE name = '${PR889_SCHEMA[0]}';`, 'PREFLIGHT_PR889_NOT_APPLIED'],
    ['is_sales_rep search_path', 'ALTER FUNCTION public.is_sales_rep() SET search_path = public;', 'PREFLIGHT_ROLE_HELPER_DRIFT'],
    ['is_sales_rep VOLATILE', 'ALTER FUNCTION public.is_sales_rep() VOLATILE;', 'PREFLIGHT_ROLE_HELPER_DRIFT'],
    ['is_sales_rep owner', 'ALTER FUNCTION public.is_sales_rep() OWNER TO supabase_admin;', 'PREFLIGHT_ROLE_HELPER_DRIFT', 'supabase_admin'],
    ['complete_delivery wrapper body', commentDrift('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'), 'PREFLIGHT_COMPLETE_DELIVERY_DRIFT'],
    ['cifo second overload', "CREATE FUNCTION public.create_invoice_from_order(uuid, uuid, text) RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';", 'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT'],
    ['split second overload', "CREATE FUNCTION public.create_split_invoices_from_order(uuid) RETURNS uuid[] LANGUAGE sql AS 'SELECT NULL::uuid[]';", 'PREFLIGHT_SPLIT_INVOICE_WRAPPER_DRIFT'],
    ['cifo STRICT', `ALTER FUNCTION ${CIFO} STRICT;`, 'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT'],
    ['cifo search_path', `ALTER FUNCTION ${CIFO} SET search_path = public;`, 'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT'],
    ['cifo owner', `ALTER FUNCTION ${CIFO} OWNER TO supabase_admin;`, 'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT', 'supabase_admin'],
    ['split STABLE', `ALTER FUNCTION ${SPLIT} STABLE;`, 'PREFLIGHT_SPLIT_INVOICE_WRAPPER_DRIFT'],
    ['split SECURITY INVOKER', `ALTER FUNCTION ${SPLIT} SECURITY INVOKER;`, 'PREFLIGHT_SPLIT_INVOICE_WRAPPER_DRIFT'],
    ['impl0718 ACL', 'GRANT EXECUTE ON FUNCTION public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text) TO authenticated;', 'PREFLIGHT_ORDER_INVOICE_DELEGATE_DRIFT'],
    ['split provenance impl ACL', 'GRANT EXECUTE ON FUNCTION public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text) TO authenticated;', 'PREFLIGHT_SPLIT_INVOICE_DELEGATE_DRIFT'],
  ];
  for (const [label, driftSql, code, user] of pinDrifts) {
    const r = docker([...psqlArgs(user)], { input: `BEGIN;\n${driftSql}\n\\i /tmp/candidate.sql\nCOMMIT;\n`, allowFailure: true });
    const out = `${r.stdout}\n${r.stderr}`;
    assert.notEqual(r.status, 0, `PREFLIGHT (${label}): the candidate applied over the drift`);
    assert.match(out, new RegExp(code), `PREFLIGHT (${label}): wrong refusal, expected ${code}:\n${out}`);
    wrappersUnchanged(LIVE_BODY_MD5[CIFO], LIVE_BODY_MD5[SPLIT], `PREFLIGHT (${label})`);
  }
  for (const [signature, md5] of Object.entries(LIVE_BODY_MD5)) {
    assert.equal(lfBodyMd5(signature), md5, `PREFLIGHT: a rolled-back drift left ${signature} changed`);
  }
  console.log(`[prover] PREFLIGHT: a split wrapper drifted by one comment blocks the apply, and so does each of ${pinDrifts.length} other pin drifts (delegate, provenance, role-helper and both complete_delivery bodies; delegate and wrapper ACLs; wrapper overloads, owner, strictness, volatility, security mode and search_path; is_sales_rep security mode, volatility, owner and search_path; two scope columns; PR #889 missing from the ledger), each with its own code; nothing changed`);

  // 2d. POSTFLIGHT: the postflight refuses (and rolls the whole apply back) when the applied
  // bodies are not the reviewed ones, and when the split type gate sits after the claim even
  // with a matching md5 pin.
  const candidateText = lf(CANDIDATE);
  const reviewedCifoStatement = functionStatement(CANDIDATE, 'CREATE OR REPLACE FUNCTION public.create_invoice_from_order(');
  const reviewedSplitStatement = functionStatement(CANDIDATE, 'CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(');
  assert.equal(statementBodyMd5(reviewedCifoStatement), NEW_CIFO_MD5, 'NEW_CIFO_MD5 is not the md5 of the candidate cifo body');
  assert.equal(statementBodyMd5(reviewedSplitStatement), NEW_SPLIT_MD5, 'NEW_SPLIT_MD5 is not the md5 of the candidate split body');
  const lateGateSplit = move(reviewedSplitStatement, '  -- CRX-LIFE-001 type allow-list, before any claim, lock or insert', '      USING ERRCODE = \'check_violation\';\n  END IF;\n\n', '  PERFORM 1\n    FROM public.orders o\n   WHERE o.id = p_order_id\n   FOR UPDATE;', 'postflight late gate');
  const postflightMutants = [
    ['cifo pin', candidateText.replace(`= '${NEW_CIFO_MD5}'`, `= '${'0'.repeat(32)}'`), /POSTFLIGHT_ORDER_INVOICE_WRAPPER_CONTRACT: public create_invoice_from_order body/],
    ['split pin', candidateText.replace(`= '${NEW_SPLIT_MD5}'`, `= '${'0'.repeat(32)}'`), /POSTFLIGHT_SPLIT_INVOICE_WRAPPER_CONTRACT: public create_split_invoices_from_order body/],
    ['split type gate after the claim', candidateText.replace(reviewedSplitStatement.trimEnd(), lateGateSplit.trimEnd()).replace(`= '${NEW_SPLIT_MD5}'`, `= '${statementBodyMd5(lateGateSplit)}'`),
      /POSTFLIGHT_SPLIT_INVOICE_WRAPPER_CONTRACT: the split wrapper must refuse a disallowed type before its idempotency claim/],
  ];
  for (const [label, text, code] of postflightMutants) {
    assert.notEqual(text, candidateText, `POSTFLIGHT (${label}): the mutant is the candidate`);
    stageText('postflight-mutant.sql', text);
    const r = apply('postflight-mutant.sql', true);
    assert.notEqual(r.status, 0, `POSTFLIGHT (${label}): the mutant applied`);
    assert.match(r.output, code, `POSTFLIGHT (${label}): wrong refusal:\n${r.output}`);
    assert.doesNotMatch(r.output, /POSTFLIGHT_OK/, `POSTFLIGHT (${label}): printed POSTFLIGHT_OK`);
    wrappersUnchanged(LIVE_BODY_MD5[CIFO], LIVE_BODY_MD5[SPLIT], `POSTFLIGHT (${label})`);
  }
  console.log('[prover] POSTFLIGHT: a wrong cifo or split body pin, and a split type gate moved after the claim (with its md5 pin matched), each make the postflight refuse and roll the whole apply back');

  // 3. APPLY.
  const applied = apply('candidate.sql', true);
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  assert.match(applied.output, /POSTFLIGHT_OK/, `candidate applied without its postflight notice:\n${applied.output}`);
  wrappersUnchanged(NEW_CIFO_MD5, NEW_SPLIT_MD5, 'APPLY');
  assert.deepEqual({ cifo: oid(CIFO), split: oid(SPLIT) }, oids, 'the apply changed a wrapper OID');
  for (const signature of [CIFO, SPLIT]) assert.equal(acl(signature), 'authenticated,postgres,service_role|false', `the apply changed ${signature}'s ACL`);
  for (const [signature, md5] of Object.entries(LIVE_BODY_MD5)) {
    if (signature !== CIFO && signature !== SPLIT) assert.equal(lfBodyMd5(signature), md5, `the candidate changed ${signature}`);
  }
  console.log('[prover] APPLY: POSTFLIGHT_OK; new wrapper bodies; OIDs, ACLs and every delegate unchanged');

  // 4. FIX: chain steps 1-7 as authenticated, nothing written, no number drawn.
  const steps = [
    ['1 cifo rep B\'s customer', 'cifo', O.B, null, 'chemical_sale', /^P0001\|CUSTOMER_SCOPE_DENIED$/],
    ['2 cifo unassigned customer', 'cifo', O.U, null, 'chemical_sale', /^P0001\|CUSTOMER_SCOPE_DENIED$/],
    ['3 cifo naming rep B', 'cifo', O.A, REP_B, 'chemical_sale', /^P0001\|SALESMAN_SCOPE_DENIED$/],
    ['4 cifo order salesman rep B', 'cifo', O.A_OTHER, null, 'chemical_sale', /^P0001\|SALESMAN_SCOPE_DENIED$/],
    ['5a split rep B\'s allocated order', 'split', O.S_B, REP_A, 'chemical_sale', /^P0001\|CUSTOMER_SCOPE_DENIED$/],
    ['5 split with rep B\'s landlord', 'split', O.S_MIXED, REP_A, 'chemical_sale', /^P0001\|CUSTOMER_SCOPE_DENIED$/],
    ['5b split rep A\'s order on rep B\'s field', 'split', O.S_FIELD_B, null, 'chemical_sale', /^P0001\|CUSTOMER_SCOPE_DENIED$/],
    ['5c split rep B\'s order on rep A\'s field', 'split', O.S_T, REP_A, 'chemical_sale', /^P0001\|CUSTOMER_SCOPE_DENIED$/],
    ['5d cifo missing order', 'cifo', O.MISSING, null, 'chemical_sale', new RegExp(`^P0001\\|Order not found: ${O.MISSING}$`)],
    ['5e split missing order', 'split', O.MISSING, REP_A, 'chemical_sale', new RegExp(`^P0001\\|Order not found: ${O.MISSING}$`)],
    ['6 split naming rep B', 'split', O.S_OWN, REP_B, 'chemical_sale', /^P0001\|SALESMAN_SCOPE_DENIED$/],
    ['7 split field_application', 'split', O.S_OWN, REP_A, 'field_application', /^23514\|ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge$/],
  ];
  for (const [label, kind, order, salesman, type, expected] of steps) {
    expectRefused(attempt(REP_A, kind, order, salesman, type, `prover-fix-${label.split(' ')[0]}`), expected, `FIX step ${label}`);
    // Ordering: the same refusal while the order row and the key's claim lock are held.
    expectRefused(await heldAttempt(REP_A, kind, order, salesman, type, `prover-held-${label.split(' ')[0]}`, `held ${label}`), expected, `FIX step ${label} (order and claim locks held)`);
  }
  expectRefused(attempt(ADMIN, 'split', O.S_OWN, ADMIN, 'field_application', 'prover-fix-admin-field'), /^23514\|ORDER_INVOICE_TYPE_NOT_ALLOWED:/, 'FIX admin field_application split');
  expectRefused(attempt(REP_A, 'split', O.S_OWN, REP_A, 'credit_memo', 'prover-fix-credit'), /^23514\|ORDER_INVOICE_TYPE_NOT_ALLOWED:/, 'FIX split credit_memo');
  expectRefused(attempt(REP_A, 'split', O.S_OWN, REP_A, null, 'prover-fix-null'), /^23514\|ORDER_INVOICE_TYPE_NOT_ALLOWED:/, 'FIX split NULL type');
  const own = probeAs(REP_A, `SELECT ${call('cifo', O.A, null, 'chemical_sale', 'prover-fix-own')} AS first \\gset
SELECT ${call('cifo', O.A, null, 'chemical_sale', 'prover-fix-own')} AS second \\gset
RESET ROLE;
SELECT (:'first' = :'second') || '|' || customer_id || '|' || COALESCE(salesman_id::text, 'none') || '|' || created_by FROM public.invoices WHERE id = :'first';`);
  assert.ok(own.ok, `FIX: rep A's own order invoice broke:\n${own.error}`);
  assert.equal(own.last, `true|${C_A}|none|${REP_A}`, `FIX: rep A's own order invoice or its replay is wrong: ${own.last}`);
  const ownSplit = probeAs(REP_A, `SELECT array_to_string(${call('split', O.S_OWN, REP_A, 'chemical_sale', 'prover-fix-own-split')}, ',') AS first \\gset
SELECT array_to_string(${call('split', O.S_OWN, REP_A, 'chemical_sale', 'prover-fix-own-split')}, ',') AS second \\gset
RESET ROLE;
SELECT (:'first' = :'second') || '|' || string_agg(customer_id || ':' || salesman_id, ',') FROM public.invoices WHERE id::text = ANY (string_to_array(:'first', ','));`);
  assert.ok(ownSplit.ok, `FIX: rep A's own split broke:\n${ownSplit.error}`);
  assert.equal(ownSplit.last, `true|${C_A}:${REP_A}`, `FIX: rep A's own split or its replay is wrong: ${ownSplit.last}`);
  // Not over-strict: a field owned by rep B's customer but billed 100% to rep A's customer
  // through field_billing_defaults is rep A's to split (the owner rule takes the billing
  // default over fields.customer_id, exactly as the provenance implementation does).
  const override = attempt(REP_A, 'split', O.S_OVR, REP_A, 'chemical_sale', 'prover-fix-ovr');
  assert.equal(override.result, 'ok', `FIX: rep A could not split their order on a field billed to their customer: ${override.result}`);
  assert.equal(override.detail, `${C_A}:${REP_A}:${REP_A}`, `FIX: the billing-default override split billed the wrong customer: ${override.detail}`);
  // The salesman leg of the cifo post-check on the replay path (the pre-check passes here).
  assert.equal(replayAfterSalesmanChange('prover-fix-replay-salesman'), 'P0001|SALESMAN_SCOPE_DENIED', 'FIX: a replay of an invoice whose salesman became rep B was not refused');
  const adminOther = attempt(ADMIN, 'cifo', O.B, REP_B, 'chemical_sale', 'prover-fix-admin-cifo');
  assert.equal(adminOther.result, 'ok', `FIX: an admin could not invoice rep B's customer under rep B: ${adminOther.result}`);
  assert.equal(adminOther.detail, `${C_B}:${REP_B}:${ADMIN}`);
  const adminSplit = attempt(ADMIN, 'split', O.S_B, REP_B, 'chemical_sale', 'prover-fix-admin-split');
  assert.equal(adminSplit.result, 'ok', `FIX: an admin could not split rep B's allocated order: ${adminSplit.result}`);
  assert.equal(adminSplit.detail, `${C_B}:${REP_B}:${ADMIN}`);
  const adminMixed = attempt(ADMIN, 'split', O.S_MIXED, ADMIN, 'chemical_sale', 'prover-fix-admin-mixed');
  assert.equal(adminMixed.result, mixedAdmin.result, 'FIX: the admin\'s mixed-owner split outcome changed - the scope rule must never refuse an admin');
  // An admin's exact split replay with no salesman (the jsonb replay path).
  const adminReplay = probeAs(ADMIN, `SELECT array_to_string(${call('split', O.S_OWN, null, 'chemical_sale', 'prover-fix-admin-split-replay')}, ',') AS first \\gset
SELECT array_to_string(${call('split', O.S_OWN, null, 'chemical_sale', 'prover-fix-admin-split-replay')}, ',') AS second \\gset
RESET ROLE;
SELECT (:'first' = :'second') || '|' || string_agg(customer_id || ':' || COALESCE(salesman_id::text, 'none') || ':' || created_by, ',') FROM public.invoices WHERE id::text = ANY (string_to_array(:'first', ','));`);
  assert.ok(adminReplay.ok, `FIX: an admin's split replay broke:\n${adminReplay.error}`);
  assert.equal(adminReplay.last, `true|${C_A}:none:${ADMIN}`, `FIX: an admin's split or its exact replay is wrong: ${adminReplay.last}`);
  // misc_charge stays an allowed split type, for an admin exactly as before the candidate and
  // for rep A on their own order.
  const miscAfter = attempt(ADMIN, 'split', O.S_OWN, ADMIN, 'misc_charge', 'prover-fix-misc-admin');
  assert.equal(miscAfter.result, miscBefore.result, `FIX: an admin's misc_charge split changed outcome: ${miscBefore.result} -> ${miscAfter.result}`);
  const miscRep = attempt(REP_A, 'split', O.S_OWN, REP_A, 'misc_charge', 'prover-fix-misc-rep');
  assert.doesNotMatch(miscRep.result, /ORDER_INVOICE_TYPE_NOT_ALLOWED/, `FIX: a misc_charge split was refused as a disallowed type: ${miscRep.result}`);
  assert.equal(miscRep.result, miscBefore.result, `FIX: rep A's misc_charge split on their own order differs from the admin's: ${miscRep.result}`);
  for (const kind of ['cifo', 'split']) {
    const anon = probeAs(REP_A, `SELECT ${call(kind, O.A, null, 'chemical_sale', `prover-anon-${kind}`)};`, 'anon');
    assert.ok(!anon.ok && /permission denied for function create_(split_invoices|invoice)_from_order/.test(anon.error), `anon could execute the ${kind} wrapper:\n${anon.error}`);
  }
  console.log('[prover] FIX: steps 1-7 (and 5a-5e: rep B\'s order on rep A\'s field, a missing order for both wrappers) refused as authenticated with no number drawn, and refused the same way while a second session held the order row and the key\'s claim lock (so before the claim and the lock); admin/credit_memo/NULL split types refused with no number; rep A\'s own invoice and split replay exactly; a field billed to rep A\'s customer through field_billing_defaults is rep A\'s to split; a replay of an invoice whose salesman became rep B is SALESMAN_SCOPE_DENIED; an admin\'s split replays exactly; misc_charge splits unchanged; admins unrestricted; anon denied');
  console.log(`[prover] FIX: misc_charge split outcome (admin before = admin after = rep A after): ${miscBefore.result}`);

  // 5. DELIVERIES.
  deliveries('after');
  console.log('[prover] DELIVERIES: (a) admin auto-split drafted; (b) rep A on rep B\'s order and on the mixed-owner order: completed, flagged, activity + 2 admin notifications, no invoice, no number, and the exact auto-split call repeated directly is CUSTOMER_SCOPE_DENIED; (c) rep A\'s own auto-split drafted with no salesman; (d) driver unchanged fallback; (e) non-allocated mono auto-invoice unchanged (known gap)');

  // 6. CHAINS.
  expectChainPass(CHAINS.repScope, 'rep-scope-after.sql');
  expectChainPass(CHAINS.typeGate, 'type-gate-after.sql');
  assert.doesNotMatch(expectChainPass(CHAINS.split, 'split-after.sql'), SPLIT_PRE_GATE_NOTE, 'AFTER: the split chain took its pre-candidate branch');
  assert.equal(maskSuffix(firstError(runChain(CHAINS.lifecycle, 'lifecycle-after.sql'))), lifecycleBefore, 'the lifecycle chain now fails differently on #889\'s schema than before the candidate');
  expectChainPass(CHAINS.lifecycle, 'lifecycle-after-unlocked.sql', withoutPr889Locks(lf(CHAINS.lifecycle)));
  expectChainPass(CHAINS.keys, 'keys-after.sql');
  expectChainPass(CHAINS.periodGuard, 'period-guard-after.sql');
  for (const key of Object.keys(STALE_CHAINS)) {
    assert.equal(firstError(runChain(CHAINS[key], `${key}-after.sql`)), staleBefore[key], `${key} now fails differently than before the candidate`);
  }
  console.log('[prover] CHAINS: rep-scope, type-gate, split-billing, required keys and delivery period guard pass and roll back; the order lifecycle chain stops on #889\'s deleted-order lock exactly as before the candidate and passes, before and after, with those #889 locks disabled in its own rolled-back transaction; the two stale chains fail exactly as they did before the candidate');

  // 7. RE-APPLY.
  const reapplied = apply('candidate.sql', true);
  assert.notEqual(reapplied.status, 0, 'the candidate re-applied over itself');
  assert.match(reapplied.output, /PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT/, `wrong re-apply refusal:\n${reapplied.output}`);
  wrappersUnchanged(NEW_CIFO_MD5, NEW_SPLIT_MD5, 'RE-APPLY');
  console.log('[prover] RE-APPLY: refused on its own pins; nothing changed');

  // 8. MUTATIONS.
  const reviewedCifo = functionStatement(CANDIDATE, 'CREATE OR REPLACE FUNCTION public.create_invoice_from_order(');
  const reviewedSplit = functionStatement(CANDIDATE, 'CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(');
  const restore = (label) => {
    applyText(`restore-${label}.sql`, `${reviewedCifo}${reviewedSplit}`);
    wrappersUnchanged(NEW_CIFO_MD5, NEW_SPLIT_MD5, `restore after ${label}`);
    expectChainPass(CHAINS.repScope, `rep-scope-restored-${label}.sql`);
  };

  // (a) the CRX-LIFE-001 create_invoice_from_order body -> the new chain fails at step 1.
  applyText('mutant-a.sql', functionStatement(path.join(MIGRATIONS, '20261006200000_refuse_field_invoice_through_order_rpcs.sql'), 'CREATE OR REPLACE FUNCTION public.create_invoice_from_order('));
  assert.equal(lfBodyMd5(CIFO), LIVE_BODY_MD5[CIFO]);
  expectChainFail(CHAINS.repScope, 'mutant-a.sql', /SMOKE_FAIL: step 1: a sales rep created an order invoice the scope rule forbids/, 'MUTATION (a)');
  restore('a');

  // (b) without the cifo pre-check the post-check still refuses, but only after drawing a number.
  const cifoPreCheck = ['  v_scope_rep := public.is_sales_rep();\n  IF v_scope_rep THEN\n    SELECT o.customer_id, o.salesman_id', '      RAISE EXCEPTION \'SALESMAN_SCOPE_DENIED\';\n    END IF;\n  END IF;\n'];
  applyText('mutant-b.sql', cut(reviewedCifo, ...cifoPreCheck, 'mutant b').replace('  v_invoice_id := public._create_invoice_from_order_idem_impl_20260721(', '  v_scope_rep := public.is_sales_rep();\n  v_invoice_id := public._create_invoice_from_order_idem_impl_20260721('));
  expectChainFail(CHAINS.repScope, 'mutant-b.sql', /SMOKE_FAIL: step 1: a refused call drew an invoice number .*: CUSTOMER_SCOPE_DENIED/, 'MUTATION (b)');
  restore('b');

  // (c) without the cifo post-check, the order's customer changed under its lock bills rep B's customer.
  const cifoRace = (orderId) => `UPDATE public.orders SET customer_id = '${C_B}' WHERE id = '${orderId}';`;
  const cifoCall = (orderId) => `(${call('cifo', orderId, null, 'chemical_sale', `prover-race-${orderId.slice(-4)}`)})::text`;
  applyText('mutant-c.sql', cut(reviewedCifo, '  -- Authoritative re-check of the invoice actually created or replayed', '      RAISE EXCEPTION \'SALESMAN_SCOPE_DENIED\';\n    END IF;\n  END IF;\n', 'mutant c'));
  const raceC = await interleave(O.R_C1, cifoRace(O.R_C1), cifoCall(O.R_C1), 'mutation c');
  assert.ok(raceC.ok, `MUTATION (c): without the post-check the raced call should have succeeded:\n${raceC.error}`);
  assert.equal(raceC.result, `${C_B}:none`, `MUTATION (c): without the post-check rep A should hold an invoice for rep B's customer: ${raceC.result}`);
  restore('c');
  const raceC2 = await interleave(O.R_C2, cifoRace(O.R_C2), cifoCall(O.R_C2), 'restored c');
  assert.ok(!raceC2.ok && /ERROR:\s+CUSTOMER_SCOPE_DENIED/.test(raceC2.error), `RESTORED (c): the post-check did not refuse the raced invoice:\n${raceC2.error}\n${raceC2.result}`);
  console.log('[prover] MUTATION (a)-(c): the old wrapper fails step 1; without the pre-check step 1 burns a number; without the post-check a two-session race (order customer changed under the lock) bills rep B\'s customer, and the restored post-check refuses it');

  // (d) the 20260719060256 split body -> step 5a fails first; steps 6 and 7 are then also wrong.
  applyText('mutant-d.sql', liveSplit);
  assert.equal(lfBodyMd5(SPLIT), LIVE_BODY_MD5[SPLIT]);
  expectChainFail(CHAINS.repScope, 'mutant-d.sql', /SMOKE_FAIL: step 5a: a sales rep created an order invoice the scope rule forbids/, 'MUTATION (d)');
  const d6 = attempt(REP_A, 'split', O.S_OWN, REP_B, 'chemical_sale', 'prover-mutant-d6');
  assert.equal(d6.result, 'ok', `MUTATION (d): the old split body should let rep A name rep B: ${d6.result}`);
  const d7 = attempt(REP_A, 'split', O.S_OWN, REP_A, 'field_application', 'prover-mutant-d7');
  assert.match(d7.result, /invoices_field_application_has_no_order/, `MUTATION (d): the old split body should reach the CHECK: ${d7.result}`);
  assert.notEqual(d7.seqAfter, d7.seqBefore, 'MUTATION (d): the old split body should draw a number before the CHECK refuses');
  restore('d');

  // (e) without the split type gate the split-billing chain fails on the burned number.
  applyText('mutant-e.sql', cut(reviewedSplit, '  -- CRX-LIFE-001 type allow-list, before any claim, lock or insert', '      USING ERRCODE = \'check_violation\';\n  END IF;\n\n', 'mutant e'));
  expectChainFail(CHAINS.split, 'mutant-e.sql', /SMOKE_FAIL: a refused field_application split drew an invoice number/, 'MUTATION (e)');
  restore('e');
  expectChainPass(CHAINS.split, 'split-restored-e.sql');

  // (f) without the split owner pre-check, step 5a is refused by the post-check only after a number.
  applyText('mutant-f.sql', cut(reviewedSplit, '    IF EXISTS (\n      SELECT 1\n        FROM (\n          SELECT v_order_customer_id AS customer_id', '      RAISE EXCEPTION \'CUSTOMER_SCOPE_DENIED\';\n    END IF;\n', 'mutant f'));
  expectChainFail(CHAINS.repScope, 'mutant-f.sql', /SMOKE_FAIL: step 5a: a refused call drew an invoice number .*: CUSTOMER_SCOPE_DENIED/, 'MUTATION (f)');
  restore('f');

  // (g) without the split post-check, an allocated order moved to rep B's customer (and its
  // field's billing owner to rep B's customer) under the lock is billed to rep B's customer.
  // DEVIATION from design 5.4.8(g), which changes only the field's billing owner: the order's
  // customer must move too, because trg_guard_invoice_terminal_order refuses a split invoice
  // whose customer is not the order's. So (g) proves the post-check against an order-customer
  // race through the split engine (as (c) does for the single invoice); a landlord-only race
  // cannot create an invoice while that lineage guard holds, so the post-check's per-landlord
  // reach is defence in depth, not separately proven.
  const splitRace = (orderId, fieldId) => `UPDATE public.orders SET customer_id = '${C_B}' WHERE id = '${orderId}';
INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES ('${fieldId}', '${C_B}', 100, true);`;
  const splitCall = (orderId) => `array_to_string(${call('split', orderId, REP_A, 'chemical_sale', `prover-race-${orderId.slice(-4)}`)}, ',')`;
  applyText('mutant-g.sql', cut(reviewedSplit, '  -- Authoritative re-check of every invoice actually created or replayed', '      RAISE EXCEPTION \'SALESMAN_SCOPE_DENIED\';\n    END IF;\n  END IF;\n\n', 'mutant g'));
  const raceG = await interleave(O.R_G1, splitRace(O.R_G1, F_G1), splitCall(O.R_G1), 'mutation g');
  assert.ok(raceG.ok, `MUTATION (g): without the post-check the raced split should have succeeded:\n${raceG.error}`);
  assert.equal(raceG.result, `${C_B}:${REP_A}`, `MUTATION (g): without the post-check rep A should hold a split invoice for rep B's customer: ${raceG.result}`);
  restore('g');
  const raceG2 = await interleave(O.R_G2, splitRace(O.R_G2, F_G2), splitCall(O.R_G2), 'restored g');
  assert.ok(!raceG2.ok && /ERROR:\s+CUSTOMER_SCOPE_DENIED/.test(raceG2.error), `RESTORED (g): the split post-check did not refuse the raced invoice:\n${raceG2.error}\n${raceG2.result}`);
  console.log('[prover] MUTATION (d)-(g): the old split body fails step 5a (and lets steps 6-7 through); without the type gate the split chain burns a number; without the owner pre-check step 5a burns a number; without the split post-check a two-session race (order customer moved under the lock) bills rep B\'s customer, and the restored post-check refuses it');

  // (h)-(k) ORDERING: the split pre-check, or the type gate, moved to just after the claim or
  // just after the order locks still refuses on the committed rows - but only after waiting on
  // a held lock, so the held attempt ends in a lock timeout instead. (h)/(j) hold ONLY the
  // key's claim lock and (i)/(k) ONLY the order row, so each lock is shown to catch a late
  // check on its own. (v) does the same for the cifo pre-check moved after the idempotent
  // implementation call (check_idempotency takes the same advisory lock before its order lock).
  const preCheck = ['  -- Rep scope (Mason 2026-10-06): a sales rep must be the assigned rep', '      RAISE EXCEPTION \'SALESMAN_SCOPE_DENIED\';\n    END IF;\n  END IF;\n\n'];
  const typeGate = ['  -- CRX-LIFE-001 type allow-list, before any claim, lock or insert', '      USING ERRCODE = \'check_violation\';\n  END IF;\n\n'];
  const afterClaim = '  PERFORM 1\n    FROM public.orders o\n   WHERE o.id = p_order_id\n   FOR UPDATE;';
  const afterLocks = '  SELECT EXISTS (\n    SELECT 1\n      FROM public.order_item_field_allocations oifa';
  const STEP5A = /^P0001\|CUSTOMER_SCOPE_DENIED$/;
  const STEP7 = /^23514\|ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge$/;
  const orderingMutants = [
    ['h', 'scope pre-check after the claim', reviewedSplit, preCheck, afterClaim, 'claim', ['5a', 'split', O.S_B, REP_A, 'chemical_sale', STEP5A]],
    ['i', 'scope pre-check after the order locks', reviewedSplit, preCheck, afterLocks, 'order', ['5a', 'split', O.S_B, REP_A, 'chemical_sale', STEP5A]],
    ['j', 'type gate after the claim', reviewedSplit, typeGate, afterClaim, 'claim', ['7', 'split', O.S_OWN, REP_A, 'field_application', STEP7]],
    ['k', 'type gate after the order locks', reviewedSplit, typeGate, afterLocks, 'order', ['7', 'split', O.S_OWN, REP_A, 'field_application', STEP7]],
    ['v', 'cifo pre-check after the idempotent implementation call', reviewedCifo, cifoPreCheck, '  -- Authoritative re-check of the invoice actually created or replayed', 'claim', ['1', 'cifo', O.B, null, 'chemical_sale', STEP5A]],
  ];
  for (const [letter, label, statement, [from, through], anchor, hold, [step, kind, order, salesman, type, expected]] of orderingMutants) {
    applyText(`mutant-${letter}.sql`, move(statement, from, through, anchor, `mutant ${letter}`));
    const held = await heldAttempt(REP_A, kind, order, salesman, type, `prover-mutant-${letter}`, `mutant ${letter}`, { hold });
    assert.match(held.result, LOCK_TIMEOUT, `MUTATION (${letter}) ${label}: the ${hold}-only held-lock check did not detect it (step ${step} returned ${held.result})`);
    restore(letter);
    const heldRestored = await heldAttempt(REP_A, kind, order, salesman, type, `prover-restored-${letter}`, `restored ${letter}`, { hold });
    expectRefused(heldRestored, expected, `RESTORED (${letter}) step ${step} with only the ${hold} lock held`);
  }
  console.log('[prover] MUTATION (h)-(k),(v): the split scope pre-check or type gate moved after the claim (only the claim lock held) or after the order locks (only the order row held), and the cifo pre-check moved after the idempotent implementation call (only the claim lock held), each wait on that one lock (lock timeout) instead of refusing first; each restored body refuses first with its exact error and no number');

  // (l)/(m) each owner branch of the split pre-check is load-bearing: without the
  // field_billing_defaults branch step 5 is refused only after a number is drawn (by the
  // lineage guard), and without the fields.customer_id branch step 5b is.
  applyText('mutant-l.sql', cut(reviewedSplit, '          UNION\n          SELECT fbd.customer_id', '           WHERE oi.order_id = p_order_id\n', 'mutant l'));
  expectChainFail(CHAINS.repScope, 'mutant-l.sql', /SMOKE_FAIL: step 5: a refused call drew an invoice number/, 'MUTATION (l)');
  restore('l');
  applyText('mutant-m.sql', cut(reviewedSplit, '          UNION\n          SELECT f.customer_id', '             AND NOT EXISTS (SELECT 1 FROM public.field_billing_defaults d WHERE d.field_id = oifa.field_id)\n', 'mutant m'));
  expectChainFail(CHAINS.repScope, 'mutant-m.sql', /SMOKE_FAIL: step 5b: a refused call drew an invoice number/, 'MUTATION (m)');
  restore('m');
  console.log('[prover] MUTATION (l)-(m): without the field_billing_defaults owner branch step 5 burns a number; without the fields.customer_id owner branch step 5b does');

  // (n) a type gate narrowed to chemical_sale refuses misc_charge, which FIX's allow check catches.
  const gateList = "p_invoice_type NOT IN ('chemical_sale', 'misc_charge')";
  assert.equal(reviewedSplit.split(gateList).length - 1, 1, 'mutant n: the split type list must occur once');
  applyText('mutant-n.sql', reviewedSplit.replace(gateList, "p_invoice_type NOT IN ('chemical_sale')"));
  const miscMutant = attempt(REP_A, 'split', O.S_OWN, REP_A, 'misc_charge', 'prover-mutant-n');
  assert.match(miscMutant.result, /^23514\|ORDER_INVOICE_TYPE_NOT_ALLOWED/, `MUTATION (n): a narrowed gate should refuse misc_charge: ${miscMutant.result}`);
  // The exact FIX allow assertion, re-run against the mutant, must fail.
  assert.throws(() => assert.doesNotMatch(miscMutant.result, /ORDER_INVOICE_TYPE_NOT_ALLOWED/), 'MUTATION (n): FIX\'s misc_charge allow assertion would still pass against the narrowed gate');
  restore('n');
  console.log('[prover] MUTATION (n): a split gate narrowed to chemical_sale refuses misc_charge, which the FIX allow check rejects');

  // (o)/(p) the SALESMAN leg of each post-check: an admin sets the order's salesman to rep B
  // under the order lock while rep A (naming no salesman) waits; without that leg rep A's
  // invoice is recorded under rep B; restored, SALESMAN_SCOPE_DENIED.
  const salesmanRace = (orderId) => `UPDATE public.orders SET salesman_id = '${REP_B}' WHERE id = '${orderId}';`;
  const splitCallNoSalesman = (orderId) => `array_to_string(${call('split', orderId, null, 'chemical_sale', `prover-race-${orderId.slice(-4)}`)}, ',')`;
  applyText('mutant-o.sql', cut(reviewedCifo, '    IF v_invoice_salesman_id IS NOT NULL AND v_invoice_salesman_id IS DISTINCT FROM v_actor THEN', '      RAISE EXCEPTION \'SALESMAN_SCOPE_DENIED\';\n    END IF;\n', 'mutant o'));
  const raceO = await interleave(O.R_S1, salesmanRace(O.R_S1), cifoCall(O.R_S1), 'mutation o');
  assert.ok(raceO.ok, `MUTATION (o): without the cifo salesman post-check the raced call should have succeeded:\n${raceO.error}`);
  assert.equal(raceO.result, `${C_A}:${REP_B}`, `MUTATION (o): without the salesman post-check rep A's invoice should be recorded under rep B: ${raceO.result}`);
  // ... and on the replay path: without that leg, rep A's replay returns the invoice now
  // recorded under rep B (FIX asserts the reviewed body refuses it).
  assert.equal(replayAfterSalesmanChange('prover-mutant-o-replay'), 'ok', 'MUTATION (o): without the salesman post-check the replay should have returned rep B\'s invoice');
  restore('o');
  assert.equal(replayAfterSalesmanChange('prover-restored-o-replay'), 'P0001|SALESMAN_SCOPE_DENIED', 'RESTORED (o): the replay of an invoice whose salesman became rep B was not refused');
  const raceO2 = await interleave(O.R_S2, salesmanRace(O.R_S2), cifoCall(O.R_S2), 'restored o');
  assert.ok(!raceO2.ok && /ERROR:\s+SALESMAN_SCOPE_DENIED/.test(raceO2.error), `RESTORED (o): the cifo salesman post-check did not refuse:\n${raceO2.error}\n${raceO2.result}`);
  applyText('mutant-p.sql', cut(reviewedSplit, '    IF EXISTS (SELECT 1\n                 FROM unnest(COALESCE(v_invoice_ids, \'{}\'::uuid[])) AS returned(invoice_id)\n                 JOIN public.invoices i ON i.id = returned.invoice_id\n                WHERE i.salesman_id IS NOT NULL', '      RAISE EXCEPTION \'SALESMAN_SCOPE_DENIED\';\n    END IF;\n', 'mutant p'));
  const raceP = await interleave(O.R_SS1, salesmanRace(O.R_SS1), splitCallNoSalesman(O.R_SS1), 'mutation p');
  assert.ok(raceP.ok, `MUTATION (p): without the split salesman post-check the raced split should have succeeded:\n${raceP.error}`);
  assert.equal(raceP.result, `${C_A}:${REP_B}`, `MUTATION (p): without the salesman post-check rep A's split invoice should be recorded under rep B: ${raceP.result}`);
  restore('p');
  const raceP2 = await interleave(O.R_SS2, salesmanRace(O.R_SS2), splitCallNoSalesman(O.R_SS2), 'restored p');
  assert.ok(!raceP2.ok && /ERROR:\s+SALESMAN_SCOPE_DENIED/.test(raceP2.error), `RESTORED (p): the split salesman post-check did not refuse:\n${raceP2.error}\n${raceP2.result}`);
  console.log('[prover] MUTATION (o)-(p): without the salesman leg of either post-check, a two-session race (order salesman set to rep B under the lock) records rep A\'s invoice under rep B, and (cifo) a replay of an invoice whose salesman became rep B returns it; restored, SALESMAN_SCOPE_DENIED');

  // (q)-(u) each pre-check LEG on its own: without it the call is refused only later (after a
  // number is drawn) or wrongly.
  const cifoSalesmanPre = ['    IF COALESCE(p_salesman_id, v_order_salesman_id) IS NOT NULL', '      RAISE EXCEPTION \'SALESMAN_SCOPE_DENIED\';\n    END IF;\n'];
  // (q) no cifo salesman pre-check -> step 3 (rep A names rep B) burns a number.
  applyText('mutant-q.sql', cut(reviewedCifo, ...cifoSalesmanPre, 'mutant q'));
  expectChainFail(CHAINS.repScope, 'mutant-q.sql', /SMOKE_FAIL: step 3: a refused call drew an invoice number .*: SALESMAN_SCOPE_DENIED/, 'MUTATION (q)');
  restore('q');
  // (r) the cifo salesman pre-check reading only p_salesman_id (save_invoice's rule) -> step 4
  // (the order's recorded salesman is rep B, the call names no one) burns a number.
  assert.equal(reviewedCifo.split('COALESCE(p_salesman_id, v_order_salesman_id)').length - 1, 2, 'mutant r: the cifo salesman pre-check must use the COALESCE twice');
  applyText('mutant-r.sql', reviewedCifo.replaceAll('COALESCE(p_salesman_id, v_order_salesman_id)', 'p_salesman_id'));
  expectChainFail(CHAINS.repScope, 'mutant-r.sql', /SMOKE_FAIL: step 4: a refused call drew an invoice number .*: SALESMAN_SCOPE_DENIED/, 'MUTATION (r)');
  restore('r');
  // (s) no split salesman pre-check -> step 6 (rep A's own split naming rep B) burns a number.
  applyText('mutant-s.sql', cut(reviewedSplit, ...cifoSalesmanPre, 'mutant s'));
  expectChainFail(CHAINS.repScope, 'mutant-s.sql', /SMOKE_FAIL: step 6: a refused call drew an invoice number .*: SALESMAN_SCOPE_DENIED/, 'MUTATION (s)');
  restore('s');
  // (t) no order-customer leg in the split owner set -> rep B's customer's order allocated to
  // rep A's own field (FIX step 5c) passes the pre-check and is refused only after a number.
  applyText('mutant-t.sql', cut(reviewedSplit, '          SELECT v_order_customer_id AS customer_id\n', '          UNION\n', 'mutant t'));
  const tMutant = attempt(REP_A, 'split', O.S_T, REP_A, 'chemical_sale', 'prover-mutant-t');
  assert.notEqual(tMutant.seqAfter, tMutant.seqBefore, `MUTATION (t): without the order-customer leg step 5c should draw a number (got ${tMutant.result})`);
  assert.throws(() => expectRefused(tMutant, /^P0001\|CUSTOMER_SCOPE_DENIED$/, 'mutant t'), 'MUTATION (t): FIX step 5c would still pass');
  restore('t');
  // (u) the fields.customer_id branch without its "no billing default" filter -> the override
  // field's owner (rep B's customer) is counted although it is never billed: over-strict.
  const noFbdFilter = '\n             AND NOT EXISTS (SELECT 1 FROM public.field_billing_defaults d WHERE d.field_id = oifa.field_id)';
  assert.equal(reviewedSplit.split(noFbdFilter).length - 1, 1, 'mutant u: the fields-branch filter must occur once');
  applyText('mutant-u.sql', reviewedSplit.replace(noFbdFilter, ''));
  const uMutant = attempt(REP_A, 'split', O.S_OVR, REP_A, 'chemical_sale', 'prover-mutant-u');
  assert.equal(uMutant.result, 'P0001|CUSTOMER_SCOPE_DENIED', `MUTATION (u): without the filter the override split should be (wrongly) refused, which FIX's allow check catches: ${uMutant.result}`);
  restore('u');
  wrappersUnchanged(NEW_CIFO_MD5, NEW_SPLIT_MD5, 'final');
  console.log('[prover] MUTATION (q)-(u): without the cifo salesman pre-check step 3 burns a number; with it reading only p_salesman_id step 4 burns one; without the split salesman pre-check step 6 burns one; without the order-customer owner leg step 5c burns one; without the fields-branch billing-default filter the override split is wrongly refused');

  console.log('ORDER_INVOICE_REP_SCOPE_PROOF_PASS pr889=replayed_and_required before=bug_reproduced autocommit=refused preflight=blocks_every_pin_group postflight=refuses_wrong_body fix=refused_no_number,before_claim_and_lock,replay_salesman_rescoped allowed=own_customer,billing_default_override,admin,misc_charge deliveries=complete(mono_auto_invoice_gap_open) chains=5_pass,lifecycle_pass_with_pr889_locks_off,financialScope+splitJsonb_stale_assert_nothing reapply=refused mutations=a-v_detected');
}

try { await main(); }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
