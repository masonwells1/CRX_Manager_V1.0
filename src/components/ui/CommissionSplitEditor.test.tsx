import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CommissionSplitEditor from './CommissionSplitEditor';
import type { CommissionSplit } from '../../types';

const mockRpc = vi.fn();
vi.mock('../../lib/db', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  assertRpcResult: <T,>(data: unknown, rpcName: string): T => {
    if (data === null || data === undefined) {
      throw new Error(`${rpcName} returned no data`);
    }
    return data as T;
  },
}));

beforeEach(() => {
  // Default: RPC unavailable — component must fall back to the built-in list.
  mockRpc.mockResolvedValue({ data: null, error: new Error('unavailable') });
});

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
    // Fallback options carry no profile id; the DB stamps it at save time.
    expect(onChange).toHaveBeenCalledWith({
      splits: [{ recipient: 'Chance Tuttle', recipient_user_id: null, percentage: 50 }],
    });
  });

  it('carries the profile id when the picked option came from the live RPC', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { id: 'aaaaaaaa-0000-0000-0000-000000000001', full_name: 'Chance Tuttle' },
        { id: 'aaaaaaaa-0000-0000-0000-000000000002', full_name: 'Mason Wells' },
      ],
      error: null,
    });
    const onChange = vi.fn();
    render(
      <CommissionSplitEditor value={defaultValue} onChange={onChange} />
    );

    await waitFor(() => {
      const select = screen.getByLabelText('Recipient for split 1');
      expect(
        Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
      ).toContain('Chance Tuttle');
    });

    fireEvent.change(screen.getByLabelText('Recipient for split 1'), {
      target: { value: 'Chance Tuttle' },
    });
    expect(onChange).toHaveBeenCalledWith({
      splits: [
        {
          recipient: 'Chance Tuttle',
          recipient_user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
          percentage: 50,
        },
      ],
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

  it('does not offer a free-text "Other" recipient option', () => {
    render(
      <CommissionSplitEditor value={defaultValue} onChange={() => {}} />
    );

    const select = screen.getByLabelText('Recipient for split 1');
    const optionValues = Array.from(select.querySelectorAll('option')).map(
      (o) => o.getAttribute('value')
    );
    expect(optionValues).not.toContain('__other__');
    expect(screen.queryByPlaceholderText('Enter recipient name')).not.toBeInTheDocument();
  });

  it('renders all preset recipient options', () => {
    render(
      <CommissionSplitEditor value={defaultValue} onChange={() => {}} />
    );

    const select = screen.getByLabelText('Recipient for split 1');
    const options = select.querySelectorAll('option');
    // "Select recipient..." + 4 RECIPIENTS
    expect(options).toHaveLength(5);
  });

  it('loads recipient options from list_commission_recipients when available', async () => {
    mockRpc.mockResolvedValue({
      data: [
        { full_name: 'Chance Tuttle' },
        { full_name: 'Clayton Wells' },
        { full_name: 'Mason Wells' },
      ],
      error: null,
    });
    render(
      <CommissionSplitEditor value={defaultValue} onChange={() => {}} />
    );

    await waitFor(() => {
      const select = screen.getByLabelText('Recipient for split 1');
      const labels = Array.from(select.querySelectorAll('option')).map(
        (o) => o.textContent
      );
      expect(labels).toContain('Clayton Wells');
      expect(mockRpc).toHaveBeenCalledWith('list_commission_recipients');
    });
  });

  it('keeps a legacy non-list recipient visible and selected', () => {
    const value: CommissionSplit = {
      splits: [{ recipient: 'Old Custom Partner', percentage: 100 }],
    };
    render(<CommissionSplitEditor value={value} onChange={() => {}} />);

    const select = screen.getByLabelText('Recipient for split 1') as HTMLSelectElement;
    expect(select.value).toBe('Old Custom Partner');
  });
});
