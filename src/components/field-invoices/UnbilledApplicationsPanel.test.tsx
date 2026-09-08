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

vi.mock('../../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({
    getKey: () => `transfer-key-${transferIdemState.generation}`,
    resetKey: mockResetKey,
  }),
}));

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

function queryResult(data: unknown[]) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['select', 'eq', 'is', 'order']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve({ data, error: null }));
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
    mockResetKey.mockImplementation(() => {
      transferIdemState.generation += 1;
    });
    mockSanitizeError.mockReturnValue('sanitized fallback');
    mockFrom.mockImplementation((table: string) => queryResult(table === 'jobs' ? [completedJob] : []));
  });

  it('shows receipt recovery guidance and retains the same request key across retries', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'IDEMPOTENCY_RESULT_INVALID', details: null, hint: null },
    });

    render(<UnbilledApplicationsPanel />);
    await screen.findByText('J-TRANSFER-4004');
    fireEvent.click(screen.getByRole('button', { name: 'Create Invoice' }));

    confirmCreateInvoice();
    const recoveryMessage = 'The server could not verify the invoice result. Refresh this job and confirm whether an invoice was created before trying again.';
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', recoveryMessage));
    expect(mockSanitizeError).not.toHaveBeenCalled();
    expect(mockResetKey).not.toHaveBeenCalled();

    confirmCreateInvoice();
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(2));
    const firstKey = mockRpc.mock.calls[0][1].p_idempotency_key;
    const secondKey = mockRpc.mock.calls[1][1].p_idempotency_key;
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
    expect(mockResetKey).not.toHaveBeenCalled();
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
