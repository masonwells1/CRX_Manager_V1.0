/**
 * IntegrityCleanup.sentinel-alerts.test.tsx — the new "Data-integrity alerts"
 * section that surfaces the daily sentinel's findings (integrity_alerts) in
 * plain English on the admin Integrity Cleanup page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const ALERT = {
  id: 'alert-1',
  alert_type: 'negative_invoice_balance',
  entity_table: 'invoices',
  entity_id: 'inv-1',
  details: { invoice_number: 'INV-100', status: 'posted', balance_cents: -500 },
  detected_at: '2026-07-06T12:00:00Z',
};

vi.mock('../lib/db', () => {
  function chainable(resolveWith: unknown) {
    const builder: Record<string, unknown> = {};
    const self = () => builder;
    for (const m of [
      'select', 'insert', 'update', 'delete',
      'eq', 'neq', 'gt', 'lt', 'is', 'in', 'or', 'not', 'order', 'limit', 'range', 'single',
    ]) {
      builder[m] = vi.fn(self);
    }
    builder.then = vi.fn((resolve: (v: unknown) => void) => {
      Promise.resolve(resolveWith).then(resolve);
      return builder;
    });
    return builder;
  }
  return {
    // Business-cleanup queries all resolve empty; only the sentinel query has a row.
    supabase: { from: vi.fn(() => chainable({ data: [], error: null })) },
    supabaseUntyped: { from: vi.fn(() => chainable({ data: [ALERT], error: null })) },
    assertRpcResult: vi.fn((d: unknown) => d),
    checkMutationResult: vi.fn(),
  };
});

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

describe('IntegrityCleanup — data-integrity sentinel alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces open integrity alerts in plain English with a resolve action', async () => {
    render(<IntegrityCleanupPanel />);
    await screen.findByText('Data-integrity alerts');
    expect(await screen.findByText('Negative invoice balance')).toBeTruthy();
    // details rendered as "Invoice INV-100 — balance $-5.00 (posted)"
    expect(screen.getByText(/INV-100/)).toBeTruthy();
    expect(screen.getByText('Mark resolved')).toBeTruthy();
  });
});
