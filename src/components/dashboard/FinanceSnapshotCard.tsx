import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DollarSign, Clock, Wallet, Package, TrendingUp, AlertTriangle, ChevronRight } from 'lucide-react';
import Card, { CardHeader } from '../ui/Card';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { formatUSD } from '../../lib/money';

// F6 — admin-only "Finance Snapshot" on the home Dashboard. Reuses the existing
// financial_dashboard_summary RPC (the same one /financial-dashboard uses; values
// are DOLLARS). Each tile deep-links to its page. Read-only, zero DB. Rendered
// only for admins (the RPC is admin-gated), so no role widening.

type FinRpc = {
  open_ar_balance?: number | string;
  total_profit?: number | string;
  total_prepay_unallocated?: number | string;
  po_unreceived_value?: number | string;
  customers_over_credit_count?: number | string;
  ar_aging_buckets?: { days_61_90?: number | string; days_90_plus?: number | string } | null;
};

const TONE: Record<string, string> = {
  red: 'text-red-600',
  green: 'text-crx-green',
  teal: 'text-teal-600',
  navy: 'text-nav-dark',
};

export default function FinanceSnapshotCard() {
  const navigate = useNavigate();
  const [d, setD] = useState<FinRpc | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('financial_dashboard_summary');
        if (error) throw error;
        const res = assertRpcResult<FinRpc>(data, 'financial_dashboard_summary');
        if (!cancelled) setD(res);
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'fetch', action: 'dashboard_finance_snapshot' } });
        if (!cancelled) setD(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!d) return null;

  const ar = Number(d.open_ar_balance) || 0;
  const overdue60 = (Number(d.ar_aging_buckets?.days_61_90) || 0) + (Number(d.ar_aging_buckets?.days_90_plus) || 0);
  const prepay = Number(d.total_prepay_unallocated) || 0;
  const onOrder = Number(d.po_unreceived_value) || 0;
  const profit = Number(d.total_profit) || 0;
  const overCredit = Number(d.customers_over_credit_count) || 0;

  const tiles: { label: string; value: string; icon: React.ReactNode; to: string; tone: string }[] = [
    { label: 'Open AR', value: formatUSD(ar), icon: <DollarSign className="w-4 h-4" />, to: '/accounts-receivable', tone: ar > 0 ? 'red' : 'green' },
    { label: 'Overdue 60+', value: formatUSD(overdue60), icon: <Clock className="w-4 h-4" />, to: '/ar-aging', tone: overdue60 > 0 ? 'red' : 'green' },
    { label: 'Unused Prepay', value: formatUSD(prepay), icon: <Wallet className="w-4 h-4" />, to: '/accounts-receivable?tab=prepayments', tone: 'green' },
    { label: 'On Order', value: formatUSD(onOrder), icon: <Package className="w-4 h-4" />, to: '/receiving-hub', tone: 'teal' },
    { label: 'Period Profit', value: formatUSD(profit), icon: <TrendingUp className="w-4 h-4" />, to: '/financial-dashboard', tone: 'navy' },
  ];

  return (
    <Card>
      <CardHeader title="Finance" accent="Snapshot" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <button
            key={t.label}
            onClick={() => navigate(t.to)}
            className="min-h-[44px] rounded-xl border border-gray-100 bg-white p-3 text-left transition-all hover:border-crx-green/30 hover:shadow"
          >
            <div className="flex items-center gap-1.5 mb-1 text-gray-400">
              {t.icon}
              <span className="text-[11px] font-medium text-secondary uppercase tracking-wide">{t.label}</span>
            </div>
            <p className={`text-xl font-semibold font-heading ${TONE[t.tone]}`}>{t.value}</p>
          </button>
        ))}
      </div>
      {overCredit > 0 && (
        <button
          onClick={() => navigate('/ar-aging')}
          className="mt-3 w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-100 text-sm text-red-700 hover:bg-red-100 transition-colors"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1 text-left">
            {overCredit} customer{overCredit !== 1 ? 's are' : ' is'} over their credit limit
          </span>
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </Card>
  );
}
