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
  role: 'admin',
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

// Fixtures already carry cost; the admin cost read (get_admin_cost_fields) passes rows through.
vi.mock('../../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
  withAdminNestedCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));

vi.mock('../../lib/db', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  assertRpcResult: (value: unknown) => value,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', full_name: 'Test User', role: mocks.role },
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
    mocks.role = 'admin';
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

  it('fails closed when OCR returns an ambiguous same-name Product', async () => {
    mocks.from.mockReturnValue(chainable({
      data: [
        product,
        { ...product, id: 'product-sibling', sku: 'ATR-4L-SIBLING' },
      ],
      error: null,
    }));

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'AMBIGUOUS.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));

    const importButton = await screen.findByRole('button', { name: /import 0 pos/i });
    expect(importButton).toBeDisabled();
    expect(screen.getByRole('button', { name: /select product/i })).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_purchase_order', expect.anything());
  });

  it('rejects a whole PO when any positive-quantity row is unresolved', async () => {
    mocks.processDocumentWithOCR.mockResolvedValue({
      success: true,
      raw_text: 'parsed',
      document_type: 'purchase_order',
      parsed_data: {
        vendor_name: 'Vendor A',
        invoice_number: 'NO-PARTIAL',
        invoice_date: '2026-07-16',
        items: [
          { product_name: product.sku, quantity: 2, unit_cost: 10, unit_size: 'GAL' },
          { product_name: 'Unknown Product', quantity: 1, unit_cost: 20, unit_size: 'GAL' },
        ],
      },
      confidence: 1,
      processing_time_ms: 1,
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'NO-PARTIAL.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));

    expect(await screen.findByRole('button', { name: /import 0 pos/i })).toBeDisabled();
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_purchase_order', expect.anything());
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
    // The import fingerprint ignores cost, so an admin is told a re-import never changes costs.
    expect(mocks.toast).toHaveBeenCalledWith(
      'info',
      'Skipped 1 document already imported. A re-import does not change its costs; check them in Supplier POs.',
    );
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalledWith('next_po_number');

    fireEvent.click(screen.getByText('Close'));
    expect(defaultProps.onSuccess).toHaveBeenCalledTimes(1);
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  it('does not tell a sales rep about costs when a document was already imported', async () => {
    mocks.role = 'sales_rep';
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
      target: { files: [new File(['one'], 'INV-101.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));

    expect(await screen.findByText(/already imported and skipped: 1/i)).toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith('info', 'Skipped 1 document already imported.');
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

  it('marks only the PO that just imported as previously imported after a partial batch', async () => {
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
          new File(['one'], 'INV-201.pdf', { type: 'application/pdf' }),
          new File(['two'], 'INV-202.pdf', { type: 'application/pdf' }),
        ],
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 2 files/i }));
    expect(screen.queryByText('Previously imported')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /import 2 pos/i }));

    // The badge is driven by render state published at the end of handleImport, not by
    // re-reading the mutable marker ref (React 19 follow-up, 2026-10-14).
    await waitFor(() => expect(screen.getAllByText('Previously imported')).toHaveLength(1));
  });

  it('explains a changed-content conflict instead of showing only a generic failure', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'save_purchase_order') {
        return {
          data: null,
          error: { message: 'BULK_PO_DOCUMENT_CONTENT_CONFLICT' },
        };
      }
      return { data: null, error: new Error(`Unexpected RPC: ${name}`) };
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-CHANGED.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/INV-CHANGED\.pdf:.*already imported.*edit it instead/i),
    ));
    expect(mocks.toast).not.toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/review and retry/i),
    );
  });

  it('refuses an OCR unit cost with more than two decimals until the admin fixes it', async () => {
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

    // Refused, never rounded: the PO is not importable until the admin fixes the cost.
    expect(await screen.findByRole('button', { name: /import 0 pos/i })).toBeDisabled();
    const costInput = screen.getByRole('spinbutton', { name: /unit cost for/i });
    expect(costInput).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/no more than two decimal places/i)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_purchase_order', expect.anything());
    // The footer total dashes too: an invalid cost is never shown as a rounded aggregate.
    expect(screen.getByText('PO Total').closest('tr')).toHaveTextContent('—');
    expect(screen.getByText('PO Total').closest('tr')).not.toHaveTextContent('$');

    fireEvent.change(costInput, { target: { value: '3.33' } });
    expect(screen.getByText('PO Total').closest('tr')).toHaveTextContent('$6.66');
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

  it('a sales rep can still import a document whose OCR cost has more than two decimals (no cost is sent)', async () => {
    mocks.role = 'sales_rep';
    mocks.processDocumentWithOCR.mockResolvedValue({
      success: true,
      raw_text: 'parsed',
      document_type: 'purchase_order',
      parsed_data: {
        vendor_name: 'Vendor A',
        invoice_number: 'INV-REP-FRACTIONAL',
        invoice_date: '2026-07-16',
        items: [{ product_name: product.product_name, quantity: 2, unit_cost: 3.334, unit_size: 'GAL' }],
      },
      confidence: 1,
      processing_time_ms: 1,
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-REP-FRACTIONAL.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('save_purchase_order', expect.anything()));
    const call = mocks.rpc.mock.calls.find(([name]) => name === 'save_purchase_order')!;
    const items = (call[1] as { p_items: Array<Record<string, unknown>> }).p_items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).not.toHaveProperty('unit_cost');
      expect(item).not.toHaveProperty('unit_cost_cents');
    }
  });

  it('treats a cleared cost box as missing, not $0, until the admin types a cost', async () => {
    mocks.processDocumentWithOCR.mockResolvedValue({
      success: true,
      raw_text: 'parsed',
      document_type: 'purchase_order',
      parsed_data: {
        vendor_name: 'Vendor A',
        invoice_number: 'INV-CLEARED',
        invoice_date: '2026-07-16',
        items: [{ product_name: product.product_name, quantity: 2, unit_cost: 3.334, unit_size: 'GAL' }],
      },
      confidence: 1,
      processing_time_ms: 1,
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-CLEARED.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    await screen.findByRole('button', { name: /import 0 pos/i });

    const costInput = screen.getByRole('spinbutton', { name: /unit cost for/i });
    fireEvent.change(costInput, { target: { value: '' } });

    expect(await screen.findByRole('button', { name: /import 0 pos/i })).toBeDisabled();
    expect(costInput).toHaveAccessibleDescription(/enter a unit cost/i);

    // An explicit 0 is the admin's choice and imports.
    fireEvent.change(costInput, { target: { value: '0' } });
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'save_purchase_order',
      expect.objectContaining({
        p_items: [expect.objectContaining({ unit_cost: 0, unit_cost_cents: 0 })],
      }),
    ));
  });

  it('keeps an explicit typed 0 when the admin then picks the product (no catalog cost fallback)', async () => {
    mocks.processDocumentWithOCR.mockResolvedValue({
      success: true,
      raw_text: 'parsed',
      document_type: 'purchase_order',
      parsed_data: {
        vendor_name: 'Vendor A',
        invoice_number: 'INV-PICK',
        invoice_date: '2026-07-16',
        items: [{ product_name: 'Unknown Product', quantity: 2, unit_cost: 5, unit_size: 'GAL' }],
      },
      confidence: 1,
      processing_time_ms: 1,
    });

    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-PICK.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    await screen.findByRole('button', { name: /import 0 pos/i });

    fireEvent.change(screen.getByRole('spinbutton', { name: /unit cost for/i }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /select product/i }));

    fireEvent.change(await screen.findByPlaceholderText(/search by name/i), { target: { value: 'atrazine' } });
    const pickerRows = await screen.findAllByRole('button', { name: /atrazine 4l/i });
    fireEvent.click(pickerRows[pickerRows.length - 1]);
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'save_purchase_order',
      expect.objectContaining({
        p_items: [expect.objectContaining({ unit_cost: 0, unit_cost_cents: 0 })],
      }),
    ));
  });

  it('refuses a typed cost whose dollar number cannot carry its exact cents, and saves agreeing dollars and cents otherwise', async () => {
    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-LARGEST.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    await screen.findByRole('button', { name: /import 1 po/i });

    // 90071992547409.91 has exact cents (9007199254740991), but as a JSON number its dollars read
    // 90071992547409.9, so save_purchase_order would refuse the pair (PO_UNIT_COST_CENTS_MISMATCH).
    // It is refused here instead, before anything is sent.
    const costInput = screen.getByRole('spinbutton', { name: /unit cost for/i });
    fireEvent.change(costInput, { target: { value: '90071992547409.91' } });
    expect(await screen.findByRole('button', { name: /import 0 pos/i })).toBeDisabled();
    expect(costInput).toHaveAttribute('aria-invalid', 'true');
    expect(costInput).toHaveAccessibleDescription(/too large to save exactly/i);
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_purchase_order', expect.anything());

    // A large but real cost: the dollars and the cents sent agree exactly.
    fireEvent.change(costInput, { target: { value: '1234567.89' } });
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'save_purchase_order',
      expect.objectContaining({ p_items: [expect.objectContaining({ unit_cost: 1234567.89, unit_cost_cents: 123456789 })] }),
    ));
  });

  it('refuses a typed cost too precise for a number instead of shortening it', async () => {
    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-TYPED.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    await screen.findByRole('button', { name: /import 1 po/i });

    // parseFloat('10.0000000000000001') is exactly 10; the typed text must still be refused.
    const costInput = screen.getByRole('spinbutton', { name: /unit cost for/i });
    fireEvent.change(costInput, { target: { value: '10.0000000000000001' } });

    expect(await screen.findByRole('button', { name: /import 0 pos/i })).toBeDisabled();
    expect(costInput).toHaveAttribute('aria-invalid', 'true');
    expect(costInput).toHaveAccessibleDescription(/no more than two decimal places/i);
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_purchase_order', expect.anything());
  });

  it('a sales rep import sends no cost and shows no cost columns (purchase cost is admin-only)', async () => {
    mocks.role = 'sales_rep';
    render(<BulkPOImport {...defaultProps} />);
    fireEvent.change(document.querySelector('#po-pdf-upload')!, {
      target: { files: [new File(['one'], 'INV-REP.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    // Wait for the review table before checking that it has no cost column.
    const importButton = await screen.findByRole('button', { name: /import 1 po/i });
    expect(screen.queryByText('Unit Cost')).not.toBeInTheDocument();
    fireEvent.click(importButton);

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('save_purchase_order', expect.anything()));
    const call = mocks.rpc.mock.calls.find(([name]) => name === 'save_purchase_order')!;
    const items = (call[1] as { p_items: Array<Record<string, unknown>> }).p_items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).not.toHaveProperty('unit_cost');
      expect(item).not.toHaveProperty('unit_cost_cents');
    }
  });

  it('canonicalizes identity boundary whitespace before saving', async () => {
    const vendorName = '\u00a0Vendor A\t';
    const invoiceNumber = '\tINV-NBSP\u00a0';
    mocks.processDocumentWithOCR.mockResolvedValue({
      success: true,
      raw_text: 'parsed with non-ASCII boundary whitespace',
      document_type: 'purchase_order',
      parsed_data: {
        vendor_name: vendorName,
        invoice_number: invoiceNumber,
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
      target: { files: [new File(['one'], 'INV-NBSP.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /process 1 file/i }));
    fireEvent.click(await screen.findByRole('button', { name: /import 1 po/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'save_purchase_order',
      expect.objectContaining({
        p_po_payload: expect.objectContaining({
          vendor: 'Vendor A',
          bulk_import_vendor_reference: 'INV-NBSP',
        }),
      }),
    ));
  });

  it('rejects an invisible whitespace-only vendor before creating a duplicate claim', async () => {
    mocks.processDocumentWithOCR.mockResolvedValue({
      success: true,
      raw_text: 'parsed without vendor',
      document_type: 'purchase_order',
      parsed_data: {
        vendor_name: '\u00a0\t',
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
