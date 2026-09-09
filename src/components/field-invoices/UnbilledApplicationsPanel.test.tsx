import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import UnbilledApplicationsPanel from './UnbilledApplicationsPanel';

const {
  mockFrom,
  mockRpc,
  mockNavigate,
  mockToast,
  mockSanitizeError,
  mockResetKey,
  transferIdemState,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockNavigate: vi.fn(),
  mockToast: vi.fn(),
  mockSanitizeError: vi.fn(),
  mockResetKey: vi.fn(),
  transferIdemState: { generation: 0 },
}));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return {
    ...actual,
    supabase: { from: mockFrom, rpc: mockRpc },
    sanitizeError: mockSanitizeError,
  };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'profile-transfer' } }),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useIdempotencyKey', async () => {
  const { useCallback, useRef } = await vi.importActual<typeof import('react')>('react');

  return {
    useIdempotencyKey: () => {
      const keyRef = useRef<string | null>(null);
      const getKey = useCallback(() => {
        if (keyRef.current === null) {
          transferIdemState.generation += 1;
          keyRef.current = `transfer-key-${transferIdemState.generation}`;
        }
        return keyRef.current;
      }, []);
      const resetKey = useCallback(() => {
        keyRef.current = null;
        mockResetKey();
      }, []);

      return { getKey, resetKey };
    },
  };
});

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

const completedJob = {
  id: 'job-transfer',
  job_number: 'J-TRANSFER-4004',
  job_date: '2026-09-08',
  total_acres: 80,
  total_price_cents: 125000,
  customer: { farm_name: 'Safe Retry Farms' },
};

function queryResult(data: unknown[], error: unknown = null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq', 'is', 'order']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve({ data, error }));
  return chain;
}

function confirmCreateInvoice() {
  const dialog = screen.getByRole('dialog', { name: 'Create Invoice' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create Invoice' }));
}

describe('UnbilledApplicationsPanel transfer intent recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transferIdemState.generation = 0;
    mockSanitizeError.mockReturnValue('sanitized fallback');
    mockFrom.mockImplementation((table: string) => queryResult(table === 'jobs' ? [completedJob] : []));
  });

  it('allows the cutover refusal to retry immediately with the same request key', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'TRANSFER_INVOICE_INTENT_CUTOVER_RETRY', details: null, hint: null },
    });

    render(<UnbilledApplicationsPanel />);
    await screen.findByText('J-TRANSFER-4004');
    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));
    confirmCreateInvoice();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'The invoice safety update finished during this transfer. Try Transfer to Invoice again — the app will safely reuse the same request.',
    ));
    expect(mockResetKey).not.toHaveBeenCalled();

    confirmCreateInvoice();
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));
    const firstKey = mockRpc.mock.calls[0][1].p_idempotency_key;
    const secondKey = mockRpc.mock.calls[1][1].p_idempotency_key;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
    expect(mockResetKey).not.toHaveBeenCalled();
  });

  it.each([
    'TRANSFER_INVOICE_RESULT_INVALID',
    'IDEMPOTENCY_RESULT_INVALID',
  ])('refreshes the backlog before allowing a new confirmed request for %s', async (token) => {
    let jobReads = 0;
    let ticketReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'jobs') {
        jobReads += 1;
        return queryResult([completedJob]);
      }
      ticketReads += 1;
      return queryResult([]);
    });
    let transferAttempts = 0;
    mockRpc.mockImplementation(() => {
      transferAttempts += 1;
      return Promise.resolve(transferAttempts === 1
        ? { data: null, error: { code: 'P0001', message: token, details: null, hint: null } }
        : { data: { job_id: 'job-transfer', invoice_id: 'invoice-1', invoice_number: 'INV-1' }, error: null });
    });

    render(<UnbilledApplicationsPanel />);
    await screen.findByText('J-TRANSFER-4004');
    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));
    confirmCreateInvoice();

    const recoveryMessage = 'The server could not verify the invoice result. Refresh this job and confirm whether an invoice was created before trying again.';
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', recoveryMessage));
    await waitFor(() => {
      expect(jobReads).toBe(2);
      expect(ticketReads).toBe(2);
    });
    expect(screen.queryByRole('dialog', { name: 'Create Invoice' })).toBeNull();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockResetKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));
    expect(screen.getByRole('dialog', { name: 'Create Invoice' })).toBeInTheDocument();
    confirmCreateInvoice();

    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));
    const firstKey = mockRpc.mock.calls[0][1].p_idempotency_key;
    const secondKey = mockRpc.mock.calls[1][1].p_idempotency_key;
    expect(firstKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
    expect(mockResetKey).toHaveBeenCalledTimes(1);
  });

  it('removes an already-invoiced job from the backlog after invalid-result reconciliation', async () => {
    let jobReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'jobs') return queryResult([]);
      jobReads += 1;
      return queryResult(jobReads === 1 ? [completedJob] : []);
    });
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'TRANSFER_INVOICE_RESULT_INVALID', details: null, hint: null },
    });

    render(<UnbilledApplicationsPanel />);
    await screen.findByText('J-TRANSFER-4004');
    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));
    confirmCreateInvoice();

    await waitFor(() => expect(jobReads).toBe(2));
    await waitFor(() => expect(screen.queryByText('J-TRANSFER-4004')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Create Invoice' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Create Invoice' })).toBeNull();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockResetKey).not.toHaveBeenCalled();
  });

  it('keeps the job blocked until a failed reconciliation is followed by a successful refresh', async () => {
    let jobReads = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'jobs') return queryResult([]);
      jobReads += 1;
      return jobReads === 2
        ? queryResult([], { code: 'PGRST500', message: 'refresh failed' })
        : queryResult([completedJob]);
    });
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'IDEMPOTENCY_RESULT_INVALID', details: null, hint: null },
    });

    render(<UnbilledApplicationsPanel />);
    await screen.findByText('J-TRANSFER-4004');
    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));
    confirmCreateInvoice();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to load unbilled applications'));
    const createButton = await screen.findByRole('button', { name: 'Create Invoice' });
    expect(createButton).toBeDisabled();
    fireEvent.click(createButton);
    expect(screen.queryByRole('dialog', { name: 'Create Invoice' })).toBeNull();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockResetKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Invoice' })).not.toBeDisabled());
    expect(jobReads).toBe(3);
    expect(mockResetKey).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing sanitizer fallback for unrelated failures', async () => {
    const unrelatedError = { code: 'P0001', message: 'SPLIT_OVERRIDE_UNSUPPORTED' };
    mockRpc.mockResolvedValue({ data: null, error: unrelatedError });

    render(<UnbilledApplicationsPanel />);
    await screen.findByText('J-TRANSFER-4004');
    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));
    confirmCreateInvoice();

    await waitFor(() => expect(mockSanitizeError).toHaveBeenCalledWith(unrelatedError));
    expect(mockToast).toHaveBeenCalledWith('error', 'sanitized fallback');
    expect(mockResetKey).not.toHaveBeenCalled();
  });
});
