import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProductSearchResultRow } from './ProductSearchResultRow';

describe('ProductSearchResultRow', () => {
  it('keeps the live picker row phone-stacked and desktop-aligned while retaining exact Product details', () => {
    const onClick = vi.fn();
    render(<ProductSearchResultRow product={{ id: '99999999-9999-4999-8999-999999999999', product_name: 'Same Name', sku: null }} onClick={onClick} trailing={<span>T1: $10.00</span>} />);
    const row = screen.getByRole('button', { name: /Same Name/ });
    expect(row).toHaveClass('flex-col', 'sm:flex-row', 'min-w-0');
    expect(screen.getByText('Product ID: 99999999-9999-4999-8999-999999999999')).toBeInTheDocument();
    row.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
