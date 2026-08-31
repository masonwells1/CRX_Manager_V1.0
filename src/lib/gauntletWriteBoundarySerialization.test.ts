import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(
    process.cwd(),
    'supabase',
    'migrations',
    '20260831235900_serialize_gauntlet_write_boundaries.sql',
  ),
  'utf8',
).replace(/\r\n/g, '\n');

const code = migration.replace(/^[ \t]*--.*$/gm, '');

function assertReceivingBoundary(candidate: string): void {
  const start = candidate.indexOf(
    'CREATE OR REPLACE FUNCTION public.reverse_receiving_record',
  );
  const end = candidate.indexOf(
    'REVOKE ALL ON FUNCTION public.reverse_receiving_record',
    start,
  );
  const body = candidate.slice(start, end);
  const poItemLock = body.indexOf('FROM public.purchase_order_items poi');
  const poLock = body.indexOf('FROM public.purchase_orders po');
  const monthLock = body.indexOf(
    'public._lock_accounting_months(ARRAY[v_receiving_date], false)',
  );
  const periodCheck = body.indexOf('public.check_period_open(v_receiving_date)');
  const implementation = body.indexOf(
    'public._section9_reverse_receiving_record_serialized',
  );

  if (
    start < 0
    || poItemLock < 0
    || poLock < 0
    || !body.slice(poItemLock, poLock).includes('FOR UPDATE')
    || !body.slice(poLock, monthLock).includes('FOR UPDATE')
    || poLock < poItemLock
    || monthLock < poLock
    || periodCheck < monthLock
    || implementation < periodCheck
  ) {
    throw new Error('receiving reversal serialization boundary missing');
  }
}

function assertCycleItemBoundary(candidate: string): void {
  const start = candidate.indexOf(
    'CREATE OR REPLACE FUNCTION public.bump_cycle_count_item_revision',
  );
  const end = candidate.indexOf(
    'REVOKE ALL ON FUNCTION public.bump_cycle_count_item_revision',
    start,
  );
  const body = candidate.slice(start, end);
  const parentRead = body.indexOf('FROM public.cycle_counts cc');
  const parentLock = body.indexOf('FOR UPDATE', parentRead);
  const revision = body.indexOf('SET item_revision = item_revision + 1');

  if (
    start < 0
    || !candidate.includes(
      'BEFORE INSERT OR UPDATE OR DELETE ON public.cycle_count_items',
    )
    || parentRead < 0
    || parentLock < parentRead
    || revision < parentLock
    || !body.includes("v_status IS DISTINCT FROM 'in_progress'")
    || !body.includes("RAISE EXCEPTION 'CYCLE_COUNT_NOT_IN_PROGRESS'")
  ) {
    throw new Error('cycle-count item serialization boundary missing');
  }
}

describe('gauntlet write-boundary serialization follow-up', () => {
  it('serializes receiving reversal with PO billing and period close', () => {
    expect(() => assertReceivingBoundary(code)).not.toThrow();
    expect(code).toContain('PERFORM pg_advisory_xact_lock(73492009)');
    expect(code).toContain("p_idempotency_key, 'reverse_receiving_record', v_actor, v_fingerprint");
  });

  it('locks and revalidates the parent before every cycle-count item mutation', () => {
    expect(() => assertCycleItemBoundary(code)).not.toThrow();
    expect(code).toContain('DROP TRIGGER trg_bump_cycle_count_item_revision');
    expect(code).toContain("IF TG_OP = 'DELETE' THEN");
  });

  it('detects removal or reordering of each load-bearing guard', () => {
    for (const mutant of [
      code.replace('FROM public.purchase_orders po', 'FROM public.purchase_orders_unlocked po'),
      code.replace('FROM public.purchase_order_items poi', 'FROM public.purchase_order_items_unlocked poi'),
      code.replace(
        'public._lock_accounting_months(ARRAY[v_receiving_date], false)',
        'public.check_period_open(v_receiving_date)',
      ),
      code.replace(
        'BEFORE INSERT OR UPDATE OR DELETE ON public.cycle_count_items',
        'AFTER INSERT OR UPDATE OR DELETE ON public.cycle_count_items',
      ),
      code.replace("v_status IS DISTINCT FROM 'in_progress'", 'false'),
    ]) {
      const receivingStillValid = () => assertReceivingBoundary(mutant);
      const cycleStillValid = () => assertCycleItemBoundary(mutant);
      expect(
        (() => {
          receivingStillValid();
          cycleStillValid();
        }),
      ).toThrow();
    }
  });
});
