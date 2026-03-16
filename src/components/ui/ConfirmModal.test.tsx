import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';

describe('ConfirmModal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    title: 'Delete Item',
    message: 'Are you sure you want to delete this?',
  };

  it('renders nothing when open is false', () => {
    const { container } = render(
      <ConfirmModal {...defaultProps} open={false} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the title and message when open', () => {
    render(<ConfirmModal {...defaultProps} />);
    expect(screen.getByText('Delete Item')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to delete this?')).toBeInTheDocument();
  });

  it('renders Cancel and Confirm buttons', () => {
    render(<ConfirmModal {...defaultProps} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<ConfirmModal {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm when Confirm button is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('uses custom confirmLabel', () => {
    render(<ConfirmModal {...defaultProps} confirmLabel="Yes, Delete" />);
    expect(screen.getByText('Yes, Delete')).toBeInTheDocument();
  });

  it('applies danger variant styles by default', () => {
    render(<ConfirmModal {...defaultProps} />);
    const messageContainer = screen.getByText(defaultProps.message).closest('div');
    expect(messageContainer?.className).toContain('bg-red-50');
  });

  it('applies warning variant styles', () => {
    render(<ConfirmModal {...defaultProps} variant="warning" />);
    const messageContainer = screen.getByText(defaultProps.message).closest('div');
    expect(messageContainer?.className).toContain('bg-amber-50');
  });

  it('applies info variant styles', () => {
    render(<ConfirmModal {...defaultProps} variant="info" />);
    const messageContainer = screen.getByText(defaultProps.message).closest('div');
    expect(messageContainer?.className).toContain('bg-blue-50');
  });
});
