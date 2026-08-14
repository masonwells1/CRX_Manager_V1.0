import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const BASELINE_PATH =
  'supabase/migrations/20260812151606_quote_items_cost_at_quote_snapshot.sql';
const MIGRATION_PATH =
  'supabase/migrations/20260813161614_restrict_draw_down_quote_owner.sql';
const SMOKE_PATH =
  'scripts/smoke/smoke-draw-down-quote-owner-boundary.sql';

const baselineSql = readFileSync(BASELINE_PATH, 'utf8').replace(/\r\n/g, '\n');
const migrationSql = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');
const smokeSql = readFileSync(SMOKE_PATH, 'utf8').replace(/\r\n/g, '\n');
const smokeSpecs = JSON.parse(readFileSync('scripts/smoke/smoke-specs.json', 'utf8'));
const capturedProver = readFileSync(
  'scripts/smoke/prove-pricing-audit-real-schema.mjs',
  'utf8',
).replace(/\r\n/g, '\n');

function storedFunctionSource(sql: string, declaration: string): string {
  const start = sql.indexOf(declaration);
  expect(start, `${declaration} is missing`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf('AS $function$', start);
  const bodyEnd = sql.indexOf('$function$;', bodyStart);
  expect(bodyStart, `${declaration} body is missing`).toBeGreaterThan(start);
  expect(bodyEnd, `${declaration} body is unterminated`).toBeGreaterThan(bodyStart);
  return sql.slice(bodyStart + 'AS $function$'.length, bodyEnd);
}

function md5(source: string): string {
  return createHash('md5').update(source).digest('hex');
}

describe('draw_down_quote owner and deletion boundary migration', () => {
  it('pins the exact applied private body and changes only authorization plus cent settlement', () => {
    const baselineBody = storedFunctionSource(
      baselineSql,
      'CREATE OR REPLACE FUNCTION public.draw_down_quote(',
    );
    const patchedBody = storedFunctionSource(
      migrationSql,
      'CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(',
    );
    const newGuard = [
      '  IF NOT FOUND OR v_quote.deleted_at IS NOT NULL THEN',
      "    RAISE EXCEPTION 'Quote not found';",
      '  END IF;',
      "  IF v_actor_role <> 'admin' AND v_quote.created_by IS DISTINCT FROM v_actor THEN",
      "    RAISE EXCEPTION 'NOT_QUOTE_OWNER';",
      '  END IF;',
      '',
    ].join('\n');

    expect(md5(baselineBody)).toBe('87bf7adcdc63d94684676da5ab09bfde');
    expect(md5(patchedBody)).toBe('2ff7a345a555b1cdeee16a890bb65034');
    expect(
      patchedBody
        .replace(
          newGuard,
          "  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;\n\n",
        )
        .replace('    v_wavg_price := ROUND(v_wavg_price, 2);\n', '')
        .replace(/^[ \t]*--.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe(
      baselineBody.replace(/^[ \t]*--.*$/gm, '').replace(/\s+/g, ' ').trim(),
    );
  });

  it('settles weighted price and cost before deriving order-line money', () => {
    const body = storedFunctionSource(
      migrationSql,
      'CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(',
    );
    const roundedPrice = body.indexOf('v_wavg_price := ROUND(v_wavg_price, 2);');
    const roundedCost = body.indexOf('v_wavg_cost := ROUND(v_wavg_cost, 2);');
    const lineTotal = body.indexOf('v_line_total := ROUND(v_wavg_price * v_qty, 2);');
    const orderInsert = body.indexOf('INSERT INTO order_items');

    expect(roundedPrice).toBeGreaterThan(-1);
    expect(roundedCost).toBeGreaterThan(roundedPrice);
    expect(lineTotal).toBeGreaterThan(roundedCost);
    expect(orderInsert).toBeGreaterThan(lineTotal);
  });

  it('locks before authorizing and authorizes before cache reads or writes', () => {
    const body = storedFunctionSource(
      migrationSql,
      'CREATE OR REPLACE FUNCTION public._draw_down_quote_below_cost_impl_20260810(',
    );
    const lock = body.indexOf('FROM quotes WHERE id = p_quote_id FOR UPDATE;');
    const deleted = body.indexOf('v_quote.deleted_at IS NOT NULL');
    const owner = body.indexOf('v_quote.created_by IS DISTINCT FROM v_actor');
    const cache = body.indexOf("check_idempotency(p_idempotency_key, 'draw_down_quote')");
    const firstOrderWrite = body.indexOf('INSERT INTO orders');

    expect(lock).toBeGreaterThan(-1);
    expect(deleted).toBeGreaterThan(lock);
    expect(owner).toBeGreaterThan(deleted);
    expect(cache).toBeGreaterThan(owner);
    expect(firstOrderWrite).toBeGreaterThan(cache);
  });

  it('keeps the private implementation private and the public wrapper unchanged', () => {
    expect(migrationSql).toContain(
      "'public._draw_down_quote_below_cost_impl_20260810(uuid,jsonb,uuid,text)'",
    );
    expect(migrationSql).toContain(
      "'public.draw_down_quote(uuid,jsonb,uuid,text,text)'",
    );
    expect(migrationSql).toContain("<> '970960d8490b63b972bc8c60fe207a5b'");
    expect(migrationSql).toContain("has_function_privilege('authenticated', v_impl, 'EXECUTE')");
    expect(migrationSql).toContain("has_function_privilege('service_role', v_impl, 'EXECUTE')");
    expect(migrationSql).toContain("NOT has_function_privilege('postgres', v_impl, 'EXECUTE')");
  });

  it('proves two sales reps, a deleted quote, owner/admin controls, and zero mutation', () => {
    expect(smokeSql.match(/'sales_rep'/g)).toHaveLength(2);
    expect(smokeSql).toContain("'NOT_QUOTE_OWNER%'");
    expect(smokeSql).toContain("'Quote not found%'");
    expect(smokeSql.match(/'EMPTY_DRAW%'/g)).toHaveLength(2);
    expect(smokeSql).toContain('deleted_at');
    expect(smokeSql).toContain('FROM public.orders');
    expect(smokeSql).toContain('FROM public.quote_product_draws');
    expect(smokeSql).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
  });

  it('registers the container-only chain and includes it in the captured-ledger proof', () => {
    const spec = smokeSpecs.specs.draw_down_quote_owner_boundary;
    expect(spec.chain).toBe('smoke-draw-down-quote-owner-boundary.sql');
    expect(spec.container_only).toBe(true);
    expect(spec.covers).toContain('draw_down_quote');
    expect(capturedProver).toContain(
      "'20260813161614_restrict_draw_down_quote_owner.sql'",
    );
    expect(capturedProver).toContain("'smoke-draw-down-quote-owner-boundary.sql'");
    expect(capturedProver).toContain(
      'smoke_draw_down_owner=SMOKE_PASS_ROLLBACK',
    );
  });
});
