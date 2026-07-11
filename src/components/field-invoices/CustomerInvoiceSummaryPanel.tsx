import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, FileText, Printer, Layers } from 'lucide-react';
import Card from '../ui/Card';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { runCriticalAction } from '../../lib/criticalAction';
import { formatCents as fmt } from '../../lib/money';
import { localToday, parseLocalDate } from '../../lib/dateUtils';
import { SkeletonTable } from '../ui/Skeleton';
import {
  buildCustomerInvoiceSummary,
  type SummaryInvoiceRow,
  type SummaryTotals,
} from '../../lib/customerInvoiceSummary';
import { downloadCustomerInvoiceSummaryPdf } from '../../lib/invoiceSummaryPdf';

/**
 * CustomerInvoiceSummary.tsx — field-app parity #34.
 *
 * ChemMan's "Customer Invoice Summary" (/reportCondensedUnpostedInvoice.php):
 * a consolidated, customer-facing statement that combines a customer's UNPOSTED
 * chemical-sales invoices AND UNPOSTED field-application invoices into ONE
 * document, with a per-type subtotal and a single combined total + balance.
 *
 * This is a READ-ONLY report. Heading Date / Discount Date / Terms / Invoice
 * Comment are report inputs only — they print on the PDF and are NOT persisted
 * (matches ChemMan: these are heading fields on the report, not invoice edits).
 *
 * Money is integer cents end-to-end; the per-type subtotals + combined total are
 * computed by the pure, tested buildCustomerInvoiceSummary() so the on-screen and
 * printed numbers are always identical.
 */

// Both invoice types live in one `invoices` table. We pull a customer's UNPOSTED
// rows (draft|unposted) of BOTH types in one query and partition client-side.
const SUMMARY_SELECT =
  'id, invoice_number, invoice_type, status, invoice_date, total_amount_cents, paid_amount_cents, prepay_applied_cents, write_off_cents, discount_earned_cents, balance_cents';

interface CustomerOption {
  id: string;
  farm_name: string;
  account_number: string | null;
  billing_address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payment_terms: string | null;
}

