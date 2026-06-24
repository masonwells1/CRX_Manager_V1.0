/**
 * FieldCustomerAssignment.test.tsx — per-field customer assignment on shapefile import (SOW-F3).
 * Purely presentational, so it renders from plain props with no wizard/parse dependency.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FieldCustomerAssignment from './FieldCustomerAssignment';
import type { Customer } from '../../types';
import type { AssignableField } from '../../lib/fieldImportCustomers';

const fields: AssignableField[] = [
  { index: 1, name: 'North 80', acres: 80 },
  { index: 2, name: 'South 40', acres: 40.4 },
];

const customers = [
  { id: 'c1', farm_name: 'Alpha Farm' },
  { id: 'c2', farm_name: 'Beta Farm' },
] as Customer[];

describe('FieldCustomerAssignment', () => {
  const baseProps = {
    fields,
    customers,
    assignments: {} as Record<number, string>,
    fallbackCustomerId: '',
    onAssign: vi.fn(),
    onApplyToAll: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists every parsed field with its acreage', () => {
    render(<FieldCustomerAssignment {...baseProps} />);
    expect(screen.getByText('North 80')).toBeInTheDocument();
    expect(screen.getByText('South 40')).toBeInTheDocument();
    expect(screen.getByText('80.0 ac')).toBeInTheDocument();
    expect(screen.getByText('40.4 ac')).toBeInTheDocument();
  });

  it('"apply to all" assigns one customer to every field', () => {
    render(<FieldCustomerAssignment {...baseProps} />);
    const applyInput = screen.getByRole('textbox', { name: /apply one customer to all fields/i });
    fireEvent.focus(applyInput);
    fireEvent.click(screen.getByRole('button', { name: 'Alpha Farm' }));
    expect(baseProps.onApplyToAll).toHaveBeenCalledWith('c1');
  });

  it('assigns a single field to its own customer (override)', () => {
    render(<FieldCustomerAssignment {...baseProps} />);
    // Each row picker is named for its field, so a screen reader (and this test) can target it.
    const northInput = screen.getByRole('textbox', { name: /customer for north 80/i });
    fireEvent.focus(northInput);
    fireEvent.click(screen.getByRole('button', { name: 'Beta Farm' }));
    expect(baseProps.onAssign).toHaveBeenCalledWith(1, 'c2');
  });

  it('warns while any field is still missing a customer (no fallback, no overrides)', () => {
    render(<FieldCustomerAssignment {...baseProps} />);
    expect(screen.getByText(/2 fields still need/i)).toBeInTheDocument();
  });

  it('the apply-to-all FALLBACK alone satisfies every field (no warning, rows show the name)', () => {
    render(<FieldCustomerAssignment {...baseProps} fallbackCustomerId="c1" />);
    expect(screen.queryByText(/still need/i)).not.toBeInTheDocument();
    // Both row inputs resolve to the fallback customer.
    expect(screen.getByRole('textbox', { name: /customer for north 80/i })).toHaveValue('Alpha Farm');
    expect(screen.getByRole('textbox', { name: /customer for south 40/i })).toHaveValue('Alpha Farm');
  });

  it('a per-field override shows over the fallback', () => {
    render(<FieldCustomerAssignment {...baseProps} fallbackCustomerId="c1" assignments={{ 2: 'c2' }} />);
    expect(screen.queryByText(/still need/i)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /customer for north 80/i })).toHaveValue('Alpha Farm');
    expect(screen.getByRole('textbox', { name: /customer for south 40/i })).toHaveValue('Beta Farm');
  });
});
