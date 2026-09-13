import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

/**
 * Renders the REAL BatchAdjustModal inside a stand-in for the Inventory page
 * against a fake adjust_inventory that models the LIVE contract: it moves stock
 * once per new key, stores a receipt, and replays that receipt for the same key
 * whatever payload arrives — key + operation only, with no actor or payload
 * binding (see the KNOWN LIMIT note in src/lib/idempotency.ts). Under that
 * contract a reused key silently replays an old result, so the stock-move counter
 * is what proves each new adjustment got a fresh key and each retry did not.
 * The binding-rejection case injects the error codes that the pending, unapplied
 * migration 20260911120000 would add; nothing else relies on that migration.
 *
 * The stand-in page does what InventoryPage does: its onSuccess clears the
 * selection (so `items` becomes empty) and its onClose closes the dialog. A
 * no-op onSuccess would hide any result the dialog loses when that happens.
 *
 * "Lost reply" means the fake COMMITS the stock move and then returns a transport
 * failure — exactly the case that used to move stock twice. Assertions are on the
 * fake's stock-move counter and exact request list, taken once each submit has
 * settled (each submit ends with exactly one toast).
 */

const { mockRpc, mockToast, mockLogActivity } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockLogActivity: vi.fn(),
}));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { rpc: mockRpc } };
});
vi.mock('../../lib/activityLogger', () => ({ logActivity: mockLogActivity }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import BatchAdjustModal from './BatchAdjustModal';

// Each submit ends with IndexedDB coordination (resolveIntent) before the button
// re-enables. Under a loaded full-suite run that can outlast the 1s default.
configure({ asyncUtilTimeout: 5000 });

// The key useUncertainMutationIntent stores the batch under for this operation
// and user. A browser fires a `storage` event with it in every OTHER tab.
const BATCH_INTENT_STORAGE_KEY = `crx:uncertain-mutation:v4:${JSON.stringify(['adjust_inventory_batch', 'admin-1'])}`;

type AdjustArgs = {
  p_inventory_id: string;
  p_delta: number;
  p_reason: string;
  p_performed_by: string;
  p_idempotency_key: string;
};

function createFakeDatabase() {
  const stock = new Map<string, number>();
  const moves = new Map<string, number>();
  const receipts = new Map<string, Record<string, unknown>>();
  const calls: AdjustArgs[] = [];
  // Rows whose NEXT successful commit loses its reply.
  const loseNextReply = new Set<string>();
  const refuse = new Map<string, { code: string; message: string }>();

  mockRpc.mockImplementation(async (name: string, args: AdjustArgs) => {
    expect(name).toBe('adjust_inventory');
    calls.push(args);
    const refusal = refuse.get(args.p_inventory_id);
    if (refusal) return { data: null, error: refusal };

    // Live contract: the receipt is found by key alone and replayed as-is.
    const receipt = receipts.get(args.p_idempotency_key);
    if (receipt) return { data: receipt, error: null };

    const next = (stock.get(args.p_inventory_id) ?? 100) + args.p_delta;
    stock.set(args.p_inventory_id, next);
    moves.set(args.p_inventory_id, (moves.get(args.p_inventory_id) ?? 0) + 1);
    const result = { status: 'adjusted', new_quantity: next, product_id: `product-${args.p_inventory_id}` };
    receipts.set(args.p_idempotency_key, result);

    if (loseNextReply.delete(args.p_inventory_id)) {
      // Committed, then the connection dropped: no code a server would send.
      return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } };
    }
    return { data: result, error: null };
  });

  return { stock, moves, calls, loseNextReply, refuse };
}

type FakeDatabase = ReturnType<typeof createFakeDatabase>;
type Scope = Pick<typeof screen, 'getByPlaceholderText' | 'findByRole' | 'queryByRole' | 'getByRole' | 'getByText' | 'queryByText'>;

const PRODUCTS = [
  { id: 'inv-a', product_id: 'p-a', product_name: 'Atrazine 4L' },
  { id: 'inv-b', product_id: 'p-b', product_name: 'Bicep II Magnum' },
];

