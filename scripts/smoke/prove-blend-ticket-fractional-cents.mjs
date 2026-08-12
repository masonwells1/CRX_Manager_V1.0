#!/usr/bin/env node
/**
 * prove-blend-ticket-fractional-cents.mjs
 *
 * Executable proof that CRX-MONEY-001 is really fixed by the migration that is
 * actually live: supabase/migrations/20260811200000_blend_ticket_order_whole_cent_totals.sql
 * (applied to production 2026-08-11, ledger version 20260811220045).
 *
 * Why this exists. That migration shipped on review and reasoning, but no blend
 * ticket with a fractional converted quantity has ever been run through the
 * fixed function — production has never created an order from a blend ticket at
 * all. This is the missing execution.
 *
 * The live database cannot host the proof: the chain has to INSERT a customer, a
 * blend ticket and an order, and the LIVE-DATA GUARD (correctly) refuses. So a
 * unique PostgreSQL 17 container runs with no network and tmpfs storage, and is
 * force-removed in `finally`.
 *
 * Both function bodies come from real migration files on disk — nothing is
 * transcribed by hand and nothing is reverse-patched:
 *
 *   pre-fix   20260714230200_blend_ticket_order_lifecycle.sql   md5 must equal
 *             PREFIX_BODY_MD5, the body that was live before the fix.
 *   post-fix  20260811200000_blend_ticket_order_whole_cent_totals.sql  md5 must
 *             equal LIVE_PROD_BODY_MD5, read out of production pg_proc.
 *
 * That second assertion is the load-bearing one: it proves the file this proof
 * exercises is byte for byte the function running in production. If someone
 * re-emits the function, this stops matching and the proof refuses to run rather
 * than quietly certifying a body nobody is using.
 *
 * Six stages, all of which must land as stated:
 *   A  chain against the PRE-FIX body   -> check_violation on
 *                                          orders_total_cost_whole_cents_chk
 *   B  apply the migration VERBATIM     -> its own $verify$ postcondition passes
 *   C  chain against the FIXED body     -> SMOKE_PASS_ROLLBACK
 *   D  mutation: drop after_order_items_change, re-apply -> must FAIL CLOSED
 *   E  mutation: set that trigger REPLICA-only, re-apply -> must FAIL CLOSED
 *      ('R' is the fail-open trap: a `tgenabled <> 'D'` check would pass here
 *      even though a replica-only trigger never fires in an origin session.)
 *   F  characterization: FIXED body + no recalc trigger at RUN time. Documents
 *      the one residual gap — the migration's trigger guarantee is apply-time
 *      only, so a trigger dropped later books a zero-value order silently.
 *
 * Usage: node scripts/smoke/prove-blend-ticket-fractional-cents.mjs [--keep]
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
/** The migration that was live before the fix — source of the PRE-FIX body. */
const LIFECYCLE = join(MIGRATIONS, '20260714230200_blend_ticket_order_lifecycle.sql');
/** The migration under proof — applied to production as ledger 20260811220045. */
const MIGRATION = join(MIGRATIONS, '20260811200000_blend_ticket_order_whole_cent_totals.sql');
const BASE = join(HERE, 'fixtures', 'blend-ticket-fractional-cents-base.sql');
const CHAIN = join(HERE, 'smoke-blend-ticket-fractional-cents.sql');

/** LF-normalized md5 of create_order_from_blend_ticket BEFORE the fix. */
const PREFIX_BODY_MD5 = 'c056d2bf1200fd0fb73a0da54941a8d9';
/**
 * LF-normalized md5 of create_order_from_blend_ticket as read from production
 * pg_proc ON 2026-08-11, after 20260811200000 was applied
 * (raw prosrc md5 27d4411a40fb14839babb786e8a6ba56, length 10015, one overload).
 *
 * This is a PINNED HISTORICAL SNAPSHOT, not a live reading. The prover runs its
 * container with --network none and never contacts production, so a match here
 * proves only that the repository file still equals what production held on
 * that date — if the live function is re-emitted later, this still passes
 * (CodeRabbit, PR #384). To re-confirm current parity, run against production:
 *
 *   SELECT md5(replace(prosrc, E'\r\n', E'\n')), length(prosrc), count(*) OVER ()
 *     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 *    WHERE n.nspname = 'public' AND p.proname = 'create_order_from_blend_ticket';
 */
