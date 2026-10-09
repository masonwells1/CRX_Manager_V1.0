/**
 * FieldInvoicesSeasonWindow.test.tsx — the Field Invoices tabs after the Oct 1 rollover.
 *
 * Bug (2026-10-09): every Field Invoices tab only fetched the CURRENT season, so on Oct 1
 * the prior-season unposted field invoice disappeared from the Drafts tab, its badge, its
 * footer totals and Post All (and posted-but-unpaid ones from the Posted / All tabs).
 * The rule now: an OPEN invoice (draft, unposted, posted, overdue) shows whatever season it
 * is in, labelled with its season; only CLOSED ones (paid, voided, cancelled) stay
 * season-windowed. The supabase mock applies the panels' real filters to an in-memory row
 * set, so these tests prove which rows the queries actually return.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../../test-utils/inMemoryQuery';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { from: mockFrom, rpc: mockRpc } };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import FieldInvoicesUnpostedPanel from './FieldInvoicesUnpostedPanel';
import FieldInvoicesPostedPanel from './FieldInvoicesPostedPanel';
import FieldInvoicesListPanel from './FieldInvoicesListPanel';
import FieldInvoices from '../../pages/FieldInvoices';

function fieldInvoice(overrides: Record<string, unknown>) {
  return {
    id: overrides.invoice_number,
    invoice_type: 'field_application',
    customer_id: 'cust-1',
    customer: { farm_name: 'Test Farm' },
    job: null,
    job_id: null,
    blend_ticket_id: null,
    invoice_group_id: null,
    deleted_at: null,
    field_app_locations: [],
    invoice_items: [],
    total_acres: 10,
    total_amount_cents: 278578,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    balance_cents: 278578,
    ...overrides,
  };
}

// "Today" is 2026-10-09, so the current season is 2027 (Oct 1 2026 – Sep 30 2027).
const ROWS = [
  fieldInvoice({ invoice_number: 'FA-OLD-UNPOSTED', status: 'unposted', season: 2026, invoice_date: '2026-08-08', created_at: '2026-08-08T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-OLD-DRAFT', status: 'draft', season: 2026, invoice_date: '2026-07-01', created_at: '2026-07-01T15:00:00+00:00', total_amount_cents: 100000, balance_cents: 100000 }),
  fieldInvoice({ invoice_number: 'FA-OLD-OVERDUE', status: 'overdue', season: 2026, invoice_date: '2026-06-01', created_at: '2026-06-01T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-OLD-PAID', status: 'paid', season: 2026, balance_cents: 0, invoice_date: '2026-06-02', created_at: '2026-06-02T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-OLD-VOIDED', status: 'voided', season: 2026, balance_cents: 0, invoice_date: '2026-06-03', created_at: '2026-06-03T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-NEW-PAID', status: 'paid', season: 2027, balance_cents: 0, invoice_date: '2026-10-02', created_at: '2026-10-02T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-NEW-DRAFT', status: 'draft', season: 2027, invoice_date: '2026-10-03', created_at: '2026-10-03T15:00:00+00:00', total_amount_cents: 50000, balance_cents: 50000 }),
];

function renderInRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('Field Invoices tabs — season window after the Oct 1 rollover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? ROWS : []));
    mockRpc.mockImplementation(() => ({
      throwOnError: () => Promise.resolve({ data: null, error: null }),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Drafts tab lists prior-season unposted invoices with their season, and the footer totals include them', async () => {
    renderInRouter(<FieldInvoicesUnpostedPanel />);

    await waitFor(() => expect(screen.getAllByText('FA-OLD-UNPOSTED').length).toBeGreaterThan(0));
    expect(screen.getAllByText('FA-OLD-DRAFT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('FA-NEW-DRAFT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Season 2026').length).toBeGreaterThan(0);
    // Footer: 3 invoices, $2,785.78 + $1,000.00 + $500.00 = $4,285.78.
    expect(screen.getByText('Invoices Displayed: 3')).toBeInTheDocument();
    expect(screen.getByText('$4,285.78')).toBeInTheDocument();
  });

  it('Post All reaches the prior-season unposted invoice through the normal server post_invoice call, and its confirm says so', async () => {
    renderInRouter(<FieldInvoicesUnpostedPanel />);
    await waitFor(() => expect(screen.getAllByText('FA-OLD-UNPOSTED').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Post All/ }));
    // post_invoice has no season or closed-month check, so the confirm must name the
    // earlier-season invoices it is about to post (FA-OLD-UNPOSTED + FA-OLD-DRAFT).
    expect(await screen.findByText(/This includes 2 invoice\(s\) from an earlier season \(Season 2026\)/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Post 3 target(s)' }));

    await waitFor(() => {
      const posted = mockRpc.mock.calls
        .filter(([name]) => name === 'post_invoice')
        .map(([, args]) => (args as { p_invoice_id: string }).p_invoice_id);
      expect(posted).toEqual(expect.arrayContaining(['FA-OLD-UNPOSTED', 'FA-OLD-DRAFT', 'FA-NEW-DRAFT']));
    });
    // Nothing season-specific is sent. NOTE: post_invoice has NO season or closed-month
    // check on the server, so the confirm text above is the only prior-season warning.
    const postArgs = mockRpc.mock.calls.filter(([name]) => name === 'post_invoice').map(([, args]) => args);
    for (const args of postArgs) expect(Object.keys(args as object).sort()).toEqual(['p_idempotency_key', 'p_invoice_id']);
  });

  it('Posted tab keeps prior-season overdue invoices but season-windows paid ones', async () => {
    renderInRouter(<FieldInvoicesPostedPanel />);

    await waitFor(() => expect(screen.getAllByText('FA-NEW-PAID').length).toBeGreaterThan(0));
    expect(screen.getAllByText('FA-OLD-OVERDUE').length).toBeGreaterThan(0);
    expect(screen.queryByText('FA-OLD-PAID')).not.toBeInTheDocument();
  });

  it('Unpost All in the default scope only touches this season; an older invoice needs its month batch chosen', async () => {
    const thisSeasonPosted = fieldInvoice({ invoice_number: 'FA-NEW-POSTED', status: 'posted', season: 2027, invoice_date: '2026-10-04', created_at: '2026-10-04T15:00:00+00:00' });
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? [...ROWS, thisSeasonPosted] : []));
    mockRpc.mockImplementation(() => Promise.resolve({ data: true, error: null }));
    renderInRouter(<FieldInvoicesPostedPanel />);
    await waitFor(() => expect(screen.getAllByText('FA-OLD-OVERDUE').length).toBeGreaterThan(0));

    // The prior-season month is labelled as holding only its unpaid invoices.
    expect(screen.getByRole('option', { name: /June 2026 \(1\) — unpaid only/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /October 2026 \(2\)$/ })).toBeInTheDocument();

    // Default scope: FA-OLD-OVERDUE is listed but NOT an Unpost All candidate.
    fireEvent.click(screen.getByRole('button', { name: 'Unpost All (1)' }));
    expect(await screen.findByText(/1 unpaid invoice\(s\) from an earlier season in view are NOT included/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unpost 1' }));
    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'unpost_invoice')).toHaveLength(1));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'unpost_invoice').map(([, args]) => (args as { p_invoice_id: string }).p_invoice_id))
      .toEqual(['FA-NEW-POSTED']);

    // Choosing the June 2026 batch is the explicit opt-in that reaches the older invoice.
    fireEvent.change(screen.getByLabelText('Posting scope'), { target: { value: '2026-06' } });
    expect(await screen.findByRole('button', { name: 'Unpost All (1)' })).toBeEnabled();
  });

  it('All Invoices tab keeps prior-season open invoices but season-windows closed ones', async () => {
    renderInRouter(<FieldInvoicesListPanel />);

    await waitFor(() => expect(screen.getAllByText(/FA-OLD-UNPOSTED/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/FA-OLD-OVERDUE/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/FA-NEW-PAID/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/FA-OLD-PAID/)).not.toBeInTheDocument();
    expect(screen.queryByText(/FA-OLD-VOIDED/)).not.toBeInTheDocument();
  });

  it('tab badges count prior-season open invoices', async () => {
    renderInRouter(<FieldInvoices />);

    // Drafts: FA-OLD-UNPOSTED + FA-OLD-DRAFT + FA-NEW-DRAFT. Posted: FA-OLD-OVERDUE + FA-NEW-PAID.
    await waitFor(() => expect(within(screen.getByRole('tab', { name: /Drafts/ })).getByText('3')).toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByRole('tab', { name: /Posted/ })).getByText('2')).toBeInTheDocument());
  });
});
