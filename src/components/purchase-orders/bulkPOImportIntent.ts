export interface BulkPOIntentItem {
  productId: string;
  quantityOrdered: number;
  unitCost: number;
  unitSize: string;
  notes: string;
}

export interface BulkPOIntent {
  sourceIndex: number;
  sourceFile: string;
  vendorName: string;
  invoiceNumber: string;
  invoiceDate: string;
  items: BulkPOIntentItem[];
}

export function buildBulkPOIntentKey(intent: BulkPOIntent): string {
  return JSON.stringify({
    source_index: intent.sourceIndex,
    source_file: intent.sourceFile,
    vendor_name: intent.vendorName.trim(),
    invoice_number: intent.invoiceNumber,
    invoice_date: intent.invoiceDate,
    items: intent.items.map((item) => ({
      product_id: item.productId,
      quantity_ordered: item.quantityOrdered,
      unit_cost: item.unitCost,
      unit_size: item.unitSize,
      notes: item.notes,
    })),
  });
}
