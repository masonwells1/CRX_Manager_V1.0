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
  /**
   * The header's per-acre carrier rate, as free text ("10 gal/acre"). Mason
   * confirmed 2026-08-19 that this is always the TOTAL spray solution per acre,
   * not one product's rate, which is what makes rate × acres ≈ total_volume a
   * true statement about the tank.
   */
  application_rate: string | null;
}

/**
 * Units that only ever mean a WEIGHT, and units that only ever mean a VOLUME.
 *
 * Used to decide what a ticket's total is measuring, which decides which total
 * check is even meaningful. `oz` appears in NEITHER list on purpose: it is the one
 * genuinely ambiguous spelling (a fluid ounce for a liquid, a weight ounce for a
 * dry product), so a total recorded as plain `oz` is treated as a volume, matching
 * the server's "unknown form is liquid" default.
 *
 * The spellings are kept deliberately in step with the CASE inside the live
 * `normalize_rate_unit` (read from `pg_proc.prosrc`, 2026-08-20), which knows
 * oz/pt/qt/gal/lb/ton/g/kg/l/ml and their long forms. An earlier draft of these
 * sets listed only the US spellings, so a ticket totalled in `kg` or `liters`
 * matched NEITHER family, ran no total check at all, and said nothing about it —
 * a silent hole, and a regression against the old same-unit sum comparison.
 * Raised as MED #3 by gpt-5.6-sol on PR #439. Anything still unclassifiable now
 * earns an explicit `unchecked` note rather than silence.
 */
const WEIGHT_ONLY_UNITS = new Set([
  'lb', 'lbs', 'pound', 'pounds', 'ton', 'tons', 'dry oz',
  'g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms',
]);
const VOLUME_ONLY_UNITS = new Set([
  'gal', 'gallon', 'gallons', 'gl', 'qt', 'quart', 'quarts', 'pt', 'pint', 'pints',
  'fl oz', 'floz', 'fluid ounce', 'l', 'liter', 'liters', 'litre', 'litres', 'ml',
]);

/**
 * Pull a number and a unit out of the free-text application-rate box.
 *
 * The field is unconstrained, so this parses only the unambiguous shape — a single
 * leading number followed by a unit ("10 gal/acre", "10gal/A", "10 gal per acre").
 * Anything else (a range, two terms added together, a bare number, prose, blank)
 * returns null and the tank check simply does not run. That is deliberate: a
 * confident guess about what an operator meant is exactly the class of bug this
 * whole file is being rebuilt to remove.
 */
function parseApplicationRate(raw: string | null | undefined): { value: number; unit: string } | null {
  // Zero-width first, so a pasted '10 g<ZWSP>al/acre' closes up to '10 gal/acre'
  // instead of splitting into '10 g al/acre', which would parse to no known unit.
  const text = (raw ?? '').replace(ZERO_WIDTH, '').replace(WHITESPACE_RUN, ' ').trim();
  if (text === '') return null;
  const match = /^(\d+(?:\.\d+)?)\s*(.+)$/.exec(text);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  // A second number anywhere means a range or a sum; refuse rather than take the first.
  if (/\d/.test(match[2].replace(/\/\s*a(c|cre|cres)?\b/gi, ''))) return null;
  const unit = rateBaseUnit(match[2]);
  if (unit === '') return null;
  return { value, unit };
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
  // DELIBERATELY NOT zero-width-stripped, and deliberately NOT whitespace-collapsed —
  // unlike `normalizeUnit` below. This is the SERVER-PARITY normalizer, and its only
  // job is to predict what the live `normalize_rate_unit` will do. That function is
  // `lower(btrim(COALESCE(p_unit,'')))` plus a CASE: `btrim` strips OUTER SPACES ONLY,
  // so live returns 'm<ZWSP>g' and 'fl  oz' unchanged, matches no size table, and
  // `field_app_priced_quantity` refuses — which makes
  // `create_invoice_from_blend_ticket` raise BLEND_TICKET_UNIT_UNCONVERTIBLE.
  //
  // Closing the character up here would make this check MORE permissive than the
  // database it is predicting: the ticket would look invoice-ready and then fail at
  // billing. Verified against live `pg_proc.prosrc` on 2026-08-20 (gpt-5.6-sol finding
  // CRX-MONEY-PARITY-001 on PR #439). The operator-friendly fix is to teach the SQL to
  // close zero-width up, in a reviewed migration, and relax this in the same change —
  // never one side alone. `normalizeUnit` may and does strip them, because it only
  // ever compares two client-side strings and no server contract rides on it.
  const raw = (unit ?? '').trim().toLowerCase();
  if (raw === '') return '';
  const perAcreSlash = /\s*\/\s*(ac|acre|acres|a)\s*$/;
  const perAcreSpelled = /\s+per\s+acre$/;
  if (perAcreSlash.test(raw)) return raw.replace(perAcreSlash, '').trim();
  if (perAcreSpelled.test(raw)) return raw.replace(perAcreSpelled, '').trim();
  return raw;
}

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

