import type { CustomerShareResult } from '../../types';

interface CustomerSharesTableProps {
  shares: CustomerShareResult[];
  invoiceTotalCents: number;
}

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export default function CustomerSharesTable({ shares, invoiceTotalCents }: CustomerSharesTableProps) {
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
          {shares.map((sh) => {
            const amount = Math.round(invoiceTotalCents * sh.split_pct / 100);
            return (
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
                <td className="px-4 py-2 text-right font-medium tabular-nums">{fmt(amount)}</td>
              </tr>
            );
          })}
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
              <td className="px-4 py-2 text-right tabular-nums">{fmt(invoiceTotalCents)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
