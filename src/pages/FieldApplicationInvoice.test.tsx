/**
 * FieldApplicationInvoice.test.tsx — Phase 1 (2026-04-29)
 *
 * Tests the contract between this page and the Phase 1 RPCs. Mock-only;
 * matrix-style behavioral tests (60/40 splits, Mode A vs B arithmetic) live
 * in the Playwright E2E spec.
 *
 * Key contracts pinned here:
 *   - save_field_app_invoice is called with the 7-arg jsonb shape (the migration
 *     added p_application_service_id between p_performed_by and p_idempotency_key).
 *   - Post button routes to post_invoice_group when invoice_group_id is set,
 *     and to post_invoice otherwise (this is the "atomic group post" wiring).
 *   - When the loaded invoice belongs to a 2+ sibling group, the blue banner
 *     listing the sibling invoices renders.
 *   - Edit is locked across the whole group when ANY sibling is in a status
 *     other than draft/unposted (the migration's group-aware lock surface).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import FieldApplicationInvoice from './FieldApplicationInvoice';

// ── Hoisted shared mocks ────────────────────────────────────────────────────
const {
  mockFrom,
  mockRpc,
  mockToast,
  mockNavigate,
  mockUseParams,
  mockUseUnsavedChanges,
  mockBlockerReset,
  mockBlockerProceed,
} = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockFrom = vi.fn();
  const mockToast = vi.fn();
  const mockNavigate = vi.fn();
  const mockUseParams = vi.fn();
  const mockUseUnsavedChanges = vi.fn();
  const mockBlockerReset = vi.fn();
  const mockBlockerProceed = vi.fn();
  return { mockFrom, mockRpc, mockToast, mockNavigate, mockUseParams, mockUseUnsavedChanges, mockBlockerReset, mockBlockerProceed };
});

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T,>(data: T) => data,
  checkMutationResult: () => {},
  sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  RpcErrorCodes: { ZERO_APPLIED_ACRES: 'ZERO_APPLIED_ACRES', ACTOR_MISMATCH: 'ACTOR_MISMATCH' },
  hasRpcCode: (err: unknown, code: string) => {
    const m = err instanceof Error ? err.message : String(err ?? '');
    return m === code || m.startsWith(`${code}:`) || m.startsWith(`${code} `);
  },
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../lib/activityLogger', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: mockUseUnsavedChanges,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => mockUseParams(),
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

// SelectLocationsModal is rendered. Most tests don't drive it; the #33 discount
// test does, so the mock exposes a button that fires onSelect with a single field
// (a real Field shape) when the modal is open. Backward compatible — tests that
// never open the modal never see the button.
vi.mock('../components/field-app/SelectLocationsModal', () => ({
  default: ({ isOpen, onSelect }: { isOpen: boolean; onSelect: (fields: unknown[]) => void }) =>
    isOpen ? (
      <button
        type="button"
        data-testid="mock-select-one-field"
        onClick={() =>
          onSelect([
            {
              id: 'field-1',
              field_name: 'North 80',
              crop_type: 'corn',
              total_acres: 40,
              measured_acres: 40,
              override_acres: null,
              customer_name: 'Farm A',
            },
          ])
        }
      >
        pick field
      </button>
    ) : null,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a chainable `from('table')` mock where every terminal call resolves
 * to { data, error }. The page calls .single() (for the invoice fetch),
 * .order() (twice — sort_order + sort_order), and .eq() (multiple), so we
 * make the chain return itself everywhere and let the leaf return the data
 * provided.
 */
