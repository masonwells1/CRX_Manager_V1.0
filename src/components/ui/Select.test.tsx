import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import Select from './Select';

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Charlie' },
];

describe('Select', () => {
  it('renders a select element', () => {
    render(<Select options={options} />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('renders all options', () => {
    render(<Select options={options} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Charlie')).toBeInTheDocument();
  });

  it('renders placeholder option when provided', () => {
    render(<Select options={options} placeholder="Choose one..." />);
    expect(screen.getByText('Choose one...')).toBeInTheDocument();
  });

  it('does not render placeholder when not provided', () => {
    render(<Select options={options} />);
    const allOptions = screen.getAllByRole('option');
    expect(allOptions).toHaveLength(3); // just the 3 options
  });

  it('renders label when provided', () => {
    render(<Select options={options} label="Category" />);
    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  it('associates label with select via htmlFor/id', () => {
    render(<Select options={options} label="Status" />);
    const select = screen.getByLabelText('Status');
    expect(select).toBeInTheDocument();
    expect(select.tagName).toBe('SELECT');
  });

  it('generates id from label text', () => {
    render(<Select options={options} label="Sort Order" />);
    const select = screen.getByLabelText('Sort Order');
    expect(select).toHaveAttribute('id', 'sort-order');
  });

  it('uses custom id when provided', () => {
    render(<Select options={options} label="Type" id="my-select" />);
    const select = screen.getByLabelText('Type');
    expect(select).toHaveAttribute('id', 'my-select');
  });

  it('renders error message when provided', () => {
    render(<Select options={options} error="Please select a value" />);
    expect(screen.getByText('Please select a value')).toBeInTheDocument();
  });

  it('applies error styling when error is present', () => {
    render(<Select options={options} error="Error" />);
    const select = screen.getByRole('combobox');
    expect(select.className).toContain('border-red-400');
  });

  it('handles onChange events', () => {
    const onChange = vi.fn();
    render(<Select options={options} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('forwards ref to select element', () => {
    const ref = createRef<HTMLSelectElement>();
    render(<Select options={options} ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLSelectElement);
  });

  it('applies custom className', () => {
    render(<Select options={options} className="w-48" />);
    expect(screen.getByRole('combobox').className).toContain('w-48');
  });

  it('supports disabled state', () => {
    render(<Select options={options} disabled />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
