import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';

// Remove goes through soft_delete_customer_document (20260921180000), not a
// direct UPDATE: the rep SELECT policy hides soft-deleted rows, so PostgreSQL
// refused a rep's UPDATE that produced one. These tests pin the caller side:
// the RPC is used, its key survives an uncertain failure, and a definitive
// refusal retires it. The database side is proven by
// scripts/smoke/prove-customer-document-rep-soft-delete-real-schema.mjs.

const toastSpy = vi.fn();
vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'rep-1', role: 'sales_rep' } }),
}));

const DOCUMENT = {
  id: 'doc-1', customer_id: 'customer-1', document_type: 'license',
  storage_path: 'customer-1/doc-1.pdf', filename: 'License.pdf', mime_type: 'application/pdf',
  size_bytes: 1024, effective_date: null, expiration_date: null, notes: null,
  created_at: '2026-09-21T00:00:00Z',
};

type Recorded = { method: string; args: unknown[] };
const fromCalls: { table: string; recorded: Recorded[] }[] = [];
let documentRows: unknown[] = [DOCUMENT];

function makeChain(table: string) {
  const entry = { table, recorded: [] as Recorded[] };
  fromCalls.push(entry);
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'update', 'insert', 'eq', 'is', 'order', 'maybeSingle', 'single']) {
    chain[method] = (...args: unknown[]) => { entry.recorded.push({ method, args }); return chain; };
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve(
    table === 'customers'
      ? { data: { assigned_sales_rep: 'rep-1' }, error: null }
      : { data: documentRows, error: null },
  );
  return chain;
}

const rpcMock = vi.fn();
vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>();
  return {
    ...actual,
    supabase: { from: (table: string) => makeChain(table), rpc: (...args: unknown[]) => rpcMock(...args) },
  };
});
const logActivityMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../../lib/activityLogger', () => ({ logActivity: (...args: unknown[]) => logActivityMock(...args) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import CustomerDocuments from './CustomerDocuments';

const success = { data: { success: true, document_id: 'doc-1', customer_id: 'customer-1', deleted_at: '2026-09-21T12:00:00Z' }, error: null };
const keysSent = () => rpcMock.mock.calls.map((call) => (call[1] as { p_idempotency_key: string }).p_idempotency_key);

async function confirmRemove() {
  fireEvent.click(await screen.findByLabelText('Remove License.pdf'));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove document' }));
}

describe('CustomerDocuments Remove', () => {
  beforeEach(() => {
    fromCalls.length = 0;
    documentRows = [DOCUMENT];
    rpcMock.mockReset();
    toastSpy.mockClear();
    logActivityMock.mockClear();
  });
  afterEach(cleanup);

  it('removes through soft_delete_customer_document, never a direct UPDATE', async () => {
    rpcMock.mockResolvedValueOnce(success);
    render(<CustomerDocuments customerId="customer-1" userId="rep-1" />);
    await confirmRemove();

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('success', 'Document removed'));
    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [name, args] = rpcMock.mock.calls[0] as [string, { p_document_id: string; p_idempotency_key: string }];
    expect(name).toBe('soft_delete_customer_document');
    expect(args.p_document_id).toBe('doc-1');
    expect(args.p_idempotency_key).toMatch(/^soft_delete_customer_document:rep-1:/);
    expect(fromCalls.some((call) => call.recorded.some((r) => r.method === 'update'))).toBe(false);
    expect(logActivityMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'document_removed', entityId: 'doc-1' }));
    expect(screen.queryByText('License.pdf')).not.toBeInTheDocument();
  });

  it('keeps the same key after an uncertain failure so the retry replays the receipt', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } })
      .mockResolvedValueOnce(success);
    render(<CustomerDocuments customerId="customer-1" userId="rep-1" />);
    await confirmRemove();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('error', 'Failed to remove document'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove document' }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('success', 'Document removed'));
    const [first, second] = keysSent();
    expect(second).toBe(first);
  });

  it('retires the key after a definitive refusal', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'INSUFFICIENT_ROLE: Only active admins and sales reps can remove customer documents' } })
      .mockResolvedValueOnce(success);
    render(<CustomerDocuments customerId="customer-1" userId="rep-1" />);
    await confirmRemove();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('error', 'Failed to remove document'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove document' }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('success', 'Document removed'));
    const [first, second] = keysSent();
    expect(second).not.toBe(first);
  });

  it('treats CUSTOMER_DOCUMENT_NOT_FOUND as already gone and reloads the list', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found' } });
    render(<CustomerDocuments customerId="customer-1" userId="rep-1" />);
    await screen.findByText('License.pdf');
    const loadsBefore = fromCalls.filter((call) => call.table === 'customer_documents').length;
    documentRows = [];
    await confirmRemove();

    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('error', 'That document was already removed or is no longer available.'));
    await waitFor(() => expect(fromCalls.filter((call) => call.table === 'customer_documents').length).toBeGreaterThan(loadsBefore));
    expect(await screen.findByText('No documents have been uploaded yet.')).toBeInTheDocument();
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it('accepts a confirmation whose ids differ only in letter case', async () => {
    rpcMock.mockResolvedValueOnce({ data: { ...success.data, customer_id: 'CUSTOMER-1', document_id: 'DOC-1' }, error: null });
    render(<CustomerDocuments customerId="customer-1" userId="rep-1" />);
    await confirmRemove();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('success', 'Document removed'));
  });

  it.each([
    ['a different document', { document_id: 'doc-other' }],
    ['a different customer', { customer_id: 'customer-other' }],
  ])('refuses a success that confirms %s', async (_label, override) => {
    rpcMock.mockResolvedValueOnce({ data: { ...success.data, ...override }, error: null });
    render(<CustomerDocuments customerId="customer-1" userId="rep-1" />);
    await confirmRemove();
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('error', 'The server confirmed a different document; refresh and try again.'));
    expect(logActivityMock).not.toHaveBeenCalled();
    expect(screen.getByText('License.pdf')).toBeInTheDocument();
  });
});