function makeFromMock(perTable: Record<string, { data: unknown; error?: unknown }>) {
  return vi.fn().mockImplementation((table: string) => {
    const result = perTable[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    const term = vi.fn().mockResolvedValue({ data: result.data, error: result.error || null });
    const single = vi.fn().mockResolvedValue({
      data: Array.isArray(result.data) ? result.data[0] ?? null : result.data,
      error: result.error || null,
    });
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.is = vi.fn().mockReturnValue(chain);
    chain.not = vi.fn().mockReturnValue(chain);
    chain.or = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);
    chain.update = vi.fn().mockReturnValue(chain);
    chain.insert = vi.fn().mockReturnValue(chain);
    chain.delete = vi.fn().mockReturnValue(chain);
    chain.single = single;
    chain.maybeSingle = single;
    // The page awaits chains terminated by .order(...) (returning array data).
    // Make .order() ALSO be thenable so `await query.eq(...).order(...)` resolves.
    const thenable = (resolve: (v: { data: unknown; error: unknown }) => void) =>
      resolve({ data: result.data, error: result.error || null });
    chain.then = thenable;
    chain.term = term;
    return chain;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseParams.mockReturnValue({ id: undefined });
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockUseUnsavedChanges.mockReturnValue({
    state: 'unblocked',
    reset: mockBlockerReset,
    proceed: mockBlockerProceed,
  });
});

describe('FieldApplicationInvoice — unsaved navigation', () => {
  it('renders the shared Stay/Leave prompt and wires both blocker actions', async () => {
    mockUseUnsavedChanges.mockReturnValue({
      state: 'blocked',
      reset: mockBlockerReset,
      proceed: mockBlockerProceed,
    });
    mockFrom.mockImplementation(makeFromMock({}));

    await renderPage();

    expect(screen.getByRole('alertdialog', { name: 'Unsaved Changes' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(mockBlockerReset).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(mockBlockerProceed).toHaveBeenCalledOnce();
  });
});

async function renderPage() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<FieldApplicationInvoice />);
  });
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('FieldApplicationInvoice — new invoice (no id)', () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ id: undefined });
    mockFrom.mockImplementation(makeFromMock({}));
  });

  it('renders the New Field Application Invoice header and tabs', async () => {
    await renderPage();
    expect(screen.getByText('New Field Application Invoice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Chemicals\/Charges/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Customers$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Applied Info/i })).toBeInTheDocument();
  });

  it('shows the Save button (no Post button on a brand-new invoice)', async () => {
    await renderPage();
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Post$/i })).not.toBeInTheDocument();
  });

  it('mounts the ApplicationServicePicker dropdown (Phase 1: drives service fee)', async () => {
    await renderPage();
    expect(screen.getByText('Application Service')).toBeInTheDocument();
  });

  it('uses Net 30 by default and requires a date for Custom date', async () => {
    await renderPage();

    const terms = screen.getByLabelText('Payment Terms') as HTMLSelectElement;
    expect(terms.value).toBe('Net 30');
    expect(screen.getByRole('option', { name: 'Net 15' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Due on receipt' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Custom date…' })).toBeInTheDocument();

    fireEvent.change(terms, { target: { value: 'Custom date…' } });
    expect(screen.getByLabelText('Due Date')).toBeRequired();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Choose a custom due date before saving.');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('refuses a blank transaction date before calling the save RPC', async () => {
    await renderPage();

    const dateLabel = screen.getByText('Transaction Date');
    const dateInput = dateLabel.parentElement?.querySelector('input[type="date"]');
    expect(dateInput).toBeInstanceOf(HTMLInputElement);

    fireEvent.change(dateInput as HTMLInputElement, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(mockToast).toHaveBeenCalledWith('error', 'Choose a transaction date before saving.');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('clicking Save calls save_field_app_invoice with the 7-arg Phase 1 shape', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { invoice_ids: ['new-inv-1'], invoice_group_id: null },
      error: null,
    });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(mockRpc).toHaveBeenCalled());

    const [name, args] = mockRpc.mock.calls[0];
    expect(name).toBe('save_field_app_invoice');
    expect(args).toMatchObject({
      p_invoice_id: null,
      p_performed_by: 'user-1',
      p_application_service_id: null,
      p_idempotency_key: 'test-idem-key',
    });
    expect(args.p_invoice).toBeDefined();
    expect(Array.isArray(args.p_locations)).toBe(true);
    expect(Array.isArray(args.p_chemicals)).toBe(true);
  });

  it('disables invoice inputs while Save is in flight', async () => {
    let resolveSave!: (value: { data: { invoice_ids: string[]; invoice_group_id: null }; error: null }) => void;
    mockRpc.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    await renderPage();

    const invoiceNumberInput = screen.getByPlaceholderText('Auto-generated');
    fireEvent.change(invoiceNumberInput, { target: { value: 'FA-DRAFT' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(invoiceNumberInput).toBeDisabled());
    expect(screen.getByRole('button', { name: /^Save$/i })).toBeDisabled();

    await act(async () => {
      resolveSave({ data: { invoice_ids: ['new-inv-1'], invoice_group_id: null }, error: null });
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/invoices/field-app/new-inv-1', { replace: true }));
  });

  it('navigates to the new invoice URL after Save returns invoice_ids', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { invoice_ids: ['new-inv-1'], invoice_group_id: null },
      error: null,
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/invoices/field-app/new-inv-1', { replace: true });
    });
  });

  it('shows a group-aware success toast when Save returns a non-null invoice_group_id', async () => {
    mockRpc.mockResolvedValueOnce({
      data: { invoice_ids: ['inv-a', 'inv-b'], invoice_group_id: 'grp-1' },
      error: null,
    });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/group of 2/));
    });
  });
});

