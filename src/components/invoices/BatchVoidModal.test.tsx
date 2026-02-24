/**
 * BatchVoidModal.test.tsx — Tests for batch void invoice modal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BatchVoidModal from './BatchVoidModal';

describe('BatchVoidModal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    count: 4,
    onConfirm: vi.fn(),
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when open=true', () => {
    render(<BatchVoidModal {...defaultProps} />);
    expect(screen.getByText('Batch Void Invoices')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<BatchVoidModal {...defaultProps} open={false} />);
    expect(screen.queryByText('Batch Void Invoices')).not.toBeInTheDocument();
  });

  it('shows count in confirmation message', () => {
    render(<BatchVoidModal {...defaultProps} count={7} />);
    expect(screen.getByText(/7 invoices/i)).toBeInTheDocument();
  });

  it('shows singular form for count=1', () => {
    render(<BatchVoidModal {...defaultProps} count={1} />);
    expect(screen.getByText(/1 invoice\b/i)).toBeInTheDocument();
  });

  it('renders a textarea for void reason', () => {
    render(<BatchVoidModal {...defaultProps} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('calls onConfirm with reason when submitted', () => {
    render(<BatchVoidModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Duplicate entry' } });
    const confirmBtn = screen.getByRole('button', { name: /void.*invoice/i });
    fireEvent.click(confirmBtn);
    expect(defaultProps.onConfirm).toHaveBeenCalledWith('Duplicate entry');
  });

  it('uses default reason when textarea is empty', () => {
    render(<BatchVoidModal {...defaultProps} />);
    const confirmBtn = screen.getByRole('button', { name: /void.*invoice/i });
    fireEvent.click(confirmBtn);
    expect(defaultProps.onConfirm).toHaveBeenCalledWith('Batch voided');
  });

  it('calls onClose when cancel button is clicked', () => {
    render(<BatchVoidModal {...defaultProps} />);
    const cancelBtn = screen.getByRole('button', { name: /^cancel$/i });
    fireEvent.click(cancelBtn);
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables buttons when loading', () => {
    render(<BatchVoidModal {...defaultProps} loading={true} />);
    const confirmBtn = screen.getByRole('button', { name: /void.*invoice/i });
    expect(confirmBtn).toBeDisabled();
  });

  it('resets reason after confirm', () => {
    render(<BatchVoidModal {...defaultProps} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Test reason' } });
    const confirmBtn = screen.getByRole('button', { name: /void.*invoice/i });
    fireEvent.click(confirmBtn);
    expect(textarea.value).toBe('');
  });
});
