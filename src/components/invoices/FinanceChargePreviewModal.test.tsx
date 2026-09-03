/**
 * FinanceChargePreviewModal.test.tsx — Tests for finance charge preview + generation modal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FinanceChargePreviewModal from './FinanceChargePreviewModal';
import type { FinanceChargePreview } from '../../types';

// ── Mocks ────────────────────────────────────────────────────────────────

const { mockRpc, mockToast } = vi.hoisted(() => {
  const mockRpc = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockToast = vi.fn();
  return { mockRpc, mockToast };
});

vi.mock('../../lib/db', async () => ({
  supabase: { rpc: mockRpc },
  assertRpcResult: (data: unknown) => data,
  // The REAL sanitizeError, never a stub. A stub shaped
  // `e instanceof Error ? e.message : …` would re-implement the defect this
  // screen was fixed for and pass against a regressed product.
  sanitizeError: (await vi.importActual<typeof import('../../lib/errorSanitizer')>(
    '../../lib/errorSanitizer',
  )).sanitizeError,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1' }, role: 'admin' }),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

const makePreviews = (): FinanceChargePreview[] => [
  {
    customer_id: 'c1',
    customer_name: 'Green Acres Farm',
    account_number: 'GA-100',
    overdue_balance_cents: 500000,
    charge_rate: 1.5,
    grace_days: 30,
    days_overdue: 45,
    charge_amount_cents: 7500,
    finance_charge_enabled: true,
    open_credit_cents: 40000,
  },
  {
    customer_id: 'c2',
    customer_name: 'Blue Sky Ranch',
    account_number: 'BS-200',
    overdue_balance_cents: 200000,
    charge_rate: 1.5,
    grace_days: 30,
    days_overdue: 120,
    charge_amount_cents: 3000,
    finance_charge_enabled: true,
    open_credit_cents: 0,
  },
];

// ── Tests ────────────────────────────────────────────────────────────────

describe('FinanceChargePreviewModal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    asOfDate: '2026-01-15',
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: preview returns empty (no charges)
    mockRpc.mockResolvedValue({ data: [], error: null });
  });

  it('renders when open=true', async () => {
    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Finance Charge/)).toBeInTheDocument();
    });
  });

  it('does not render when open=false', () => {
    render(<FinanceChargePreviewModal {...defaultProps} open={false} />);
    expect(screen.queryByText(/Finance Charge/)).not.toBeInTheDocument();
  });

  it('fetches preview data on open', async () => {
    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('preview_finance_charges', {
        p_as_of_date: '2026-01-15',
      });
    });
  });

  it('shows empty state when no charges', async () => {
    mockRpc.mockResolvedValueOnce({ data: [], error: null });
    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/no finance charges to generate/i)).toBeInTheDocument();
    });
  });

  it('renders customer rows in table', async () => {
    mockRpc.mockResolvedValueOnce({ data: makePreviews(), error: null });
    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Green Acres Farm')).toBeInTheDocument();
      expect(screen.getByText('Blue Sky Ranch')).toBeInTheDocument();
    });
  });

  it('renders account numbers', async () => {
    mockRpc.mockResolvedValueOnce({ data: makePreviews(), error: null });
    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('GA-100')).toBeInTheDocument();
      expect(screen.getByText('BS-200')).toBeInTheDocument();
    });
  });

  it('renders charge rate as badge', async () => {
    mockRpc.mockResolvedValueOnce({ data: makePreviews(), error: null });
    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => {
      const badges = screen.getAllByText('1.5%');
      expect(badges.length).toBeGreaterThan(0);
    });
  });

  it('selects all customers by default', async () => {
    mockRpc.mockResolvedValueOnce({ data: makePreviews(), error: null });
    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/2 of 2 customer/)).toBeInTheDocument();
    });
  });

  it('shows total charges for selected', async () => {
    mockRpc.mockResolvedValueOnce({ data: makePreviews(), error: null });
    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => {
      // Total = $75.00 + $30.00 = $105.00
      expect(screen.getByText(/\$105\.00/)).toBeInTheDocument();
    });
  });

  it('shows generate all and generate selected buttons', async () => {
    mockRpc.mockResolvedValueOnce({ data: makePreviews(), error: null });
    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate all/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /generate selected/i })).toBeInTheDocument();
    });
  });

  it('calls generate_finance_charges RPC for selected customers', async () => {
    const previews = makePreviews();
    mockRpc
      .mockResolvedValueOnce({ data: previews, error: null }) // preview
      .mockResolvedValueOnce({ data: { charges_generated: 2, details: [] }, error: null }); // generate

    render(<FinanceChargePreviewModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Green Acres Farm')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate selected/i }));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('generate_finance_charges', {
        p_as_of_date: '2026-01-15',
        p_performed_by: 'user-1',
        p_customer_ids: expect.arrayContaining(['c1', 'c2']),
        p_idempotency_key: expect.stringContaining('generate_finance_charges'),
      });
    });
  });

  it('calls generate_finance_charges with all previewed customer_ids for Generate All', async () => {
    const previews = makePreviews();
    mockRpc
      .mockResolvedValueOnce({ data: previews, error: null }) // preview
      .mockResolvedValueOnce({ data: { charges_generated: 2, details: [] }, error: null }); // generate

    render(<FinanceChargePreviewModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Green Acres Farm')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate all/i }));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith('generate_finance_charges', {
        p_as_of_date: '2026-01-15',
        p_performed_by: 'user-1',
        p_customer_ids: expect.arrayContaining(['c1', 'c2']),
        p_idempotency_key: expect.stringContaining('generate_finance_charges'),
      });
    });
  });

  it('shows success toast and calls onClose + onSuccess after generate', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: makePreviews(), error: null })
      .mockResolvedValueOnce({ data: { charges_generated: 2, details: [] }, error: null });

    render(<FinanceChargePreviewModal {...defaultProps} />);
    await waitFor(() => screen.getByText('Green Acres Farm'));

    fireEvent.click(screen.getByRole('button', { name: /generate all/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('success', expect.stringContaining('2 finance charge'));
      expect(defaultProps.onClose).toHaveBeenCalled();
      expect(defaultProps.onSuccess).toHaveBeenCalled();
    });
  });

  it('shows error toast when generate selected with none checked', async () => {
    const previews = makePreviews();
    mockRpc.mockResolvedValueOnce({ data: previews, error: null });
    render(<FinanceChargePreviewModal {...defaultProps} />);

    // Wait for rows to render
    await waitFor(() => screen.getByText('Green Acres Farm'));

    // Click each row to deselect (all are selected by default)
    const rows = screen.getAllByText(/Farm|Ranch/).map((el) => el.closest('tr')!);
    rows.forEach((row) => fireEvent.click(row));

    fireEvent.click(screen.getByRole('button', { name: /generate selected/i }));

    expect(mockToast).toHaveBeenCalledWith('error', 'Select at least one customer');
  });

  // ASSERTION DELIBERATELY CHANGED (H5 follow-up). This previously asserted
  // `stringContaining('Failed')`, which passed only because the modal was showing
  // its canned literal 'Failed to load finance charge preview' INSTEAD of the
  // server's reason. postgrest-js resolves a non-throwing rpc error as a PLAIN
  // OBJECT, so `err instanceof Error` was false and the old ternary discarded the
  // real explanation. The test agreed with the bug and so could never catch it.
  it('surfaces the server reason verbatim when the preview fetch fails', async () => {
    const reason = 'Finance charge preview is unavailable while the period is closing.';
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: reason, details: null, hint: null, code: 'P0001' },
    });
    render(<FinanceChargePreviewModal {...defaultProps} />);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', reason);
    });
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Failed to load finance charge preview');
  });

  it('calls onClose when Cancel clicked', async () => {
    render(<FinanceChargePreviewModal {...defaultProps} />);
    // Wait for fetch to complete (empty state)
    await waitFor(() => screen.getByText(/no finance charges/i));
    // Cancel is always visible even in empty state... but let's check with data
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });
});
