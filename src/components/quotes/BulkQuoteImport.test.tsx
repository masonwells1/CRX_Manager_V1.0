/**
 * BulkQuoteImport.test.tsx — Basic render + behavior tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => {
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

  return {
    chainable,
    from: vi.fn((table: string) => {
      const dataByTable: Record<string, unknown[]> = {
        customers: [{ id: 'customer-1', farm_name: 'North Farm' }],
        products: [{ id: 'product-1', product_name: 'Roundup', sku: 'RU-1', current_cost: 10, inventory_unit: 'Gallon', unit_size: null }],
        unit_conversions: [{ unit: 'oz', factor_oz: 1 }, { unit: 'Gallon', factor_oz: 128 }],
      };
      return chainable({ data: dataByTable[table] ?? [], error: null });
    }),
    rpc: vi.fn((_name: string, _args: Record<string, unknown>) => Promise.resolve({ data: { quote_id: 'quote-1' }, error: null })),
    assertRpcResult: vi.fn((data: unknown) => data),
    logActivity: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../lib/db', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  assertRpcResult: mocks.assertRpcResult,
}));

vi.mock('../../lib/sentry', () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: mocks.logActivity,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', full_name: 'Test User' },
  }),
}));

vi.mock('../../lib/documentOCR', () => ({
  processDocumentWithOCR: vi.fn(),
  isCSVFile: vi.fn(() => true),
  isOCRSupported: vi.fn(() => false),
}));

vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import BulkQuoteImport from './BulkQuoteImport';

describe('BulkQuoteImport', () => {
  const defaultProps = { open: true, onClose: vi.fn(), onSuccess: vi.fn() };
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('renders when open', () => {
    render(<BulkQuoteImport {...defaultProps} />);
    expect(screen.getByText(/bulk quote/i)).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<BulkQuoteImport {...defaultProps} open={false} />);
    expect(screen.queryByText(/bulk quote/i)).not.toBeInTheDocument();
  });

  it('shows file upload instructions', () => {
    render(<BulkQuoteImport {...defaultProps} />);
    expect(screen.getByText(/csv/i)).toBeInTheDocument();
  });

  it('routes uploaded quotes through save_quote instead of direct lifecycle table inserts', async () => {
    const onSuccess = vi.fn();
    const { container } = render(<BulkQuoteImport {...defaultProps} onSuccess={onSuccess} />);
    const csv = [
      'quote_number,customer_farm_name,section_name,product_name,acres,price_per_unit,oz_per_acre,rate_unit,status',
      'Q-100,North Farm,Spring,Roundup,10,20,32,Pint,draft',
    ].join('\n');
    const file = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await screen.findByText(/Q-100/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('save_quote', expect.objectContaining({
      p_quote_id: null,
      p_performed_by: 'user-1',
      p_idempotency_key: expect.stringContaining('save_quote_bulk_import'),
    })));
    const saveQuoteArgs = mocks.rpc.mock.calls.find(([rpcName]) => rpcName === 'save_quote')?.[1] as {
      p_quote_payload: { quote_number: string; status: string };
      p_sections: Array<{ items: Array<Record<string, unknown>> }>;
    };
    expect(saveQuoteArgs.p_quote_payload).toEqual(expect.objectContaining({
      quote_number: 'Q-100',
      status: 'draft',
    }));
    expect(saveQuoteArgs.p_sections[0].items[0]).toEqual(expect.objectContaining({
      actual_rate: 32,
      rate_unit: 'oz',
      price_per_unit: 20,
      price_override: 20,
    }));
    expect(mocks.assertRpcResult).toHaveBeenCalledWith({ quote_id: 'quote-1' }, 'save_quote');
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      event: 'quote_bulk_imported',
      performedBy: 'user-1',
      entityType: 'quote',
      entityId: 'quote-1',
      customerId: 'customer-1',
    }));
    expect(mocks.from).not.toHaveBeenCalledWith('quotes');
    expect(mocks.from).not.toHaveBeenCalledWith('quote_sections');
    expect(mocks.from).not.toHaveBeenCalledWith('quote_items');
    expect(onSuccess).toHaveBeenCalled();
  });

  it('uses one canonical quote identity for casing and spacing variants', async () => {
    const { container } = render(<BulkQuoteImport {...defaultProps} />);
    const csv = [
      'quote_number,customer_farm_name,section_name,product_name,acres,price_per_unit,oz_per_acre,status',
      ' q-500 ,North Farm,Spring,Roundup,10,20,32,draft',
      'Q-500,North Farm,Spring,Roundup,5,20,32,draft',
    ].join('\n');
    const file = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await screen.findAllByText(/Q-500/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('save_quote', expect.anything()));
    const saveQuoteArgs = mocks.rpc.mock.calls.find(([rpcName]) => rpcName === 'save_quote')?.[1] as {
      p_idempotency_key: string;
      p_quote_payload: { quote_number: string };
      p_sections: Array<{ items: Array<Record<string, unknown>> }>;
    };
    expect(saveQuoteArgs.p_quote_payload.quote_number).toBe('Q-500');
    expect(saveQuoteArgs.p_idempotency_key).toContain('Q-500');
    expect(saveQuoteArgs.p_sections[0].items).toHaveLength(2);
  });

  it('rejects normalized quote groups that reference multiple customers', async () => {
    mocks.from
      .mockImplementationOnce(() => mocks.chainable({
        data: [
          { id: 'customer-1', farm_name: 'North Farm' },
          { id: 'customer-2', farm_name: 'South Farm' },
        ],
        error: null,
      }))
      .mockImplementationOnce(() => mocks.chainable({
        data: [{ id: 'product-1', product_name: 'Roundup', sku: 'RU-1', current_cost: 10, inventory_unit: 'Gallon', unit_size: null }],
        error: null,
      }))
      .mockImplementationOnce(() => mocks.chainable({
        data: [{ unit: 'oz', factor_oz: 1 }, { unit: 'Gallon', factor_oz: 128 }],
        error: null,
      }));
    const onSuccess = vi.fn();
    const { container } = render(<BulkQuoteImport {...defaultProps} onSuccess={onSuccess} />);
    const csv = [
      'quote_number,customer_farm_name,section_name,product_name,acres,price_per_unit,oz_per_acre,status',
      ' q-525 ,North Farm,Spring,Roundup,10,20,32,draft',
      'Q-525,South Farm,Spring,Roundup,5,20,32,draft',
    ].join('\n');
    const file = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await screen.findAllByText(/Q-525/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));

    await screen.findByText(/Rows reference multiple customers - North Farm, South Farm/);
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('uses product unit_size when inventory_unit is blank', async () => {
    mocks.from
      .mockImplementationOnce(() => mocks.chainable({
        data: [{ id: 'customer-1', farm_name: 'North Farm' }],
        error: null,
      }))
      .mockImplementationOnce(() => mocks.chainable({
        data: [{ id: 'product-1', product_name: 'Roundup', sku: 'RU-1', current_cost: 10, inventory_unit: null, unit_size: 'Gallon' }],
        error: null,
      }))
      .mockImplementationOnce(() => mocks.chainable({
        data: [{ unit: 'oz', factor_oz: 1 }, { unit: 'Gallon', factor_oz: 128 }],
        error: null,
      }));
    const { container } = render(<BulkQuoteImport {...defaultProps} />);
    const csv = [
      'quote_number,customer_farm_name,product_name,acres,price_per_unit,oz_per_acre,status',
      'Q-550,North Farm,Roundup,10,20,32,draft',
    ].join('\n');
    const file = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await screen.findByText(/Q-550/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('save_quote', expect.anything()));
    expect(screen.queryByText(/Unsupported inventory unit/i)).not.toBeInTheDocument();
  });

  it('uses a different retry key when the same quote number has changed payload content', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'dropped response' } } as never)
      .mockResolvedValueOnce({ data: { quote_id: 'quote-1' }, error: null });
    const { container } = render(<BulkQuoteImport {...defaultProps} />);
    const firstCsv = [
      'quote_number,customer_farm_name,product_name,acres,price_per_unit,oz_per_acre,status',
      'Q-800,North Farm,Roundup,10,20,32,draft',
    ].join('\n');
    const secondCsv = [
      'quote_number,customer_farm_name,product_name,acres,price_per_unit,oz_per_acre,status',
      'Q-800,North Farm,Roundup,10,21,32,draft',
    ].join('\n');
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();

    const firstFile = new File([firstCsv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(firstFile, 'text', { value: () => Promise.resolve(firstCsv) });
    fireEvent.change(input as HTMLInputElement, { target: { files: [firstFile] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/Q-800/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));
    await screen.findByText(/dropped response/);

    const firstSaveQuoteArgs = mocks.rpc.mock.calls.find(([rpcName]) => rpcName === 'save_quote')?.[1] as {
      p_idempotency_key: string;
    };

    const closeButtons = screen.getAllByRole('button', { name: /close/i });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    const retryInput = container.querySelector('input[type="file"]');
    expect(retryInput).toBeTruthy();
    const secondFile = new File([secondCsv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(secondFile, 'text', { value: () => Promise.resolve(secondCsv) });
    fireEvent.change(retryInput as HTMLInputElement, { target: { files: [secondFile] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/Q-800/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));

    await waitFor(() => expect(mocks.rpc.mock.calls.filter(([rpcName]) => rpcName === 'save_quote')).toHaveLength(2));
    const saveQuoteCalls = mocks.rpc.mock.calls.filter(([rpcName]) => rpcName === 'save_quote');
    const secondSaveQuoteArgs = saveQuoteCalls[1][1] as { p_idempotency_key: string };
    expect(firstSaveQuoteArgs.p_idempotency_key).toContain('Q-800');
    expect(secondSaveQuoteArgs.p_idempotency_key).toContain('Q-800');
    expect(secondSaveQuoteArgs.p_idempotency_key).not.toBe(firstSaveQuoteArgs.p_idempotency_key);
  });

  it('reuses the retry key when the same failed import is reselected later', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(new Date('2026-01-01T00:00:00.000Z').getTime())
      .mockReturnValueOnce(new Date('2026-01-02T00:00:00.000Z').getTime());
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'dropped response' } } as never)
      .mockResolvedValueOnce({ data: { quote_id: 'quote-1' }, error: null });
    const { container } = render(<BulkQuoteImport {...defaultProps} />);
    const csv = [
      'quote_number,customer_farm_name,product_name,acres,price_per_unit,oz_per_acre,status',
      'Q-825,North Farm,Roundup,10,20,32,draft',
    ].join('\n');
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();

    const firstFile = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(firstFile, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(input as HTMLInputElement, { target: { files: [firstFile] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/Q-825/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));
    await screen.findByText(/dropped response/);

    const firstSaveQuoteArgs = mocks.rpc.mock.calls.find(([rpcName]) => rpcName === 'save_quote')?.[1] as {
      p_idempotency_key: string;
    };

    const closeButtons = screen.getAllByRole('button', { name: /close/i });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    const retryInput = container.querySelector('input[type="file"]');
    expect(retryInput).toBeTruthy();
    const secondFile = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(secondFile, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(retryInput as HTMLInputElement, { target: { files: [secondFile] } });
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));
    await screen.findByText(/Q-825/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));

    await waitFor(() => expect(mocks.rpc.mock.calls.filter(([rpcName]) => rpcName === 'save_quote')).toHaveLength(2));
    const saveQuoteCalls = mocks.rpc.mock.calls.filter(([rpcName]) => rpcName === 'save_quote');
    const secondSaveQuoteArgs = saveQuoteCalls[1][1] as { p_idempotency_key: string };
    expect(firstSaveQuoteArgs.p_idempotency_key).toContain('Q-825');
    expect(secondSaveQuoteArgs.p_idempotency_key).toBe(firstSaveQuoteArgs.p_idempotency_key);
  });

  it('does not fail an acknowledged import when activity logging fails', async () => {
    mocks.logActivity.mockRejectedValueOnce(new Error('activity down'));
    const onSuccess = vi.fn();
    const { container } = render(<BulkQuoteImport {...defaultProps} onSuccess={onSuccess} />);
    const csv = [
      'quote_number,customer_farm_name,product_name,acres,price_per_unit,oz_per_acre,status',
      'Q-600,North Farm,Roundup,10,20,32,draft',
    ].join('\n');
    const file = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await screen.findByText(/Q-600/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));

    await screen.findByText(/Successfully imported 1 quote/);
    expect(screen.getByText(/Quote Q-600: Created with 1 items/)).toBeInTheDocument();
    expect(onSuccess).toHaveBeenCalled();
  });

  it('rejects a quote when any grouped product is unknown', async () => {
    const onSuccess = vi.fn();
    const { container } = render(<BulkQuoteImport {...defaultProps} onSuccess={onSuccess} />);
    const csv = [
      'quote_number,customer_farm_name,product_name,acres,price_per_unit,oz_per_acre,status',
      'Q-300,North Farm,Roundup,10,20,32,draft',
      'Q-300,North Farm,Missing Product,10,20,32,draft',
    ].join('\n');
    const file = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await screen.findAllByText(/Q-300/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));

    await screen.findByText(/Product\(s\) not found - Missing Product/);
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('rejects unsupported unit conversions before calling save_quote', async () => {
    const onSuccess = vi.fn();
    const { container } = render(<BulkQuoteImport {...defaultProps} onSuccess={onSuccess} />);
    const csv = [
      'quote_number,customer_farm_name,product_name,acres,price_per_unit,actual_rate,rate_unit,status',
      'Q-700,North Farm,Roundup,10,20,2,Jug,draft',
    ].join('\n');
    const file = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await screen.findByText(/Q-700/);
    fireEvent.click(screen.getByRole('button', { name: /import 1 quote/i }));

    await screen.findByText(/Unsupported rate unit "Jug"/);
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('rejects non-draft quote status during parse', async () => {
    const { container } = render(<BulkQuoteImport {...defaultProps} />);
    const csv = [
      'quote_number,customer_farm_name,product_name,status',
      'Q-200,North Farm,Roundup,sent',
    ].join('\n');
    const file = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await screen.findByText(/unsupported status/i);
    expect(screen.getByText(/draft quotes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import 0 quote/i })).toBeDisabled();
  });

  it('rejects the whole quote when one grouped row is invalid', async () => {
    const { container } = render(<BulkQuoteImport {...defaultProps} />);
    const csv = [
      'quote_number,customer_farm_name,product_name,acres,status',
      'Q-400,North Farm,Roundup,10,draft',
      'Q-400,North Farm,Roundup,10,accepted',
    ].join('\n');
    const file = new File([csv], 'quotes.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
    await screen.findByText(/quotes\.csv/i);
    fireEvent.click(screen.getByRole('button', { name: /parse file/i }));

    await screen.findByText(/unsupported status/i);
    expect(screen.getByText(/another invalid row/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import 0 quote/i })).toBeDisabled();
    expect(mocks.rpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
  });
});
