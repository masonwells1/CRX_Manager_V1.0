import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Card, { CardHeader } from './Card';

describe('Card', () => {
  it('renders children', () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText('Card content')).toBeInTheDocument();
  });

  it('applies padding by default', () => {
    const { container } = render(<Card>Test</Card>);
    expect(container.firstChild).toHaveClass('p-5');
  });

  it('removes padding when padding=false', () => {
    const { container } = render(<Card padding={false}>Test</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).not.toContain('p-5');
  });

  it('applies hover styles when hover=true', () => {
    const { container } = render(<Card hover>Test</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('hover:shadow-card-hover');
  });

  it('does not apply hover styles by default', () => {
    const { container } = render(<Card>Test</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).not.toContain('hover:shadow-card-hover');
  });

  it('applies custom className', () => {
    const { container } = render(<Card className="mt-4">Test</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('mt-4');
  });

  it('passes through HTML div attributes', () => {
    render(<Card data-testid="my-card">Test</Card>);
    expect(screen.getByTestId('my-card')).toBeInTheDocument();
  });

  it('has base card classes', () => {
    const { container } = render(<Card>Test</Card>);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('bg-white');
    expect(card.className).toContain('rounded-xl');
    expect(card.className).toContain('shadow-card');
  });
});

describe('CardHeader', () => {
  it('renders the title', () => {
    render(<CardHeader title="Test Title" />);
    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('renders accent text when provided', () => {
    render(<CardHeader title="My" accent="Header" />);
    expect(screen.getByText('Header')).toBeInTheDocument();
  });

  it('renders action element when provided', () => {
    render(
      <CardHeader
        title="Title"
        action={<button>Action</button>}
      />
    );
    expect(screen.getByText('Action')).toBeInTheDocument();
  });

  it('does not render accent when not provided', () => {
    const { container } = render(<CardHeader title="Title Only" />);
    const accent = container.querySelector('.split-heading-accent');
    expect(accent).not.toBeInTheDocument();
  });
});
