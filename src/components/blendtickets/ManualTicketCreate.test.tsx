/**
 * ManualTicketCreate.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Fully chainable Supabase query-builder mock
function chainable(resolveWith: unknown = { data: [], error: null }) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  const methods = [
    'select','insert','update','upsert','delete',
    'eq','neq','gt','gte','lt','lte','like','ilike','is','in','or','not','match',
    'order','limit','range','single','maybeSingle',
    'csv','explain',
  ];
  for (const m of methods) builder[m] = vi.fn(self);
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
    return builder;
  });
  return builder;
}

// Product catalog returned for the `products` table so the product <select> has options.
const TEST_PRODUCTS = [
  { id: 'p1', product_name: 'Roundup PowerMax', is_active: true },
  { id: 'p2', product_name: 'Atrazine 4L', is_active: true },
];

vi.mock('../../lib/db', () => ({
  supabase: {
    from: vi.fn((table: string) =>
      chainable(table === 'products' ? { data: TEST_PRODUCTS, error: null } : { data: [], error: null })
    ),
    rpc: vi.fn(() => chainable()),
  },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', full_name: 'Test User' } }),
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: vi.fn(),
}));

vi.mock('../../lib/blendMathValidator', () => ({
  validateBlendMath: vi.fn(() => ({ valid: true, errors: [] })),
}));

import { ManualTicketCreate } from './ManualTicketCreate';
import type { Customer } from '../../types';

describe('ManualTicketCreate', () => {
  const defaultProps = {
    customers: [{ id: 'c1', farm_name: 'Smith Farm' }] as unknown as Customer[],
    onComplete: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  it('renders the form', () => {
    render(<ManualTicketCreate {...defaultProps} />);
    expect(screen.getAllByText(/customer/i).length).toBeGreaterThan(0);
  });

  it('renders product section', () => {
    render(<ManualTicketCreate {...defaultProps} />);
    expect(screen.getAllByText(/product/i).length).toBeGreaterThan(0);
  });

  // A1 regression guard: the product-select onChange calls updateProduct twice back-to-back
  // (product_id then product_name). With a stale-closure updateProduct the second call overwrote
  // the first and product_id was lost (select reverted to ''), causing $0 pricing / FK crash.
  // The functional-updater fix must keep BOTH the id (select value) and the name.
  it('persists product_id when a product is selected (no stale-closure wipe)', async () => {
    render(<ManualTicketCreate {...defaultProps} />);

    // Add a blank product line (the product <select> only renders per product row).
    fireEvent.click(screen.getByRole('button', { name: /add product/i }));

    // Wait for the async product catalog to load into the new row's dropdown.
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: 'Roundup PowerMax' }).length).toBeGreaterThan(0)
    );

    // Find the product-row <select> (the one offering "Select Product").
    const productSelect = screen
      .getAllByRole('combobox')
      .find((el) =>
        Array.from(el.querySelectorAll('option')).some((o) => o.textContent === 'Select Product')
      ) as HTMLSelectElement;
    expect(productSelect).toBeTruthy();

    // Select a product — fires the double updateProduct.
    fireEvent.change(productSelect, { target: { value: 'p1' } });

    // product_id must survive: the select value stays 'p1' (bug would revert it to '').
    expect(productSelect.value).toBe('p1');
    // ...and product_name is applied too.
    expect(screen.getAllByRole('option', { selected: true }).some((o) => o.textContent === 'Roundup PowerMax')).toBe(true);
  });
});
