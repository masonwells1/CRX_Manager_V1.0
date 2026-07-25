import { describe, expect, it } from 'vitest';
import { addDeliveryEditItem, removeDeliveryEditItem, type DeliveryEditItem } from './deliveryEditItems';

describe('delivery edit item transitions', () => {
  it('preserves exact Product metadata through remove then re-add', () => {
    const product = { id: '11111111-aaaa-bbbb-cccc-222222222222', sku: 'SKU-2.5', return_policy: 'no_return' };
    const item: DeliveryEditItem<typeof product> = {
      order_item_id: 'order-item-1', product_id: product.id, product_name: 'Same Name', quantity: 1,
      max_quantity: 4, unit_size: 'gal', product,
    };

    const removed = removeDeliveryEditItem([item], [], item.order_item_id);
    const readded = addDeliveryEditItem(removed.editItems, removed.availableItems, item.order_item_id);

    expect(readded.editItems).toEqual([{ ...item, quantity: 4 }]);
    expect(readded.editItems[0].product).toBe(product);
  });
});
