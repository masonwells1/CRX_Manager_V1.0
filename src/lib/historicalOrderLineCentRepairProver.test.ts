import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260812154757_repair_historical_order_line_cents.sql',
  'utf8',
);
const prover = readFileSync(
  'scripts/smoke/prove-historical-order-line-cent-repair-live-rollback.mjs',
  'utf8',
);

describe('historical order-line cent repair rollback prover', () => {
  it('supports the published derived-population replay source', () => {
    expect(migration).toContain('SELECT jsonb_agg(');
    expect(migration).toContain('INTO v_approved');
    expect(migration).not.toContain('$approved_rows$');

    expect(prover).not.toContain('migration approved-row map is not readable');
    expect(prover).not.toContain('$approved_rows$');
    expect(prover).toContain('public replay migration no longer derives');
  });

  it('re-derives the rolled-back 16-order population and binds its full digest', () => {
    expect(prover).toContain('SELECT DISTINCT oi.order_id');
    expect(prover).toContain('approved_order_count: 16');
    expect(prover).toContain("snapshot_digest: EXPECTED_DIGEST");
    expect(prover).toContain('dirty_lines: 35');
    expect(prover).toContain('constraint_count: 0');
  });
});