const NEGATIVE_STOCK_REFUSAL = {
  code: 'P0001',
  message: 'Adjustment would result in negative inventory (current: 1, delta: -4, result: -3)',
};

function renderPage(db: FakeDatabase, options: { selectOnOpen: string[]; startOpen?: boolean }) {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  function InventoryPageStandIn() {
    const [open, setOpen] = useState(options.startOpen ?? true);
    const [selectedIds, setSelectedIds] = useState<string[]>(options.startOpen === false ? [] : options.selectOnOpen);
    const items = PRODUCTS
      .filter((product) => selectedIds.includes(product.id))
      .map((product) => ({ ...product, quantity_available: db.stock.get(product.id) ?? 100 }));
    return (
      <>
        <button onClick={() => { setSelectedIds(options.selectOnOpen); setOpen(true); }}>Select and open batch adjust</button>
        <BatchAdjustModal
          open={open}
          onClose={() => { onClose(); setOpen(false); }}
          items={items}
          userId="admin-1"
          onSuccess={() => { onSuccess(); setSelectedIds([]); }}
        />
      </>
    );
  }

  const view = render(<InventoryPageStandIn />);
  return { ...view, onClose, onSuccess, scope: within(view.container) as Scope };
}

function fillForm(delta: string, reason: string, scope: Scope = screen) {
  fireEvent.change(scope.getByPlaceholderText('e.g. 5 or -3'), { target: { value: delta } });
  fireEvent.change(scope.getByPlaceholderText('e.g. Cycle count correction, Damaged goods'), {
    target: { value: reason },
  });
}

async function click(name: RegExp, scope: Scope = screen) {
  const button = await scope.findByRole('button', { name });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(button);
  });
}

async function pressEscape() {
  await act(async () => {
    fireEvent.keyDown(document, { key: 'Escape' });
  });
}

/** What a browser does in every other tab after this tab writes the stored batch. */
async function deliverStorageEventToOtherTabs() {
  await act(async () => {
    window.dispatchEvent(new StorageEvent('storage', { key: BATCH_INTENT_STORAGE_KEY, storageArea: window.localStorage }));
  });
}

/** Clicks a submit button and waits until that submit has fully settled. */
async function submit(name: RegExp, scope: Scope = screen) {
  const toastsBefore = mockToast.mock.calls.length;
  await click(name, scope);
  await waitFor(() => expect(mockToast.mock.calls.length).toBe(toastsBefore + 1));
  await waitFor(() => expect(scope.queryByRole('button', { name: /Cancel/ })?.hasAttribute('disabled') ?? false).toBe(false));
}

