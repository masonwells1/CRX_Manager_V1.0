import {
  classifyRegistrationNumber,
  type EpaLookupResult,
  type RegistrationClassification,
} from '../../supabase/functions/epa-lookup/logic.ts';

export { classifyRegistrationNumber };

export interface EpaDataQualityProduct {
  id: string;
  product_name: string;
  epa_registration: string;
  epaRegistrationDb: string;
  is_rup: boolean;
  signal_word: string | null;
  category?: string | null;
}

export type EpaDataQualityFindingType =
  | 'NAME_MISMATCH'
  | 'DISTRIBUTOR_NAME_DIFF'
  | 'CANCELLED'
  | 'RUP_DISAGREE'
  | 'UNSUPPORTED_REGNUM'
  | 'NOT_FOUND'
  | 'SIGNAL_WORD_AVAILABLE'
  | 'MISSING_EPA'
  | 'NEEDS_MANUAL'
  | 'LOOKUP_ERROR';

export interface EpaDataQualityFinding {
  type: EpaDataQualityFindingType;
  level: 'suspected_error' | 'action' | 'informational' | 'operational_error';
  registrationNumber: string;
  productId: string;
  productName: string;
  message: string;
  ourValue?: string | boolean | null;
  epaValue?: string | boolean | null;
}

const GENERIC_NAME_WORDS = new Set([
  'agricultural',
  'concentrate',
  'emulsifiable',
  'flowable',
  'fungicide',
  'herbicide',
  'insecticide',
  'miticide',
  'pesticide',
  'solution',
  'suspension',
]);

function comparableNameTokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) =>
      token.length > 1 &&
      !/^\d+(?:\.\d+)?$/.test(token) &&
      !GENERIC_NAME_WORDS.has(token)
    );
}

/** Conservative by design: only flag names with no shared meaningful token. */
export function namesClearlyDifferent(ours: string, epa: string): boolean {
  const ourTokens = comparableNameTokens(ours);
  const epaTokens = comparableNameTokens(epa);
  if (ourTokens.length === 0 || epaTokens.length === 0) return false;

  const ourSet = new Set(ourTokens);
  return !epaTokens.some((token) => ourSet.has(token));
}

function finding(
  type: EpaDataQualityFindingType,
  level: EpaDataQualityFinding['level'],
  registrationNumber: string,
  product: EpaDataQualityProduct,
  message: string,
  values: Pick<EpaDataQualityFinding, 'ourValue' | 'epaValue'> = {},
): EpaDataQualityFinding {
  return {
    type,
    level,
    registrationNumber,
    productId: product.id,
    productName: product.product_name,
    message,
    ...values,
  };
}

/**
 * Products without a registration are intentionally not sent to the EPA lookup.
 * They still need an action finding so an admin can use the verified correction flow.
 */
export function buildMissingEpaFinding(product: EpaDataQualityProduct): EpaDataQualityFinding {
  return finding(
    'MISSING_EPA',
    'action',
    '',
    product,
    'This pesticide has no EPA registration number saved. Enter a number and verify it against EPA before saving.',
    { ourValue: null, epaValue: null },
  );
}

const SIGNAL_WORD_TRUST_BREAKERS = new Set<EpaDataQualityFindingType>([
  'NAME_MISMATCH',
  'CANCELLED',
  'NOT_FOUND',
  'UNSUPPORTED_REGNUM',
  'NEEDS_MANUAL',
  'LOOKUP_ERROR',
]);

/**
 * Returns the EPA signal word only when this row has a matched, trusted EPA
 * record. Distributor trade-name differences and RUP disagreement are not
 * registration trust failures, so they do not prevent this narrow fill.
 */
export function trustedAvailableSignalWord(
  findings: EpaDataQualityFinding[],
): 'Danger' | 'Warning' | 'Caution' | null {
  if (findings.some((item) => SIGNAL_WORD_TRUST_BREAKERS.has(item.type))) {
    return null;
  }

  const available = findings.find((item) => item.type === 'SIGNAL_WORD_AVAILABLE');
  return available?.epaValue === 'Danger'
    || available?.epaValue === 'Warning'
    || available?.epaValue === 'Caution'
    ? available.epaValue
    : null;
}

