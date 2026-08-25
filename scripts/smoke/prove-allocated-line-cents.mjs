#!/usr/bin/env node
/**
 * prove-allocated-line-cents.mjs
 *
 * Executable proof for CRX-MONEY-LIFECYCLE-001 and for the migration that
 * fixes it: supabase/migrations/20260817120000_carry_allocated_line_cents_through_lifecycle.sql
 *
 * Why this exists. The tier-split draw-down deliberately makes an order line's
 * `total_price` differ from ROUND(price_per_unit * quantity, 2): when a booking
 * is drawn across price tiers, each new line carries the tier's cumulative
 * rounded value minus the cents already committed. Four downstream sites then
 * threw that allocation away and re-derived the money by multiplying unit price
 * by quantity again, so every fractional segment rounded independently and the
 * total drifted — the order said 25c while the invoice billed 26c.
 *
 * A model of the arithmetic cannot catch that. The defect is a projection bug:
 * the algebra was never wrong, the wrong value was simply read. So this proof
 * runs the REAL functions, against the real money CHECK constraints and the
 * real BEFORE triggers, and asserts on cents actually written to invoice_items
 * and order_items.
 *
 * The live database cannot host it: the chain INSERTs orders, deliveries and
 * invoices, and the LIVE-DATA GUARD (correctly) refuses. So a disposable
 * PostgreSQL container runs with no network and tmpfs storage, force-removed in
 * `finally`.
 *
 * Nothing is transcribed by hand. All five function bodies are sliced out of
 * the migration files that define them and md5-gated:
 *
 *   under test   _complete_delivery_authorized_impl                    20260716120104
 *                _create_invoice_for_unbilled_delivery_impl_20260718   20260719024641
 *                _close_undelivered_order_remainder_20260718           20260721014858
 *   real guards  _enforce_below_cost_line                              20260812115237
 *                _round_money_to_whole_cents                           20260809230500
 *
 * Each md5 is pinned to what production held on 2026-08-17. These are PINNED
 * HISTORICAL SNAPSHOTS, not live readings — the container has no network. A
 * match proves the repository file still equals what production held on that
 * date. To re-confirm current parity, run against production:
 *
 *   SELECT p.proname, length(p.prosrc), md5(p.prosrc)
 *     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 *    WHERE n.nspname = 'public' AND p.proname = ANY(ARRAY[...]);
 *
 * Note _close_undelivered_order_remainder_20260718 is stored with CRLF line
 * endings live while the other two are LF. The prover reproduces that byte for
 * byte, so the migration's own md5 precondition block is exercised for real
 * here instead of being silently skipped.
 *
 * Three stages, all of which must land as stated:
 *   A  plant the PRE-FIX bodies, run the chain -> must fail ALLOCATION_DRIFT,
 *      naming every one of the six scenarios. If the chain passes here, the
 *      chain is not actually testing anything and the proof refuses.
 *   B  apply the migration VERBATIM, in ONE transaction -> its own md5
 *      preconditions and its $verify$ postconditions must both pass.
 *   C  run the same chain again -> SMOKE_PASS_ROLLBACK.
 *
 * Usage: node scripts/smoke/prove-allocated-line-cents.mjs [--keep]
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

const MIGRATION = join(MIGRATIONS, '20260817120000_carry_allocated_line_cents_through_lifecycle.sql');
const BASE = join(HERE, 'fixtures', 'allocated-line-cents-base.sql');
const CHAIN = join(HERE, 'smoke-allocated-line-cents.sql');

const IMAGE = 'postgres:17-alpine';
const CONTAINER = `crx-allocated-line-cents-${process.pid}`;
const KEEP = process.argv.includes('--keep');

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const lf = (s) => s.replace(/\r\n/g, '\n');
const say = (m) => console.log(`  ${m}`);

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exitCode = 1;
  throw new Error('PROOF_FAILED');
}

/**
 * The five bodies this proof plants, each pinned to the production snapshot
 * taken 2026-08-17. `crlf` marks the one body production stores with CRLF.
 */
const BODIES = [
  {
    key: 'completeDelivery',
    file: '20260716120104_gauntlet_access_boundaries.sql',
    needle: 'CREATE OR REPLACE FUNCTION public.complete_delivery(',
    md5: 'e58470546605ad93a1fff722315d6d09',
    len: 25079,
    crlf: false,
    signature:
      'CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(' +
      'p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, ' +
      'p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, ' +
      'p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, ' +
      'p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)\n' +
      ' RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO \'public\', \'pg_temp\'\n',
  },
  {
    key: 'backfillInvoice',
    file: '20260719024641_lock_backfill_split_allocation_rows.sql',
    needle: 'CREATE OR REPLACE FUNCTION public.create_invoice_for_unbilled_delivery(',
    md5: '2fc0102fe8702f6c2d63c326a99c15dd',
    len: 5558,
    crlf: false,
    signature:
      'CREATE OR REPLACE FUNCTION public._create_invoice_for_unbilled_delivery_impl_20260718(' +
      'p_delivery_id uuid, p_performed_by uuid DEFAULT NULL::uuid, ' +
      'p_idempotency_key text DEFAULT NULL::text)\n' +
      ' RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO \'public\', \'pg_temp\'\n',
  },
  {
    key: 'closeRemainder',
    file: '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql',
    needle: 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(',
    // Production stores this body with CRLF; the md5 below is of the CRLF form.
    md5: 'e2d4b46c47be7561a8829191c30dc0a7',
    len: 15910,
    crlf: true,
    signature:
      'CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(' +
      'p_order_id uuid, p_actor uuid)\n' +
      ' RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp\n',
  },
];

/**
 * Returns the single function body opened by the dollar-quote tag that follows
 * `needle` in `file`. Refuses if the needle is absent or appears more than
 * once, so a migration that re-emits the function cannot silently hand back
 * the wrong definition.
 */
function extractBody(file, needle, label) {
  const raw = readFileSync(join(MIGRATIONS, file), 'utf8');
  const occurrences = raw.split(needle).length - 1;
  if (occurrences !== 1) {
    fail(`${label}: expected exactly 1 definition in ${file}, found ${occurrences}`);
  }
  const start = raw.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(raw.slice(start));
  if (!tag) fail(`${label}: no dollar-quote delimiter after the signature in ${file}`);
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = raw.indexOf(tag[0], bodyStart);
  if (bodyEnd < 0) fail(`${label}: unterminated ${tag[0]} body in ${file}`);
  return lf(raw.slice(bodyStart, bodyEnd));
}

function docker(args, { input, allowFailure = false } = {}) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 300_000 });
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
 * transaction, so a failing postcondition leaves nothing half-applied behind.
 */
