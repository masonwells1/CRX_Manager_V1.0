/**
 * LotsEditorModal.test.tsx — B1 Lot Capture & Trace (2026-06-22)
 *
 * Mock-only proof of the editor↔data-access contract (the lotRpc shim is mocked).
 * The migration that creates the table + RPCs is parked pending go-live, so the live
 * UI walkthrough moves to post-apply; these tests pin the wiring the editor owns:
 *   - existing lots load and render per product
 *   - Save builds the replace-all p_lots payload from every product's rows,
 *     skipping blanks, with p_performed_by = the actor and the idempotency key
 *   - choosing a suggested lot carries its receiving_record_id (provenance link)
 *   - a duplicate (product, lot) is blocked client-side before the save fires
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import LotsEditorModal from './LotsEditorModal';

const { mockFetchRecordLots, mockFetchRecentLots, mockSaveRecordLots, mockToast } = vi.hoisted(() => ({
  mockFetchRecordLots: vi.fn(),
  mockFetchRecentLots: vi.fn(),
  mockSaveRecordLots: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../lib/lotRpc', () => ({
  fetchRecordLots: mockFetchRecordLots,
  fetchRecentLots: mockFetchRecentLots,
  saveRecordLots: mockSaveRecordLots,
}));

vi.mock('../lib/db', () => ({
  hasRpcCode: (err: unknown, code: string) =>
    (err instanceof Error ? err.message : String(err ?? '')).startsWith(code),
  RpcErrorCodes: {
    DUPLICATE_LOT: 'DUPLICATE_LOT',
    PRODUCT_NOT_ON_RECORD: 'PRODUCT_NOT_ON_RECORD',
    SOURCE_RECEIPT_MISMATCH: 'SOURCE_RECEIPT_MISMATCH',
    LOT_MISSING_NUMBER: 'LOT_MISSING_NUMBER',
    INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  },
  sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'user-1' } }) }));
vi.mock('./ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem-key-1', resetKey: vi.fn() }),
}));

const PID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const PID_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const RCV_1 = 'cccccccc-0000-0000-0000-000000000003';

const RECORD = {
  id: 'rec-1',
  record_number: 'AR-1001',
  product_data: [
    { product_id: PID_A, product_name: 'Herbicide A', quantity: 10, unit: 'gal', rate_per_acre: null, rate_unit: null, epa_registration: null, is_rup: false },
    { product_id: PID_B, product_name: 'Adjuvant B', quantity: 5, unit: 'gal', rate_per_acre: null, rate_unit: null, epa_registration: null, is_rup: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchRecordLots.mockResolvedValue([
    { product_id: PID_A, lot_number: 'EXIST-1', source_receiving_record_id: null, quantity_from_lot: null, unit: null },
  ]);
  mockFetchRecentLots.mockImplementation((productId: string) =>
    Promise.resolve(
      productId === PID_A
        ? [{ lot_number: 'RCV-A', last_received_at: '2026-06-01T00:00:00Z', receiving_record_id: RCV_1, source: 'receiving' }]
        : []
    )
  );
  mockSaveRecordLots.mockResolvedValue({ success: true, count: 2 });
});

describe('LotsEditorModal', () => {
  it('loads existing lots and builds a replace-all save payload across products', async () => {
    render(<LotsEditorModal open record={RECORD} onClose={vi.fn()} />);

    expect(await screen.findByText('Herbicide A')).toBeInTheDocument();
    expect(screen.getByText('Adjuvant B')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByDisplayValue('EXIST-1')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: 'Add lot' })[1]); // product B
    fireEvent.change(screen.getByLabelText('Lot number for Adjuvant B'), { target: { value: 'NEW-B' } });
    fireEvent.click(screen.getByRole('button', { name: /save lots/i }));

    await waitFor(() => expect(mockSaveRecordLots).toHaveBeenCalled());
    const args = mockSaveRecordLots.mock.calls[0][0];
    expect(args).toMatchObject({
      p_application_record_id: 'rec-1',
      p_performed_by: 'user-1',
      p_idempotency_key: 'idem-key-1',
    });
    expect(args.p_lots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ product_id: PID_A, lot_number: 'EXIST-1' }),
        expect.objectContaining({ product_id: PID_B, lot_number: 'NEW-B', source_receiving_record_id: null }),
      ])
    );
  });

  it('carries the receiving_record_id when a suggested lot is chosen', async () => {
    mockFetchRecordLots.mockResolvedValue([]); // start empty
    render(<LotsEditorModal open record={RECORD} onClose={vi.fn()} />);
    await screen.findByText('Herbicide A');
    await waitFor(() => expect(mockFetchRecentLots).toHaveBeenCalledWith(PID_A));

    fireEvent.click(screen.getAllByRole('button', { name: 'Add lot' })[0]); // product A
    fireEvent.change(screen.getByLabelText('Lot number for Herbicide A'), { target: { value: 'rcv-a' } }); // case-insensitive match
    fireEvent.click(screen.getByRole('button', { name: /save lots/i }));

    await waitFor(() => expect(mockSaveRecordLots).toHaveBeenCalled());
    expect(mockSaveRecordLots.mock.calls[0][0].p_lots).toEqual([
      expect.objectContaining({ product_id: PID_A, lot_number: 'rcv-a', source_receiving_record_id: RCV_1 }),
    ]);
  });

  it('disables save and blocks data loss when existing lots fail to load', async () => {
    mockFetchRecordLots.mockRejectedValue(new Error('network down'));
    render(<LotsEditorModal open record={RECORD} onClose={vi.fn()} />);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to load lots'));

    const saveBtn = screen.getByRole('button', { name: /save lots/i });
    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    expect(mockSaveRecordLots).not.toHaveBeenCalled(); // a replace-all here would wipe existing lots
  });

  it('dedupes repeated product_data entries into one section and saves once', async () => {
    mockFetchRecordLots.mockResolvedValue([]);
    // blend-style record: same product_id appears twice in product_data
    const dupRecord = { ...RECORD, product_data: [RECORD.product_data[0], RECORD.product_data[0]] };
    render(<LotsEditorModal open record={dupRecord} onClose={vi.fn()} />);
    await screen.findByText('Herbicide A');

    expect(screen.getAllByText('Herbicide A')).toHaveLength(1); // one section, not two
    fireEvent.click(screen.getByRole('button', { name: 'Add lot' }));
    fireEvent.change(screen.getByLabelText('Lot number for Herbicide A'), { target: { value: 'ONE' } });
    fireEvent.click(screen.getByRole('button', { name: /save lots/i }));

    await waitFor(() => expect(mockSaveRecordLots).toHaveBeenCalled());
    expect(mockSaveRecordLots.mock.calls[0][0].p_lots).toEqual([
      expect.objectContaining({ product_id: PID_A, lot_number: 'ONE' }),
    ]);
  });

  it('drops a stale lot load when the record changes mid-load', async () => {
    let resolveA!: (rows: unknown[]) => void;
    const aDeferred = new Promise<unknown[]>((r) => { resolveA = r; });
    mockFetchRecordLots
      .mockReturnValueOnce(aDeferred) // record A — resolves late
      .mockResolvedValueOnce([
        { product_id: PID_B, lot_number: 'B-FRESH', source_receiving_record_id: null, quantity_from_lot: null, unit: null },
      ]); // record B — resolves immediately
    mockFetchRecentLots.mockResolvedValue([]);

    const recA = { id: 'rec-A', record_number: 'AR-A', product_data: [RECORD.product_data[0]] };
    const recB = { id: 'rec-B', record_number: 'AR-B', product_data: [RECORD.product_data[1]] };

    const { rerender } = render(<LotsEditorModal open record={recA} onClose={vi.fn()} />);
    rerender(<LotsEditorModal open record={recB} onClose={vi.fn()} />); // switch before A resolves
    await waitFor(() => expect(screen.getByDisplayValue('B-FRESH')).toBeInTheDocument());

    resolveA([{ product_id: PID_A, lot_number: 'A-STALE', source_receiving_record_id: null, quantity_from_lot: null, unit: null }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.queryByDisplayValue('A-STALE')).not.toBeInTheDocument(); // stale load ignored
    expect(screen.getByDisplayValue('B-FRESH')).toBeInTheDocument();
  });

  it('blocks a duplicate (product, lot) before calling save', async () => {
    mockFetchRecordLots.mockResolvedValue([]);
    render(<LotsEditorModal open record={RECORD} onClose={vi.fn()} />);
    const section = (await screen.findByText('Herbicide A')).closest('div')!.parentElement as HTMLElement;

    const addA = screen.getAllByRole('button', { name: 'Add lot' })[0];
    fireEvent.click(addA);
    fireEvent.click(addA);
    const inputs = within(section).getAllByLabelText('Lot number for Herbicide A');
    fireEvent.change(inputs[0], { target: { value: 'DUP' } });
    fireEvent.change(inputs[1], { target: { value: ' dup ' } }); // same after normalize

    fireEvent.click(screen.getByRole('button', { name: /save lots/i }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('more than once')));
    expect(mockSaveRecordLots).not.toHaveBeenCalled();
  });

  it('blocks every modal close path while a save is in flight (no lost edits on a switched record)', async () => {
    const onClose = vi.fn();
    let resolveSave: (v: { success: boolean; count: number }) => void = () => {};
    mockSaveRecordLots.mockReturnValueOnce(new Promise((r) => { resolveSave = r; }));

    render(<LotsEditorModal open record={RECORD} onClose={onClose} />);
    await waitFor(() => expect(screen.getByDisplayValue('EXIST-1')).toBeInTheDocument());

    // Start a save; the deferred promise keeps the modal in its `saving` state.
    fireEvent.click(screen.getByRole('button', { name: /save lots/i }));
    await waitFor(() => expect(mockSaveRecordLots).toHaveBeenCalled());

    // While saving, the X button and Escape (and the backdrop, same onClose) must NOT close the
    // modal — otherwise the user could switch records and this save's completion would close/
    // overwrite the new one, dropping its unsaved lot edits.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    // Once the save completes, the success path closes the modal normally (exactly once).
    resolveSave({ success: true, count: 1 });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
