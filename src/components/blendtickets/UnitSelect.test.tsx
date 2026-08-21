import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UnitConversion } from '../../types';
import UnitSelect from './UnitSelect';

const UNIT_CONVERSIONS: UnitConversion[] = [
  { id: 'u-oz', unit: 'oz', factor_oz: 1, unit_type: 'liquid', notes: null },
  { id: 'u-gal', unit: 'Gal', factor_oz: 128, unit_type: 'liquid', notes: null },
  { id: 'u-lb', unit: 'Lb', factor_oz: 16, unit_type: 'dry', notes: null },
  { id: 'u-ea', unit: 'Ea', factor_oz: 1, unit_type: 'both', notes: null },
];

describe('UnitSelect', () => {
  it('offers only units for the product form plus both-type units', () => {
    render(
      <UnitSelect
        unitConversions={UNIT_CONVERSIONS}
        form="liquid"
        value=""
        onChange={vi.fn()}
        ariaLabel="Quantity unit"
      />,
    );

    const select = screen.getByRole('combobox', { name: 'Quantity unit' }) as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.value)).toEqual(['', 'oz', 'Gal', 'Ea']);
    expect(select.options[0].disabled).toBe(true);
  });

  it('keeps an unknown saved value available and reports a new selection', () => {
    const onChange = vi.fn();
    render(
      <UnitSelect
        unitConversions={UNIT_CONVERSIONS}
        form="dry"
        value="Legacy jug"
        onChange={onChange}
        ariaLabel="Rate unit per acre"
      />,
    );

    const select = screen.getByRole('combobox', { name: 'Rate unit per acre' }) as HTMLSelectElement;
    expect(select).toHaveValue('Legacy jug');
    expect(Array.from(select.options, (option) => option.value)).toContain('Legacy jug');

    fireEvent.change(select, { target: { value: 'Lb' } });
    expect(onChange).toHaveBeenCalledWith('Lb');
  });
});
