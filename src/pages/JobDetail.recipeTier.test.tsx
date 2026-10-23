/**
 * JobDetail.recipeTier.test.tsx — loading a recipe prices its lines at the job customer's tier.
 *
 * The page's customer list holds active customers only, and a recipe priced from that list fell
 * back to tier 1 when the job's customer was not on it. A job for an inactive tier-3 customer got
 * tier-1 recipe prices. The page now reads a customer missing from the list by id, and blocks
 * pricing when that read fails instead of assuming tier 1.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, mockNavigate, mockCapture } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  mockCapture: vi.fn(),
}));

const CHAIN_METHODS = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
  'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
  'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
  'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
  'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const m of CHAIN_METHODS) self[m] = () => self;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await (importOriginal() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    supabase: { from: mockFrom, rpc: mockRpc, storage: { from: vi.fn() } },
    checkMutationResult: vi.fn((result: { error?: unknown }) => {
      if (result?.error) throw result.error;
    }),
    assertRpcResult: vi.fn((d) => d),
    sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  };
});
vi.mock('../contexts/AuthContext', () => ({
  // A sales rep edits jobs and sees no cost, so the page reads no admin cost table.
  useAuth: () => ({ profile: { id: 'user-1', role: 'sales_rep', full_name: 'Test Rep' }, role: 'sales_rep' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: () => {} }));
vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({ state: 'unblocked', reset: vi.fn(), proceed: vi.fn() }),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mockCapture } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import JobDetail from './JobDetail';

// The job's customer is inactive, so the page's active-only customer list does not hold it.
const JOB = {
  id: 'job-1',
  job_number: 'J-0001',
  job_date: '2026-08-19',
  customer_id: 'cust-inactive',
  applicator_id: null,
  status: 'scheduled',
  customer: { farm_name: 'Old Farm' },
  vehicle: null,
  quote: null,
  quote_section: null,
  job_fields: [],
  job_chemicals: [],
  job_field_shares: [],
  applied_info: null,
};
const PRODUCT = {
  id: 'prod-1', product_name: 'Herbicide X', is_active: true, unit_size: 'gal', rate_unit: 'gal',
  current_cost: 5, tier1_price: 10, tier2_price: 9, tier3_price: 7,
};
const RECIPE = { id: 'recipe-1', name: 'Spring Mix', is_active: true };
const RECIPE_ITEM = {
  id: 'ri-1', recipe_id: 'recipe-1', product_id: 'prod-1', product_name: 'Herbicide X',
  quantity: 2, unit: 'gal', rate_per_acre: 1, sort_order: 0, notes: null, price_per_unit_cents: 0,
};

let customerByIdReads = 0;
let customerByIdRequested: unknown[] = [];
let recipeItemReads = 0;

function serveTables(customerById: { data: unknown; error: unknown }, product: object = PRODUCT, extraProducts: object[] = []) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') return buildChain({ data: JOB, error: null });
    if (table === 'customers') {
      // The list read pages with .range(); the by-id tier read ends in .maybeSingle().
      const chain = buildChain({ data: [{ id: 'cust-active', farm_name: 'Active Farm', assigned_tier: 1, is_active: true }], error: null });
      let idFilter: unknown;
      const eq = chain.eq as (...args: unknown[]) => unknown;
      chain.eq = (column: unknown, value: unknown) => { if (column === 'id') idFilter = value; return eq(column, value); };
      // The fixture answers only a read for the job's own customer.
      chain.maybeSingle = () => {
        customerByIdReads += 1;
        customerByIdRequested.push(idFilter);
        return buildChain(idFilter === 'cust-inactive' ? customerById : { data: null, error: null });
      };
      return chain;
    }
    if (table === 'products') return buildChain({ data: [product, ...extraProducts], error: null });
    if (table === 'blend_recipes') return buildChain({ data: [RECIPE], error: null });
    if (table === 'blend_recipe_items') { recipeItemReads += 1; return buildChain({ data: [RECIPE_ITEM], error: null }); }
    return buildChain({ data: [], error: null });
  });
}

async function loadRecipe() {
  const router = createMemoryRouter(
    [{ path: '/jobs/:id', element: <JobDetail /> }],
    { initialEntries: ['/jobs/job-1?tab=chemicals'] },
  );
  render(<RouterProvider router={router} />);
  fireEvent.click(await screen.findByRole('button', { name: /Select Recipe/ }));
  fireEvent.change(await screen.findByLabelText('Select recipe'), { target: { value: 'recipe-1' } });
  fireEvent.click(screen.getByRole('button', { name: /Load Recipe/ }));
}

async function openChemicalLine() {
  const router = createMemoryRouter(
    [{ path: '/jobs/:id', element: <JobDetail /> }],
    { initialEntries: ['/jobs/job-1?tab=chemicals'] },
  );
  render(<RouterProvider router={router} />);
  fireEvent.click(await screen.findByRole('button', { name: /Add Chemical/ }));
}

async function pickProduct(name: RegExp) {
  const box = screen.getByPlaceholderText('Select product...');
  fireEvent.click(box);
  fireEvent.change(box, { target: { value: name.source.split(' ')[0] } });
  fireEvent.click(await screen.findByRole('option', { name }));
}

// The price input follows its (unassociated) "Price ¢/unit" label.
function priceInput() {
  return screen.getByText('Price ¢/unit').nextElementSibling as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  customerByIdReads = 0;
  customerByIdRequested = [];
  recipeItemReads = 0;
  mockRpc.mockResolvedValue({ data: null, error: null });
});

describe('JobDetail recipe pricing tier', () => {
  it('prices a recipe at an inactive customer\'s own tier, read by id', async () => {
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null });
    await loadRecipe();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('from recipe')));
    expect(customerByIdReads).toBeGreaterThan(0);
    // Every by-id read asked for the job's own customer.
    expect(new Set(customerByIdRequested)).toEqual(new Set(['cust-inactive']));
    // Tier 3 is $7.00, not tier 1's $10.00.
    expect(screen.getByDisplayValue('700')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('1000')).not.toBeInTheDocument();
  });

  it('MONEY: prices at tier 1 when the product has no price for the customer tier, not $0', async () => {
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null }, { ...PRODUCT, tier3_price: null });
    await loadRecipe();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('from recipe')));
    expect(screen.getByDisplayValue('1000')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('0')).not.toBeInTheDocument();
  });

  it('blocks pricing the recipe when the customer cannot be read, instead of using tier 1', async () => {
    const readError = { message: 'customer read failed' };
    serveTables({ data: null, error: readError });
    await loadRecipe();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      "This job's customer could not be loaded, so products cannot be priced. Refresh the page and try again.",
    ));
    expect(mockCapture).toHaveBeenCalledWith(readError, { tags: { source: 'fetch', action: 'load_job_customer_tier' } });
    expect(recipeItemReads).toBe(0);
    expect(screen.queryByDisplayValue('1000')).not.toBeInTheDocument();
  });

  it('MONEY: a product priced at $0 replaces the previous product\'s price on a picked line', async () => {
    // Free Sample has no tier-3 price and a $0 tier-1 price: the line must not keep Herbicide X's.
    const FREE = { ...PRODUCT, id: 'prod-free', product_name: 'Free Sample', tier1_price: 0, tier2_price: null, tier3_price: null };
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null }, PRODUCT, [FREE]);
    await openChemicalLine();

    await pickProduct(/Herbicide X/);
    // Tier 3 is $7.00.
    await waitFor(() => expect(priceInput().value).toBe('700'));

    await pickProduct(/Free Sample/);
    await waitFor(() => expect(priceInput().value).toBe('0'));
  });

  it('MONEY: a product that states no price blanks the previous product\'s price, and the line cannot be saved', async () => {
    const UNPRICED = { ...PRODUCT, id: 'prod-unpriced', product_name: 'Unpriced Adjuvant', tier1_price: null, tier2_price: null, tier3_price: null };
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null }, PRODUCT, [UNPRICED]);
    await openChemicalLine();

    await pickProduct(/Herbicide X/);
    await waitFor(() => expect(priceInput().value).toBe('700'));

    await pickProduct(/Unpriced Adjuvant/);
    await waitFor(() => expect(priceInput().value).toBe(''));
    fireEvent.change(screen.getByText('Total Applied').nextElementSibling as HTMLInputElement, { target: { value: '5' } });
    expect(await screen.findByText(/its price is blank, negative, or not a whole number of cents/)).toBeInTheDocument();

    // A customer-supplied line is never billed, so its blank price no longer blocks the save.
    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    await waitFor(() => expect(screen.queryByText(/its price is blank, negative, or not a whole number of cents/)).not.toBeInTheDocument());
  });

  it('MONEY: un-ticking customer supplied on an unpriced product at $0 blanks the price, so it cannot bill $0', async () => {
    const UNPRICED = { ...PRODUCT, id: 'prod-unpriced', product_name: 'Unpriced Adjuvant', tier1_price: null, tier2_price: null, tier3_price: null };
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null }, PRODUCT, [UNPRICED]);
    await openChemicalLine();
    await pickProduct(/Unpriced Adjuvant/);
    // As if reloaded after a customer-supplied save: ticked, price stored as 0.
    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    fireEvent.change(priceInput(), { target: { value: '0' } });
    expect(priceInput().value).toBe('0');

    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    await waitFor(() => expect(priceInput().value).toBe(''));
    fireEvent.change(screen.getByText('Total Applied').nextElementSibling as HTMLInputElement, { target: { value: '5' } });
    expect(await screen.findByText(/its price is blank, negative, or not a whole number of cents/)).toBeInTheDocument();
  });

  it('MONEY: a per-gallon price that is not whole cents per oz is left blank with a warning, not rounded', async () => {
    // $1.50/gal is 1.17¢/oz: a rounded 1¢ would bill 128 oz at $1.28.
    const PER_GAL = { ...PRODUCT, id: 'prod-gal', product_name: 'Oz Rate Chem', rate_unit: 'oz/ac', product_form: 'liquid', tier1_price: 1.5, tier2_price: 1.5, tier3_price: 1.5 };
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null }, PRODUCT, [PER_GAL]);
    await openChemicalLine();
    await pickProduct(/Oz Rate Chem/);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringContaining('is not a whole number of cents per oz')));
    expect(priceInput().value).toBe('');
    // Even at quantity 0 this blank blocks: the product HAS a price, so a saved $0 would pass every
    // check once the quantity rose and bill nothing.
    fireEvent.change(screen.getByText('Total Applied').nextElementSibling as HTMLInputElement, { target: { value: '0' } });
    expect(await screen.findByText(/its price is blank, negative, or not a whole number of cents/)).toBeInTheDocument();
  });

  it('a blank price on a quantity-0 line does not block the save (it bills nothing)', async () => {
    const UNPRICED = { ...PRODUCT, id: 'prod-unpriced', product_name: 'Unpriced Adjuvant', tier1_price: null, tier2_price: null, tier3_price: null };
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null }, PRODUCT, [UNPRICED]);
    await openChemicalLine();
    await pickProduct(/Unpriced Adjuvant/);
    await waitFor(() => expect(priceInput().value).toBe(''));
    const quantityInput = screen.getByText('Total Applied').nextElementSibling as HTMLInputElement;
    fireEvent.change(quantityInput, { target: { value: '5' } });
    expect(await screen.findByText(/its price is blank, negative, or not a whole number of cents/)).toBeInTheDocument();

    fireEvent.change(quantityInput, { target: { value: '0' } });
    await waitFor(() => expect(screen.queryByText(/its price is blank, negative, or not a whole number of cents/)).not.toBeInTheDocument());
    expect(priceInput().value).toBe('');
  });

  it('MONEY: un-ticking customer supplied on a $0 line re-prices it from the catalog at the customer tier', async () => {
    // As if saved customer-supplied at $0 when the product had no price, and it has one now.
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null });
    await openChemicalLine();
    await pickProduct(/Herbicide X/);
    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    fireEvent.change(priceInput(), { target: { value: '0' } });
    expect(priceInput().value).toBe('0');

    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    // Tier 3 is $7.00.
    await waitFor(() => expect(priceInput().value).toBe('700'));
  });

  it('MONEY: un-ticking customer supplied re-prices a price written as 0.0', async () => {
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null });
    await openChemicalLine();
    await pickProduct(/Herbicide X/);
    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    fireEvent.change(priceInput(), { target: { value: '0.0' } });
    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    await waitFor(() => expect(priceInput().value).toBe('700'));
  });

  it('un-ticking customer supplied leaves a malformed price for the save check, not the catalog price', async () => {
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null });
    await openChemicalLine();
    await pickProduct(/Herbicide X/);
    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    fireEvent.change(priceInput(), { target: { value: '0.5' } });
    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    expect(priceInput().value).toBe('0.5');
  });

  it('MONEY: a typed $0 on a billable line whose product states no price cannot be saved (mirrors the server trigger)', async () => {
    const UNPRICED = { ...PRODUCT, id: 'prod-unpriced', product_name: 'Unpriced Adjuvant', tier1_price: null, tier2_price: null, tier3_price: null };
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null }, PRODUCT, [UNPRICED]);
    await openChemicalLine();
    await pickProduct(/Unpriced Adjuvant/);
    fireEvent.change(screen.getByText('Total Applied').nextElementSibling as HTMLInputElement, { target: { value: '5' } });
    fireEvent.change(priceInput(), { target: { value: '0' } });
    expect(await screen.findByText(/its product has no price for this customer's tier, so it would bill \$0/)).toBeInTheDocument();
  });

  it('un-ticking customer supplied keeps a priced product\'s $0 price', async () => {
    const FREE = { ...PRODUCT, id: 'prod-free', product_name: 'Free Sample', tier1_price: 0, tier2_price: null, tier3_price: null };
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null }, PRODUCT, [FREE]);
    await openChemicalLine();
    await pickProduct(/Free Sample/);
    await waitFor(() => expect(priceInput().value).toBe('0'));
    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    fireEvent.click(document.getElementById('cust-supp-0') as HTMLInputElement);
    expect(priceInput().value).toBe('0');
  });

  it('MONEY: drops a recipe load whose customer changed while its products were loading', async () => {
    serveTables({ data: { id: 'cust-inactive', assigned_tier: 3 }, error: null });
    // The recipe's products are held until the customer has been changed.
    let release!: (result: { data: unknown; error: unknown }) => void;
    const held = new Promise<{ data: unknown; error: unknown }>((resolve) => { release = resolve; });
    const served = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'blend_recipe_items') return served(table);
      const chain: Record<string, unknown> = {};
      for (const m of CHAIN_METHODS) chain[m] = () => chain;
      chain.then = (...args: Parameters<Promise<unknown>['then']>) => held.then(...args);
      return chain;
    });
    await loadRecipe();

    // The recipe dialog hides the page from role queries, so the customer box (the one listing the
    // active customers) is found directly.
    const customerSelect = [...document.querySelectorAll('select')]
      .find((el) => [...el.options].some((o) => o.value === 'cust-active')) as HTMLSelectElement;
    fireEvent.change(customerSelect, { target: { value: 'cust-active' } });
    await act(async () => {
      release({ data: [RECIPE_ITEM], error: null });
      await held;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockToast).toHaveBeenCalledWith('error', "The job's customer changed while the products were loading. Load them again to price them for this customer.");
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.stringContaining('from recipe'));
    expect(screen.queryByDisplayValue('700')).not.toBeInTheDocument();
  });
});
