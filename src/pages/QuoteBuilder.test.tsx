/**
 * QuoteBuilder.test.tsx — Tests for the quote builder page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockFrom, mockRpc, mockToast, mockNavigate } = vi.hoisted(() => {
  return {
    mockFrom: vi.fn(),
    mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
    mockToast: vi.fn(),
    mockNavigate: vi.fn(),
  };
});

/**
 * Build a Supabase-like chain mock using real Promises.
 * Every chained method returns `self`, and `.then()` resolves with `result`.
 */
function buildChain(
  result: { data: unknown; error: unknown },
  onSelect?: (columns: unknown) => void,
): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) {
    self[m] = method;
  }
  self.select = (columns: unknown) => {
    onSelect?.(columns);
    return self;
  };
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

function buildPendingChain(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) {
    self[m] = method;
  }
  const promise = new Promise(() => {});
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

vi.mock('../hooks/useUnsavedChanges', () => ({
  useUnsavedChanges: () => ({
    setDirty: vi.fn(),
    confirmNavigation: vi.fn(() => true),
    showModal: false,
    handleConfirm: vi.fn(),
    handleCancel: vi.fn(),
  }),
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyLargeOrder: vi.fn(), notifyCreditLimitExceeded: vi.fn() }));
vi.mock('../lib/metrics', () => ({ trackBusinessEvent: vi.fn() }));
vi.mock('../lib/dateUtils', () => ({ localDatePlusDays: vi.fn(() => '2026-04-15'), localToday: vi.fn(() => '2026-03-16') }));
vi.mock('../lib/quotePdf', () => ({ downloadQuotePdf: vi.fn(), generateQuotePdf: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: vi.fn(), pdfToBase64: vi.fn(), buildEmailHtml: vi.fn(() => '<p>test</p>') }));
vi.mock('../lib/rupCompliance', () => ({
  checkRUPCompliance: vi.fn().mockResolvedValue({ compliant: true, warnings: [], rupProductNames: [] }),
}));
vi.mock('../components/ui/CommissionSplitEditor', () => ({
  default: () => <div data-testid="commission-split-editor">CommissionSplitEditor</div>,
}));
vi.mock('../components/ui/UnsavedChangesModal', () => ({ default: () => null }));

import { preferredQuoteNotes } from '../lib/quoteNotes';
import QuoteBuilder from './QuoteBuilder';

function renderQuoteBuilder(id?: string) {
  const path = id ? `/quotes/${id}/edit` : '/quotes/new';
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/quotes/new" element={<QuoteBuilder />} />
        <Route path="/quotes/:id/edit" element={<QuoteBuilder />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('QuoteBuilder', () => {
  it('prefers customer-facing quoting guidance and falls back to the grower description', () => {
    expect(preferredQuoteNotes({ quoting_notes: 'Customer quote guidance', notes: 'Grower copy' }))
      .toBe('Customer quote guidance');
    expect(preferredQuoteNotes({ quoting_notes: null, notes: 'Grower copy' }))
      .toBe('Grower copy');
    expect(preferredQuoteNotes({ quoting_notes: '   ', notes: '  Grower copy  ' }))
      .toBe('Grower copy');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  it('renders the Quote Builder heading for a new quote', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByText('Builder')).toBeInTheDocument();
    });
  });

  it('shows loading skeleton while fetching data for existing quote', () => {
    mockFrom.mockImplementation(() => buildPendingChain());
    mockRpc.mockImplementation(() => new Promise(() => {}));
    renderQuoteBuilder('quote-123');
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders customer select dropdown', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Select a customer...')).toBeInTheDocument();
    });
  });

  it('shows Save Draft button', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByText('Save Draft')).toBeInTheDocument();
    });
  });

  it('renders breadcrumbs with Quotes link and New Quote', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByText('Quotes')).toBeInTheDocument();
      expect(screen.getByText('New Quote')).toBeInTheDocument();
    });
  });

  it('handles quote not found gracefully when editing invalid ID', async () => {
    mockFrom.mockImplementation(() => buildChain({ data: null, error: null }));
    renderQuoteBuilder('nonexistent-id');
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('error', 'Quote not found');
    });
    expect(mockNavigate).toHaveBeenCalledWith('/quotes');
  });

  it('renders the commission split editor', async () => {
    renderQuoteBuilder();
    await waitFor(() => {
      expect(screen.getByTestId('commission-split-editor')).toBeInTheDocument();
    });
  });

  it('loads and renders the real Product family on a persisted quote row', async () => {
    const product = {
      id: '11111111-1111-4111-8111-111111111111',
      product_name: 'Exact Product',
      sku: 'SKU-EXACT',
      is_active: true,
      inventory_unit: 'gal',
      packaging_variant: '2 x 2.5 gal',
      return_policy: 'returnable',
      is_full_tote_only: false,
      product_family: { name: 'Family Alpha' },
    };
    const quote = {
      id: 'quote-123',
      quote_number: 'Q-2026-0123',
      customer_id: null,
      tier: 1,
      valid_days: 30,
      header_notes: null,
      footer_notes: null,
      status: 'draft',
      is_planned: false,
      commission_split: null,
      created_at: '2026-07-25T00:00:00.000Z',
    };
    const section = {
      id: 'section-1',
      quote_id: quote.id,
      section_name: 'Products',
      sort_order: 1,
      section_notes: null,
      section_header_notes: null,
      needed_by_date: null,
      field_id: null,
    };
    const item = {
      id: 'item-1',
      quote_id: quote.id,
      section_id: section.id,
      product_id: product.id,
      sort_order: 1,
      product,
      calc_mode: 'units_direct',
      total_units_needed: 1,
      price_per_unit: 1000,
      price_override: null,
      current_cost: 700,
      suggested_rate: null,
      actual_rate: null,
      rate_unit: null,
      oz_per_acre: null,
      price_per_acre: null,
      acres: null,
      unit_size: null,
      profit: 300,
      total_price: 1000,
      net_margin: 30,
      notes: null,
      price_unit: null,
    };
    const quoteItemSelects: unknown[] = [];

    mockFrom.mockImplementation((table: string) => {
      const data = table === 'quotes'
        ? quote
        : table === 'quote_sections'
          ? [section]
          : table === 'quote_items'
            ? [item]
            : table === 'products'
              ? [product]
              : [];
      return buildChain(
        { data, error: null },
        table === 'quote_items' ? (columns) => quoteItemSelects.push(columns) : undefined,
      );
    });

    renderQuoteBuilder(quote.id);

    expect(await screen.findByText('Family: Family Alpha')).toBeInTheDocument();
    expect(screen.getAllByText('SKU: SKU-EXACT')).toHaveLength(1);
    expect(quoteItemSelects).toContain('*, product:products(*, product_family:product_families(name))');
  });
});
