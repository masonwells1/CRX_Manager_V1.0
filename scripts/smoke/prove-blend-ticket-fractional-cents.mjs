#!/usr/bin/env node
/**
 * prove-blend-ticket-fractional-cents.mjs
 *
 * End-to-end proof for CRX-MONEY-001 and for
 * supabase/migrations/20260811190000_blend_ticket_order_totals_whole_cents.sql.
 *
 * The live database cannot host this proof: the chain has to INSERT a customer,
 * a blend ticket and an order, and the LIVE-DATA GUARD (correctly) refuses. So a
 * unique PostgreSQL 17 container runs with no network and tmpfs storage, and is
 * force-removed in `finally`.
 *
 * Into it we plant scripts/smoke/fixtures/blend-ticket-fractional-cents-base.sql
 * (live CHECK constraints, both order_items money triggers, and the live bodies
 * of the helper functions) plus the PRE-FIX create_order_from_blend_ticket. That
 * pre-fix body is not transcribed by hand — it is reconstructed from the
 * migration's own post-fix body by reversing the single documented hunk, and the
 * result must md5 to c056d2bf1200fd0fb73a0da54941a8d9, the LF-normalized md5 of
 * the live body. If the reconstruction is off by one byte the run aborts, so a
 * green result also re-proves the migration's baseline claim.
 *
 * Five stages, all of which must land as stated:
 *   A  chain against the PRE-FIX body      -> check_violation on
 *                                             orders_total_cost_whole_cents_chk
 *   B  apply the migration VERBATIM        -> §0 md5 precondition + §0b trigger
 *                                             precondition + self-verify pass
 *   C  chain against the FIXED body        -> SMOKE_PASS_ROLLBACK
 *   D  mutation test: restore the pre-fix body, drop
 *      trg_order_items_round_money, re-apply -> §0b must FAIL CLOSED
 *   E  mutation test: FIXED body, drop after_order_items_change, run the chain
 *      -> the run-time postcondition must refuse rather than book a 0-value order
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

const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260811190000_blend_ticket_order_totals_whole_cents.sql');
const BASE = join(HERE, 'fixtures', 'blend-ticket-fractional-cents-base.sql');
const CHAIN = join(HERE, 'smoke-blend-ticket-fractional-cents.sql');

const BASELINE_MD5 = 'c056d2bf1200fd0fb73a0da54941a8d9';
/**
 * md5 of the block reversePatch() removes. BASELINE_MD5 only certifies that
 * everything OUTSIDE the block is untouched, so on its own it would let an
 * unreviewed statement smuggled INSIDE the block be deleted by the reversal and
 * still reconstruct byte-perfectly. Pinning the removed span closes that: the
 * two md5s together prove the delta is exactly the reviewed hunk and nothing else.
 */
const REPLACED_BLOCK_MD5 = 'bc8ef7a8392cfcd3ac01271c9efb7630';
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

// ── reconstruct the pre-fix body from the migration ──────────────────────────

/** The hunk the migration replaced, verbatim from live pg_proc on 2026-08-11. */
const PREFIX_HUNK = [
  '  -- CHANGED: Removed balance_due from UPDATE (AR tracked via invoices)',
  '  UPDATE orders',
  '  SET total_price = v_total_price,',
  '      total_cost = v_total_cost,',
  '      total_profit = v_total_price - v_total_cost,',
  '      total_margin_pct = CASE WHEN v_total_price > 0 THEN ((v_total_price - v_total_cost) / v_total_price * 100) ELSE 0 END',
  '  WHERE id = v_order_id;',
].join('\n');

function extractPostFixBody(migrationSql) {
  const header = /CREATE OR REPLACE FUNCTION public\.create_order_from_blend_ticket\b/.exec(migrationSql);
  if (!header) fail('could not find the create_order_from_blend_ticket definition in the migration');
  const open = migrationSql.indexOf('AS $function$', header.index);
  if (open === -1) fail('could not find the opening $function$ delimiter');
  const bodyStart = open + 'AS $function$'.length;
  const close = migrationSql.indexOf('$function$', bodyStart);
  if (close === -1) fail('could not find the closing $function$ delimiter');
  return migrationSql.slice(bodyStart, close);
}

