export interface ParsedProduct {
  product_name: string;
  sku?: string;
  category?: string;
  use_timing?: string;
  vendor?: string;
  manufacturer?: string;
  container_size?: number;
  unit_size?: string;
  epa_registration?: string;
  suggested_rate?: string;
  rate_per_acre?: number;
  rate_unit?: string;
  product_form?: string;
  inventory_unit?: string;
  container_unit?: string;
  container_type?: string;
  notes?: string;
}

export const PRODUCT_IMPORT_STRING_FIELDS = [
  'product_name',
  'sku',
  'category',
  'use_timing',
  'vendor',
  'manufacturer',
  'unit_size',
  'epa_registration',
  'suggested_rate',
  'rate_unit',
  'product_form',
  'inventory_unit',
  'container_unit',
  'container_type',
  'notes',
] as const satisfies readonly (keyof ParsedProduct)[];

type ProductImportStringField = typeof PRODUCT_IMPORT_STRING_FIELDS[number];

export function isProductImportStringField(field: string): field is ProductImportStringField {
  return (PRODUCT_IMPORT_STRING_FIELDS as readonly string[]).includes(field);
}

export const normalizeProductImportHeader = (header: string) => header
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

/**
 * Product import is deliberately non-pricing. Reject recognizable pricing
 * columns instead of silently ignoring them, so an old template cannot appear
 * to have updated money when it did not.
 */
export function isRetiredPricingColumn(header: string): boolean {
  const normalized = normalizeProductImportHeader(header);
  if (
    [
      'cost', 'current_cost', 'current_cost_cents', 'unit_cost', 'unit_cost_cents',
      'base_cost', 'base_cost_cents', 'price', 'price_per_acre', 'pricing_version',
    ].includes(normalized)
  ) {
    return true;
  }

  return /^(?:tier_?[123]|t[123])_(?:price|price_cents|margin|margin_percent|margin_pct|gross_margin|gross_profit|markup|price_per_acre)$/.test(normalized)
    || /^(?:price|margin)_(?:tier_?)?[123]$/.test(normalized);
}

/** Explicit allowlist: no future ParsedProduct property can be spread into products. */
export function buildProductInsert(product: ParsedProduct) {
  return {
    product_name: product.product_name,
    sku: product.sku,
    category: product.category,
    use_timing: product.use_timing,
    vendor: product.vendor,
    manufacturer: product.manufacturer,
    container_size: product.container_size,
    unit_size: product.unit_size,
    epa_registration: product.epa_registration,
    suggested_rate: product.suggested_rate,
    rate_per_acre: product.rate_per_acre,
    rate_unit: product.rate_unit,
    product_form: product.product_form,
    inventory_unit: product.inventory_unit,
    container_unit: product.container_unit,
    container_type: product.container_type,
    notes: product.notes,
    is_active: true,
  };
}
