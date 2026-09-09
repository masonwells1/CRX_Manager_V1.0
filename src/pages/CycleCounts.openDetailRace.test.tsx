/**
 * CycleCounts.openDetailRace.test.tsx
 *
 * Opening count A and then count B can let A's slower item query resolve LAST.
 * Before the request token, `setCountItems` ran unguarded, so A's rows were
 * painted while `activeCount` was B — and `updateCountedQty` derives `p_item_id`
 * from exactly that state, so an inventory adjustment could be sent against a
 * different count's item than the one on screen.
 *
 * This branch made that window WIDER than `main`: `main` reaches `setCountItems`
 * after one await, and the revision seed read added a second. `setActiveCount`
 * was guarded by id while `setCountItems` was not, which made the function read
 * as protected — one half of a pairing, the shape this branch kept finding
 * elsewhere. (CodeRabbit on de2c43a83.)
 *
 * Drives the real page: click row A, click row B, then release A's query last.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';

const COUNT_A = '11111111-1111-4111-8111-111111111111';
const COUNT_B = '22222222-2222-4222-8222-222222222222';

const H = vi.hoisted(() => ({ toast: vi.fn(), rpc: vi.fn() }));

const counts = [
  {
    id: COUNT_A,
    count_number: 'CC-1001',
    warehouse: 'Main Warehouse',
    status: 'in_progress',
    item_revision: 1,
    initiated_by: null,
    completed_by: null,
    created_at: '2026-09-01T00:00:00Z',
    items: [],
  },
  {
    id: COUNT_B,
    count_number: 'CC-2002',
    warehouse: 'Main Warehouse',
    status: 'in_progress',
    item_revision: 1,
    initiated_by: null,
    completed_by: null,
    created_at: '2026-09-02T00:00:00Z',
    items: [],
  },
];

const itemsFor: Record<string, unknown[]> = {
  [COUNT_A]: [{
    id: 'item-a', cycle_count_id: COUNT_A, product_id: 'p-a', expected_qty: 10,
    counted_qty: null, variance: null, is_counted: false,
    product: { product_name: 'ALPHA PRODUCT' },
  }],
  [COUNT_B]: [{
    id: 'item-b', cycle_count_id: COUNT_B, product_id: 'p-b', expected_qty: 20,
    counted_qty: null, variance: null, is_counted: false,
    product: { product_name: 'BRAVO PRODUCT' },
  }],
};

// Item queries are held open per count id so the test controls resolution order.
let heldItemQueries: Record<string, (value: unknown) => void> = {};

vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const builder = (table: string) => {
    let scopedId: string | null = null;
    const result = () => {
      if (table === 'cycle_counts') return Promise.resolve({ data: counts, error: null });
      return Promise.resolve({ data: [], error: null });
    };
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') {
          // `cycle_count_items` scoped to a count id is the awaited detail load.
          if (table === 'cycle_count_items' && scopedId) {
            const id = scopedId;
            return (resolve: (v: unknown) => void) => {
              const pending = new Promise((r) => { heldItemQueries[id] = r; });
              return pending.then(() => resolve({ data: itemsFor[id], error: null }));
            };
          }
          return (resolve: (v: unknown) => void) => result().then(resolve);
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => {
            if (table === 'cycle_counts' && scopedId) {
              return Promise.resolve({ data: { item_revision: 1 }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          };
        }
        return (...args: unknown[]) => {
          if (typeof args[1] === 'string' && (args[0] === 'cycle_count_id' || args[0] === 'id')) {
            scopedId = args[1] as string;
          }
          return proxy;
        };
      },
      apply() { return proxy; },
    });
    return proxy;
  };
  return {
    ...actual,
    supabase: { from: (table: string) => builder(table), rpc: H.rpc },
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', profile: { id: 'admin-1', full_name: 'Admin' } }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

const STABLE_TOAST = { toast: H.toast };
vi.mock('../components/ui/Toast', () => ({
  useToast: () => STABLE_TOAST,
  ToastProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../lib/sentry', () => ({ Sentry: new Proxy({}, { get: () => () => undefined }) }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

const { default: CycleCounts } = await import('./CycleCounts');

describe('CycleCounts openDetail race', () => {
  beforeEach(() => {
    heldItemQueries = {};
    H.toast.mockReset();
    H.rpc.mockReset();
  });
  afterEach(() => cleanup());

  it('does not paint an earlier count rows when its query resolves last', async () => {
    render(<CycleCounts />);

    // Open count A. Its item query is held open.
    await waitFor(() => expect(screen.getByText('CC-1001')).toBeTruthy());
    fireEvent.click(screen.getByText('CC-1001'));
    await waitFor(() => expect(heldItemQueries[COUNT_A]).toBeTruthy());

    // Open count B before A answers, and let B finish.
    fireEvent.click(screen.getByText('CC-2002'));
    await waitFor(() => expect(heldItemQueries[COUNT_B]).toBeTruthy());
    await act(async () => { heldItemQueries[COUNT_B]?.(null); });
    await waitFor(() => expect(screen.getByText('BRAVO PRODUCT')).toBeTruthy());

    // Now A's older query finally answers.
    await act(async () => { heldItemQueries[COUNT_A]?.(null); });

    // B is on screen, so B's rows must stay. A's rows appearing here is the defect:
    // the operator would be editing ALPHA's item while the screen says CC-2002, and
    // updateCountedQty would send that item's id.
    await waitFor(() => expect(screen.getByText('BRAVO PRODUCT')).toBeTruthy());
    expect(screen.queryByText('ALPHA PRODUCT')).toBeNull();
  });
});
