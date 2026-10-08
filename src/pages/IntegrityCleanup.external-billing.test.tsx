/**
 * IntegrityCleanup.external-billing.test.tsx — a completed delivery recorded in
 * delivery_external_billings was billed outside CRX (e.g. in Chem Man), so the
 * "Completed deliveries without invoices" list must not offer to invoice it
 * again. If that record cannot be read, the list is hidden instead of shown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const state = vi.hoisted(() => ({
  externalBilling: { data: [{ delivery_id: 'd1' }], error: null } as { data: unknown; error: unknown },
}));

const DELIVERIES = [
  { id: 'd1', delivery_number: 'DEL-QB-1', order_id: 'o1', completed_at: '2026-03-20T12:00:00Z', customer: { farm_name: 'Farm A' }, items: [{ id: 'i1' }] },
  { id: 'd2', delivery_number: 'DEL-CRX-2', order_id: 'o2', completed_at: '2026-09-20T12:00:00Z', customer: { farm_name: 'Farm B' }, items: [{ id: 'i2' }] },
];

vi.mock('../lib/db', () => {
  function chainable(resolveWith: () => unknown) {
    const builder: Record<string, unknown> = {};
    const self = () => builder;
    for (const m of [
      'select', 'insert', 'update', 'delete',
      'eq', 'neq', 'gt', 'lt', 'is', 'in', 'or', 'not', 'order', 'limit', 'range', 'single',
    ]) {
      builder[m] = vi.fn(self);
    }
    builder.then = vi.fn((resolve: (v: unknown) => void) => {
      Promise.resolve(resolveWith()).then(resolve);
      return builder;
    });
    return builder;
  }
  return {
    supabase: {
      from: vi.fn((table: string) =>
        chainable(() => (table === 'deliveries' ? { data: DELIVERIES, error: null } : { data: [], error: null }))),
    },
    supabaseUntyped: {
      from: vi.fn((table: string) =>
        chainable(() => (table === 'delivery_external_billings' ? state.externalBilling : { data: [], error: null }))),
    },
    assertRpcResult: vi.fn((d: unknown) => d),
    checkMutationResult: vi.fn(),
    sanitizeError: vi.fn((e: unknown) => String(e)),
  };
});

vi.mock('../lib/deliveryInvoiceCoverage', () => ({
  fetchActiveInvoiceCoveragePages: vi.fn(async () => ({ data: [], error: null })),
  activeInvoiceCoversDelivery: vi.fn(() => false),
}));

vi.mock('../lib/deliverySplitBilling', () => ({
  fetchSplitBillingOrderIds: vi.fn(async () => ({ data: new Set<string>(), error: null })),
  SPLIT_BILLING_BLOCK_REASON: 'split',
}));

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() },
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' } }),
}));

import IntegrityCleanupPanel from '../components/integrity/IntegrityCleanupPanel';

describe('IntegrityCleanup — deliveries billed outside CRX', () => {
  beforeEach(() => {
    state.externalBilling = { data: [{ delivery_id: 'd1' }], error: null };
  });

  it('does not offer to invoice a delivery that was billed outside CRX', async () => {
    render(<IntegrityCleanupPanel />);
    expect(await screen.findByText('DEL-CRX-2', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('DEL-QB-1')).toBeNull();
    expect(screen.getAllByText('Create draft invoice')).toHaveLength(1);
  });

  it('hides the list when the billed-outside-CRX record cannot be read', async () => {
    state.externalBilling = { data: null, error: { message: 'permission denied' } };
    render(<IntegrityCleanupPanel />);
    expect(await screen.findByText('Could not verify invoice coverage — refresh to try again.', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('DEL-QB-1')).toBeNull();
    expect(screen.queryByText('DEL-CRX-2')).toBeNull();
  });
});
