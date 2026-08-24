/**
 * JobDetail.billingHazard.test.tsx — the FIRST test that mounts JobDetail.
 *
 * Why this file exists. Every defect in the chem grid found so far has been emergent from
 * COMPOSITION, not from a wrong pure function: the calculator helpers are individually
 * correct and individually tested, while the page that wires them together had no test at
 * all. chemCalculator.test.ts proves chemLineBillingHazard's arithmetic; only mounting the
 * real page proves the guard is actually WIRED — that the warning renders and that Save is
 * genuinely refused.
 *
 * The scenario is the live one: a product carrying a 'Dry oz' rate against pound stock.
 * reconcileChemAutofillUnits cannot size 'dry oz' in DRY_TO_POUNDS, so it keeps the per-POUND
 * price while quantity counts OUNCES, and transfer_job_to_invoice bills quantity × price with
 * no conversion — 16× too much, silently. 75 live products carry a 'Dry oz' rate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, mockNavigate } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc, storage: { from: vi.fn() } },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
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
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/criticalAction', () => ({
  runCriticalAction: async ({ action, setLoading }: {
    action: () => Promise<void>; setLoading?: (v: boolean) => void;
  }) => { setLoading?.(true); try { await action(); } finally { setLoading?.(false); } },
}));
vi.mock('../lib/dateUtils', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, localToday: () => '2026-08-19' };
});

import JobDetail from './JobDetail';

const DRY_PRODUCT = {
  id: 'prod-dry-1',
  product_name: 'Dry Ounce Herbicide',
  product_form: 'dry',
  unit_size: 'Lb',
  inventory_unit: 'Lb',
  rate_unit: 'Dry oz/ac',
  // $1.50 / lb — the exact live shape that bills 16× when the quantity counts ounces.
  cost_cents: 150,
  tier1_price_cents: 150,
  is_active: true,
  max_label_rate: null,
  max_label_rate_unit: null,
  rei_hours: null,
  phi_days: null,
  epa_registration: null,
  product_family: null,
};

/** 32 Dry oz/ac × 100 ac = 3,200 (ounces) labelled 'Lb' and priced $1.50/lb → $4,800 vs $300. */
const HAZARD_CHEM = {
  id: 'jc-1',
  product_id: DRY_PRODUCT.id,
  product: { product_name: DRY_PRODUCT.product_name },
  quantity: 3200,
  unit: 'Lb',
  rate_per_acre: 32,
  rate_unit: 'Dry oz/ac',
  cost_per_unit_cents: 150,
  price_per_unit_cents: 150,
  diluent_rate: null,
  rei_hours: null,
  phi_days: null,
  warehouse: null,
  vendor: null,
  customer_supplied: false,
  sort_order: 0,
};

function makeJob(chem: Record<string, unknown>) {
  return {
    id: 'job-1',
    job_number: 'J-1001',
    job_date: '2026-08-19',
    customer_id: 'cust-1',
    status: 'scheduled',
    customer: { farm_name: 'Farm Alpha' },
    vehicle: null,
    quote: null,
    quote_section: null,
    job_fields: [{ id: 'jf-1', acres_to_treat: 100, field: { field_name: 'North 100' } }],
    job_chemicals: [chem],
    job_field_shares: [],
    applied_info: null,
  };
}

function mountWith(chem: Record<string, unknown>) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') return buildChain({ data: makeJob(chem), error: null });
    if (table === 'products') return buildChain({ data: [DRY_PRODUCT], error: null });
    return buildChain({ data: [], error: null });
  });
  return render(
    <MemoryRouter initialEntries={['/jobs/job-1?tab=chemicals']}>
      <Routes><Route path="/jobs/:id" element={<JobDetail />} /></Routes>
    </MemoryRouter>,
  );
}

