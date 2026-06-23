import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { traceLot } from '../lib/lotRpc';
import { sanitizeError } from '../lib/db';
import { Sentry } from '../lib/sentry';
import { parseLocalDate } from '../lib/dateUtils';
import type { LotApplicationTraceRow } from '../types';

/**
 * Lot Trace — the recall / compliance payoff of B1. Enter a lot number and see every
 * application that used it: product, field(s), date, customer, applicator, record #, invoice.
 * Reads through get_lot_application_trace (admin/sales gated, case-insensitive). The migration
 * that creates the RPC is parked pending go-live, so this lands together with it; the page is
 * proven by a mocked-RPC component test until then (live walkthrough moves to post-apply).
 */
export default function LotTrace() {
  const { toast } = useToast();
  const [lotNumber, setLotNumber] = useState('');
  const [rows, setRows] = useState<LotApplicationTraceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchedLot, setSearchedLot] = useState('');
  // A FAILED lookup must never read as "nothing found" — for a recall/compliance search that
  // false negative is dangerous. On error we surface this instead of the empty-results state.
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    const lot = lotNumber.trim();
    if (!lot) {
      toast('error', 'Enter a lot number to trace');
      return;
    }
    setLoading(true);
    setSearchedLot(lot);
    setSearchError(null);
    try {
      const result = await traceLot(lot);
      setRows(result);
      setSearched(true);
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'rpc', action: 'get_lot_application_trace' } });
      const msg = sanitizeError(err);
      toast('error', msg);
      setRows([]);
      setSearchError(msg); // do NOT mark as a completed (empty) search — it failed
    } finally {
      setLoading(false);
    }
  };

  const columns: Column<LotApplicationTraceRow>[] = [
    {
      key: 'lot_number',
      header: 'Lot #',
      sortable: true,
      render: (r) => <span className="font-mono text-xs font-medium text-nav-dark">{r.lot_number}</span>,
    },
    {
      key: 'product_name',
      header: 'Product',
      sortable: true,
      render: (r) => <span className="font-medium">{r.product_name || '—'}</span>,
    },
    {
      key: 'application_date',
      header: 'Applied',
      sortable: true,
      render: (r) => parseLocalDate(r.application_date).toLocaleDateString(),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (r) => r.customer_name || '—',
    },
    {
      key: 'field_names',
      header: 'Field(s)',
      render: (r) => r.field_names || '—',
    },
    {
      key: 'applicator_name',
      header: 'Applicator',
      sortable: true,
      render: (r) => r.applicator_name || '—',
    },
    {
      key: 'record_number',
      header: 'Record #',
      sortable: true,
      render: (r) => <span className="font-mono text-xs">{r.record_number}</span>,
    },
    {
      key: 'source_receiving_record_id',
      header: 'Source',
      render: (r) => (
        <Badge variant={r.source_receiving_record_id ? 'info' : 'default'}>
          {r.source_receiving_record_id ? 'Received lot' : 'Entered'}
        </Badge>
      ),
    },
    {
      key: 'invoice_id',
      header: 'Invoiced',
      render: (r) => (r.invoice_id ? <Badge variant="success">Yes</Badge> : <span className="text-secondary">—</span>),
    },
  ];

  return (
    <div className="space-y-6">
      <SplitHeading title="Lot" accent="Trace" />

      <Card>
        <form onSubmit={handleSearch} className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[16rem]">
            <label htmlFor="lot-trace-input" className="block text-xs font-medium text-secondary mb-1">
              Lot number
            </label>
            <input
              id="lot-trace-input"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              placeholder="e.g. ABC-12345"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <Button
            type="submit"
            icon={<Search className="w-4 h-4" />}
            showChevron={false}
            disabled={loading}
          >
            {loading ? 'Tracing…' : 'Trace lot'}
          </Button>
        </form>
        <p className="mt-2 text-xs text-secondary">
          Find every application that used a lot — its products, fields, dates, customers, and applicators.
          Matching is case-insensitive.
        </p>
      </Card>

      {searchError ? (
        <Card>
          <div className="py-8 text-center text-sm text-red-600">
            Couldn't trace lot <span className="font-mono">{searchedLot}</span>: {searchError}. This is a
            failed lookup, not a confirmed "no results" — please try again.
          </div>
        </Card>
      ) : searched ? (
        <Card padding={false}>
          <div className="p-5">
            {rows.length > 0 && (
              <p className="mb-3 text-sm text-secondary">
                {rows.length} application{rows.length !== 1 ? 's' : ''} used lot{' '}
                <span className="font-mono text-nav-dark">{searchedLot}</span>.
              </p>
            )}
            <DataTable
              data={rows as unknown as Record<string, unknown>[]}
              columns={columns as unknown as Column<Record<string, unknown>>[]}
              searchable
              searchPlaceholder="Filter results..."
              searchKeys={['lot_number', 'product_name', 'customer_name', 'field_names', 'applicator_name', 'record_number']}
              emptyTitle={`No applications found for "${searchedLot}"`}
              emptyDescription="No application has recorded this lot. Check the number, or it may not be entered yet."
              loading={loading}
            />
          </div>
        </Card>
      ) : null}
    </div>
  );
}
