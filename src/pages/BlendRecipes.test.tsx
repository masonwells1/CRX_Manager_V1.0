import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recipe item units are a PICKER, not free text.
 *
 * A recipe seeds a blend ticket, and the blend validator bills off rate_per_acre in the
 * item's unit — so a unit the conversion table does not contain is a money-shaped defect,
 * not a cosmetic one. These tests pin (a) that the control is a <select> restricted to
 * real unit_conversions rows, (b) that it filters to the product's liquid/dry form, and
 * (c) that a blank unit caused by a failed unit fetch blocks the save instead of being
 * written through.
 */

const { mockFrom, mockRpc, mockToast, mockSentryCaptureException } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockSentryCaptureException: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => chain;
  for (const name of ['select', 'eq', 'is', 'in', 'order', 'limit', 'update', 'maybeSingle']) chain[name] = method;
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return chain;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((value) => value),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'actor-1' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mockSentryCaptureException } }));

import BlendRecipes from './BlendRecipes';

const LIQUID_PRODUCT = { id: 'prod-liquid', product_name: 'Liquid Product', product_form: 'liquid', is_active: true };
const DRY_PRODUCT = { id: 'prod-dry', product_name: 'Dry Product', product_form: 'dry', is_active: true };

// Shape mirrors the live unit_conversions rows verified 2026-08-23 (note 'Gal', not 'gal').
const UNIT_ROWS = [
  { id: 'u-ea', unit: 'Ea', factor_oz: 1, unit_type: 'both', notes: null },
  { id: 'u-gal', unit: 'Gal', factor_oz: 128, unit_type: 'liquid', notes: null },
  { id: 'u-oz', unit: 'oz', factor_oz: 1, unit_type: 'liquid', notes: null },
  { id: 'u-lb', unit: 'Lb', factor_oz: 16, unit_type: 'dry', notes: null },
];

const BLANK_UNIT_RECIPE = {
  id: 'recipe-1',
  name: 'Legacy Recipe',
  description: null,
  recipe_type: 'generic',
  crop_type: null,
  timing: null,
  created_by: null,
  deleted_at: null,
  items: [{ count: 1 }],
};

function mockTables(overrides: {
  unitError?: Error; recipes?: unknown[]; recipeItems?: unknown[]; products?: unknown[];
} = {}) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'blend_recipes') return buildChain({ data: overrides.recipes ?? [], error: null });
    if (table === 'blend_recipe_items') return buildChain({ data: overrides.recipeItems ?? [], error: null });
    if (table === 'products') return buildChain({ data: overrides.products ?? [LIQUID_PRODUCT, DRY_PRODUCT], error: null });
    if (table === 'unit_conversions') {
      return overrides.unitError
        ? buildChain({ data: null, error: Object.assign(overrides.unitError, { message: overrides.unitError.message }) })
        : buildChain({ data: UNIT_ROWS, error: null });
    }
    return buildChain({ data: [], error: null });
  });
}

/** Open the New Recipe editor and add one blank product row. */
async function openNewRecipeWithOneItem() {
  fireEvent.click(await screen.findByRole('button', { name: /New Recipe/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Add Product/ }));
}

