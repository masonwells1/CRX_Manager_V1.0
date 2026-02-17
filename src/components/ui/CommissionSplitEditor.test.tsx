import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CommissionSplitEditor from './CommissionSplitEditor';
import type { CommissionSplit } from '../../types';

const defaultValue: CommissionSplit = {
  splits: [{ recipient: 'Mason Wells', percentage: 50 }],
};

describe('CommissionSplitEditor', () => {
  it('renders the label', () => {
    render(
      <CommissionSplitEditor value={defaultValue} onChange={() => {}} />
    );
    expect(screen.getByText('Commission Split')).toBeInTheDocument();
  });

  it('renders custom label', () => {
    render(
      <CommissionSplitEditor
        value={defaultValue}
        onChange={() => {}}
        label="Sales Split"
      />
    );
    expect(screen.getByText('Sales Split')).toBeInTheDocument();
  });

  it('renders existing splits', () => {
    const value: CommissionSplit = {
      splits: [
        { recipient: 'Mason Wells', percentage: 60 },
        { recipient: 'Chance Tuttle', percentage: 40 },
      ],
    };
    render(<CommissionSplitEditor value={value} onChange={() => {}} />);

    const selects = screen.getAllByRole('combobox');
    expect(selects).toHaveLength(2);
  });

  it('shows total percentage', () => {
    render(
      <CommissionSplitEditor value={defaultValue} onChange={() => {}} />
    );
    // React splits "Total: {total.toFixed(1)}%" into text nodes
    expect(screen.getByText(/Total:.*50\.0%/)).toBeInTheDocument();
  });

  it('shows "should be 100%" when total is not 100', () => {
    render(
      <CommissionSplitEditor value={defaultValue} onChange={() => {}} />
    );
    expect(screen.getByText(/should be 100%/)).toBeInTheDocument();
  });

  it('does not show warning when total is 100%', () => {
    const value: CommissionSplit = {
      splits: [{ recipient: 'Mason Wells', percentage: 100 }],
    };
    render(<CommissionSplitEditor value={value} onChange={() => {}} />);
    expect(screen.queryByText(/should be 100%/)).not.toBeInTheDocument();
    expect(screen.getByText(/Total:.*100\.0%/)).toBeInTheDocument();
  });

  it('calls onChange when Add Recipient is clicked', () => {
    const onChange = vi.fn();
    render(
      <CommissionSplitEditor value={defaultValue} onChange={onChange} />
    );

    fireEvent.click(screen.getByText('Add Recipient'));
    expect(onChange).toHaveBeenCalledWith({
      splits: [
        { recipient: 'Mason Wells', percentage: 50 },
        { recipient: '', percentage: 0 },
      ],
    });
  });

  it('calls onChange when percentage is updated', () => {
    const onChange = vi.fn();
    render(
      <CommissionSplitEditor value={defaultValue} onChange={onChange} />
    );

    const percentInput = screen.getByLabelText('Commission percentage for split 1');
    fireEvent.change(percentInput, { target: { value: '75' } });
    expect(onChange).toHaveBeenCalledWith({
      splits: [{ recipient: 'Mason Wells', percentage: 75 }],
    });
  });

  it('calls onChange when recipient is changed via select', () => {
    const onChange = vi.fn();
    render(
      <CommissionSplitEditor value={defaultValue} onChange={onChange} />
    );

    const select = screen.getByLabelText('Recipient for split 1');
    fireEvent.change(select, { target: { value: 'Chance Tuttle' } });
    expect(onChange).toHaveBeenCalledWith({
      splits: [{ recipient: 'Chance Tuttle', percentage: 50 }],
    });
  });

  it('shows remove button only when multiple splits exist', () => {
    render(
      <CommissionSplitEditor value={defaultValue} onChange={() => {}} />
    );
    // Only 1 split — no remove button
    expect(screen.queryByLabelText(/Remove split/)).not.toBeInTheDocument();
  });

  it('shows remove buttons when multiple splits exist', () => {
    const value: CommissionSplit = {
      splits: [
        { recipient: 'Mason Wells', percentage: 50 },
        { recipient: 'Chance Tuttle', percentage: 50 },
      ],
    };
    render(<CommissionSplitEditor value={value} onChange={() => {}} />);
    expect(screen.getAllByLabelText(/Remove split/)).toHaveLength(2);
  });

  it('calls onChange when remove button is clicked', () => {
    const onChange = vi.fn();
    const value: CommissionSplit = {
      splits: [
        { recipient: 'Mason Wells', percentage: 60 },
        { recipient: 'Chance Tuttle', percentage: 40 },
      ],
    };
    render(<CommissionSplitEditor value={value} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Remove split 2'));
    expect(onChange).toHaveBeenCalledWith({
      splits: [{ recipient: 'Mason Wells', percentage: 60 }],
    });
  });

  it('shows text input when Other is selected', () => {
    const onChange = vi.fn();
    render(
      <CommissionSplitEditor value={defaultValue} onChange={onChange} />
    );

    const select = screen.getByLabelText('Recipient for split 1');
    fireEvent.change(select, { target: { value: '__other__' } });

    // After selecting "Other", a text input should appear
    expect(screen.getByPlaceholderText('Enter recipient name')).toBeInTheDocument();
  });

  it('renders all preset recipient options', () => {
    render(
      <CommissionSplitEditor value={defaultValue} onChange={() => {}} />
    );

    const select = screen.getByLabelText('Recipient for split 1');
    const options = select.querySelectorAll('option');
    // "Select recipient..." + 4 RECIPIENTS + "Other..."
    expect(options).toHaveLength(6);
  });
});
