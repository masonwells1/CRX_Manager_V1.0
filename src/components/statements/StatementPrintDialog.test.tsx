/**
 * StatementPrintDialog.test.tsx — Tests for statement generation dialog
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StatementPrintDialog from './StatementPrintDialog';

describe('StatementPrintDialog', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    onGenerate: vi.fn(),
    loading: false,
    defaultDate: '2026-01-15',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders when open=true', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    expect(screen.getByText('Generate Statement')).toBeInTheDocument();
  });

  it('does not render when open=false', () => {
    render(<StatementPrintDialog {...defaultProps} open={false} />);
    expect(screen.queryByText('Generate Statement')).not.toBeInTheDocument();
  });

  it('shows Summary and Detailed mode buttons', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    expect(screen.getByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('Detailed')).toBeInTheDocument();
  });

  it('defaults to summary mode', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    expect(screen.getByRole('button', { name: /generate summary statement/i })).toBeInTheDocument();
  });

  it('switches button text when Detailed mode selected', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    // Click the Detailed mode button
    fireEvent.click(screen.getByText('Detailed'));
    expect(screen.getByRole('button', { name: /generate detailed statement/i })).toBeInTheDocument();
  });

  it('renders date input with defaultDate', () => {
    render(<StatementPrintDialog {...defaultProps} defaultDate="2026-03-01" />);
    const dateInput = screen.getByDisplayValue('2026-03-01');
    expect(dateInput).toBeInTheDocument();
  });

  it('renders show grower shares checkbox', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    expect(screen.getByText('Show grower shares')).toBeInTheDocument();
  });

  it('grower shares checkbox defaults to checked', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('calls onGenerate with summary options', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /generate summary statement/i }));
    expect(defaultProps.onGenerate).toHaveBeenCalledWith({
      mode: 'summary',
      show_shares: true,
      as_of_date: '2026-01-15',
    });
  });

  it('calls onGenerate with detailed mode after switching', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Detailed'));
    fireEvent.click(screen.getByRole('button', { name: /generate detailed statement/i }));
    expect(defaultProps.onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'detailed' }),
    );
  });

  it('passes changed date to onGenerate', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    const dateInput = screen.getByDisplayValue('2026-01-15');
    fireEvent.change(dateInput, { target: { value: '2026-06-30' } });
    fireEvent.click(screen.getByRole('button', { name: /generate summary statement/i }));
    expect(defaultProps.onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ as_of_date: '2026-06-30' }),
    );
  });

  it('unchecking shares passes show_shares=false', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /generate summary statement/i }));
    expect(defaultProps.onGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ show_shares: false }),
    );
  });

  it('calls onClose when Cancel clicked', () => {
    render(<StatementPrintDialog {...defaultProps} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('disables generate button when loading', () => {
    render(<StatementPrintDialog {...defaultProps} loading={true} />);
    expect(screen.getByRole('button', { name: /generate.*statement/i })).toBeDisabled();
  });
});
