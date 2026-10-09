/**
 * Invoices.seasonWindow.test.tsx — the Chemical Sales list after the Oct 1 rollover.
 *
 * Bug (2026-10-09): the list only fetched invoices created in the CURRENT season, so on
 * Oct 1 every prior-season draft, unposted, posted-unpaid and overdue invoice vanished
 * from the list. The rule now: an OPEN invoice shows whatever season it is in (labelled
 * with its season), and only CLOSED invoices (paid / voided / cancelled) stay
 * season-windowed. The supabase mock applies the page's real filters to an in-memory
 * row set, so this proves which rows the query actually returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({ mockFrom: vi.fn(), mockRpc: vi.fn(), mockToast: vi.fn() }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return { ...actual, supabase: { from: mockFrom, rpc: mockRpc } };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import Invoices from './Invoices';

function invoice(overrides: Record<string, unknown>) {
  return {
    id: overrides.invoice_number,
    invoice_type: 'chemical_sale',
    customer_id: 'cust-1',
    customer: { farm_name: 'Test Farm' },
    salesman_id: null,
    order_id: null,
    deleted_at: null,
    total_amount_cents: 10000,
    balance_cents: 10000,
    is_quick_delivery: false,
    ...overrides,
  };
}

// "Today" is 2026-10-09, so the current season is 2027 (Oct 1 2026 – Sep 30 2027).
const ROWS = [
  invoice({ invoice_number: 'OLD-DRAFT', status: 'draft', season: 2026, invoice_date: '2026-05-06', created_at: '2026-05-06T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-UNPOSTED', status: 'unposted', season: 2026, invoice_date: '2026-06-01', created_at: '2026-06-01T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-POSTED', status: 'posted', season: 2026, invoice_date: '2026-07-01', created_at: '2026-07-01T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-OVERDUE', status: 'overdue', season: 2026, invoice_date: '2026-04-08', created_at: '2026-08-18T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-PAID', status: 'paid', season: 2026, balance_cents: 0, invoice_date: '2026-07-17', created_at: '2026-07-17T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-VOIDED', status: 'voided', season: 2026, balance_cents: 0, invoice_date: '2026-07-18', created_at: '2026-07-18T15:00:00+00:00' }),
  invoice({ invoice_number: 'NEW-PAID', status: 'paid', season: 2027, balance_cents: 0, invoice_date: '2026-10-05', created_at: '2026-10-05T15:00:00+00:00' }),
  invoice({ invoice_number: 'NEW-DRAFT', status: 'draft', season: 2027, invoice_date: '2026-10-06', created_at: '2026-10-06T15:00:00+00:00' }),
  // Field invoices never belong on the Chemical Sales list, whatever their status.
  invoice({ invoice_number: 'OLD-FIELD', invoice_type: 'field_application', status: 'unposted', season: 2026, invoice_date: '2026-08-08', created_at: '2026-08-08T15:00:00+00:00' }),
];

describe('Invoices list — season window after the Oct 1 rollover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    mockFrom.mockImplementation((table: string) =>
      buildInMemoryQuery(table === 'invoices' ? ROWS : []));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps every prior-season open invoice on the list, labelled with its season', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    for (const number of ['OLD-DRAFT', 'OLD-UNPOSTED', 'OLD-POSTED', 'OLD-OVERDUE', 'NEW-DRAFT', 'NEW-PAID']) {
      await waitFor(() => expect(screen.getAllByText(number).length).toBeGreaterThan(0));
    }
    // Prior-season rows carry a visible season label; current-season rows do not need one.
    expect(screen.getAllByText('Season 2026').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('Season 2027')).not.toBeInTheDocument();
  });

  it('still season-windows closed invoices and keeps field invoices off this list', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    await waitFor(() => expect(screen.getAllByText('NEW-PAID').length).toBeGreaterThan(0));
    expect(screen.queryByText('OLD-PAID')).not.toBeInTheDocument();
    expect(screen.queryByText('OLD-VOIDED')).not.toBeInTheDocument();
    expect(screen.queryByText('OLD-FIELD')).not.toBeInTheDocument();
  });

  it('counts prior-season drafts in the Unposted card', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    // OLD-DRAFT + OLD-UNPOSTED + NEW-DRAFT are all still waiting to be posted.
    const card = await screen.findByRole('button', { name: 'Show invoices ready to post' });
    await waitFor(() => expect(card).toHaveTextContent('3'));
  });

  it('counts overdue invoices in the Posted Total and Outstanding cards, and says older open invoices are included', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    // OLD-POSTED ($100.00) + OLD-OVERDUE ($100.00): overdue is a posted invoice past due.
    const outstanding = (await screen.findByText('unpaid balance on posted and overdue invoices')).parentElement!;
    await waitFor(() => expect(outstanding).toHaveTextContent('$200.00'));
    const postedTotal = screen.getByText(/posted invoices \(including overdue\)/).parentElement!;
    expect(postedTotal).toHaveTextContent('$200.00');
    expect(postedTotal).toHaveTextContent('2 posted invoices (including overdue)');
    expect(screen.getByText(/plus any invoice from an earlier season that is still unposted\s+or unpaid/)).toBeInTheDocument();
  });

  it('Select All picks only this season, so Select All + Post posts no prior-season draft', async () => {
    mockRpc.mockImplementation(() => {
      const result = Promise.resolve({ data: null, error: null });
      return Object.assign(result, { throwOnError: () => result });
    });
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    // Only NEW-DRAFT (this season) is postable / deletable; the Season 2026 draft,
    // unposted and posted / overdue invoices are not selected, so no Void button either.
    expect(screen.getByRole('button', { name: /Post 1 Selected/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete 1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Void \d+ Selected/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/not from this season/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1' }));
    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')).toHaveLength(1));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')[0][1]).toMatchObject({ p_invoice_id: 'NEW-DRAFT' });
  });

  // Regression (2026-10-09 final review): the toggle compared HOW MANY rows were
  // selected with how many this-season rows there were, not WHICH rows. A hand-ticked
  // older row skews the count, so the button could clear when it said Select All, or
  // select when it said Deselect All.
  const toggleButton = () => screen.getByRole('button', { name: /^(Select|Deselect) All$/ });
  const tickRow = (number: string) => {
    const row = screen.getAllByText(number).map((el) => el.closest('tr')).find(Boolean)!;
    fireEvent.click(within(row).getByRole('checkbox'));
  };

  const rowCheckbox = (number: string) => {
    const row = screen.getAllByText(number).map((el) => el.closest('tr')).find(Boolean)!;
    return within(row).getByRole('checkbox');
  };
  const statusFilter = () => screen.getByRole('combobox', { name: 'Filter by status' });
  const postSucceeds = () => {
    const result = Promise.resolve({ data: null, error: null });
    return Object.assign(result, { throwOnError: () => result });
  };
  const postedIds = () =>
    mockRpc.mock.calls.filter(([name]) => name === 'post_invoice').map(([, args]) => args.p_invoice_id);

  it('with an older-season invoice ticked by hand, Select All replaces it with exactly this season in view', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    // One row selected, but this season's NEW-DRAFT is not: the button must offer to
    // select, and must not clear.
    expect(toggleButton()).toHaveTextContent('Select All');
    fireEvent.click(toggleButton());

    // Select All selects exactly this season's rows in view; it does not carry the
    // hand-ticked older-season row along.
    expect(screen.getByRole('button', { name: /Post 1 Selected/ })).toBeInTheDocument();
    expect(rowCheckbox('NEW-DRAFT')).toBeChecked();
    expect(rowCheckbox('OLD-DRAFT')).not.toBeChecked();
    expect(toggleButton()).toHaveTextContent('Deselect All');
  });

  // Regression (2026-10-09 review of the id-based toggle): Select All unioned this
  // season's rows into the EXISTING selection, so a row ticked earlier and then hidden
  // by a filter was still selected, counted and posted although it was not on screen.
  it('a row ticked and then hidden by a filter is not carried into Select All + Post', async () => {
    mockRpc.mockImplementation(postSucceeds);
    mockFrom.mockImplementation((table: string) =>
      buildInMemoryQuery(table === 'invoices'
        ? [
          ...ROWS,
          invoice({ invoice_number: 'NEW-UNPOSTED', status: 'unposted', season: 2027, invoice_date: '2026-10-07', created_at: '2026-10-07T15:00:00+00:00' }),
        ]
        : []));
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-UNPOSTED').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    // Unposted only: OLD-UNPOSTED (Season 2026) and NEW-UNPOSTED are in view; the
    // ticked OLD-DRAFT is hidden.
    fireEvent.change(statusFilter(), { target: { value: 'unposted' } });
    expect(screen.queryByText('OLD-DRAFT')).not.toBeInTheDocument();
    fireEvent.click(toggleButton());

    // The one this-season row in view, and nothing else.
    expect(screen.getByRole('button', { name: /Post 1 Selected/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1' }));
    await waitFor(() => expect(postedIds()).toHaveLength(1));
    expect(postedIds()).toEqual(['NEW-UNPOSTED']);
  });

  // Regression: under a filter with no selectable rows, neither the toggle nor Clear
  // selection rendered, yet the Print bulk button still acted on the hidden selection.
  it('a leftover selection under a filter with no selectable rows is cleared, so no bulk button acts on it', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));

    tickRow('NEW-DRAFT');
    expect(screen.getByRole('button', { name: /Print 1 Selected/ })).toBeInTheDocument();

    // Paid only: NEW-PAID is in view, and a paid invoice has no checkbox.
    fireEvent.change(statusFilter(), { target: { value: 'paid' } });
    expect(screen.getAllByText('NEW-PAID').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Print \d+ Selected/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /(Post|Void) \d+ Selected/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete \d+$/ })).not.toBeInTheDocument();

    // Back to every status: the hidden selection was dropped, not just hidden.
    fireEvent.change(statusFilter(), { target: { value: '' } });
    expect(rowCheckbox('NEW-DRAFT')).not.toBeChecked();
    expect(screen.queryByRole('button', { name: /Print \d+ Selected/ })).not.toBeInTheDocument();
  });

  it('a ticked row hidden by the search box is dropped too, so no bulk button acts on it', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));

    tickRow('NEW-DRAFT');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search invoices...' }), { target: { value: 'OLD-DRAFT' } });
    expect(screen.queryByText('NEW-DRAFT')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /(Post|Print) \d+ Selected/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search invoices...' }), { target: { value: '' } });
    expect(rowCheckbox('NEW-DRAFT')).not.toBeChecked();
  });

  it('offers Clear selection whenever something on screen is selected, even when Deselect All shows', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    tickRow('NEW-DRAFT');
    expect(toggleButton()).toHaveTextContent('Deselect All');
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('button', { name: /(Post|Print) \d+ Selected/ })).not.toBeInTheDocument();
  });

  // Regression: "is anything selected" and the Print count used the raw selection,
  // which can hold an id the list no longer loads (deleted elsewhere, row cap shift).
  it('counts only loaded invoices: a failed post re-selecting a row the reload no longer returns drops it', async () => {
    let rows = ROWS;
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? rows : []));
    mockRpc.mockImplementation(() => {
      // NEW-DRAFT is deleted elsewhere while this batch runs, and both posts fail.
      rows = ROWS.filter((row) => row.id !== 'NEW-DRAFT');
      const failed = Promise.resolve({ data: null, error: { message: 'post failed' } });
      return Object.assign(failed, { throwOnError: () => Promise.reject(new Error('post failed')) });
    });
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    tickRow('NEW-DRAFT');
    fireEvent.click(screen.getByRole('button', { name: /Post 2 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 2' }));

    await waitFor(() => expect(postedIds()).toHaveLength(2));
    // The reload has landed: OLD-DRAFT is back on screen and NEW-DRAFT is gone.
    await waitFor(() => {
      expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0);
      expect(screen.queryByText('NEW-DRAFT')).not.toBeInTheDocument();
    });
    // Only the still-loaded failed invoice stays selected and counted.
    await waitFor(() => expect(screen.getByRole('button', { name: /Post 1 Selected/ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Print 1 Selected/ })).toBeInTheDocument();
  });

  it('Deselect All clears everything, including a hand-ticked older-season invoice', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    tickRow('NEW-DRAFT');
    expect(screen.getByRole('button', { name: /Post 2 Selected/ })).toBeInTheDocument();
    expect(toggleButton()).toHaveTextContent('Deselect All');
    fireEvent.click(toggleButton());

    expect(screen.queryByRole('button', { name: /Post \d+ Selected/ })).not.toBeInTheDocument();
    expect(toggleButton()).toHaveTextContent('Select All');
  });

  it('a partial selection offers Clear selection, which clears it', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('button', { name: /Post \d+ Selected/ })).not.toBeInTheDocument();
  });

  it('Select All is disabled when every selectable row in view is from an older or unknown season', async () => {
    mockFrom.mockImplementation((table: string) =>
      buildInMemoryQuery(table === 'invoices'
        ? [
          ...ROWS.filter((row) => (row as { season?: number }).season === 2026),
          invoice({ invoice_number: 'NO-SEASON', status: 'draft', season: null, invoice_date: '2026-10-07', created_at: '2026-10-07T15:00:00+00:00' }),
        ]
        : []));
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText('NO-SEASON').length).toBeGreaterThan(0));

    // The unknown-season draft is tagged like an older-season one.
    expect(screen.getAllByText('Season unknown').length).toBeGreaterThan(0);
    expect(toggleButton()).toHaveTextContent('Select All');
    expect(toggleButton()).toBeDisabled();
    fireEvent.click(toggleButton());
    expect(screen.queryByRole('button', { name: /Post \d+ Selected/ })).not.toBeInTheDocument();

    // A hand-ticked row can still be cleared with the same button.
    tickRow('NO-SEASON');
    expect(toggleButton()).toHaveTextContent('Deselect All');
    expect(toggleButton()).toBeEnabled();
    fireEvent.click(toggleButton());
    expect(screen.queryByRole('button', { name: /Post \d+ Selected/ })).not.toBeInTheDocument();
  });

  it('a prior-season draft ticked by hand is named as not from this season in the Post confirm', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    const row = screen.getAllByText('OLD-DRAFT').map((el) => el.closest('tr')).find(Boolean)!;
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/This includes 1 invoice\(s\) not from this season \(Season 2026\)/)).toBeInTheDocument();
  });
});
