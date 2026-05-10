/**
 * WriteOffModal.test.tsx — Tests for invoice write-off modal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WriteOffModal from './WriteOffModal';

// ── Mocks ────────────────────────────────────────────────────────────────

const { mockRpc, mockToast } = vi.hoisted(() => {
  // apply_write_off returns the write-off uuid — non-null per its RPC contract,
  // so the default mock matches the real shape (and satisfies assertRpcResult).
  const mockRpc = vi.fn().mockResolvedValue({ data: 'wo-uuid-stub', error: null });
  const mockToast = vi.fn();
  return { mockRpc, mockToast };
});

vi.mock('../../lib/db', () => ({
  supabase: { rpc: mockRpc },
  // Real shape: throws on null/undefined, returns the value otherwise.
  assertRpcResult: (data: unknown, rpcName: string) => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data — operation may have been denied`);
    }
    return data;
  },
}));

vi.mock('../../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-key-123', resetKey: vi.fn() }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1' }, role: 'admin' }),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// ── Tests ────────────────────────────────────────────────────────────────

describe('WriteOffModal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    invoiceId: 'inv-001',
    invoiceNumber: 'INV-500',
    balanceCents: 25000, // $250.00
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: 'wo-uuid-stub', error: null });
  });

  it('renders when open=true', () => {
    render(<WriteOffModal {...defaultProps} />);
    expect(screen.getByText('Write Off Balance')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<WriteOffModal {...defaultProps} open={false} />);
    expect(screen.queryByText('Write Off Balance')).not.toBeInTheDocument();
  });

  it('shows invoice number in description', () => {
    render(<WriteOffModal {...defaultProps} />);
    expect(screen.getByText('INV-500')).toBeInTheDocument();
  });

  it('shows current balance formatted', () => {
    render(<WriteOffModal {...defaultProps} />);
    expect(screen.getByText('$250.00')).toBeInTheDocument();
  });

  it('renders amount input and reason textarea', () => {
    render(<WriteOffModal {...defaultProps} />);
    expect(screen.getByText('Write-Off Amount ($)')).toBeInTheDocument();
    expect(screen.getByText('Reason *')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows error toast for zero amount', async () => {
    render(<WriteOffModal {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /apply write-off/i }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Enter a valid write-off amount');
  });

  it('shows error toast for amount exceeding balance', async () => {
    render(<WriteOffModal {...defaultProps} />);
    // Find the number input (within Input component, it renders with label)
    const inputs = screen.getAllByRole('spinbutton');
    fireEvent.change(inputs[0], { target: { value: '300' } });
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Test reason' } });
    fireEvent.click(screen.getByRole('button', { name: /apply write-off/i }));
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('cannot exceed'));
  });

  it('shows error toast for empty reason', async () => {
    render(<WriteOffModal {...defaultProps} />);
    const inputs = screen.getAllByRole('spinbutton');
    fireEvent.change(inputs[0], { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /apply write-off/i }));
    expect(mockToast).toHaveBeenCalledWith('error', 'Reason is required for write-offs');
  });

  it('calls RPC with correct params on valid submit', async () => {
    render(<WriteOffModal {...defaultProps} />);
    const inputs = screen.getAllByRole('spinbutton');
    fireEvent.change(inputs[0], { target: { value: '100' } });
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Bad debt' } });
    fireEvent.click(screen.getByRole('button', { name: /apply write-off/i }));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('apply_write_off', {
        p_invoice_id: 'inv-001',
        p_amount_cents: 10000,
        p_reason: 'Bad debt',
        p_performed_by: 'user-1',
        p_idempotency_key: 'test-key-123',
      });
    });
  });

  it('calls onClose and onSuccess after successful write-off', async () => {
    render(<WriteOffModal {...defaultProps} />);
    const inputs = screen.getAllByRole('spinbutton');
    fireEvent.change(inputs[0], { target: { value: '50' } });
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Small balance' } });
    fireEvent.click(screen.getByRole('button', { name: /apply write-off/i }));

    await waitFor(() => {
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
      expect(defaultProps.onSuccess).toHaveBeenCalledTimes(1);
      expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('Write-off'));
    });
  });

  it('shows error toast on RPC failure', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC failed' } });
    render(<WriteOffModal {...defaultProps} />);
    const inputs = screen.getAllByRole('spinbutton');
    fireEvent.change(inputs[0], { target: { value: '50' } });
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Reason' } });
    fireEvent.click(screen.getByRole('button', { name: /apply write-off/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Failed'));
    });
  });

  it('calls onClose when Cancel clicked', () => {
    render(<WriteOffModal {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });
});
