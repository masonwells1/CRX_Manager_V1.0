import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TransactionThread from './TransactionThread';

function renderThread(props: Parameters<typeof TransactionThread>[0]) {
  return render(
    <MemoryRouter>
      <TransactionThread {...props} />
    </MemoryRouter>
  );
}

describe('TransactionThread', () => {
  it('renders nothing when only one entity exists', () => {
    const { container } = renderThread({
      orderId: '1',
      orderNumber: 'O-001',
      currentEntity: 'order',
    });
    expect(container.innerHTML).toBe('');
  });

  it('renders the full pipeline', () => {
    renderThread({
      quoteId: 'q1',
      quoteNumber: 'Q-100',
      orderId: 'o1',
      orderNumber: 'O-200',
      deliveries: [{ id: 'd1', number: 'D-300' }],
      invoices: [{ id: 'i1', number: 'INV-400' }],
      currentEntity: 'order',
      currentEntityId: 'o1',
    });
    expect(screen.getByText('Q-100')).toBeInTheDocument();
    expect(screen.getByText('O-200')).toBeInTheDocument();
    expect(screen.getByText('D-300')).toBeInTheDocument();
    expect(screen.getByText('INV-400')).toBeInTheDocument();
  });

  it('shows No quote for missing quote', () => {
    renderThread({
      orderId: 'o1',
      orderNumber: 'O-200',
      deliveries: [{ id: 'd1', number: 'D-300' }],
      currentEntity: 'order',
    });
    expect(screen.getByText('No quote')).toBeInTheDocument();
  });

  it('shows dropdown for multiple deliveries', () => {
    renderThread({
      orderId: 'o1',
      orderNumber: 'O-200',
      deliveries: [
        { id: 'd1', number: 'D-301' },
        { id: 'd2', number: 'D-302' },
        { id: 'd3', number: 'D-303' },
      ],
      invoices: [{ id: 'i1', number: 'INV-400' }],
      currentEntity: 'order',
    });
    expect(screen.getByText('3 Deliveries')).toBeInTheDocument();
  });

  it('highlights the current entity', () => {
    renderThread({
      orderId: 'o1',
      orderNumber: 'O-200',
      deliveries: [{ id: 'd1', number: 'D-300' }],
      currentEntity: 'order',
      currentEntityId: 'o1',
    });
    const orderLink = screen.getByText('O-200').closest('a');
    expect(orderLink?.className).toContain('text-crx-green');
  });

  it('links to correct detail pages', () => {
    renderThread({
      quoteId: 'q1',
      quoteNumber: 'Q-100',
      orderId: 'o1',
      orderNumber: 'O-200',
      deliveries: [{ id: 'd1', number: 'D-300' }],
      invoices: [{ id: 'i1', number: 'INV-400' }],
      currentEntity: 'order',
    });
    expect(screen.getByText('Q-100').closest('a')).toHaveAttribute('href', '/quotes/q1');
    expect(screen.getByText('O-200').closest('a')).toHaveAttribute('href', '/orders/o1');
    expect(screen.getByText('D-300').closest('a')).toHaveAttribute('href', '/deliveries/d1');
    expect(screen.getByText('INV-400').closest('a')).toHaveAttribute('href', '/invoices/i1');
  });
});
