import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const ORDER_COST_PATH =
  'supabase/migrations/20260813010000_wave_a_order_cost_authority_and_finiteness.sql';
const ROUND_HEADER_PATH =
  'supabase/migrations/20260813020000_round_order_header_money.sql';
const COMMISSION_MATH_PATH =
  'supabase/migrations/20260813040000_clamp_negative_commission_remainder.sql';
const SPLIT_CORRECTION_PATH =
  'supabase/migrations/20260813050000_guard_job_commission_split_immutable.sql';
const FINITENESS_PATH =
  'supabase/migrations/20260813030000_reject_non_finite_money_and_quantities.sql';
const DELIVERY_BILLING_PATH =
  'supabase/migrations/20260813060000_require_completed_delivery_before_invoice_post.sql';
const COMMISSION_BASIS_PATH =
  'supabase/migrations/20260810150000_commission_basis_from_canonical_order_header.sql';
const BELOW_COST_PATH =
  'supabase/migrations/20260812154028_enforce_below_cost_admin_approval.sql';
const BLEND_HEADER_ASSERT_PATH =
  'supabase/migrations/20260812010000_blend_ticket_order_header_runtime_assert.sql';

const orderCostSql = readFileSync(ORDER_COST_PATH, 'utf8').replace(/\r\n/g, '\n');
const roundHeaderSql = readFileSync(ROUND_HEADER_PATH, 'utf8').replace(/\r\n/g, '\n');
const commissionMathSql = readFileSync(COMMISSION_MATH_PATH, 'utf8').replace(/\r\n/g, '\n');
const splitCorrectionSql = readFileSync(SPLIT_CORRECTION_PATH, 'utf8').replace(/\r\n/g, '\n');
const finitenessSql = readFileSync(FINITENESS_PATH, 'utf8').replace(/\r\n/g, '\n');
const deliveryBillingSql = readFileSync(DELIVERY_BILLING_PATH, 'utf8').replace(/\r\n/g, '\n');
const commissionBasisSql = readFileSync(COMMISSION_BASIS_PATH, 'utf8').replace(/\r\n/g, '\n');
const belowCostSql = readFileSync(BELOW_COST_PATH, 'utf8').replace(/\r\n/g, '\n');
const blendHeaderAssertSql = readFileSync(BLEND_HEADER_ASSERT_PATH, 'utf8').replace(/\r\n/g, '\n');

function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} definition is missing`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $function$', start);
  const end = sql.indexOf('$function$;', bodyStart);
  expect(bodyStart, `${name} body is missing`).toBeGreaterThan(start);
  expect(end, `${name} body is unterminated`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart, end);
}

function storedFunctionSource(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} definition is missing`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $function$', start);
  const end = sql.indexOf('$function$;', bodyStart);
  expect(bodyStart, `${name} body is missing`).toBeGreaterThan(start);
  expect(end, `${name} body is unterminated`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart + 'AS $function$'.length, end);
}

