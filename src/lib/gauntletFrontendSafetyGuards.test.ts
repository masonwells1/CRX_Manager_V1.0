/**
 * Caller-side prevention contracts for the Section 5/6/15 gauntlet fixes.
 *
 * These are deliberately source-level: each bug is a sequencing or intent
 * binding rule between React and an existing RPC, where a mocked RPC response
 * cannot prove that the caller retained the required key or wait barrier.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

describe('gauntlet caller-side safety guards', () => {
  it('serializes cycle-count edits and completes only after a fresh authoritative read', () => {
    const page = source('src/pages/CycleCounts.tsx');
    expect(page).toContain('itemWriteQueuesRef');
    expect(page).toContain('await Promise.all([...pendingItemWritesRef.current])');
    expect(page).toMatch(/waitForAuthoritativeCountItems[\s\S]*refreshCountItems/);
    expect(page).toContain('disabled={preparingCompletion || completing}');
  });

  it('keeps bulk field-import RPC intents stable per imported row and refuses re-entry', () => {
    const component = source('src/components/fields/BulkFieldImport.tsx');
    expect(component).toContain('uploadInFlightRef.current');
    expect(component).toContain('const intentScope = `import:${fieldIndex}:${pf.customer_id}:${pf.field_name}`');
    expect(component).toContain('saveFieldIdem.getKeyFor(intentScope)');
    expect(component).toContain('setBoundaryIdem.getKeyFor(intentScope)');
    expect(component).toContain('setOverrideAcresIdem.getKeyFor(intentScope)');
  });

  it('binds duplicate recipes and negative-inventory reconciliation to a row-specific retry intent', () => {
    const recipes = source('src/pages/BlendRecipes.tsx');
    const integrity = source('src/components/integrity/IntegrityCleanupPanel.tsx');
    expect(recipes).toContain('duplicateInFlightRef.current.has(scope)');
    expect(recipes).toContain('p_idempotency_key: duplicateRecipeIdem.getKeyFor(scope)');
    expect(integrity).toContain('reconcileInFlightRef.current.has(scope)');
    expect(integrity).toContain('p_idempotency_key: reconcileIdem.getKeyFor(scope)');
  });

  it('deduplicates damaged-receipt alerts by receipt IDs with server-side intent binding', () => {
    const triggers = source('src/lib/notificationTriggers.ts');
    const detail = source('src/pages/PurchaseOrderDetail.tsx');
    const quickReceive = source('src/components/receiving/QuickReceivePanel.tsx');
    expect(triggers).toContain('damaged-receiving:${poId}:${[...receiptIntentIds].sort().join(\':\')}');
    const migration = source('supabase/migrations/20260831233000_bind_section9_replays_to_intent.sql');
    expect(migration).toContain("'items_summary', p_items_summary");
    expect(migration).toContain("'actor_id', v_actor");
    expect(detail).toContain('await notifyDamagedReceiving(po.po_number, damagedItems, po.id, damagedReceiptIntentIds)');
    expect(quickReceive).toContain('await notifyDamagedReceiving(firstPO, damagedInfo, firstPOId, damagedReceiptIntentIds)');
  });

  it('keeps extension-only overloads excluded without hiding a mixed extension/application collision', () => {
    const predicate = source('scripts/db-invariant-sweeps/predicates/overloads.sql');
    expect(predicate).toContain('AND bool_or(NOT EXISTS');
    expect(predicate).not.toMatch(/WHERE p\.pronamespace[\s\S]*?AND NOT EXISTS[\s\S]*?GROUP BY p\.proname/);
  });

  it('classifies known legacy-tab redirects as intentional crawl outcomes', () => {
    const crawl = source('tests/crawl/route-crawl.spec.ts');
    expect(crawl).toContain("intentionalRedirectTo: '/integrity'");
    expect(crawl).toContain("status = 'intentional-redirect'");
    expect(crawl).toContain("r.status !== 'intentional-redirect'");
  });
});
