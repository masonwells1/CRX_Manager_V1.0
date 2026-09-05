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

vi.mock('../lib/db', async () => ({
  supabase: { from: mockFrom, rpc: mockRpc, storage: { from: vi.fn() } },
  checkMutationResult: vi.fn(),
  // The REAL assertRpcResult. The passthrough stub `vi.fn((d) => d)` never throws, so
  // an RPC answering with an empty payload and no error — the ambiguous reply this
  // helper exists to reject — was indistinguishable from success in every test here.
  assertRpcResult: (await vi.importActual<typeof import('../lib/db')>('../lib/db')).assertRpcResult,
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  // Previously absent. JobDetail imports both, so any code path reaching them under
  // this mock would fail on `undefined` rather than on the behaviour under test.
  hasRpcCode: (error: { message?: string }, code: string) => (
    error?.message === code
    || error?.message?.startsWith(`${code}:`) === true
    || error?.message?.startsWith(`${code} `) === true
  ),
  RpcErrorCodes: {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    ACTOR_MISMATCH: 'ACTOR_MISMATCH',
    INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  },
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

function makeJob(
  chem: Record<string, unknown>,
  acres: number | string | Array<number | string> = 100,
  applicatorId: string | null = null,
) {
  const fieldAcres = Array.isArray(acres) ? acres : [acres];
  return {
    id: 'job-1',
    job_number: 'J-1001',
    job_date: '2026-08-19',
    customer_id: 'cust-1',
    applicator_id: applicatorId,
    status: 'scheduled',
    customer: { farm_name: 'Farm Alpha' },
    vehicle: null,
    quote: null,
    quote_section: null,
    job_fields: fieldAcres.map((fieldAcresValue, index) => ({
      id: `jf-${index + 1}`,
      acres_to_treat: fieldAcresValue,
      field: { field_name: `Field ${index + 1}` },
    })),
    job_chemicals: [chem],
    job_field_shares: [],
    applied_info: null,
  };
}

// Enough of the live unit_conversions table for the Unit dropdown to offer the dry
// units the relabel tests exercise. Without rows, the select renders only the blank
// option plus the grandfathered current value, and a change to any other unit is
// coerced to '' by the DOM before React ever sees it.
const UNIT_CONVERSIONS = [
  { id: 'uc-lb', unit: 'Lb', factor_oz: 16, unit_type: 'dry' },
  { id: 'uc-dryoz', unit: 'Dry oz', factor_oz: 1, unit_type: 'dry' },
];

/**
 * The ACTIVE-list products query answers immediately, so the grid and the hazard banner render
 * at once, while the BY-ID query — the one whose effect flips `jobLabelsLoaded` — is held open
 * until the test explicitly releases it. That is the exact shape of the real race, made
 * deterministic ON PURPOSE.
 *
 * Without this, the window between "banner is on screen" and "save gate is open" is only a few
 * microseconds wide: it closes before the test can click, so the retry in clickSave() is never
 * exercised locally and a reverted fix looks green — until CI load widens the window and the
 * suite fails intermittently instead. Holding the by-id load open forces every save-clicking
 * test through the fail-closed branch first, so the guard's real behaviour is what gets proven.
 *
 * The gate is a DEFERRED PROMISE, not a timer. An earlier draft held the query for a fixed
 * 800ms, which silently stops testing anything the moment a machine is slow: if setup outlasts
 * the timer, the query resolves before the first click, no fail-closed toast is emitted, and
 * clickSave() returns on its first attempt having exercised no retry at all — a green test
 * proving nothing. With an explicit gate the ordering holds on any machine at any speed, and
 * clickSave() ASSERTS the blocked attempt actually happened. (CodeRabbit, PR #485.)
 *
 * Verified 2026-08-25: with this harness and a single un-retried click, 5 tests fail with the
 * production symptom (`expected false to be true`, toast "Checking the label-rate policy — try
 * Save again in a moment."); with clickSave(), all 14 pass.
 */
let releaseLabelLookup: () => void = () => {};
// True only while a mountWith() gate is installed for the CURRENT test. A few tests build
// their own `mockFrom` instead of calling mountWith, so their by-id lookup resolves
// immediately and there is no fail-closed attempt to assert. Reset in beforeEach so the
// flag can never leak from one test into the next.
let labelLookupGated = false;

function buildGatedByIdProductsChain(rows: unknown[], gate: Promise<void>): Record<string, unknown> {
  let byId = false;
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal']) self[m] = method;
  self.in = (col: unknown, _vals: unknown) => { if (col === 'id') byId = true; return self; };
  const settle = () => (byId
    ? gate.then(() => ({ data: rows, error: null }))
    : Promise.resolve({ data: rows, error: null }));
  self.then = (onF: unknown, onR: unknown) => settle().then(onF as never, onR as never);
  self.catch = (onR: unknown) => settle().catch(onR as never);
  self.finally = (onF: unknown) => settle().finally(onF as never);
  return self;
}

function mountWith(
  chem: Record<string, unknown>,
  acres: number | string | Array<number | string> = 100,
  licenseFixture?: {
    applicator: { id: string; full_name: string; role: string; is_active: boolean };
    license: { profile_id: string; expiry_date: string; is_active: boolean };
    savedApplicatorId?: string | null;
  },
) {
  // One gate per mount, created BEFORE render so the by-id effect can only ever
  // observe the pending promise. `from('products')` is called more than once, so the
  // gate must be shared across those chains rather than created inside each.
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = () => resolve(); });
  releaseLabelLookup = release;
  labelLookupGated = true;

  mockFrom.mockImplementation((table: string) => {
    if (table === 'jobs') {
      return buildChain({
        data: makeJob(chem, acres, licenseFixture?.savedApplicatorId ?? null),
        error: null,
      });
    }
    if (table === 'products') return buildGatedByIdProductsChain([DRY_PRODUCT], gate);
    if (table === 'unit_conversions') return buildChain({ data: UNIT_CONVERSIONS, error: null });
    if (table === 'profile_public_view') {
      return buildChain({ data: licenseFixture ? [licenseFixture.applicator] : [], error: null });
    }
    if (table === 'applicator_licenses') {
      return buildChain({ data: licenseFixture ? [licenseFixture.license] : [], error: null });
    }
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

/**
 * Click Save, retrying while the page is still fail-closed on its label-rate lookups.
 *
 * handleSave's FIRST branch returns early with "Checking the label-rate policy — try Save
 * again in a moment." whenever `guardrailModeLoaded`/`jobLabelsLoaded` have not resolved yet.
 * Those are SEPARATE queries from the job/products fetch that renders the hazard banner, so
 * awaiting the banner does NOT imply the save gate is open. A single click landing in that
 * window emits a non-matching toast and returns — and nothing re-fires the save, so a
 * `waitFor` on the expected toast just spins until it times out. That is the intermittent CI
 * failure (`expected false to be true` from the toast assertion) on a correct, unchanged page:
 * a race in the test, not a defect in the guard. Longer timeouts cannot fix it; only a retry can.
 *
 * Retrying is exactly what the app instructs the operator to do, and it cannot double-save:
 * while the gate is closed the save never proceeds, and once it is open the loop stops.
 *
 * Because mountWith() holds the by-id lookup open until released, the FIRST click is
 * guaranteed to hit the fail-closed branch — so this asserts that it did. That assertion is
 * what stops the harness from quietly degrading into a no-op: if the gate ever stopped
 * closing, this fails loudly instead of passing while testing nothing.
 */
async function clickSave(saveButton: HTMLElement) {
  // 1. The blocked attempt — asserted only where mountWith actually installed the gate.
  //    Proves the page really does refuse while the policy is still loading, and stops this
  //    harness from quietly degrading into a no-op: if the gate ever stopped closing, this
  //    fails loudly instead of passing while testing nothing.
  if (labelLookupGated) {
    const before = mockToast.mock.calls.length;
    fireEvent.click(saveButton);
    const blocked = mockToast.mock.calls.slice(before).map((c) => String(c[1]));
    expect(blocked.some((m) => /Checking the label-rate policy/i.test(m))).toBe(true);
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
  }

  // 2. Let the label-rate lookup finish, then retry until the gate is actually open.
  releaseLabelLookup();
  await waitFor(() => {
    const mark = mockToast.mock.calls.length;
    fireEvent.click(saveButton);
    const fresh = mockToast.mock.calls.slice(mark).map((c) => String(c[1]));
    expect(fresh.some((m) => /Checking the label-rate policy/i.test(m))).toBe(false);
  }, { timeout: 15000 });
}

describe('JobDetail — billing-hazard guard is wired, not just implemented', () => {
  beforeEach(() => {
    mockToast.mockClear();
    mockRpc.mockClear();
    mockRpc.mockResolvedValue({ data: null, error: null });
    // A gate belongs to exactly one test. Clearing here means a test that builds its own
    // `mockFrom` can never inherit the previous test's gate — or its release function.
    labelLookupGated = false;
    releaseLabelLookup = () => {};
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
    await clickSave(save);

    // Wait for the MATCHING toast, not merely the first toast of any kind — under CI
    // load an unrelated toast can land first, and asserting on a snapshot taken at that
    // moment reads as "the guard didn't fire" when it fires one tick later.
    await waitFor(() => {
      const errors = mockToast.mock.calls.filter((c) => c[0] === 'error').map((c) => String(c[1]));
      expect(errors.some((m) => /counted in dry oz|cannot be saved/i.test(m))).toBe(true);
    }, { timeout: 15000 });
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
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    // Wait for the MATCHING toast, not the first toast of any kind (CI-interleaving race).
    const hazardToast = await waitFor(() => {
      const errors = mockToast.mock.calls.filter((c) => c[0] === 'error').map((c) => String(c[1]));
      const found = errors.find((m) => /quantity counted in/i.test(m)) || '';
      expect(found).not.toBe('');
      return found;
    }, { timeout: 15000 });
    expect(hazardToast).toMatch(/re-enter the rate/i);
    expect(hazardToast).toMatch(/does not change the amount/i);
    // The specific dangerous shape: a bare "or change the rate unit to X/ac." that ENDS the
    // sentence, with no instruction to re-enter the rate alongside it.
    expect(hazardToast).not.toMatch(/or change the rate unit to \S+\/ac\.\s*$/i);
  }, 30000);

  it('clears the per-unit money when the stock Unit is RELABELLED to a different unit (Codex P1, 2026-08-24)', async () => {
    // THE OTHER HALF OF THE RELABEL BYPASS. The remedy's first option says to set the
    // Unit to the rate's unit AND re-enter its cost/price — but nothing enforced the
    // second half: changing only Unit from Lb to Dry oz made the units compare equal,
    // the guard cleared, and the same 150¢ figures billed per OUNCE ($4,800 not $300).
    // Relabelling between two REAL units now clears the amounts (they were entered per
    // the old unit and no longer state anything provable), and the blank-cents save
    // gate holds the row until they are re-entered.
    mountWith(HAZARD_CHEM);
    await screen.findByText(/This line cannot be saved/i, {}, { timeout: 15000 });

    const unitSelect = screen.getByDisplayValue('Lb') as HTMLSelectElement;
    fireEvent.change(unitSelect, { target: { value: 'Dry oz' } });

    // The money is gone from the row, and the operator was told why.
    await waitFor(() => {
      const infos = mockToast.mock.calls.filter((c) => c[0] === 'info').map((c) => String(c[1]));
      expect(infos.some((m) => /cost and price were entered per Lb/i.test(m) && /cleared/i.test(m))).toBe(true);
    });

    // The save is still refused — by the blank-cents gate now — and save_job never runs.
    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/cannot be saved/i)));
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
  }, 30000);

  it('KEEPS entered money when a BLANK Unit is labelled for the first time', async () => {
    // Labelling is not relabelling: the blank-unit defect's own remedy is "pick the
    // unit", and the operator's amounts were always meant per the unit they now name.
    // Clearing them here would punish following the instruction.
    mountWith({ ...HAZARD_CHEM, unit: '', rate_unit: 'Lb/ac' });
    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    expect(saveButtons.length).toBeGreaterThan(0);

    // Several inputs legitimately display '' — pick the SELECT whose options carry the
    // stock units and whose current value is the blank one.
    const unitSelect = screen.getAllByRole('combobox').find((s) => {
      const sel = s as HTMLSelectElement;
      return sel.value === '' && Array.from(sel.options).some((o) => o.value === 'Lb');
    }) as HTMLSelectElement;
    expect(unitSelect).toBeTruthy();
    fireEvent.change(unitSelect, { target: { value: 'Lb' } });

    await waitFor(() => {
      expect(screen.getAllByDisplayValue('150').length).toBeGreaterThan(0);
    });
    const infos = mockToast.mock.calls.filter((c) => c[0] === 'info').map((c) => String(c[1]));
    expect(infos.some((m) => /cleared/i.test(m))).toBe(false);
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
    await clickSave(save);

    await waitFor(
      () => expect(mockRpc.mock.calls.some((c) => c[0] === 'save_job')).toBe(true),
      { timeout: 15000 },
    );
    const saveCall = mockRpc.mock.calls.find((c) => c[0] === 'save_job');
    const args = saveCall?.[1] as { p_job_payload: Record<string, unknown> };
    expect(args.p_job_payload.total_price_cents).toBe(15);   // exact — NOT the float path's 14
    expect(args.p_job_payload.total_cost_cents).toBe(15);
  }, 30000);

  it('SAVES a quantity exactly on PostgreSQL numeric tolerance instead of falsely blocking it', async () => {
    // Exact SQL arithmetic: abs(0.1001 - (0.0501 x 2)) = 0.0001, and the
    // server comparison is inclusive. Binary float reads the difference as
    // 0.00010000000000000286 and used to show "no longer agree" / block Save.
    mountWith({
      ...HAZARD_CHEM,
      quantity: 0.1001, unit: 'Lb', rate_per_acre: 0.0501, rate_unit: 'Lb/ac',
    }, 2);

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    const save = saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement;
    await clickSave(save);

    await waitFor(
      () => expect(mockRpc.mock.calls.some((c) => c[0] === 'save_job')).toBe(true),
      { timeout: 15000 },
    );
    expect(screen.queryByText(/no longer agree/i)).toBeNull();
    const saveCall = mockRpc.mock.calls.find((c) => c[0] === 'save_job');
    const args = saveCall?.[1] as { p_fields: Array<Record<string, unknown>>; p_chemicals: Array<Record<string, unknown>> };
    expect(args.p_fields[0].acres_to_treat).toBe(2);
    expect(args.p_chemicals[0]).toMatchObject({ quantity: 0.1001, rate_per_acre: 0.0501 });
  }, 30000);

  it('SAVES an exact-boundary quantity when acreage is split across decimal fields', async () => {
    // The payload sends 0.1 and 0.2 as separate field values, so PostgreSQL numeric sums
    // exact 0.3. A binary client sum of 0.30000000000000004 used to falsely block this row.
    mountWith({
      ...HAZARD_CHEM,
      quantity: 0.01493, unit: 'Lb', rate_per_acre: 0.0501, rate_unit: 'Lb/ac',
    }, [0.1, 0.2]);

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    const save = saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement;
    await clickSave(save);

    await waitFor(
      () => expect(mockRpc.mock.calls.some((c) => c[0] === 'save_job')).toBe(true),
      { timeout: 15000 },
    );
    expect(screen.queryByText(/no longer agree/i)).toBeNull();
    const saveCall = mockRpc.mock.calls.find((c) => c[0] === 'save_job');
    const args = saveCall?.[1] as {
      p_job_payload: Record<string, unknown>;
      p_fields: Array<Record<string, unknown>>;
      p_chemicals: Array<Record<string, unknown>>;
    };
    expect(args.p_job_payload.total_acres).toBe(0.3);
    expect(args.p_fields.map((field) => field.acres_to_treat)).toEqual([0.1, 0.2]);
    expect(args.p_chemicals[0]).toMatchObject({ quantity: 0.01493, rate_per_acre: 0.0501 });
  }, 30000);

  it('SAVES the lower boundary that restoration of floating-point comparison rejects', async () => {
    // The field payload values sum to exact 1000000000000000.3 in PostgreSQL numeric,
    // while the browser's Number values cannot represent the product and subtraction
    // exactly. At this deliberately synthetic scale, the submitted quantity is on SQL's
    // accepted lower 0.1 boundary but Math.abs reports it outside. This pins exact decimal
    // comparison through the real save gate; the schema has no precision ceiling.
    mountWith({
      ...HAZARD_CHEM,
      quantity: 999999999.9000003, unit: 'Lb', rate_per_acre: 0.000001, rate_unit: 'Lb/ac',
      cost_per_unit_cents: 0, price_per_unit_cents: 0,
    }, [1000000000000000.1, 0.2]);

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    const save = saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement;
    await clickSave(save);

    await waitFor(
      () => expect(mockRpc.mock.calls.some((c) => c[0] === 'save_job')).toBe(true),
      { timeout: 15000 },
    );
    expect(screen.queryByText(/no longer agree/i)).toBeNull();
    const saveCall = mockRpc.mock.calls.find((c) => c[0] === 'save_job');
    const args = saveCall?.[1] as { p_fields: Array<Record<string, unknown>> };
    expect(args.p_fields.map((field) => field.acres_to_treat)).toEqual([1000000000000000.1, 0.2]);
  }, 30000);

  it('SAVES the complementary upper boundary only when JobDetail passes exact acreage', async () => {
    // The lower case above kills restoration of the old Math.abs float predicate. This
    // complementary side kills a dropped exactAcres argument: the Number-collapsed field
    // total makes its exact-decimal difference 0.1000001 instead of SQL's accepted 0.1.
    mountWith({
      ...HAZARD_CHEM,
      quantity: 1000000000.1000003, unit: 'Lb', rate_per_acre: 0.000001, rate_unit: 'Lb/ac',
      cost_per_unit_cents: 0, price_per_unit_cents: 0,
    }, [1000000000000000.1, 0.2]);

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    const save = saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement;
    await clickSave(save);

    await waitFor(
      () => expect(mockRpc.mock.calls.some((c) => c[0] === 'save_job')).toBe(true),
      { timeout: 15000 },
    );
    expect(screen.queryByText(/no longer agree/i)).toBeNull();
    const saveCall = mockRpc.mock.calls.find((c) => c[0] === 'save_job');
    const args = saveCall?.[1] as { p_fields: Array<Record<string, unknown>> };
    expect(args.p_fields.map((field) => field.acres_to_treat)).toEqual([1000000000000000.1, 0.2]);
  }, 30000);

  it('REFUSES a nonblank non-finite field acreage before save_job can run', async () => {
    mountWith({
      ...HAZARD_CHEM,
      quantity: 0, unit: 'Lb', rate_per_acre: 0, rate_unit: 'Lb/ac',
      cost_per_unit_cents: 0, price_per_unit_cents: 0,
    }, '1e999');

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);

    await waitFor(() => {
      const errors = mockToast.mock.calls.filter((c) => c[0] === 'error').map((c) => String(c[1]));
      expect(errors.some((m) => /field acreage.*finite, non-negative number/i.test(m))).toBe(true);
    }, { timeout: 15000 });
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
  }, 30000);

  it('REFUSES negative field acreage before save_job can run', async () => {
    mountWith({
      ...HAZARD_CHEM,
      quantity: 0, unit: 'Lb', rate_per_acre: 0, rate_unit: 'Lb/ac',
      cost_per_unit_cents: 0, price_per_unit_cents: 0,
    }, '-1');

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'error',
        expect.stringMatching(/field acreage.*finite, non-negative number/i),
      );
    }, { timeout: 15000 });
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
  }, 30000);

  it.each([
    ['non-finite', '1e999'],
    ['negative', '-1'],
  ])('keeps %s acreage blocked after an admin confirms the expired-license override', async (_case, acres) => {
    // Reaching Assign Anyway proves the fail-closed guard remains inside performSave,
    // where the override calls directly, rather than only in the initial save handler.
    const expiredApplicator = {
      id: 'app-expired', full_name: 'Expired Applicator', role: 'applicator', is_active: true,
    };
    mountWith({
      ...HAZARD_CHEM,
      quantity: 0, unit: 'Lb', rate_per_acre: 0, rate_unit: 'Lb/ac',
      cost_per_unit_cents: 0, price_per_unit_cents: 0,
    }, acres, {
      applicator: expiredApplicator,
      license: { profile_id: expiredApplicator.id, expiry_date: '2025-01-01', is_active: true },
    });

    const applicatorSelect = await waitFor(() => {
      const found = screen.getAllByRole('combobox').find((element) => (
        Array.from((element as HTMLSelectElement).options)
          .some((option) => option.value === expiredApplicator.id)
      ));
      if (!found) throw new Error('applicator select not found');
      return found as HTMLSelectElement;
    }, { timeout: 15000 });
    fireEvent.change(applicatorSelect, { target: { value: expiredApplicator.id } });

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    const assignAnyway = await screen.findByRole('button', { name: /assign anyway/i }, { timeout: 15000 });
    fireEvent.click(assignAnyway);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'error',
        expect.stringMatching(/field acreage.*finite, non-negative number/i),
      );
    }, { timeout: 15000 });
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
  }, 30000);

  it('normalizes an intentionally blank field acreage to 0 in the save_job payload', async () => {
    mountWith({
      ...HAZARD_CHEM,
      quantity: 0, unit: 'Lb', rate_per_acre: 0, rate_unit: 'Lb/ac',
      cost_per_unit_cents: 0, price_per_unit_cents: 0,
    }, '');

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);

    await waitFor(
      () => expect(mockRpc.mock.calls.some((c) => c[0] === 'save_job')).toBe(true),
      { timeout: 15000 },
    );
    const saveCall = mockRpc.mock.calls.find((c) => c[0] === 'save_job');
    const args = saveCall?.[1] as { p_fields: Array<Record<string, unknown>> };
    expect(args.p_fields[0].acres_to_treat).toBe(0);
  }, 30000);

  /** Mount on the Locations tab with one reloaded 1.5 pt/ac / 150 pt line over 100 acres,
   *  carrying whatever `driver` the database returned, then double the acreage and move to
   *  the Chemicals tab. Returns the spinbutton values as they stand after the change. */
  async function reloadLineAndDoubleAcres(driver: 'rate' | 'qty' | null) {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        return buildChain({
          data: makeJob({
            ...HAZARD_CHEM,
            quantity: 150, unit: 'pt', rate_per_acre: 1.5, rate_unit: 'pt/ac', driver,
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

    // Move to the Chemicals tab, where the rate and quantity inputs live.
    const chemTab = screen.getAllByRole('button').find((b) => /chemical/i.test(b.textContent || ''));
    fireEvent.click(chemTab as HTMLElement);
    await waitFor(() => {
      expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(2);
    }, { timeout: 15000 });
    return () => screen.getAllByRole('spinbutton').map((el) => (el as HTMLInputElement).value);
  }

  it('a RELOADED line with NO stored driver keeps its saved quantity — and is named on screen', async () => {
    // F06 (fixed 2026-09-03 by persisting job_chemicals.driver): a row that reloads with
    // driver NULL — saved before the column existed, or written by the close-quote / recipe
    // paths — is still left untouched when the acreage changes. Guessing the driver from
    // `quantity == rate x acres` was refuted (Codex P1): applyChemEdit back-solves the rate
    // whenever a total is typed, so a HAND-ENTERED total satisfies the equality by
    // construction and would be silently rewritten. What changed: the disagreement is now
    // named on the row (the mirror of save_job's CHEM_QUANTITY_NOT_DERIVED) instead of the
    // server refusing the whole job save with no warning.
    const values = await reloadLineAndDoubleAcres(null);
    await waitFor(() => expect(values()).toContain('150'), { timeout: 15000 });
    expect(values()).not.toContain('300');
    expect(await screen.findByText(/no longer agree/i, {}, { timeout: 15000 })).toBeTruthy();
  }, 30000);

  it("a RELOADED line stored with driver 'rate' re-derives its quantity when the acreage changes", async () => {
    const values = await reloadLineAndDoubleAcres('rate');
    await waitFor(() => expect(values()).toContain('300'), { timeout: 15000 });
    expect(values()).toContain('1.5');
    expect(screen.queryByText(/no longer agree/i)).toBeNull();
  }, 30000);

  it("a RELOADED line stored with driver 'qty' holds its typed total and re-derives the rate", async () => {
    const values = await reloadLineAndDoubleAcres('qty');
    await waitFor(() => expect(values()).toContain('0.75'), { timeout: 15000 });
    expect(values()).toContain('150');
    expect(values()).not.toContain('300');
    expect(screen.queryByText(/no longer agree/i)).toBeNull();
  }, 30000);

  it("SAVES the stored driver and the re-derived quantity end to end", async () => {
    // Database driver='rate' → acreage change → the payload save_job receives carries
    // driver 'rate' and the re-derived quantity, so the next reload knows the side again.
    mountWith({ ...HAZARD_CHEM, quantity: 150, unit: 'pt', rate_per_acre: 1.5, rate_unit: 'pt/ac', driver: 'rate' });
    const locTab = await waitFor(() => {
      const b = screen.getAllByRole('button').find((x) => /^locations/i.test((x.textContent || '').trim()));
      if (!b) throw new Error('Locations tab not found');
      return b;
    }, { timeout: 15000 });
    fireEvent.click(locTab as HTMLElement);
    const acresInput = await waitFor(() => {
      const found = screen.getAllByRole('spinbutton')
        .find((el) => (el as HTMLInputElement).value === '100');
      if (!found) throw new Error('acres input not found');
      return found as HTMLInputElement;
    }, { timeout: 15000 });
    fireEvent.change(acresInput, { target: { value: '200' } });

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    const save = saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement;
    await clickSave(save);
    await waitFor(
      () => expect(mockRpc.mock.calls.some((c) => c[0] === 'save_job')).toBe(true),
      { timeout: 15000 },
    );
    const saveCall = mockRpc.mock.calls.find((c) => c[0] === 'save_job');
    const args = saveCall?.[1] as { p_chemicals: Array<Record<string, unknown>>; p_fields: Array<Record<string, unknown>> };
    expect(args.p_fields[0].acres_to_treat).toBe(200);
    expect(args.p_chemicals[0]).toMatchObject({ driver: 'rate', rate_per_acre: 1.5, quantity: 300 });
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
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
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
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    await waitFor(() => {
      expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('save_job');
    }, { timeout: 15000 });
  }, 30000);

  it('refuses NEGATIVE quantities and NEGATIVE cents instead of billing a negative line (Codex High, 2026-08-25)', async () => {
    // The decimal and safe-integer gates test grammar and precision, not SIGN, and the
    // input's HTML min="0" is advisory — a typed or pasted '-5' reaches the click handler.
    // A negative quantity times a positive price bills a NEGATIVE invoice line.
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
    fireEvent.change(qtyInput, { target: { value: '-5' } });
    expect(await screen.findByText(/quantity is negative/i, {}, { timeout: 15000 })).toBeTruthy();

    // Restore the quantity; a negative PRICE must be refused by the cents gate.
    fireEvent.change(qtyInput, { target: { value: '10' } });
    const priceInput = await waitFor(() => {
      const found = screen.getAllByRole('spinbutton')
        .find((el) => (el as HTMLInputElement).value === '150');
      if (!found) throw new Error('price input not found');
      return found as HTMLInputElement;
    }, { timeout: 15000 });
    fireEvent.change(priceInput, { target: { value: '-150' } });
    expect(await screen.findByText(/blank, negative, or not a whole number of cents/i, {}, { timeout: 15000 })).toBeTruthy();

    const saveButtons = await screen.findAllByRole('button', { name: /save/i }, { timeout: 15000 });
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
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
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
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
    await clickSave(saveButtons.find((b) => !/recipe/i.test(b.textContent || '')) as HTMLElement);
    // Wait for the MATCHING toast, not the first toast of any kind (CI-interleaving race).
    await waitFor(() => {
      const errors = mockToast.mock.calls.filter((c) => c[0] === 'error').map((c) => String(c[1]));
      expect(errors.some((m) => /its price is blank, negative, or not a whole number of cents/i.test(m))).toBe(true);
    }, { timeout: 15000 });
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

/**
 * The reserved job number is the only thing standing between the operator and a job
 * they cannot save, and its failure used to be invisible.
 *
 * `if (!error && data) setJobNumber(...)` discarded BOTH failure shapes — a raised
 * error and an empty reply — so the field simply stayed blank with no toast and no
 * Sentry event. Harmless while `next_job_number` could not fail; not harmless since
 * the F2 number-generator gate applied live on 2026-09-04, which raises
 * INSUFFICIENT_ROLE for a deactivated or out-of-role profile. That user got a blank
 * box and no way to know why.
 */
describe('JobDetail — a failed job-number reservation is explained', () => {
  beforeEach(() => {
    mockToast.mockClear();
    mockRpc.mockClear();
    mockFrom.mockReturnValue(buildChain({ data: [], error: null }));
  });

  function mountNewJob() {
    return render(
      <MemoryRouter initialEntries={['/jobs/new']}>
        <Routes><Route path="/jobs/:id" element={<JobDetail />} /></Routes>
      </MemoryRouter>,
    );
  }

  it('names the role gate when next_job_number is refused', async () => {
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'next_job_number'
        ? { data: null, error: { message: 'INSUFFICIENT_ROLE' } }
        : { data: null, error: null },
    ));

    mountNewJob();

    await waitFor(
      () => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/not permitted to start a new job/i)),
      { timeout: 15000 },
    );
  }, 30000);

  it('still explains an EMPTY reply, which carries no error at all', async () => {
    // The other half of the discarded pair. `{ data: null, error: null }` is the
    // permission-denied shape assertRpcResult exists to catch: nothing to inspect, and
    // the old truthiness test dropped it just as silently as a raised error.
    mockRpc.mockResolvedValue({ data: null, error: null });

    mountNewJob();

    await waitFor(
      () => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/Could not reserve a job number/i)),
      { timeout: 15000 },
    );
  }, 30000);
});
