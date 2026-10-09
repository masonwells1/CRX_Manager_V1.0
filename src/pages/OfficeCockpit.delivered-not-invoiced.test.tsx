import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// "Delivered, not invoiced" must filter BEFORE its tile limit: when the newest 50 completed
// deliveries were all billed outside CRX, an older unbilled delivery still has to show.
const BILLED_PAGE = Array.from({ length: 50 }, (_, i) => ({
  id: `billed-${i}`,
  delivery_number: `DEL-B${i}`,
  order_id: `order-b${i}`,
  completed_at: '2026-04-30T15:00:00Z',
  customer: { farm_name: 'Chem Man Farm' },
}));
const OLDER_PAGE = [{
  id: 'unbilled-1',
  delivery_number: 'DEL-UNBILLED',
  order_id: 'order-u1',
  completed_at: '2026-03-01T15:00:00Z',
  customer: { farm_name: 'Needs Invoice Farm' },
}];
const deliveryRanges: Array<[number, number]> = [];

function query(table: string) {
  const builder: Record<string, unknown> = {};
  let range: [number, number] | null = null;
  const self = () => builder;
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'in', 'gte', 'lte', 'lt', 'gt', 'not']) {
    builder[method] = vi.fn(self);
  }
  builder.range = vi.fn((from: number, to: number) => {
    range = [from, to];
    if (table === 'deliveries') deliveryRanges.push(range);
    return builder;
  });
  builder.then = vi.fn((resolve: (value: unknown) => unknown) => {
    let data: unknown[] = [];
    if (table === 'deliveries' && range) data = range[0] === 0 ? BILLED_PAGE : range[0] === 50 ? OLDER_PAGE : [];
    if (table === 'delivery_external_billings') data = BILLED_PAGE.map((d) => ({ delivery_id: d.id }));
    return Promise.resolve({ data, error: null }).then(resolve);
  });
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
vi.mock('../lib/deliveryInvoiceCoverage', async () => ({
  ...(await vi.importActual<typeof import('../lib/deliveryInvoiceCoverage')>('../lib/deliveryInvoiceCoverage')),
  fetchActiveInvoiceCoveragePages: vi.fn(() => Promise.resolve({ data: [], error: null })),
}));
vi.mock('../lib/db', async () => ({
  supabase: {
    from: vi.fn((table: string) => query(table)),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
  supabaseUntyped: {
    from: vi.fn((table: string) => query(table)),
    rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
  },
  assertRpcResult: vi.fn((data: unknown) => data),
  hasRpcCode: vi.fn(() => false),
  RpcErrorCodes: { INVOICE_ALREADY_POSTED: 'INVOICE_ALREADY_POSTED' },
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>('../lib/errorSanitizer')).sanitizeError,
}));

import OfficeCockpit from './OfficeCockpit';

describe('OfficeCockpit "Delivered, not invoiced"', () => {
  it('pages past a full page of deliveries billed outside CRX to find an older unbilled one', async () => {
    render(<OfficeCockpit />);

    expect(await screen.findByText('#DEL-UNBILLED', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('#DEL-B0')).toBeNull();
    expect(screen.queryByText('No completed deliveries need invoicing.')).toBeNull();
    expect(deliveryRanges).toEqual([[0, 49], [50, 99]]);
  });
});
