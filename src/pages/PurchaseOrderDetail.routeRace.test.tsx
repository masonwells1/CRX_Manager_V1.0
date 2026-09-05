/**
 * PurchaseOrderDetail — route-currency race.
 *
 * READY TO LAND at src/pages/PurchaseOrderDetail.routeRace.test.tsx
 * (blocked only by the hold latch; unverified — has never been run).
 *
 * React Router reuses this component when only the :id param changes, so a
 * query started for PO A can resolve after the operator has already navigated
 * to PO B. Before the fix, PO A's line-item query landing last overwrote
 * `items` while `po` stayed B: the screen showed B's PO number above A's line
 * items, and a receive submitted from there carried A's `po_item_id` values.
 * `receive_po_items` derives the affected PO from the submitted item ids and
 * has no expected-PO parameter, so the goods were booked against PO A while
 * the operator believed they were receiving PO B.
 *
 * This suite stubs `@supabase/supabase-js` rather than `../lib/db`, so the REAL
 * db.ts runs and the REAL `assertRpcResult` and `sanitizeError` are exercised.
 * Stubbing `assertRpcResult` as a passthrough (`(d) => d`) would silently delete
 * the ambiguous-reply path from every test in this file.
 *
 * Each guard gets its own test, so removing one guard turns exactly one test
 * red. A guard whose failure is carried by a neighbouring guard is untested.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const harness = vi.hoisted(() => {
  // db.ts throws at import when these are missing, and it must import for real.
  const metaEnv = (import.meta as unknown as { env: Record<string, string> }).env;
  metaEnv.VITE_SUPABASE_URL = 'http://route-race.test';
  metaEnv.VITE_SUPABASE_ANON_KEY = 'route-race-anon-key';
  return {
    impl: null as null | {
      from: (table: string) => unknown;
      rpc: (name: string, args: unknown) => unknown;
    },
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => harness.impl!.from(table),
    rpc: (name: string, args: unknown) => harness.impl!.rpc(name, args),
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  }),
}));

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  resetKey: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'admin-1', full_name: 'Admin' },
  }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({
    getKey: () => 'idem-1',
    resetKey: mocks.resetKey,
  }),
}));

vi.mock('../lib/criticalAction', () => ({
  runCriticalAction: async (options: {
    action: () => Promise<unknown>;
    onSuccess?: (result: unknown) => void;
  }) => {
    const result = await options.action();
    options.onSuccess?.(result);
  },
}));

// A successful receive downloads a PDF receipt. Under jsdom that writes a real
// file into the repo root, so without this the suite would leave an untracked
// PO-*_receiving_receipt.pdf behind on every run -- a dirty worktree that the
// push-proof gate refuses. The receipt is not what this suite is testing.
vi.mock('../lib/receivingPdf', () => ({
  generateReceivingPdf: vi.fn(async () => {}),
  downloadReceivingPdf: vi.fn(async () => {}),
  generateBatchReceivingPdf: vi.fn(async () => {}),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({
  notifyDamagedReceiving: vi.fn(),
  notifyOverReceive: vi.fn(),
}));

// Imported AFTER the mocks above so the page picks up the stubbed client.
const { default: PurchaseOrderDetail } = await import('./PurchaseOrderDetail');

type QueryResult = { data: unknown; error: unknown; count?: number };

/* ── Controllable query gate ──────────────────────────────────────────────
 * Every PO-scoped query (header / items / history) parks here instead of
 * resolving, and only a `release(key)` call fires it. That is what lets PO A's
 * line-item query resolve AFTER PO B has fully loaded. Queries outside those
 * three (e.g. the receiver-name lookup) resolve immediately, so a test only has
 * to sequence what it actually cares about.
 *
 * Parking is unconditional on purpose. An earlier version parked only the keys
 * a test had opted into, which made release() on any other key throw "no query
 * is waiting" -- the gate silently had nothing to sequence.
 */
const pending: Array<{ key: string; fire: () => void }> = [];
const PARKED_PREFIXES = ['header:', 'items:', 'history:', 'receivers:'];