/**
 * A warning, tiered by what it actually claims.
 *
 * `mismatch` — a comparison RAN and disagreed. Something on this ticket is wrong
 * and is worth stopping for. These should be rare.
 * `unchecked` — a comparison could NOT run: a unit is missing, or the units are
 * from families that cannot be converted without a density the database does not
 * carry. Nothing is known to be wrong; the operator is simply being told what was
 * not verified for them.
 *
 * The split exists because the two used to render identically. On a realistic
 * ticket the "unchecked" kind is the common one, so showing it in the same alarmed
 * amber as a real error teaches operators that the banner means nothing — the
 * failure mode an adversarial review flagged as the main risk of this whole
 * redesign.
 */
export type BlendMathWarningLevel = 'mismatch' | 'unchecked';

export interface BlendMathWarning {
  level: BlendMathWarningLevel;
  message: string;
}

export function validateBlendMath(
  ticketData: TicketData,
  products: ProductData[]
): BlendMathWarning[] {
  const warnings: BlendMathWarning[] = [];
  /** A comparison ran and disagreed — something here is actually wrong. */
  const mismatch = (message: string) => warnings.push({ level: 'mismatch', message });
  /** A comparison could not run. Nothing is known to be wrong. */
  const unchecked = (message: string) => warnings.push({ level: 'unchecked', message });
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
        unchecked(
          `Not checked — ${name}: the rate is in ${rateUnit} but the quantity is in ${qtyUnit}, which can't be converted${form === 'dry' ? ' for a dry product' : ''}. Please verify this line by hand.`
        );
      } else if (expected > 0) {
        const pctDiff = Math.abs(product.quantity - expected) / expected;
        if (pctDiff > TOLERANCE) {
          const inUnit = qtyUnit !== '' && qtyUnit !== rateUnit ? ` ${qtyUnit}` : '';
          mismatch(
            `${name}: quantity (${product.quantity}) doesn't match rate/acre (${product.rate_per_acre}${rateUnit ? ' ' + rateUnit : ''}) × acres (${totalAcres}) = ${expected.toFixed(2)}${inUnit}`
          );
        }
      }

    }
  }

  // Invoice pre-flight. `create_invoice_from_blend_ticket` hard-raises
  // BLEND_TICKET_UNIT_UNCONVERTIBLE when a billable line's rate unit cannot be
  // converted to the unit the product is sold in. Catching it here turns an error
  // discovered weeks later at invoicing into a note while the ticket is open.
  //
  // This runs in its OWN loop, deliberately outside the acres block above. Whether a
  // rate unit can reach the sold unit is a property of the product row alone — it does
  // not depend on `total_acres` being filled in yet, nor on a quantity having been
  // entered. Leaving it nested meant a half-filled ticket reported nothing and then
  // failed at billing, which is the exact surprise this check exists to prevent.
  // Still gated on a real rate, so a blank new row stays quiet.
  for (const product of products) {
    if (!product.rate_per_acre || product.rate_per_acre <= 0) continue;
    const name = product.product_name || 'Unnamed product';
    const form = product.product_form?.trim().toLowerCase() === 'dry' ? 'dry' : 'liquid';
    const lineRateUnit = (product.rate_per_acre_unit ?? '').trim();
    const rateUnit = rateBaseUnit(lineRateUnit !== '' ? lineRateUnit : product.product_rate_unit);
    const soldUnit = rateBaseUnit(product.product_inventory_unit);
    // Deliberately silent when either side is blank, though the SQL would refuse such
    // a line (gpt-5.6-sol MED #1, PR #439). A blank here does NOT reliably mean the
    // catalog is missing a unit: it equally means this caller did not resolve the
    // catalog row — an inactive product is absent from the `allProducts` list the
    // pages filter to `is_active`. Live measurement on 2026-08-20 says the innocent
    // reading is the likely one: 0 of 595 active products lack a sold unit. So warning
    // on blank would mostly produce false "not recorded" notes from load gaps, which
    // is exactly the wallpaper effect the two-tier design exists to avoid. Closing
    // this properly means telling the validator whether the catalog row RESOLVED,
    // rather than inferring it from an empty string; tracked in KNOWN_ISSUES.md.
    if (rateUnit !== '' && soldUnit !== '' && fieldAppPricedQuantity(1, rateUnit, soldUnit, form) === null) {
      mismatch(
        `${name}: the rate unit (${rateUnit}) can't be converted to the unit this product is sold in (${soldUnit}), so this ticket will fail when you invoice it.`
      );
    }
  }

  // ── Total volume ───────────────────────────────────────────────────────────
  //
  // The old check here summed every product quantity and compared it to
  // total_volume. Mason confirmed on 2026-08-19 that a blend ticket's total volume
  // is "everything in the sprayer, so water + product". The products are therefore
  // meant to come to FAR LESS than the total — a 1,000 gal tank might hold 50 gal
  // of actual product — so that equation was not merely unit-blind, it was the
  // wrong equation, and unit-converting it would only have made a false alarm more
  // precise. It is gone rather than fixed.
  //
  // Three statements that ARE true replace it, below.

  // (1) The tank equation: the header's own per-acre rate times the acres is the
  // finished tank. Water sits on both sides and cancels. This runs only when the
  // free-text rate parses unambiguously, which is why it is a bonus check and not
  // the primary one — see parseApplicationRate.
  const parsedRate = parseApplicationRate(ticketData.application_rate);
  const headerUnit = rateBaseUnit(ticketData.total_volume_unit);
  if (parsedRate !== null && totalAcres && totalAcres > 0 && totalVolume && totalVolume > 0 && headerUnit !== '') {
    const expectedTank = fieldAppPricedQuantity(parsedRate.value * totalAcres, parsedRate.unit, headerUnit, 'liquid');
    if (expectedTank !== null && expectedTank > 0) {
      const pctDiff = Math.abs(totalVolume - expectedTank) / expectedTank;
      if (pctDiff > TOLERANCE) {
        mismatch(
          `Total volume (${totalVolume} ${headerUnit}) doesn't match the application rate (${parsedRate.value} ${parsedRate.unit}/acre) × acres (${totalAcres}) = ${expectedTank.toFixed(2)} ${headerUnit}`
        );
      }
    }
  }

  // (2) and (3) both need each product measured in the ticket's own unit.
  if (totalVolume && totalVolume > 0 && products.length > 0 && headerUnit !== '') {
    // A total recorded in a weight unit is a DRY BLEND: no water, so the parts
    // must equal the whole (Mason, 2026-08-19). A total in a volume unit is a
    // spray tank, where water is the unentered remainder and only a one-sided
    // bound is safe. `oz` is ambiguous and falls to the volume reading.
    const totalIsWeight = WEIGHT_ONLY_UNITS.has(headerUnit);
    const totalIsVolume = VOLUME_ONLY_UNITS.has(headerUnit) || headerUnit === 'oz';

    let convertedSum = 0;
    let anyContributing = false;
    let anyUnconvertible = false;
    // Two different reasons a row can sit out, which must NOT be conflated:
    //   • no unit recorded at all — a data gap worth telling the operator about,
    //     and the hole three separate reviews found in the previous design;
    //   • a perfectly good unit from the other family (pounds of dry product in a
    //     gallon tank) — entirely normal on a real ticket, and warning about it
    //     every time is how a banner gets trained into wallpaper.
    let anyMissingUnit = false;
    // The third case, split out from the second: a row that HAS a unit, is not the
    // expected other-family exclusion, and still would not convert. That is an
    // anomaly rather than a normal ticket, and on a spray tank it used to vanish in
    // silence — it left `convertedSum` and said nothing, so a ticket could pass with
    // a product quietly uncounted. Exactly the silent-skip this file exists to remove.
    let anyUnexpectedUnconvertible = false;
    for (const p of products) {
      const qty = p.quantity || 0;
      if (qty === 0) continue;
      anyContributing = true;
      const unitRecorded = normalizeUnit(p.unit) !== null;
      if (!unitRecorded) anyMissingUnit = true;
      const form = p.product_form?.trim().toLowerCase() === 'dry' ? 'dry' : 'liquid';
      const converted = fieldAppPricedQuantity(qty, rateBaseUnit(p.unit), headerUnit, form);
      if (converted === null) {
        anyUnconvertible = true;
        // Dry product in a spray tank is the ONE expected exclusion (pounds do not
        // convert to gallons without a density), so it stays quiet. A row with no
        // unit at all is already reported above and must not be counted twice.
        if (unitRecorded && !(totalIsVolume && form === 'dry')) anyUnexpectedUnconvertible = true;
      } else {
        convertedSum += converted;
      }
    }

    if (anyMissingUnit) {
      unchecked(
        `Not checked — a product has a quantity but no unit, so it can't be counted towards the total. Please verify the total by hand.`
      );
    }

    if (anyContributing && totalIsWeight && anyUnconvertible) {
      // A dry blend's parts are supposed to equal its whole, so unlike the spray
      // bound below, dropping a row here would break the claim rather than soften
      // it. Say the check was abandoned instead of quietly comparing a subset.
      unchecked(
        `Total weight not checked: not every product is recorded in a weight unit that can be compared to ${headerUnit}. Please verify the total by hand.`
      );
    } else if (anyContributing && totalIsWeight && !anyUnconvertible) {
      // Dry blend: the products ARE the total.
      const pctDiff = Math.abs(convertedSum - totalVolume) / totalVolume;
      if (pctDiff > TOLERANCE) {
        mismatch(
          `Total weight (${totalVolume} ${headerUnit}) doesn't match the products, which add up to ${convertedSum.toFixed(2)} ${headerUnit}`
        );
      }
    } else if (anyContributing && totalIsVolume) {
      // Spray tank: products may be far under the total (the rest is water), but
      // they can never be OVER it. One-sided, so it cannot false-alarm whatever the
      // water volume happens to be. Rows that could not be converted are simply
      // absent from the sum, which only makes the bound more forgiving, never
      // wrong — but the operator still has to be TOLD a row sat out, or "no warning"
      // reads as "checked and fine" when part of the ticket was never counted.
      if (convertedSum > totalVolume * (1 + TOLERANCE)) {
        // Excluded rows only ever lower the sum, so if what remains already exceeds
        // the tank the mismatch is true regardless — say that, and only that.
        mismatch(
          `The products add up to ${convertedSum.toFixed(2)} ${headerUnit}, which is more than the total volume of ${totalVolume} ${headerUnit}. A tank can't hold more product than its total.`
        );
      } else if (anyUnexpectedUnconvertible) {
        unchecked(
          `Total volume not fully checked: a product's unit can't be compared to ${headerUnit}, so it isn't counted towards the total. Please verify the total by hand.`
        );
      }
    } else if (anyContributing) {
      // The total's unit is recorded but belongs to neither family — free text like
      // 'ea', or a spelling no size table carries. Neither branch above can run, so
      // without this the whole total check disappears in silence and the ticket looks
      // verified. Name the unit, since it is the thing the operator can fix.
      unchecked(
        `Total not checked: "${ticketData.total_volume_unit}" isn't a unit the products can be added up in, so the total couldn't be compared. Please verify it by hand.`
      );
    }
  }

  // Legacy comparison, retained ONLY for the shape it was always right for: a
  // ticket carrying no unit information at all, where there is nothing to convert
  // and nothing to contradict. Everything above supersedes it when units exist.
  if (totalVolume && totalVolume > 0 && products.length > 0 && headerUnit === '') {
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
        unchecked(
          `Total volume not checked: a product has a quantity but no unit, so it can't be told whether it adds to the rest. Please verify the total by hand.`
        );
      } else if (someUnitRecorded && ticketUnitMissing) {
        unchecked(
          `Total volume not checked: the products have units but the total volume doesn't, so there's nothing to compare them against. Please verify the total by hand.`
        );
      } else if (unitLabels.size > 1) {
        const labels = Array.from(unitLabels.values()).join(', ');
        unchecked(
          `Total volume not checked: these are not all the same unit (${labels}). Quantities in different units can't be added together, so please verify the total by hand.`
        );
      } else {
        const diff = Math.abs(sumQuantities - totalVolume);
        const pctDiff = diff / totalVolume;
        if (pctDiff > TOLERANCE) {
          mismatch(
            `Total product quantities (${sumQuantities.toFixed(2)}) doesn't match total volume (${totalVolume}${ticketData.total_volume_unit ? ' ' + ticketData.total_volume_unit : ''})`
          );
        }
      }
    }
  }

  return warnings;
}
