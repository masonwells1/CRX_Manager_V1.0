import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH =
  'supabase/migrations/20260819232000_bind_draw_down_receipts_to_intent.sql';
const CUTOVER_PATH =
  'supabase/migrations/20260816110000_draw_down_cutover_barrier.sql';
const TIER_SPLIT_PATH =
  'supabase/migrations/20260816120000_draw_down_split_order_lines_by_price_tier.sql';
const SMOKE_PATH =
  'scripts/smoke/smoke-draw-down-quote-intent-binding.sql';

const migrationSql = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');
const cutoverSql = readFileSync(CUTOVER_PATH, 'utf8').replace(/\r\n/g, '\n');
const tierSplitSql = readFileSync(TIER_SPLIT_PATH, 'utf8').replace(/\r\n/g, '\n');
const smokeSql = readFileSync(SMOKE_PATH, 'utf8').replace(/\r\n/g, '\n');
const smokeSpecs = JSON.parse(readFileSync('scripts/smoke/smoke-specs.json', 'utf8'));

function expectOrdered(source: string, markers: string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker);
    expect(next, `${marker} is missing`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe('draw_down_quote actor and intent binding migration', () => {
  it('wraps the governed entry point without copying or replacing money math', () => {
    expect(migrationSql).toContain(
      'ALTER FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)\n  RENAME TO _draw_down_quote_intent_impl_20260819;',
    );
    expect(migrationSql).toContain(
      'RETURN public._draw_down_quote_intent_impl_20260819(',
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

  it('fails closed before replay and preserves cross-representative coverage', () => {
    expectOrdered(migrationSql, [
      '-- DRAW_DOWN_INTENT_BARRIER<<<',
      '-- DRAW_DOWN_INTENT_AUTHZ<<<',
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
    expect(migrationSql).toContain('ORDER BY d.ordinality');
    expect(migrationSql).toContain("'draw_down_quote',\n    v_actor,\n    v_fingerprint");
    expect(migrationSql).toContain("NULLIF(v_replay -> 'result' ->> 'order_id', '') IS NULL");
    expect(migrationSql).toContain('SET request_fingerprint = v_fingerprint,\n         request_actor_id = v_actor');
    expect(migrationSql).toContain("RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';");
  });

  it('keeps the private chain private and exposes only the reviewed wrapper', () => {
    expect(migrationSql).toContain(
      'REVOKE ALL ON FUNCTION public._draw_down_quote_intent_impl_20260819(uuid, jsonb, uuid, text, text)\n  FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION public._draw_down_quote_intent_impl_20260819(uuid, jsonb, uuid, text, text)\n  TO postgres;',
    );
    expect(migrationSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.draw_down_quote(uuid, jsonb, uuid, text, text)\n  TO authenticated, service_role;',
    );
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
    expect(smokeSql).toContain('request_actor_id = v_rep_a');
    expect(smokeSql).toContain('request_fingerprint IS NOT NULL');
    expect(smokeSql).toContain('oi.price_per_unit = 10.00');
    expect(smokeSql).toContain('oi.cost_at_time_cents = 500');
    expect(smokeSql).toContain('i.quantity_prebooked = 1');
    expect(smokeSql).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';");
  });
});
