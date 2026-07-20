import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PerLineSplitEditor from './PerLineSplitEditor';

describe('PerLineSplitEditor', () => {
  const lines = [{
    line_key: 'chemical:1',
    line_kind: 'chemical' as const,
    description: 'Atrazine',
    shares: [
      { customer_id: 'customer-a', split_mode: 'field_default' as const, split_micro_pct: 60000000, base_unit_price_cents: 1200, base_price_source: 'tier', price_mode: 'default' as const, unit_price_cents: 1200, amount_cents: 7200 },
      { customer_id: 'customer-b', split_mode: 'field_default' as const, split_micro_pct: 40000000, base_unit_price_cents: 1300, base_price_source: 'tier', price_mode: 'default' as const, unit_price_cents: 1300, amount_cents: 5200 },
    ],
  }];

  it('renders every customer price and emits a complete custom vector', () => {
    const onChange = vi.fn();
    render(<PerLineSplitEditor lines={lines} options={{ lines: [] }} customerNames={{ 'customer-a': 'Alpha Farm', 'customer-b': 'Beta Farm' }} onChange={onChange} />);
    expect(screen.getByText('Advanced per-line split and price overrides').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Atrazine')).toBeInTheDocument();
    expect(screen.getByText('Alpha Farm')).toBeInTheDocument();
    expect(screen.getByText('Beta Farm')).toBeInTheDocument();
    const splitInputs = screen.getAllByLabelText('Split %');
    fireEvent.change(splitInputs[0], { target: { value: '55' } });
    expect(onChange).toHaveBeenCalledWith({ lines: [expect.objectContaining({
      line_key: 'chemical:1',
      split_mode: 'custom',
      vector: [
        { customer_id: 'customer-a', split_micro_pct: 55000000 },
        { customer_id: 'customer-b', split_micro_pct: 40000000 },
      ],
    })] });
  });

  it('converts a typed per-person price to exact integer cents', () => {
    const onChange = vi.fn();
    render(<PerLineSplitEditor lines={lines} options={{ lines: [] }} customerNames={{}} onChange={onChange} />);
    fireEvent.change(screen.getAllByLabelText(/Unit price/)[0], { target: { value: '12.34' } });
    expect(onChange).toHaveBeenCalledWith({ lines: [expect.objectContaining({
      line_key: 'chemical:1',
      price_overrides: [{ customer_id: 'customer-a', unit_price_cents: 1234, reason: '' }],
    })] });
  });
});
