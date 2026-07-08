/**
 * GettingStarted.first-cycle.test.tsx — the live "first billing cycle" tracker.
 * Verifies the admin-only progress strip renders live milestone counts and points
 * to the first unfinished step.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// quotes/orders/deliveries done; invoices + payments not yet → next step is "Invoice posted"
const COUNTS: Record<string, number> = {
  quotes: 3,
  orders: 5,
  deliveries: 2,
  invoices: 0,
  payments: 0,
};

vi.mock('../lib/db', () => {
  function chainable(count: number) {
    const builder: Record<string, unknown> = {};
    const self = () => builder;
    for (const m of ['select', 'eq', 'neq', 'in', 'not', 'is', 'or', 'gt', 'order', 'limit', 'range']) {
      builder[m] = vi.fn(self);
    }
    builder.then = vi.fn((resolve: (v: unknown) => void) => {
      Promise.resolve({ count, data: null, error: null }).then(resolve);
      return builder;
    });
    return builder;
  }
  return {
    supabase: {
      from: vi.fn((table: string) => chainable(COUNTS[table] ?? 0)),
    },
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { role: 'admin' } }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

import GettingStarted from './GettingStarted';

describe('GettingStarted — first billing cycle tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the live tracker and points to the first unfinished step', async () => {
    render(<GettingStarted />);
    await screen.findByText('Your first billing cycle');
    // counts = [3,5,2,0,0] → first zero is index 3 → "Invoice posted"
    expect(await screen.findByText(/Next step: Invoice posted\./)).toBeTruthy();
    expect(screen.getByText('Payment recorded')).toBeTruthy();
    expect(screen.getByText('Quote sent')).toBeTruthy();
  });
});
