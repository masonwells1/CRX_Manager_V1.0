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
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';

const { mockFrom, mockToast } = vi.hoisted(() => ({ mockFrom: vi.fn(), mockToast: vi.fn() }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return { ...actual, supabase: { from: mockFrom, rpc: vi.fn() } };
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
});
