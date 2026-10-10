import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// The page-wide "All clear!" banner may only show when every cockpit query loaded.
let failTable: string | null = null;

function query(table: string) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'range', 'in', 'gte', 'lte', 'lt', 'gt', 'not']) {
    builder[method] = vi.fn(self);
  }
  builder.then = vi.fn((resolve: (value: unknown) => unknown) =>
    Promise.resolve(table === failTable
      ? { data: null, error: { message: `${table} unavailable` } }
      : { data: [], error: null }).then(resolve));
  return builder;
}

const stableNavigate = vi.fn();
const stableToast = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => stableNavigate }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { role: 'admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: stableToast }) }));
vi.mock('../lib/idempotency', () => ({ generateIdempotencyKey: vi.fn(() => 'key') }));
vi.mock('../lib/criticalAction', () => ({ runCriticalAction: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/db', async () => ({
  supabase: {
    from: vi.fn((table: string) => query(table)),
    rpc: vi.fn((name: string) => Promise.resolve({ data: name === 'get_watchdog_flags' ? [] : null, error: null })),
  },
  supabaseUntyped: {
    from: vi.fn((table: string) => query(table)),
    rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
  },
  assertRpcResult: vi.fn((data: unknown) => data ?? []),
  hasRpcCode: vi.fn(() => false),
  RpcErrorCodes: { INVOICE_ALREADY_POSTED: 'INVOICE_ALREADY_POSTED' },
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>('../lib/errorSanitizer')).sanitizeError,
}));

import OfficeCockpit from './OfficeCockpit';

describe('OfficeCockpit "All clear!" banner', () => {
  it('shows when every query loads and nothing needs attention', async () => {
    failTable = null;
    render(<OfficeCockpit />);
    expect(await screen.findByText('All clear!', {}, { timeout: 5000 })).toBeTruthy();
  });

  it('stays hidden when a query fails, even with nothing to show', async () => {
    failTable = 'jobs';
    render(<OfficeCockpit />);
    // Wait until the load has finished (this tile renders only after a successful delivery check).
    await screen.findByText('No completed deliveries need invoicing.', {}, { timeout: 5000 });
    expect(screen.queryByText('All clear!')).toBeNull();
  });
});
