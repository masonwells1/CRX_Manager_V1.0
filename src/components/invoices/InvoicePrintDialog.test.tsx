/**
 * InvoicePrintDialog.test.tsx — Tests for invoice print options dialog
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InvoicePrintDialog from './InvoicePrintDialog';

describe('InvoicePrintDialog', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    invoiceType: 'field_application',
    hasShares: true,
    onPrint: vi.fn(),
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when open=true', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    expect(screen.getByText('Print Invoice')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<InvoicePrintDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Print Invoice')).not.toBeInTheDocument();
  });

  it('shows EPA checkbox always', () => {
    render(<InvoicePrintDialog {...defaultProps} invoiceType="standard" hasShares={false} />);
    expect(screen.getByText('Show EPA registration numbers')).toBeInTheDocument();
  });

  it('shows grower shares checkbox when hasShares=true', () => {
    render(<InvoicePrintDialog {...defaultProps} hasShares={true} />);
    expect(screen.getByText('Show grower shares')).toBeInTheDocument();
  });

  it('hides grower shares checkbox when hasShares=false', () => {
    render(<InvoicePrintDialog {...defaultProps} hasShares={false} />);
    expect(screen.queryByText('Show grower shares')).not.toBeInTheDocument();
  });

  it('shows price per acre checkbox for field_application type', () => {
    render(<InvoicePrintDialog {...defaultProps} invoiceType="field_application" />);
    expect(screen.getByText('Show price per acre')).toBeInTheDocument();
  });

  it('hides price per acre checkbox for non-field_application type', () => {
    render(<InvoicePrintDialog {...defaultProps} invoiceType="standard" />);
    expect(screen.queryByText('Show price per acre')).not.toBeInTheDocument();
  });

  it('calls onPrint with all options when Download PDF clicked', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(defaultProps.onPrint).toHaveBeenCalledWith({
      show_shares: true,
      show_price_per_acre: true,
      show_epa_registration: true,
    });
  });

  it('toggling checkboxes changes the options passed to onPrint', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    // Uncheck EPA checkbox
    const checkboxes = screen.getAllByRole('checkbox');
    const epaCheckbox = checkboxes[checkboxes.length - 1]; // Last one is EPA
    fireEvent.click(epaCheckbox);
    fireEvent.click(screen.getByRole('button', { name: /download pdf/i }));
    expect(defaultProps.onPrint).toHaveBeenCalledWith(
      expect.objectContaining({ show_epa_registration: false }),
    );
  });

  it('calls onClose when Cancel clicked', () => {
    render(<InvoicePrintDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables Download PDF button when loading', () => {
    render(<InvoicePrintDialog {...defaultProps} loading={true} />);
    expect(screen.getByRole('button', { name: /download pdf/i })).toBeDisabled();
  });
});
