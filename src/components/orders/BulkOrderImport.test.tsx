/**
 * BulkOrderImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
  profileRole: 'admin',
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
  useAuth: () => ({ profile: { id: 'user-1', full_name: 'Test User', role: mocks.profileRole } }),
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

import BulkOrderImport from './BulkOrderImport';
import { BelowCostApprovalProvider } from '../../contexts/BelowCostApprovalContext';

function renderImport(props: Parameters<typeof BulkOrderImport>[0]) {
  return render(
    <BelowCostApprovalProvider>
      <BulkOrderImport {...props} />
    </BelowCostApprovalProvider>,
  );
}

/** Type a reason into the database-challenge modal and approve it. */
async function approveBelowCost(reason: string) {
  const textarea = await screen.findByLabelText(/approval reason \(required\)/i);
  fireEvent.change(textarea, { target: { value: reason } });
  fireEvent.click(screen.getByRole('button', { name: /approve and retry/i }));
}

const belowCostReasonError = {
  code: 'P0001',
  message: `BELOW_COST_REASON_REQUIRED:${JSON.stringify({
    operation: 'bulk_import_order',
    product_id: 'product-b',
    product_name: 'Same Name',
    unit_price_cents: 300,
    // Intentionally differs from the browser fixture's $7 Product cost. The
    // modal must display this later $9 database-locked value.
    locked_unit_cost_cents: 900,
  })}`,
};

const belowCostAdminError = {
  code: 'P0001',
  message: `BELOW_COST_ADMIN_REQUIRED:${JSON.stringify({
    operation: 'bulk_import_order',
    product_id: 'product-b',
    product_name: 'Same Name',
    unit_price_cents: 300,
    locked_unit_cost_cents: 700,
  })}`,
};