/**
 * A `products` chain that answers the ACTIVE-LIST query and the BY-ID query differently,
 * which buildChain cannot do (it fixes its result before any filter is applied).
 *
 * The distinction is the whole point of the discontinued-product case: `.eq('is_active',
 * true)` must come back EMPTY, while `.in('id', [...])` must still return the product. The
 * result is therefore resolved lazily, at await time, once the filters have been recorded.
 */
function buildProductsChain(rows: unknown[]): Record<string, unknown> {
  let activeOnly = false;
  let byId = false;
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'contains', 'containedBy', 'range', 'filter', 'not',
    'or', 'and', 'match', 'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal']) self[m] = method;
  self.eq = (col: unknown, val: unknown) => {
    if (col === 'is_active' && val === true) activeOnly = true;
    return self;
  };
  self.in = (col: unknown, _vals: unknown) => { if (col === 'id') byId = true; return self; };
  const settle = () => Promise.resolve({ data: activeOnly && !byId ? [] : rows, error: null });
  self.then = (onF: unknown, onR: unknown) => settle().then(onF as never, onR as never);
  self.catch = (onR: unknown) => settle().catch(onR as never);
  self.finally = (onF: unknown) => settle().finally(onF as never);
  return self;
}

/** Same as mountWith, but the product is DISCONTINUED: absent from the active list, and
 *  reachable only by id — the shape a saved job with a retired product actually has. */
