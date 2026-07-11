import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReceivingRecord } from '../../types';
import ReceivingLogMobileCards from './ReceivingLogMobileCards';

const record = {
  id: 'record-1',
  purchase_order_id: 'po-1',
  po_number: 'PO-2042',
  vendor: 'River Valley Supply',
  product_name: 'Atrazine 4L',
  quantity_received: 75,
  unit_size: 'gal',
  condition: 'good',
  received_at: '2026-07-11T14:30:00.000Z',
  received_by_name: 'Mason Wells',
  lot_number: 'T-1234',
  notes: null,
  photo_count: 1,
  is_non_returnable: false,
} as ReceivingRecord;

describe('ReceivingLogMobileCards', () => {
  it('renders log records as narrow cards with the receiving essentials', () => {
    window.innerWidth = 375;
    render(
      <ReceivingLogMobileCards
        records={[record]}
        canSelect={false}
        selected={new Set()}
        onToggleSelect={vi.fn()}
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByTestId('receiving-log-mobile-cards')).toHaveClass('md:hidden');
    expect(screen.getByText('Atrazine 4L')).toBeInTheDocument();
    expect(screen.getByText(/River Valley Supply/)).toBeInTheDocument();
    expect(screen.getByText('75 gal')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