// #33 (money-lens MED #1): on a BRAND-NEW invoice the per-customer Discount Earned
// editor must capture keystrokes and carry them into update_field_app_invoice_billing
// at save. Before the fix the editor draft was keyed by invoice id (undefined on a new
// invoice), so every keystroke was silently dropped and the discount persisted as 0.
// This test drives the natural create → pick field → Preview → type discount → Save
// flow and asserts the typed discount reaches the billing RPC as non-zero cents.
describe('FieldApplicationInvoice — #33 discount on a NEW invoice reaches the billing RPC', () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ id: undefined });
    // After save, the page re-fetches the created invoice to map id -> customer_id.
    mockFrom.mockImplementation(
      makeFromMock({
        invoices: { data: [{ id: 'new-inv-1', customer_id: 'cust-A' }] },
        field_app_locations: { data: [] },
        invoice_items: { data: [] },
        invoice_shares: { data: [] },
      }),
    );
    // Route each RPC by name. derive + preview return one customer (cust-A); save
    // returns the new id; the billing RPC just succeeds.
    mockRpc.mockImplementation((name: string) => {
      if (name === 'derive_customer_shares_from_fields') {
        return Promise.resolve({
          data: {
            rows: [],
            customers: [{ customer_id: 'cust-A', customer_name: 'Farm A', is_primary: true, total_share_acres: 40, overall_split_pct: 100, tier: 1 }],
            total_applied_acres: 40,
            field_count: 1,
            fallback_used_field_ids: [],
          },
          error: null,
        });
      }
      if (name === 'preview_field_app_invoice_split') {
        return Promise.resolve({
          data: {
            per_customer: [{ customer_id: 'cust-A', customer_name: 'Farm A', is_primary: true, tier: 1, total_cents: 100000, lines: [] }],
            grand_total_cents: 100000,
            customer_count: 1,
            shares_detail: { rows: [], customers: [], total_applied_acres: 40, field_count: 1, fallback_used_field_ids: [] },
          },
          error: null,
        });
      }
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: ['new-inv-1'], invoice_group_id: null }, error: null });
      }
      // update_field_app_applied_info + update_field_app_invoice_billing
      return Promise.resolve({ data: { success: true }, error: null });
    });
  });

  it('types a discount on the new invoice Preview and it reaches update_field_app_invoice_billing (not dropped)', async () => {
    await renderPage();

    // 1) Open the locations modal and pick a field → derives shares (cust-A).
    fireEvent.click(screen.getByRole('button', { name: /Select Locations/i }));
    fireEvent.click(await screen.findByTestId('mock-select-one-field'));
    await waitFor(() =>
      expect(mockRpc.mock.calls.some((c) => c[0] === 'derive_customer_shares_from_fields')).toBe(true),
    );

    // 2) Click Preview → server-computed per-customer table renders the editable
    //    Discount Earned input for cust-A.
    fireEvent.click(screen.getByRole('button', { name: /^Preview$/i }));
    const discountInput = await screen.findByTitle(/Early-pay discount earned/i);

    // 3) Type a $25.00 discount on the brand-new invoice.
    fireEvent.change(discountInput, { target: { value: '25.00' } });

    // 4) Save → the billing RPC must receive cust-A's invoice with 2500 cents.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const billingCall = mockRpc.mock.calls.find((c) => c[0] === 'update_field_app_invoice_billing');
      expect(billingCall).toBeDefined();
      const discounts = (billingCall![1] as { p_discounts: Record<string, { amount_cents: number; date: string | null }> }).p_discounts;
      // The new invoice id maps to cust-A; the typed $25.00 must arrive as 2500 cents.
      expect(discounts['new-inv-1']).toBeDefined();
      expect(discounts['new-inv-1'].amount_cents).toBe(2500);
    });
  });

  // The transaction date decides the SEASON, and the season selects the
  // customer_application_rates row — so it changes the PRICE exactly as much as locations,
  // chemicals and the service selector do, all of which already invalidate the preview.
  // Before this guard, previewing on one side of October 1 and then moving the date across it
  // left the OLD per-acre rate on screen while save charged the new one, so the breakdown the
  // operator approves was not the one billed (Codex push-proof review, 2026-09-04).
  it('discards a rendered preview when the transaction date changes', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Select Locations/i }));
    fireEvent.click(await screen.findByTestId('mock-select-one-field'));
    await waitFor(() =>
      expect(mockRpc.mock.calls.some((c) => c[0] === 'derive_customer_shares_from_fields')).toBe(true),
    );

    // The discount input only exists while previewData is set, so it is a faithful proxy for
    // "a server-computed preview is on screen".
    fireEvent.click(screen.getByRole('button', { name: /^Preview$/i }));
    expect(await screen.findByTitle(/Early-pay discount earned/i)).toBeInTheDocument();

    const dateInput = screen.getByText('Transaction Date').parentElement?.querySelector('input[type="date"]');
    expect(dateInput).toBeInstanceOf(HTMLInputElement);
    fireEvent.change(dateInput as HTMLInputElement, { target: { value: '2026-10-01' } });

    await waitFor(() => {
      expect(screen.queryByTitle(/Early-pay discount earned/i)).not.toBeInTheDocument();
    });
  });

  it('drops a preview response that arrives after the transaction date changed', async () => {
    // The race the previous test does NOT cover: clearing previewData on a date change does
    // nothing about a Preview RPC that is ALREADY in flight. Without a version guard that
    // request resolves later and unconditionally repaints a breakdown priced for the OLD date
    // — across the Oct 1 season boundary, a different per-acre rate than save will use.
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /Select Locations/i }));
    fireEvent.click(await screen.findByTestId('mock-select-one-field'));
    await waitFor(() =>
      expect(mockRpc.mock.calls.some((c) => c[0] === 'derive_customer_shares_from_fields')).toBe(true),
    );

    // Hold the preview RPC open; every other RPC keeps the shared routing from beforeEach.
    const routeRpc = mockRpc.getMockImplementation()!;
    let resolvePreview!: (value: unknown) => void;
    mockRpc.mockImplementation((name: string, args: unknown) => {
      if (name === 'preview_field_app_invoice_split') {
        return new Promise((resolve) => {
          resolvePreview = resolve;
        });
      }
      return routeRpc(name, args);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Preview$/i }));
    await waitFor(() => expect(typeof resolvePreview).toBe('function'));
    expect(screen.queryByTitle(/Early-pay discount earned/i)).not.toBeInTheDocument();

    // Operator moves the date across the season boundary while the request is still open.
    const dateInput = screen.getByText('Transaction Date').parentElement?.querySelector('input[type="date"]');
    expect(dateInput).toBeInstanceOf(HTMLInputElement);
    fireEvent.change(dateInput as HTMLInputElement, { target: { value: '2026-10-01' } });

    // The old-date answer lands now. It must be discarded, not rendered.
    await act(async () => {
      resolvePreview({
        data: {
          per_customer: [{ customer_id: 'cust-A', customer_name: 'Farm A', is_primary: true, tier: 1, total_cents: 100000, lines: [] }],
          grand_total_cents: 100000,
          customer_count: 1,
          shares_detail: { rows: [], customers: [], total_applied_acres: 40, field_count: 1, fallback_used_field_ids: [] },
        },
        error: null,
      });
    });

    expect(screen.queryByTitle(/Early-pay discount earned/i)).not.toBeInTheDocument();
  });
});

