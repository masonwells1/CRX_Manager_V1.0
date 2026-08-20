import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH =
  'supabase/migrations/20260819232000_bind_draw_down_receipts_to_intent.sql';
const CUTOVER_PATH =
  'supabase/migrations/20260816110000_draw_down_cutover_barrier.sql';
const TIER_SPLIT_PATH =
  'supabase/migrations/20260816120000_draw_down_split_order_lines_by_price_tier.sql';
const ALLOCATED_CENTS_PATH =
  'supabase/migrations/20260817120000_carry_allocated_line_cents_through_lifecycle.sql';
const SMOKE_PATH =
  'scripts/smoke/smoke-draw-down-quote-intent-binding.sql';
const PROVER_PATH =
  'scripts/smoke/prove-draw-down-quote-intent-binding.mjs';

const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
const cutoverSql = readFileSync(CUTOVER_PATH, 'utf8');
const tierSplitSql = readFileSync(TIER_SPLIT_PATH, 'utf8');
const allocatedCentsSql = readFileSync(ALLOCATED_CENTS_PATH, 'utf8');
const smokeSql = readFileSync(SMOKE_PATH, 'utf8');
const proverSource = readFileSync(PROVER_PATH, 'utf8');
const quoteBuilder = readFileSync('src/pages/QuoteBuilder.tsx', 'utf8').replace(/\r\n/g, '\n');
const smokeSpecs = JSON.parse(readFileSync('scripts/smoke/smoke-specs.json', 'utf8'));
const gitAttributes = readFileSync('.gitattributes', 'utf8').replace(/\r\n/g, '\n');

