import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BulkDeleteConfirmModal from './BulkDeleteConfirmModal';

describe('BulkDeleteConfirmModal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <BulkDeleteConfirmModal
        open={false}
        onClose={vi.fn()}
        count={3}
        entityName="quote"
        onConfirm={vi.fn()}
      />
    );
    // Modal renders null when open=false
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows count and plural entity name in warning', () => {
    render(
      <BulkDeleteConfirmModal
        open={true}
        onClose={vi.fn()}
        count={3}
        entityName="quote"
        onConfirm={vi.fn()}
      />
    );
    // The warning paragraph contains "3" and "quotes"
    const warning = screen.getByText(/about to delete/i);
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toContain('3');
    expect(warning.textContent).toContain('quotes');
  });

  it('shows singular entity name for count=1', () => {
    render(
      <BulkDeleteConfirmModal
        open={true}
        onClose={vi.fn()}
        count={1}
        entityName="customer"
        onConfirm={vi.fn()}
      />
    );
    const warning = screen.getByText(/about to delete/i);
    expect(warning.textContent).toContain('1');
    expect(warning.textContent).toContain('customer');
  });

  it('uses custom plural when provided', () => {
    render(
      <BulkDeleteConfirmModal
        open={true}
        onClose={vi.fn()}
        count={5}
        entityName="delivery"
        entityNamePlural="deliveries"
        actionWord="cancel"
        onConfirm={vi.fn()}
      />
    );
    const warning = screen.getByText(/about to cancel/i);
    expect(warning.textContent).toContain('deliveries');
  });

  it('calls onConfirm when confirm button clicked', () => {
    const onConfirm = vi.fn();
    render(
      <BulkDeleteConfirmModal
        open={true}
        onClose={vi.fn()}
        count={2}
        entityName="product"
        actionWord="deactivate"
        onConfirm={onConfirm}
      />
    );
    // Find the button that says "Deactivate 2 products"
    const confirmBtn = screen.getByRole('button', { name: /deactivate/i });
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when cancel button clicked', () => {
    const onClose = vi.fn();
    render(
      <BulkDeleteConfirmModal
        open={true}
        onClose={onClose}
        count={2}
        entityName="quote"
        onConfirm={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
