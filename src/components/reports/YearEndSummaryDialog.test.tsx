/**
 * YearEndSummaryDialog.test.tsx — Tests for year-end summary PDF generation dialog
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import YearEndSummaryDialog from './YearEndSummaryDialog';

describe('YearEndSummaryDialog', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onGenerate: vi.fn(),
    loading: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when open=true', () => {
    render(<YearEndSummaryDialog {...defaultProps} />);
    expect(screen.getByText('Generate Season Summary')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<YearEndSummaryDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Generate Season Summary')).not.toBeInTheDocument();
  });

  it('shows customer name in title when provided', () => {
    render(<YearEndSummaryDialog {...defaultProps} customerName="Green Acres" />);
    expect(screen.getByText('Season Summary — Green Acres')).toBeInTheDocument();
  });

  it('shows batch mode title when batchMode=true', () => {
    render(<YearEndSummaryDialog {...defaultProps} batchMode batchCount={5} />);
    expect(screen.getByText('Generate Year-End Summaries')).toBeInTheDocument();
  });

  it('shows batch count in description', () => {
    render(<YearEndSummaryDialog {...defaultProps} batchMode batchCount={12} />);
    expect(screen.getByText(/12 customer\(s\)/)).toBeInTheDocument();
  });

  it('shows single-mode description when not batch', () => {
    render(<YearEndSummaryDialog {...defaultProps} />);
    expect(screen.getByText(/comprehensive season summary/i)).toBeInTheDocument();
  });

  it('renders season dropdown with 5 options', () => {
    render(<YearEndSummaryDialog {...defaultProps} />);
    const select = screen.getByRole('combobox');
    const options = select.querySelectorAll('option');
    expect(options.length).toBe(5);
  });

  it('all three checkboxes default to checked', () => {
    render(<YearEndSummaryDialog {...defaultProps} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(3);
    checkboxes.forEach((cb) => expect(cb).toBeChecked());
  });

  it('shows checkbox labels', () => {
    render(<YearEndSummaryDialog {...defaultProps} />);
    expect(screen.getByText('Product usage detail')).toBeInTheDocument();
    expect(screen.getByText('Grower shares')).toBeInTheDocument();
    expect(screen.getByText('Year-over-year comparison')).toBeInTheDocument();
  });

  it('calls onGenerate with all options checked by default', () => {
    render(<YearEndSummaryDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /generate summary/i }));
    expect(defaultProps.onGenerate).toHaveBeenCalledWith(
      expect.any(Number),
      {
        show_product_detail: true,
        show_shares: true,
        show_yoy_comparison: true,
      },
    );
  });

  it('passes unchecked options correctly', () => {
    render(<YearEndSummaryDialog {...defaultProps} />);
    const checkboxes = screen.getAllByRole('checkbox');
    // Uncheck "Product usage detail" (first) and "Grower shares" (second)
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /generate summary/i }));
    expect(defaultProps.onGenerate).toHaveBeenCalledWith(
      expect.any(Number),
      {
        show_product_detail: false,
        show_shares: false,
        show_yoy_comparison: true,
      },
    );
  });

  it('batch mode shows count in button text', () => {
    render(<YearEndSummaryDialog {...defaultProps} batchMode batchCount={8} />);
    expect(screen.getByRole('button', { name: /generate 8 summaries/i })).toBeInTheDocument();
  });

  it('calls onClose when Cancel clicked', () => {
    render(<YearEndSummaryDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables generate button when loading', () => {
    render(<YearEndSummaryDialog {...defaultProps} loading={true} />);
    expect(screen.getByRole('button', { name: /generate summary/i })).toBeDisabled();
  });

  it('changes season when dropdown value changes', () => {
    render(<YearEndSummaryDialog {...defaultProps} />);
    const select = screen.getByRole('combobox');
    const options = select.querySelectorAll('option');
    // Pick the second option (currentSeason - 1)
    fireEvent.change(select, { target: { value: options[1].value } });
    fireEvent.click(screen.getByRole('button', { name: /generate summary/i }));
    expect(defaultProps.onGenerate).toHaveBeenCalledWith(
      Number(options[1].value),
      expect.any(Object),
    );
  });
});
