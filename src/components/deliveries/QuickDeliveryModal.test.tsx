/**
 * QuickDeliveryModal.test.tsx — Tests for quick delivery creation modal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import QuickDeliveryModal from './QuickDeliveryModal';

// ── Mocks ────────────────────────────────────────────────────────────────

const { mockFrom, mockRpc, mockToast, mockNavigate } = vi.hoisted(() => {
  const mockOrder = vi.fn().mockReturnThis();
  const mockIn = vi.fn().mockReturnThis();
  const mockEq = vi.fn().mockReturnThis();
  const mockOr = vi.fn().mockReturnThis();
  const mockLimit = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockSelect = vi.fn().mockReturnValue({
    eq: mockEq,
    in: mockIn,
    or: mockOr,
    order: mockOrder,
    limit: mockLimit,
  });
  // Make chainable: eq/in/or/order all return the chain
  mockEq.mockReturnValue({ eq: mockEq, in: mockIn, or: mockOr, order: mockOrder, limit: mockLimit, select: mockSelect });
  mockIn.mockReturnValue({ eq: mockEq, in: mockIn, or: mockOr, order: mockOrder, limit: mockLimit, select: mockSelect });
  mockOr.mockReturnValue({ eq: mockEq, in: mockIn, or: mockOr, order: mockOrder, limit: mockLimit, select: mockSelect });
  mockOrder.mockReturnValue({ eq: mockEq, in: mockIn, or: mockOr, order: mockOrder, limit: mockLimit, select: mockSelect });
  // Products + drivers use .order() at the end which resolves the promise
  mockOrder.mockResolvedValue({ data: [], error: null });
  // U9: the stock lookup queries terminate in .eq() / .in() (no .order()), so they
  // need their own resolved-promise terminals or the component's Promise.all hangs.
  const mockStockEq = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockStockIn = vi.fn().mockResolvedValue({ data: [], error: null });
  const mockStockSelect = vi.fn().mockReturnValue({ eq: mockStockEq, in: mockStockIn });
  const mockFrom = vi.fn().mockImplementation((table: string) =>
    table === 'inventory' || table === 'purchase_order_items'
      ? { select: mockStockSelect }
      : { select: mockSelect });

  const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
  const mockToast = vi.fn();
  const mockNavigate = vi.fn();

  return { mockFrom, mockRpc, mockToast, mockNavigate, mockSelect, mockEq, mockOrder, mockIn, mockOr };
});

vi.mock('../../lib/db', () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
  },
  assertRpcResult: (data: unknown) => data,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin' }),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('../../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

// ── Tests ────────────────────────────────────────────────────────────────

describe('QuickDeliveryModal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onCreated: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: null, error: null });
  });

  /** Render + flush the useEffect that fetches products/drivers on mount */
  async function renderModal(props = defaultProps) {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(<QuickDeliveryModal {...props} />);
    });
    return result;
  }

  it('renders when open=true', async () => {
    await renderModal();
    expect(screen.getByText('Quick Delivery')).toBeInTheDocument();
  });

  it('does not render when open=false', async () => {
    await renderModal({ ...defaultProps, open: false });
    expect(screen.queryByText('Quick Delivery')).not.toBeInTheDocument();
  });

  it('shows warning banner about creating order + delivery + invoice', async () => {
    await renderModal();
    expect(screen.getByText(/create an order and delivery, plus a draft invoice/i)).toBeInTheDocument();
  });

  it('shows customer search input', async () => {
    await renderModal();
    expect(screen.getByPlaceholderText(/search by farm name/i)).toBeInTheDocument();
  });

  it('shows Add Product button', async () => {
    await renderModal();
    expect(screen.getByRole('button', { name: /add product/i })).toBeInTheDocument();
  });

  it('shows empty products state', async () => {
    await renderModal();
    expect(screen.getByText(/no products added yet/i)).toBeInTheDocument();
  });

  it('shows driver dropdown with Unassigned option', async () => {
    await renderModal();
    expect(screen.getByText('Driver')).toBeInTheDocument();
    const select = screen.getByDisplayValue('Unassigned');
    expect(select).toBeInTheDocument();
  });

  it('shows scheduled date input', async () => {
    await renderModal();
    expect(screen.getByText('Scheduled Date')).toBeInTheDocument();
  });

  it('shows delivery notes textarea', async () => {
    await renderModal();
    expect(screen.getByPlaceholderText(/optional notes/i)).toBeInTheDocument();
  });

  it('Create Quick Delivery button is disabled when no customer or items', async () => {
    await renderModal();
    const btn = screen.getByRole('button', { name: /create quick delivery/i });
    expect(btn).toBeDisabled();
  });

  it('submit button stays disabled without customer selection', async () => {
    await renderModal();
    const btn = screen.getByRole('button', { name: /create quick delivery/i });
    expect(btn).toBeDisabled();
  });

  it('calls onClose on Cancel button', async () => {
    await renderModal();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('fetches products and drivers when opened', async () => {
    await renderModal();
    expect(mockFrom).toHaveBeenCalledWith('products');
    // PR-07 follow-up: drivers now read from profile_public_view.
    expect(mockFrom).toHaveBeenCalledWith('profile_public_view');
  });
});
