/**
 * BulkPOImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

vi.mock('../../lib/db', () => ({
  supabase: { from: vi.fn(() => chainable()), rpc: vi.fn(() => chainable()) },
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', full_name: 'Test User' },
  }),
}));

vi.mock('../../lib/documentOCR', () => ({
  processDocumentWithOCR: vi.fn(),
  isOCRSupported: vi.fn(() => false),
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import BulkPOImport from './BulkPOImport';
import { buildBulkPOIntentKey } from './bulkPOImportIntent';

describe('BulkPOImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => vi.clearAllMocks());

  it('renders when open', () => {
    render(<BulkPOImport {...defaultProps} />);
    expect(screen.getByText(/import pos/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<BulkPOImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/import pos/i)).not.toBeInTheDocument();
  });

  it('keeps identical-looking source documents as separate import intents', () => {
    const sharedIntent = {
      sourceFile: 'duplicate.pdf',
      vendorName: 'Vendor',
      invoiceNumber: 'INV-1',
      invoiceDate: '2026-07-16',
      items: [{
        productId: 'product-1',
        quantityOrdered: 10,
        unitCost: 250,
        unitSize: 'gal',
        notes: '',
      }],
    };

    const firstIntent = {
      ...sharedIntent,
      sourceIndex: 0,
    };
    const secondIntent = {
      ...sharedIntent,
      sourceIndex: 1,
    };

    const firstKey = buildBulkPOIntentKey(firstIntent);
    const secondKey = buildBulkPOIntentKey(secondIntent);

    expect(firstKey).not.toBe(secondKey);
    expect(buildBulkPOIntentKey(firstIntent)).toBe(firstKey);
  });
});
