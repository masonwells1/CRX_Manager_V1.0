import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260831212415_guard_cycle_count_completion_revision.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const code = migration.replace(/^[ \t]*--.*$/gm, '');

describe('cycle count completion revision contract', () => {
  it('records every item mutation in an authoritative parent revision', () => {
    expect(code).toContain('ADD COLUMN item_revision bigint NOT NULL DEFAULT 0');
    expect(code).toContain('CREATE TRIGGER trg_bump_cycle_count_item_revision');
    expect(code).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON public\.cycle_count_items/);
    expect(code).toContain('SET item_revision = item_revision + 1');
  });

  it('locks an item before its parent, while completion locks all items first', () => {
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
  });

  it('rejects an authoritative snapshot that changed before completion', () => {
    expect(code).toContain('p_expected_item_revision bigint DEFAULT NULL');
    expect(code).toContain('v_current_item_revision IS DISTINCT FROM p_expected_item_revision');
    expect(code).toContain("RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION'");
    expect(code).toContain("'_expected_item_revision', p_expected_item_revision");
  });

  it('keeps one public overload and exposes the revision to item-save callers', () => {
    expect(code).toContain('RENAME TO _complete_cycle_count_pre_revision_20260831');
    expect(code).toContain("'item_revision', v_item_revision");
    expect(code).toContain("to_regprocedure('public.complete_cycle_count(uuid,uuid,text)')")
  });
});
