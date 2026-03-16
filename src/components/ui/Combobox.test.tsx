import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Combobox from './Combobox';

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('Combobox', () => {
  const options = ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry'];

  it('renders with a label', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} />
    );
    expect(screen.getByLabelText('Fruit')).toBeInTheDocument();
  });

  it('renders without a label', () => {
    render(
      <Combobox value="" onChange={() => {}} options={options} placeholder="Pick one" />
    );
    expect(screen.getByPlaceholderText('Pick one')).toBeInTheDocument();
  });

  it('shows placeholder text', () => {
    render(
      <Combobox value="" onChange={() => {}} options={options} placeholder="Search..." />
    );
    expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
  });

  it('calls onChange when typing', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="" onChange={onChange} options={options} />
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'App' } });
    expect(onChange).toHaveBeenCalledWith('App');
  });

  it('shows dropdown on focus', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });

  it('filters options based on input value', () => {
    render(
      <Combobox label="Fruit" value="an" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    // "Banana" and "Elderberry" don't match "an" — wait, "Banana" contains "an"
    const listItems = screen.getAllByRole('option');
    const texts = listItems.map((li) => li.textContent);
    expect(texts).toContain('Banana');
    // "Apple" does not contain "an"
    expect(texts).not.toContain('Apple');
  });

  it('selects option on click', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="" onChange={onChange} options={options} />
    );
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.mouseDown(screen.getByText('Cherry'));
    expect(onChange).toHaveBeenCalledWith('Cherry');
  });

  it('navigates options with arrow keys and selects with Enter', () => {
    const onChange = vi.fn();
    render(
      <Combobox label="Fruit" value="" onChange={onChange} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Apple');
  });

  it('closes dropdown on Escape', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not open dropdown when disabled', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} disabled />
    );
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows error message', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} error="Required" />
    );
    expect(screen.getByText('Required')).toBeInTheDocument();
  });

  it('has correct ARIA attributes', () => {
    render(
      <Combobox label="Fruit" value="" onChange={() => {}} options={options} />
    );
    const input = screen.getByRole('combobox');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
  });
});
