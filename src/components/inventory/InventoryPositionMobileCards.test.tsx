import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import InventoryPositionMobileCards from './InventoryPositionMobileCards';

const row = {
  id: 'inventory-1',
  product_id: 'product-1',
  product_name: 'Atrazine 4L',
  inventory_unit: 'gal',
  unit_size: null,
  location: 'Main Warehouse',
  total_on_floor: 120,
  quantity_prebooked: 145,
  net_position: -25,
};

describe('InventoryPositionMobileCards', () => {
  it('renders the phone card fields and shortfall without a wide table', () => {
    window.innerWidth = 375;
    render(
      <InventoryPositionMobileCards
        rows={[row]}
        isAdmin={false}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onViewHistory={vi.fn()}
        onReceive={vi.fn()}
        onAdjust={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByTestId('inventory-mobile-cards')).toHaveClass('md:hidden');
    expect(screen.getByText('Atrazine 4L')).toBeInTheDocument();
    expect(screen.getByText('On hand')).toBeInTheDocument();
    expect(screen.getByText('Reserved')).toBeInTheDocument();
    expect(screen.getByText('Shortfall 25')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
