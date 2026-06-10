import { supabase } from './db';
import { localToday } from './dateUtils';

export interface RUPComplianceResult {
  hasRUPProducts: boolean;
  hasValidLicense: boolean;
  expiredLicense: boolean;
  missingLicense: boolean;
  rupProductNames: string[];
  warnings: string[];
}

/**
 * Check if any products in the list are RUP (Restricted Use Pesticide)
 * and whether the customer has a valid applicator license.
 *
 * Returns warnings — does NOT block the transaction.
 */
export async function checkRUPCompliance(
  customerId: string,
  productIds: string[]
): Promise<RUPComplianceResult> {
  const result: RUPComplianceResult = {
    hasRUPProducts: false,
    hasValidLicense: false,
    expiredLicense: false,
    missingLicense: false,
    rupProductNames: [],
    warnings: [],
  };

  if (!productIds.length) return result;

  // 1. Check which products are RUP
  const { data: rupProducts, error: rupError } = await supabase
    .from('products')
    .select('id, product_name')
    .in('id', productIds)
    .eq('is_rup', true);

  if (rupError) {
    return { ...result, warnings: ['Unable to verify RUP compliance - database error'] };
  }

  if (!rupProducts?.length) return result;

  result.hasRUPProducts = true;
  result.rupProductNames = rupProducts.map((p) => p.product_name);

  // 2. Check customer's applicator license
  // (was `.is('deleted_at', null)` — that column never existed on applicator_licenses,
  // so this query 400'd and the check silently degraded to the generic warning.
  // Live-verified + fixed 2026-06-10 alongside migration 20260610185741.)
  const today = localToday();
  const { data: licenses, error: licenseError } = await supabase
    .from('applicator_licenses')
    .select('id, expiry_date')
    .eq('customer_id', customerId)
    .eq('is_active', true);

  if (licenseError) {
    return { ...result, warnings: ['Unable to verify applicator license - database error'] };
  }

  if (!licenses?.length) {
    result.missingLicense = true;
    result.warnings.push(
      `RUP products (${result.rupProductNames.join(', ')}) require a valid applicator license. No license on file for this customer.`
    );
    return result;
  }

  // Check if any license is currently valid
  const validLicense = licenses.find((l) => l.expiry_date >= today);
  if (validLicense) {
    result.hasValidLicense = true;
    return result;
  }

  // All licenses are expired
  result.expiredLicense = true;
  result.warnings.push(
    `RUP products (${result.rupProductNames.join(', ')}) require a valid applicator license. Customer's license is expired.`
  );

  return result;
}
