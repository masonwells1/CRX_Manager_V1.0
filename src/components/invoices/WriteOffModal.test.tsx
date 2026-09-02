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

vi.mock('../../lib/db', async () => ({
  supabase: { rpc: mockRpc },
  // Real shape: throws on null/undefined, returns the value otherwise.
  assertRpcResult: (data: unknown, rpcName: string) => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data — operation may have been denied`);
    }
    return data;
  },
  // The REAL sanitizeError, never a stub. A stub shaped
  // `e instanceof Error ? e.message : …` would re-implement the defect this
  // screen was fixed for and pass against a regressed product.
  sanitizeError: (await vi.importActual<typeof import('../../lib/errorSanitizer')>(
    '../../lib/errorSanitizer',
  )).sanitizeError,
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

  // ASSERTION DELIBERATELY CHANGED (H5 follow-up). This test previously asserted
  // `stringContaining('Failed')`, which passed only because the screen was showing
  // its canned literal 'Failed to apply write-off' INSTEAD of the server's reason —
  // the test agreed with the bug, so it could never catch it. postgrest-js resolves
  // a non-throwing rpc error as a PLAIN OBJECT (PostgrestError is constructed only
  // under .throwOnError()), so `err instanceof Error` was false and the old ternary
  // discarded a refusal the database had already explained. Pin the real behaviour:
  // the server's message reaches the operator, and the literal does not.
  it('surfaces the server refusal verbatim on RPC failure, not a canned literal', async () => {
    const refusal = 'Write-off exceeds the remaining balance on this invoice. No changes were saved.';
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: refusal, details: null, hint: null, code: 'P0001' },
    });
    render(<WriteOffModal {...defaultProps} />);
    const inputs = screen.getAllByRole('spinbutton');
    fireEvent.change(inputs[0], { target: { value: '50' } });
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Reason' } });
    fireEvent.click(screen.getByRole('button', { name: /apply write-off/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', refusal);
    });
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Failed to apply write-off');
  });

  // The fix must not trade a swallowed message for a schema leak: raw PostgreSQL
  // constraint text is still redacted on its way to the operator.
  it('redacts raw constraint text instead of leaking schema identifiers', async () => {
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: {
        message: 'new row for relation "invoices" violates check constraint "invoices_balance_chk"',
        details: null,
        hint: null,
        code: '23514',
      },
    });
    render(<WriteOffModal {...defaultProps} />);
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '50' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Reason' } });
    fireEvent.click(screen.getByRole('button', { name: /apply write-off/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'The provided value is not valid');
    });
    const shown = mockToast.mock.calls.map((c) => String(c[1])).join(' | ');
    expect(shown).not.toContain('invoices_balance_chk');
    expect(shown).not.toContain('relation');
  });

  it('calls onClose when Cancel clicked', () => {
    render(<WriteOffModal {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });
});
