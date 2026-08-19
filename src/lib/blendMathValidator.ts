// Server-parity conversion. `fieldAppPricedQuantity` mirrors the live SQL
// `field_app_priced_quantity` that create_invoice_from_blend_ticket bills through,
// including its identity short-circuit for a rate unit that already equals the
// target unit — which is why an MG-rated, MG-sold product prices correctly even
// though no MG size is defined anywhere. Any other factor table used here would let
// this warning and the invoice disagree about the same line.
import { fieldAppPricedQuantity } from './chemCalculator';

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
  /**
   * The catalog product's own form. Decides whether 'oz' means a FLUID ounce or a
   * WEIGHT ounce — the live `field_app_priced_quantity` makes the same split, and a
   * null/unknown form is treated as liquid there, so it is treated as liquid here.
   */
  product_form: string | null;
  /**
   * The catalog product's default rate unit. Billing falls back to this when a line
   * leaves its rate unit blank (`COALESCE(NULLIF(btrim(btp.rate_per_acre_unit), ''),
   * p.rate_unit)` inside `create_invoice_from_blend_ticket`), so this check must use
   * the same fallback — otherwise it goes quiet on exactly the rows that still bill.
   * Recipe-applied rows always arrive with a blank rate unit, so this is the norm.
   */
  product_rate_unit: string | null;
  /**
   * The unit the product is SOLD in — `COALESCE(NULLIF(inventory_unit,''), unit_size)`,
   * matching billing. Used only to predict the invoice-time failure below; never to
   * rescale anything shown on the ticket.
   */
  product_inventory_unit: string | null;
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
 * Strip a PER-ACRE denominator from a rate unit, mirroring the live SQL
 * `normalize_rate_unit` exactly: 'pt/ac' and 'pt per acre' become 'pt'.
 *
 * The important detail is the last branch. If some OTHER denominator is present
 * ('oz/cwt'), the server keeps the whole string so it can never match a bare unit
 * and the conversion refuses. `chemCalculator.baseUnitOfRate` instead splits on the
 * first '/' unconditionally, so it would read 'oz/cwt' as 'oz' and claim a
 * conversion the invoice will reject — silence here, a hard error at billing. That
 * is the one direction this check must never fail in, so it does its own stripping.
 *
 * Synonym folding ('gallons' → 'gal') is deliberately NOT repeated here: the size
 * tables inside `fieldAppPricedQuantity` already list every spelling the server
 * lists, so folding twice would be a second place to drift.
 */
function rateBaseUnit(unit: string | null | undefined): string {
  const raw = (unit ?? '').trim().toLowerCase();
  if (raw === '') return '';
  const perAcreSlash = /\s*\/\s*(ac|acre|acres|a)\s*$/;
  const perAcreSpelled = /\s+per\s+acre$/;
  if (perAcreSlash.test(raw)) return raw.replace(perAcreSlash, '').trim();
  if (perAcreSpelled.test(raw)) return raw.replace(perAcreSpelled, '').trim();
  return raw;
}

/**
 * A run of whitespace, including the invisible characters that JS `\s` misses.
 * `\s` already covers the non-breaking space and the BOM, but not the zero-width
 * space / non-joiner / joiner, which ride along on text pasted out of a PDF or a
 * spreadsheet. Built from character codes because eslint's `no-irregular-
 * whitespace` rule (rightly) forbids writing those characters literally.
 */
const INVISIBLE_RUN = new RegExp(
  `[\\s${[0x200b, 0x200c, 0x200d].map((c) => String.fromCharCode(c)).join('')}]+`,
  'g'
);

/**
 * Normalize a unit for comparison, returning the comparison key alongside a
 * cleaned-up spelling so callers can show the unit roughly as it was typed.
 *
 * Only lossless differences are folded away — ones that cannot change which unit
 * is meant: case (the live rows carry deliberate case aliases with identical
 * factors: Lb/LB, oz/Oz, qt/Qt), any run of whitespace including non-breaking and
 * zero-width characters, and periods ('fl. oz' is 'fl oz'; 'gal.' is 'gal'). This
 * never conflates two genuinely distinct units — 'oz' (liquid) stays separate
 * from 'Dry oz' (dry), and 'g' from 'MG'.
 *
 * Returns null for a unit that was never recorded. That is NOT the same as a unit
 * that disagrees, and callers must not treat "unknown" as "matches".
 */
