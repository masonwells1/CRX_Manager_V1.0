import { describe, expect, it } from 'vitest';
import type { EpaLookupResult } from '../../supabase/functions/epa-lookup/logic.ts';
import {
  buildFindingsForRegistration,
  buildMissingEpaFinding,
  classifyRegistrationNumber,
  groupProductsByRegistration,
  trustedAvailableSignalWord,
  type EpaDataQualityProduct,
} from './epaDataQualityReport';

const product = (
  overrides: Partial<EpaDataQualityProduct> = {},
): EpaDataQualityProduct => ({
  id: 'product-1',
  product_name: '2,4-D Amine',
  epa_registration: '62719-524',
  epaRegistrationDb: '62719-524',
  is_rup: false,
  signal_word: null,
  ...overrides,
});

const epa = (overrides: Partial<EpaLookupResult> = {}): EpaLookupResult => ({
  found: true,
  regType: 'section3',
  eparegno: '62719-524',
  productname: 'FOREFRONT R&P',
  signalWordCanonical: 'Danger',
  needsManual: false,
  manufacturer: 'EPA Company',
  rupYn: 'No',
  productStatus: 'Active',
  isCancelled: false,
  activeIngredients: [],
  latestLabelPdfUrl: null,
  labelPdfs: [],
  ...overrides,
});

function types(
  registrationNumber: string,
  products: EpaDataQualityProduct[],
  result: EpaLookupResult | null,
) {
  return buildFindingsForRegistration(
    registrationNumber,
    classifyRegistrationNumber(registrationNumber),
    products,
    result,
  ).map((finding) => finding.type);
}

describe('EPA data-quality finding classification', () => {
  it('flags a clearly different Section 3 product name as NAME_MISMATCH', () => {
    expect(types('62719-524', [product()], epa())).toContain('NAME_MISMATCH');
  });

  it('uses informational DISTRIBUTOR_NAME_DIFF instead of NAME_MISMATCH', () => {
    const result = epa({ regType: 'distributor', eparegno: '62719-524-123' });
    const findingTypes = types(
      '62719-524-123',
      [product({ epa_registration: '62719-524-123' })],
      result,
    );

    expect(findingTypes).toContain('DISTRIBUTOR_NAME_DIFF');
    expect(findingTypes).not.toContain('NAME_MISMATCH');
  });

  it('reports a canonical signal word only when the product field is blank', () => {
    expect(types('62719-524', [product({ signal_word: '  ' })], epa()))
      .toContain('SIGNAL_WORD_AVAILABLE');
    expect(types('62719-524', [product({ signal_word: 'Caution' })], epa()))
      .not.toContain('SIGNAL_WORD_AVAILABLE');
  });

  it('creates an actionable finding for a pesticide with no EPA number', () => {
    const finding = buildMissingEpaFinding(product({ epa_registration: '' }));

    expect(finding).toMatchObject({
      type: 'MISSING_EPA',
      level: 'action',
      registrationNumber: '',
    });
  });

  it('offers an EPA signal word only when no registration trust breaker exists', () => {
    const base = buildFindingsForRegistration(
      '62719-524',
      classifyRegistrationNumber('62719-524'),
      [product({ product_name: 'FOREFRONT R&P' })],
      epa(),
    );
    expect(trustedAvailableSignalWord(base)).toBe('Danger');

    expect(trustedAvailableSignalWord([
      ...base,
      { ...base[0], type: 'DISTRIBUTOR_NAME_DIFF' },
      { ...base[0], type: 'RUP_DISAGREE' },
    ])).toBe('Danger');

    for (const result of [
      epa({ productname: 'Unrelated Product' }),
      epa({ isCancelled: true, productStatus: 'Cancelled' }),
      epa({ needsManual: true, signalWordCanonical: null }),
      epa({ found: false }),
    ]) {
      const findings = buildFindingsForRegistration(
        '62719-524',
        classifyRegistrationNumber('62719-524'),
        [product()],
        result,
      );
      expect(trustedAvailableSignalWord(findings)).toBeNull();
    }
  });

  it('reports cancellation, RUP disagreement, and manual signal words', () => {
    const findingTypes = types('62719-524', [product()], epa({
      isCancelled: true,
      productStatus: 'Cancelled',
      rupYn: 'Yes',
      signalWordCanonical: null,
      needsManual: true,
    }));

    expect(findingTypes).toEqual(expect.arrayContaining([
      'CANCELLED',
      'RUP_DISAGREE',
      'NEEDS_MANUAL',
    ]));
  });

  it('classifies unsupported and not-found registrations without an EPA match', () => {
    expect(types('EPA SLN No. NC950034', [product()], null))
      .toEqual(['UNSUPPORTED_REGNUM']);
    expect(types('62719-524', [product()], epa({ found: false })))
      .toEqual(['NOT_FOUND']);
  });

  it('fans one registration out to every pack-size product deterministically', () => {
    const groups = groupProductsByRegistration([
      product({ id: 'product-b', product_name: 'Example - Bulk' }),
      product({ id: 'product-a', product_name: 'Example - 2.5 Gal' }),
    ]);

    expect([...groups.keys()]).toEqual(['62719-524']);
    expect(groups.get('62719-524')?.map((item) => item.id))
      .toEqual(['product-a', 'product-b']);
  });

  it('preserves the raw database registration while grouping on its trimmed value', () => {
    const groups = groupProductsByRegistration([
      product({ epa_registration: '62719-524', epaRegistrationDb: ' 62719-524 ' }),
    ]);

    expect(groups.get('62719-524')?.[0].epaRegistrationDb).toBe(' 62719-524 ');
  });
});
