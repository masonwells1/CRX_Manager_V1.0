import type { CustomerShareResult, PreviewFieldAppSplitResult } from '../../types';
import { formatCents } from '../../lib/money';
import {
  deriveSplitRef,
  reconcileSplit,
  customerShareAcres,
  customerSharePct,
  CUSTOMER_SHARES_BASIS_OPTIONS,
  type CustomerSharesBasis,
} from './customerSplit';

interface CustomerSharesTableProps {
  /**
   * Legacy customer share data (used until a preview is available).
   * Shows split %, acres, and a placeholder amount column.
   */
  shares: CustomerShareResult[];
  invoiceTotalCents: number;

  /**
   * Phase 1 (2026-04-29): when set, replaces the legacy table with the
   * server-computed per-customer breakdown including line items.
   * Returned by preview_field_app_invoice_split RPC.
   */
  preview?: PreviewFieldAppSplitResult | null;

  /**
   * #26: "Customer Shares By" basis (Locations / Share %). Controls how the
   * per-customer SUMMARY row labels each customer's "Total Shares" — it does NOT
   * change the dollars (the engine always splits by acres-weighted location
   * share). Optional; defaults to 'location'.
   */
  sharesBasis?: CustomerSharesBasis;
  onSharesBasisChange?: (basis: CustomerSharesBasis) => void;

  /**
   * #26: split numbering base — the source JOB number when this invoice came
   * from a job, else the group's primary invoice number. Used to render the
   * ChemMan "<base>-<NNN>" Split Ref per customer. Optional.
   */
  splitRefBase?: string | null;

  /**
   * #33: per-customer "Discount Earned" — owner-entered early-pay discount in
   * TYPED DOLLARS (string, blank/partial allowed mid-edit) + an optional date,
   * keyed by customer_id. Display/edit ONLY — it is informational and NEVER
   * reduces the billed Invoice Total (the real reduction flows through
   * payments/write-off). Stored per-invoice as bigint cents by the parent.
   */
  discountByCustomer?: Record<string, { dollars: string; date: string }>;
  /**
   * #33: edit callback for the Discount Earned column. When omitted the column is
   * read-only (a posted/locked invoice). Patches dollars and/or date for one customer.
   */
  onDiscountChange?: (customerId: string, patch: { dollars?: string; date?: string }) => void;
}