describe('FieldApplicationInvoice — existing single invoice (no group)', () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ id: 'inv-solo' });
    mockFrom.mockImplementation(
      makeFromMock({
        invoices: {
          data: [
            {
              id: 'inv-solo',
              invoice_number: 'INV-1001',
              invoice_type: 'field_application',
              invoice_date: '2026-04-29',
              header_notes: '',
              status: 'draft',
              application_service_id: null,
              invoice_group_id: null,
              total_amount_cents: 100000,
            },
          ],
        },
        field_app_locations: { data: [] },
        invoice_items: { data: [] },
        invoice_shares: { data: [] },
      }),
    );
  });

  it('renders Post button and routes through post_invoice (NOT post_invoice_group) when no group_id', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByText(/Field Application INV-1001/)).toBeInTheDocument());

    const postButton = screen.getByRole('button', { name: /^Post$/i });
    expect(postButton).toBeInTheDocument();

    // #28: Post now opens a confirm modal first; confirm to fire the RPC.
    fireEvent.click(postButton);
    const confirmButton = await screen.findByRole('button', { name: /^Post Invoice$/i });
    fireEvent.click(confirmButton);
    await waitFor(() => {
      const calls = mockRpc.mock.calls.map((c) => c[0]);
      expect(calls).toContain('post_invoice');
      expect(calls).not.toContain('post_invoice_group');
    });
  });

  it('does not render the sibling banner on a single (ungrouped) invoice', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByText(/Field Application INV-1001/)).toBeInTheDocument());
    expect(screen.queryByText(/part of a/i)).not.toBeInTheDocument();
  });
});

