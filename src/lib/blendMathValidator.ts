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
 * Deliberately limited to those two DB-declared pairs. The unit fields are free
 * text (`ManualTicketCreate.tsx`, `BlendTicketDetail.tsx`), so an operator can
 * type 'gallons' or 'lbs', which will NOT merge with 'Gal' or 'Lb' here. That is
 * the safe direction to fail: an unmatched spelling costs one "check it by hand"
 * message, whereas guessing that 'ounces' means fluid rather than dry ounces
 * would resurrect the silent bad arithmetic this whole change exists to remove.
 * The real fix for spelling drift is to make the field a picker, as the Field App
 * already does (`unitOptionsForForm`); tracked in docs/manual/KNOWN_ISSUES.md.
 *
 * This is NOT a conversion table and deliberately carries no factors: it only
 * decides WHETHER two rows are the same unit, never rescales a quantity. Adding a
 * factor here would duplicate money-critical data that must stay in the database.
 *
 * Null-prototype so a unit literally typed as 'constructor' or '__proto__' cannot
 * return an inherited value where a string is expected.
 */
const UNIT_ALIASES: Record<string, string> = Object.assign(Object.create(null), {
  'fl oz': 'oz',
  unit: 'ea',
});

/**
 * Zero-width characters, which ride along on text pasted out of a PDF or a
 * spreadsheet. These are DELETED rather than collapsed to a space: they occupy no
 * width, so a reader who types 'gal' and a reader who pastes 'g<ZWSP>al' mean the
 * same unit and must produce the same key. Turning one into a space instead would
 * split the abbreviation into 'g al', which matches nothing — the check would then
 * be skipped and the message would list two units that look identical on screen.
 *
 * `\s` already matches the BOM (U+FEFF) but not the zero-width space / non-joiner
 * / joiner, and it is the wrong treatment for all four, so the BOM is handled here
 * too. Genuinely visible whitespace — including the non-breaking space — is left
 * to `WHITESPACE_RUN` below, because a space between words IS meaningful.
 *
 * Built from character codes because eslint's `no-irregular-whitespace` rule
 * (rightly) forbids writing those characters literally.
 */
const ZERO_WIDTH = new RegExp(
  `[${[0x200b, 0x200c, 0x200d, 0xfeff].map((c) => String.fromCharCode(c)).join('')}]`,
  'g'
);

/** A run of real whitespace, collapsed to one space. Applied after ZERO_WIDTH. */
const WHITESPACE_RUN = /\s+/g;

/**
 * Normalize a unit for comparison, returning the comparison key alongside a
 * cleaned-up spelling so callers can show the unit roughly as it was typed.
 *
 * Only lossless differences are folded away — ones that cannot change which unit
 * is meant: case (the live rows carry deliberate case aliases with identical
 * factors: Lb/LB, oz/Oz, qt/Qt), zero-width characters (deleted outright), any run
 * of real whitespace including the non-breaking space (collapsed to one space),
 * and periods ('fl. oz' is 'fl oz'; 'gal.' is 'gal'). This never conflates two
 * genuinely distinct units — 'oz' (liquid) stays separate from 'Dry oz' (dry), and
 * 'g' from 'MG'.
 *
 * Returns null for a unit that was never recorded. That is NOT the same as a unit
 * that disagrees, and callers must not treat "unknown" as "matches".
 */
function normalizeUnit(
  unit: string | null | undefined
): { key: string; label: string } | null {
  // Zero-width first, so 'g<ZWSP>al' closes up to 'gal' instead of splitting into
  // 'g al'; only then is real whitespace collapsed.
  const label = (unit ?? '').replace(ZERO_WIDTH, '').replace(WHITESPACE_RUN, ' ').trim();
  if (label === '') return null;
  // Periods are decoration on an abbreviation, never part of which unit is meant.
  // Dropping one can leave a double space ('fl . oz'), so collapse again after.
  const key = label.toLowerCase().replace(/\./g, '').replace(WHITESPACE_RUN, ' ').trim();
  if (key === '') return null;
  return { key: UNIT_ALIASES[key] ?? key, label };
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
  // per-product density the table does not carry. So compare only when every
  // contributing quantity is known to be in one unit, and tell the operator when
  // the check had to be skipped rather than emitting a number that silently adds
  // gallons to pounds. "Not recorded" is treated as unknown, never as agreement.
  if (totalVolume && totalVolume > 0 && products.length > 0) {
    const sumQuantities = products.reduce((sum, p) => sum + (p.quantity || 0), 0);
    if (sumQuantities > 0) {
      // Only rows that actually move the sum can make it non-additive. A
      // half-entered row (unit typed, quantity still 0) contributes nothing, so
      // it must not suppress the check for the whole ticket.
      const contributingUnits = products
        .filter((p) => (p.quantity || 0) !== 0)
        .map((p) => p.unit);

      // First-seen spelling per normalized unit, so the message shows the units
      // roughly as they were actually entered.
      const unitLabels = new Map<string, string>();
      // A row that moves the sum but has no unit recorded is the dangerous case:
      // its quantity is already in `sumQuantities`, so treating "unknown" as
      // "matches" is exactly the silent bad arithmetic being fixed. The unit
      // fields are free text and a new row starts blank, so this is a likely
      // real-world state, not an edge case.
      let hasUnrecordedUnit = false;
      for (const raw of contributingUnits) {
        const normalized = normalizeUnit(raw);
        if (normalized === null) {
          hasUnrecordedUnit = true;
        } else if (!unitLabels.has(normalized.key)) {
          unitLabels.set(normalized.key, normalized.label);
        }
      }

      // The ticket's own total unit is the other half of the same hole. If the
      // products say Gal and the total says nothing, the total is NOT thereby in
      // gallons — it is simply unknown, and comparing against it is the same silent
      // guess. This is not a rare case: the scanned-ticket importer
      // (`supabase/functions/process-blend-ticket/index.ts`) writes `total_volume`
      // and never writes `total_volume_unit`, so EVERY imported ticket lands here.
      const ticketUnit = normalizeUnit(ticketData.total_volume_unit);
      const ticketUnitMissing = ticketUnit === null;
      if (ticketUnit !== null && !unitLabels.has(ticketUnit.key)) {
        unitLabels.set(ticketUnit.key, ticketUnit.label);
      }

      // A ticket with no units recorded anywhere carries no evidence of a unit
      // problem, so it still gets the plain number comparison it always had —
      // warning there would fire on every unit-less ticket and teach operators to
      // ignore the banner. The check is only suppressed once SOME unit is known
      // and something else disagrees with it or is missing.
      const someUnitRecorded = unitLabels.size > 0;

      if (someUnitRecorded && hasUnrecordedUnit) {
        warnings.push(
          `Total volume not checked: a product has a quantity but no unit, so it can't be told whether it adds to the rest. Please verify the total by hand.`
        );
      } else if (someUnitRecorded && ticketUnitMissing) {
        warnings.push(
          `Total volume not checked: the products have units but the total volume doesn't, so there's nothing to compare them against. Please verify the total by hand.`
        );
      } else if (unitLabels.size > 1) {
        const labels = Array.from(unitLabels.values()).join(', ');
        warnings.push(
          `Total volume not checked: these are not all the same unit (${labels}). Quantities in different units can't be added together, so please verify the total by hand.`
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
