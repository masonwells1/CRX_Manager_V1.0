import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BelowCostConfirmModal from './BelowCostConfirmModal';

describe('BelowCostConfirmModal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    lines: [
      { productName: 'Atrazine 4L', price: 10.5, cost: 12.25 },
      { productName: 'Roundup PowerMax', price: 30, cost: 31.4 },
    ],
  };

  it('renders nothing when open is false', () => {
    const { container } = render(<BelowCostConfirmModal {...defaultProps} open={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists each below-cost line with formatted price and cost', () => {
    render(<BelowCostConfirmModal {...defaultProps} />);
    expect(screen.getByText('Selling below cost')).toBeInTheDocument();
    expect(
      screen.getByText('Atrazine 4L: price $10.50 is below cost $12.25')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Roundup PowerMax: price $30.00 is below cost $31.40')
    ).toBeInTheDocument();
  });

  it('disables Confirm until a non-empty reason is entered', () => {
    render(<BelowCostConfirmModal {...defaultProps} />);
    const confirm = screen.getByText('Approve Below-Cost Sale').closest('button')!;
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason (required)'), {
      target: { value: 'Price match vs co-op' },
    });
    expect(confirm).not.toBeDisabled();
  });

  it('calls onConfirm with the trimmed reason', () => {
    const onConfirm = vi.fn();
    render(<BelowCostConfirmModal {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.change(screen.getByLabelText('Reason (required)'), {
      target: { value: '  Price match vs co-op  ' },
    });
    fireEvent.click(screen.getByText('Approve Below-Cost Sale'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('Price match vs co-op');
  });

  it('calls onClose when Cancel is clicked and never onConfirm without a reason', () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<BelowCostConfirmModal {...defaultProps} onClose={onClose} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