function storedFunctionSourceFromDeclaration(sql: string, declaration: string): string {
  const start = sql.indexOf(declaration);
  expect(start, `${declaration} definition is missing`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $function$', start);
  const end = sql.indexOf('$function$;', bodyStart);
  expect(bodyStart, `${declaration} body is missing`).toBeGreaterThan(start);
  expect(end, `${declaration} body is unterminated`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart + 'AS $function$'.length, end);
}

function md5(source: string): string {
  return createHash('md5').update(source).digest('hex');
}

describe('Wave A money migration remediation', () => {
  it('extends the private direct-order implementation without clobbering the below-cost wrapper', () => {
    const precond = orderCostSql.slice(
      orderCostSql.indexOf('DO $precond$'),
      orderCostSql.indexOf('$precond$;') + '$precond$;'.length,
    );
    const postcond = orderCostSql.slice(orderCostSql.indexOf('DO $postcond$'));
    const baselineImplementation = storedFunctionSource(
      commissionBasisSql,
      'create_direct_order',
    );
    const governedWrapper = storedFunctionSourceFromDeclaration(
      belowCostSql,
      'CREATE FUNCTION public.create_direct_order(',
    );

    expect(md5(baselineImplementation)).toBe('c761f4c46dc12ea07efd74af5b2ada54');
    expect(md5(governedWrapper)).toBe('f18495ee041dafa152e736ce93c0452f');
    expect(precond).toContain('c761f4c46dc12ea07efd74af5b2ada54');
    expect(precond).toContain('f18495ee041dafa152e736ce93c0452f');
    expect(orderCostSql).toContain(
      'CREATE OR REPLACE FUNCTION public._create_direct_order_below_cost_impl_20260810(',
    );
    expect(orderCostSql).not.toContain(
      'CREATE OR REPLACE FUNCTION public.create_direct_order(',
    );
    expect(postcond).toContain("v_public_src NOT LIKE '%_begin_below_cost_money_write%'");
    expect(postcond).toContain(
      "v_public_src NOT LIKE '%_create_direct_order_below_cost_impl_20260810%'",
    );
    expect(postcond).toContain(
      "has_function_privilege('authenticated', 'public._create_direct_order_below_cost_impl_20260810(uuid, date, text, text, jsonb, uuid, text, text)', 'EXECUTE')",
    );
  });

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

  it('pins the repaired blend-ticket predecessor instead of its obsolete raw header writer', () => {
    const precond = roundHeaderSql.slice(
      roundHeaderSql.indexOf('DO $precond$'),
      roundHeaderSql.indexOf('$precond$;') + '$precond$;'.length,
    );
    const predecessor = storedFunctionSource(
      blendHeaderAssertSql,
      'create_order_from_blend_ticket',
    );

    expect(md5(predecessor)).toBe('344532c6522cce26857ce4ffd9597125');
    expect(precond).toContain('344532c6522cce26857ce4ffd9597125');
    expect(precond).toContain("p.prosrc NOT LIKE '%SET total_price = v_total_price%'");
    expect(precond).toContain("p.prosrc LIKE '%ORDER_HEADER_NOT_RECALCULATED%'");
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

  it('hardens commission-minting helper grants and keeps the empty-schema probe runnable', () => {
    const postcond = commissionMathSql.slice(commissionMathSql.indexOf('DO $postcond$'));

    expect(commissionMathSql).toContain(
      'REVOKE ALL ON FUNCTION public._insert_commissions_for_order(uuid, uuid, numeric, jsonb, date)',
    );
    expect(commissionMathSql).toContain(
      'REVOKE ALL ON FUNCTION public._insert_commissions_for_job(uuid, uuid, uuid, numeric, jsonb, date)',
    );
    expect(postcond).toContain("unnest(ARRAY['anon', 'authenticated', 'service_role', 'public'])");
    expect(postcond).toContain(")), '[]'::jsonb))");
    expect(postcond).toContain("jsonb_array_length(v_split->'splits') <> 4");
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

  it('pins both ends of every Wave A commission function replay instead of trusting a marker', () => {
    const commissionPrecond = commissionMathSql.slice(
      commissionMathSql.indexOf('DO $precond$'),
      commissionMathSql.indexOf('$precond$;') + '$precond$;'.length,
    );
    const correctionPrecond = splitCorrectionSql.slice(
      splitCorrectionSql.indexOf('DO $precond$'),
      splitCorrectionSql.indexOf('$precond$;') + '$precond$;'.length,
    );

    const commissionPins: Record<string, string> = {
      _insert_commissions_for_order: '42b511d845c0ea150cfd61ed781d966c',
      _insert_commissions_for_job: '4616a2444837c25b9766469722ce477a',
      _derive_job_commission_rows: 'cf0fa9a7085fc523873581478d199f29',
      _save_invoice_scoped_impl: '6c3f064160e177b551a42f68717da055',
    };
    for (const [name, expectedMd5] of Object.entries(commissionPins)) {
      expect(md5(storedFunctionSource(commissionMathSql, name))).toBe(expectedMd5);
      expect(commissionPrecond).toContain(expectedMd5);
    }

    const correctionPins: Record<string, string> = {
      _guard_job_commission_split_immutable: 'a7f35f20abba77c38c542f6ff0524430',
      correct_job_commission_split: '0bf3f0dee2644bfc2ae642dd00119f96',
    };
    for (const [name, expectedMd5] of Object.entries(correctionPins)) {
      expect(md5(storedFunctionSource(splitCorrectionSql, name))).toBe(expectedMd5);
      expect(correctionPrecond).toContain(expectedMd5);
    }

    expect(commissionPrecond).not.toContain(
      "IF position('WAVE-A-CLAMP-2026-08-09' in v_src) > 0 THEN",
    );
    expect(correctionPrecond).not.toContain('position(\'WAVE-A-JOBSPLIT-FREEZE-2026-08-09\' in p.prosrc) > 0');
    expect(commissionMathSql).toContain('md5(p.prosrc) = \'42b511d845c0ea150cfd61ed781d966c\'');
    expect(splitCorrectionSql).toContain('p.proowner = j.relowner');
  });

  it('adds finiteness constraints only when absent and refuses changed definitions', () => {
    const install = finitenessSql.slice(
      finitenessSql.indexOf('DO $finiteness$'),
      finitenessSql.indexOf('$finiteness$;') + '$finiteness$;'.length,
    );
    const declaredConstraints = install.match(/'[^']+_finite_chk'/g) ?? [];

    expect(declaredConstraints).toHaveLength(30);
    expect(install).toContain('FOR v_table, v_column, v_constraint IN');
    expect(install).toContain('pg_get_constraintdef(c.oid)');
    expect(install).toContain("regexp_replace(lower(v_found_def), '[[:space:]()]', '', 'g')");
    expect(install).toContain('possibly stronger later constraint');
    expect(install).toContain('ALTER TABLE public.%1$I ADD CONSTRAINT %2$I CHECK');
    expect(install).not.toContain('DROP CONSTRAINT');
    expect(finitenessSql).toContain('POSTCOND: constraint %.% is missing or not validated');
  });

  it('drives authenticated migration probes through Supabase auth.uid subject claims', () => {
    for (const sql of [splitCorrectionSql, deliveryBillingSql]) {
      expect(sql).toContain('SET LOCAL request.jwt.claim.sub');
      expect(sql).toContain("set_config('request.jwt.claim.sub', '', true)");
      expect(sql).not.toContain('request.jwt.claims');
    }
  });

  it('requires a row-bound completion RPC handoff before a delivery can become completed', () => {
    const guardStart = deliveryBillingSql.indexOf(
      'CREATE FUNCTION public._guard_delivery_completion_authorized()',
    );
    const guardEnd = deliveryBillingSql.indexOf('$function$;', guardStart);
    const guard = deliveryBillingSql.slice(guardStart, guardEnd);
    const wrapper = functionBody(deliveryBillingSql, 'complete_delivery');
    const postcond = deliveryBillingSql.slice(deliveryBillingSql.indexOf('DO $postcond$'));

    expect(guard).toContain('current_setting(\'crx.delivery_completion_authorized\', true)');
    expect(guard).toContain('OLD.id::text');
    expect(guard).toContain('DELIVERY_COMPLETION_RPC_REQUIRED');
    expect(guard).not.toContain('app.admin_override');
    expect(deliveryBillingSql).toContain(
      'CREATE TRIGGER trg_guard_delivery_completion_authorized\n  BEFORE UPDATE OF status ON public.deliveries',
    );

    expect(wrapper).toContain(
      "set_config('crx.delivery_completion_authorized', p_delivery_id::text, true)",
    );
    expect(wrapper).toContain("set_config('crx.delivery_completion_authorized', '', true)");
    expect(wrapper).toContain('public._complete_delivery_period_preflight_impl');

    const directRefusal = postcond.indexOf('the direct-completion refuse path did not run');
    const authorizedCompletion = postcond.indexOf('v_completion_result := public.complete_delivery(');
    const residueProof = postcond.indexOf('crx.delivery_completion_authorized still set');
    const rollback = postcond.indexOf("MESSAGE = 'PROBE_OK_ROLLBACK'");
    expect(directRefusal).toBeGreaterThan(-1);
    expect(authorizedCompletion).toBeGreaterThan(directRefusal);
    expect(residueProof).toBeGreaterThan(authorizedCompletion);
    expect(rollback).toBeGreaterThan(residueProof);
  });

  it('revokes every client role from the delivery-completion trigger guard when present', () => {
    const guardStart = deliveryBillingSql.indexOf(
      'CREATE FUNCTION public._guard_delivery_completion_authorized()',
    );
    const guardEnd = deliveryBillingSql.indexOf(
      'CREATE TRIGGER trg_guard_delivery_completion_authorized',
      guardStart,
    );
    const guardInstall = deliveryBillingSql.slice(guardStart, guardEnd);

    expect(guardInstall).toContain(
      'REVOKE ALL ON FUNCTION public._guard_delivery_completion_authorized() FROM PUBLIC;',
    );
    expect(guardInstall).toContain(
      "FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP",
    );
    expect(guardInstall).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN",
    );
    expect(guardInstall).toContain(
      "'REVOKE ALL ON FUNCTION public._guard_delivery_completion_authorized() FROM %I'",
    );
  });
});
