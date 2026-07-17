/**
 * BulkPOImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  processDocumentWithOCR: vi.fn(),
  toast: vi.fn(),
}));

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
  supabase: { from: mocks.from, rpc: mocks.rpc },
  assertRpcResult: (value: unknown) => value,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', full_name: 'Test User' },
  }),
}));

vi.mock('../../lib/documentOCR', () => ({
  processDocumentWithOCR: mocks.processDocumentWithOCR,
  isOCRSupported: vi.fn(() => true),
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

import BulkPOImport from './BulkPOImport';

describe('BulkPOImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  const product = {
    id: 'product-1',
    product_name: 'Atrazine 4L',
    sku: 'ATR-4L',
    vendor: 'Vendor A',
    unit_size: 'GAL',
    current_cost: 10,
    is_active: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.from.mockReturnValue(chainable({ data: [product], error: null }));
    mocks.processDocumentWithOCR.mockImplementation(async (file: File) => ({
      success: true,
      raw_text: 'parsed',
      document_type: 'purchase_order',
      parsed_data: {
        vendor_name: 'Vendor A',
        invoice_number: file.name,
        invoice_date: '2026-07-16',
        items: [{ product_name: product.product_name, quantity: 2, unit_cost: 10, unit_size: 'GAL' }],
      },
      confidence: 1,
      processing_time_ms: 1,
    }));
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'next_po_number') return { data: 'PO-1001', error: null };
      if (name === 'save_purchase_order') {
        return { data: { po_id: 'po-1', status: 'saved', po_number: 'PO-1001' }, error: null };
      }
      return { data: null, error: new Error(`Unexpected RPC: ${name}`) };
    });
  });

  it('renders when open', () => {
    render(<BulkPOImport {...defaultProps} />);
    expect(screen.getByText(/import pos/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<BulkPOImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/import pos/i)).not.toBeInTheDocument();
  });

  it('reports a server duplicate as skipped instead of newly imported', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'next_po_number') return { data: 'PO-UNUSED', error: null };
      if (name === 'save_purchase_order') {
        return {
          data: { po_id: 'po-existing', status: 'already_imported', po_number: 'PO-EXISTING' },
          error: null,
        };
      }
      return { data: null, error: new Error(`Unexpected RPC: ${name}`) };
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-100.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));

    expect(await screen.findByText(/successfully imported: 0 purchase orders/i)).toBeInTheDocument();
    expect(screen.getByText(/already imported and skipped: 1/i)).toBeInTheDocument();
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
  });

  it('refreshes the parent when a partially successful batch is closed', async () => {
    let saveCalls = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'next_po_number') return { data: `PO-${1001 + saveCalls}`, error: null };
      if (name === 'save_purchase_order') {
        saveCalls++;
        if (saveCalls === 1) {
          return { data: { po_id: 'po-new', status: 'saved', po_number: 'PO-1001' }, error: null };
        }
        return { data: null, error: new Error('temporary save failure') };
      }
      return { data: null, error: new Error(`Unexpected RPC: ${name}`) };
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: {
        files: [
          new File(['one'], 'INV-101.pdf', { type: 'application/pdf' }),
          new File(['two'], 'INV-102.pdf', { type: 'application/pdf' }),
        ],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 2 files/i }));
    fireEvent.click(await screen.findByRole('button', { name: /import 2 pos/i }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringMatching(/1 purchase order failed/i)));
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
    expect(screen.getByText('INV-102.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(defaultProps.onSuccess).toHaveBeenCalledTimes(1);
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });
});