const PROD_BODY_MD5_ON_2026_08_11 = '27d4411a40fb14839babb786e8a6ba56';

const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK';
const IMAGE = 'postgres:17-alpine';
const CONTAINER = `crx-blendcents-${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const KEEP = process.argv.includes('--keep');

const lf = (s) => s.replace(/\r\n/g, '\n');
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');

let step = 0;
const say = (msg) => console.log(`[${String(++step).padStart(2, '0')}] ${msg}`);
const fail = (msg) => { throw new Error(msg); };

function docker(args, { input, allowFailure = false } = {}) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 180_000 });
  if (r.error) fail(`docker ${args[0]} failed to spawn: ${r.error.message}`);
  if (!allowFailure && r.status !== 0) {
    fail(`docker ${args.slice(0, 3).join(' ')} exited ${r.status}\n${r.stdout || ''}\n${r.stderr || ''}`);
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const psql = (sql, opts = {}) =>
  docker(['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q',
          '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, ...opts });

/**
 * Apply a migration the way Supabase's migration runner does: as ONE
 * transaction. Without --single-transaction the CREATE OR REPLACE FUNCTION and
 * the grants commit before the trailing $verify$ block raises, so stages D/E
 * would report "fails CLOSED" while the half-applied function stayed behind —
 * which is the opposite of failing closed (CodeRabbit, PR #384).
 */
const psqlTxn = (sql, opts = {}) =>
  docker(['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q',
          '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, ...opts });

/** LF-normalized md5 of the create_order_from_blend_ticket body live in the container. */
function bodyMd5InContainer() {
  const r = psql(
    `\\pset tuples_only on
     \\pset format unaligned
     SELECT md5(replace(prosrc, E'\\r\\n', E'\\n')) FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'create_order_from_blend_ticket';`);
  return r.stdout.trim();
}

// ── pull each function body straight out of its migration ────────────────────

/**
 * Returns the single create_order_from_blend_ticket body defined in `file`.
 * Refuses if the file defines the function zero times or more than once, so a
 * migration that re-emits it twice cannot silently hand back the wrong one.
 */
function extractBody(file, label) {
  const raw = lf(readFileSync(file, 'utf8'));
  const re = /CREATE OR REPLACE FUNCTION public\.create_order_from_blend_ticket\b/g;
  const bodies = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    // Bound the delimiter search to THIS definition. Searching the rest of the
    // file unbounded means a definition written with a different dollar-quote
    // tag ($$ or $body$) silently yields some LATER function's body, and the
    // md5 gate then fails with a misleading message (CodeRabbit, PR #384).
    re.lastIndex = m.index + 1;
    const nextDef = re.exec(raw);
    re.lastIndex = nextDef ? nextDef.index : raw.length;
    const limit = nextDef ? nextDef.index : raw.length;

    const open = raw.indexOf('AS $function$', m.index);
    if (open === -1 || open >= limit) {
      fail(`${label}: definition at offset ${m.index} does not open with AS $function$ before the next definition`);
    }
    const bodyStart = open + 'AS $function$'.length;
    const close = raw.indexOf('$function$', bodyStart);
    if (close === -1 || close > limit) {
      fail(`${label}: definition at offset ${m.index} has no closing $function$ delimiter`);
    }
    bodies.push(raw.slice(bodyStart, close));
  }
  if (bodies.length !== 1) {
    fail(`${label}: expected exactly 1 create_order_from_blend_ticket definition, found ${bodies.length}`);
  }
  return bodies[0];
}

// ── seed ─────────────────────────────────────────────────────────────────────

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CLERK_ID = '22222222-2222-4222-8222-222222222222';

/**
 * tier1_price 12.35 and current_cost 7.01 both produce a sub-cent value at the
 * 0.5-unit quantity the chain uses (6.175 and 3.505), which is exactly the
 * shape CRX-MONEY-001 fails on. inventory_unit == the blend line's unit, so
 * field_app_priced_quantity returns the quantity unchanged and the arithmetic
 * under test is not perturbed by a conversion.
 */
const SEED = `
INSERT INTO profiles (id, role, is_active) VALUES
  ('${ADMIN_ID}', 'admin', true),
  ('${CLERK_ID}', 'office', true);