/**
 * Wait for a query to reach the gate before releasing it. A component effect
 * starts its fetch during render, but the query only registers here on the
 * following microtask, so a release that assumed the entry was already parked
 * raced the very code it exists to sequence.
 */
async function waitForPending(key: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (pending.some((entry) => entry.key === key)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(
    `No query is waiting for "${key}". Waiting: ${pending.map((e) => e.key).join(', ') || '(none)'}`,
  );
}

/**
 * Fire EVERY query parked under this key, including any that appear while the
 * earlier ones are settling -- not just the first.
 *
 * An effect that runs more than once parks the same key twice. Releasing only
 * one of them resolves a SUPERSEDED fetch, which by design writes nothing and
 * does not clear the loading flag, while the newest fetch -- the one that
 * actually owns that flag -- stays parked and the page sits on its skeleton
 * forever. That failed only under full-suite timing, where the extra run
 * happens; in isolation the suite passed while carrying the same latent bug.
 */
async function release(key: string) {
  await waitForPending(key);
  for (let pass = 0; pass < 10; pass += 1) {
    const index = pending.findIndex((entry) => entry.key === key);
    if (index === -1) break;
    const [entry] = pending.splice(index, 1);
    await act(async () => {
      entry.fire();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function isWaiting(key: string) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return pending.some((entry) => entry.key === key);
}

/**
 * The PO number renders in the breadcrumb AND in the page heading, so a
 * single-element query throws "found multiple elements". What these tests care
 * about is which purchase order the page is presenting, not how many places it
 * says so -- and, for the absence checks, that it is presenting the other one
 * nowhere at all.
 */
async function expectShowsPo(poNumber: string) {
  await waitFor(
    () => {
      expect(screen.getAllByText(poNumber).length).toBeGreaterThan(0);
    },
    { timeout: 5000 },
  );
}

function expectShowingNow(text: string) {
  expect(screen.getAllByText(text).length).toBeGreaterThan(0);
}

function expectAbsent(text: string) {
  expect(screen.queryAllByText(text)).toHaveLength(0);
}

/* ── Fixtures ─────────────────────────────────────────────────────────── */
const productA = {
  id: 'product-a',
  product_name: 'Atrazine 4L',
  sku: 'SKU-A',
  unit_size: '2.5 GL',
  packaging_variant: 'Jug',
  container_size: 2.5,
  container_unit: 'GL',
  inventory_unit: 'GAL',
  return_policy: 'returnable',
  product_family: { name: 'Herbicide' },
};
const productB = {
  id: 'product-b',
  product_name: 'Roundup PowerMax',
  sku: 'SKU-B',
  unit_size: '30 GL',
  packaging_variant: 'Drum',
  container_size: 30,
  container_unit: 'GL',
  inventory_unit: 'GAL',
  return_policy: 'non_returnable',
  product_family: { name: 'Herbicide' },
};

function makePo(id: string, number: string, vendor: string) {
  return {
    id,
    po_number: number,
    vendor,
    status: 'submitted',
    submitted_date: '2026-07-01',
    expected_delivery_date: null,
    notes: null,
    total_cost: 1000,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  };
}

function makeItem(id: string, poId: string, product: typeof productA) {
  return {
    id,
    purchase_order_id: poId,
    product_id: product.id,
    product,
    quantity_ordered: 10,
    quantity_received: 0,
    unit_cost: 100,
    unit_cost_cents: 10000,
    unit_size: product.unit_size,
    notes: null,
  };
}

const historyRecordA = {
  id: 'rec-a1',
  purchase_order_id: 'po-a',
  po_item_id: 'item-a1',
  product_id: 'product-a',
  product: { product_name: 'Atrazine 4L' },
  quantity_received: 3,
  received_by: null,
  received_at: '2026-07-02T00:00:00Z',
  notes: null,
  condition: 'good',
  lot_number: 'LOT-A-ONLY',
  storage_location: 'Main Warehouse',
  unit_size: '2.5 GL',
  created_at: '2026-07-02T00:00:00Z',
};

let posById: Record<string, unknown>;
let itemsByPo: Record<string, unknown[]>;
let historyByPo: Record<string, unknown[]>;
let profilesById: Record<string, { id: string; full_name: string }>;

/* ── Query builder ────────────────────────────────────────────────────── */
interface Op { fn: string; args: unknown[] }

function findOp(ops: Op[], fn: string, first?: string) {
  return ops.find((o) => o.fn === fn && (first === undefined || o.args[0] === first));
}

function describeQuery(table: string, ops: Op[]): { key: string; rows: unknown[] } {
  if (table === 'purchase_orders') {
    const id = findOp(ops, 'eq', 'id')?.args[1] as string;
    return { key: `header:${id}`, rows: posById[id] ? [posById[id]] : [] };
  }
  if (table === 'purchase_order_items') {
    const id = findOp(ops, 'eq', 'purchase_order_id')?.args[1] as string;
    return { key: `items:${id}`, rows: itemsByPo[id] || [] };
  }
  if (table === 'receiving_records') {
    const id = findOp(ops, 'eq', 'purchase_order_id')?.args[1] as string;
    return { key: `history:${id}`, rows: historyByPo[id] || [] };
  }
  // The receiver-name lookup is a SECOND await inside fetchReceivingHistory.
  // It needs its own gate key: the guard after it can only be tested if this
  // query can be made to resolve after the operator has moved to another PO.
  if (table === 'profile_public_view') {
    const ids = (findOp(ops, 'in', 'id')?.args[1] as string[]) || [];
    return {
      key: `receivers:${ids.join(',')}`,
      rows: ids.map((receiverId) => profilesById[receiverId]).filter(Boolean),
    };
  }
  return { key: `other:${table}`, rows: [] };
}

class Query implements PromiseLike<QueryResult> {
  private ops: Op[] = [];
  private mode: 'maybe' | 'one' | null = null;
  constructor(private table: string) {}

  private push(fn: string, args: unknown[]) {
    this.ops.push({ fn, args });
    return this;
  }

  select(...a: unknown[]) { return this.push('select', a); }
  eq(...a: unknown[]) { return this.push('eq', a); }
  neq(...a: unknown[]) { return this.push('neq', a); }
  in(...a: unknown[]) { return this.push('in', a); }
  is(...a: unknown[]) { return this.push('is', a); }
  not(...a: unknown[]) { return this.push('not', a); }
  or(...a: unknown[]) { return this.push('or', a); }
  ilike(...a: unknown[]) { return this.push('ilike', a); }
  order(...a: unknown[]) { return this.push('order', a); }
  limit(...a: unknown[]) { return this.push('limit', a); }
  range(...a: unknown[]) { return this.push('range', a); }
  maybeSingle() { this.mode = 'maybe'; return this; }
  single() { this.mode = 'one'; return this; }

  then<R1 = QueryResult, R2 = never>(
    onFulfilled?: ((value: QueryResult) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    const { key, rows } = describeQuery(this.table, this.ops);
    const value: QueryResult = this.mode
      ? { data: rows[0] ?? null, error: null }
      : { data: rows, error: null, count: rows.length };

    if (PARKED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      return new Promise<QueryResult>((resolve) => {
        pending.push({ key, fire: () => resolve(value) });
      }).then(onFulfilled, onRejected);
    }
    return Promise.resolve(value).then(onFulfilled, onRejected);
  }
}

/* ── Harness ──────────────────────────────────────────────────────────── */
function GoToPoB() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/purchase-orders/po-b')}>
      go-to-po-b
    </button>
  );
}

function GoToPoA() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/purchase-orders/po-a')}>
      go-to-po-a
    </button>
  );
}

function renderAtPoA() {
  return render(
    <MemoryRouter initialEntries={['/purchase-orders/po-a']}>
      <GoToPoB />
      <GoToPoA />
      <Routes>
        <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function navigateToPoB() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'go-to-po-b' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function navigateToPoA() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'go-to-po-a' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Release ONE parked query when several share a key, chosen by arrival order.
 * Two fetches for the SAME purchase order park under the same key, and the
 * ticket guard only matters when the OLDER of them answers LAST -- an ordering
 * `release` cannot express, because it drains every match oldest-first.
 */
async function fireNthPending(key: string, index: number) {
  await waitForPending(key);
  const matches = pending.filter((entry) => entry.key === key);
  const entry = matches[index];
  if (!entry) {
    throw new Error(`no parked "${key}" at index ${index} (parked: ${matches.length})`);
  }
  pending.splice(pending.indexOf(entry), 1);
  await act(async () => {
    entry.fire();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function loadPo(poId: string) {
  await release(`header:${poId}`);
  await release(`items:${poId}`);
  await release(`history:${poId}`);
}

/** Drive the receive modal end to end and return the RPC arguments, if any. */
async function submitReceive(quantity: string) {
  fireEvent.click(screen.getByRole('button', { name: /receive items/i }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getAllByRole('spinbutton')[0], { target: { value: quantity } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^review \(/i }));
  await act(async () => {
    fireEvent.click(await within(dialog).findByRole('button', { name: /confirm & receive/i }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // The receive path writes a durable mutation intent to IndexedDB before it
  // calls the RPC, so the outcome is several async turns away from the click.
  // Settle until the RPC fires or the page reports a refusal; sampling after a
  // single tick reads "not yet" as "never", which would let a broken guard look
  // exactly like a working one.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const fired = mocks.rpc.mock.calls.some((call) => call[0] === 'receive_po_items');
    if (fired || mocks.toast.mock.calls.length > 0) break;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return mocks.rpc.mock.calls.find((call) => call[0] === 'receive_po_items');
}

describe('PurchaseOrderDetail route-currency race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending.length = 0;
    window.localStorage.clear();
    window.sessionStorage.clear();
    // The receive path records a durable mutation intent in IndexedDB before it
    // will call the RPC, and fails CLOSED when that store is unavailable. jsdom
    // ships no IndexedDB, so without this every receive would be refused with
    // "Receiving could not be safely prepared" and the payload assertions below
    // would pass for the wrong reason. Same shim the rest of the suite uses.
    globalThis.indexedDB = new IDBFactory();
    posById = {
      'po-a': makePo('po-a', 'PO-A-1001', 'Vendor Alpha'),
      'po-b': makePo('po-b', 'PO-B-2002', 'Vendor Bravo'),
    };
    itemsByPo = {
      'po-a': [makeItem('item-a1', 'po-a', productA)],
      'po-b': [makeItem('item-b1', 'po-b', productB)],
    };
    historyByPo = { 'po-a': [], 'po-b': [] };
    profilesById = { 'user-a': { id: 'user-a', full_name: 'Receiver Alpha' } };
    // `assertRpcResult` is the REAL helper in this suite, so every RPC the page
    // or any child fires must answer with a shape it accepts. `RelatedNotes`
    // renders unconditionally and calls `get_notes_for_entity` on mount; a null
    // or non-array answer makes it throw inside an uncaught async effect, which
    // fails the run on the `Errors` line without failing any single test.
    mocks.rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === 'get_notes_for_entity'
          ? { data: [], error: null }
          : { data: { receiving_record_ids: ['rec-new'] }, error: null },
      ),
    );
    harness.impl = {
      from: (table: string) => new Query(table),
      rpc: (name: string, args: unknown) => mocks.rpc(name, args),
    };
  });

  it("drops PO A's line items when they resolve after the operator moved to PO B", async () => {
    renderAtPoA();

    await release('header:po-a');
    await release('history:po-a');
    expect(await isWaiting('items:po-a')).toBe(true);

    // Operator navigates to PO B — same component instance, no unmount.
    await navigateToPoB();
    await loadPo('po-b');
    await expectShowsPo('PO-B-2002');

    // PO A's stale line-item query now resolves LAST.
    await release('items:po-a');

    expectShowingNow('PO-B-2002');
    expectAbsent('PO-A-1001');
    expect(screen.getAllByText('Roundup PowerMax').length).toBeGreaterThan(0);
    expectAbsent('Atrazine 4L');

    // A receive submitted from this screen cannot carry PO A's item ids.
    const rpcCall = await submitReceive('4');
    expect(rpcCall).toBeDefined();
    expect(rpcCall![1].p_items).toEqual([
      expect.objectContaining({ po_item_id: 'item-b1', quantity: 4 }),
    ]);
    expect(JSON.stringify(rpcCall![1])).not.toContain('item-a1');
  });

  it("drops PO A's header when it resolves after PO B finished loading", async () => {
    renderAtPoA();

    await navigateToPoB();
    await loadPo('po-b');
    await expectShowsPo('PO-B-2002');

    await release('header:po-a');

    expectShowingNow('PO-B-2002');
    expectAbsent('PO-A-1001');
    expectAbsent('Vendor Alpha');
  });

  it("never renders PO B's header above PO A's line items while PO B is loading", async () => {
    renderAtPoA();
    await release('header:po-a');
    await release('items:po-a');
    await release('history:po-a');
    await expectShowsPo('PO-A-1001');
    expect(screen.getAllByText('Atrazine 4L').length).toBeGreaterThan(0);

    await navigateToPoB();

    // PO B's header arrives while its line items are still in flight. PO A's
    // lines must not appear under PO B's number for even one render.
    await release('header:po-b');
    expectAbsent('Atrazine 4L');

    await release('items:po-b');
    await release('history:po-b');
    await expectShowsPo('PO-B-2002');
    expect(screen.getAllByText('Roundup PowerMax').length).toBeGreaterThan(0);
  });

  it("drops PO A's receiving history when it resolves after PO B loaded", async () => {
    historyByPo['po-a'] = [historyRecordA];
    renderAtPoA();

    await release('header:po-a');
    await release('items:po-a');
    expect(await isWaiting('history:po-a')).toBe(true);

    await navigateToPoB();
    await loadPo('po-b');
    await expectShowsPo('PO-B-2002');

    await release('history:po-a');

    expectAbsent('LOT-A-ONLY');
    // Settled, not wedged on the history loading skeleton.
    expect(screen.getByText(/no items have been received yet/i)).toBeInTheDocument();
  });

  it("drops PO A's receiver-name lookup when it resolves after PO B loaded", async () => {
    // fetchReceivingHistory awaits TWICE: the receiving records, then the
    // receiver names. Guarding only the first await leaves the second one able
    // to publish PO A's history while PO B is on screen, so each await gets its
    // own test rather than trusting one to cover both.
    historyByPo['po-a'] = [{ ...historyRecordA, received_by: 'user-a' }];
    renderAtPoA();

    await release('header:po-a');
    await release('items:po-a');
    await release('history:po-a');
    expect(await isWaiting('receivers:user-a')).toBe(true);

    await navigateToPoB();
    await loadPo('po-b');
    await expectShowsPo('PO-B-2002');

    // PO A's receiver-name lookup now resolves LAST.
    await release('receivers:user-a');

    expectAbsent('LOT-A-ONLY');
    expectAbsent('Receiver Alpha');
    // Settled, not wedged on the history loading skeleton.
    expect(screen.getByText(/no items have been received yet/i)).toBeInTheDocument();
  });

  it('refuses a receive whose line items belong to a different purchase order', async () => {
    // The state the race used to produce, and that a refactor could reintroduce.
    itemsByPo['po-b'] = [makeItem('item-a1', 'po-a', productA)];
    renderAtPoA();
    await navigateToPoB();
    await loadPo('po-b');
    await expectShowsPo('PO-B-2002');

    const rpcCall = await submitReceive('4');

    expect(rpcCall).toBeUndefined();
    expect(mocks.toast).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/still loading.*refresh/i),
    );
  });

  it('leaves the page usable after a superseded fetch is dropped', async () => {
    renderAtPoA();
    await release('header:po-a');
    await release('history:po-a');

    await navigateToPoB();
    await loadPo('po-b');
    await release('items:po-a');

    // No wedged spinner: the real PO B content is interactive.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /receive items/i })).toBeEnabled();
    });
    expectShowingNow('PO-B-2002');
  });

  it('drops a superseded fetch for the SAME purchase order (A -> B -> A)', async () => {
    // The ticket's own job, and the one thing the route check cannot do: both
    // fetches below were started for PO A, so their route ids AGREE and only
    // call order separates them. Without this case the ticket half is carried
    // by the route half and could be deleted with every test still green.
    historyByPo['po-a'] = [historyRecordA];
    renderAtPoA();
    // PO A's first load is in flight. Leave it parked and walk away from it.
    expect(await isWaiting('header:po-a')).toBe(true);

    await navigateToPoB();
    await loadPo('po-b');
    await expectShowsPo('PO-B-2002');

    // PO A changed while the operator was on PO B, so the abandoned load and
    // the current one now disagree -- otherwise a stale overwrite of the same
    // record would be invisible and the test would prove nothing.
    posById['po-a'] = makePo('po-a', 'PO-A-1001', 'Vendor Alpha Revised');
    historyByPo['po-a'] = [{ ...historyRecordA, lot_number: 'LOT-A-REVISED' }];

    await navigateToPoA();

    // Two header:po-a and two history:po-a fetches are parked: [0] the
    // abandoned first load, carrying the pre-change values, and [1] the
    // current one. Answer the CURRENT one and finish its load...
    await fireNthPending('header:po-a', 1);
    await release('items:po-a');
    await fireNthPending('history:po-a', 1);
    await expectShowsPo('Vendor Alpha Revised');
    await expectShowsPo('LOT-A-REVISED');

    // ...then let the ABANDONED answers land last. Same PO, same route, older
    // calls -- the ticket is the only thing that can still tell them apart.
    await fireNthPending('header:po-a', 0);
    await fireNthPending('history:po-a', 0);

    expectShowingNow('Vendor Alpha Revised');
    expectAbsent('Vendor Alpha');
    expectShowingNow('LOT-A-REVISED');
    expectAbsent('LOT-A-ONLY');
  });

  it("drops a finished action's refetch when the operator navigated away mid-RPC", async () => {
    // Every action handler on this page -- receive, reverse, save, submit,
    // cancel -- calls fetchPO() after awaiting its RPC, from the closure of the
    // render it started on. A ticket alone cannot catch that: the stale closure
    // MINTS THE NEWEST TICKET for PO A, so an order-only guard certifies it as
    // current and paints A over B. Only comparing the id the fetch started for
    // against the live route catches it.
    // Give PO A a receiving record: the stale refetch reloads history too, and
    // an empty fixture would hide a stale install behind an empty list.
    historyByPo['po-a'] = [historyRecordA];
    renderAtPoA();
    await loadPo('po-a');
    await expectShowsPo('PO-A-1001');

    // Hold the receive RPC open so the operator can navigate while it is in
    // flight -- the whole point is that the handler resumes after the route
    // has already changed.
    let completeReceive: (() => void) | undefined;
    mocks.rpc.mockImplementation((name: string) => {
      if (name === 'get_notes_for_entity') return Promise.resolve({ data: [], error: null });
      if (name === 'receive_po_items') {
        return new Promise((resolve) => {
          completeReceive = () =>
            resolve({ data: { receiving_record_ids: ['rec-new'] }, error: null });
        });
      }
      return Promise.resolve({ data: { receiving_record_ids: ['rec-new'] }, error: null });
    });

    expect(await submitReceive('3')).toBeDefined();
    expect(completeReceive).toBeDefined();

    await navigateToPoB();
    await loadPo('po-b');
    await expectShowsPo('PO-B-2002');

    // PO A's receive lands now. Its success path refetches PO A.
    await act(async () => {
      completeReceive!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Let that stale refetch's own queries answer, so the guard is exercised on
    // a real response rather than passing because nothing ever resolved.
    await release('header:po-a');
    await release('history:po-a');

    expectShowingNow('PO-B-2002');
    expectAbsent('PO-A-1001');
    expectAbsent('Vendor Alpha');
    expectAbsent('Atrazine 4L');
    expectAbsent('LOT-A-ONLY');
  });
});
