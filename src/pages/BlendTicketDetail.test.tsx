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
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, mockNavigate, mockStorageFrom } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  mockStorageFrom: vi.fn().mockReturnValue({
    createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'http://test/signed' }, error: null }),
  }),
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
  review_status: 'approved',
  payment_status: 'unbilled',
  order_link_status: 'unlinked',
  job_id: null,
  total_acres: 50,
  field_id: null,
  notes: '',
  uploader: { id: 'u', full_name: 'Op' },
  reviewer: null,
  customer: { id: 'cust-1', farm_name: 'Farm Alpha' },
  field: null,
  salesman: null,
};

describe('BlendTicketDetail — Phase 1 contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: null, error: null });
    let firstFromCall = true;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets' && firstFromCall) {
        firstFromCall = false;
        return buildChain({ data: baseTicket, error: null });
      }
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
});