function reversePatch(postFixBody) {
  // The replacement is one contiguous block: an explanatory comment run, the
  // canonical re-read, and the run-time postcondition that proves the trigger
  // actually wrote the header. Reverse the whole block back to the raw overwrite.
  //
  // The end is anchored on the FIRST `END IF;` at or after the postcondition's
  // RAISE, not on the re-read's `WHERE`, so the guard is removed along with the
  // rest of the block. Anchoring earlier would leave the guard in the
  // "pre-fix" body and the md5 check below would reject it — fail-closed either
  // way, but this keeps the reconstruction honest instead of merely loud.
  const startMarker = '  -- CRX-MONEY-001: the order header is NOT written here any more.';
  const guardMarker = "'BLEND_TICKET_HEADER_NOT_RECALCULATED";
  const endMarker = '  END IF;';
  const a = postFixBody.indexOf(startMarker);
  if (a === -1) fail('the migration no longer contains the expected replacement block');
  const g = postFixBody.indexOf(guardMarker, a);
  if (g === -1) fail('the migration no longer contains the run-time header postcondition');
  const b = postFixBody.indexOf(endMarker, g);
  if (b === -1) fail('the run-time header postcondition is not closed by an END IF');
  const removed = postFixBody.slice(a, b + endMarker.length);
  const removedMd5 = md5(lf(removed));
  if (removedMd5 !== REPLACED_BLOCK_MD5) {
    fail(`the block being reversed is not the reviewed hunk: md5 ${removedMd5}, expected ${REPLACED_BLOCK_MD5}. `
         + 'Something was added to or changed inside the delta. Re-review it, then update REPLACED_BLOCK_MD5.');
  }
  return postFixBody.slice(0, a) + PREFIX_HUNK + postFixBody.slice(b + endMarker.length);
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

// ── run ──────────────────────────────────────────────────────────────────────

let ok = false;
try {
  say('reconstructing the pre-fix function body from the migration');
  const migrationRaw = readFileSync(MIGRATION, 'utf8');
  const postFix = extractPostFixBody(lf(migrationRaw));
  const preFix = reversePatch(postFix);
  const got = md5(preFix);
  if (got !== BASELINE_MD5) {
    fail(`reconstructed pre-fix body md5 ${got} != live baseline ${BASELINE_MD5}\n` +
         'Either the migration drifted or the reversal is wrong. Refusing to prove against a body that is not live.');
  }
  say(`pre-fix body md5 ${got} matches the live baseline`);

  const baseSql = lf(readFileSync(BASE, 'utf8'));
  const chainSql = lf(readFileSync(CHAIN, 'utf8'));
  const migrationSql = lf(migrationRaw);

  const definitionFor = (body) =>
    'CREATE OR REPLACE FUNCTION public.create_order_from_blend_ticket(' +
    'p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, ' +
    'p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), ' +
    'p_idempotency_key text DEFAULT NULL::text)\n' +
    ' RETURNS json\n LANGUAGE plpgsql\n SECURITY DEFINER\n' +
    " SET search_path TO 'public', 'pg_temp'\nAS $function$" + body + '$function$;\n';

  const preFixDefinition = definitionFor(preFix);
  // Stage E plants the fixed body directly rather than re-applying the
  // migration: §0b would (correctly) refuse once a trigger has been dropped,
  // and stage E needs the fixed body running WITHOUT one.
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
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)'], { timeout: 5000 });
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
  say('STAGE B — applying the migration VERBATIM from disk');
  const b = psql(migrationSql, { allowFailure: true });
  if (b.status !== 0) fail(`STAGE B: the migration failed to apply:\n${b.stdout}\n${b.stderr}`);
  say('STAGE B ✔ §0 md5 precondition, §0b trigger precondition and §1 self-verify all passed');

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

  // ── D: mutation-test the §0b trigger precondition ──────────────────────────
  say('STAGE D — mutation test: drop trg_order_items_round_money, re-apply');
  psql(preFixDefinition); // restore the baseline so §0 passes and §0b is reached
  psql('DROP TRIGGER trg_order_items_round_money ON public.order_items;');
  const d = psql(migrationSql, { allowFailure: true });
  const dOut = d.stdout + d.stderr;
  if (d.status === 0) fail('STAGE D: the migration applied with the rounding trigger MISSING. §0b fails open.');
  if (!/BLEND_TICKET_TOTALS_PRECONDITION|trg_order_items_round_money/.test(dOut)) {
    fail(`STAGE D: it refused, but not via the §0b trigger precondition:\n${dOut}`);
  }
  say('STAGE D ✔ §0b fails CLOSED when the canonical rounding trigger is gone');
  console.log('     ' + (dOut.split('\n').find((l) => /PRECONDITION/.test(l)) || '').trim());

  // ── E: mutation-test the RUN-TIME header postcondition ─────────────────────
  // §0b only proves the triggers exist at APPLY time. This is the other half:
  // with the FIXED body in place, drop the recalculation trigger and confirm the
  // RPC refuses loudly instead of booking an order on the 0/0/0/0 header the
  // INSERT seeded. Without the postcondition this stage returns success:true.
  say('STAGE E — mutation test: fixed body + no recalc trigger, run the chain');
  psql(`
CREATE TRIGGER trg_order_items_round_money
  BEFORE INSERT OR UPDATE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._round_money_to_whole_cents();
`);
  psql(postFixDefinition);
  psql('DROP TRIGGER after_order_items_change ON public.order_items;');
  const e = psql(AS_ADMIN + '\n' + chainSql, { allowFailure: true });
  const eOut = e.stdout + e.stderr;
  if (e.status === 0 || eOut.includes(PASS_TOKEN)) {
    fail('STAGE E: the RPC succeeded with the recalculation trigger MISSING. ' +
         'The run-time header postcondition fails open — a zero-value order would be booked.');
  }
  if (!/BLEND_TICKET_HEADER_NOT_RECALCULATED/.test(eOut)) {
    fail(`STAGE E: it failed, but not via the run-time header postcondition:\n${eOut}`);
  }
  say('STAGE E ✔ the RPC refuses loudly rather than book a zero-value order');
  console.log('     ' + (eOut.split('\n').find((l) => /BLEND_TICKET_HEADER_NOT_RECALCULATED/.test(l)) || '').trim());

  ok = true;
} finally {
  if (KEEP) {
    console.log(`\n[--keep] container ${CONTAINER} left running. Remove it with:\n  docker rm -f ${CONTAINER}`);
  } else {
    docker(['rm', '-f', CONTAINER], { allowFailure: true });
  }
  console.log(ok
    ? '\nPROOF PASSED — CRX-MONEY-001 reproduced, fixed, and the precondition fails closed.'
    : '\nPROOF FAILED — see the stage that threw above.');
}

process.exit(0);