export default function CustomerSharesTable({
  shares,
  invoiceTotalCents,
  preview,
  sharesBasis = 'location',
  onSharesBasisChange,
  splitRefBase,
  discountByCustomer,
  onDiscountChange,
}: CustomerSharesTableProps) {
  // #33: parse a typed dollars string to bigint cents (0 when blank/invalid). Used
  // only to SUM the Discount Earned column footer — never to alter Invoice Total.
  const discountCents = (custId: string): number => {
    const dollars = parseFloat(discountByCustomer?.[custId]?.dollars ?? '');
    return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
  };
  // Server-computed preview path (Phase 1 split-aware): show real per-customer
  // amounts including grower-share lines, chemical lines, and service fees.
  if (preview && preview.per_customer.length > 0) {
    const isSplit = preview.per_customer.length > 1;
    const recon = reconcileSplit(preview);

    return (
      <div className="space-y-4">
        {/* #26: "Customer Shares By" basis selector (ChemMan parity). */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-gray-600 whitespace-nowrap">Customer Shares By:</span>
            <select
              value={sharesBasis}
              onChange={(e) => onSharesBasisChange?.(e.target.value as CustomerSharesBasis)}
              disabled={!onSharesBasisChange}
              className="border rounded px-2 py-1 text-sm disabled:bg-gray-50 disabled:text-gray-500"
            >
              {CUSTOMER_SHARES_BASIS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>

          {/* #26: explicit reconciliation badge — the split totals must equal the
              whole (penny-exact dollars + conserved acres). */}
          {recon.balanced ? (
            <span className="text-xs px-2 py-1 rounded bg-crx-green/10 text-crx-green font-medium">
              Reconciles · {formatCents(recon.grandTotalCents)} · {recon.totalAppliedAcres.toFixed(2)} ac
            </span>
          ) : (
            <span className="text-xs px-2 py-1 rounded bg-red-50 text-red-700 font-medium">
              Mismatch · split sums {formatCents(recon.sumCustomerCents)} / {recon.sumCustomerAcres.toFixed(2)} ac
              {' '}vs whole {formatCents(recon.grandTotalCents)} / {recon.totalAppliedAcres.toFixed(2)} ac
            </span>
          )}
        </div>

        {/* #26: per-customer SUMMARY table — ChemMan Customers-tab columns:
            Name, Total Shares, Total acres, Discount Earned, Invoice Total. */}
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 bg-gray-50">
              <tr className="border-b">
                {isSplit && <th className="px-4 py-2 text-left font-medium">Split Ref</th>}
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-right font-medium">Total Shares</th>
                <th className="px-4 py-2 text-right font-medium">Total acres</th>
                <th className="px-4 py-2 text-right font-medium">Discount Earned</th>
                <th className="px-4 py-2 text-right font-medium">Invoice Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {preview.per_customer.map((c, idx) => {
                const acres = customerShareAcres(preview, c.customer_id);
                const pct = customerSharePct(preview, c.customer_id);
                // "Total Shares": by-location shows acres; by-share shows the
                // overall percentage. Same money either way.
                const totalShares = sharesBasis === 'share'
                  ? `${pct.toFixed(2)}%`
                  : `${acres.toFixed(2)} ac`;
                return (
                  <tr key={c.customer_id} className="hover:bg-gray-50">
                    {isSplit && (
                      <td className="px-4 py-2 tabular-nums text-gray-700">
                        {deriveSplitRef(splitRefBase || '', idx, true)}
                      </td>
                    )}
                    <td className="px-4 py-2 font-medium">
                      {c.customer_name}
                      {c.is_primary && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-crx-green/10 text-crx-green font-normal">
                          Primary
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{totalShares}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{acres.toFixed(2)}</td>
                    {/* #33: Discount Earned — owner-entered early-pay discount (DOLLARS),
                        per customer. Informational ONLY: it is recorded/printed but does
                        NOT reduce the Invoice Total. Editable when onDiscountChange is set
                        (a draft/unposted invoice); read-only (the saved amount) otherwise. */}
                    <td className="px-4 py-2 text-right tabular-nums">
                      {onDiscountChange ? (
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex items-center justify-end gap-1">
                            <span className="text-gray-400">$</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={discountByCustomer?.[c.customer_id]?.dollars ?? ''}
                              onChange={(e) => onDiscountChange(c.customer_id, { dollars: e.target.value })}
                              placeholder="0.00"
                              className="w-24 px-2 py-1 border rounded text-right text-sm tabular-nums"
                              title="Early-pay discount earned — recorded & printed, does not reduce the invoice total"
                            />
                          </div>
                          <input
                            type="date"
                            value={discountByCustomer?.[c.customer_id]?.date ?? ''}
                            onChange={(e) => onDiscountChange(c.customer_id, { date: e.target.value })}
                            className="w-32 px-2 py-1 border rounded text-right text-xs text-gray-600"
                            title="Discount date (optional)"
                          />
                        </div>
                      ) : (
                        <span className={discountCents(c.customer_id) > 0 ? '' : 'text-gray-400'}>
                          {formatCents(discountCents(c.customer_id))}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">{formatCents(c.total_cents)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 font-semibold border-t">
                {isSplit && <td className="px-4 py-2" />}
                <td className="px-4 py-2">Totals</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {sharesBasis === 'share' ? '100.00%' : `${recon.sumCustomerAcres.toFixed(2)} ac`}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{recon.sumCustomerAcres.toFixed(2)}</td>
                {/* #33: sum of Discount Earned across customers — informational; it is
                    NOT subtracted from the Invoice Total below (no double-count). */}
                <td className="px-4 py-2 text-right tabular-nums">
                  {formatCents(preview.per_customer.reduce((s, c) => s + discountCents(c.customer_id), 0))}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{formatCents(recon.sumCustomerCents)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Per-customer line-item detail (unchanged from Phase 1). */}
        {preview.per_customer.map((c, idx) => (
          <div key={c.customer_id} className="border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b">
              <div className="font-medium">
                {isSplit && (
                  <span className="mr-2 text-xs px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 tabular-nums">
                    {deriveSplitRef(splitRefBase || '', idx, true)}
                  </span>
                )}
                {c.customer_name}
                {c.is_primary && (
                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-crx-green/10 text-crx-green font-normal">
                    Primary
                  </span>
                )}
                <span className="ml-2 text-xs text-gray-500">Tier {c.tier}</span>
              </div>
              <div className="font-semibold tabular-nums">{formatCents(c.total_cents)}</div>
            </div>
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500">
                <tr className="border-b">
                  <th className="px-4 py-1.5 text-left font-medium">Line</th>
                  <th className="px-4 py-1.5 text-right font-medium w-24">Qty</th>
                  <th className="px-4 py-1.5 text-right font-medium w-28">Unit Price</th>
                  <th className="px-4 py-1.5 text-right font-medium w-28">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {c.lines.map((l, lineIdx) => (
                  <tr key={lineIdx} className="hover:bg-gray-50">
                    <td className="px-4 py-1.5">
                      {l.kind === 'grower_share' && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 mr-2">grower</span>
                      )}
                      {l.kind === 'service_fee' && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 mr-2">service</span>
                      )}
                      {l.kind === 'fuel_surcharge' && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 mr-2">fuel</span>
                      )}
                      {l.description}
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{l.quantity.toFixed(2)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{formatCents(l.unit_price_cents)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums font-medium">{formatCents(l.extended_cents)}</td>
                  </tr>
                ))}
                {c.lines.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-3 text-center text-gray-400 text-xs">No lines yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
        <div className="flex justify-end gap-6 pt-2 border-t text-sm">
          <div className="text-gray-600">
            Customers: <span className="font-semibold">{preview.customer_count}</span>
          </div>
          <div className="text-gray-600">
            Grand Total: <span className="font-semibold text-gray-900">{formatCents(preview.grand_total_cents)}</span>
          </div>
        </div>
      </div>
    );
  }

  // Legacy/no-preview path: shows split %, acres, and a placeholder for amount.
  // After Phase 1 the placeholder reflects the truth that final amounts come
  // from the server (via preview button or after save).
  const totalPct = shares.reduce((s, sh) => s + sh.split_pct, 0);
  const totalAcres = shares.reduce((s, sh) => s + sh.total_acres, 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-50 border-b">
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Customer</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Share %</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Acres</th>
            <th className="px-4 py-2 text-right text-xs font-medium text-gray-500">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {shares.map((sh) => (
            <tr key={sh.customer_id} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-medium">
                {sh.customer_name}
                {sh.is_primary && (
                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-crx-green/10 text-crx-green font-normal">
                    Primary
                  </span>
                )}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{sh.split_pct.toFixed(2)}%</td>
              <td className="px-4 py-2 text-right tabular-nums">{sh.total_acres.toFixed(1)}</td>
              <td className="px-4 py-2 text-right text-xs italic text-gray-400">
                Click Preview for amounts
              </td>
            </tr>
          ))}
          {shares.length === 0 && (
            <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">Select locations to see customer shares</td></tr>
          )}
        </tbody>
        {shares.length > 0 && (
          <tfoot>
            <tr className="bg-gray-50 font-semibold border-t">
              <td className="px-4 py-2">Totals</td>
              <td className="px-4 py-2 text-right tabular-nums">{totalPct.toFixed(2)}%</td>
              <td className="px-4 py-2 text-right tabular-nums">{totalAcres.toFixed(1)}</td>
              <td className="px-4 py-2 text-right text-xs italic text-gray-400">{formatCents(invoiceTotalCents)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
