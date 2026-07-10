import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SearchableSelect from './SearchableSelect';

const options = [
  { value: 'north', label: 'North Farm', sublabel: '1001' },
  { value: 'south', label: 'South Farm', sublabel: '2002' },
  { value: 'west', label: 'West Field', sublabel: '3003' },
];

describe('SearchableSelect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('filters options by label and sublabel', () => {
    render(<SearchableSelect options={options} value="" onChange={vi.fn()} label="Customer" />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Customer' }), { target: { value: '2002' } });

    expect(screen.getByRole('option', { name: /south farm/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /north farm/i })).not.toBeInTheDocument();
  });

  it('selects a clicked option', () => {
    const onChange = vi.fn();
    render(<SearchableSelect options={options} value="" onChange={onChange} label="Customer" />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Customer' }));
    fireEvent.click(screen.getByRole('option', { name: /south farm/i }));

    expect(onChange).toHaveBeenCalledWith('south');
  });

  it('selects the highlighted option with Enter', () => {
    const onChange = vi.fn();
    render(<SearchableSelect options={options} value="" onChange={onChange} label="Customer" />);
    const input = screen.getByRole('combobox', { name: 'Customer' });

    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('south');
  });

  it('does not commit a selection change while typing', () => {
    const onChange = vi.fn();
    render(<SearchableSelect options={options} value="north" onChange={onChange} label="Customer" />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Customer' }), { target: { value: 'North' } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits a clear when a selected field is emptied and blurred', () => {
    const onChange = vi.fn();
    render(<SearchableSelect options={options} value="north" onChange={onChange} label="Customer" />);
    const input = screen.getByRole('combobox', { name: 'Customer' });

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('commits a clear synchronously after selecting an option and blurring empty text', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SearchableSelect options={options} value="" onChange={onChange} label="Customer" />
    );
    const input = screen.getByRole('combobox', { name: 'Customer' });

    fireEvent.focus(input);
    const option = screen.getByRole('option', { name: /north farm/i });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    rerender(<SearchableSelect options={options} value="north" onChange={onChange} label="Customer" />);
    onChange.mockClear();

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith('');
  });

  it('restores the selected label when a partial query is blurred', () => {
    const onChange = vi.fn();
    render(<SearchableSelect options={options} value="north" onChange={onChange} label="Customer" />);
    const input = screen.getByRole('combobox', { name: 'Customer' });

    fireEvent.change(input, { target: { value: 'North' } });
    fireEvent.blur(input);

    expect(input).toHaveValue('North Farm');
    expect(onChange).not.toHaveBeenCalled();
  });
});
