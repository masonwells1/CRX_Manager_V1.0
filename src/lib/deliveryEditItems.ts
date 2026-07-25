/**
 * Pure edit-list transitions for DeliveryDetail.
 *
 * The Product object is display context only, but it must survive a remove /
 * re-add cycle so the operator does not lose exact-SKU/policy context.
 */
export interface DeliveryEditItem<TProduct = unknown> {
  order_item_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  max_quantity: number;
  unit_size: string;
  product?: TProduct;
}

export type AvailableDeliveryEditItem<TProduct = unknown> = Omit<DeliveryEditItem<TProduct>, 'quantity'>;

export function removeDeliveryEditItem<TProduct>(
  editItems: DeliveryEditItem<TProduct>[],
  availableItems: AvailableDeliveryEditItem<TProduct>[],
  orderItemId: string,
): { editItems: DeliveryEditItem<TProduct>[]; availableItems: AvailableDeliveryEditItem<TProduct>[] } {
  const removed = editItems.find((item) => item.order_item_id === orderItemId);
  if (!removed) return { editItems, availableItems };
  const { quantity: _quantity, ...available } = removed;
  return {
    editItems: editItems.filter((item) => item.order_item_id !== orderItemId),
    availableItems: [...availableItems, available],
  };
}

export function addDeliveryEditItem<TProduct>(
  editItems: DeliveryEditItem<TProduct>[],
  availableItems: AvailableDeliveryEditItem<TProduct>[],
  orderItemId: string,
): { editItems: DeliveryEditItem<TProduct>[]; availableItems: AvailableDeliveryEditItem<TProduct>[] } {
  const toAdd = availableItems.find((item) => item.order_item_id === orderItemId);
  if (!toAdd) return { editItems, availableItems };
  return {
    editItems: [...editItems, { ...toAdd, quantity: toAdd.max_quantity }],
    availableItems: availableItems.filter((item) => item.order_item_id !== orderItemId),
  };
}
