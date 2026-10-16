/**
 * Replay-binding batch 2 (migration 20261016140000): the screens that call the thirteen wrapped
 * stock RPCs retire a refused retry key ONLY when the refusal proves nothing committed under it
 * ('intent' = the key belongs to a different request, 'actor' = to another user). A 'receipt'
 * refusal (IDEMPOTENCY_RESULT_INVALID / IDEMPOTENCY_RECEIPT_MISSING) must keep the key: an earlier
 * attempt may have committed, and the key is the only way to replay it instead of repeating the
 * stock action. Same rule and form as batch 1 (replayBindingBatch1CallSites.test.ts).
 *
 * reconcile_negative_inventory (IntegrityCleanupPanel) is deliberately left without the reset: its
 * key is already scoped to the exact row, quantity and reason, so a binding refusal is unreachable
 * there, and its unresolved-intent guard must keep a refused scope frozen rather than mint a fresh
 * key for an absolute stock write.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// File -> number of batch-2 call sites in it.
const SITES: Record<string, number> = {
  'src/pages/InventoryPage.tsx': 3, // release_inventory_hold, manual_inventory_add, retire_inventory_item
  'src/pages/BlendTicketDetail.tsx': 2, // create_order_from_blend_ticket, create_application_record_from_blend_ticket
  'src/pages/NewOrder.tsx': 2, // create_rush_order, create_direct_order
  'src/pages/QuoteBuilder.tsx': 3, // create_planned_holds, close_quote_as_applied, close_quote_as_short
  'src/pages/Deliveries.tsx': 1, // batch_cancel_deliveries
  'src/pages/CycleCounts.tsx': 1, // reverse_completed_cycle_count
};

const INTENT_OR_ACTOR_RESET =
  /const bindingRejection = getIdempotencyBindingRejection\(\w+\);\s*\n\s*if \(bindingRejection === 'intent' \|\| bindingRejection === 'actor'\) \S*reset\S*\(/g;
// Any reset guarded by the bare helper result (truthy for 'receipt' too).
const BARE_HELPER_RESET = /if\s*\(\s*getIdempotencyBindingRejection\([^)]*\)\s*\)\s*\{?\s*\S*reset\S*\(/;

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('replay-binding batch 2 call sites keep the key on a receipt refusal', () => {
  for (const [file, count] of Object.entries(SITES)) {
    it(`${file}: ${count} site(s) retire the key only for intent or actor`, () => {
      const source = read(file);
      expect(source.match(INTENT_OR_ACTOR_RESET)?.length ?? 0).toBe(count);
      expect(BARE_HELPER_RESET.test(source)).toBe(false);
    });
  }

  // After 20261016140000 twelve of the thirteen refuse a keyless call (IDEMPOTENCY_KEY_REQUIRED);
  // the generated types still mark the key optional, so pin that every app call sends one.
  const KEYED_CALLS: Array<[string, string]> = [
    ['src/pages/InventoryPage.tsx', 'release_inventory_hold'],
    ['src/pages/InventoryPage.tsx', 'manual_inventory_add'],
    ['src/pages/InventoryPage.tsx', 'retire_inventory_item'],
    ['src/components/integrity/IntegrityCleanupPanel.tsx', 'reconcile_negative_inventory'],
    ['src/pages/BlendTicketDetail.tsx', 'create_order_from_blend_ticket'],
    ['src/pages/BlendTicketDetail.tsx', 'create_application_record_from_blend_ticket'],
    ['src/pages/NewOrder.tsx', 'create_rush_order'],
    ['src/pages/NewOrder.tsx', 'create_direct_order'],
    ['src/pages/QuoteBuilder.tsx', 'create_planned_holds'],
    ['src/pages/QuoteBuilder.tsx', 'close_quote_as_applied'],
    ['src/pages/QuoteBuilder.tsx', 'close_quote_as_short'],
    ['src/pages/Deliveries.tsx', 'batch_cancel_deliveries'],
    ['src/pages/CycleCounts.tsx', 'reverse_completed_cycle_count'],
  ];
  for (const [file, rpc] of KEYED_CALLS) {
    it(`${file}: every ${rpc} call sends p_idempotency_key`, () => {
      const source = read(file);
      // Each call's argument object runs to its closing line: '})' or, under the below-cost
      // wrapper, '}, reason)'.
      const calls = [...source.matchAll(new RegExp(`\\.rpc\\('${rpc}',([\\s\\S]*?)\\n\\s*\\}(?:, reason)?\\)`, 'g'))];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // A real key expression, never undefined/null or an `|| undefined` fallback.
        expect(call[1]).toMatch(/p_idempotency_key:\s*\S/);
        expect(call[1]).not.toMatch(/p_idempotency_key:[^,\n]*\b(?:undefined|null)\b/);
      }
    });
  }

  // An edited retry under a key whose first attempt already created an order is refused as
  // 'intent' with that order's receipt; the order screens open it rather than let the next click,
  // with a fresh key, create a second order (Codex P1 on PR #951).
  // NewOrder runs inside runCriticalAction, so it must exit with the handled signal (a plain return
  // would add the generic success toast); BlendTicketDetail shows its own toasts and returns.
  const HANDLED_EXIT = '//[^\\n]*\\n\\s*throw new CriticalActionHandledError\\(';
  const ORDER_RECOVERY: Array<[string, string, string]> = [
    ['src/pages/NewOrder.tsx', 'create_rush_order', HANDLED_EXIT],
    ['src/pages/NewOrder.tsx', 'create_direct_order', HANDLED_EXIT],
    ['src/pages/BlendTicketDetail.tsx', 'create_order_from_blend_ticket', 'return;'],
  ];
  for (const [file, rpc, exit] of ORDER_RECOVERY) {
    it(`${file}: a ${rpc} intent refusal opens the order already created`, () => {
      const source = read(file);
      expect(source).toMatch(new RegExp(
        `const committedOrderId = getCommittedOrderIdFromMismatch\\(error, '${rpc}'\\);\\s*\\n\\s*if \\(committedOrderId\\) \\{[\\s\\S]{0,200}?navigate\\(\`/orders/\\$\\{committedOrderId\\}\`\\);\\s*\\n\\s*${exit}`,
      ));
    });
  }

  it('the reconcile screen keeps its exact-intent key on any refusal', () => {
    const source = read('src/components/integrity/IntegrityCleanupPanel.tsx');
    expect(source).toContain('const scope = `reconcile:${row.id}:${newQuantity}:${input.reason.trim()}`;');
    expect(source).not.toMatch(/getIdempotencyBindingRejection\([^)]*\)[\s\S]{0,120}reconcileIdem\.reset/);
  });

  it('the patterns tell the two forms apart', () => {
    const good = "const bindingRejection = getIdempotencyBindingRejection(holdError);\n    if (bindingRejection === 'intent' || bindingRejection === 'actor') idem.resetKey();";
    const bad = 'if (getIdempotencyBindingRejection(error)) idem.resetKeyFor(scope);';
    expect(good.match(INTENT_OR_ACTOR_RESET)?.length).toBe(1);
    expect(BARE_HELPER_RESET.test(good)).toBe(false);
    expect(BARE_HELPER_RESET.test(bad)).toBe(true);
  });
});