describe('BlendRecipes unit picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTables();
  });

  it('offers only real unit_conversions units, filtered to the selected product form', async () => {
    render(<BlendRecipes />);
    await openNewRecipeWithOneItem();

    const unitSelect = await screen.findByLabelText(/^Unit for product 1$/);
    // It is a <select>, not a text box: there is no longer any way to type a unit.
    expect(unitSelect.tagName).toBe('SELECT');

    // No product picked yet → form is unknown, so every unit stays offered.
    expect(within(unitSelect).getByRole('option', { name: 'Gal' })).toBeInTheDocument();
    expect(within(unitSelect).getByRole('option', { name: 'Lb' })).toBeInTheDocument();

    const productSelect = screen.getByRole('combobox', { name: 'Product 1' });

    fireEvent.change(productSelect, { target: { value: DRY_PRODUCT.id } });
    const dryUnitSelect = await screen.findByLabelText(/^Unit for Dry Product$/);
    await waitFor(() => expect(within(dryUnitSelect).queryByRole('option', { name: 'oz' })).toBeNull());
    expect(within(dryUnitSelect).getByRole('option', { name: 'Lb' })).toBeInTheDocument();
    expect(within(dryUnitSelect).getByRole('option', { name: 'Ea' })).toBeInTheDocument();

    fireEvent.change(productSelect, { target: { value: LIQUID_PRODUCT.id } });
    const liquidUnitSelect = await screen.findByLabelText(/^Unit for Liquid Product$/);
    await waitFor(() => expect(within(liquidUnitSelect).queryByRole('option', { name: 'Lb' })).toBeNull());
    expect(within(liquidUnitSelect).getByRole('option', { name: 'Gal' })).toBeInTheDocument();
  });

  it('keeps the product id when a product is picked', async () => {
    mockRpc.mockResolvedValue({ data: { recipe_id: 'r-1', created: true }, error: null });
    render(<BlendRecipes />);
    await openNewRecipeWithOneItem();

    fireEvent.change(screen.getByPlaceholderText(/Corn Pre-Emerge Standard/), { target: { value: 'New Blend' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Product 1' }), { target: { value: LIQUID_PRODUCT.id } });
    fireEvent.change(await screen.findByLabelText(/^Unit for Liquid Product$/), { target: { value: 'Gal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Recipe' }));

    // Regression guard: the product <select> fires two updateItem calls in one handler.
    // While updateItem copied the `editItems` closure, the second call (product_name)
    // discarded the first (product_id) and the recipe saved with an EMPTY product id.
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_blend_recipe', expect.objectContaining({
      p_items: [expect.objectContaining({ product_id: LIQUID_PRODUCT.id, product_name: 'Liquid Product' })],
    })));
  });

  it('seeds a new item with NO unit, so no default can slip past the save guard', async () => {
    render(<BlendRecipes />);
    await openNewRecipeWithOneItem();

    const unitSelect = await screen.findByLabelText(/^Unit for product 1$/) as HTMLSelectElement;
    // The seed was 'gal' (a value unit_conversions does not even contain) and then 'Gal'.
    // Both were wrong for the same reason: a NON-BLANK seed is invisible to a blank-only
    // save guard, so during a unit-list outage the guess itself got saved — a liquid unit
    // riding along on a dry product. Blank forces a deliberate pick.
    expect(unitSelect.value).toBe('');
  });

  it('clears a unit the newly picked product form cannot offer', async () => {
    render(<BlendRecipes />);
    await openNewRecipeWithOneItem();

    // With no product picked, every unit is on offer — choose a LIQUID one.
    fireEvent.change(await screen.findByLabelText(/^Unit for product 1$/), { target: { value: 'Gal' } });
    expect((screen.getByLabelText(/^Unit for product 1$/) as HTMLSelectElement).value).toBe('Gal');

    // Switching to a dry product used to leave 'Gal' selected as a grandfathered option, so
    // an operator who did not look saved a liquid unit on a dry product. Found by driving
    // the real screen in a browser, not by this suite.
    fireEvent.change(screen.getByRole('combobox', { name: 'Product 1' }), { target: { value: DRY_PRODUCT.id } });

    const unitSelect = await screen.findByLabelText(/^Unit for Dry Product$/) as HTMLSelectElement;
    expect(unitSelect.value).toBe('');
    expect(within(unitSelect).queryByRole('option', { name: 'Gal' })).toBeNull();
  });

  it('keeps a unit the newly picked product form still offers', async () => {
    render(<BlendRecipes />);
    await openNewRecipeWithOneItem();
    fireEvent.change(await screen.findByLabelText(/^Unit for product 1$/), { target: { value: 'Gal' } });

    // 'Gal' is valid for a liquid product, so the pick must survive — the clear only fires
    // when the unit genuinely no longer fits.
    fireEvent.change(screen.getByRole('combobox', { name: 'Product 1' }), { target: { value: LIQUID_PRODUCT.id } });
    const unitSelect = await screen.findByLabelText(/^Unit for Liquid Product$/) as HTMLSelectElement;
    expect(unitSelect.value).toBe('Gal');
  });

  it('does not clear a stored unit while the unit list is unavailable', async () => {
    mockTables({
      unitError: new Error('unit_conversions unavailable'),
      recipes: [BLANK_UNIT_RECIPE],
      recipeItems: [{
        id: 'item-1', product_id: LIQUID_PRODUCT.id, quantity: 2, unit: 'Gal', rate_per_acre: 1,
        price_per_unit_cents: null, sort_order: 0, notes: null, product: { product_name: 'Liquid Product' },
      }],
    });
    render(<BlendRecipes />);
    fireEvent.click(await screen.findByText('Legacy Recipe'));
    await screen.findByLabelText(/^Unit for Liquid Product$/); // editor is open

    // During an outage isKnownUnit is false for EVERYTHING, so an unguarded clear would
    // wipe a perfectly good stored unit on any product change. It must not.
    fireEvent.change(screen.getByRole('combobox', { name: 'Product 1' }), { target: { value: DRY_PRODUCT.id } });
    const unitSelect = await screen.findByLabelText(/^Unit for Dry Product$/) as HTMLSelectElement;
    expect(unitSelect.value).toBe('Gal');
  });

  it('refuses to save a blank unit when the unit list failed to load', async () => {
    mockTables({
      unitError: new Error('unit_conversions unavailable'),
      recipes: [BLANK_UNIT_RECIPE],
      // A stored item whose unit is blank — the case the picker cannot repair while the
      // conversion list is unavailable.
      recipeItems: [{
        id: 'item-1',
        product_id: LIQUID_PRODUCT.id,
        quantity: 2,
        unit: '',
        rate_per_acre: 1,
        price_per_unit_cents: null,
        sort_order: 0,
        notes: null,
        product: { product_name: 'Liquid Product' },
      }],
    });
    render(<BlendRecipes />);

    fireEvent.click(await screen.findByText('Legacy Recipe'));
    const unitSelect = await screen.findByLabelText(/^Unit for Liquid Product$/) as HTMLSelectElement;
    expect(unitSelect.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    // Names the real cause (a failed load) rather than blaming the operator for a blank
    // they had no way to fill.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Units could not be loaded, so a unit is still blank. Refresh and retry before saving.',
    ));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('refuses to save a new item during an outage, where the seed used to slip through', async () => {
    mockTables({ unitError: new Error('unit_conversions unavailable') });
    render(<BlendRecipes />);
    await openNewRecipeWithOneItem();
    fireEvent.change(screen.getByPlaceholderText(/Corn Pre-Emerge Standard/), { target: { value: 'New Blend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Recipe' }));

    // The hole CodeRabbit found on PR #447: the item was seeded with a NON-BLANK unit, the
    // save guard only looked for blanks, and the outage meant the operator could not correct
    // it — so the seeded liquid unit saved onto whatever product was chosen.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Units could not be loaded, so a unit is still blank. Refresh and retry before saving.',
    ));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('refuses to save a blank unit even when the list is healthy', async () => {
    render(<BlendRecipes />);
    await openNewRecipeWithOneItem();
    fireEvent.change(screen.getByPlaceholderText(/Corn Pre-Emerge Standard/), { target: { value: 'New Blend' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Product 1' }), { target: { value: LIQUID_PRODUCT.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Recipe' }));

    // A recipe bills off rate_per_acre and a blank unit still bills, so "saved but
    // unpriceable" is exactly what this screen exists to prevent. Free text allowed a blank;
    // the picker does not.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Pick a unit for Liquid Product.'));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('refuses to save a stored unit the product form cannot use', async () => {
    mockTables({
      recipes: [BLANK_UNIT_RECIPE],
      // A dry product carrying a liquid unit. UnitSelect grandfathers it so re-saving cannot
      // silently blank it — but grandfathering must not mean the save is allowed to keep it.
      recipeItems: [{
        id: 'item-1', product_id: DRY_PRODUCT.id, quantity: 2, unit: 'Gal', rate_per_acre: 1,
        price_per_unit_cents: null, sort_order: 0, notes: null, product: { product_name: 'Dry Product' },
      }],
    });
    render(<BlendRecipes />);
    fireEvent.click(await screen.findByText('Legacy Recipe'));
    await screen.findByLabelText(/^Unit for Dry Product$/);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error', '"Gal" is not a unit Dry Product can use. Pick one from the list.',
    ));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('refuses to save while an item\'s product has not loaded, instead of assuming any unit fits', async () => {
    mockTables({
      // Products empty: the load-order case where an existing recipe opens before
      // fetchProducts returns. A product that has since been deactivated behaves the same.
      products: [],
      recipes: [BLANK_UNIT_RECIPE],
      recipeItems: [{
        id: 'item-1', product_id: DRY_PRODUCT.id, quantity: 2, unit: 'Gal', rate_per_acre: 1,
        price_per_unit_cents: null, sort_order: 0, notes: null, product: { product_name: 'Dry Product' },
      }],
    });
    render(<BlendRecipes />);
    fireEvent.click(await screen.findByText('Legacy Recipe'));
    await screen.findByLabelText(/^Unit for Dry Product$/);

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    // Third instance of one bug shape in this PR: absent data collapsing to null, and null
    // meaning "no restriction". An unresolved product must not read as a form-agnostic one,
    // or a liquid unit rides through on a dry product.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Product details for Dry Product have not loaded yet, so its unit cannot be checked. Try saving again in a moment.',
    ));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('does not block a save when the unit list loaded fine', async () => {
    mockRpc.mockResolvedValue({ data: { recipe_id: 'r-1', created: true }, error: null });
    render(<BlendRecipes />);
    await openNewRecipeWithOneItem();

    fireEvent.change(screen.getByPlaceholderText(/Corn Pre-Emerge Standard/), { target: { value: 'New Blend' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Product 1' }), { target: { value: LIQUID_PRODUCT.id } });
    fireEvent.change(await screen.findByLabelText(/^Unit for Liquid Product$/), { target: { value: 'Gal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Recipe' }));

    // A healthy list must never produce a "refresh and retry" message; the save proceeds.
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_blend_recipe', expect.objectContaining({
      p_items: [expect.objectContaining({ unit: 'Gal' })],
    })));
    expect(mockToast).not.toHaveBeenCalledWith(
      'error',
      'Units could not be loaded, so a unit is still blank. Refresh and retry before saving.',
    );
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Units are still loading. Try saving again in a moment.');
  });
});