describe('FieldApplicationInvoice — existing GROUP member invoice', () => {
  function setupGroup(siblingStatuses: string[]) {
    const invoiceRow = {
      id: 'inv-grp-1',
      invoice_number: 'INV-2001',
      invoice_type: 'field_application',
      invoice_date: '2026-04-29',
      header_notes: '',
      status: 'draft',
      application_service_id: 'svc-1',
      invoice_group_id: 'grp-xyz',
      total_amount_cents: 100000,
    };
    const siblings = siblingStatuses.map((s, i) => ({
      id: `inv-grp-${i + 1}`,
      invoice_number: `INV-200${i + 1}`,
      customer_id: `cust-${i + 1}`,
      customer: { farm_name: `Farm ${i + 1}` },
      total_amount_cents: 50000,
      status: s,
    }));
    mockFrom.mockImplementation(
      makeFromMock({
        invoices: { data: [invoiceRow, ...siblings] },
        field_app_locations: { data: [] },
        invoice_items: { data: [] },
        invoice_shares: { data: [] },
      }),
    );
    mockUseParams.mockReturnValue({ id: 'inv-grp-1' });
  }

  it('renders the sibling banner when the group has 2+ members', async () => {
    setupGroup(['draft', 'draft']);
    await renderPage();
    await waitFor(() => expect(screen.getByText(/part of a/i)).toBeInTheDocument());
  });

  it('Post button labels itself "Post Group (...)" and routes through post_invoice_group when group_id is set', async () => {
    setupGroup(['draft', 'draft']);
    await renderPage();
    await waitFor(() => expect(screen.getByText(/part of a/i)).toBeInTheDocument());

    const postButton = screen.getByRole('button', { name: /Post Group/i });
    fireEvent.click(postButton);
    // #28: Post now opens a confirm modal first; confirm to fire the RPC. The confirm
    // button on a group is labeled "Post Group" (the toolbar button is "Post Group (N)").
    const confirmButton = await screen.findByRole('button', { name: /^Post Group$/i });
    fireEvent.click(confirmButton);
    await waitFor(() => {
      const calls = mockRpc.mock.calls.map((c) => c[0]);
      expect(calls).toContain('post_invoice_group');
      expect(calls).not.toContain('post_invoice');
    });

    const groupCall = mockRpc.mock.calls.find((c) => c[0] === 'post_invoice_group')!;
    expect(groupCall[1]).toMatchObject({
      p_invoice_group_id: 'grp-xyz',
      p_performed_by: 'user-1',
      p_idempotency_key: 'test-idem-key',
    });
  });

  it('locks edit (no Save / Post / Delete buttons) when any sibling is posted', async () => {
    setupGroup(['draft', 'posted']);
    await renderPage();
    await waitFor(() => expect(screen.getByText(/part of a/i)).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /^Save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Post$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Post Group/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/i })).not.toBeInTheDocument();
  });
});

