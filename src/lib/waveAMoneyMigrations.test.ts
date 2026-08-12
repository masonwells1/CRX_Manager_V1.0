import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROUND_HEADER_PATH =
  'supabase/migrations/20260812020000_round_order_header_money.sql';
const COMMISSION_MATH_PATH =
  'supabase/migrations/20260812040000_clamp_negative_commission_remainder.sql';
const SPLIT_CORRECTION_PATH =
  'supabase/migrations/20260812050000_guard_job_commission_split_immutable.sql';

const roundHeaderSql = readFileSync(ROUND_HEADER_PATH, 'utf8').replace(/\r\n/g, '\n');
const commissionMathSql = readFileSync(COMMISSION_MATH_PATH, 'utf8').replace(/\r\n/g, '\n');
const splitCorrectionSql = readFileSync(SPLIT_CORRECTION_PATH, 'utf8').replace(/\r\n/g, '\n');

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} definition is missing`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $function$', start);
  const end = sql.indexOf('$function$;', bodyStart);
  expect(bodyStart, `${name} body is missing`).toBeGreaterThan(start);
  expect(end, `${name} body is unterminated`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, end);
}

describe('Wave A money migration remediation', () => {
  it('derives the order-header profit from rounded price and cost', () => {
    const body = functionBody(roundHeaderSql, '_round_money_to_whole_cents');
    const orders = body.slice(body.indexOf("ELSIF TG_TABLE_NAME = 'orders' THEN"));

    const priceRound = orders.indexOf('NEW.total_price := ROUND(NEW.total_price, 2);');
    const costRound = orders.indexOf('NEW.total_cost := ROUND(NEW.total_cost, 2);');
    const derivedProfit = orders.indexOf(
      'NEW.total_profit := ROUND(NEW.total_price, 2) - ROUND(NEW.total_cost, 2);',
    );

    expect(priceRound).toBeGreaterThan(-1);
    expect(costRound).toBeGreaterThan(priceRound);
    expect(derivedProfit).toBeGreaterThan(costRound);
    expect(orders).toContain(
      'IF NEW.total_price IS NOT NULL AND NEW.total_cost IS NOT NULL THEN',
    );
    expect(orders).toContain('ELSIF NEW.total_profit IS NOT NULL THEN');
  });

  it('uses one job-commission derivation for fresh mints and corrections', () => {
    const mint = functionBody(commissionMathSql, '_insert_commissions_for_job');
    const correction = functionBody(splitCorrectionSql, 'correct_job_commission_split');

    expect(commissionMathSql).toContain(
      'CREATE OR REPLACE FUNCTION public._derive_job_commission_rows(',
    );
    expect(mint).toContain(
      'FROM public._derive_job_commission_rows(p_profit, p_commission_split) d',
    );
    expect(correction).toContain('public._derive_job_commission_rows(');
  });

  it('binds correction idempotency to the complete normalized intent', () => {
    const correction = functionBody(splitCorrectionSql, 'correct_job_commission_split');
    const fingerprint = correction.slice(
      correction.indexOf('v_fingerprint := encode('),
      correction.indexOf("'hex'", correction.indexOf('v_fingerprint := encode(')),
    );

    for (const field of ['actor_id', 'job_id', 'new_split', 'reason']) {
      expect(fingerprint).toContain(`'${field}'`);
    }
    expect(correction.indexOf('SELECT * INTO v_job')).toBeLessThan(
      correction.indexOf('public.check_idempotency_intent('),
    );
    expect(correction).toContain('SET request_fingerprint = v_fingerprint');
    expect(correction).toContain('request_actor_id = v_actor');
    expect(correction).toContain("RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'");
  });

  it('blocks unsafe commission history and audits the full reconciliation', () => {
    const correction = functionBody(splitCorrectionSql, 'correct_job_commission_split');

    expect(correction).toContain("count(*) FILTER (WHERE c.status = 'paid')");
    expect(correction).toContain("count(*) FILTER (WHERE c.status = 'cancelled')");
    expect(correction).toContain('FROM public.commission_payment_items cpi');
    expect(correction).toContain("RAISE EXCEPTION\n      'COMMISSION_CORRECTION_BLOCKED:");
    expect(correction).toContain('AND c.deleted_at IS NULL');
    expect(correction).toContain("'commission_rows_rewritten', v_commission_updated");
    expect(correction).toContain("'commission_rows_reconciled', v_commission_reconciled");
  });

  it('seeds and rolls back the reconciliation probe without borrowing commission rows', () => {
    const postcond = splitCorrectionSql.slice(splitCorrectionSql.indexOf('DO $postcond$'));
    const jobSelection = postcond.slice(
      postcond.indexOf('SELECT j.id, j.commission_split INTO v_job_id'),
      postcond.indexOf('SELECT id INTO v_null_job_id'),
    );
    const commissionFingerprint = postcond.indexOf('INTO v_commission_fp_before');
    const seed = postcond.indexOf('INSERT INTO public.commissions (');
    const rollback = postcond.indexOf("MESSAGE = 'PROBE_OK_ROLLBACK'");
    const residueProof = postcond.indexOf(
      'synthetic commission row(s) survived the probe rollback',
    );

    expect(jobSelection).toContain('WHERE j.commission_split IS NOT NULL');
    expect(jobSelection).not.toContain('public.commissions');
    expect(commissionFingerprint).toBeGreaterThan(-1);
    expect(seed).toBeGreaterThan(commissionFingerprint);
    expect(rollback).toBeGreaterThan(seed);
    expect(residueProof).toBeGreaterThan(rollback);
    expect(postcond).toContain('WHERE id = v_seeded_commission_ids[1]');
    expect(postcond).toContain('cardinality(v_seeded_commission_ids) <> 2');
    expect(postcond).toContain(
      'v_commission_rows_after IS DISTINCT FROM v_commission_rows_before',
    );
  });
});
