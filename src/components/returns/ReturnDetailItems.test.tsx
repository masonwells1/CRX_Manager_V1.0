import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReturnDetailItems } from './ReturnDetailItems';

describe('ReturnDetailItems', () => {
  it('renders the same no-return Product policy in phone cards and desktop table markup', () => {
    render(<ReturnDetailItems
      formatCents={(value) => `$${(value / 100).toFixed(2)}`}
      items={[{ id: 'return-item-1', product_name: 'Same Name', quantity: 2, unit: 'gal', condition: 'unopened', extended_cents: 2500, restock: true, restocked: false, product: { id: 'aaaaaaaa-1111-2222-3333-444444444444', product_name: 'Same Name', sku: null, return_policy: 'no_return' } }]}
    />);

    expect(screen.getByTestId('return-detail-mobile-cards')).toHaveClass('sm:hidden');
    expect(screen.getByTestId('return-detail-desktop-table')).toHaveClass('hidden', 'sm:block');
    expect(screen.getAllByText('No return policy — the database remains the authority for every return action.')).toHaveLength(2);
    expect(screen.getAllByText('Product ID: aaaaaaaa-1111-2222-3333-444444444444')).toHaveLength(2);
    expect(screen.getAllByText('$25.00')).toHaveLength(4);
  });
});
