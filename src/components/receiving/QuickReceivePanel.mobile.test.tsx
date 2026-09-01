import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import QuickReceivePanel from './QuickReceivePanel';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1' } }),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../../lib/db', () => {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.order.mockResolvedValue({ data: [], error: null });

  return {
    supabase: { from: vi.fn(() => builder), rpc: vi.fn() },
    assertRpcResult: vi.fn((value) => value),
  };
});

describe('QuickReceivePanel mobile form', () => {
  it('uses one-column phone fields, large controls, and a decimal keyboard for quantity', async () => {
    window.innerWidth = 375;
    render(
      <MemoryRouter>
        <QuickReceivePanel />
      </MemoryRouter>
    );

    expect(screen.getByTestId('quick-receive-shipment-fields')).toHaveClass('grid-cols-1', 'md:grid-cols-2');
    fireEvent.click(screen.getByRole('button', { name: 'Add Product' }));

    const quantity = await screen.findByRole('spinbutton', { name: 'Quantity received' });
    expect(quantity).toHaveAttribute('inputmode', 'decimal');
    expect(quantity).toHaveClass('min-h-11', 'w-full');
  });
});
