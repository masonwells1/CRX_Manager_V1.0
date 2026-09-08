/**
 * CycleCounts.completionRace.test.tsx
 *
 * The COMPLETION path had the same stale-write hole the open path did, and the
 * fix for the open path did not cover it. (CodeRabbit on 7e98858cb, PR #535.)
 *
 * `handleComplete` -> `waitForAuthoritativeCountItems` -> `refreshCountItems`
 * ends in `setCountItems(rows)` after two awaits. The detail modal's close
 * handler only hid the modal — it did not end the session or cancel the
 * in-flight completion — so:
 *
 *   open count A -> click Complete -> close the modal while it loads ->
 *   open count B -> A's refresh resolves LAST -> A's rows paint under B
 *
 * `updateCountedQty` derives `p_item_id` from exactly that state, so the
 * operator's next edit adjusts inventory for a product they are not looking at.
 * This is the same defect the open-path test covers, reached through a function
 * that token never guarded — the guard pinned one half of a pairing.
 *
 * Drives the real page. Both halves are asserted: the stale rows must not paint,
 * AND the superseded completion must not commit an inventory adjustment.
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

// Every item is already counted so the completion runs straight through instead
// of stopping at the "complete anyway?" confirmation.
const itemsFor: Record<string, unknown[]> = {
  [COUNT_A]: [{
    id: 'item-a', cycle_count_id: COUNT_A, product_id: 'p-a', expected_qty: 10,
    counted_qty: 10, variance: 0, is_counted: true,
    product: { product_name: 'ALPHA PRODUCT' },
  }],
  [COUNT_B]: [{
    id: 'item-b', cycle_count_id: COUNT_B, product_id: 'p-b', expected_qty: 20,
    counted_qty: 20, variance: 0, is_counted: true,
    product: { product_name: 'BRAVO PRODUCT' },
  }],
};

// Item queries are held open IN ORDER so the test controls resolution. A single
// count is loaded more than once here (open, then the completion refresh), so
// these cannot be keyed by count id alone the way the open-path test does.
type HeldQuery = { countId: string; release: (value: unknown) => void };
let heldItemQueries: HeldQuery[] = [];

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
          if (table === 'cycle_count_items' && scopedId) {
            const id = scopedId;
            return (resolve: (v: unknown) => void) => {
              const pending = new Promise((r) => {
                heldItemQueries.push({ countId: id, release: r });
              });
              return pending.then(() => resolve({ data: itemsFor[id], error: null }));
            };
          }
          return (resolve: (v: unknown) => void) => result().then(resolve);
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => {
            if (table === 'cycle_counts' && scopedId) {
              // Serves both the openDetail revision seed and the completion's
              // authoritative revision read; status must be in_progress or
              // completion stops before it ever reaches refreshCountItems.
              return Promise.resolve({
                data: { item_revision: 1, status: 'in_progress' },
                error: null,
              });
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

/** Release the Nth held item query (0-based) and let React flush. */
async function release(index: number) {
  const held = heldItemQueries[index];
  expect(held, `expected a held item query at index ${index}`).toBeTruthy();
  await act(async () => { held.release(null); });
}

describe('CycleCounts completion race', () => {
  beforeEach(() => {
    heldItemQueries = [];
    H.toast.mockReset();
    H.rpc.mockReset();
    H.rpc.mockResolvedValue({ data: null, error: null });
  });
  afterEach(() => cleanup());

  it('does not paint a closed count rows when its completion refresh resolves last', async () => {
    render(<CycleCounts />);

    // Open count A and let it finish, so the operator is genuinely looking at it.
    await waitFor(() => expect(screen.getByText('CC-1001')).toBeTruthy());
    fireEvent.click(screen.getByText('CC-1001'));
    await waitFor(() => expect(heldItemQueries.length).toBe(1));
    await release(0);
    await waitFor(() => expect(screen.getByText('ALPHA PRODUCT')).toBeTruthy());

    // Start completing A. Its authoritative refresh is held open.
    fireEvent.click(screen.getByText(/Complete & Apply Adjustments/));
    await waitFor(() => expect(heldItemQueries.length).toBe(2));
    expect(heldItemQueries[1].countId).toBe(COUNT_A);

    // The operator closes the modal mid-completion and opens count B. Closing is
    // the step the old code treated as cosmetic: it hid the modal but left A's
    // completion running and its session current.
    fireEvent.click(screen.getByLabelText('Close'));
    fireEvent.click(screen.getByText('CC-2002'));
    await waitFor(() => expect(heldItemQueries.length).toBe(3));
    await release(2);
    await waitFor(() => expect(screen.getByText('BRAVO PRODUCT')).toBeTruthy());

    // Now A's completion refresh finally answers, with B on screen.
    await release(1);

    // B's rows must stay. ALPHA appearing here is the defect: the screen says
    // CC-2002 while updateCountedQty would send ALPHA's item id.
    await waitFor(() => expect(screen.getByText('BRAVO PRODUCT')).toBeTruthy());
    expect(screen.queryByText('ALPHA PRODUCT')).toBeNull();

    // And the superseded completion must not have moved inventory for a count the
    // operator walked away from.
    const completionCalls = H.rpc.mock.calls.filter((call) => call[0] === 'complete_cycle_count');
    expect(completionCalls).toEqual([]);
  });
});
