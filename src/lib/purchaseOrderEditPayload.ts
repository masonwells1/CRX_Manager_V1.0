import {
  purchaseOrderCentsToDollars,
  purchaseOrderUnitCostCents,
} from './purchaseOrderMoney';

export interface PurchaseOrderEditableLine {
  id: string;
  product_id: string;
  product_name: string;
  unit_size: string;
  quantity_ordered: string;
  unit_cost: string;
  quantity_received: number;
}

export function buildPurchaseOrderEditItemsPayload(items: PurchaseOrderEditableLine[]) {
  return items.map((item) => {
    const unitCostCents = purchaseOrderUnitCostCents(parseFloat(item.unit_cost));
    return {
      id: item.id,
      product_id: item.product_id,
      product_name: item.product_name,
      unit_size: item.unit_size || null,
      quantity_ordered: parseFloat(item.quantity_ordered),
      unit_cost: purchaseOrderCentsToDollars(unitCostCents),
      unit_cost_cents: unitCostCents,
      quantity_received: item.quantity_received || 0,
    };
  });
}
