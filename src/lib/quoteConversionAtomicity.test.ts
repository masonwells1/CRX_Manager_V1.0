import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function migrationSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

describe('quote conversion atomicity contract', () => {
  it('keeps acceptance, hold release, order creation, and prebooking in one owner function', () => {
    const source = migrationSource(
      'supabase/migrations/20260702172500_layer2_convert_quote_to_order_job_aware.sql',
    );
    const functionStart = source.indexOf('CREATE OR REPLACE FUNCTION public.convert_quote_to_order(');
    const functionEnd = source.indexOf('$function$;', functionStart);

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const body = source.slice(functionStart, functionEnd);
    const checkpoints = [
      "UPDATE quotes SET status = 'accepted'",
      'UPDATE inventory_holds SET is_active = false',
      'INSERT INTO orders (',
      'INSERT INTO order_items (',
      'UPDATE inventory SET quantity_prebooked = quantity_prebooked + v_item.total_units_needed',
      "INSERT INTO inventory_transactions",
    ];

    let previousIndex = -1;
    for (const checkpoint of checkpoints) {
      const currentIndex = body.indexOf(checkpoint);
      expect(currentIndex, `missing conversion checkpoint: ${checkpoint}`).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }
  });

  it('keeps the public governed wrapper delegated to that preserved owner implementation', () => {
    const rowVersionGuard = migrationSource(
      'supabase/migrations/20260730235031_quote_customer_row_version_guard.sql',
    );
    const belowCostGuard = migrationSource(
      'supabase/migrations/20260812154028_enforce_below_cost_admin_approval.sql',
    );

    expect(rowVersionGuard).toContain(
      'ALTER FUNCTION public.convert_quote_to_order(uuid, uuid, text)\n  RENAME TO _convert_quote_to_order_owner_impl;',
    );
    expect(rowVersionGuard).toContain(
      'v_result := public._convert_quote_to_order_owner_impl(',
    );
    expect(belowCostGuard).toContain(
      'ALTER FUNCTION public.convert_quote_to_order(uuid, uuid, text, bigint)\n  RENAME TO _convert_quote_to_order_below_cost_impl_20260810;',
    );
    expect(belowCostGuard).toContain(
      'RETURN public._convert_quote_to_order_below_cost_impl_20260810(',
    );
  });
});
