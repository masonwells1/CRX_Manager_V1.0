import { describe, expect, it } from 'vitest';
import { buildPurchaseOrderEditItemsPayload } from './purchaseOrderEditPayload';

describe('buildPurchaseOrderEditItemsPayload', () => {
  it('preserves a received UUID and sends the exact sibling UUID selected for an unreceived line', () => {
    const payload = buildPurchaseOrderEditItemsPayload([
      {
        id: 'received-line',
        product_id: 'product-sibling-a',
        product_name: 'Same Name',
        unit_size: '2.5 GL',
        quantity_ordered: '10',
        unit_cost: '100',
        quantity_received: 4,
      },
      {
        id: 'editable-line',
        product_id: 'product-sibling-b',
        product_name: 'Same Name',
        unit_size: '30 GL',
        quantity_ordered: '2',
        unit_cost: '900.25',
        quantity_received: 0,
      },
    ]);

    expect(payload.map(({ id, product_id, quantity_received }) => ({
      id,
      product_id,
      quantity_received,
    }))).toEqual([
      {
        id: 'received-line',
        product_id: 'product-sibling-a',
        quantity_received: 4,
      },
      {
        id: 'editable-line',
        product_id: 'product-sibling-b',
        quantity_received: 0,
      },
    ]);
  });
});