describe('BatchAdjustModal retry keys', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    globalThis.indexedDB = new IDBFactory();
    mockRpc.mockReset();
    mockToast.mockClear();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it('retries a lost response with the same key and moves the stock only once', async () => {
    const db = createFakeDatabase();
    db.loseNextReply.add('inv-a');
    const { onClose, onSuccess } = renderPage(db, { selectOnOpen: ['inv-a'] });

    fillForm('5', 'Cycle count correction');
    await submit(/Adjust 1 Product/);

    expect(screen.getByText('Not confirmed — retry')).toBeTruthy();
    expect(mockToast).toHaveBeenLastCalledWith('warning', expect.stringContaining('Retry the batch unchanged'));
    expect(db.calls).toHaveLength(1);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(onClose).not.toHaveBeenCalled();

    await submit(/Retry 1 Unchanged/);

    expect(mockToast).toHaveBeenLastCalledWith('success', 'Adjusted 1 product(s) by +5');
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1].p_idempotency_key).toBe(db.calls[0].p_idempotency_key);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(db.stock.get('inv-a')).toBe(105);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('blocks a fresh submission when another tab finishes the unconfirmed batch', async () => {
    const db = createFakeDatabase();
    db.loseNextReply.add('inv-a');

    // Tab A: the stock move commits but its reply is lost, so the batch freezes.
    const tabA = renderPage(db, { selectOnOpen: ['inv-a'] });
    fillForm('5', 'Cycle count correction', tabA.scope);
    await submit(/Adjust 1 Product/, tabA.scope);
    expect(tabA.scope.getByText('Not confirmed — retry')).toBeTruthy();
    expect(db.moves.get('inv-a')).toBe(1);

    // Tab B (a second live page on the same browser storage) retries the frozen
    // batch, gets the stored receipt, and resolves it.
    const tabB = renderPage(db, { selectOnOpen: ['inv-a'], startOpen: false });
    await click(/Select and open batch adjust/, tabB.scope);
    await waitFor(() => expect(tabB.scope.getByText(/Unconfirmed batch/)).toBeTruthy());
    await submit(/Retry 1 Unchanged/, tabB.scope);
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1].p_idempotency_key).toBe(db.calls[0].p_idempotency_key);
    expect(db.moves.get('inv-a')).toBe(1);

    await deliverStorageEventToOtherTabs();

    // Tab A lost its frozen lock, but it must not offer a fresh adjustment: its
    // form still holds +5 and a new batch would move the stock a second time.
    await waitFor(() => expect(tabA.scope.getByText(/Finished in another tab/)).toBeTruthy());
    expect(tabA.scope.queryByText(/Unconfirmed batch/)).toBeNull();
    expect(tabA.scope.getByText('Finished elsewhere — check stock')).toBeTruthy();
    const adjustButton = tabA.scope.getByRole('button', { name: /Adjust/ }) as HTMLButtonElement;
    expect(adjustButton.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(adjustButton);
    });
    expect(db.calls).toHaveLength(2);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(db.stock.get('inv-a')).toBe(105);

    // Closing hands the refresh to the page so it loads authoritative stock.
    await click(/Cancel/, tabA.scope);
    expect(tabA.onSuccess).toHaveBeenCalledTimes(1);
    expect(tabA.onClose).toHaveBeenCalledTimes(1);
  });

  it('blocks a passive tab that only watched the batch freeze and resolve elsewhere', async () => {
    const db = createFakeDatabase();
    db.loseNextReply.add('inv-a');

    // Tab C is open with the same adjustment typed but never submits.
    const tabC = renderPage(db, { selectOnOpen: ['inv-a'] });
    fillForm('5', 'Cycle count correction', tabC.scope);

    // Tab A submits it; the stock move commits and the reply is lost.
    const tabA = renderPage(db, { selectOnOpen: ['inv-a'] });
    fillForm('5', 'Cycle count correction', tabA.scope);
    await submit(/Adjust 1 Product/, tabA.scope);
    expect(db.moves.get('inv-a')).toBe(1);

    // Tab C hears about the frozen batch and shows it locked.
    await deliverStorageEventToOtherTabs();
    await waitFor(() => expect(tabC.scope.getByText(/Unconfirmed batch/)).toBeTruthy());

    // Tab A retries, replays the receipt, and resolves the batch itself.
    await submit(/Retry 1 Unchanged/, tabA.scope);
    expect(tabA.onClose).toHaveBeenCalledTimes(1);
    expect(db.calls).toHaveLength(2);
    expect(db.moves.get('inv-a')).toBe(1);

    await deliverStorageEventToOtherTabs();

    // Tab C's own form still holds +5 and a reason; it must not become a fresh
    // adjustment of stock that has already moved.
    await waitFor(() => expect(tabC.scope.getByText(/Finished in another tab/)).toBeTruthy());
    expect(tabC.scope.queryByText(/Unconfirmed batch/)).toBeNull();
    const adjustButton = tabC.scope.getByRole('button', { name: /Adjust/ }) as HTMLButtonElement;
    expect(adjustButton.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(adjustButton);
    });
    expect(db.calls).toHaveLength(2);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(db.stock.get('inv-a')).toBe(105);

    // Tab C submitted nothing, but its page is stale: closing still refreshes it.
    await click(/Cancel/, tabC.scope);
    expect(tabC.onSuccess).toHaveBeenCalledTimes(1);
  });

  it('refreshes the page when closed with a row that may already have moved stock', async () => {
    const db = createFakeDatabase();
    db.loseNextReply.add('inv-a');
    const { onClose, onSuccess } = renderPage(db, { selectOnOpen: ['inv-a'] });

    fillForm('5', 'Cycle count correction');
    await submit(/Adjust 1 Product/);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(onSuccess).not.toHaveBeenCalled();

    await pressEscape();

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the unconfirmed row key after a mixed result and keeps the results on screen', async () => {
    const db = createFakeDatabase();
    db.loseNextReply.add('inv-b');
    const { onSuccess } = renderPage(db, { selectOnOpen: ['inv-a', 'inv-b'] });

    fillForm('2', 'Recount');
    await submit(/Adjust 2 Products/);

    // The page clears its selection in onSuccess; calling it now would wipe these.
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByText('Adjusted')).toBeTruthy();
    expect(screen.getByText('Not confirmed — retry')).toBeTruthy();
    expect(db.calls).toHaveLength(2);
    const keyA = db.calls.find((call) => call.p_inventory_id === 'inv-a')!.p_idempotency_key;
    const keyB = db.calls.find((call) => call.p_inventory_id === 'inv-b')!.p_idempotency_key;
    expect(keyA).not.toBe(keyB);

    await submit(/Retry 1 Unchanged/);

    expect(db.calls).toHaveLength(3);
    expect(db.calls[2].p_inventory_id).toBe('inv-b');
    expect(db.calls[2].p_idempotency_key).toBe(keyB);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(db.moves.get('inv-b')).toBe(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('restores a frozen batch after a reload and replays every row under its original key', async () => {
    const db = createFakeDatabase();
    db.loseNextReply.add('inv-b');
    const first = renderPage(db, { selectOnOpen: ['inv-a', 'inv-b'] });

    fillForm('-3', 'Damaged goods');
    await submit(/Adjust 2 Products/);
    const firstKeys = db.calls.map((call) => call.p_idempotency_key).sort();
    expect(firstKeys).toHaveLength(2);

    // A reload: selection and dialog state are gone; the frozen batch survives in
    // browser storage and is shown locked as soon as the dialog opens again, even
    // when only one of its products is selected.
    first.unmount();
    const second = renderPage(db, { selectOnOpen: ['inv-a'], startOpen: false });
    await click(/Select and open batch adjust/);
    await waitFor(() => expect(screen.getByText(/Unconfirmed batch/)).toBeTruthy());
    expect((screen.getByPlaceholderText('e.g. 5 or -3') as HTMLInputElement).disabled).toBe(true);

    await submit(/Retry 2 Unchanged/);

    expect(mockToast).toHaveBeenLastCalledWith('success', 'Adjusted 2 product(s) by -3');
    expect(db.calls).toHaveLength(4);
    expect(db.calls.slice(2).map((call) => call.p_idempotency_key).sort()).toEqual(firstKeys);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(db.moves.get('inv-b')).toBe(1);
    expect(db.stock.get('inv-a')).toBe(97);
    expect(db.stock.get('inv-b')).toBe(97);
    expect(second.onClose).toHaveBeenCalledTimes(1);
    expect(second.onSuccess).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Unconfirmed batch/)).toBeNull();
  });

  it('keeps a refused row of a retried batch listed even when it is not in the current selection', async () => {
    const db = createFakeDatabase();
    db.loseNextReply.add('inv-a');
    db.refuse.set('inv-b', NEGATIVE_STOCK_REFUSAL);
    const first = renderPage(db, { selectOnOpen: ['inv-a', 'inv-b'] });

    fillForm('-4', 'Shrink');
    await submit(/Adjust 2 Products/);
    // Atrazine is unconfirmed, so the batch — refused Bicep included — stays frozen.
    expect(screen.getByText('Refused — will retry')).toBeTruthy();

    first.unmount();
    const second = renderPage(db, { selectOnOpen: ['inv-a'], startOpen: false });
    await click(/Select and open batch adjust/);
    await waitFor(() => expect(screen.getByText(/Unconfirmed batch/)).toBeTruthy());

    await submit(/Retry 2 Unchanged/);

    // The retry replays Atrazine and Bicep is refused again under its SAME key.
    expect(db.calls).toHaveLength(4);
    expect(db.calls[3].p_inventory_id).toBe('inv-b');
    expect(db.calls[3].p_idempotency_key).toBe(db.calls[1].p_idempotency_key);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(db.moves.get('inv-b')).toBeUndefined();
    // The batch unfroze, but Bicep's result is still on screen although only
    // Atrazine is selected — and this dialog resolved it, so it is not
    // "finished elsewhere".
    expect(screen.queryByText(/Unconfirmed batch/)).toBeNull();
    expect(screen.queryByText(/Finished in another tab/)).toBeNull();
    expect(screen.getByText('Bicep II Magnum')).toBeTruthy();
    expect(screen.getByText('Refused — nothing changed')).toBeTruthy();
    expect(second.onSuccess).not.toHaveBeenCalled();
  });

  it('uses a fresh key when the payload changes', async () => {
    // Under the live key-only contract a reused key would silently replay the
    // first receipt, so three stock moves prove three distinct keys.
    const db = createFakeDatabase();
    const { onClose } = renderPage(db, { selectOnOpen: ['inv-a'] });

    fillForm('5', 'Cycle count correction');
    await submit(/Adjust 1 Product/);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Same row, different delta: a genuinely new adjustment.
    await click(/Select and open batch adjust/);
    fillForm('3', 'Cycle count correction');
    await submit(/Adjust 1 Product/);

    // Same row and delta, different reason: also new.
    await click(/Select and open batch adjust/);
    fillForm('3', 'Found an extra case');
    await submit(/Adjust 1 Product/);

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(db.calls).toHaveLength(3);
    expect(new Set(db.calls.map((call) => call.p_idempotency_key)).size).toBe(3);
    expect(db.moves.get('inv-a')).toBe(3);
    expect(db.stock.get('inv-a')).toBe(111);
  });

  it('shows a binding rejection distinctly, never retries it, and does not stay frozen', async () => {
    // Injected: IDEMPOTENCY_ACTOR_MISMATCH is what the pending migration
    // 20260911120000 would raise; the live function cannot return it yet.
    const db = createFakeDatabase();
    db.refuse.set('inv-b', { code: 'P0001', message: 'IDEMPOTENCY_ACTOR_MISMATCH' });
    const { onClose, onSuccess } = renderPage(db, { selectOnOpen: ['inv-a', 'inv-b'] });

    fillForm('4', 'Recount');
    await submit(/Adjust 2 Products/);

    expect(screen.getByText('Adjusted')).toBeTruthy();
    expect(screen.getByText('Check stock history')).toBeTruthy();
    expect(mockToast).toHaveBeenLastCalledWith('error', expect.stringContaining("Check each product's stock history"));
    expect(screen.queryByText(/Unconfirmed batch/)).toBeNull();
    expect(db.calls).toHaveLength(2);
    expect(onClose).not.toHaveBeenCalled();
    // Both rows are settled, so there is nothing left to send from this dialog.
    expect((screen.getByRole('button', { name: /Adjust 0 Products/ }) as HTMLButtonElement).disabled).toBe(true);

    // Closing hands the refresh to the page, once.
    await click(/Cancel/);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats a definitive refusal as final for that row and unfreezes the batch', async () => {
    const db = createFakeDatabase();
    db.refuse.set('inv-b', NEGATIVE_STOCK_REFUSAL);
    const { onSuccess } = renderPage(db, { selectOnOpen: ['inv-a', 'inv-b'] });

    fillForm('-4', 'Shrink');
    await submit(/Adjust 2 Products/);

    expect(screen.getByText('Adjusted')).toBeTruthy();
    expect(screen.getByText('Refused — nothing changed')).toBeTruthy();
    expect(screen.queryByText(/Unconfirmed batch/)).toBeNull();
    expect(db.calls).toHaveLength(2);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(db.moves.get('inv-b')).toBeUndefined();
    expect(onSuccess).not.toHaveBeenCalled();

    // The refused row can be sent again as a NEW batch; the adjusted row is not.
    db.refuse.delete('inv-b');
    await submit(/Adjust 1 Product/);

    expect(db.calls).toHaveLength(3);
    expect(db.calls[2].p_inventory_id).toBe('inv-b');
    expect(db.calls[2].p_idempotency_key).not.toBe(db.calls[1].p_idempotency_key);
    expect(db.moves.get('inv-a')).toBe(1);
    expect(db.moves.get('inv-b')).toBe(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
