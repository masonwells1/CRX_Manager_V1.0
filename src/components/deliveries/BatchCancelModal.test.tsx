/**
 * BatchCancelModal.test.tsx — Tests for batch cancel delivery modal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BatchCancelModal from './BatchCancelModal';

describe('BatchCancelModal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    count: 3,
    onConfirm: vi.fn(),
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when open=true', () => {
    render(<BatchCancelModal {...defaultProps} />);
    expect(screen.getByText('Batch Cancel Deliveries')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<BatchCancelModal {...defaultProps} open={false} />);
    expect(screen.queryByText('Batch Cancel Deliveries')).not.toBeInTheDocument();
  });

  it('shows count in confirmation message', () => {
    render(<BatchCancelModal {...defaultProps} count={5} />);
    // Count is wrapped in <strong>, and "deliveries" appears in title/button too
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText(/you are about to cancel/i)).toBeInTheDocument();
  });

  it('shows singular form for count=1', () => {
    render(<BatchCancelModal {...defaultProps} count={1} />);
    expect(screen.getByText(/1 delivery/i)).toBeInTheDocument();
  });

  it('renders a textarea for cancel reason', () => {
    render(<BatchCancelModal {...defaultProps} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('calls onConfirm with reason when submitted', () => {
    render(<BatchCancelModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Customer requested' } });
    const confirmBtn = screen.getByRole('button', { name: /cancel.*deliver/i });
    fireEvent.click(confirmBtn);
    expect(defaultProps.onConfirm).toHaveBeenCalledWith('Customer requested');
  });

  it('uses default reason when textarea is empty', () => {
    render(<BatchCancelModal {...defaultProps} />);
    const confirmBtn = screen.getByRole('button', { name: /cancel.*deliver/i });
    fireEvent.click(confirmBtn);
    expect(defaultProps.onConfirm).toHaveBeenCalledWith('Batch cancelled');
  });

  it('calls onClose when cancel button is clicked', () => {
    render(<BatchCancelModal {...defaultProps} />);
    const keepBtn = screen.getByRole('button', { name: /keep/i });
    fireEvent.click(keepBtn);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables buttons when loading', () => {
    render(<BatchCancelModal {...defaultProps} loading={true} />);
    const buttons = screen.getAllByRole('button');
    // At least the confirm button should be disabled
    const confirmBtn = buttons.find(b => /cancel.*deliver/i.test(b.textContent ?? ''));
    expect(confirmBtn).toBeDisabled();
  });

  it('resets reason after confirm', () => {
    render(<BatchCancelModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Test reason' } });
    const confirmBtn = screen.getByRole('button', { name: /cancel.*deliver/i });
    fireEvent.click(confirmBtn);
    expect(textarea.value).toBe('');
  });
});