export function buildFindingsForRegistration(
  registrationNumber: string,
  classification: RegistrationClassification,
  products: EpaDataQualityProduct[],
  epaResult: EpaLookupResult | null,
): EpaDataQualityFinding[] {
  if (!classification.supported) {
    return products.map((product) => finding(
      'UNSUPPORTED_REGNUM',
      'action',
      registrationNumber,
      product,
      `Registration type ${classification.kind} is not supported by the EPA lookup endpoint.`,
      { ourValue: registrationNumber, epaValue: null },
    ));
  }

  if (!epaResult) return [];

  if (!epaResult.found) {
    return products.map((product) => finding(
      'NOT_FOUND',
      'action',
      registrationNumber,
      product,
      'EPA returned no matching registration.',
      { ourValue: registrationNumber, epaValue: null },
    ));
  }

  const findings: EpaDataQualityFinding[] = [];
  for (const product of products) {
    if (
      epaResult.productname &&
      namesClearlyDifferent(product.product_name, epaResult.productname)
    ) {
      const distributor = classification.kind === 'distributor';
      findings.push(finding(
        distributor ? 'DISTRIBUTOR_NAME_DIFF' : 'NAME_MISMATCH',
        distributor ? 'informational' : 'suspected_error',
        registrationNumber,
        product,
        distributor
          ? 'A distributor sub-registration may legitimately use a different trade name.'
          : 'The EPA product name is clearly different; verify the stored registration number.',
        { ourValue: product.product_name, epaValue: epaResult.productname },
      ));
    }

    if (epaResult.isCancelled) {
      findings.push(finding(
        'CANCELLED',
        'action',
        registrationNumber,
        product,
        'EPA marks this registration as cancelled.',
        { ourValue: registrationNumber, epaValue: epaResult.productStatus },
      ));
    }

    if (epaResult.rupYn !== null) {
      const epaIsRup = epaResult.rupYn === 'Yes';
      if (product.is_rup !== epaIsRup) {
        findings.push(finding(
          'RUP_DISAGREE',
          'suspected_error',
          registrationNumber,
          product,
          'EPA restricted-use status differs from the product catalog.',
          { ourValue: product.is_rup, epaValue: epaIsRup },
        ));
      }
    }

    if (!product.signal_word?.trim() && epaResult.signalWordCanonical) {
      findings.push(finding(
        'SIGNAL_WORD_AVAILABLE',
        'informational',
        registrationNumber,
        product,
        'EPA has a canonical signal word and the product field is blank.',
        { ourValue: product.signal_word, epaValue: epaResult.signalWordCanonical },
      ));
    }

    if (epaResult.needsManual) {
      findings.push(finding(
        'NEEDS_MANUAL',
        'action',
        registrationNumber,
        product,
        'EPA returned an unrecognized signal word that requires manual review.',
        { ourValue: product.signal_word, epaValue: null },
      ));
    }
  }

  return findings;
}

export function buildLookupErrorFindings(
  registrationNumber: string,
  products: EpaDataQualityProduct[],
  safeError: string,
): EpaDataQualityFinding[] {
  return products.map((product) => finding(
    'LOOKUP_ERROR',
    'operational_error',
    registrationNumber,
    product,
    `EPA lookup failed: ${safeError}`,
  ));
}

export function groupProductsByRegistration(
  products: EpaDataQualityProduct[],
): Map<string, EpaDataQualityProduct[]> {
  const groups = new Map<string, EpaDataQualityProduct[]>();
  for (const product of products) {
    const registrationNumber = product.epa_registration.trim();
    if (!registrationNumber) continue;
    const group = groups.get(registrationNumber) ?? [];
    group.push({ ...product, epa_registration: registrationNumber });
    groups.set(registrationNumber, group);
  }

  return new Map([...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
    .map(([registrationNumber, group]) => [
      registrationNumber,
      group.sort((left, right) => left.id.localeCompare(right.id)),
    ]));
}
