import { describe, it, expect } from 'vitest';
import { validateBlendMath } from './blendMathValidator';

describe('validateBlendMath', () => {
  describe('per-product rate × acres validation', () => {
    it('returns no warnings when quantity matches rate × acres', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [
          { product_name: 'Atrazine', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('warns when quantity deviates > 5% from expected', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [
          { product_name: 'Atrazine', quantity: 250, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('Atrazine');
      expect(warnings[0].message).toContain('250');
      expect(warnings[0].message).toContain('200');
    });

    it('passes within 5% tolerance', () => {
      // 2 × 100 = 200 expected, 209 is 4.5% off (within 5%)
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [
          { product_name: 'Product A', quantity: 209, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('skips products with zero rate_per_acre', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [
          { product_name: 'Water', quantity: 500, unit: 'gal', rate_per_acre: 0, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('skips when total_acres is null', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: null, total_volume_unit: null, application_rate: null },
        [
          { product_name: 'Atrazine', quantity: 250, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });

    it('skips when total_acres is 0', () => {
      const warnings = validateBlendMath(
        { total_acres: 0, total_volume: null, total_volume_unit: null, application_rate: null },
        [
          { product_name: 'Atrazine', quantity: 250, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz', product_form: null, product_rate_unit: null, product_inventory_unit: null },
        ]
      );
      expect(warnings).toHaveLength(0);
    });
  });

  // Mason, 2026-08-19: a blend ticket's total volume is "everything in the sprayer,
  // so water + product". The products are therefore meant to come to FAR LESS than
  // the total, which makes the old sum-equals-total check the wrong equation rather
  // than a unit-blind one. These cases pin the three statements that replaced it.
  describe('total volume', () => {
    const liq = { product_form: 'liquid', product_rate_unit: null, product_inventory_unit: null };
    const dry = { product_form: 'dry', product_rate_unit: null, product_inventory_unit: null };

    describe('the tank equation (rate x acres = total volume)', () => {
      it('stays quiet when the header rate accounts for the total', () => {
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: 1000, total_volume_unit: 'gal', application_rate: '10 gal/acre' },
          []
        );
        expect(warnings).toHaveLength(0);
      });

      it('flags a total that the header rate cannot account for', () => {
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: 250, total_volume_unit: 'gal', application_rate: '10 gal/acre' },
          []
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('1000.00');
      });

      it('converts between liquid units on the way', () => {
        // 16 pt/acre x 100 ac = 1600 pt = 200 gal.
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: 200, total_volume_unit: 'gal', application_rate: '16 pt per acre' },
          []
        );
        expect(warnings).toHaveLength(0);
      });

      // The field is free text. A confident guess about an ambiguous entry is the
      // exact class of bug this rebuild exists to remove, so it declines instead.
      it.each(['', '10', 'about ten gallons', '10-15 gal/acre', '1 qt/ac + 2 lb/ac'])(
        'declines to run on an application rate of %j rather than guessing',
        (rate) => {
          const warnings = validateBlendMath(
            { total_acres: 100, total_volume: 999999, total_volume_unit: 'gal', application_rate: rate },
            []
          );
          expect(warnings).toHaveLength(0);
        }
      );
    });

    describe('spray tank: products can never exceed the tank', () => {
      it('stays quiet when the products are a small part of the tank, the rest being water', () => {
        // The old check called this a mismatch and was wrong to.
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 1000, total_volume_unit: 'gal', application_rate: null },
          [
            { product_name: 'A', quantity: 30, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
            { product_name: 'B', quantity: 20, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
          ]
        );
        expect(warnings).toHaveLength(0);
      });

      it('flags products that add up to more than the tank holds', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 100, total_volume_unit: 'gal', application_rate: null },
          [
            { product_name: 'A', quantity: 80, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
            { product_name: 'B', quantity: 60, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
          ]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain("can't hold more product than its total");
      });

      // Reviewer A's banner-fatigue objection: a dry product in a liquid tank is
      // the ordinary case, not an anomaly, and must not light the banner.
      it('says nothing about a dry product sitting in a liquid tank', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 1000, total_volume_unit: 'gal', application_rate: null },
          [
            { product_name: 'Liquid', quantity: 30, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
            { product_name: 'Dry', quantity: 50, unit: 'lb', rate_per_acre: null, rate_per_acre_unit: null, ...dry },
          ]
        );
        expect(warnings).toHaveLength(0);
      });
    });

    // Mason, 2026-08-19: a dry blend has no water, so the parts must equal the whole.
    describe('dry blend: the parts must equal the whole', () => {
      it('stays quiet when the weights add up', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 2000, total_volume_unit: 'lb', application_rate: null },
          [
            { product_name: 'A', quantity: 1200, unit: 'lb', rate_per_acre: null, rate_per_acre_unit: null, ...dry },
            { product_name: 'B', quantity: 800, unit: 'lb', rate_per_acre: null, rate_per_acre_unit: null, ...dry },
          ]
        );
        expect(warnings).toHaveLength(0);
      });

      it('flags a dry blend whose parts do not equal the whole', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 2000, total_volume_unit: 'lb', application_rate: null },
          [{ product_name: 'A', quantity: 1200, unit: 'lb', rate_per_acre: null, rate_per_acre_unit: null, ...dry }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('1200.00');
      });

      it('converts tons and dry ounces into the ticket weight', () => {
        // 1 ton = 32000 dry oz = 2000 lb.
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 1, total_volume_unit: 'ton', application_rate: null },
          [{ product_name: 'A', quantity: 2000, unit: 'lb', rate_per_acre: null, rate_per_acre_unit: null, ...dry }]
        );
        expect(warnings).toHaveLength(0);
      });

      // Dropping a row would break the equality claim rather than soften it, so
      // unlike the spray bound this one has to say it gave up.
      it('abandons the check, loudly, if a product is not in a weight unit', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 2000, total_volume_unit: 'lb', application_rate: null },
          [
            { product_name: 'A', quantity: 2000, unit: 'lb', rate_per_acre: null, rate_per_acre_unit: null, ...dry },
            { product_name: 'B', quantity: 5, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
          ]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('Total weight not checked');
      });
    });

    describe('missing units', () => {
      // The hole three separate reviews found, preserved through the redesign.
      it('reports a quantity entered with no unit at all', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 1000, total_volume_unit: 'gal', application_rate: null },
          [{ product_name: 'A', quantity: 50, unit: '', rate_per_acre: null, rate_per_acre_unit: null, ...liq }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('quantity but no unit');
      });

      it('ignores a blank unit on a row contributing nothing', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 1000, total_volume_unit: 'gal', application_rate: null },
          [{ product_name: 'A', quantity: 0, unit: '', rate_per_acre: null, rate_per_acre_unit: null, ...liq }]
        );
        expect(warnings).toHaveLength(0);
      });

      it('still compares bare numbers when the ticket records no unit anywhere', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 250, total_volume_unit: '', application_rate: null },
          [
            { product_name: 'A', quantity: 100, unit: '', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
            { product_name: 'B', quantity: 200, unit: null, rate_per_acre: null, rate_per_acre_unit: null, ...liq },
          ]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('300.00');
      });

      // Every OCR-imported ticket arrives in this shape.
      it('refuses when the products carry units but the total does not', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 300, total_volume_unit: '', application_rate: null },
          [{ product_name: 'A', quantity: 300, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain("total volume doesn't");
      });
    });
  });

  // The tier decides how loudly the UI speaks. 'mismatch' means a comparison ran
  // and disagreed and is rendered in alarmed amber; 'unchecked' means nothing could
  // be compared and is rendered as a quiet grey note. Promoting an 'unchecked' to a
  // 'mismatch' would relight the permanent banner an adversarial review warned
  // about, so each one is pinned here rather than left to the message text.
  describe('warning tiers', () => {
    const liq = { product_form: 'liquid', product_rate_unit: null, product_inventory_unit: null };

    it('marks a real disagreement as a mismatch', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: 250, total_volume_unit: 'gal', application_rate: '10 gal/acre' },
        []
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].level).toBe('mismatch');
    });

    it('marks an over-full tank as a mismatch', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 100, total_volume_unit: 'gal', application_rate: null },
        [{ product_name: 'A', quantity: 140, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].level).toBe('mismatch');
    });

    it('marks a missing product unit as unchecked, not as an error', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 1000, total_volume_unit: 'gal', application_rate: null },
        [{ product_name: 'A', quantity: 50, unit: '', rate_per_acre: null, rate_per_acre_unit: null, ...liq }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].level).toBe('unchecked');
    });

    it('marks a missing ticket total unit as unchecked, not as an error', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: 300, total_volume_unit: '', application_rate: null },
        [{ product_name: 'A', quantity: 300, unit: 'Gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].level).toBe('unchecked');
    });

    it('marks an unconvertible rate/quantity pairing as unchecked', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{ product_name: 'A', quantity: 3200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'lb', ...liq }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].level).toBe('unchecked');
    });

    // This one predicts a hard invoice-time failure, so it is a real problem even
    // though no comparison "disagreed" — it must not be filed under quiet notes.
    it('marks a predicted invoice failure as a mismatch', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{
          product_name: 'Post spray', quantity: 200, unit: 'MG', rate_per_acre: 2, rate_per_acre_unit: 'MG',
          product_form: 'dry', product_rate_unit: 'MG', product_inventory_unit: 'lb',
        }]
      );
      const invoiceWarning = warnings.find((w) => w.message.includes('fail when you invoice it'));
      expect(invoiceWarning).toBeDefined();
      expect(invoiceWarning?.level).toBe('mismatch');
    });
  });

  // The rate arm feeds BILLING: create_invoice_from_blend_ticket prices each line
  // from rate_per_acre and its unit, never from quantity. These cases pin the check
  // to the same conversion rules the invoice uses, so the two can never disagree.
  describe('unit-aware rate check (billing parity)', () => {
    const liquid = { product_form: 'liquid', product_rate_unit: null, product_inventory_unit: null };
    const dry = { product_form: 'dry', product_rate_unit: null, product_inventory_unit: null };

    it('converts within the liquid family: 2 gal/ac over 100 ac = 25600 oz', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{ product_name: 'A', quantity: 25600, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'gal', ...liquid }]
      );
      expect(warnings).toHaveLength(0);
    });

    it('flags a real mismatch after converting, rather than comparing bare numbers', () => {
      // 2 gal/ac × 100 ac = 200 gal = 25600 oz. Entering 200 oz is a 128x error that
      // the old unit-blind check called a perfect match.
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{ product_name: 'A', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'gal', ...liquid }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('25600.00');
    });

    // Mason, 2026-08-19: "oz" against a DRY product means a weight ounce.
    it('reads oz as a WEIGHT ounce for a dry product', () => {
      // 2 lb/ac × 100 ac = 200 lb = 3200 dry oz.
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{ product_name: 'Dry A', quantity: 3200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'lb', ...dry }]
      );
      expect(warnings).toHaveLength(0);
    });

    it('refuses the same lb-to-oz pairing on a LIQUID product instead of guessing', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{ product_name: 'A', quantity: 3200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'lb', ...liquid }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('Not checked');
    });

    // Billing does COALESCE(NULLIF(btrim(rate_per_acre_unit),''), p.rate_unit) and
    // charges. Recipe-applied rows ALWAYS arrive with a blank rate unit, so going
    // silent here would abandon exactly the rows that still bill.
    it('falls back to the product default rate unit when the line leaves it blank', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{
          product_name: 'A', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: '',
          product_form: 'liquid', product_rate_unit: 'gal', product_inventory_unit: null,
        }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('25600.00');
    });

    it('strips a per-acre suffix so pt/ac matches a pt quantity', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{ product_name: 'A', quantity: 200, unit: 'pt', rate_per_acre: 2, rate_per_acre_unit: 'pt/ac', ...liquid }]
      );
      expect(warnings).toHaveLength(0);
    });

    // The live normalize_rate_unit keeps a non-acre denominator whole so it cannot
    // match a bare unit. chemCalculator's baseUnitOfRate would read this as 'oz' and
    // claim a conversion the invoice rejects — silence here, hard error at billing.
    it('refuses a non-acre denominator rather than reading oz/cwt as oz', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{ product_name: 'A', quantity: 200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: 'oz/cwt', ...liquid }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('Not checked');
    });

    it('stays quiet on an MG-rated, MG-sold product (the identity path billing uses)', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{
          product_name: 'Post spray', quantity: 200, unit: 'MG', rate_per_acre: 2, rate_per_acre_unit: 'MG',
          product_form: 'dry', product_rate_unit: 'MG', product_inventory_unit: 'MG',
        }]
      );
      expect(warnings).toHaveLength(0);
    });

    // create_invoice_from_blend_ticket hard-raises BLEND_TICKET_UNIT_UNCONVERTIBLE
    // for this shape. Better a note now than a failed invoice weeks later.
    it('predicts the invoice failure when the rate unit cannot reach the sold unit', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{
          product_name: 'Post spray', quantity: 200, unit: 'MG', rate_per_acre: 2, rate_per_acre_unit: 'MG',
          product_form: 'dry', product_rate_unit: 'MG', product_inventory_unit: 'lb',
        }]
      );
      expect(warnings.some((w) => w.message.includes('fail when you invoice it'))).toBe(true);
    });

    it('keeps the plain numeric comparison when no unit is recorded on either side', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{ product_name: 'A', quantity: 250, unit: null, rate_per_acre: 2, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('200.00');
    });
  });
});
