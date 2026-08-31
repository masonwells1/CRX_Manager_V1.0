import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260831212415_guard_cycle_count_completion_revision.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const code = migration.replace(/^[ \t]*--.*$/gm, '');
const page = readFileSync(
  join(process.cwd(), 'src', 'pages', 'CycleCounts.tsx'),
  'utf8',
).replace(/\r\n/g, '\n');

function assertCriticalCycleGuards(candidate: string): void {
  const completionStart = candidate.indexOf('CREATE FUNCTION public.complete_cycle_count');
  const completion = candidate.slice(completionStart);
  const inventoryLock = completion.indexOf('FOR UPDATE OF i;');
  const implementation = completion.indexOf('PERFORM public._complete_cycle_count_impl');
  if (completionStart < 0 || inventoryLock < 0 || implementation < 0 || inventoryLock > implementation) {
    throw new Error('completion inventory lock contract missing');
  }
  if (!candidate.includes("p_idempotency_key, 'update_cycle_count_item', v_actor, v_fingerprint")) {
    throw new Error('item-update intent binding missing');
  }
  if (!candidate.includes('v_current_item_revision IS DISTINCT FROM p_expected_item_revision')) {
    throw new Error('stale-revision rejection missing');
  }
}

describe('cycle count completion revision contract', () => {
  it('records every item mutation in an authoritative parent revision', () => {
    expect(code).toContain('ADD COLUMN item_revision bigint NOT NULL DEFAULT 0');
    expect(code).toContain('CREATE TRIGGER trg_bump_cycle_count_item_revision');
    expect(code).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON public\.cycle_count_items/);
    expect(code).toContain('SET item_revision = item_revision + 1');
  });

  it('locks an item before its parent, while completion locks items, parent, then inventory', () => {
    const updateStart = code.indexOf('CREATE OR REPLACE FUNCTION public.update_cycle_count_item');
    const updateEnd = code.indexOf('ALTER FUNCTION public.complete_cycle_count', updateStart);
    const update = code.slice(updateStart, updateEnd);
    expect(update.indexOf('WHERE id = p_item_id\n   FOR UPDATE;'))
      .toBeLessThan(update.indexOf('WHERE id = v_item.cycle_count_id\n   FOR UPDATE;'));

    const completionStart = code.indexOf('CREATE FUNCTION public.complete_cycle_count');
    const completion = code.slice(completionStart);
    expect(completion.indexOf('FROM public.cycle_count_items'))
      .toBeLessThan(completion.indexOf('FROM public.cycle_counts'));
    expect(completion).toContain('ORDER BY id\n   FOR UPDATE;');
    expect(completion.indexOf('FROM public.cycle_counts'))
      .toBeLessThan(completion.indexOf('FROM public.inventory i'));
    expect(completion.indexOf('FROM public.inventory i'))
      .toBeLessThan(completion.indexOf('PERFORM public._complete_cycle_count_impl'));
    expect(completion).toContain('FOR UPDATE OF i;');
  });

  it('requires and binds every item-save replay to actor and payload intent', () => {
    expect(code).toContain('IDEMPOTENCY_KEY_REQUIRED: update_cycle_count_item requires p_idempotency_key');
    expect(code).toContain("p_idempotency_key, 'update_cycle_count_item', v_actor, v_fingerprint");
    expect(code).toContain('request_actor_id = v_actor');
    expect(code).toContain('request_fingerprint = v_fingerprint');
    expect(page).toContain("useIdempotencyKey('update_cycle_count_item', profile?.id || '')");
    expect(page).toContain('updateCycleCountItemIdem.getKeyFor(intentScope)');
    expect(page).toContain('updateCycleCountItemIdem.resetKeyFor(intentScope)');
    expect(page).toContain('p_idempotency_key: idempotencyKey');
  });

  it('rejects an authoritative snapshot that changed before completion', () => {
    expect(code).toContain('p_expected_item_revision bigint DEFAULT NULL');
    expect(code).toContain('v_current_item_revision IS DISTINCT FROM p_expected_item_revision');
    expect(code).toContain("RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION'");
    expect(code).toContain("'_expected_item_revision', p_expected_item_revision");
    expect(page).toContain(".select('item_revision, status')");
    expect(page).toContain('p_expected_item_revision: snapshot.itemRevision');
    expect(page.indexOf(".select('item_revision, status')"))
      .toBeLessThan(page.indexOf('const items = await refreshCountItems(activeCount.id)'));
  });

  it('keeps one public overload and exposes the revision to item-save callers', () => {
    expect(code).toContain('RENAME TO _complete_cycle_count_pre_revision_20260831');
    expect(code).toContain("'item_revision', v_item_revision");
    expect(code).toContain("to_regprocedure('public.complete_cycle_count(uuid,uuid,text)')");
  });

  it('fails when each critical guard is deliberately broken', () => {
    expect(() => assertCriticalCycleGuards(code)).not.toThrow();
    for (const mutant of [
      code.replace('FOR UPDATE OF i;', '/* inventory lock removed */'),
      code.replace(
        "p_idempotency_key, 'update_cycle_count_item', v_actor, v_fingerprint",
        "p_idempotency_key, 'update_cycle_count_item', v_actor, 'unbound'",
      ),
      code.replace(
        'v_current_item_revision IS DISTINCT FROM p_expected_item_revision',
        'false',
      ),
    ]) {
      expect(() => assertCriticalCycleGuards(mutant)).toThrow();
    }
  });
});
