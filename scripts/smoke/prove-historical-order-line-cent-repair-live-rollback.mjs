#!/usr/bin/env node
/**
 * Executes the exact historical-cent repair migration against the linked CRX
 * database inside a transaction that deliberately raises a pass marker. The
 * error forces PostgreSQL to roll the entire migration back. A second read-only
 * query proves that the 35-row preimage and absent constraint were restored.
 *
 * This is a pre-apply proof, not an apply mechanism. It never commits live data.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260812154757_repair_historical_order_line_cents.sql',
);
const LINKED_WORKDIR = process.env.CRX_SUPABASE_WORKDIR ?? 'C:\\CRX_Manager';
const PASS_TOKEN = 'SMOKE_PASS_ROLLBACK historical_order_line_cent_repair';
const EXPECTED_DIGEST = '0f8ccef3bf6d3291c654d5abb24a151e16ad759851f5eddfc65d1585d7f5b7db';

function runSupabase(args, { allowFailure = false } = {}) {
  const result = spawnSync('supabase', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw new Error(`${result.error?.message ?? ''}\n${result.stderr || result.stdout}`.trim());
  }
  return result;
}

function liveQuery(sql) {
  const result = runSupabase([
    'db', 'query', '--linked', '--workdir', LINKED_WORKDIR,
    '--output-format', 'json', sql,
  ]);
  return JSON.parse(result.stdout);
}

const migration = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
assert.match(
  migration,
  new RegExp(`^-- APPROVED_SET_DIGEST: ${EXPECTED_DIGEST}$`, 'm'),
  'migration is not bound to the approved live snapshot digest',
);
assert.match(
  migration,
  /SELECT jsonb_agg\([\s\S]*?INTO v_approved[\s\S]*?total_price IS DISTINCT FROM ROUND\(oi\.total_price, 2\)/,
  'public replay migration no longer derives the approved dirty-row population under lock',
);

const tempDir = mkdtempSync(path.join(tmpdir(), 'crx-cent-repair-proof-'));
const proofFile = path.join(tempDir, 'proof.sql');

try {
  writeFileSync(
    proofFile,
    `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
${migration}

DO $proof$
DECLARE
  v_dirty bigint;
  v_constraint bigint;
BEGIN
  SELECT count(*)
    INTO v_dirty
    FROM public.order_items
   WHERE total_price IS NOT NULL
     AND (
       total_price IS DISTINCT FROM ROUND(total_price, 2)
       OR NOT (total_price > '-Infinity'::numeric
               AND total_price < 'Infinity'::numeric)
     );

  SELECT count(*)
    INTO v_constraint
    FROM pg_constraint
   WHERE conrelid = 'public.order_items'::regclass
     AND conname = 'order_items_total_price_whole_cents_chk'
     AND contype = 'c'
     AND convalidated;

  IF v_dirty <> 0 OR v_constraint <> 1 THEN
    RAISE EXCEPTION
      'HISTORICAL_CENT_REPAIR_PROOF_FAILED: dirty=% validated_constraint=%',
      v_dirty,
      v_constraint;
  END IF;

  RAISE EXCEPTION '${PASS_TOKEN}';
END
$proof$;

COMMIT;
`,
    'utf8',
  );

  const rehearsal = runSupabase(
    [
      'db', 'query', '--linked', '--workdir', LINKED_WORKDIR,
      '--file', proofFile, '--output-format', 'json',
    ],
    { allowFailure: true },
  );
  const rehearsalOutput = `${rehearsal.stdout}\n${rehearsal.stderr}`;
  assert.notEqual(rehearsal.status, 0, 'rollback proof unexpectedly committed instead of raising');
  assert.match(rehearsalOutput, new RegExp(PASS_TOKEN), 'migration did not reach rollback pass marker');

  const rollbackState = liveQuery(`
    WITH approved_orders AS (
      SELECT DISTINCT oi.order_id
        FROM public.order_items AS oi
       WHERE oi.total_price IS NOT NULL
         AND oi.total_price IS DISTINCT FROM ROUND(oi.total_price, 2)
    ), snapshot_rows AS (
      SELECT 'L'::text AS row_kind,
             oi.id,
             oi.order_id,
             NULL::text AS status,
             oi.total_price,
             oi.profit,
             oi.cost_per_unit,
             oi.total_units_needed,
             NULL::numeric AS total_cost,
             NULL::numeric AS total_profit,
             NULL::numeric AS total_margin_pct
        FROM public.order_items AS oi
        JOIN approved_orders AS a ON a.order_id = oi.order_id
      UNION ALL
      SELECT 'O'::text,
             o.id,
             NULL::uuid,
             o.status,
             o.total_price,
             NULL::numeric,
             NULL::numeric,
             NULL::numeric,
             o.total_cost,
             o.total_profit,
             o.total_margin_pct
        FROM public.orders AS o
        JOIN approved_orders AS a ON a.order_id = o.id
    ), snapshot AS (
      SELECT encode(
               extensions.digest(
                 COALESCE(
                   string_agg(
                     CASE row_kind
                       WHEN 'L' THEN
                         'L|' || id::text || '|' || order_id::text || '|'
                         || COALESCE(total_price::text, '<NULL>') || '|'
                         || COALESCE(profit::text, '<NULL>') || '|'
                         || COALESCE(cost_per_unit::text, '<NULL>') || '|'
                         || COALESCE(total_units_needed::text, '<NULL>')
                       ELSE
                         'O|' || id::text || '|' || COALESCE(status, '<NULL>') || '|'
                         || COALESCE(total_price::text, '<NULL>') || '|'
                         || COALESCE(total_cost::text, '<NULL>') || '|'
                         || COALESCE(total_profit::text, '<NULL>') || '|'
                         || COALESCE(total_margin_pct::text, '<NULL>')
                     END,
                     E'\\n' ORDER BY row_kind, id
                   ),
                   ''
                 ),
                 'sha256'
               ),
               'hex'
             ) AS snapshot_digest
        FROM snapshot_rows
    )
    SELECT json_build_object(
      'dirty_lines', (
        SELECT count(*)
          FROM public.order_items
         WHERE total_price IS NOT NULL
           AND total_price IS DISTINCT FROM ROUND(total_price, 2)
      ),
      'approved_order_count', (SELECT count(*) FROM approved_orders),
      'constraint_count', (
        SELECT count(*)
          FROM pg_constraint
         WHERE conrelid = 'public.order_items'::regclass
           AND conname = 'order_items_total_price_whole_cents_chk'
      ),
      'snapshot_digest', (SELECT snapshot_digest FROM snapshot)
    ) AS rollback_state;
  `);
  const state = rollbackState.rows?.[0]?.rollback_state;
  assert.deepEqual(
    state,
    {
      approved_order_count: 16,
      constraint_count: 0,
      dirty_lines: 35,
      snapshot_digest: EXPECTED_DIGEST,
    },
    'the rollback did not restore the exact approved pre-apply state',
  );

  console.log(
    `HISTORICAL_ORDER_LINE_CENT_REPAIR_LIVE_ROLLBACK_PASS `
    + `approved_digest=${EXPECTED_DIGEST} repaired_in_transaction=35 `
    + 'validated_constraint_in_transaction=1 rollback_dirty_lines=35 '
    + `rollback_constraint_count=0 rollback_digest=${state.snapshot_digest}`,
  );
} catch (error) {
  console.error(`HISTORICAL_ORDER_LINE_CENT_REPAIR_LIVE_ROLLBACK_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