// #28: Unpost on the per-acre field-app editor — a posted single invoice exposes an
// Unpost button (NOT Post), and confirming it routes through the unpost_invoice RPC
// with the actor + a per-invoice idempotency key.
describe('FieldApplicationInvoice — #28 Unpost on a posted invoice', () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ id: 'inv-posted' });
    mockFrom.mockImplementation(
      makeFromMock({
        invoices: {
          data: [
            {
              id: 'inv-posted',
              invoice_number: 'INV-3001',
              invoice_type: 'field_application',
              invoice_date: '2026-04-29',
              header_notes: '',
              status: 'posted',
              application_service_id: null,
              invoice_group_id: null,
              total_amount_cents: 320000,
            },
          ],
        },
        field_app_locations: { data: [] },
        invoice_items: { data: [] },
        invoice_shares: { data: [] },
      }),
    );
  });

  it('shows Unpost (not Post) on a posted invoice and routes through unpost_invoice after confirm', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByText(/Field Application INV-3001/)).toBeInTheDocument());

    // Posted => Post button is gone, Unpost is shown.
    expect(screen.queryByRole('button', { name: /^Post$/i })).not.toBeInTheDocument();
    const unpostButton = screen.getByRole('button', { name: /^Unpost$/i });
    expect(unpostButton).toBeInTheDocument();

    mockRpc.mockResolvedValueOnce({ data: { success: true, status: 'unposted' }, error: null });

    fireEvent.click(unpostButton);
    // Confirm modal opens; the confirm button is "Unpost Invoice" (distinct from the
    // toolbar "Unpost" button).
    const confirmButton = await screen.findByRole('button', { name: /^Unpost Invoice$/i });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      const call = mockRpc.mock.calls.find((c) => c[0] === 'unpost_invoice');
      expect(call).toBeDefined();
      expect(call![1]).toMatchObject({
        p_invoice_id: 'inv-posted',
        p_performed_by: 'user-1',
      });
      expect(typeof call![1].p_idempotency_key).toBe('string');
    });
  });
});

// #29: Void on the per-acre field-app editor — Void is admin-only, requires a reason
// (the confirm button is disabled until non-empty), and routes through void_invoice
// with the actor's reason + a per-invoice idempotency key. void_invoice itself routes
// draft/unposted -> cancelled and posted -> voided; the UI is the same either way.
describe('FieldApplicationInvoice — #29 Void on a field-app invoice', () => {
  function setupInvoice(status: string, extra: Record<string, unknown> = {}) {
    mockUseParams.mockReturnValue({ id: 'inv-void' });
    mockFrom.mockImplementation(
      makeFromMock({
        invoices: {
          data: [
            {
              id: 'inv-void',
              invoice_number: 'INV-9001',
              invoice_type: 'field_application',
              job_id: null,
              blend_ticket_id: null,
              invoice_date: '2026-04-29',
              header_notes: '',
              status,
              application_service_id: null,
              invoice_group_id: null,
              total_amount_cents: 100000,
              ...extra,
            },
          ],
        },
        field_app_locations: { data: [] },
        invoice_items: { data: [] },
        invoice_shares: { data: [] },
      }),
    );
  }

  it('shows a Void button on a posted invoice and forces a reason before voiding', async () => {
    setupInvoice('posted');
    await renderPage();
    await waitFor(() => expect(screen.getByText(/Field Application INV-9001/)).toBeInTheDocument());

    const voidButton = screen.getByRole('button', { name: /^Void$/i });
    expect(voidButton).toBeInTheDocument();
    fireEvent.click(voidButton);

    // The modal opens; the confirm "Void Invoice" button is disabled until a reason
    // is entered (acceptance criterion: forced reason).
    const confirmButton = await screen.findByRole('button', { name: /^Void Invoice$/i });
    expect(confirmButton).toBeDisabled();

    const reason = screen.getByPlaceholderText(/Entered in error/i);
    fireEvent.change(reason, { target: { value: 'Duplicate bill' } });
    expect(confirmButton).not.toBeDisabled();

    mockRpc.mockResolvedValueOnce({ data: null, error: null }); // void_invoice RETURNS void
    fireEvent.click(confirmButton);

    await waitFor(() => {
      const call = mockRpc.mock.calls.find((c) => c[0] === 'void_invoice');
      expect(call).toBeDefined();
      expect(call![1]).toMatchObject({
        p_invoice_id: 'inv-void',
        p_void_reason: 'Duplicate bill',
      });
      expect(typeof call![1].p_idempotency_key).toBe('string');
    });
  });

  it('shows Void on a draft invoice (routes to cancelled via the same RPC)', async () => {
    setupInvoice('draft');
    await renderPage();
    await waitFor(() => expect(screen.getByText(/Field Application INV-9001/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Void$/i })).toBeInTheDocument();
  });

  it('does NOT show Void on an already-voided invoice (terminal)', async () => {
    setupInvoice('voided');
    await renderPage();
    await waitFor(() => expect(screen.getByText(/Field Application INV-9001/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Void$/i })).not.toBeInTheDocument();
  });

  it('does NOT show Void on an already-cancelled invoice (terminal)', async () => {
    setupInvoice('cancelled');
    await renderPage();
    await waitFor(() => expect(screen.getByText(/Field Application INV-9001/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Void$/i })).not.toBeInTheDocument();
  });
});