export default function CustomerInvoiceSummaryPanel() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [headingDate, setHeadingDate] = useState(localToday());
  const [discountDate, setDiscountDate] = useState('');
  const [terms, setTerms] = useState('');
  const [comment, setComment] = useState('');

  const [rows, setRows] = useState<SummaryInvoiceRow[] | null>(null);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [printing, setPrinting] = useState(false);

  // Load customers once for the selector.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('customers')
        .select('id, farm_name, account_number, billing_address, city, state, zip, payment_terms')
        .order('farm_name');
      if (cancelled) return;
      if (error) {
        Sentry.captureException(error, { tags: { source: 'fetch', page: 'customer-invoice-summary' } });
        toast('error', 'Failed to load customers');
        setLoadingCustomers(false);
        return;
      }
      setCustomers((data || []) as CustomerOption[]);
      setLoadingCustomers(false);
    })();
    return () => { cancelled = true; };
  }, [toast]);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) || null,
    [customers, selectedCustomerId]
  );

  // Default the Terms input to the customer's payment terms when they're picked
  // (the user can override; still report-only). Only seeds an empty Terms box so
  // we never clobber what the user typed.
  useEffect(() => {
    if (selectedCustomer && terms.trim() === '' && selectedCustomer.payment_terms) {
      setTerms(selectedCustomer.payment_terms);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomerId]);

  const loadSummary = useCallback(async (customerId: string) => {
    setLoadingSummary(true);
    const { data, error } = await supabase
      .from('invoices')
      .select(SUMMARY_SELECT)
      .eq('customer_id', customerId)
      .in('invoice_type', ['chemical_sale', 'field_application'])
      .in('status', ['draft', 'unposted'])
      .is('deleted_at', null)
      .order('invoice_date', { ascending: true });

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch_summary', page: 'customer-invoice-summary' } });
      toast('error', 'Failed to load invoice summary');
      setLoadingSummary(false);
      return;
    }

    const mapped: SummaryInvoiceRow[] = ((data || []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      invoice_number: String(r.invoice_number ?? ''),
      invoice_type: r.invoice_type as SummaryInvoiceRow['invoice_type'],
      status: r.status as SummaryInvoiceRow['status'],
      invoice_date: String(r.invoice_date ?? ''),
      total_amount_cents: Number(r.total_amount_cents) || 0,
      paid_amount_cents: Number(r.paid_amount_cents) || 0,
      prepay_applied_cents: Number(r.prepay_applied_cents) || 0,
      write_off_cents: Number(r.write_off_cents) || 0,
      discount_earned_cents: Number(r.discount_earned_cents) || 0,
      balance_cents: Number(r.balance_cents) || 0,
    }));
    setRows(mapped);
    setLoadingSummary(false);
  }, [toast]);

  const handleViewReport = () => {
    if (!selectedCustomerId) {
      toast('error', 'Select a customer first');
      return;
    }
    void loadSummary(selectedCustomerId);
  };

  const summary = useMemo(
    () => (rows ? buildCustomerInvoiceSummary(rows) : null),
    [rows]
  );

  const handlePrint = async () => {
    if (!summary || !selectedCustomer) return;
    await runCriticalAction({
      action: async () => {
        await downloadCustomerInvoiceSummaryPdf({
          customer_name: selectedCustomer.farm_name,
          customer_account_number: selectedCustomer.account_number || undefined,
          customer_address: selectedCustomer.billing_address || undefined,
          customer_city: selectedCustomer.city || undefined,
          customer_state: selectedCustomer.state || undefined,
          customer_zip: selectedCustomer.zip || undefined,
          heading_date: headingDate,
          discount_date: discountDate || undefined,
          terms: terms.trim() || undefined,
          invoice_comment: comment.trim() || undefined,
          summary,
        });
      },
      toast,
      successMessage: `Customer Invoice Summary downloaded for ${selectedCustomer.farm_name}`,
      setLoading: setPrinting,
      sentryTag: 'customer_invoice_summary_print',
    });
  };

  return (
    <div className="min-w-0 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate('/field-invoices')}
          className="p-1.5 rounded-lg hover:bg-gray-100 text-secondary"
          aria-label="Back to field invoices"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Customer Invoice Summary</h2>
          <p className="text-xs text-secondary mt-0.5">
            One combined statement of a customer's unposted chemical sales and unposted field application invoices.
          </p>
        </div>
      </div>

      {/* Report inputs */}
      <Card>
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="w-full min-w-0 sm:min-w-[14rem] sm:w-auto">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="cis-customer">Customer</label>
            <select
              id="cis-customer"
              value={selectedCustomerId}
              onChange={(e) => { setSelectedCustomerId(e.target.value); setRows(null); }}
              disabled={loadingCustomers}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Select customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.farm_name}</option>
              ))}
            </select>
          </div>
          <div className="w-full sm:w-auto">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="cis-heading-date">Heading Date</label>
            <input
              id="cis-heading-date"
              type="date"
              value={headingDate}
              onChange={(e) => setHeadingDate(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 sm:w-auto"
            />
          </div>
          <div className="w-full sm:w-auto">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="cis-discount-date">Discount Date</label>
            <input
              id="cis-discount-date"
              type="date"
              value={discountDate}
              onChange={(e) => setDiscountDate(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 sm:w-auto"
            />
          </div>
          <div className="w-full sm:w-auto">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="cis-terms">Terms</label>
            <input
              id="cis-terms"
              type="text"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="e.g. Net 30"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20 sm:w-40"
            />
          </div>
          <div className="w-full min-w-0 flex-1 sm:min-w-[14rem]">
            <label className="block text-xs font-medium text-secondary mb-1" htmlFor="cis-comment">Invoice Comment</label>
            <input
              id="cis-comment"
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Optional comment printed on the summary"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <Button
            variant="primary"
            icon={<FileText className="w-4 h-4" />}
            onClick={handleViewReport}
            disabled={!selectedCustomerId || loadingCustomers}
          >
            View Report
          </Button>
        </div>
      </Card>

      {loadingSummary && (
        <div className="p-2">
          <SkeletonTable rows={6} />
        </div>
      )}

      {!loadingSummary && summary && selectedCustomer && (
        <>
          {/* Statement summary header */}
          <Card>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h3 className="text-lg font-semibold text-nav-dark">{selectedCustomer.farm_name}</h3>
                <p className="text-xs text-secondary">
                  Heading date: {parseLocalDate(headingDate).toLocaleDateString()}
                  {discountDate ? ` · Discount date: ${parseLocalDate(discountDate).toLocaleDateString()}` : ''}
                  {terms.trim() ? ` · Terms: ${terms.trim()}` : ''}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-secondary">Combined Balance</p>
                <p className={`text-xl font-semibold font-heading ${summary.combinedTotal.balanceCents > 0 ? 'text-red-600' : 'text-crx-green'}`}>
                  {fmt(summary.combinedTotal.balanceCents)}
                </p>
              </div>
            </div>
          </Card>

          {summary.combinedTotal.count === 0 ? (
            <Card>
              <div className="text-center py-8">
                <Layers className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                <p className="text-secondary">No unposted chemical sales or field application invoices for this customer.</p>
              </div>
            </Card>
          ) : (
            <>
              <SummarySection title="Chemical Sales" rows={summary.chemicalRows} subtotal={summary.chemicalSubtotal} />
              <SummarySection title="Field Application" rows={summary.fieldRows} subtotal={summary.fieldSubtotal} />

              {/* Combined total */}
              <Card>
                <div className="flex flex-col items-end gap-1 text-sm">
                  <div className="flex justify-between w-full max-w-xs">
                    <span className="text-secondary">Combined Total ({summary.combinedTotal.count})</span>
                    <span className="font-mono">{fmt(summary.combinedTotal.totalAmountCents)}</span>
                  </div>
                  {summary.combinedTotal.paidAmountCents > 0 && (
                    <div className="flex justify-between w-full max-w-xs">
                      <span className="text-secondary">Payments</span>
                      <span className="font-mono text-crx-green">-{fmt(summary.combinedTotal.paidAmountCents)}</span>
                    </div>
                  )}
                  {summary.combinedTotal.prepayAppliedCents > 0 && (
                    <div className="flex justify-between w-full max-w-xs">
                      <span className="text-secondary">Prepay Applied</span>
                      <span className="font-mono text-crx-green">-{fmt(summary.combinedTotal.prepayAppliedCents)}</span>
                    </div>
                  )}
                  {summary.combinedTotal.writeOffCents > 0 && (
                    <div className="flex justify-between w-full max-w-xs">
                      <span className="text-secondary">Write-off</span>
                      <span className="font-mono text-crx-green">-{fmt(summary.combinedTotal.writeOffCents)}</span>
                    </div>
                  )}
                  <div className="flex justify-between w-full max-w-xs border-t border-gray-200 pt-1 mt-1">
                    <span className="font-semibold text-nav-dark">Combined Balance</span>
                    <span className={`font-mono font-semibold ${summary.combinedTotal.balanceCents > 0 ? 'text-red-600' : 'text-crx-green'}`}>
                      {fmt(summary.combinedTotal.balanceCents)}
                    </span>
                  </div>
                  {summary.combinedTotal.discountEarnedCents > 0 && (
                    <div className="flex justify-between w-full max-w-xs">
                      <span className="text-xs text-secondary">Discount Earned (if paid early)</span>
                      <span className="font-mono text-xs text-secondary">{fmt(summary.combinedTotal.discountEarnedCents)}</span>
                    </div>
                  )}
                </div>
              </Card>

              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  icon={<Printer className="w-4 h-4" />}
                  onClick={handlePrint}
                  loading={printing}
                >
                  Print / Download PDF
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── Section table (Chemical Sales / Field Application) ──────────────────────
function SummarySection({
  title,
  rows,
  subtotal,
}: {
  title: string;
  rows: SummaryInvoiceRow[];
  subtotal: SummaryTotals;
}) {
  if (rows.length === 0) {
    return (
      <Card padding={false}>
        <div className="px-4 py-3 border-b border-gray-100">
          <h4 className="text-sm font-semibold text-nav-dark">{title}</h4>
        </div>
        <p className="px-4 py-4 text-sm text-secondary">No unposted {title.toLowerCase()} invoices.</p>
      </Card>
    );
  }
  return (
    <Card padding={false}>
      <div className="px-4 py-3 border-b border-gray-100">
        <h4 className="text-sm font-semibold text-nav-dark">{title}</h4>
      </div>
      <div className="max-w-full overflow-x-auto overscroll-x-contain">
        <table className="min-w-[36rem] w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-secondary uppercase tracking-wide">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Invoice #</th>
              <th className="px-3 py-2 font-medium text-right">Total</th>
              <th className="px-3 py-2 font-medium text-right">Paid</th>
              <th className="px-3 py-2 font-medium text-right">Prepay</th>
              <th className="px-3 py-2 font-medium text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-gray-50">
                <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                  {new Date(r.invoice_date + 'T00:00:00').toLocaleDateString()}
                </td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 font-medium text-nav-dark">
                    <FileText className="w-3.5 h-3.5 text-crx-green flex-shrink-0" />
                    {r.invoice_number}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(r.total_amount_cents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(r.paid_amount_cents)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmt(r.prepay_applied_cents)}</td>
                <td className="px-3 py-2 text-right tabular-nums font-medium">{fmt(r.balance_cents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-200 bg-gray-50/60 font-semibold text-nav-dark">
              <td className="px-3 py-2" colSpan={2}>Subtotal — {title} ({subtotal.count})</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(subtotal.totalAmountCents)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(subtotal.paidAmountCents)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(subtotal.prepayAppliedCents)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(subtotal.balanceCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