function normalizeUnit(
  unit: string | null | undefined
): { key: string; label: string } | null {
  const label = (unit ?? '').replace(INVISIBLE_RUN, ' ').trim();
  if (label === '') return null;
  // Periods are decoration on an abbreviation, never part of which unit is meant.
  const key = label.toLowerCase().replace(/\./g, '').replace(INVISIBLE_RUN, ' ').trim();
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

  // Per-product: quantity should ≈ rate_per_acre × total_acres.
  //
  // This arm guards a MONEY path. `create_invoice_from_blend_ticket` bills each line
  // from `rate_per_acre` and its unit — never from `quantity` — so a rate recorded in
  // the wrong unit becomes a wrong invoice, not just a wrong number on screen. The
  // conversion therefore goes through `fieldAppPricedQuantity`, which mirrors the live
  // SQL `field_app_priced_quantity` exactly; using any other factor table would let
  // this warning and the invoice disagree about the same line.
  if (totalAcres && totalAcres > 0) {
    for (const product of products) {
      if (!product.rate_per_acre || product.rate_per_acre <= 0 || product.quantity <= 0) continue;

      const name = product.product_name || 'Unnamed product';
      const form = product.product_form?.trim().toLowerCase() === 'dry' ? 'dry' : 'liquid';

      // Billing's own fallback for a blank line rate unit.
      const lineRateUnit = (product.rate_per_acre_unit ?? '').trim();
      const rateUnit = rateBaseUnit(lineRateUnit !== '' ? lineRateUnit : product.product_rate_unit);
      const qtyUnit = rateBaseUnit(product.unit);

      // The rate is per acre, so acres cancel and the product is in the RATE's unit.
      const expectedInRateUnit = product.rate_per_acre * totalAcres;

      let expected: number | null;
      if (rateUnit === '' || qtyUnit === '' || rateUnit === qtyUnit) {
        // Nothing recorded to disagree, or the units already match: compare the bare
        // numbers, exactly as this check always did.
        expected = expectedInRateUnit;
      } else {
        expected = fieldAppPricedQuantity(expectedInRateUnit, rateUnit, qtyUnit, form);
      }

      if (expected === null) {
        warnings.push(
          `Not checked — ${name}: the rate is in ${rateUnit} but the quantity is in ${qtyUnit}, which can't be converted${form === 'dry' ? ' for a dry product' : ''}. Please verify this line by hand.`
        );
      } else if (expected > 0) {
        const pctDiff = Math.abs(product.quantity - expected) / expected;
        if (pctDiff > TOLERANCE) {
          const inUnit = qtyUnit !== '' && qtyUnit !== rateUnit ? ` ${qtyUnit}` : '';
          warnings.push(
            `${name}: quantity (${product.quantity}) doesn't match rate/acre (${product.rate_per_acre}${rateUnit ? ' ' + rateUnit : ''}) × acres (${totalAcres}) = ${expected.toFixed(2)}${inUnit}`
          );
        }
      }

      // Invoice pre-flight. `create_invoice_from_blend_ticket` hard-raises
      // BLEND_TICKET_UNIT_UNCONVERTIBLE when a billable line's rate unit cannot be
      // converted to the unit the product is sold in. Catching it here turns an error
      // discovered weeks later at invoicing into a note while the ticket is open.
      const soldUnit = rateBaseUnit(product.product_inventory_unit);
      if (rateUnit !== '' && soldUnit !== '' && fieldAppPricedQuantity(1, rateUnit, soldUnit, form) === null) {
        warnings.push(
          `${name}: the rate unit (${rateUnit}) can't be converted to the unit this product is sold in (${soldUnit}), so this ticket will fail when you invoice it.`
        );
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
