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
} = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockFrom = vi.fn();
  const mockToast = vi.fn();
  const mockNavigate = vi.fn();
  const mockUseParams = vi.fn();
  return { mockFrom, mockRpc, mockToast, mockNavigate, mockUseParams };
});

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T,>(data: T) => data,
  checkMutationResult: () => {},
  sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
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
  useUnsavedChanges: () => {},
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => mockUseParams(),
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>{children}</a>
  ),
}));

// SelectLocationsModal is rendered but we don't drive it in these tests
vi.mock('../components/field-app/SelectLocationsModal', () => ({
  default: () => null,
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

    fireEvent.click(postButton);
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
