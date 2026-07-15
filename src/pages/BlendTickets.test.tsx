import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const {
  mockFrom,
  mockToast,
  mockCheckMutationResult,
  selectedTicket,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  mockCheckMutationResult: vi.fn(),
  selectedTicket: {
    id: 'ticket-1',
    ticket_number: 'BT-DELETE-1',
    status: 'completed',
    review_status: 'approved',
    order_link_status: 'unlinked',
    payment_status: 'unbilled',
    ocr_confidence_score: 100,
    customer: null,
    driver_name: null,
    uploaded_by: null,
    reviewed_by: null,
    salesman_id: null,
  },
}));

type QueryChain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<{ data: unknown; error: unknown }>;

function buildChain(result: { data: unknown; error: unknown }): QueryChain {
  const self: Record<string, unknown> = {};
  for (const method of [
    'select', 'update', 'eq', 'is', 'in', 'order', 'limit',
  ]) {
    self[method] = vi.fn(() => self);
  }
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  return self as QueryChain;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: vi.fn() },
  checkMutationResult: mockCheckMutationResult,
  assertRpcResult: vi.fn((data) => data),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', profile: { id: 'admin-1' } }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useOCRProcessor', () => ({
  useOCRProcessor: () => ({ isProcessing: false, processedCount: 0 }),
}));

vi.mock('../hooks/useOCRThresholds', () => ({
  useOCRThresholds: () => ({ needs_review: 70 }),
}));

vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: () => {} }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem-1', resetKey: vi.fn() }),
}));
vi.mock('../hooks/useRowSelection', () => ({
  useRowSelection: () => ({
    selected: new Set(['ticket-1']),
    toggleSelect: vi.fn(),
    toggleAll: vi.fn(),
    clearSelection: vi.fn(),
    selectedCount: 1,
    selectedRows: [selectedTicket],
    allSelected: true,
  }),
  createCheckboxColumn: () => ({ key: 'select', header: '' }),
}));

vi.mock('../components/ui/PageHeader', () => ({
  default: ({ actions }: { actions?: ReactNode }) => <div>{actions}</div>,
}));
vi.mock('../components/ui/DataTable', () => ({ default: () => <div>ticket table</div> }));
vi.mock('../components/ui/BulkDeleteConfirmModal', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open
    ? <button onClick={onConfirm}>Confirm bulk delete</button>
    : null,
}));
vi.mock('../components/blendtickets/BulkTicketUpload', () => ({ BulkTicketUpload: () => null }));
vi.mock('../components/blendtickets/ManualTicketCreate', () => ({ ManualTicketCreate: () => null }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/errorSanitizer', () => ({
  sanitizeError: (error: unknown) => error instanceof Error ? error.message : 'Request failed',
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { BlendTickets } from './BlendTickets';

function renderPage() {
  return render(<MemoryRouter><BlendTickets /></MemoryRouter>);
}

describe('BlendTickets bulk-delete downstream guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses deletion with a friendly message when a selected ticket has an application record', async () => {
    const ticketLoad = buildChain({ data: [selectedTicket], error: null });
    const customerLoad = buildChain({ data: [], error: null });
    const applicationRecordLookup = buildChain({ data: [{ source_id: 'ticket-1' }], error: null });
    const deleteMutation = buildChain({ data: [{ id: 'ticket-1' }], error: null });
    let blendTicketCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') return customerLoad;
      if (table === 'application_records') return applicationRecordLookup;
      if (table === 'blend_tickets') {
        blendTicketCalls += 1;
        return blendTicketCalls === 1 ? ticketLoad : deleteMutation;
      }
      return buildChain({ data: [], error: null });
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Tickets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk delete' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'error',
        'Reverse the application records linked to the selected blend tickets before deleting them.',
      );
    });
    expect(applicationRecordLookup.select).toHaveBeenCalledWith('source_id');
    expect(applicationRecordLookup.eq).toHaveBeenCalledWith('source_type', 'blend_ticket');
    expect(applicationRecordLookup.in).toHaveBeenCalledWith('source_id', ['ticket-1']);
    expect(applicationRecordLookup.limit).toHaveBeenCalledWith(1);
    expect(deleteMutation.update).not.toHaveBeenCalled();
  });

  it('continues to the soft delete when no selected ticket has an application record', async () => {
    const ticketLoad = buildChain({ data: [selectedTicket], error: null });
    const customerLoad = buildChain({ data: [], error: null });
    const applicationRecordLookup = buildChain({ data: [], error: null });
    const deleteMutation = buildChain({ data: [{ id: 'ticket-1' }], error: null });
    let blendTicketCalls = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') return customerLoad;
      if (table === 'application_records') return applicationRecordLookup;
      if (table === 'blend_tickets') {
        blendTicketCalls += 1;
        if (blendTicketCalls === 1 || blendTicketCalls === 3) return ticketLoad;
        return deleteMutation;
      }
      return buildChain({ data: [], error: null });
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Tickets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk delete' }));

    await waitFor(() => {
      expect(deleteMutation.update).toHaveBeenCalledWith({ deleted_at: expect.any(String) });
      expect(mockToast).toHaveBeenCalledWith('success', 'Deleted 1 ticket(s)');
    });
    expect(mockCheckMutationResult).toHaveBeenCalledWith(
      { data: [{ id: 'ticket-1' }], error: null },
      'Delete blend tickets',
    );
  });
});
