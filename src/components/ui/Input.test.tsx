import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import Input from './Input';

describe('Input', () => {
  it('renders an input element', () => {
    render(<Input />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('renders label when provided', () => {
    render(<Input label="Username" />);
    expect(screen.getByText('Username')).toBeInTheDocument();
  });

  it('associates label with input via htmlFor/id', () => {
    render(<Input label="Email" />);
    const input = screen.getByLabelText('Email');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('generates id from label text', () => {
    render(<Input label="First Name" />);
    const input = screen.getByLabelText('First Name');
    expect(input).toHaveAttribute('id', 'first-name');
  });

  it('uses custom id when provided', () => {
    render(<Input label="Name" id="custom-id" />);
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('id', 'custom-id');
  });

  it('shows required asterisk when required', () => {
    render(<Input label="Name" required />);
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('does not show asterisk when not required', () => {
    render(<Input label="Name" />);
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });

  it('renders error message when provided', () => {
    render(<Input error="This field is required" />);
    expect(screen.getByText('This field is required')).toBeInTheDocument();
  });

  it('applies error styling when error is present', () => {
    render(<Input error="Error!" />);
    const input = screen.getByRole('textbox');
    expect(input.className).toContain('border-red-400');
  });

  it('does not show error message when no error', () => {
    const { container } = render(<Input />);
    const errorP = container.querySelector('p');
    expect(errorP).not.toBeInTheDocument();
  });

  it('handles onChange events', () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('forwards ref to input element', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('applies custom className', () => {
    render(<Input className="w-64" />);
    expect(screen.getByRole('textbox').className).toContain('w-64');
  });

  it('passes through placeholder', () => {
    render(<Input placeholder="Enter value..." />);
    expect(screen.getByPlaceholderText('Enter value...')).toBeInTheDocument();
  });

  it('supports disabled state', () => {
    render(<Input disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
