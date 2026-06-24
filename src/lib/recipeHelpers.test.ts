import { describe, it, expect, beforeEach } from 'vitest';
import {
  recipeItemToChemRowSeed,
  chemRowToRecipeItem,
  chemRowsToRecipeItems,
  getLastRecipeId,
  setLastRecipeId,
  type RecipeItemSource,
} from './recipeHelpers';
import type { BlendRecipeItem, Product } from '../types';

const PROD_ID = '11111111-1111-4111-8111-111111111111';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: PROD_ID,
    product_name: 'Roundup',
    sku: null,
    category: null,
    vendor: 'Bayer',
    manufacturer: null,
    container_size: null,
    unit_size: 'gal',
    epa_registration: null,
    is_rup: false,
    signal_word: null,
    rei_hours: 12,
    phi_days: 7,
    product_form: null,
    inventory_unit: null,
    container_unit: null,
    container_type: null,
    current_cost: 5, // $5.00 -> 500 cents
    cost_updated_date: null,
    tier1_price: 8, // $8.00 -> 800 cents
    tier1_margin: null,
    tier1_gross_margin: null,
    tier2_price: 7,
    tier2_margin: null,
    tier2_gross_margin: null,
    tier3_price: 6,
    tier3_margin: null,
    tier3_gross_margin: null,
    tier1_price_per_acre: null,
    tier2_price_per_acre: null,
    tier3_price_per_acre: null,
    suggested_rate: null,
    rate_per_acre: null,
    rate_unit: 'pt/ac',
    notes: null,
    internal_notes: null,
    is_active: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as Product;
}

function recipeItem(overrides: Partial<BlendRecipeItem> = {}): BlendRecipeItem {
  return {
    id: 'r1',
    recipe_id: 'rec1',
    product_id: PROD_ID,
    product_name: 'Roundup',
    quantity: 50,
    unit: 'gal',
    rate_per_acre: 2,
    sort_order: 0,
    notes: null,
    price_per_unit_cents: 0,
    created_at: '',
    ...overrides,
  } as BlendRecipeItem;
}

describe('recipeItemToChemRowSeed', () => {
  it('maps products/rates/units from the recipe item and product', () => {
    const seed = recipeItemToChemRowSeed(recipeItem(), product(), 1);
    expect(seed.product_id).toBe(PROD_ID);
    expect(seed.product_name).toBe('Roundup');
    expect(seed.quantity).toBe('50');
    expect(seed.unit).toBe('gal');
    expect(seed.rate_per_acre).toBe('2');
    expect(seed.rate_unit).toBe('pt/ac');
    expect(seed.cost_per_unit_cents).toBe('500');
    expect(seed.vendor).toBe('Bayer');
    expect(seed.rei_hours).toBe('12');
    expect(seed.phi_days).toBe('7');
    expect(seed.driver).toBe('rate');
  });

  it('a recipe price overrides the tier default', () => {
    const seed = recipeItemToChemRowSeed(recipeItem({ price_per_unit_cents: 1234 }), product(), 1);
    expect(seed.price_per_unit_cents).toBe('1234');
  });

  it('falls back to the customer tier price when the recipe has no price (never silently $0)', () => {
    expect(recipeItemToChemRowSeed(recipeItem({ price_per_unit_cents: 0 }), product(), 1).price_per_unit_cents).toBe('800');
    expect(recipeItemToChemRowSeed(recipeItem({ price_per_unit_cents: 0 }), product(), 2).price_per_unit_cents).toBe('700');
    expect(recipeItemToChemRowSeed(recipeItem({ price_per_unit_cents: 0 }), product(), 3).price_per_unit_cents).toBe('600');
  });

  it('tolerates a missing product (deleted/inactive) — falls back to recipe fields', () => {
    const seed = recipeItemToChemRowSeed(recipeItem(), undefined, 1);
    expect(seed.product_name).toBe('Roundup');
    expect(seed.unit).toBe('gal');
    expect(seed.cost_per_unit_cents).toBe('0');
    expect(seed.price_per_unit_cents).toBe('0'); // no product -> no tier price available
    expect(seed.rate_unit).toBe('');
    expect(seed.vendor).toBe('');
  });
});

describe('chemRowToRecipeItem', () => {
  const row: RecipeItemSource = {
    product_id: PROD_ID,
    product_name: 'Roundup',
    quantity: '50',
    unit: 'gal',
    rate_per_acre: '2',
    price_per_unit_cents: '800',
  };

  it('maps a chem row to a recipe item payload', () => {
    expect(chemRowToRecipeItem(row)).toEqual({
      product_id: PROD_ID,
      product_name: 'Roundup',
      quantity: 50,
      unit: 'gal',
      rate_per_acre: 2,
      price_per_unit_cents: 800,
      notes: null,
    });
  });

  it('drops a row with no product', () => {
    expect(chemRowToRecipeItem({ ...row, product_id: '' })).toBeNull();
  });

  it('blank rate -> null; blank/invalid numbers -> 0', () => {
    const out = chemRowToRecipeItem({ ...row, rate_per_acre: '', quantity: '', price_per_unit_cents: '' });
    expect(out?.rate_per_acre).toBeNull();
    expect(out?.quantity).toBe(0);
    expect(out?.price_per_unit_cents).toBe(0);
  });

  it('defaults a blank unit to gal', () => {
    expect(chemRowToRecipeItem({ ...row, unit: '' })?.unit).toBe('gal');
  });
});

describe('chemRowsToRecipeItems', () => {
  it('keeps only product-bearing rows', () => {
    const rows: RecipeItemSource[] = [
      { product_id: PROD_ID, product_name: 'A', quantity: '1', unit: 'gal', rate_per_acre: '1', price_per_unit_cents: '100' },
      { product_id: '', product_name: '', quantity: '0', unit: '', rate_per_acre: '', price_per_unit_cents: '0' },
    ];
    expect(chemRowsToRecipeItems(rows)).toHaveLength(1);
  });
});

describe('round-trip: save chem rows -> recipe items -> load back', () => {
  it('products/rates/units/price match what was saved', () => {
    const rows: RecipeItemSource[] = [
      { product_id: PROD_ID, product_name: 'Roundup', quantity: '50', unit: 'gal', rate_per_acre: '2', price_per_unit_cents: '800' },
    ];
    // Save direction
    const items = chemRowsToRecipeItems(rows);
    expect(items[0].quantity).toBe(50);
    expect(items[0].rate_per_acre).toBe(2);
    expect(items[0].price_per_unit_cents).toBe(800);

    // Persisted recipe item (what the DB would hand back)
    const persisted = recipeItem({
      product_id: items[0].product_id,
      product_name: items[0].product_name,
      quantity: items[0].quantity,
      unit: items[0].unit,
      rate_per_acre: items[0].rate_per_acre,
      price_per_unit_cents: items[0].price_per_unit_cents,
    });

    // Load direction
    const seed = recipeItemToChemRowSeed(persisted, product(), 1);
    expect(seed.product_id).toBe(rows[0].product_id);
    expect(seed.quantity).toBe(rows[0].quantity);
    expect(seed.unit).toBe(rows[0].unit);
    expect(seed.rate_per_acre).toBe(rows[0].rate_per_acre);
    expect(seed.price_per_unit_cents).toBe(rows[0].price_per_unit_cents);
  });
});

describe('last-used recipe (localStorage shortcut)', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a stored id', () => {
    expect(getLastRecipeId()).toBeNull();
    setLastRecipeId('rec-123');
    expect(getLastRecipeId()).toBe('rec-123');
  });
});
