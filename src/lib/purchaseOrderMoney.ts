export function purchaseOrderUnitCostCents(unitCostDollars: number): number {
  if (!Number.isFinite(unitCostDollars)) return 0;
  return Math.round(unitCostDollars * 100);
}

export function purchaseOrderLineTotalCents(
  quantity: number,
  unitCostDollars: number,
): number {
  if (!Number.isFinite(quantity)) return 0;
  return Math.round(quantity * purchaseOrderUnitCostCents(unitCostDollars));
}

export function purchaseOrderCentsToDollars(cents: number): number {
  return cents / 100;
}