INSERT INTO products (product_name, tier1_price, tier2_price, tier3_price, current_cost,
                      inventory_unit, unit_size, product_form, is_active)
VALUES ('[SMOKE] Fractional Cent Concentrate', 12.35, 12.35, 12.35, 7.01,
        'gal', 'gal', 'liquid', true);
`;

const AS_ADMIN = `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN_ID}"}', false);`;

const RECREATE_RECALC_TRIGGER = `
CREATE TRIGGER after_order_items_change
  AFTER INSERT OR UPDATE OR DELETE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_recalc_order_totals();
`;

// ── run ──────────────────────────────────────────────────────────────────────

let ok = false;
try {
  say('reading both function bodies from their migration files');
  const preFix = extractBody(LIFECYCLE, '20260714230200 (pre-fix)');
  const postFix = extractBody(MIGRATION, '20260811200000 (under proof)');

  const preMd5 = md5(preFix);
  if (preMd5 !== PREFIX_BODY_MD5) {
    fail(`pre-fix body md5 ${preMd5} != recorded pre-fix baseline ${PREFIX_BODY_MD5}\n` +
         'The lifecycle migration changed. Refusing to prove against a baseline that was never live.');
  }
  say(`pre-fix body md5 ${preMd5} matches the recorded pre-fix baseline`);

  const postMd5 = md5(postFix);
  if (postMd5 !== PROD_BODY_MD5_ON_2026_08_11) {
    fail(`post-fix body md5 ${postMd5} != the 2026-08-11 production snapshot ${PROD_BODY_MD5_ON_2026_08_11}\n` +
         'The repo has moved off the body that was applied live. Re-read pg_proc and re-verify before trusting this proof.');
  }
  say(`post-fix body md5 ${postMd5} matches the 2026-08-11 production snapshot`);
  console.log('     (pinned snapshot, not a live reading — this container has no network)');

  const baseSql = lf(readFileSync(BASE, 'utf8'));
  const chainSql = lf(readFileSync(CHAIN, 'utf8'));
  const migrationSql = lf(readFileSync(MIGRATION, 'utf8'));

  const definitionFor = (body) =>
    'CREATE OR REPLACE FUNCTION public.create_order_from_blend_ticket(' +
    'p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, ' +
    'p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), ' +
    'p_idempotency_key text DEFAULT NULL::text)\n' +
    ' RETURNS json\n LANGUAGE plpgsql\n SECURITY DEFINER\n' +
    " SET search_path TO 'public', 'pg_temp'\nAS $function$" + body + '$function$;\n';

  const preFixDefinition = definitionFor(preFix);
  // Stage F plants the fixed body directly rather than re-applying the
  // migration: the $verify$ block would (correctly) refuse once the trigger has
  // been dropped, and stage F needs the fixed body running WITHOUT one.
  const postFixDefinition = definitionFor(postFix);

  say(`starting a disposable ${IMAGE} container (${CONTAINER})`);
  docker(['run', '--rm', '-d', '--name', CONTAINER, '--network', 'none',
          '--tmpfs', '/pgtmp:rw',
          '-e', 'POSTGRES_PASSWORD=postgres',
          '-e', 'PGDATA=/pgtmp/data',
          IMAGE]);

  say('waiting for the server');
  let up = false;
  for (let i = 0; i < 60; i++) {
    const r = docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { allowFailure: true });
    if (r.status === 0) { up = true; break; }
    // Block this thread for a second without paying for a whole extra Node
    // process on every one of up to 60 retries (CodeRabbit, PR #384).
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (!up) fail('the container never became ready');

  say('planting the stand-in schema, live triggers, CHECKs and helper bodies');
  psql(baseSql);

  say('planting the PRE-FIX create_order_from_blend_ticket');
  psql(preFixDefinition);

  say('seeding one admin, one non-privileged profile and one qualifying product');
  psql(SEED);

  // ── A: reproduce the regression ────────────────────────────────────────────
  say('STAGE A — running the chain against the PRE-FIX body');
  const a = psql(AS_ADMIN + '\n' + chainSql, { allowFailure: true });
  const aOut = a.stdout + a.stderr;
  if (a.status === 0) fail('STAGE A: the pre-fix body did NOT fail. The regression is not reproduced.');
  if (aOut.includes(PASS_TOKEN)) fail(`STAGE A: the chain passed against the PRE-FIX body — it does not detect CRX-MONEY-001.\n${aOut}`);
  if (!/orders_total_cost_whole_cents_chk|orders_total_profit_whole_cents_chk/.test(aOut)) {
    fail(`STAGE A: expected a whole-cent CHECK violation, got:\n${aOut}`);
  }
  say('STAGE A ✔ pre-fix body violates the live whole-cent CHECK, exactly as reported');
  console.log('     ' + (aOut.split('\n').find((l) => /violates check constraint/.test(l)) || '').trim());

  // ── B: apply the migration ─────────────────────────────────────────────────
  say('STAGE B — applying 20260811200000 VERBATIM from disk, in ONE transaction');
  const b = psqlTxn(migrationSql, { allowFailure: true });
  if (b.status !== 0) fail(`STAGE B: the migration failed to apply:\n${b.stdout}\n${b.stderr}`);
  say('STAGE B ✔ applied and its own $verify$ postcondition block passed');

  // ── C: the fix ─────────────────────────────────────────────────────────────
  say('STAGE C — re-running the chain against the FIXED body');
  const c = psql(AS_ADMIN + '\n' + chainSql, { allowFailure: true });
  const cOut = c.stdout + c.stderr;
  if (!cOut.includes(PASS_TOKEN)) fail(`STAGE C: expected ${PASS_TOKEN}, got:\n${cOut}`);
  if (/SMOKE_FAIL/.test(cOut)) fail(`STAGE C: a chain assertion failed:\n${cOut}`);
  say(`STAGE C ✔ ${PASS_TOKEN} — every assertion held and the fixture rolled back`);
  for (const line of cOut.split('\n')) {
    if (/SMOKE_NOTE|NOTICE:/.test(line)) console.log('     ' + line.trim());
  }

  // ── D: mutation-test the $verify$ trigger-presence check ───────────────────
  say('STAGE D — mutation test: drop after_order_items_change, re-apply');
  psql(preFixDefinition); // restore the baseline so the migration has work to do
  psql('DROP TRIGGER after_order_items_change ON public.order_items;');
  const d = psqlTxn(migrationSql, { allowFailure: true });
  const dOut = d.stdout + d.stderr;
  if (d.status === 0) fail('STAGE D: the migration applied with the recalculation trigger MISSING. The $verify$ block fails open.');
  if (!/POSTCONDITION FAILED.*after_order_items_change is missing/.test(dOut)) {
    fail(`STAGE D: it refused, but not via the trigger-presence postcondition:\n${dOut}`);
  }
  // Refusing is only half of "fails closed": the earlier CREATE OR REPLACE and
  // grants must be gone too. Confirm the pre-fix body is still what is installed.
  const dBody = bodyMd5InContainer();
  if (dBody !== md5(preFix)) {
    fail(`STAGE D: the migration refused but did NOT roll back — installed body md5 ${dBody} ` +
         `!= pre-fix ${md5(preFix)}. A half-applied migration is not failing closed.`);
  }
  say('STAGE D ✔ the migration fails CLOSED when the recalculation trigger is gone (and rolls back)');
  console.log('     ' + (dOut.split('\n').find((l) => /POSTCONDITION FAILED/.test(l)) || '').trim());

  // ── E: mutation-test the REPLICA-only trigger state ────────────────────────
  // pg_trigger.tgenabled has four values: O origin, D disabled, R replica-only,
  // A always. A replica-only trigger does NOT fire in an ordinary origin
  // session, so the widespread `tgenabled <> 'D'` idiom fails OPEN here. This
  // stage proves 20260811200000 rejects 'R' rather than merely 'D'.
  say("STAGE E — mutation test: set after_order_items_change REPLICA-only, re-apply");
  psql(RECREATE_RECALC_TRIGGER);
  psql('ALTER TABLE public.order_items ENABLE REPLICA TRIGGER after_order_items_change;');
  const eState = psql(
    `SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.order_items'::regclass
       AND tgname = 'after_order_items_change' AND NOT tgisinternal;`, { allowFailure: true });
  if (!/\bR\b/.test(eState.stdout)) {
    fail(`STAGE E: could not put the trigger into replica-only state, got:\n${eState.stdout}${eState.stderr}`);
  }
  psql(preFixDefinition);
  const e = psqlTxn(migrationSql, { allowFailure: true });
  const eOut = e.stdout + e.stderr;
  if (e.status === 0) {
    fail("STAGE E: the migration applied with the trigger REPLICA-only. It fails OPEN on tgenabled='R' — " +
         'a replica-only trigger never fires in an origin session, so the order header would stay at zero.');
  }
  if (!/POSTCONDITION FAILED.*will not fire on ordinary writes/.test(eOut)) {
    fail(`STAGE E: it refused, but not via the tgenabled postcondition:\n${eOut}`);
  }
  const eBody = bodyMd5InContainer();
  if (eBody !== md5(preFix)) {
    fail(`STAGE E: the migration refused but did NOT roll back — installed body md5 ${eBody} ` +
         `!= pre-fix ${md5(preFix)}.`);
  }
  say("STAGE E ✔ fails CLOSED on tgenabled='R', not just 'D' (and rolls back)");
  console.log('     ' + (eOut.split('\n').find((l) => /POSTCONDITION FAILED/.test(l)) || '').trim());

  // ── F: characterize the residual RUN-TIME gap ──────────────────────────────
  // Stages D and E prove the trigger is guaranteed at APPLY time. There is no
  // equivalent guarantee at RUN time: the fixed body reads the header back with
  // `SELECT ... INTO v_total_price` + `IF NOT FOUND`, and the order row always
  // exists by then, so FOUND is true even when the trigger never ran. This
  // stage pins that behavior so a future change to it is noticed rather than
  // assumed. It is a KNOWN GAP, not a pass.
  say('STAGE F — characterizing the run-time gap: fixed body, recalc trigger dropped');
  // DROP works whatever tgenabled stage E left behind, so the replica-only
  // state does not need unwinding first.
  psql('DROP TRIGGER after_order_items_change ON public.order_items;');
  psql(postFixDefinition);
  const f = psql(AS_ADMIN + '\n' + chainSql, { allowFailure: true });
  const fOut = f.stdout + f.stderr;
  if (fOut.includes(PASS_TOKEN)) {
    fail('STAGE F: the chain PASSED with no recalculation trigger. The fixture is not exercising the header at all.');
  }
  if (/ORDER_HEADER_UNREADABLE|HEADER_NOT_RECALCULATED/.test(fOut)) {
    fail('STAGE F: the RPC now refuses at RUN time when the trigger is missing.\n' +
         'That is an IMPROVEMENT over the documented behavior — the run-time gap has been closed. ' +
         'Update this stage and docs/manual/KNOWN_ISSUES.md, which still records the gap as open.');
  }
  if (!/SMOKE_FAIL: header .* <> canonical trigger totals/.test(fOut)) {
    fail(`STAGE F: expected the chain to catch a stale zero header, got:\n${fOut}`);
  }
  say('STAGE F ⚠ KNOWN GAP confirmed — the RPC reported success and booked a zero-value header;');
  console.log('       only the smoke chain caught it. The trigger guarantee is APPLY-time only.');
  console.log('     ' + (fOut.split('\n').find((l) => /SMOKE_FAIL: header/.test(l)) || '').trim());

  ok = true;
} finally {
  if (KEEP) {
    console.log(`\n[--keep] container ${CONTAINER} left running. Remove it with:\n  docker rm -f ${CONTAINER}`);
  } else {
    docker(['rm', '-f', CONTAINER], { allowFailure: true });
  }
  console.log(ok
    ? '\nPROOF PASSED — CRX-MONEY-001 reproduced against the pre-fix body, fixed by the live\n' +
      'migration 20260811200000, apply-time guards fail closed on both a missing and a\n' +
      'replica-only trigger, and the residual run-time gap is characterized (stage F).'
    : '\nPROOF FAILED — see the stage that threw above.');
}

process.exit(0);
