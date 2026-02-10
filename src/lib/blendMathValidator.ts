interface TicketData {
  total_acres: number | null;
  total_volume: number | null;
  total_volume_unit: string | null;
}

interface ProductData {
  product_name: string;
  quantity: number;
  unit: string | null;
  rate_per_acre: number | null;
  rate_per_acre_unit: string | null;
}

const TOLERANCE = 0.05; // 5%

export function validateBlendMath(
  ticketData: TicketData,
  products: ProductData[]
): string[] {
  const warnings: string[] = [];
  const totalAcres = ticketData.total_acres;
  const totalVolume = ticketData.total_volume;

  // Per-product: quantity should ≈ rate_per_acre × total_acres
  if (totalAcres && totalAcres > 0) {
    for (const product of products) {
      if (product.rate_per_acre && product.rate_per_acre > 0 && product.quantity > 0) {
        const expected = product.rate_per_acre * totalAcres;
        const diff = Math.abs(product.quantity - expected);
        const pctDiff = diff / expected;
        if (pctDiff > TOLERANCE) {
          warnings.push(
            `${product.product_name || 'Unnamed product'}: quantity (${product.quantity}) doesn't match rate/acre (${product.rate_per_acre}) × acres (${totalAcres}) = ${expected.toFixed(2)}`
          );
        }
      }
    }
  }

  // Total volume: sum of product quantities should ≈ total_volume
  if (totalVolume && totalVolume > 0 && products.length > 0) {
    const sumQuantities = products.reduce((sum, p) => sum + (p.quantity || 0), 0);
    if (sumQuantities > 0) {
      const diff = Math.abs(sumQuantities - totalVolume);
      const pctDiff = diff / totalVolume;
      if (pctDiff > TOLERANCE) {
        warnings.push(
          `Total product quantities (${sumQuantities.toFixed(2)}) doesn't match total volume (${totalVolume}${ticketData.total_volume_unit ? ' ' + ticketData.total_volume_unit : ''})`
        );
      }
    }
  }

  return warnings;
}