function expectOrdered(source: string, markers: string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker);
    expect(next, `${marker} is missing`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

function functionBodySha256(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${escaped}\\([\\s\\S]*?AS \\$function\\$(\\n[\\s\\S]*?\\n)\\$function\\$;`,
  ));
  expect(match, `${name} body is missing`).not.toBeNull();
  return createHash('sha256').update(match![1], 'utf8').digest('hex');
}

describe('draw_down_quote actor and intent binding migration', () => {
  it('wraps the governed entry point without copying or replacing money math', () => {
    expect(migrationSql).toContain(
      'ALTER FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)\n  RENAME TO _draw_down_quote_intent_impl_20260819;',
    );
    expect(migrationSql).toContain(
      'v_result := public._draw_down_quote_intent_impl_20260819(',
    );
    expect(migrationSql).not.toContain(
      'CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(',
    );

    expect(cutoverSql).toContain('pg_try_advisory_xact_lock_shared(20260816, 1)');
    expect(cutoverSql).toContain('_begin_below_cost_money_write');
    expect(cutoverSql).toContain('_draw_down_quote_below_cost_impl_20260810');
    expect(tierSplitSql).toContain('-- TIERSPLIT<<< emit one order line per booked price tier.');
    expect(tierSplitSql).toContain('quote_item_id       -- PROVENANCE');
  });

  it('pins the exact reviewed tier-split and allocated-cent lifecycle bodies', () => {
    for (const path of [
      ALLOCATED_CENTS_PATH,
      MIGRATION_PATH,
      SMOKE_PATH,
      PROVER_PATH,
    ]) {
      expect(gitAttributes).toContain(`${path} text eol=lf`);
    }
    expect(allocatedCentsSql).not.toContain('\r');
    expect(migrationSql).not.toContain('\r');
    expect(smokeSql).not.toContain('\r');
    expect(proverSource).not.toContain('\r');

    for (const [source, functionName] of [
      [tierSplitSql, '_draw_down_quote_below_cost_impl_20260810'],
      [allocatedCentsSql, '_allocated_cumulative_cents'],
      [allocatedCentsSql, '_allocated_delivery_cents'],
      [allocatedCentsSql, '_complete_delivery_authorized_impl'],
      [allocatedCentsSql, '_create_invoice_for_unbilled_delivery_impl_20260718'],
      [allocatedCentsSql, '_close_undelivered_order_remainder_20260718'],
    ] as const) {
      const expectedHash = functionBodySha256(source, functionName);
      expect(migrationSql).toContain(expectedHash);
    }
    expect(migrationSql).toContain(
      'DRAW_DOWN_INTENT_PREFLIGHT: reviewed pricing/lifecycle prerequisite body drifted',
    );
    expect(migrationSql).toContain(
      'DRAW_DOWN_INTENT_POSTFLIGHT: reviewed pricing/lifecycle prerequisite body changed',
    );
  });

  it('fails closed before replay and preserves cross-representative coverage', () => {
    expectOrdered(migrationSql, [
      'CREATE TEMP TABLE crx_draw_intent_transaction_guard',
      'INSERT INTO crx_draw_intent_transaction_guard(marker) VALUES (true);',
      "SET LOCAL lock_timeout = '15s';",
      'SELECT pg_advisory_xact_lock(20260816, 1);',
      'DO $preflight$',
    ]);
    expectOrdered(migrationSql, [
      '-- DRAW_DOWN_INTENT_BARRIER<<<',
      '-- DRAW_DOWN_INTENT_AUTHZ<<<',
      '-- DRAW_DOWN_INTENT_KEY_LOCK<<<',
      "WHERE id = p_quote_id\n     AND deleted_at IS NULL\n   FOR UPDATE;",
      '-- DRAW_DOWN_INTENT_REPLAY<<<',
      '-- DRAW_DOWN_INTENT_FIRST_CALL<<<',
      '-- DRAW_DOWN_INTENT_BIND<<<',
    ]);
    expect(migrationSql).toContain('v_actor uuid := auth.uid();');
    expect(migrationSql).toContain("RAISE EXCEPTION 'AUTH_REQUIRED';");
    expect(migrationSql).toContain("RAISE EXCEPTION 'ACTOR_MISMATCH';");
    expect(migrationSql).toContain("v_actor_role NOT IN ('admin', 'sales_rep')");
    expect(migrationSql).toContain("RAISE EXCEPTION 'INSUFFICIENT_ROLE';");
    expect(migrationSql).toContain("RAISE EXCEPTION 'Quote not found';");
    expect(migrationSql).not.toContain('NOT_QUOTE_OWNER');
    expect(migrationSql).not.toMatch(/created_by\s+(?:=|IS DISTINCT FROM)\s+v_actor/);
    expect(migrationSql).toContain(
      "hashtextextended('crx:idempotency:' || p_idempotency_key, 0)",
    );
    expect(migrationSql).toContain(
      'IDEMPOTENCY_KEY_REQUIRED: draw_down_quote requires p_idempotency_key',
    );
    expect(migrationSql).toContain("operation = 'draw_down_quote'\n       AND expires_at > now()");
    expect(migrationSql).toContain('unexpired legacy draw_down_quote receipts exist');
    expect(migrationSql).toContain("current_setting('transaction_isolation')");
  });

  it('binds the key to actor, quote, ordered canonical draws, and the saved result', () => {
    const fingerprintStart = migrationSql.indexOf('v_fingerprint := encode(');
    const replayStart = migrationSql.indexOf('v_replay := public.check_idempotency_intent(');
    const fingerprintBlock = migrationSql.slice(fingerprintStart, replayStart);

    expect(fingerprintStart).toBeGreaterThan(-1);
    expect(replayStart).toBeGreaterThan(fingerprintStart);
    expect(fingerprintBlock).toContain("'actor_id', v_actor");
    expect(fingerprintBlock).toContain("'quote_id', p_quote_id");
    expect(fingerprintBlock).toContain("'draws', v_canonical_draws");
    expect(fingerprintBlock).not.toContain('p_below_cost_reason');
    expect(migrationSql).toContain('trim_scale((d.value ->> \'quantity\')::numeric)');
    expect(migrationSql).toContain("pg_input_is_valid(d.value ->> 'quantity', 'numeric')");
    expect(migrationSql).toContain("'NaN'::numeric");
    expect(migrationSql).toContain("'Infinity'::numeric");
    expect(migrationSql).toContain(
      "RAISE EXCEPTION\n      'BOOKING_QUANTITY_INVALID: draw quantity must be finite';",
    );
    expect(migrationSql).toContain('ORDER BY d.ordinality');
    expect(migrationSql).toContain("'draw_down_quote',\n    v_actor,\n    v_fingerprint");
    expect(migrationSql).toContain("NULLIF(v_replay -> 'result' ->> 'order_id', '') IS NULL");
    expect(migrationSql).toContain('SET request_fingerprint = v_fingerprint,\n         request_actor_id = v_actor');
    expect(migrationSql).toContain("RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';");
    expectOrdered(migrationSql, [
      'IDEMPOTENCY_KEY_REQUIRED: draw_down_quote requires p_idempotency_key',
      "'BOOKING_QUANTITY_INVALID: draw quantity must be finite'",
      'v_fingerprint := encode(',
    ]);
    expect(migrationSql).not.toContain(
      'RETURN public._draw_down_quote_intent_impl_20260819(\n      p_quote_id, p_draws, p_performed_by, NULL',
    );
  });

  it('retires rejected draw keys and gives the operator a safe recovery path', () => {
    const drawStart = quoteBuilder.indexOf('const handleDrawDown = async () => {');
    const drawEnd = quoteBuilder.indexOf('const handleConvertToOrder = async () => {', drawStart);
    const drawHandler = quoteBuilder.slice(drawStart, drawEnd);

    expect(drawStart).toBeGreaterThan(-1);
    expect(drawEnd).toBeGreaterThan(drawStart);
    expect(quoteBuilder).toContain(
      "import { getIdempotencyBindingRejection, getIdempotencyMismatchResult } from '../lib/idempotency';",
    );
    expect(drawHandler).toContain('const bindingRejection = getIdempotencyBindingRejection(error);');
    const rejectionHandler = drawHandler.slice(drawHandler.indexOf('if (bindingRejection) {'));
    expectOrdered(rejectionHandler, [
      'if (bindingRejection) {',
      'drawDownIdem.resetKey();',
      "getIdempotencyMismatchResult(error, 'draw_down_quote')",
      'if (committedOrderId) {',
      'navigate(`/orders/${committedOrderId}`);',
      'const balanceReloaded = await openDrawDownModal();',
    ]);
    expect(drawHandler).toContain('const authError = rpcAuthErrorMessage(error);');
    expect(drawHandler).toContain('Only active administrators and sales representatives can draw down bookings.');
    expect(drawHandler).toContain('RpcErrorCodes.BOOKING_QUANTITY_INVALID');
    expect(drawHandler).not.toContain("toast('error', 'IDEMPOTENCY_INTENT_MISMATCH'");
    expect(drawHandler).not.toContain("toast('error', 'IDEMPOTENCY_ACTOR_MISMATCH'");
    expect(quoteBuilder).toContain('const loadGeneration = ++initialLoadGenerationRef.current;');
    expect(quoteBuilder).toContain('initialLoadGenerationRef.current !== loadGeneration');
    expect(quoteBuilder).toContain('cancelAnimationFrame(frame);');
  });

  it('keeps the private chain private and exposes only the reviewed wrapper', () => {
    expect(migrationSql).toContain(
      'REVOKE ALL ON FUNCTION public._draw_down_quote_intent_impl_20260819(uuid, jsonb, uuid, text, text)\n  FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION public._draw_down_quote_intent_impl_20260819(uuid, jsonb, uuid, text, text)\n  TO postgres;',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)\n  TO authenticated;',
    );
    expect(migrationSql).toContain("has_function_privilege('service_role', v_wrapper, 'EXECUTE')");
    expect(migrationSql).toContain('SECURITY DEFINER\nSET search_path = public, pg_temp');
    expect(migrationSql).toContain("pg_get_userbyid(p.proowner) = 'postgres'");
  });

  it('registers a rollback chain that mutation-tests replay, actor, money, and inventory', () => {
    const spec = smokeSpecs.specs.draw_down_quote_intent_binding;
    expect(spec).toBeDefined();
    expect(spec.chain).toBe('smoke-draw-down-quote-intent-binding.sql');
    expect(spec.container_only).toBe(true);
    expect(spec.container_prover).toBe('prove-draw-down-quote-intent-binding.mjs');
    expect(spec.covers).toContain('draw_down_quote');
    expect(spec.area).toEqual(
      expect.arrayContaining(['pricing', 'inventory', 'security', 'idempotency']),
    );

    expect(smokeSql).toContain("'quantity', 1.00");
    expect(smokeSql).toContain("'quantity', 2");
    expect(smokeSql).toContain('IDEMPOTENCY_INTENT_MISMATCH');
    expect(smokeSql).toContain('IDEMPOTENCY_ACTOR_MISMATCH');
    expect(smokeSql).toContain('IDEMPOTENCY_KEY_REQUIRED');
    expect(smokeSql).toContain('request_actor_id = v_rep_a');
    expect(smokeSql).toContain('request_fingerprint IS NOT NULL');
    expect(smokeSql).toContain('oi.price_per_unit = 10.00');
    expect(smokeSql).toContain('oi.cost_at_time_cents = 500');
    expect(smokeSql).toContain('c.commission_amount = 5.00');
    expect(smokeSql).toContain('c.recipient_user_id = v_rep_a');
    expect(smokeSql).toContain('i.quantity_prebooked = 1');
    expect(smokeSql).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';");
    expect(proverSource).toContain("const smokeSql = readFileSync(SMOKE_PATH, 'utf8');");
    expect(proverSource).toContain('/SMOKE_PASS_ROLLBACK/');
    expect(proverSource).toContain('listed.stderr.trim()');
    expect(proverSource).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ;');
    expect(proverSource).toContain('repeatable-read execution is refused before the legacy-receipt scan');
    expect(proverSource).toContain('exclusive cutover lock drains and detects');
    expect(proverSource).toContain('restoreFullSchemaAndRunSmoke();');
  });
});
