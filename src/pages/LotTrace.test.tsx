/**
 * LotTrace.test.tsx — B1 Lot Capture & Trace (2026-06-22)
 *
 * Mock-only proof of the recall lookup page (the lotRpc shim is mocked). The
 * get_lot_application_trace RPC is in the parked migration, so the live walkthrough
 * moves to post-apply; this pins the page's contract: it traces the entered lot,
 * renders the result rows, shows an empty state for no matches, surfaces errors,
 * and refuses a blank search.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LotTrace from './LotTrace';

const { mockTraceLot, mockToast } = vi.hoisted(() => ({
  mockTraceLot: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../lib/lotRpc', () => ({ traceLot: mockTraceLot }));
vi.mock('../lib/db', () => ({ sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

const ROW = {
  application_record_id: 'r1',
  record_number: 'AR-1001',
  product_id: 'p1',
  product_name: 'Herbicide A',
  lot_number: 'LOT-9',
  quantity_from_lot: null,
  unit: null,
  application_date: '2026-05-01',
  customer_id: 'c1',
  customer_name: 'Farm Alpha',
  applicator_id: 'a1',
  applicator_name: 'Joe Driver',
  field_names: 'North 40',
  invoice_id: 'inv-1',
  source_receiving_record_id: 'rcv-1',
};

beforeEach(() => vi.clearAllMocks());

describe('LotTrace', () => {
  it('traces the entered lot and renders the result rows', async () => {
    mockTraceLot.mockResolvedValue([ROW]);
    render(<LotTrace />);

    fireEvent.change(screen.getByLabelText('Lot number'), { target: { value: 'lot-9' } });
    fireEvent.click(screen.getByRole('button', { name: /trace lot/i }));

    await waitFor(() => expect(mockTraceLot).toHaveBeenCalledWith('lot-9'));
    expect(await screen.findByText('Herbicide A')).toBeInTheDocument();
    expect(screen.getByText('Farm Alpha')).toBeInTheDocument();
    expect(screen.getByText('North 40')).toBeInTheDocument();
    expect(screen.getByText('Joe Driver')).toBeInTheDocument();
  });

  it('shows an empty state when no application used the lot', async () => {
    mockTraceLot.mockResolvedValue([]);
    render(<LotTrace />);
    fireEvent.change(screen.getByLabelText('Lot number'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /trace lot/i }));

    expect(await screen.findByText(/No applications found for "nope"/i)).toBeInTheDocument();
  });

  it('surfaces an error toast when the trace RPC fails', async () => {
    mockTraceLot.mockRejectedValue(new Error('relation does not exist'));
    render(<LotTrace />);
    fireEvent.change(screen.getByLabelText('Lot number'), { target: { value: 'LOT-X' } });
    fireEvent.click(screen.getByRole('button', { name: /trace lot/i }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('relation does not exist')));
    // a FAILED lookup must show an error state, never the false-negative "no results" empty state
    expect(await screen.findByText(/failed lookup, not a confirmed/i)).toBeInTheDocument();
    expect(screen.queryByText(/No applications found/i)).not.toBeInTheDocument();
  });

  it('refuses a blank search without calling the RPC', async () => {
    render(<LotTrace />);
    fireEvent.click(screen.getByRole('button', { name: /trace lot/i }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Enter a lot number')));
    expect(mockTraceLot).not.toHaveBeenCalled();
  });
});
