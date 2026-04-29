import type { CustomerShareResult, PreviewFieldAppSplitResult } from '../../types';

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
}

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export default function CustomerSharesTable({ shares, invoiceTotalCents, preview }: CustomerSharesTableProps) {
  // Server-computed preview path (Phase 1 split-aware): show real per-customer
  // amounts including grower-share lines, chemical lines, and service fees.
  if (preview && preview.per_customer.length > 0) {
    return (
      <div className="space-y-4">
        {preview.per_customer.map((c) => (
          <div key={c.customer_id} className="border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b">
              <div className="font-medium">
                {c.customer_name}
                {c.is_primary && (
                  <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-crx-green/10 text-crx-green font-normal">
                    Primary
                  </span>
                )}
                <span className="ml-2 text-xs text-gray-500">Tier {c.tier}</span>
              </div>
              <div className="font-semibold tabular-nums">{fmt(c.total_cents)}</div>
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
                {c.lines.map((l, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-4 py-1.5">
                      {l.kind === 'grower_share' && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 mr-2">grower</span>
                      )}
                      {l.kind === 'service_fee' && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 mr-2">service</span>
                      )}
                      {l.description}
                    </td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{l.quantity.toFixed(2)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums">{fmt(l.unit_price_cents)}</td>
                    <td className="px-4 py-1.5 text-right tabular-nums font-medium">{fmt(l.extended_cents)}</td>
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
            Grand Total: <span className="font-semibold text-gray-900">{fmt(preview.grand_total_cents)}</span>
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
              <td className="px-4 py-2 text-right text-xs italic text-gray-400">{fmt(invoiceTotalCents)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
