import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260813053545_allocate_multi_price_quote_draws.sql',
  'utf8',
);
const smoke = readFileSync(
  'scripts/smoke/smoke-below-cost-quote-lifecycle.sql',
  'utf8',
);

describe('draw-down quote cent allocation migration', () => {
  it('replaces only the private implementation and preserves the governed wrapper', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(',
    );
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION public.draw_down_quote(',
    );
    expect(migration).toContain(
      "p.proname = 'draw_down_quote'",
    );
    expect(migration).toContain(
      "v_wrapper_total <> 1 OR v_wrapper_exact <> 1",
    );
  });

  it('fails closed on predecessor drift and pins the complete installed body', () => {
    expect(migration).toContain(
      '26b7a461a1e4f99b1783d7d38788e361031756000abf80a5e97efdb7da37cc64',
    );
    expect(migration).toContain(
      'f842e27fb5d4e73395bb0b1d70f0f3cdf41481ba1977b70552194c899bf74d05',
    );
    expect(migration).toContain(
      '514c4859719a4de2fb24ba7ebdc776297df20caa70354adb626960f58ea1c0f2',
    );
    expect(migration).toContain('DRAW_DOWN_CENT_ALLOCATION_PRECONDITION_DRIFTED');
    expect(migration).toContain('octet_length(p.prosrc) = 15019');
    expect(migration).toContain('octet_length(p.prosrc) = 13223');
    expect(migration).toContain("p.proacl <@ ARRAY['postgres=X/postgres']::aclitem[]");
  });

  it('allocates each partial draw as a cumulative cent delta', () => {
    expect(migration).toContain(
      'ROUND(v_booked_price_total * (v_consumed_before + v_qty) / v_booked, 2)',
    );
    expect(migration).toContain(
      '- ROUND(v_booked_price_total * v_consumed_before / v_booked, 2)',
    );
    expect(migration).toContain(
      'FLOOR((v_line_total / v_qty) * 100) / 100',
    );
    expect(migration).not.toContain(
      'SUM(qi.price_per_unit * COALESCE(qi.total_units_needed, 0)) /',
    );
  });

  it('keeps the implementation private and the security contract pinned', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain(
      'FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(migration).toContain('DRAW_DOWN_CENT_ALLOCATION_IMPL_ACL_DRIFT');
  });

  it('has a rollback regression for two same-product one-unit partial draws', () => {
    expect(smoke).toContain("'[SMOKE] Q-multi-price-' || v_sfx");
    expect(smoke).toContain('10.01,');
    expect(smoke).toContain("'smoke-q-multi-price-one-' || v_sfx");
    expect(smoke).toContain("'smoke-q-multi-price-two-' || v_sfx");
    expect(smoke).toContain("<> 20.01");
    expect(smoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
  });
});
