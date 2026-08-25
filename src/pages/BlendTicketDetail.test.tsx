/**
 * BlendTicketDetail.test.tsx — Phase 1 (2026-04-29)
 *
 * Phase 1 changed the return shape of create_invoice_from_blend_ticket from
 * a bare uuid to a jsonb object: { invoice_ids: string[], invoice_group_id: string | null }.
 * The page in src/pages/BlendTicketDetail.tsx now destructures the result and
 * navigates to invoice_ids[0]. These tests pin that contract.
 *
 * The page is large (1688 lines) and loads via a Promise.all of 8 supabase
 * queries on mount, so we use the same buildChain helper as InvoiceDetail.test.tsx
 * to make every table query resolve generically. The full E2E spec covers the
 * actual create-invoice → navigate flow with real data.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, mockNavigate, mockStorageFrom, mockCreateSignedUrl } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  mockCreateSignedUrl: vi.fn(),
  mockStorageFrom: vi.fn(),
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
  supabase: { from: mockFrom, rpc: mockRpc, storage: { from: mockStorageFrom } },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

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
vi.mock('../hooks/useOCRThresholds', () => ({ useOCRThresholds: () => ({}) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/criticalAction', () => ({
  runCriticalAction: async ({ action, setLoading }: {
    action: () => Promise<void>;
    setLoading?: (v: boolean) => void;
  }) => {
    setLoading?.(true);
    try { await action(); } finally { setLoading?.(false); }
  },
}));
vi.mock('../lib/blendMathValidator', () => ({ validateBlendMath: () => [] }));
vi.mock('../lib/dateUtils', () => ({ localToday: () => '2026-04-29' }));

import { BlendTicketDetail } from './BlendTicketDetail';

function renderTicket(id = 'tk-1') {
  return render(
    <MemoryRouter initialEntries={[`/blend-tickets/${id}`]}>
      <Routes>
        <Route path="/blend-tickets/:id" element={<BlendTicketDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const baseTicket = {
  id: 'tk-1',
  ticket_number: 'BT-2001',
  ticket_date: '2026-04-29',
  customer_id: 'cust-1',
  application_service_id: 'svc-1',
  status: 'completed',
  review_status: 'approved',
  payment_status: 'unbilled',
  order_link_status: 'unlinked',
  job_id: null,
  total_acres: 50,
  field_id: null,
  notes: '',
  updated_at: '2026-04-29T12:00:00.000Z',
  uploader: { id: 'u', full_name: 'Op' },
  reviewer: null,
  customer: { id: 'cust-1', farm_name: 'Farm Alpha' },
  field: null,
  salesman: null,
};

const baseProduct = {
  id: '11111111-1111-4111-8111-111111111111',
  blend_ticket_id: 'tk-1',
  product_id: null,
  product_name: 'Existing product',
  quantity: 1,
  unit: 'gal',
  lot_number: null,
  sequence_order: 1,
  confidence_score: 100,
  manually_corrected: true,
  rate_per_acre: 1,
  rate_per_acre_unit: 'gal/ac',
  unit_cost_cents: null,
  unit_price_cents: null,
  created_at: '2026-04-29T12:00:00.000Z',
};

const unitConversions = [
  { id: 'u-oz', unit: 'oz', factor_oz: 1, unit_type: 'liquid', notes: null },
  { id: 'u-gal', unit: 'Gal', factor_oz: 128, unit_type: 'liquid', notes: null },
  { id: 'u-lb', unit: 'Lb', factor_oz: 16, unit_type: 'dry', notes: null },
  { id: 'u-ea', unit: 'Ea', factor_oz: 1, unit_type: 'both', notes: null },
];

describe('BlendTicketDetail — Phase 1 contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: 'http://test/signed' }, error: null });
    mockStorageFrom.mockReturnValue({ createSignedUrl: mockCreateSignedUrl });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') {
        return buildChain({ data: baseTicket, error: null });
      }
      // Live `unit_conversions` is never empty, and the save guard now treats an
      // empty list as "the picker could not offer a unit". Returning [] here made
      // the default harness look like a failed fetch to every save test.
      if (table === 'unit_conversions') return buildChain({ data: unitConversions, error: null });
      return buildChain({ data: [], error: null });
    });
  });

  it('renders without crashing and loads the ticket on mount', async () => {
    renderTicket();
    await waitFor(() => {
      expect(mockFrom).toHaveBeenCalledWith('blend_tickets');
    });
  });

  it('queries blend_ticket_products and customers to populate the form', async () => {
    renderTicket();
    await waitFor(() => {
      const tablesQueried = mockFrom.mock.calls.map((c) => c[0] as string);
      expect(tablesQueried).toContain('blend_ticket_products');
      expect(tablesQueried).toContain('customers');
    });
  });

  it('queries the application_services table on load (Phase 1 picker source)', async () => {
    renderTicket();
    await waitFor(() => {
      const tablesQueried = mockFrom.mock.calls.map((c) => c[0] as string);
      expect(tablesQueried).toContain('application_services');
    });
  });

  it('uses the current catalog form, grandfathers saved odd units, and updates the row', async () => {
    const savedProduct = {
      ...baseProduct,
      product_id: 'p1',
      product_name: 'Roundup PowerMax',
      unit: 'Legacy jug',
      rate_per_acre_unit: 'Legacy dose/ac',
      product: { id: 'p1', product_form: 'dry', is_active: true },
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: baseTicket, error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [savedProduct], error: null });
      if (table === 'products') {
        return buildChain({
          data: [{
            id: 'p1',
            product_name: 'Roundup PowerMax',
            product_form: 'liquid',
            rate_unit: 'oz',
            is_active: true,
          }],
          error: null,
        });
      }
      if (table === 'unit_conversions') return buildChain({ data: unitConversions, error: null });
      return buildChain({ data: [], error: null });
    });

    renderTicket();
    const quantityUnit = await screen.findByRole('combobox', {
      name: 'Quantity unit for Roundup PowerMax',
    }) as HTMLSelectElement;
    const rateUnit = screen.getByRole('combobox', {
      name: 'Rate unit per acre for Roundup PowerMax',
    }) as HTMLSelectElement;

    expect(quantityUnit).toHaveValue('Legacy jug');
    expect(rateUnit).toHaveValue('Legacy dose/ac');
    expect(Array.from(quantityUnit.options, (option) => option.value)).toEqual([
      '', 'Legacy jug', 'oz', 'Gal', 'Ea',
    ]);
    expect(Array.from(quantityUnit.options, (option) => option.value)).not.toContain('Lb');

    fireEvent.change(rateUnit, { target: { value: 'oz' } });
    expect(rateUnit).toHaveValue('oz');
  });

  // Switching the unit fields from free text to a picker made a failed unit load
  // unrecoverable: the list is empty, so the only option is the disabled '--' and
  // the operator cannot type a unit the way they used to. The failure has to be
  // visible, and it must not be able to ride through into a saved ticket.
  it('toasts a failed unit_conversions load and blocks a save that left a unit blank', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: baseTicket, error: null });
      if (table === 'unit_conversions') {
        return buildChain({ data: null, error: { message: 'connection lost' } });
      }
      return buildChain({ data: [], error: null });
    });

    renderTicket();
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/Unit list could not be loaded/i));
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Add Product' }));
    fireEvent.change(await screen.findByPlaceholderText('Lot #'), {
      target: { value: 'LOT-NO-UNITS' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/a unit is still blank/i));
    });
    expect(mockRpc.mock.calls.find(([name]) => name === 'save_blend_ticket')).toBeUndefined();
  });

  it('does not surface a load error when the ticket payload is well-formed', async () => {
    renderTicket();
    await waitFor(() => {
      expect(mockFrom).toHaveBeenCalledWith('blend_tickets');
    });
    // Give async effects a chance to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringMatching(/failed to load/i));
  });

  it('toasts an error and does not crash when the ticket fetch fails', async () => {
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) =>
      table === 'blend_tickets'
        ? buildChain({ data: null, error: { message: 'boom' } })
        : buildChain({ data: [], error: null }),
    );
    renderTicket();
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/failed to load/i));
    });
  });

  it('keeps a newly added product local and sends it in the versioned Save snapshot', async () => {
    renderTicket();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Product' }));
    fireEvent.change(await screen.findByPlaceholderText('Lot #'), {
      target: { value: 'LOT-LOCAL-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      const saveCall = mockRpc.mock.calls.find(([name]) => name === 'save_blend_ticket');
      expect(saveCall).toBeDefined();
      expect(saveCall?.[1]).toMatchObject({
        p_ticket_id: 'tk-1',
        p_ticket_payload: { _expected_updated_at: '2026-04-29T12:00:00.000Z' },
        p_products: [expect.objectContaining({
          id: expect.any(String),
          lot_number: 'LOT-LOCAL-1',
          sequence_order: 1,
        })],
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create App Record' })).toBeEnabled();
    });
  });

  it('keeps a removal local and omits the row from the versioned Save snapshot', async () => {
    let ticketLoads = 0;
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') {
        ticketLoads += 1;
        return buildChain({ data: baseTicket, error: null });
      }
      if (table === 'blend_ticket_products') {
        return buildChain({ data: ticketLoads <= 1 ? [baseProduct] : [], error: null });
      }
      return buildChain({ data: [], error: null });
    });

    renderTicket();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove product' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      const saveCall = mockRpc.mock.calls.find(([name]) => name === 'save_blend_ticket');
      expect(saveCall).toBeDefined();
      expect(saveCall?.[1]).toMatchObject({
        p_ticket_id: 'tk-1',
        p_ticket_payload: { _expected_updated_at: '2026-04-29T12:00:00.000Z' },
        p_products: [],
      });
    });
  });

  it('blocks approval after a local product removal until the snapshot is saved', async () => {
    const unreviewedTicket = { ...baseTicket, review_status: 'unreviewed' };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: unreviewedTicket, error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [baseProduct], error: null });
      return buildChain({ data: [], error: null });
    });

    renderTicket();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove product' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    });
    expect(mockRpc.mock.calls.some(([name]) => name === 'batch_approve_blend_tickets')).toBe(false);
  });

  it('blocks application-record creation while a local product edit is unsaved', async () => {
    renderTicket();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Product' }));
    fireEvent.change(await screen.findByPlaceholderText('Lot #'), {
      target: { value: 'UNSAVED-LEGAL-SNAPSHOT' },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create App Record' })).toBeDisabled();
    });
    expect(mockRpc.mock.calls.some(([name]) => name === 'create_application_record_from_blend_ticket')).toBe(false);
  });

  it('persists removal of the final application field and blocks approval until saved', async () => {
    const unreviewedTicket = { ...baseTicket, review_status: 'unreviewed' };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: unreviewedTicket, error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [baseProduct], error: null });
      if (table === 'blend_ticket_fields') {
        return buildChain({
          data: [{ field_id: 'field-1', customer_id: 'cust-1', planned_acres: 50, sort_order: 1 }],
          error: null,
        });
      }
      if (table === 'fields') {
        return buildChain({ data: [{ id: 'field-1', field_name: 'North 50', customer_id: 'cust-1' }], error: null });
      }
      return buildChain({ data: [], error: null });
    });

    renderTicket();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove application field' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Fields' }));

    await waitFor(() => {
      const fieldSave = mockRpc.mock.calls.find(([name]) => name === 'save_blend_ticket_fields');
      expect(fieldSave?.[1]).toMatchObject({
        p_blend_ticket_id: 'tk-1',
        p_fields: [],
      });
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    });
  });

  it('disables every editor control while Save and its hydration are in flight', async () => {
    let resolveSave!: (value: { data: unknown; error: null }) => void;
    const pendingSave = new Promise<{ data: unknown; error: null }>((resolve) => {
      resolveSave = resolve;
    });
    mockRpc.mockImplementation((name: string) => name === 'save_blend_ticket'
      ? pendingSave
      : Promise.resolve({ data: null, error: null }));

    renderTicket();
    fireEvent.click(await screen.findByRole('button', { name: 'Add Product' }));
    const lotInput = await screen.findByPlaceholderText('Lot #');
    fireEvent.change(lotInput, { target: { value: 'BEFORE-SAVE' } });
    const saveButton = screen.getByRole('button', { name: 'Save Changes' });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(lotInput).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Add Product' })).toBeDisabled();
      expect(saveButton).toBeDisabled();
    });

    resolveSave({ data: { success: true }, error: null });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Create App Record' })).toBeEnabled();
    });
  });

  it('disables application-field edits while Save Fields is in flight', async () => {
    const unreviewedTicket = { ...baseTicket, review_status: 'unreviewed' };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: unreviewedTicket, error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [baseProduct], error: null });
      if (table === 'blend_ticket_fields') {
        return buildChain({
          data: [{ field_id: 'field-1', customer_id: 'cust-1', planned_acres: 50, sort_order: 1 }],
          error: null,
        });
      }
      if (table === 'fields') {
        return buildChain({ data: [{ id: 'field-1', field_name: 'North 50', customer_id: 'cust-1' }], error: null });
      }
      return buildChain({ data: [], error: null });
    });
    let resolveFieldSave!: (value: { data: unknown; error: null }) => void;
    const pendingFieldSave = new Promise<{ data: unknown; error: null }>((resolve) => {
      resolveFieldSave = resolve;
    });
    mockRpc.mockImplementation((name: string) => name === 'save_blend_ticket_fields'
      ? pendingFieldSave
      : Promise.resolve({ data: null, error: null }));

    renderTicket();
    const acresInputs = await screen.findAllByDisplayValue('50');
    const acresInput = acresInputs[acresInputs.length - 1];
    fireEvent.change(acresInput, { target: { value: '55' } });
    const fieldSaveButton = await screen.findByRole('button', { name: 'Save Fields' });
    fireEvent.click(fieldSaveButton);

    await waitFor(() => {
      expect(acresInput).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Add Field' })).toBeDisabled();
      expect(fieldSaveButton).toBeDisabled();
    });

    resolveFieldSave({ data: { success: true }, error: null });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    });
  });

  it('preserves the prior field snapshot when a post-Save field refetch fails', async () => {
    let fieldLoads = 0;
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: baseTicket, error: null });
      if (table === 'blend_ticket_fields') {
        fieldLoads += 1;
        return fieldLoads === 1
          ? buildChain({ data: [{ field_id: 'field-1', customer_id: 'cust-1', planned_acres: 50, sort_order: 1 }], error: null })
          : buildChain({ data: null, error: { message: 'field hydration failed' } });
      }
      if (table === 'fields') {
        return buildChain({ data: [{ id: 'field-1', field_name: 'North 50', customer_id: 'cust-1' }], error: null });
      }
      if (table === 'unit_conversions') return buildChain({ data: unitConversions, error: null });
      return buildChain({ data: [], error: null });
    });

    renderTicket();
    expect(await screen.findByText(/Total planned: 50 acres/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add Product' }));
    const saveButton = screen.getByRole('button', { name: 'Save Changes' });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/failed to load blend ticket/i));
      expect(screen.getByText(/Total planned: 50 acres/)).toBeInTheDocument();
      expect(screen.getByDisplayValue('North 50')).toBeDisabled();
    });
  });

  it('does not resubmit a stale no-change snapshot when post-Save hydration fails', async () => {
    let ticketLoads = 0;
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') {
        ticketLoads += 1;
        return ticketLoads === 1
          ? buildChain({ data: baseTicket, error: null })
          : buildChain({ data: null, error: { message: 'ticket hydration failed' } });
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((name: string) => name === 'save_blend_ticket'
      ? Promise.resolve({ data: { success: true }, error: null })
      : Promise.resolve({ data: null, error: null }));

    renderTicket();
    const driverInput = await screen.findByPlaceholderText('Enter driver name');
    fireEvent.change(driverInput, { target: { value: 'Saved Driver' } });
    const saveButton = screen.getByRole('button', { name: 'Save Changes' });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/failed to load blend ticket/i));
      expect(saveButton).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Create App Record' })).toBeDisabled();
    });
    expect(mockRpc.mock.calls.filter(([name]) => name === 'save_blend_ticket')).toHaveLength(1);

    fireEvent.click(saveButton);
    fireEvent.click(screen.getByRole('button', { name: 'Create App Record' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'save_blend_ticket')).toHaveLength(1);
    expect(mockRpc.mock.calls.some(([name]) => name === 'create_application_record_from_blend_ticket')).toBe(false);
  });

  it('locks header and product editing after an application record exists', async () => {
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: baseTicket, error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [baseProduct], error: null });
      if (table === 'application_records') return buildChain({ data: [{ id: 'app-record-1' }], error: null });
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    expect(await screen.findByPlaceholderText('Enter driver name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Product' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove product' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
    expect(mockFrom).toHaveBeenCalledWith('application_records');
    expect(mockRpc.mock.calls.some(([name]) => name === 'save_blend_ticket')).toBe(false);
  });

  it('locks header, product, fields, and Save for an unbilled unlinked ticket with an active invoice', async () => {
    const unreviewedTicket = { ...baseTicket, review_status: 'unreviewed' };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: unreviewedTicket, error: null });
      if (table === 'invoices') return buildChain({ data: [{ id: 'invoice-1' }], error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [baseProduct], error: null });
      if (table === 'blend_ticket_fields') {
        return buildChain({
          data: [{ field_id: 'field-1', customer_id: 'cust-1', planned_acres: 50, sort_order: 1 }],
          error: null,
        });
      }
      if (table === 'fields') {
        return buildChain({ data: [{ id: 'field-1', field_name: 'North 50', customer_id: 'cust-1' }], error: null });
      }
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    const acresInputs = await screen.findAllByDisplayValue('50');
    const fieldAcresInput = acresInputs[acresInputs.length - 1];
    expect(screen.getByPlaceholderText('Enter driver name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Product' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove product' })).toBeDisabled();
    expect(screen.getByDisplayValue('North 50')).toBeDisabled();
    expect(fieldAcresInput).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Field' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove application field' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

    fireEvent.change(fieldAcresInput, { target: { value: '55' } });
    expect(screen.queryByRole('button', { name: 'Save Fields' })).not.toBeInTheDocument();
    expect(mockRpc.mock.calls.some(([name]) => name === 'save_blend_ticket_fields')).toBe(false);
  });

  it('locks application-field controls when an application record exists', async () => {
    const unreviewedTicket = { ...baseTicket, review_status: 'unreviewed' };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: unreviewedTicket, error: null });
      if (table === 'application_records') return buildChain({ data: [{ id: 'app-record-1' }], error: null });
      if (table === 'blend_ticket_fields') {
        return buildChain({
          data: [{ field_id: 'field-1', customer_id: 'cust-1', planned_acres: 50, sort_order: 1 }],
          error: null,
        });
      }
      if (table === 'fields') {
        return buildChain({ data: [{ id: 'field-1', field_name: 'North 50', customer_id: 'cust-1' }], error: null });
      }
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    expect(await screen.findByDisplayValue('North 50')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Field' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove application field' })).toBeDisabled();
  });

  it('locks existing application fields immediately after creating an application record', async () => {
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: baseTicket, error: null });
      if (table === 'blend_ticket_fields') {
        return buildChain({
          data: [{ field_id: 'field-1', customer_id: 'cust-1', planned_acres: 50, sort_order: 1 }],
          error: null,
        });
      }
      if (table === 'fields') {
        return buildChain({ data: [{ id: 'field-1', field_name: 'North 50', customer_id: 'cust-1' }], error: null });
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((name: string) => name === 'create_application_record_from_blend_ticket'
      ? Promise.resolve({ data: { success: true }, error: null })
      : Promise.resolve({ data: null, error: null }));

    renderTicket();

    const fieldSelect = await screen.findByDisplayValue('North 50');
    expect(fieldSelect).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Create App Record' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create Record' }));

    await waitFor(() => {
      expect(fieldSelect).toBeDisabled();
      expect(mockRpc.mock.calls.some(([name]) => name === 'create_application_record_from_blend_ticket')).toBe(true);
    });
    fireEvent.change(fieldSelect, { target: { value: '' } });
    expect(screen.queryByRole('button', { name: 'Save Fields' })).not.toBeInTheDocument();
  });

  it('keeps application fields editable for a linked-only ticket with no downstream record', async () => {
    const linkedOnlyTicket = {
      ...baseTicket,
      review_status: 'unreviewed',
      order_link_status: 'linked',
      payment_status: 'unbilled',
    };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: linkedOnlyTicket, error: null });
      if (table === 'blend_ticket_fields') {
        return buildChain({
          data: [{ field_id: 'field-1', customer_id: 'cust-1', planned_acres: 50, sort_order: 1 }],
          error: null,
        });
      }
      if (table === 'fields') {
        return buildChain({ data: [{ id: 'field-1', field_name: 'North 50', customer_id: 'cust-1' }], error: null });
      }
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    const acresInputs = await screen.findAllByDisplayValue('50');
    const fieldAcresInput = acresInputs[acresInputs.length - 1];
    expect(screen.getByDisplayValue('North 50')).toBeEnabled();
    expect(fieldAcresInput).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add Field' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove application field' })).toBeEnabled();

    fireEvent.change(fieldAcresInput, { target: { value: '55' } });
    const saveFieldsButton = await screen.findByRole('button', { name: 'Save Fields' });
    expect(saveFieldsButton).toBeEnabled();
    fireEvent.click(saveFieldsButton);

    await waitFor(() => {
      expect(mockRpc.mock.calls.some(([name]) => name === 'save_blend_ticket_fields')).toBe(true);
    });
  });

  it('blocks link and create-order actions for an unbilled unlinked ticket with an active invoice', async () => {
    const matchedProduct = {
      ...baseProduct,
      product_id: 'prod-1',
      product: { id: 'prod-1', is_active: true },
    };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: baseTicket, error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [matchedProduct], error: null });
      if (table === 'invoices') return buildChain({ data: [{ id: 'invoice-1' }], error: null });
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    expect(await screen.findByText('This blend ticket has an active invoice. Void or cancel that invoice before creating or linking an order.')).toBeInTheDocument();
    const linkButton = screen.getByRole('button', { name: 'Link to Existing Order' });
    const createOrderButton = screen.getByRole('button', { name: 'Create Order from Ticket' });
    expect(linkButton).toBeDisabled();
    expect(createOrderButton).toBeDisabled();

    fireEvent.click(linkButton);
    fireEvent.click(createOrderButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRpc.mock.calls.some(([name]) => name === 'link_blend_ticket_to_order')).toBe(false);
    expect(mockRpc.mock.calls.some(([name]) => name === 'create_order_from_blend_ticket')).toBe(false);
  });

  it('blocks unlink for an unbilled linked ticket with an active invoice', async () => {
    const linkedTicket = { ...baseTicket, order_link_status: 'linked', payment_status: 'unbilled' };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: linkedTicket, error: null });
      if (table === 'invoices') return buildChain({ data: [{ id: 'invoice-1' }], error: null });
      if (table === 'blend_ticket_to_order_items') {
        return buildChain({
          data: [{
            id: 'link-1',
            blend_ticket_id: 'tk-1',
            order_id: 'order-1',
            order_item_id: 'item-1',
            quantity_applied: 1,
            order: {
              id: 'order-1',
              order_number: 'ORD-1',
              status: 'confirmed',
              customer_id: 'cust-1',
              total_price: 1,
            },
          }],
          error: null,
        });
      }
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    const unlinkButton = await screen.findByRole('button', { name: 'Unlink from Order' });
    expect(unlinkButton).toBeDisabled();
    expect(unlinkButton).toHaveAttribute('title', 'Active invoices must be voided or cancelled before unlinking');
    fireEvent.click(unlinkButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRpc.mock.calls.some(([name]) => name === 'unlink_blend_ticket_from_order')).toBe(false);
  });

  it('keeps the ticket usable when one image cannot be signed', async () => {
    const images = [
      { id: 'image-1', storage_path: 'tk-1/1.jpg', image_url: 'legacy-1', upload_order: 1 },
      { id: 'image-2', storage_path: 'tk-1/2.jpg', image_url: 'legacy-2', upload_order: 2 },
    ];
    mockCreateSignedUrl
      .mockResolvedValueOnce({ data: null, error: { message: 'temporary storage error' } })
      .mockResolvedValueOnce({ data: { signedUrl: 'http://test/signed-2' }, error: null });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: baseTicket, error: null });
      if (table === 'blend_ticket_images') return buildChain({ data: images, error: null });
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    expect(await screen.findByText('Image temporarily unavailable. Reload to try again.'))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'BT-2001' })).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith(
      'warning',
      '1 ticket image could not be loaded. The rest of the ticket is still available.',
    );
    expect(screen.getByAltText('Ticket 2')).toHaveAttribute('src', 'http://test/signed-2');
  });

  it('blocks unlink for a linked ticket with an application record', async () => {
    const linkedTicket = { ...baseTicket, order_link_status: 'linked', payment_status: 'unbilled' };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: linkedTicket, error: null });
      if (table === 'application_records') return buildChain({ data: [{ id: 'app-1' }], error: null });
      if (table === 'blend_ticket_to_order_items') {
        return buildChain({
          data: [{
            id: 'link-1',
            blend_ticket_id: 'tk-1',
            order_id: 'order-1',
            order_item_id: 'item-1',
            quantity_applied: 1,
            order: {
              id: 'order-1',
              order_number: 'ORD-1',
              status: 'confirmed',
              customer_id: 'cust-1',
              total_price: 1,
            },
          }],
          error: null,
        });
      }
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    const unlinkButton = await screen.findByRole('button', { name: 'Unlink from Order' });
    expect(unlinkButton).toBeDisabled();
    expect(unlinkButton).toHaveAttribute(
      'title',
      'Application records must be reversed or removed before unlinking',
    );
    fireEvent.click(unlinkButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRpc.mock.calls.some(([name]) => name === 'unlink_blend_ticket_from_order')).toBe(false);
  });

  it('blocks direct invoice creation for a linked unbilled ticket', async () => {
    const linkedTicket = { ...baseTicket, order_link_status: 'linked', payment_status: 'unbilled' };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: linkedTicket, error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [baseProduct], error: null });
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    expect(await screen.findByText('This blend ticket is linked to a sales order. Bill through the order path instead of creating a direct invoice.')).toBeInTheDocument();
    const createInvoiceButton = screen.getByRole('button', { name: 'Create Invoice' });
    expect(createInvoiceButton).toBeDisabled();
    fireEvent.click(createInvoiceButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRpc.mock.calls.some(([name]) => name === 'create_invoice_from_blend_ticket')).toBe(false);
  });

  it('blocks duplicate direct invoice creation when payment status is stale unbilled', async () => {
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: baseTicket, error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [baseProduct], error: null });
      if (table === 'invoices') return buildChain({ data: [{ id: 'invoice-1' }], error: null });
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    expect(await screen.findByText('This blend ticket already has an active invoice. Void or cancel it before creating another invoice.')).toBeInTheDocument();
    const createInvoiceButton = screen.getByRole('button', { name: 'Create Invoice' });
    expect(createInvoiceButton).toBeDisabled();
    fireEvent.click(createInvoiceButton);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockRpc.mock.calls.some(([name]) => name === 'create_invoice_from_blend_ticket')).toBe(false);
  });

  it('locks header, product, and application-field editing for a billed ticket when invoice SELECT is RLS-empty', async () => {
    const billedUnlinkedTicket = {
      ...baseTicket,
      payment_status: 'billed',
      order_link_status: 'unlinked',
    };
    mockFrom.mockReset();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return buildChain({ data: billedUnlinkedTicket, error: null });
      if (table === 'blend_ticket_products') return buildChain({ data: [baseProduct], error: null });
      if (table === 'blend_ticket_fields') {
        return buildChain({
          data: [{ field_id: 'field-1', customer_id: 'cust-1', planned_acres: 50, sort_order: 1 }],
          error: null,
        });
      }
      if (table === 'fields') {
        return buildChain({ data: [{ id: 'field-1', field_name: 'North 50', customer_id: 'cust-1' }], error: null });
      }
      // Models a sales rep whose invoice SELECT is filtered by RLS even though
      // the server-maintained ticket payment status is already billed.
      if (table === 'invoices') return buildChain({ data: [], error: null });
      return buildChain({ data: [], error: null });
    });

    renderTicket();

    expect(await screen.findByPlaceholderText('Enter driver name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add Product' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove product' })).toBeDisabled();
    expect(screen.getByDisplayValue('North 50')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();

    // The content lock is deliberately scoped: sanctioned non-editor actions
    // remain available instead of disabling the entire page.
    expect(screen.getByRole('button', { name: 'Create App Record' })).toBeEnabled();
    expect(mockRpc.mock.calls.some(([name]) => name === 'save_blend_ticket')).toBe(false);
  });
});
