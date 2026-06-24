import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Badge, { statusToBadgeVariant } from './Badge';

describe('Badge', () => {
  it('renders children text', () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('applies default variant classes when no variant prop', () => {
    render(<Badge>Default</Badge>);
    const badge = screen.getByText('Default');
    expect(badge.className).toContain('bg-gray-100');
  });

  it('applies success variant classes', () => {
    render(<Badge variant="success">Paid</Badge>);
    const badge = screen.getByText('Paid');
    expect(badge.className).toContain('bg-emerald-100');
  });

  it('applies error variant classes', () => {
    render(<Badge variant="error">Failed</Badge>);
    const badge = screen.getByText('Failed');
    expect(badge.className).toContain('bg-red-100');
  });

  it('applies warning variant classes', () => {
    render(<Badge variant="warning">Pending</Badge>);
    const badge = screen.getByText('Pending');
    expect(badge.className).toContain('bg-amber-100');
  });

  it('renders small size by default', () => {
    render(<Badge>Small</Badge>);
    const badge = screen.getByText('Small');
    expect(badge.className).toContain('text-xs');
  });

  it('renders medium size when specified', () => {
    render(<Badge size="md">Medium</Badge>);
    const badge = screen.getByText('Medium');
    expect(badge.className).toContain('text-sm');
  });
});

describe('statusToBadgeVariant', () => {
  it('maps draft to draft variant', () => {
    expect(statusToBadgeVariant['draft']).toBe('draft');
  });

  it('maps confirmed to success variant', () => {
    expect(statusToBadgeVariant['confirmed']).toBe('success');
  });

  it('maps cancelled to error variant', () => {
    expect(statusToBadgeVariant['cancelled']).toBe('error');
  });

  it('maps pending to warning variant', () => {
    expect(statusToBadgeVariant['pending']).toBe('warning');
  });

  it('maps paid to success variant', () => {
    expect(statusToBadgeVariant['paid']).toBe('success');
  });

  it('returns undefined for unknown status', () => {
    expect(statusToBadgeVariant['nonexistent']).toBeUndefined();
  });
});
