import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';

// Regression guards (Sol final gauntlet, 2026-07-17) for two shipped fixes:
//  1. A customer can never be left with no primary contact — demotion is
//     blocked in the UI AND the demoting/deactivating UPDATEs carry an
//     is_primary=false predicate so stale client state (another tab promoted
//     the contact) fails loudly at the database instead of silently demoting.
//  2. Mutations are customer-scoped (customer_id in the predicate).

const toastSpy = vi.fn();
vi.mock('../ui/Toast', () => ({
  useToast: () => ({ toast: toastSpy }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Chainable query stub that records every .update()/.eq() call per table.
type Recorded = { table: string; method: string; args: unknown[] };
const calls: Recorded[] = [];

function makeChain(table: string) {
  const chain: Record<string, unknown> = {};
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ table, method, args });
    return chain;
  };
  for (const method of ['select', 'update', 'insert', 'eq', 'is', 'order', 'limit']) {
    chain[method] = record(method);
  }
  chain.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: table === 'customer_contacts' ? [PRIMARY_CONTACT, SECONDARY_CONTACT] : [], error: null, count: null });
  return chain;
}

vi.mock('../../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/db')>();
  return {
    ...actual,
    supabase: { from: (table: string) => makeChain(table), rpc: vi.fn(async () => ({ data: { success: true }, error: null })) },
  };
});
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const PRIMARY_CONTACT = {
  id: 'contact-primary', customer_id: 'customer-1', name: 'Pat Primary', role: null,
  phone_display: '555-0001', phone_e164: '+15550001', email: null, preferred_contact_method: null,
  is_primary: true, is_active: true, can_place_orders: false, is_decision_maker: false,
  is_billing_contact: false, created_at: '2026-07-16T00:00:00Z', updated_at: '2026-07-16T00:00:00Z',
};
const SECONDARY_CONTACT = { ...PRIMARY_CONTACT, id: 'contact-secondary', name: 'Sam Secondary', is_primary: false };

import CustomerContacts from './CustomerContacts';

describe('CustomerContacts primary-protection guards', () => {
  beforeEach(() => { calls.length = 0; toastSpy.mockClear(); });
  afterEach(cleanup);

  it('blocks deactivating the primary contact before any confirm dialog', async () => {
    render(<CustomerContacts customerId="customer-1" performedBy="user-1" />);
    await waitFor(() => expect(screen.getByText('Pat Primary')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Deactivate Pat Primary'));
    expect(toastSpy).toHaveBeenCalledWith('error', expect.stringContaining('primary'));
    // No confirm dialog and no update issued for the primary.
    expect(screen.queryByText('Deactivate contact')).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'update')).toHaveLength(0);
  });

  it('deactivating a non-primary contact scopes the UPDATE by customer AND current non-primary status', async () => {
    render(<CustomerContacts customerId="customer-1" performedBy="user-1" />);
    await waitFor(() => expect(screen.getByText('Sam Secondary')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Deactivate Sam Secondary'));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'update')).toBe(true));
    const eqArgs = calls.filter((call) => call.method === 'eq').map((call) => call.args);
    // The stale-state guards: row identity, customer scope, and currently-non-primary.
    expect(eqArgs).toEqual(expect.arrayContaining([
      ['id', 'contact-secondary'],
      ['customer_id', 'customer-1'],
      ['is_primary', false],
    ]));
  });

  it('blocks unchecking primary on the primary contact (demote-by-promote only)', async () => {
    render(<CustomerContacts customerId="customer-1" performedBy="user-1" />);
    await waitFor(() => expect(screen.getByText('Pat Primary')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: /Edit/ })[0]);
    fireEvent.click(screen.getByLabelText('Primary contact') || screen.getByText('Primary contact'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Contact' }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('error', expect.stringContaining('promote another contact')));
    expect(calls.filter((call) => call.method === 'update')).toHaveLength(0);
  });
});