describe('BulkOrderImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profileRole = 'admin';
    mocks.from.mockImplementation((table: string) => {
      if (table === 'products') {
        return chainable({
          data: [
            { id: 'product-a', product_name: 'Same Name', sku: 'SKU-A', is_active: true, current_cost: 6 },
            { id: 'product-b', product_name: 'Same Name', sku: 'SKU-B', is_active: true, current_cost: 7 },
            { id: 'product-name-x', product_name: 'Cross Identity', sku: 'NAME-X', is_active: true, current_cost: 8 },
            { id: 'product-sku-x', product_name: 'Other Product', sku: 'Cross Identity', is_active: true, current_cost: 9 },
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
    renderImport(defaultProps);
    expect(screen.getByText(/import orders/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderImport({ ...defaultProps, open: false });
    expect(screen.queryByText(/import orders/i)).not.toBeInTheDocument();
  });

  it('shows file upload area', () => {
    renderImport(defaultProps);
    expect(screen.getAllByText(/csv/i).length).toBeGreaterThan(0);
  });

  it('rejects an ambiguous same-name Product before bulk_import_order', async () => {
    const { container } = renderImport(defaultProps);
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
    const failures = screen.getByRole('list', { name: /order import failure details/i });
    expect(failures).toHaveTextContent('Order O-AMB');
    expect(failures).toHaveTextContent('"Same Name" has an ambiguous Product match');
    expect(failures).toHaveTextContent('use a unique SKU and retry');
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('shows the missing Product text and retry guidance without calling bulk_import_order', async () => {
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-MISSING,North Farm,Unknown Product,2,20',
    ].join('\n');
    const file = new File([csv], 'missing.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/missing\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-MISSING/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await screen.findByText(/successfully imported:/i);
    const failures = screen.getByRole('list', { name: /order import failure details/i });
    expect(failures).toHaveTextContent('Order O-MISSING');
    expect(failures).toHaveTextContent('"Unknown Product" has no matching Product');
    expect(failures).toHaveTextContent('use a unique SKU and retry');
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('rejects a cross-field name/SKU collision before bulk_import_order', async () => {
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-CROSS,North Farm,Cross Identity,2,20',
    ].join('\n');
    const file = new File([csv], 'cross-field.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/cross-field\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-CROSS/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await screen.findByText(/successfully imported:/i);
    const failures = screen.getByRole('list', { name: /order import failure details/i });
    expect(failures).toHaveTextContent('"Cross Identity" has an ambiguous Product match');
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('uses a unique SKU to send the exact sibling UUID', async () => {
    const { container } = renderImport(defaultProps);
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
      p_items: Array<{ product_id: string; unit_cost?: number }>;
      p_status: string;
      p_total_cost: number;
    };
    expect(args.p_items[0].product_id).toBe('product-b');
    expect(args.p_items[0]).not.toHaveProperty('unit_cost');
    expect(args.p_total_cost).toBe(14);
    expect(args.p_status).toBe('confirmed');
  });

  it('submits cent-normalized totals and surfaces returned inventory warnings', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: belowCostReasonError })
      .mockResolvedValueOnce({
        data: {
          order_id: 'order-warning',
          warnings: ['Same Name: need 3, net position is 0'],
        },
        error: null,
      });
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-CENTS,North Farm,SKU-B,3,0.105',
    ].join('\n');
    const file = new File([csv], 'cents.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/cents\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-CENTS/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    // 0.105 is below the 7.00 Product cost, so the below-cost guardrail fires first.
    await approveBelowCost('cents test — priced below cost on purpose');

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.anything()));
    const args = mocks.rpc.mock.calls[1][1] as {
      p_total_price: number;
      p_total_cost: number;
      p_total_profit: number;
    };
    expect(args.p_total_price).toBe(0.33);
    expect(args.p_total_cost).toBe(21);
    expect(args.p_total_profit).toBe(-20.67);
    expect(mocks.toast).toHaveBeenCalledWith(
      'warning',
      'Inventory for imported order O-CENTS: Same Name: need 3, net position is 0',
    );
  });

  it('rejects a malformed explicit unit cost before bulk_import_order', async () => {
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit,unit_cost',
      'O-BAD-COST,North Farm,SKU-B,2,20,not-a-number',
    ].join('\n');
    const file = new File([csv], 'bad-cost.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/bad-cost\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    expect(await screen.findByText(/invalid quantity, price, or unit cost/i)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('rejects a blank required price instead of coercing it to zero', async () => {
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-BLANK-PRICE,North Farm,SKU-B,2,',
    ].join('\n');
    const file = new File([csv], 'blank-price.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/blank-price\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    expect(await screen.findByText(/invalid quantity, price, or unit cost/i)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('does not let an explicit zero override the authoritative Product cost', async () => {
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit,unit_cost',
      'O-ZERO-COST,North Farm,SKU-B,2,20,0',
    ].join('\n');
    const file = new File([csv], 'zero-cost.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/zero-cost\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-ZERO-COST/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('bulk_import_order', expect.anything()));
    const args = mocks.rpc.mock.calls.find(([name]) => name === 'bulk_import_order')?.[1] as {
      p_items: Array<{ unit_cost?: number }>;
      p_total_cost: number;
    };
    expect(args.p_items[0]).not.toHaveProperty('unit_cost');
    expect(args.p_total_cost).toBe(14);
  });

  it('rejects a terminal imported status before bulk_import_order', async () => {
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,status,product_name,quantity,price_per_unit',
      'O-FULFILLED,North Farm,fulfilled,SKU-B,2,20',
    ].join('\n');
    const file = new File([csv], 'fulfilled.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/fulfilled\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    expect(await screen.findByText(/only confirmed orders can be imported/i)).toBeInTheDocument();
    expect(mocks.rpc).not.toHaveBeenCalledWith('bulk_import_order', expect.anything());
  });

  it('blocks a below-cost import until a reason is approved and persists it in the notes', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: belowCostReasonError })
      .mockResolvedValueOnce({ data: { order_id: 'order-1' }, error: null });
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit,notes',
      'O-BELOW,North Farm,SKU-B,2,3,Imported batch',
    ].join('\n');
    const file = new File([csv], 'below-cost.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/below-cost\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-BELOW/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    // The first RPC is explicitly reasonless. The modal uses the locked cost
    // returned by that database attempt rather than the earlier Product read.
    expect(await screen.findByRole('heading', { name: /approve below-cost price/i })).toBeInTheDocument();
    expect(screen.getByText(/Price \$3\.00 · Cost \$9\.00 · Shortfall \$6\.00 per unit/)).toBeInTheDocument();
    const firstArgs = mocks.rpc.mock.calls[0][1] as { p_notes: string; p_idempotency_key: string };
    expect(firstArgs.p_notes).toBe('Imported batch');
    expect(firstArgs.p_notes).not.toContain('Below-cost approved');

    await approveBelowCost('price match approved by Mason');

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    const retryArgs = mocks.rpc.mock.calls[1][1] as { p_notes: string; p_idempotency_key: string };
    expect(retryArgs.p_notes).toContain('Imported batch');
    expect(retryArgs.p_notes).toContain('Below-cost approved: price match approved by Mason');
    expect(retryArgs.p_idempotency_key).toBe(firstArgs.p_idempotency_key);
  });

  it('replays the exact approved request after an ambiguous lost response', async () => {
    const onSuccess = vi.fn();
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: belowCostReasonError })
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'ETIMEDOUT', message: 'response timed out after commit' },
      })
      .mockResolvedValueOnce({ data: { order_id: 'order-committed' }, error: null });

    const { container } = renderImport({ ...defaultProps, onSuccess });
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit,notes',
      'O-RECEIPT,North Farm,SKU-B,2,3,Imported batch',
    ].join('\n');
    const file = new File([csv], 'receipt-replay.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/receipt-replay\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-RECEIPT/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));
    await approveBelowCost('receipt recovery approval');

    await screen.findByText(/failed: 1/i);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    const committedArgs = mocks.rpc.mock.calls[1][1] as {
      p_notes: string;
      p_idempotency_key: string;
    };
    expect(committedArgs.p_notes).toContain('Below-cost approved: receipt recovery approval');

    fireEvent.click(screen.getByRole('button', { name: /retry 1 failed order/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(3));
    const replayArgs = mocks.rpc.mock.calls[2][1] as {
      p_notes: string;
      p_idempotency_key: string;
    };
    expect(replayArgs.p_notes).toBe(committedArgs.p_notes);
    expect(replayArgs.p_idempotency_key).toBe(committedArgs.p_idempotency_key);
    expect(screen.queryByRole('heading', { name: /approve below-cost price/i })).not.toBeInTheDocument();
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it('attaches the approval reason only to the orders that are actually below cost', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: belowCostReasonError })
      .mockResolvedValue({ data: { order_id: 'order-1' }, error: null });
    const { container } = renderImport(defaultProps);
    // SKU-B costs 7.00 in the fixture: O-BELOW is under it, O-OK is well over.
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit,notes',
      'O-BELOW,North Farm,SKU-B,2,3,Below batch',
      'O-OK,North Farm,SKU-B,2,20,Normal batch',
    ].join('\n');
    const file = new File([csv], 'mixed-cost.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/mixed-cost\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-BELOW/);
    fireEvent.click(screen.getByRole('button', { name: /import 2 orders/i }));

    expect(await screen.findByRole('heading', { name: /approve below-cost price/i })).toBeInTheDocument();
    await approveBelowCost('clearance');

    await waitFor(() =>
      expect(mocks.rpc.mock.calls.filter(([name]) => name === 'bulk_import_order')).toHaveLength(3)
    );
    const calls = mocks.rpc.mock.calls
      .filter(([name]) => name === 'bulk_import_order')
      .map(([, args]) => args as { p_order_number: string; p_notes: string });

    const belowAttempts = calls.filter((c) => c.p_order_number === 'O-BELOW');
    const ok = calls.find((c) => c.p_order_number === 'O-OK');
    expect(belowAttempts[0]?.p_notes).toBe('Below batch');
    expect(belowAttempts[1]?.p_notes).toContain('Below-cost approved: clearance');
    // The ordinary order must NOT be stamped with an approval it never needed.
    expect(ok?.p_notes).toBe('Normal batch');
    expect(ok?.p_notes).not.toContain('Below-cost approved');
  });

  it('cancels a database challenge with Escape without closing the import or retrying', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: belowCostReasonError });
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-BELOW-CANCEL,North Farm,SKU-B,2,3',
    ].join('\n');
    const file = new File([csv], 'below-cancel.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/below-cancel\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-BELOW-CANCEL/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await screen.findByRole('heading', { name: /approve below-cost price/i });
    fireEvent.keyDown(document, { key: 'Escape' });

    await screen.findByText(/failed: 1/i);
    expect(defaultProps.onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/below-cancel\.csv/i)).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const args = mocks.rpc.mock.calls[0][1] as { p_notes?: string };
    expect(args.p_notes ?? '').not.toContain('Below-cost approved');
  });

  it('denies a sales rep instead of showing the below-cost approval prompt', async () => {
    mocks.profileRole = 'sales_rep';
    mocks.rpc.mockResolvedValueOnce({ data: null, error: belowCostAdminError });
    const { container } = renderImport(defaultProps);
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-BELOW-REP,North Farm,SKU-B,2,3',
    ].join('\n');
    const file = new File([csv], 'below-rep.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/below-rep\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-BELOW-REP/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 order/i }));

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        'error',
        expect.stringMatching(/below-cost price requires an admin/i),
      )
    );
    expect(screen.queryByLabelText(/approval reason \(required\)/i)).not.toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('keeps mixed-result failure details open while refreshing successful orders', async () => {
    const onSuccess = vi.fn();
    const onPartialSuccess = vi.fn();
    const { container } = renderImport({
      ...defaultProps,
      onSuccess,
      onPartialSuccess,
    });
    const csv = [
      'order_number,customer_name,product_name,quantity,price_per_unit',
      'O-GOOD,North Farm,SKU-B,2,20',
      'O-BAD,North Farm,Same Name,2,20',
    ].join('\n');
    const file = new File([csv], 'mixed.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await screen.findByText(/mixed\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/O-GOOD/);
    fireEvent.click(screen.getByRole('button', { name: /import 2 orders/i }));

    const failures = await screen.findByRole('list', { name: /order import failure details/i });
    expect(failures).toHaveTextContent('Order O-BAD');
    expect(onPartialSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