const psqlTxn = (sql, opts = {}) =>
  docker(['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q',
          '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { input: sql, ...opts });

let ok = false;
try {
  say('slicing the three lifecycle bodies out of their migration files');
  const planted = [];
  for (const b of BODIES) {
    const bodyLf = extractBody(b.file, b.needle, b.key);
    const body = b.crlf ? bodyLf.replace(/\n/g, '\r\n') : bodyLf;
    const got = md5(body);
    if (got !== b.md5 || body.length !== b.len) {
      fail(`${b.key}: body is md5 ${got} length ${body.length}, but the pinned ` +
           `2026-08-17 production snapshot is md5 ${b.md5} length ${b.len}.\n` +
           'The repo has moved off the body that is live. Re-read pg_proc and ' +
           're-verify before trusting this proof.');
    }
    say(`  ${b.key} md5 ${got} (${body.length} bytes${b.crlf ? ', CRLF as live' : ''}) matches`);
    planted.push(b.signature + `AS $planted_${b.key}$` + body + `$planted_${b.key}$;\n`);
  }
  console.log('     (pinned snapshots, not live readings — this container has no network)');

  const baseSql = lf(readFileSync(BASE, 'utf8'));
  const chainSql = lf(readFileSync(CHAIN, 'utf8'));
  const migrationSql = lf(readFileSync(MIGRATION, 'utf8'));

  say(`starting a disposable ${IMAGE} container (${CONTAINER})`);
  docker(['run', '--rm', '-d', '--name', CONTAINER, '--network', 'none',
          '--tmpfs', '/pgtmp:rw',
          '-e', 'POSTGRES_PASSWORD=postgres',
          '-e', 'PGDATA=/pgtmp/data',
          IMAGE]);

  say('waiting for the server');
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    const r = docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { allowFailure: true });
    if (r.status === 0) { up = true; break; }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)'], { timeout: 2000 });
  }
  if (!up) fail('the container never became ready');

  const version = psql("\\pset tuples_only on\n\\pset format unaligned\nSELECT version();").stdout.trim();
  say(`server: ${version.split(' ').slice(0, 2).join(' ')}`);

  // ── stage A ───────────────────────────────────────────────────────────────
  say('');
  say('STAGE A — pre-fix bodies: the chain must report drift');
  psql(baseSql);
  psql(planted.join('\n'));
  const a = psql(chainSql, { allowFailure: true });
  const aOut = `${a.stdout}\n${a.stderr}`;
  if (aOut.includes('SMOKE_PASS_ROLLBACK')) {
    fail('the chain PASSED against the pre-fix bodies. It is not testing the defect — ' +
         'refusing to certify the fix off a chain that cannot fail.');
  }
  if (!aOut.includes('ALLOCATION_DRIFT')) {
    fail(`expected ALLOCATION_DRIFT from the pre-fix bodies, got:\n${aOut}`);
  }
  const scenarios = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  const missed = scenarios.filter((s) => !aOut.includes(`${s} `));
  if (missed.length) {
    fail(`the pre-fix chain did not flag ${missed.join(', ')}. ` +
         `Every scenario must demonstrate the defect.\n${aOut}`);
  }
  say('  all six scenarios reported drift against the pre-fix bodies:');
  const drift = /ALLOCATION_DRIFT[^\n]*/.exec(aOut);
  if (drift) console.log(`     ${drift[0].replace(/ \| /g, '\n     ')}`);

  // ── stage B ───────────────────────────────────────────────────────────────
  say('');
  say('STAGE B — applying the migration verbatim, in one transaction');
  psqlTxn(migrationSql);
  say('  md5 preconditions and $verify$ postconditions both passed');

  // ── stage C ───────────────────────────────────────────────────────────────
  say('');
  say('STAGE C — fixed bodies: the same chain must pass');
  const c = psql(chainSql, { allowFailure: true });
  const cOut = `${c.stdout}\n${c.stderr}`;
  if (!cOut.includes('SMOKE_PASS_ROLLBACK')) {
    fail(`the chain still fails after the migration:\n${cOut}`);
  }
  say('  SMOKE_PASS_ROLLBACK — all six scenarios bill exactly the allocated cents');

  ok = true;
} catch (err) {
  if (err.message !== 'PROOF_FAILED') {
    console.error(`\nFAIL: unexpected error: ${err.stack || err.message}`);
    process.exitCode = 1;
  }
} finally {
  if (KEEP) {
    console.log(`\n(--keep) container left running: ${CONTAINER}`);
  } else {
    spawnSync('docker', ['rm', '-f', CONTAINER], { encoding: 'utf8', timeout: 60_000 });
  }
  console.log(ok
    ? '\nPASS: CRX-MONEY-LIFECYCLE-001 reproduced against the pre-fix bodies and closed by 20260817120000.'
    : '\nPROOF DID NOT PASS.');
}
