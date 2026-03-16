/**
 * ProductDetail.internal-notes.test.tsx — Tests for the internal notes field added in Sprint 1
 * Verifies: labels, helper text, field rendering
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../lib/db', () => {
  const mockProduct = {
    id: 'test-product-id',
    product_name: 'Test Product',
    sku: 'TP-001',
    category: 'Herbicide',
    vendor: 'TestVendor',
    manufacturer: 'TestMfr',
    container_size: 2.5,
    unit_size: '2.5 gal',
    epa_registration: null,
    is_rup: false,
    signal_word: null,
    product_form: 'liquid',
    inventory_unit: 'gal',
    container_unit: 'jug',
    container_type: 'Jug',
    current_cost: 50,
    cost_updated_date: null,
    tier1_price: 65, tier1_margin: null, tier1_gross_margin: null,
    tier2_price: 60, tier2_margin: null, tier2_gross_margin: null,
    tier3_price: 55, tier3_margin: null, tier3_gross_margin: null,
    tier1_price_per_acre: null, tier2_price_per_acre: null, tier3_price_per_acre: null,
    suggested_rate: '2 oz/acre',
    rate_per_acre: 2,
    rate_unit: 'oz',
    notes: 'Apply in early spring.',
    internal_notes: 'Vendor price locked through Q2.',
    is_active: true,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };

  // Build a chainable mock where maybeSingle returns single object
  function chainable(resolveWith: unknown = { data: [], error: null }) {
    const builder: Record<string, unknown> = {};
    let _resolve = resolveWith;
    const self = () => builder;
    const methods = [
      'select','insert','update','upsert','delete',
      'eq','neq','gt','gte','lt','lte','like','ilike','is','in','or','not','match',
      'order','limit','range','single','csv','explain',
    ];
    for (const m of methods) builder[m] = vi.fn(self);
    // maybeSingle changes resolve to single object
    builder.maybeSingle = vi.fn(() => {
      _resolve = { data: mockProduct, error: null };
      return builder;
    });
    builder.then = vi.fn((resolve: (v: unknown) => void) => {
      Promise.resolve(_resolve).then(resolve);
      return builder;
    });
    return builder;
  }

  return {
    supabase: {
      from: vi.fn((table: string) => {
        if (table === 'products') {
          return chainable({ data: [mockProduct], error: null });
        }
        return chainable({ data: [], error: null });
      }),
      rpc: vi.fn(() => chainable()),
    },
    checkMutationResult: vi.fn(),
  };
});

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'user-id', full_name: 'Test User' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'test-product-id' }),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/products/test-product-id' }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({
    hasUnsavedChanges: false,
    markDirty: vi.fn(),
    markClean: vi.fn(),
    showModal: false,
    handleClose: vi.fn(),
    confirmClose: vi.fn(),
    cancelClose: vi.fn(),
    setShowModal: vi.fn(),
  }),
}));

vi.mock('../lib/activityLogger', () => ({
  logActivity: vi.fn(),
}));

import ProductDetail from './ProductDetail';

describe('ProductDetail Internal Notes Field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders both Grower Description and Internal Notes labels', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');
    expect(screen.getByText('Internal Notes')).toBeTruthy();
  });

  it('renders helper text for both fields', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');
    expect(screen.getByText(/Shown to growers on quotes and PDFs/)).toBeTruthy();
    expect(screen.getByText(/Internal only — never shown to growers/)).toBeTruthy();
  });

  it('renders at least 2 textareas (grower description + internal notes)', async () => {
    render(<ProductDetail />);
    await screen.findByText('Grower Description');
    const textareas = document.querySelectorAll('textarea');
    expect(textareas.length).toBeGreaterThanOrEqual(2);
  });
});
