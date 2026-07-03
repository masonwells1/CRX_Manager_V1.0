/**
 * BrandVsGeneric.test.tsx — behavioral coverage for the ingredient-map management
 * UI added in Structure Wave-2 P2-3 (wire the brand↔generic page).
 *
 * Proves the parts most likely to be wrong: the insert payload shape (branded_ingredient
 * defaults to the branded name to satisfy the NOT-NULL column; generic name resolves to a
 * product id; blank notes → null), the "must be a real product" validation gate, and the
 * admin-only write gate (sales_rep sees read-only, matching the table's RLS).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';

const H = vi.hoisted(() => ({
  state: {
    role: 'admin' as 'admin' | 'sales_rep',
    products: [] as Array<Record<string, unknown>>,
    mappings: [] as Array<Record<string, unknown>>,
    lastInsert: null as { table: string; payload: Record<string, unknown> } | null,
    lastUpdate: null as { table: string; payload: Record<string, unknown> } | null,
    lastDelete: null as { table: string } | null,
  },
}));

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  function makeFrom(table: string) {
    const op = { type: 'select' as 'select' | 'insert' | 'update' | 'delete' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      insert: (p: Record<string, unknown>) => { op.type = 'insert'; H.state.lastInsert = { table, payload: p }; return builder; },
      update: (p: Record<string, unknown>) => { op.type = 'update'; H.state.lastUpdate = { table, payload: p }; return builder; },
      delete: () => { op.type = 'delete'; H.state.lastDelete = { table }; return builder; },
      then: (resolve: (v: unknown) => unknown) => {
        if (op.type !== 'select') return resolve({ data: [{ id: 'new-id' }], error: null });
        if (table === 'products') return resolve({ data: H.state.products, error: null });
        if (table === 'ingredient_map') return resolve({ data: H.state.mappings, error: null });
        return resolve({ data: [], error: null });
      },
    };
    return builder;
  }
  return { ...actual, supabase: { from: (t: string) => makeFrom(t) }, checkMutationResult: vi.fn() };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: H.state.role, profile: { role: H.state.role }, user: { id: 'u' } }),
}));
// Stable toast fn: the component keeps `toast` in fetchData's useCallback deps,
// so a fresh vi.fn() per render would change fetchData every render and re-fire
// the load effect in a loop (leaving the table stuck on skeletons). One shared fn.
vi.mock('../components/ui/Toast', () => {
  const toast = vi.fn();
  return { useToast: () => ({ toast }) };
});
vi.mock('../lib/sentry', () => ({ Sentry: new Proxy({}, { get: () => () => undefined }) }));

// Import AFTER mocks are registered.
import BrandVsGeneric from './BrandVsGeneric';

const ROUNDUP = { id: 'p1', product_name: 'Roundup PowerMAX', is_active: true };
const GENERIC = { id: 'p2', product_name: 'Generic Glyphosate', is_active: true };

beforeEach(() => {
  cleanup(); // guard against any DOM leaked from a prior test/file in a shared worker
  H.state.role = 'admin';
  H.state.products = [ROUNDUP, GENERIC];
  H.state.mappings = [];
  H.state.lastInsert = null;
  H.state.lastUpdate = null;
  H.state.lastDelete = null;
});

afterEach(() => cleanup());

describe('BrandVsGeneric — ingredient-map management', () => {
  it('lists existing mappings for an admin', async () => {
    H.state.mappings = [
      {
        id: 'm1',
        fallback_branded_product: 'Roundup PowerMAX',
        branded_ingredient: 'Glyphosate',
        generic_product_id: 'p2',
        generic_has_bulk: true,
        notes: 'Cheaper in bulk',
        generic_product: GENERIC,
      },
    ];
    render(<BrandVsGeneric />);
    // The row's edit/delete controls are unique to the management table (the
    // branded/generic names also appear in the "select a product" dropdown).
    // Assert inside waitFor with *All* matchers so it retries until the async
    // data load has settled — a single sync snapshot can land mid-transition
    // under the loaded full-suite worker.
    await waitFor(() => {
      expect(screen.getAllByLabelText('Edit mapping for Roundup PowerMAX').length).toBeGreaterThan(0);
      expect(screen.getAllByLabelText('Delete mapping for Roundup PowerMAX').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Generic Glyphosate').length).toBeGreaterThan(0);
    });
  });

  it('inserts with branded_ingredient defaulted to the branded name and the generic resolved to its id', async () => {
    render(<BrandVsGeneric />);
    const addButtons = await screen.findAllByRole('button', { name: 'Add Mapping' });
    fireEvent.click(addButtons[0]);

    const dialogs = await screen.findAllByRole('dialog');
    const dialog = dialogs[dialogs.length - 1];
    fireEvent.change(within(dialog).getByPlaceholderText('Search products...'), {
      target: { value: 'Roundup PowerMAX' },
    });
    fireEvent.change(within(dialog).getByPlaceholderText('Search products (optional)...'), {
      target: { value: 'Generic Glyphosate' },
    });
    // Leave Active Ingredient + Notes blank on purpose.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Mapping' }));

    await waitFor(() => expect(H.state.lastInsert).not.toBeNull());
    expect(H.state.lastInsert?.table).toBe('ingredient_map');
    expect(H.state.lastInsert?.payload).toEqual({
      fallback_branded_product: 'Roundup PowerMAX',
      branded_ingredient: 'Roundup PowerMAX', // defaulted from branded name (NOT NULL column)
      generic_product_id: 'p2',
      generic_has_bulk: false,
      notes: null,
    });
  });

  it('rejects a branded product that is not in the catalog (no insert)', async () => {
    render(<BrandVsGeneric />);
    const addButtons = await screen.findAllByRole('button', { name: 'Add Mapping' });
    fireEvent.click(addButtons[0]);

    const dialogs = await screen.findAllByRole('dialog');
    const dialog = dialogs[dialogs.length - 1];
    fireEvent.change(within(dialog).getByPlaceholderText('Search products...'), {
      target: { value: 'Totally Made Up Product' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Mapping' }));

    expect(await within(dialog).findByText(/must match an existing product/i)).toBeTruthy();
    expect(H.state.lastInsert).toBeNull();
  });

  it('blocks a duplicate mapping for a branded product that already has one (no insert)', async () => {
    H.state.mappings = [
      {
        id: 'm1',
        fallback_branded_product: 'Roundup PowerMAX',
        branded_ingredient: 'Glyphosate',
        generic_product_id: 'p2',
        generic_has_bulk: false,
        notes: null,
        generic_product: GENERIC,
      },
    ];
    render(<BrandVsGeneric />);
    const addButtons = await screen.findAllByRole('button', { name: 'Add Mapping' });
    fireEvent.click(addButtons[0]);

    const dialogs = await screen.findAllByRole('dialog');
    const dialog = dialogs[dialogs.length - 1];
    fireEvent.change(within(dialog).getByPlaceholderText('Search products...'), {
      target: { value: 'Roundup PowerMAX' }, // already mapped above
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Mapping' }));

    expect(await within(dialog).findByText(/already exists/i)).toBeTruthy();
    expect(H.state.lastInsert).toBeNull();
  });

  it('resolves the generic to the correct product id when product names collide (SKU-disambiguated)', async () => {
    // Two active products share a name — the picker must resolve to a SPECIFIC id,
    // not collapse them (schema does not enforce product_name uniqueness).
    H.state.products = [
      ROUNDUP,
      { id: 'd1', product_name: 'Dupe Product', sku: 'AAA', is_active: true },
      { id: 'd2', product_name: 'Dupe Product', sku: 'BBB', is_active: true },
    ];
    H.state.mappings = [];
    render(<BrandVsGeneric />);
    const addButtons = await screen.findAllByRole('button', { name: 'Add Mapping' });
    fireEvent.click(addButtons[0]);

    const dialogs = await screen.findAllByRole('dialog');
    const dialog = dialogs[dialogs.length - 1];
    fireEvent.change(within(dialog).getByPlaceholderText('Search products...'), {
      target: { value: 'Roundup PowerMAX' },
    });
    // The duplicate rows are offered as "Dupe Product — SKU AAA/BBB"; pick BBB (d2).
    fireEvent.change(within(dialog).getByPlaceholderText('Search products (optional)...'), {
      target: { value: 'Dupe Product — SKU BBB' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Mapping' }));

    await waitFor(() => expect(H.state.lastInsert).not.toBeNull());
    expect(H.state.lastInsert?.payload.generic_product_id).toBe('d2'); // the exact SKU BBB row, not d1
  });

  it('hides all write controls from a non-admin (read-only)', async () => {
    H.state.role = 'sales_rep';
    H.state.mappings = [
      {
        id: 'm1',
        fallback_branded_product: 'Roundup PowerMAX',
        branded_ingredient: 'Glyphosate',
        generic_product_id: 'p2',
        generic_has_bulk: false,
        notes: null,
        generic_product: GENERIC,
      },
    ];
    render(<BrandVsGeneric />);
    // Data still visible (appears in the dropdown + table row)…
    expect((await screen.findAllByText('Generic Glyphosate')).length).toBeGreaterThan(0);
    // …but no Add button and no per-row edit/delete controls.
    expect(screen.queryByRole('button', { name: 'Add Mapping' })).toBeNull();
    expect(screen.queryByLabelText(/Edit mapping/i)).toBeNull();
    expect(screen.queryByLabelText(/Delete mapping/i)).toBeNull();
  });
});
