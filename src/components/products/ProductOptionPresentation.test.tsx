import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProductOptionDetails, normalizeReturnPolicy, productOptionLabel } from './ProductOptionPresentation';

const siblingA = {
  id: 'product-a', product_name: 'Same Name', sku: 'SKU-A', unit_size: '2.5 gal',
  inventory_unit: 'gal', return_policy: 'unknown', is_full_tote_only: false,
  product_family: { name: 'Family A' },
};

describe('ProductOptionPresentation', () => {
  it('keeps same-name sibling Products distinct in the native option label', () => {
    expect(productOptionLabel(siblingA)).toContain('SKU: SKU-A');
    expect(productOptionLabel({ ...siblingA, id: 'product-b', sku: 'SKU-B' })).toContain('SKU: SKU-B');
  });

  it('uses a stable Product-ID fallback when same-name siblings have no SKU', () => {
    expect(productOptionLabel({ ...siblingA, id: 'a1b2c3d4-product-a', sku: null })).toContain('Product ID: a1b2c3d4…ct-a');
    expect(productOptionLabel({ ...siblingA, id: 'e5f6g7h8-product-b', sku: null })).toContain('Product ID: e5f6g7h8…ct-b');
  });

  it('keeps absent policy compatible as unknown and renders all picker metadata', () => {
    render(<ProductOptionDetails product={{ ...siblingA, return_policy: null, is_full_tote_only: true }} />);
    expect(screen.getByText('Family: Family A')).toBeInTheDocument();
    expect(screen.getByText('Package: 2.5 gal')).toBeInTheDocument();
    expect(screen.getByText('Unit: gal')).toBeInTheDocument();
    expect(screen.getByText('Return: unknown')).toBeInTheDocument();
    expect(screen.getByText('Full tote only')).toBeInTheDocument();
    expect(screen.getByText('Return: unknown').closest('[data-product-id]')).toHaveAttribute('data-product-id', 'product-a');
  });

  it('recognizes only the explicit no_return policy as no-return', () => {
    expect(normalizeReturnPolicy('no_return')).toBe('no_return');
    expect(normalizeReturnPolicy('unexpected')).toBe('unknown');
  });
});
