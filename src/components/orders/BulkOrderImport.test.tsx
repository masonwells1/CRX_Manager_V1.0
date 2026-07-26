/**
 * BulkOrderImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
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

vi.mock('../../lib/documentOCR', () => ({
  processDocumentWithOCR: vi.fn(),
  isCSVFile: vi.fn(() => true),
  isOCRSupported: vi.fn(() => false),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', full_name: 'Test User' } }),
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

import BulkOrderImport from './BulkOrderImport';

describe('BulkOrderImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation((table: string) => {
      if (table === 'products') {
        return chainable({
          data: [
            { id: 'product-a', product_name: 'Same Name', sku: 'SKU-A', is_active: true },
            { id: 'product-b', product_name: 'Same Name', sku: 'SKU-B', is_active: true },
          ],
          error: null,
        });
      }
      if (table === 'customers') {
        return chainable({ data: { id: 'customer-1' }, error: null });
      }
      return chainable();
    });
    mocks.rpc.mockResolvedValue({ data: { order_id: 'order-1' }, error: null });
  });

  it('renders when open', () => {
    render(<BulkOrderImport {...defaultProps} />);
    expect(screen.getByText(/import orders/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<BulkOrderImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/import orders/i)).not.toBeInTheDocument();
  });

  it('shows file upload area', () => {
    render(<BulkOrderImport {...defaultProps} />);
    expect(screen.getAllByText(/csv/i).length).toBeGreaterThan(0);
  });

  it('rejects an ambiguous same-name Product before bulk_import_order', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-AMB,North Farm,Same Name,2,20',
    ].join('\n');
    const file = new File([csv], 'ambiguous.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/ambiguous\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-AMB/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await screen.findByText(/successfully imported:/i);
    expect(screen.getByText(/failed:/i)).toHaveTextContent('Failed: 1');
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('uses a unique SKU to send the exact sibling UUID', async () => {
    const { container } = render(<BulkOrderImport {...defaultProps} />);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-SKU,North Farm,SKU-B,2,20',
    ].join('\n');
    const file = new File([csv], 'sku.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/sku\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-SKU/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.anything()));
    const args = mocks.rpc.mock.calls.find(([name]) => name === 'bulk_import_order')?.[1] as {
      p_items: Array<{ product_id: string }>;
    };
    expect(args.p_items[0].product_id).toBe('product-b');
  });
});
