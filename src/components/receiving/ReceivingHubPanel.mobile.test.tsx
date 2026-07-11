import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReceivingHubLineCards, type POLine } from './ReceivingHubPanel';

const line: POLine = {
  po_id: 'po-1',
  po_item_id: 'line-1',
  po_number: 'PO-2042',
  vendor: 'River Valley Supply',
  expected_date: '2026-07-12',
  ordered: 100,
  received: 25,
  remaining: 75,
  unit_size: 'gal',
};

describe('ReceivingHubLineCards', () => {
  it('renders inbound PO lines as phone cards with large actions', () => {
    window.innerWidth = 375;
    render(
      <ReceivingHubLineCards
        lines={[line]}
        productName="Atrazine 4L"
        onReceive={vi.fn()}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByTestId('receiving-hub-mobile-cards')).toHaveClass('md:hidden');
    expect(screen.getByText('River Valley Supply')).toBeInTheDocument();
    expect(screen.getByText('75 remaining')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receive Atrazine 4L from River Valley Supply' })).toHaveClass('min-h-11');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
