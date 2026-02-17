import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SplitHeading from './SplitHeading';

describe('SplitHeading', () => {
  it('renders title text', () => {
    render(<SplitHeading title="Customer" accent="List" />);
    expect(screen.getByText('Customer')).toBeInTheDocument();
  });

  it('renders accent text', () => {
    render(<SplitHeading title="Customer" accent="List" />);
    expect(screen.getByText('List')).toBeInTheDocument();
  });

  it('applies accent class to accent span', () => {
    const { container } = render(<SplitHeading title="A" accent="B" />);
    const accent = container.querySelector('.split-heading-accent');
    expect(accent).toBeInTheDocument();
    expect(accent?.textContent).toBe('B');
  });

  it('renders as h1 element', () => {
    render(<SplitHeading title="Test" accent="Heading" />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('applies 2xl size by default', () => {
    render(<SplitHeading title="A" accent="B" />);
    const h1 = screen.getByRole('heading');
    expect(h1.className).toContain('text-2xl');
  });

  it('applies lg size', () => {
    render(<SplitHeading title="A" accent="B" size="lg" />);
    const h1 = screen.getByRole('heading');
    expect(h1.className).toContain('text-lg');
  });

  it('applies xl size', () => {
    render(<SplitHeading title="A" accent="B" size="xl" />);
    const h1 = screen.getByRole('heading');
    expect(h1.className).toContain('text-xl');
  });

  it('renders children alongside the heading when provided', () => {
    render(
      <SplitHeading title="Orders" accent="List">
        <button>Add Order</button>
      </SplitHeading>
    );
    expect(screen.getByText('Add Order')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toBeInTheDocument();
  });

  it('wraps in flex container when children are provided', () => {
    const { container } = render(
      <SplitHeading title="A" accent="B">
        <span>child</span>
      </SplitHeading>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('flex');
    expect(wrapper.className).toContain('justify-between');
  });

  it('does not wrap in flex when no children', () => {
    const { container } = render(<SplitHeading title="A" accent="B" />);
    const firstChild = container.firstChild as HTMLElement;
    expect(firstChild.tagName).toBe('H1');
  });
});
