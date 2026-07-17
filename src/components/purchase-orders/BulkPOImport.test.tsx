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
import {
  buildBulkPOIntentKey,
  ensurePendingBulkPOIntent,
  markBulkPOIntentImported,
  savePendingBulkPOIntents,
} from '../../lib/bulkPOImportRetry';

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
    expect(mocks.rpc).not.toHaveBeenCalledWith('next_po_number');

    fireEvent.click(screen.getByText('Close'));
    expect(defaultProps.onSuccess).toHaveBeenCalledTimes(1);
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it('asks the server again when a browser marker points to a PO that may have been deleted', async () => {
    const intentKey = buildBulkPOIntentKey({
      vendorName: 'Vendor A',
      invoiceNumber: 'INV-REIMPORT.pdf',
      invoiceDate: '2026-07-16',
      items: [{
        productId: product.id,
        quantityOrdered: 2,
        unitCostCents: 1_000,
        unitSize: 'GAL',
        notes: '',
      }],
    });
    expect(intentKey).not.toBeNull();
    const pending = {};
    ensurePendingBulkPOIntent(pending, intentKey!, () => 'save_purchase_order:user-1:bulk:test');
    markBulkPOIntentImported(pending, intentKey!, 'po-deleted', Date.now(), 'PO-DELETED');
    savePendingBulkPOIntents(localStorage, 'user-1', pending);

    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'save_purchase_order') {
        return { data: { po_id: 'po-reimported', status: 'saved', po_number: 'PO-NEW' }, error: null };
      }
      return { data: null, error: new Error(`Unexpected RPC: ${name}`) };
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-REIMPORT.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    expect(await screen.findByText('Previously imported')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'save_purchase_order',
      expect.objectContaining({ p_po_id: null }),
    ));
    expect(defaultProps.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('counts an exact same-PO replay as skipped even when the RPC status is saved', async () => {
    const intentKey = buildBulkPOIntentKey({
      vendorName: 'Vendor A',
      invoiceNumber: 'INV-REPLAY.pdf',
      invoiceDate: '2026-07-16',
      items: [{
        productId: product.id,
        quantityOrdered: 2,
        unitCostCents: 1_000,
        unitSize: 'GAL',
        notes: '',
      }],
    });
    expect(intentKey).not.toBeNull();
    const pending = {};
    ensurePendingBulkPOIntent(pending, intentKey!, () => 'save_purchase_order:user-1:bulk:replay');
    markBulkPOIntentImported(pending, intentKey!, 'po-existing', Date.now(), 'PO-EXISTING');
    savePendingBulkPOIntents(localStorage, 'user-1', pending);

    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'save_purchase_order') {
        return { data: { po_id: 'po-existing', status: 'saved', po_number: 'PO-EXISTING' }, error: null };
      }
      return { data: null, error: new Error(`Unexpected RPC: ${name}`) };
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-REPLAY.pdf', { type: 'application/pdf' })] },
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

  it('normalizes an OCR fractional-cent unit cost before saving', async () => {
    mocks.processDocumentWithOCR.mockResolvedValue({
      success: true,
      raw_text: 'parsed',
      document_type: 'purchase_order',
      parsed_data: {
        vendor_name: 'Vendor A',
        invoice_number: 'INV-FRACTIONAL',
        invoice_date: '2026-07-16',
        items: [{
          product_name: product.product_name,
          quantity: 2,
          unit_cost: 3.334,
          unit_size: 'GAL',
        }],
      },
      confidence: 1,
      processing_time_ms: 1,
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-FRACTIONAL.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'save_purchase_order',
      expect.objectContaining({
        p_items: [expect.objectContaining({
          unit_cost: 3.33,
          unit_cost_cents: 333,
        })],
      }),
    ));
  });

  it('requires a vendor before creating a global duplicate claim', async () => {
    mocks.processDocumentWithOCR.mockResolvedValue({
      success: true,
      raw_text: 'parsed without vendor',
      document_type: 'purchase_order',
      parsed_data: {
        vendor_name: '',
        invoice_number: 'INV-NO-VENDOR',
        invoice_date: '2026-07-16',
        items: [{
          product_name: product.product_name,
          quantity: 2,
          unit_cost: 10,
          unit_size: 'GAL',
        }],
      },
      confidence: 1,
      processing_time_ms: 1,
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-NO-VENDOR.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));

    const importButton = await screen.findByRole('button', { name: /import 0 pos/i });
    expect(importButton).toBeDisabled();
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_purchase_order', expect.anything());

    fireEvent.change(screen.getByPlaceholderText('Vendor name...'), {
      target: { value: 'Vendor B' },
    });
    expect(await screen.findByRole('button', { name: /import 1 po/i })).toBeEnabled();
  });
});
