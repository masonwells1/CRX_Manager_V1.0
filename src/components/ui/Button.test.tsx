import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import Button from './Button';

describe('Button', () => {
  it('renders children text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('renders as a button element', () => {
    render(<Button>Test</Button>);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('calls onClick handler', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // Variants
  it('applies primary variant classes by default', () => {
    render(<Button>Primary</Button>);
    expect(screen.getByRole('button').className).toContain('bg-crx-green');
  });

  it('applies secondary variant classes', () => {
    render(<Button variant="secondary">Secondary</Button>);
    expect(screen.getByRole('button').className).toContain('bg-white');
  });

  it('applies ghost variant classes', () => {
    render(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByRole('button').className).toContain('hover:bg-gray-100');
  });

  it('applies danger variant classes', () => {
    render(<Button variant="danger">Danger</Button>);
    expect(screen.getByRole('button').className).toContain('bg-red-600');
  });

  // Sizes
  it('applies md size by default', () => {
    render(<Button>Medium</Button>);
    expect(screen.getByRole('button').className).toContain('px-4 py-2');
  });

  it('applies sm size', () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole('button').className).toContain('px-3 py-1.5');
  });

  it('applies lg size', () => {
    render(<Button size="lg">Large</Button>);
    expect(screen.getByRole('button').className).toContain('px-5 py-2.5');
  });

  // Disabled
  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  // Loading
  it('is disabled when loading', () => {
    render(<Button loading>Loading</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('shows spinner when loading', () => {
    const { container } = render(<Button loading>Loading</Button>);
    const spinner = container.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('does not show icon when loading', () => {
    render(
      <Button loading icon={<span data-testid="icon">icon</span>}>
        Loading
      </Button>
    );
    expect(screen.queryByTestId('icon')).not.toBeInTheDocument();
  });

  // Icon
  it('renders icon when provided and not loading', () => {
    render(
      <Button icon={<span data-testid="icon">+</span>}>Add</Button>
    );
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  // Chevron
  it('shows chevron for primary variant by default', () => {
    const { container } = render(<Button>Go</Button>);
    // ChevronRight renders as SVG
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThan(0);
  });

  it('hides chevron when showChevron is false', () => {
    const { container } = render(
      <Button showChevron={false}>Go</Button>
    );
    // No SVGs when no chevron and no loading
    const svgs = container.querySelectorAll('svg');
    expect(svgs.length).toBe(0);
  });

  it('does not show chevron when loading', () => {
    render(<Button loading showChevron>Go</Button>);
    // Only spinner SVG should be present, not chevron
    // The spinner has animate-spin class
    const btn = screen.getByRole('button');
    const svgs = btn.querySelectorAll('svg');
    // One SVG for Loader2 spinner
    expect(svgs.length).toBe(1);
  });

  // Ref forwarding
  it('forwards ref to button element', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  // Custom className
  it('applies custom className', () => {
    render(<Button className="custom-class">Custom</Button>);
    expect(screen.getByRole('button').className).toContain('custom-class');
  });

  // HTML attributes pass-through
  it('passes through HTML button attributes', () => {
    render(<Button type="submit" data-testid="submit-btn">Submit</Button>);
    const btn = screen.getByTestId('submit-btn');
    expect(btn).toHaveAttribute('type', 'submit');
  });
});
