/**
 * StartDeliveryModal.test.tsx — Tests for start delivery confirmation modal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StartDeliveryModal from './StartDeliveryModal';
import type { Delivery } from '../../types';

const makeDelivery = (overrides: Partial<Delivery> = {}): Delivery =>
  ({
    id: 'del-001',
    delivery_number: 'DEL-100',
    status: 'pending',
    ...overrides,
  }) as Delivery;

const makeItems = () => [
  { id: 'item-1', product_name: 'Atrazine 4L', quantity: 10, unit_size: 'gal' },
  { id: 'item-2', product_name: 'Roundup', quantity: 5, unit_size: 'qt' },
];

describe('StartDeliveryModal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    delivery: makeDelivery(),
    items: makeItems(),
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when open=true with a delivery', () => {
    render(<StartDeliveryModal {...defaultProps} />);
    // "Start Delivery" appears in both modal title and button — use heading role
    expect(screen.getByRole('heading', { name: 'Start Delivery' })).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<StartDeliveryModal {...defaultProps} open={false} />);
    expect(screen.queryByText('Start Delivery')).not.toBeInTheDocument();
  });

  it('returns null when delivery is null', () => {
    render(
      <StartDeliveryModal {...defaultProps} delivery={null} />
    );
    // Modal renders nothing meaningful when delivery is null
    expect(screen.queryByText('Items for')).not.toBeInTheDocument();
  });

  it('shows delivery number in items heading', () => {
    render(<StartDeliveryModal {...defaultProps} />);
    expect(screen.getByText(/DEL-100/)).toBeInTheDocument();
  });

  it('renders product names', () => {
    render(<StartDeliveryModal {...defaultProps} />);
    expect(screen.getByText('Atrazine 4L')).toBeInTheDocument();
    expect(screen.getByText('Roundup')).toBeInTheDocument();
  });

  it('renders quantities and units', () => {
    render(<StartDeliveryModal {...defaultProps} />);
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows empty state when items is empty', () => {
    render(<StartDeliveryModal {...defaultProps} items={[]} />);
    expect(screen.getByText(/no items/i)).toBeInTheDocument();
  });

  it('calls onConfirm when Start Delivery clicked', () => {
    render(<StartDeliveryModal {...defaultProps} />);
    const btn = screen.getByRole('button', { name: /start delivery/i });
    fireEvent.click(btn);
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Cancel clicked', () => {
    render(<StartDeliveryModal {...defaultProps} />);
    const btn = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(btn);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows warning about verifying items', () => {
    render(<StartDeliveryModal {...defaultProps} />);
    expect(screen.getByText(/verify/i)).toBeInTheDocument();
  });
});