function mountWithInactiveProduct(chem: Record<string, unknown>) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') return buildChain({ data: makeJob(chem), error: null });
    if (table === 'products') return buildProductsChain([{ ...DRY_PRODUCT, is_active: false }]);
    return buildChain({ data: [], error: null });
  });
  return render(
    <MemoryRouter initialEntries={['/jobs/job-1?tab=chemicals']}>
      <Routes><Route path="/jobs/:id" element={<JobDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('JobDetail — billing-hazard guard is wired, not just implemented', () => {
  beforeEach(() => {
    mockToast.mockClear();
    mockRpc.mockClear();
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  it('shows the on-screen warning for the live Dry oz / Lb row', async () => {
    mountWith(HAZARD_CHEM);
    expect(await screen.findByText(/This line cannot be saved/i, {}, { timeout: 15000 })).toBeTruthy();
    // The message must name BOTH units and the actual over-bill factor, or it is not actionable.
    const banner = screen.getByText(/This line cannot be saved/i).closest('div') as HTMLElement;
    expect(banner.textContent).toContain('dry oz');
    expect(banner.textContent).toContain('lb');
    expect(banner.textContent).toContain('16');
  }, 30000);

  it('REFUSES the save — no job RPC is called', async () => {
    mountWith(HAZARD_CHEM);
    await screen.findByText(/This line cannot be saved/i, {}, { timeout: 15000 });

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    const save = saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement;
    fireEvent.click(save);

    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    const errors = mockToast.mock.calls.filter((c) => c[0] === 'error').map((c) => String(c[1]));
    expect(errors.some((m) => /counted in dry oz|cannot be saved/i.test(m))).toBe(true);
    // The real proof: save_job never ran, so no wrong row could reach job_chemicals.
    // (The page calls unrelated read RPCs such as get_notes_for_entity on mount.)
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
  }, 30000);

  it('never offers the relabel-only remedy — in the banner OR the save toast', async () => {
    // THE BYPASS THIS PINS. Changing `rate_unit` only changes a LABEL: it does not recalculate
    // the quantity or the price. Turning 'Dry oz/ac' into 'Lb/ac' therefore makes the two units
    // match, which silences the guard, while quantity 3200 and price 150c/Lb stay exactly as
    // they were — saving the identical $4,800-instead-of-$300 charge in silence.
    //
    // An operator who follows the remedy VERBATIM must not end up there. This asserts both
    // places that carry the advice, because the first fix corrected the banner and left the
    // save-time toast still teaching the bypass. (Codex, 2026-08-20)
    mountWith(HAZARD_CHEM);
    const banner = await screen.findByText(/This line cannot be saved/i, {}, { timeout: 15000 });
    const bannerText = banner.closest('div')?.textContent || '';
    expect(bannerText).toMatch(/re-enter the rate/i);
    expect(bannerText).toMatch(/does not change the amount/i);

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    fireEvent.click(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    await waitFor(() => expect(mockToast).toHaveBeenCalled());

    const errors = mockToast.mock.calls.filter((c) => c[0] === 'error').map((c) => String(c[1]));
    const hazardToast = errors.find((m) => /quantity counted in/i.test(m)) || '';
    expect(hazardToast).not.toBe('');
    expect(hazardToast).toMatch(/re-enter the rate/i);
    expect(hazardToast).toMatch(/does not change the amount/i);
    // The specific dangerous shape: a bare "or change the rate unit to X/ac." that ENDS the
    // sentence, with no instruction to re-enter the rate alongside it.
    expect(hazardToast).not.toMatch(/or change the rate unit to \S+\/ac\.\s*$/i);
  }, 30000);

  it('SAVES an exactly-rounded total, matching the server rather than binary float', async () => {
    // 25c x 0.58 is exactly 14.50. The server's safe_cents_qty rounds half away from zero
    // to 15c (verified live: ROUND(25::numeric * 0.58) = 15), but Math.round(0.58 * 25)
    // gives 14 because the binary product falls just below the half-cent boundary.
    // jobs.total_price_cents is SAVED from this figure, so the old float path persisted a
    // number the database's own arithmetic disagreed with.
    mountWith({
      ...HAZARD_CHEM,
      quantity: 0.58, unit: 'Lb', rate_per_acre: 0.0058, rate_unit: 'Lb/ac',
      cost_per_unit_cents: 25, price_per_unit_cents: 25,
    });
    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    const save = saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement;
    fireEvent.click(save);

    await waitFor(
      () => expect(mockRpc.mock.calls.some((c) => c[0] === 'save_job')).toBe(true),
      { timeout: 15000 },
    );
    const saveCall = mockRpc.mock.calls.find((c) => c[0] === 'save_job');
    const args = saveCall?.[1] as { p_job_payload: Record<string, unknown> };
    expect(args.p_job_payload.total_price_cents).toBe(15);   // exact — NOT the float path's 14
    expect(args.p_job_payload.total_cost_cents).toBe(15);
  }, 30000);

  it('a RELOADED line keeps the operator\'s saved quantity when the acreage changes', async () => {
    // F06 IS STILL OPEN and this test pins the SAFE side of it, not a fix. `driver` is never
    // persisted, so a reloaded row is left untouched when the acreage changes: a 1.5 pt/ac
    // line saved over 100 acres still reads 150 pt after the job grows to 200. That
    // under-bills and under-applies.
    //
    // An earlier pass "fixed" it by inferring the driver from `quantity == rate x acres`.
    // Codex refuted it (P1) and the inference was reverted: applyChemEdit back-solves
    // rate_per_acre whenever the user types a quantity, so a HAND-ENTERED total satisfies
    // that equality by construction and would have been silently rewritten too. Rewriting an
    // operator's typed chemical amount is worse than leaving it stale, so until the driver is
    // persisted on job_chemicals the page must not touch a reloaded quantity at all.
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        return buildChain({
          data: makeJob({
            ...HAZARD_CHEM,
            quantity: 150, unit: 'pt', rate_per_acre: 1.5, rate_unit: 'pt/ac',
          }),
          error: null,
        });
      }
      if (table === 'products') return buildChain({ data: [DRY_PRODUCT], error: null });
      return buildChain({ data: [], error: null });
    });
    render(
      <MemoryRouter initialEntries={['/jobs/job-1?tab=locations']}>
        <Routes><Route path="/jobs/:id" element={<JobDetail />} /></Routes>
      </MemoryRouter>,
    );

    // Double the acreage on the Locations tab: 100 → 200.
    const acresInput = await waitFor(() => {
      const found = screen.getAllByRole('spinbutton')
        .find((el) => (el as HTMLInputElement).value === '100');
      if (!found) throw new Error('acres input not found');
      return found as HTMLInputElement;
    }, { timeout: 15000 });
    fireEvent.change(acresInput, { target: { value: '200' } });

    // Move to the Chemicals tab, where the quantity input lives.
    const chemTab = screen.getAllByRole('button').find((b) => /chemical/i.test(b.textContent || ''));
    fireEvent.click(chemTab as HTMLElement);

    // The saved quantity must be left exactly as the operator saved it — NOT re-derived.
    await waitFor(() => {
      const values = screen.getAllByRole('spinbutton').map((el) => (el as HTMLInputElement).value);
      expect(values).toContain('150');
    }, { timeout: 15000 });
    const after = screen.getAllByRole('spinbutton').map((el) => (el as HTMLInputElement).value);
    expect(after).not.toContain('300');
  }, 30000);

  it('refuses a quantity typed in exponent notation instead of billing it as zero', async () => {
    // Codex P2. `<input type="number">` accepts '1e3' as a valid value. The save gate used
    // Number.isFinite(Number(text)), which passes it, while centsTimesQuantity refuses
    // exponent notation and returns 0 — so the line saved a quantity of 1000 while
    // jobs.total_cost_cents / total_price_cents were written as 0. Both now use one grammar.
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        return buildChain({
          data: makeJob({
            ...HAZARD_CHEM,
            quantity: 10, unit: 'pt', rate_per_acre: 0.1, rate_unit: 'pt/ac',
          }),
          error: null,
        });
      }
      if (table === 'products') return buildChain({ data: [DRY_PRODUCT], error: null });
      return buildChain({ data: [], error: null });
    });
    render(
      <MemoryRouter initialEntries={['/jobs/job-1?tab=chemicals']}>
        <Routes><Route path="/jobs/:id" element={<JobDetail />} /></Routes>
      </MemoryRouter>,
    );

    const qtyInput = await waitFor(() => {
      const found = screen.getAllByRole('spinbutton')
        .find((el) => (el as HTMLInputElement).value === '10');
      if (!found) throw new Error('quantity input not found');
      return found as HTMLInputElement;
    }, { timeout: 15000 });
    fireEvent.change(qtyInput, { target: { value: '1e3' } });

    expect(await screen.findByText(/cannot be saved/i, {}, { timeout: 15000 })).toBeTruthy();
    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    // Pick the JOB Save explicitly. Clicking "Save as Recipe" would also leave save_job
    // uncalled, so an index-based click could pass without proving anything.
    fireEvent.click(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    await waitFor(() => {
      expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
    }, { timeout: 15000 });
  }, 30000);

  it('refuses a fractional cent instead of silently truncating it', async () => {
    // Cents are whole. isExactDecimalText('150.7') is true, but parseInt truncates it to 150
    // in both the saved total and buildJobChemicalsPayload — the operator's number would
    // change under them, visible only after a reload.
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        return buildChain({
          data: makeJob({
            ...HAZARD_CHEM,
            quantity: 10, unit: 'pt', rate_per_acre: 0.1, rate_unit: 'pt/ac',
          }),
          error: null,
        });
      }
      if (table === 'products') return buildChain({ data: [DRY_PRODUCT], error: null });
      return buildChain({ data: [], error: null });
    });
    render(
      <MemoryRouter initialEntries={['/jobs/job-1?tab=chemicals']}>
        <Routes><Route path="/jobs/:id" element={<JobDetail />} /></Routes>
      </MemoryRouter>,
    );

    const priceInput = await waitFor(() => {
      const found = screen.getAllByRole('spinbutton')
        .find((el) => (el as HTMLInputElement).value === '150');
      if (!found) throw new Error('price input not found');
      return found as HTMLInputElement;
    }, { timeout: 15000 });
    fireEvent.change(priceInput, { target: { value: '150.7' } });

    expect(await screen.findByText(/whole number of cents/i, {}, { timeout: 15000 })).toBeTruthy();

    // Same gate, the other precision failure: a cents value past 2^53 is ALREADY rounded by
    // the time Number() returns it, and reports as a whole integer. isSafeInteger refuses it.
    expect(Number.isInteger(Number('9007199254740993'))).toBe(true);      // the looser check passes
    expect(Number.isSafeInteger(Number('9007199254740993'))).toBe(false); // the real one does not
    fireEvent.change(priceInput, { target: { value: '9007199254740993' } });
    expect(await screen.findByText(/whole number of cents/i, {}, { timeout: 15000 })).toBeTruthy();

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    fireEvent.click(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    await waitFor(() => {
      expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
    }, { timeout: 15000 });
  }, 30000);

  it('refuses a rate unit measured per something other than acres', async () => {
    // 'oz/cwt' is per hundredweight. baseUnitOfRate strips everything after the first '/',
    // so the app treated it as oz PER ACRE and filled quantity = rate x acres — not a unit
    // mismatch but the wrong quantity outright, and it saved.
    mountWith({
      ...HAZARD_CHEM,
      quantity: 200, unit: 'oz', rate_per_acre: 2, rate_unit: 'oz/cwt',
    });
    expect(await screen.findByText(/cannot be saved/i, {}, { timeout: 15000 })).toBeTruthy();
    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    fireEvent.click(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
  }, 30000);

  it('refuses a CLEARED price instead of silently saving zero', async () => {
    // buildJobChemicalsPayload coerces with `parseInt(...) || 0`, so a price the user clears
    // used to save as 0 — a line that bills NOTHING, silently. (A reloaded null comes back
    // as '0' from the loader, so the reachable path is the user emptying the field.)
    mountWith({
      ...HAZARD_CHEM,
      quantity: 200, unit: 'Lb', rate_per_acre: 2, rate_unit: 'Lb/ac',
    });
    const priceInput = await waitFor(() => {
      const found = screen.getAllByRole('spinbutton')
        .filter((el) => (el as HTMLInputElement).value === '150');
      if (found.length === 0) throw new Error('price input not found');
      return found[found.length - 1] as HTMLInputElement;   // cost then price; take price
    }, { timeout: 15000 });
    fireEvent.change(priceInput, { target: { value: '' } });

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    fireEvent.click(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    const errors = mockToast.mock.calls.filter((c) => c[0] === 'error').map((c) => String(c[1]));
    expect(errors.some((m) => /its price is blank, or is not a whole number of cents/i.test(m))).toBe(true);
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
  }, 30000);

  it('does NOT warn or block an aligned row (no false positive on ordinary work)', async () => {
    // Same product, correctly expressed: 2 Lb/ac × 100 ac = 200 lb priced per lb.
    mountWith({
      ...HAZARD_CHEM,
      quantity: 200, unit: 'Lb', rate_per_acre: 2, rate_unit: 'Lb/ac',
    });
    await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    expect(screen.queryByText(/This line cannot be saved/i)).toBeNull();
  });

  it('does NOT block a job whose product has since been DISCONTINUED', async () => {
    // THE FALSE POSITIVE THIS PINS (Codex P2, 2026-08-23). loadLookups fills allProducts
    // with is_active = true only. A saved job carrying a now-inactive product therefore had
    // NO product_form, and fieldAppPricedQuantity silently fell to its LIQUID table — so a
    // correctly carried DRY line (1 oz/ac × 100 ac = 100 oz = 6.25 lb) could not be proven
    // safe, and the fail-closed guard blocked the whole job. The operator could not even fix
    // the memo: performSave re-sends the entire grid, so one un-provable line freezes it all.
    //
    // The form is now resolved by product id, inactive included, so the row proves out.
    mountWithInactiveProduct({
      ...HAZARD_CHEM,
      quantity: 6.25, unit: 'Lb', rate_per_acre: 1, rate_unit: 'oz/ac',
    });
    await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    expect(screen.queryByText(/This line cannot be saved/i)).toBeNull();
  }, 30000);
});