/**
 * F2 Branch B — make the common auto-fill case visible. applied_acres defaults to the field's
 * system acres, so the >=10% divergence flag never fires on a full-field bill. The Locations tab
 * (the default tab) now shows whether each row still bills the full field (unedited default) or
 * was changed — advisory only.
 */
describe('FieldApplicationInvoice — applied-acres "full field vs edited" display (F2)', () => {
  function setupWithLocation(appliedAcres: number) {
    mockUseParams.mockReturnValue({ id: 'inv-loc' });
    mockFrom.mockImplementation(
      makeFromMock({
        invoices: {
          data: [
            {
              id: 'inv-loc',
              invoice_number: 'INV-3001',
              invoice_type: 'field_application',
              job_id: null,
              blend_ticket_id: null,
              invoice_date: '2026-04-29',
              header_notes: '',
              status: 'draft',
              application_service_id: null,
              invoice_group_id: null,
              total_amount_cents: 100000,
            },
          ],
        },
        field_app_locations: {
          data: [
            {
              field_id: 'f1',
              map_number: 1,
              total_acres: 40,
              planted_acres: null,
              applied_acres: appliedAcres,
              crop_type: 'corn',
              wind_direction: null,
              sort_order: 0,
              // system_acres = billableAcres(override, measured, total) = 40
              field: {
                field_name: 'North 80',
                crop_type: 'corn',
                total_acres: 40,
                measured_acres: 40,
                override_acres: null,
                customer: { farm_name: 'Farm A' },
              },
            },
          ],
        },
        invoice_items: { data: [] },
        invoice_shares: { data: [] },
      }),
    );
  }

  it('shows "Full field — matches acres on file" when applied equals system (the auto-fill)', async () => {
    setupWithLocation(40); // applied == system (40)
    await renderPage();
    await waitFor(() => expect(screen.getByText('North 80')).toBeInTheDocument());
    expect(screen.getByText(/Full field/i)).toBeInTheDocument();
    expect(screen.queryByText(/Edited/i)).not.toBeInTheDocument();
  });

  it('shows "Edited (field is 40.0 ac)" when applied was changed within the divergence threshold', async () => {
    setupWithLocation(38); // 5% under system — not divergent, but edited off the full-field default
    await renderPage();
    await waitFor(() => expect(screen.getByText('North 80')).toBeInTheDocument());
    expect(screen.getByText(/Edited \(field is 40\.0 ac\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/Full field/i)).not.toBeInTheDocument();
  });
});

/**
 * Codex r13 — segregation routing: only an ENGINE-built field invoice (neither job_id
 * nor blend_ticket_id) belongs in this per-acre editor. A blend-ticket-built field
 * invoice (blend_ticket_id set, job_id NULL) has quantity lines and no
 * field_app_locations, so it must be bounced to the generic /field-invoices editor —
 * otherwise this page loads zero locations and its save raises "At least one field".
 */
describe('FieldApplicationInvoice — blend-ticket field invoice is bounced to the generic editor', () => {
  it('redirects a blend_ticket_id field invoice to /field-invoices/:id', async () => {
    mockUseParams.mockReturnValue({ id: 'inv-bt' });
    mockFrom.mockImplementation(
      makeFromMock({
        invoices: { data: { id: 'inv-bt', invoice_type: 'field_application', job_id: null, blend_ticket_id: 'blend-1' } },
      }),
    );
    await renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/field-invoices/inv-bt', { replace: true });
    });
  });
});
