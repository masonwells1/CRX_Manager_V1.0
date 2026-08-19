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

/**
 * Spelling synonyms for the SAME unit, as declared by the live `unit_conversions`
 * rows themselves ('oz' is noted "alias for fl oz"; 'Unit' is noted "alias for Ea").
 * Each pair shares both `factor_oz` and `unit_type`, and they are synonymous by
 * name — a fluid ounce IS a fluid ounce — not merely equal by coincidence.
 *
 * This is NOT a conversion table and deliberately carries no factors: it only
 * decides WHETHER two rows are the same unit, never rescales a quantity. Adding a
 * factor here would duplicate money-critical data that must stay in the database.
 */
const UNIT_ALIASES: Record<string, string> = {
  'fl oz': 'oz',
  unit: 'ea',
};

/**
 * Normalize a unit for comparison, returning the comparison key alongside the
 * original spelling so callers can show the unit as the operator typed it.
 *
 * Case and surrounding whitespace are ignored: the live rows carry deliberate
 * case aliases with identical factors (Lb/LB, oz/Oz, qt/Qt). This never conflates
 * two genuinely distinct units — 'oz' (liquid) stays separate from 'Dry oz' (dry),
 * and 'g' from 'MG'. A blank unit is "not recorded" rather than a unit named "".
 */
function normalizeUnit(
  unit: string | null | undefined
): { key: string; label: string } | null {
  const label = (unit ?? '').trim();
  if (label === '') return null;
  const lower = label.toLowerCase();
  return { key: UNIT_ALIASES[lower] ?? lower, label };
}

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

  // Total volume: sum of product quantities should ≈ total_volume.
  //
  // Quantities are only additive when every product is measured in the SAME unit
  // as the ticket total. `unit_conversions` cannot rescue a mixed-unit ticket:
  // `factor_oz` is within-family only (Lb = 16 DRY ounces, Gal = 128 FLUID ounces,
  // Ea/Unit = a dimensionless count), and crossing liquid <-> dry requires a
  // per-product density the table does not carry. So compare only when the units
  // agree, and tell the operator when the check had to be skipped rather than
  // emitting a number that silently adds gallons to pounds.
  if (totalVolume && totalVolume > 0 && products.length > 0) {
    const sumQuantities = products.reduce((sum, p) => sum + (p.quantity || 0), 0);
    if (sumQuantities > 0) {
      // Only rows that actually move the sum can make it non-additive. A
      // half-entered row (unit picked, quantity still 0) contributes nothing, so
      // it must not suppress the check for the whole ticket.
      const rawUnits = products
        .filter((p) => (p.quantity || 0) !== 0)
        .map((p) => p.unit)
        .concat([ticketData.total_volume_unit]);

      // First-seen original spelling per normalized unit, so the message shows
      // the units as they were actually entered.
      const unitLabels = new Map<string, string>();
      for (const raw of rawUnits) {
        const normalized = normalizeUnit(raw);
        if (normalized !== null && !unitLabels.has(normalized.key)) {
          unitLabels.set(normalized.key, normalized.label);
        }
      }

      if (unitLabels.size > 1) {
        const labels = Array.from(unitLabels.values()).join(', ');
        warnings.push(
          `Total volume not checked: this ticket mixes units (${labels}). Quantities in different units can't be added together, so please verify the total by hand.`
        );
      } else {
        const diff = Math.abs(sumQuantities - totalVolume);
        const pctDiff = diff / totalVolume;
        if (pctDiff > TOLERANCE) {
          warnings.push(
            `Total product quantities (${sumQuantities.toFixed(2)}) doesn't match total volume (${totalVolume}${ticketData.total_volume_unit ? ' ' + ticketData.total_volume_unit : ''})`
          );
        }
      }
    }
  }

  return warnings;
}
