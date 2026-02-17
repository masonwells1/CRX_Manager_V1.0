import { describe, it, expect } from 'vitest';
import { parseOCRText, fuzzyMatchProduct, fuzzyMatchCustomer } from './ocrParser';
import type { Product, Customer } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProduct(name: string, overrides?: Partial<Product>): Product {
  return {
    id: `prod-${name.replace(/\s/g, '-').toLowerCase()}`,
    product_name: name,
    sku: null,
    category: null,
    vendor: null,
    manufacturer: null,
    container_size: null,
    unit_size: null,
    epa_registration: null,
    product_form: 'liquid',
    inventory_unit: null,
    container_unit: null,
    container_type: null,
    current_cost: null,
    cost_updated_date: null,
    tier1_price: null,
    tier1_margin: null,
    tier1_gross_margin: null,
    tier2_price: null,
    tier2_margin: null,
    tier2_gross_margin: null,
    tier3_price: null,
    tier3_margin: null,
    tier3_gross_margin: null,
    tier1_price_per_acre: null,
    tier2_price_per_acre: null,
    tier3_price_per_acre: null,
    suggested_rate: null,
    rate_per_acre: null,
    rate_unit: null,
    notes: null,
    is_active: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeCustomer(farmName: string, contactName?: string): Customer {
  return {
    id: `cust-${farmName.replace(/\s/g, '-').toLowerCase()}`,
    farm_name: farmName,
    contact_name: contactName || null,
    phone: null,
    email: null,
    billing_address: null,
    assigned_tier: 1,
    assigned_sales_rep: null,
    total_acres: null,
    corn_acres: null,
    soybean_acres: null,
    other_acres: null,
    payment_terms: null,
    default_commission_split: null,
    notes: null,
    is_active: true,
    created_at: '',
    updated_at: '',
  };
}

const testProducts: Product[] = [
  makeProduct('Roundup PowerMAX'),
  makeProduct('Atrazine 4L'),
  makeProduct('Warrant Herbicide'),
  makeProduct('Liberty 280 SL'),
  makeProduct('Acuron Flexi'),
  makeProduct('Inactive Product', { is_active: false }),
];

const testCustomers: Customer[] = [
  makeCustomer('Smith Farms', 'John Smith'),
  makeCustomer('Johnson Agricultural LLC', 'Mike Johnson'),
  makeCustomer('Green Valley Farm', 'Sarah Green'),
  makeCustomer('Inactive Farm', undefined),
];
// make last one inactive
testCustomers[3].is_active = false;

// ---------------------------------------------------------------------------
// parseOCRText
// ---------------------------------------------------------------------------

describe('parseOCRText', () => {
  it('extracts date from standard format', () => {
    const result = parseOCRText('Date: 01/15/2026\nCustomer: Test Farm');
    expect(result.ticketDate).not.toBeNull();
  });

  it('extracts customer name', () => {
    const result = parseOCRText('Customer: Smith Farms\nDriver: Mike');
    expect(result.customerName).toBe('Smith Farms');
  });

  it('extracts driver name', () => {
    const result = parseOCRText('Driver: Mike Jones\nTank #: 42');
    expect(result.driverName).toBe('Mike Jones');
  });

  it('extracts tank number', () => {
    const result = parseOCRText('Tank #: 42\nProduct list');
    expect(result.tankNumber).toBe('42');
  });

  it('detects signature keywords', () => {
    const result = parseOCRText('Signature: ___________');
    expect(result.signatureDetected).toBe(true);
  });

  it('does not detect signature when not present', () => {
    const result = parseOCRText('Product: Roundup 10 gal');
    expect(result.signatureDetected).toBe(false);
  });

  it('extracts products with quantities', () => {
    const result = parseOCRText(
      'Product  Rate/Acre  Total Product\nRoundup 10 gal\nAtrazine 5 lb'
    );
    expect(result.products.length).toBeGreaterThanOrEqual(2);
  });

  it('returns overall confidence > 0 when fields are found', () => {
    const result = parseOCRText(
      'Date: 01/15/2026\nCustomer: Smith Farms\nDriver: Mike\nProducts:\nRoundup 10 gal'
    );
    expect(result.overallConfidence).toBeGreaterThan(0);
  });

  it('returns 0 confidence for empty text', () => {
    const result = parseOCRText('');
    expect(result.overallConfidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatchProduct
// ---------------------------------------------------------------------------

describe('fuzzyMatchProduct', () => {
  it('exact match returns product', () => {
    const result = fuzzyMatchProduct('Roundup PowerMAX', testProducts);
    expect(result).not.toBeNull();
    expect(result!.product_name).toBe('Roundup PowerMAX');
  });

  it('case-insensitive exact match', () => {
    const result = fuzzyMatchProduct('roundup powermax', testProducts);
    expect(result).not.toBeNull();
    expect(result!.product_name).toBe('Roundup PowerMAX');
  });

  it('matches with extra whitespace stripped', () => {
    const result = fuzzyMatchProduct('Roundup  PowerMAX', testProducts);
    expect(result).not.toBeNull();
    expect(result!.product_name).toBe('Roundup PowerMAX');
  });

  it('returns null for completely unrelated name', () => {
    const result = fuzzyMatchProduct('XYZZY Unknown Chemical', testProducts);
    expect(result).toBeNull();
  });

  it('skips inactive products', () => {
    const result = fuzzyMatchProduct('Inactive Product', testProducts);
    expect(result).toBeNull();
  });

  it('matches partial name with high similarity', () => {
    // "Atrazine" should match "Atrazine 4L"
    const result = fuzzyMatchProduct('Atrazine', testProducts);
    expect(result).not.toBeNull();
    expect(result!.product_name).toBe('Atrazine 4L');
  });

  it('returns null for empty string', () => {
    const result = fuzzyMatchProduct('', testProducts);
    expect(result).toBeNull();
  });

  it('returns null for empty product list', () => {
    const result = fuzzyMatchProduct('Roundup', []);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fuzzyMatchCustomer
// ---------------------------------------------------------------------------

describe('fuzzyMatchCustomer', () => {
  it('exact match on farm name', () => {
    const result = fuzzyMatchCustomer('Smith Farms', testCustomers);
    expect(result).not.toBeNull();
    expect(result!.farm_name).toBe('Smith Farms');
  });

  it('case-insensitive match', () => {
    const result = fuzzyMatchCustomer('smith farms', testCustomers);
    expect(result).not.toBeNull();
    expect(result!.farm_name).toBe('Smith Farms');
  });

  it('matches on contact name', () => {
    const result = fuzzyMatchCustomer('John Smith', testCustomers);
    expect(result).not.toBeNull();
    expect(result!.contact_name).toBe('John Smith');
  });

  it('skips inactive customers', () => {
    const result = fuzzyMatchCustomer('Inactive Farm', testCustomers);
    expect(result).toBeNull();
  });

  it('returns null for no match', () => {
    const result = fuzzyMatchCustomer('Nonexistent Farm', testCustomers);
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = fuzzyMatchCustomer('', testCustomers);
    expect(result).toBeNull();
  });
});
