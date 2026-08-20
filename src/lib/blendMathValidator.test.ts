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

      // Raised as a Major by CodeRabbit on PR #439: `anyUnconvertible` was computed
      // and then never consulted in this branch, so a row that could not convert left
      // the sum in total silence and "no warning" read as "checked and fine".
      it('says so when a liquid row could not be counted towards the tank', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 1000, total_volume_unit: 'gal', application_rate: null },
          [
            { product_name: 'A', quantity: 30, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
            { product_name: 'B', quantity: 20, unit: 'furlong', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
          ]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('unchecked');
        expect(warnings[0].message).toContain('not fully checked');
      });

      // Pins the precedence choice: excluded rows only ever LOWER the sum, so if what
      // was counted already exceeds the tank the mismatch is true regardless and must
      // stand alone. Emitting the "couldn't count a row" note beside it would soften a
      // verdict that needs no softening.
      it('reports only the over-capacity mismatch when a row also could not be counted', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 100, total_volume_unit: 'gal', application_rate: null },
          [
            { product_name: 'A', quantity: 140, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
            { product_name: 'B', quantity: 20, unit: 'furlong', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
          ]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('mismatch');
        expect(warnings[0].message).toContain('more than the total volume');
      });

      // The deliberate exclusion this must not undo: pounds of dry product in a
      // gallon tank is an ordinary ticket, and warning every time is how the banner
      // becomes wallpaper.
      it('stays quiet about a DRY product sitting out of a liquid tank', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 1000, total_volume_unit: 'gal', application_rate: null },
          [
            { product_name: 'A', quantity: 30, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
            { product_name: 'B', quantity: 20, unit: 'lb', rate_per_acre: null, rate_per_acre_unit: null, ...dry },
          ]
        );
        expect(warnings).toHaveLength(0);
      });

      it('does not report a row with no unit twice', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 1000, total_volume_unit: 'gal', application_rate: null },
          [
            { product_name: 'A', quantity: 30, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liq },
            { product_name: 'B', quantity: 20, unit: null, rate_per_acre: null, rate_per_acre_unit: null, ...liq },
          ]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('no unit');
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

    // gpt-5.6-sol MED #3 on PR #439. The family sets originally listed only US
    // spellings, so a total in `kg` or `liters` matched NEITHER family, ran no check
    // at all, and said nothing — silence that reads as "verified". The live
    // `normalize_rate_unit` CASE knows all of these, so the sets now match it.
    describe('unit families the database knows', () => {
      it('treats a metric VOLUME total as a spray tank', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 100, total_volume_unit: 'liters', application_rate: null },
          [{ product_name: 'A', quantity: 140, unit: 'liters', rate_per_acre: null, rate_per_acre_unit: null, ...liq }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('mismatch');
        expect(warnings[0].message).toContain('more than the total volume');
      });

      it('treats a metric WEIGHT total as a dry blend', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 100, total_volume_unit: 'kg', application_rate: null },
          [{ product_name: 'A', quantity: 50, unit: 'kg', rate_per_acre: null, rate_per_acre_unit: null, ...dry }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('mismatch');
        expect(warnings[0].message).toContain('Total weight');
      });

      it('says so when the total unit belongs to no family at all', () => {
        // The unit fields are free text, so this is reachable. Silence here used to
        // look identical to a clean ticket.
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 100, total_volume_unit: 'buckets', application_rate: null },
          [{ product_name: 'A', quantity: 10, unit: 'buckets', rate_per_acre: null, rate_per_acre_unit: null, ...liq }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('unchecked');
        expect(warnings[0].message).toContain('buckets');
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

    // Whether a rate unit can reach the sold unit is a property of the product row
    // alone. These pin that the pre-flight does not hide behind a half-filled header,
    // which is precisely when an operator is still able to fix the unit.
    it('predicts the invoice failure even before total acres is entered', () => {
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: null, total_volume_unit: null, application_rate: null },
        [{
          product_name: 'Post spray', quantity: 200, unit: 'MG', rate_per_acre: 2, rate_per_acre_unit: 'MG',
          product_form: 'dry', product_rate_unit: 'MG', product_inventory_unit: 'lb',
        }]
      );
      expect(warnings.some((w) => w.message.includes('fail when you invoice it'))).toBe(true);
    });

    it('predicts the invoice failure even before a quantity is entered', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{
          product_name: 'Post spray', quantity: 0, unit: 'MG', rate_per_acre: 2, rate_per_acre_unit: 'MG',
          product_form: 'dry', product_rate_unit: 'MG', product_inventory_unit: 'lb',
        }]
      );
      expect(warnings.some((w) => w.message.includes('fail when you invoice it'))).toBe(true);
    });

    it('stays quiet on a blank new row that has no rate yet', () => {
      // The other half of the contract: running the pre-flight outside the acres
      // block must not make an untouched row start shouting.
      const warnings = validateBlendMath(
        { total_acres: null, total_volume: null, total_volume_unit: null, application_rate: null },
        [{
          product_name: '', quantity: 0, unit: null, rate_per_acre: null, rate_per_acre_unit: null,
          product_form: null, product_rate_unit: null, product_inventory_unit: 'lb',
        }]
      );
      expect(warnings).toHaveLength(0);
    });

    it('keeps the plain numeric comparison when no unit is recorded on either side', () => {
      const warnings = validateBlendMath(
        { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
        [{ product_name: 'A', quantity: 250, unit: null, rate_per_acre: 2, rate_per_acre_unit: null, product_form: null, product_rate_unit: null, product_inventory_unit: null }]
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain('200.00');
    });

    // These pin the CLIENT/SERVER PARITY contract, and they are the reason
    // `rateBaseUnit` deliberately does not reuse `normalizeUnit`'s zero-width strip.
    //
    // PR #426 taught `normalizeUnit` to delete zero-width characters, which is right:
    // that function only ever compares two client-side strings. `rateBaseUnit` is a
    // different animal — it predicts the live `normalize_rate_unit`, which is
    // `lower(btrim(...))` plus a CASE. `btrim` strips OUTER SPACES ONLY, so the
    // database keeps 'm<ZWSP>g' intact, matches no size table, and
    // `create_invoice_from_blend_ticket` raises BLEND_TICKET_UNIT_UNCONVERTIBLE.
    //
    // So the CORRECT behaviour on a pasted unit is to refuse it here too, loudly and
    // early, rather than to close the character up and let a ticket look invoice-ready
    // that the database will later reject. A first pass at this branch stripped them
    // here and was caught by gpt-5.6-sol (CRX-MONEY-PARITY-001, PR #439); the live
    // `pg_proc.prosrc` was then read directly to confirm it. If the SQL is ever
    // hardened to close zero-width up, relax this in the SAME change — never one side.
    describe('zero-width characters must not out-run the database', () => {
      const ZWSP = String.fromCharCode(0x200b);
      const ZWNJ = String.fromCharCode(0x200c);
      const ZWJ = String.fromCharCode(0x200d);
      const BOM = String.fromCharCode(0xfeff);

      it('refuses a zero-width RATE unit, exactly as the database will', () => {
        // Arithmetically this is the correct ticket — 2 lb/ac × 100 ac = 3200 dry oz —
        // and it still must NOT come back clean, because live cannot price 'l<ZWSP>b'.
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
          [{ product_name: 'Dry A', quantity: 3200, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: `l${ZWSP}b`, ...dry }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('unchecked');
        expect(warnings[0].message).toContain('Not checked');
      });

      it('refuses a zero-width QUANTITY unit rather than guessing past it', () => {
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
          [{ product_name: 'A', quantity: 25600, unit: `o${ZWNJ}z`, rate_per_acre: 2, rate_per_acre_unit: 'gal', ...liquid }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('unchecked');
      });

      // U+200D completes the set `ZERO_WIDTH` names (200B/200C/200D/FEFF), so the
      // joiner gets the same refusal as its two siblings.
      it('refuses a zero-width JOINER the same way', () => {
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
          [{ product_name: 'A', quantity: 25600, unit: 'oz', rate_per_acre: 2, rate_per_acre_unit: `g${ZWJ}al`, ...liquid }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('unchecked');
      });

      it('reports the refusal as "unchecked", never as a confident wrong number', () => {
        // 200 oz against 2 gal/ac × 100 ac IS a 128x error, but with a zero-width in
        // the quantity unit we cannot know that — the units never converted. Saying
        // 'mismatch' here would be asserting a comparison that never ran.
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
          [{ product_name: 'A', quantity: 200, unit: `o${ZWSP}z`, rate_per_acre: 2, rate_per_acre_unit: 'gal', ...liquid }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('unchecked');
        expect(warnings[0].message).not.toContain('25600.00');
      });

      // The load-bearing one. This warning is TRUE: live really will refuse this
      // ticket at invoicing, so the operator needs to hear it while the ticket is
      // still open and the unit can be retyped.
      it('warns that the invoice WILL fail on a zero-width rate unit', () => {
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
          [{
            product_name: 'Post spray', quantity: 200, unit: 'MG', rate_per_acre: 2, rate_per_acre_unit: `M${ZWSP}G`,
            product_form: 'dry', product_rate_unit: 'MG', product_inventory_unit: 'MG',
          }]
        );
        expect(warnings.some((w) => w.message.includes('fail when you invoice it'))).toBe(true);
      });

      // The other side of the same contract: a CLEAN unit must still sail through, or
      // the parity rule above would just be "refuse everything". Mason bills a
      // post-spray product in MG, and the SQL's identity short-circuit prices it.
      it('still prices a clean MG rate against an MG sold unit', () => {
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
          [{
            product_name: 'Post spray', quantity: 200, unit: 'MG', rate_per_acre: 2, rate_per_acre_unit: 'MG',
            product_form: 'dry', product_rate_unit: 'MG', product_inventory_unit: 'MG',
          }]
        );
        expect(warnings).toHaveLength(0);
      });

      it('still refuses a genuine liquid-to-dry crossing across a zero-width character', () => {
        // Belt and braces: even if the zero-width were closed up, 'lb' against a
        // LIQUID product has no density to convert through and must still refuse.
        const warnings = validateBlendMath(
          { total_acres: 100, total_volume: null, total_volume_unit: null, application_rate: null },
          [{ product_name: 'A', quantity: 25, unit: 'gal', rate_per_acre: 2, rate_per_acre_unit: `l${ZWSP}b`, ...liquid }]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].level).toBe('unchecked');
        expect(warnings[0].message).toContain('Not checked');
      });

      // Ported almost unchanged from PR #426 — this one still lands on the arm it was
      // written for. A unit that is ENTIRELY zero-width is not a unit at all.
      it('treats a unit made only of zero-width characters as not recorded', () => {
        const warnings = validateBlendMath(
          { total_acres: null, total_volume: 300, total_volume_unit: 'gal', application_rate: null },
          [
            { product_name: 'A', quantity: 100, unit: 'gal', rate_per_acre: null, rate_per_acre_unit: null, ...liquid },
            { product_name: 'B', quantity: 200, unit: `${ZWSP}${BOM}`, rate_per_acre: null, rate_per_acre_unit: null, ...liquid },
          ]
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toContain('no unit');
      });
    });
  });
});
