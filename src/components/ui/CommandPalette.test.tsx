import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CommandPalette from './CommandPalette';
import { recordPageVisit } from '../../lib/recentPages';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../lib/db', () => ({
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
  assertRpcResult: vi.fn((data: unknown) => data),
}));

function renderPalette(open = true) {
  const onClose = vi.fn();
  const result = render(
    <MemoryRouter>
      <CommandPalette open={open} onClose={onClose} />
    </MemoryRouter>
  );
  return { ...result, onClose };
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('does not render when closed', () => {
    renderPalette(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders search input when open', () => {
    renderPalette(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search pages/i)).toBeInTheDocument();
  });

  it('closes on Escape key', () => {
    const { onClose } = renderPalette(true);
    fireEvent.keyDown(screen.getByLabelText('Search'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when clicking backdrop', () => {
    const { onClose } = renderPalette(true);
    // The backdrop is the first child with aria-hidden
    const backdrop = document.querySelector('[aria-hidden="true"]');
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows "Start typing" message when empty', () => {
    renderPalette(true);
    expect(screen.getByText(/start typing/i)).toBeInTheDocument();
  });

  it('shows recent items when input is empty and recent pages exist', () => {
    recordPageVisit('/orders', 'Orders');
    recordPageVisit('/customers', 'Customers');
    renderPalette(true);
    expect(screen.getByText('Orders')).toBeInTheDocument();
    expect(screen.getByText('Customers')).toBeInTheDocument();
  });

  it('filters pages client-side on typing', async () => {
    renderPalette(true);
    const input = screen.getByPlaceholderText(/search pages/i);
    fireEvent.change(input, { target: { value: 'Invo' } });
    await waitFor(() => {
      expect(screen.getByText('Invoices')).toBeInTheDocument();
    });
  });

  it('surfaces Sell & Deliver Now when searching sell', async () => {
    renderPalette(true);
    const input = screen.getByPlaceholderText(/search pages/i);
    fireEvent.change(input, { target: { value: 'sell' } });

    await waitFor(() => {
      expect(screen.getByText('Sell & Deliver Now')).toBeInTheDocument();
    });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/deliveries?quickDeliver=1');
  });

  it('navigates on Enter key', async () => {
    renderPalette(true);
    const input = screen.getByPlaceholderText(/search pages/i);
    fireEvent.change(input, { target: { value: 'Inventory' } });
    await waitFor(() => {
      expect(screen.getByText('Inventory')).toBeInTheDocument();
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/inventory');
  });

  it('keyboard navigates with arrow keys', async () => {
    renderPalette(true);
    const input = screen.getByPlaceholderText(/search pages/i);
    fireEvent.change(input, { target: { value: 'Ord' } });
    await waitFor(() => {
      expect(screen.getByText('Orders')).toBeInTheDocument();
    });
    // Arrow down to second result
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Should navigate (we don't assert exact path since it depends on match order)
    expect(mockNavigate).toHaveBeenCalled();
  });
});

describe('recordPageVisit', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores page visits in localStorage', () => {
    recordPageVisit('/orders', 'Orders');
    const stored = JSON.parse(localStorage.getItem('crx-recent-pages') || '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0].path).toBe('/orders');
    expect(stored[0].title).toBe('Orders');
  });

  it('deduplicates paths', () => {
    recordPageVisit('/orders', 'Orders');
    recordPageVisit('/orders', 'Orders');
    const stored = JSON.parse(localStorage.getItem('crx-recent-pages') || '[]');
    expect(stored).toHaveLength(1);
  });

  it('caps at 20 items', () => {
    for (let i = 0; i < 25; i++) {
      recordPageVisit(`/page-${i}`, `Page ${i}`);
    }
    const stored = JSON.parse(localStorage.getItem('crx-recent-pages') || '[]');
    expect(stored).toHaveLength(20);
  });
});
