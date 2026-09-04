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
const sharedTypes = readFileSync(
  join(process.cwd(), 'src', 'types', 'index.ts'),
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
  if (!candidate.includes('IDEMPOTENCY_KEY_REQUIRED: complete_cycle_count requires p_idempotency_key')) {
    throw new Error('completion idempotency requirement missing');
  }
}

function expectBefore(candidate: string, earlier: string, later: string): void {
  const earlierIndex = candidate.indexOf(earlier);
  const laterIndex = candidate.indexOf(later);
  expect(earlierIndex, `missing earlier marker: ${earlier}`).toBeGreaterThan(-1);
  expect(laterIndex, `missing later marker: ${later}`).toBeGreaterThan(-1);
  expect(earlierIndex).toBeLessThan(laterIndex);
}

describe('cycle count completion revision contract', () => {
  it('records every item mutation in an authoritative parent revision', () => {
    expect(code).toContain('ADD COLUMN item_revision bigint NOT NULL DEFAULT 0');
    expect(code).toContain('CREATE TRIGGER trg_bump_cycle_count_item_revision');
    expect(code).toMatch(/AFTER INSERT OR UPDATE OR DELETE ON public\.cycle_count_items/);
    expect(code).toContain('SET item_revision = item_revision + 1');
    expect(code).toMatch(
      /IF TG_OP = 'DELETE' THEN\s+RETURN OLD;\s+END IF;\s+RAISE EXCEPTION 'CYCLE_COUNT_NOT_FOUND'/,
    );
  });

  it('locks an item before its parent, while completion locks items, parent, then inventory', () => {
    const updateStart = code.indexOf('CREATE OR REPLACE FUNCTION public.update_cycle_count_item');
    const updateEnd = code.indexOf('ALTER FUNCTION public.complete_cycle_count', updateStart);
    const update = code.slice(updateStart, updateEnd);
    expectBefore(
      update,
      'WHERE id = p_item_id\n   FOR UPDATE;',
      'WHERE id = v_item.cycle_count_id\n   FOR UPDATE;',
    );

    const completionStart = code.indexOf('CREATE FUNCTION public.complete_cycle_count');
    const completion = code.slice(completionStart);
    expectBefore(completion, 'FROM public.cycle_count_items', 'FROM public.cycle_counts');
    expect(completion).toContain('ORDER BY id\n   FOR UPDATE;');
    expectBefore(completion, 'FROM public.cycle_counts', 'FROM public.inventory i');
    expectBefore(
      completion,
      'FROM public.inventory i',
      'PERFORM public._complete_cycle_count_impl',
    );
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

  it('blocks cutover while a live legacy item-save or completion receipt exists', () => {
    expect(code).toContain(
      'LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE',
    );
    expect(code).toContain("operation = 'update_cycle_count_item'");
    expect(code).toContain("operation = 'complete_cycle_count'");
    expect(code).toContain("result->>'_cycle_count_id' IS NULL");
    expect(code).toContain("result->>'_actor_id' IS NULL");
    expect(code).toContain("NOT (result ? '_expected_item_revision')");
    expect(code).toContain('CYCLE_COUNT_INTENT_CUTOVER_BLOCKED');
    expect(code).not.toMatch(/^BEGIN;|\nBEGIN;\s*$/m);
    expect(code.trimEnd()).not.toMatch(/COMMIT;$/);
  });

  it('rejects an authoritative snapshot that changed before completion', () => {
    expect(code).toContain('IDEMPOTENCY_KEY_REQUIRED: complete_cycle_count requires p_idempotency_key');
    expect(code).toContain('p_expected_item_revision bigint DEFAULT NULL');
    expect(code).toContain('v_current_item_revision IS DISTINCT FROM p_expected_item_revision');
    expect(code).toContain("RAISE EXCEPTION 'CYCLE_COUNT_STALE_REVISION'");
    expect(code).toContain("'_expected_item_revision', p_expected_item_revision");
    expect(page).toContain(".select('item_revision, status')");
    expect(page).toContain('p_expected_item_revision: snapshot.itemRevision');
    expect(page).toContain("typeof countState.item_revision !== 'number'");
    expect(page).toContain('onConfirm={() => { void executeComplete(); }}');
    expect(sharedTypes).toMatch(/item_revision\?: number;/);
    expectBefore(
      page,
      ".select('item_revision, status')",
      'const items = await refreshCountItems(activeCount.id)',
    );
  });

  // CodeRabbit (2026-09-04, PR #535): a successful update_cycle_count_item only
  // SCHEDULES setActiveCount, but the completion handler awaits the pending writes and
  // then read its CAPTURED activeCount — so the operator's own just-saved edit left the
  // reviewed revision on the pre-write value while the server had already advanced, and
  // the check reported their own edit as a foreign change.
  //
  // Pin the two halves as a PAIR: the synchronous write into the ref, and the read of
  // that ref for reviewedRevision. Pinning only the read would be satisfied by a ref
  // nothing ever writes to; pinning only the write leaves the completion path free to
  // go back to reading state.
  it('takes the reviewed revision from the synchronous ref, not from captured state', () => {
    expect(page).toContain('latestItemRevisionRef.current.set(item.cycle_count_id, result.item_revision)');
    expect(page).toContain(
      'latestItemRevisionRef.current.get(activeCount.id) ?? activeCount.item_revision',
    );
    // The write must be recorded BEFORE the scheduled state update, which is the whole
    // point — a ref set after an await would inherit the same staleness.
    //
    // Scoped to the item-write success path. `setActiveCount((previousCount) =` is NOT
    // unique in this file, so comparing raw indexOf positions matched an EARLIER
    // unrelated call and failed a correct implementation.
    const writeSuccess = page.slice(
      page.indexOf('failedItemWritesRef.current.delete(failedItemWriteKey(item.cycle_count_id, itemId));'),
    );
    expect(writeSuccess).not.toHaveLength(0);
    expectBefore(
      writeSuccess,
      'latestItemRevisionRef.current.set(item.cycle_count_id, result.item_revision)',
      'setActiveCount((previousCount) =',
    );
    // Keyed per cycle count: this component outlives the detail modal, so an unkeyed
    // revision would let count A decide count B's completion.
    expect(page).toContain('latestItemRevisionRef = useRef(new Map<string, number>())');
  });

  // Codex on 1973add81 caught this in the FIX above, not in the original code: because
  // the read prefers the ref, a ref that is never advanced on the remote-refresh path
  // pins the client to a superseded revision FOREVER. After another client's edit the
  // refresh adopts the new revision into state, but every later click re-reads the old
  // one from the ref and repeats the mismatch — completion wedged until a reload,
  // strictly worse than the single extra click the ref was added to remove.
  //
  // The pairing therefore has THREE members, not two: write on local save, ADVANCE on
  // remote adoption, read at completion. Pinning only the first and last is satisfied
  // by the wedge.
  it('advances the revision ref wherever it adopts an authoritative revision', () => {
    expect(page).toContain('latestItemRevisionRef.current.set(activeCount.id, countState.item_revision)');
    // Must sit with the state adoption it shadows: adopting into state while leaving
    // the ref behind is the wedge itself.
    const adoption = page.slice(page.indexOf('const items = await refreshCountItems(activeCount.id)'));
    expectBefore(
      adoption,
      'item_revision: countState.item_revision',
      'latestItemRevisionRef.current.set(activeCount.id, countState.item_revision)',
    );
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
      code.replace(
        'IDEMPOTENCY_KEY_REQUIRED: complete_cycle_count requires p_idempotency_key',
        'keyless completion allowed',
      ),
    ]) {
      expect(() => assertCriticalCycleGuards(mutant)).toThrow();
    }
  });
});
