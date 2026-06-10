/**
 * DailyBrief — the owner's morning summary (deep-dive H1 E3).
 *
 * One readable paragraph-style card for admins: cash/AR position, prepay and
 * commissions, period status, and today's workload — composed from
 * financial_dashboard_summary (admin-gated in-body, returns DOLLARS not cents)
 * plus operational numbers the Dashboard already fetched (passed as props so
 * nothing is fetched twice).
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sunrise } from 'lucide-react';
import Card from '../ui/Card';
import { supabase, assertRpcResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { formatUSD } from '../../lib/money';

interface DailyBriefProps {
  deliveriesToday: number;
  deliveryUnassigned: number;
  activeOrders: number;
  actionItemsCount: number;
}

interface BriefFinancials {
  open_ar_balance: number;
  ar_aging_buckets: { current: number; days_31_60: number; days_61_90: number; days_90_plus: number };
  total_prepay_unallocated: number;
  total_commission_owed: number;
  customers_over_credit_count: number;
  current_period: { name: string; status: string; days_remaining: number } | null;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default function DailyBrief({ deliveriesToday, deliveryUnassigned, activeOrders, actionItemsCount }: DailyBriefProps) {
  const navigate = useNavigate();
  const [fin, setFin] = useState<BriefFinancials | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('financial_dashboard_summary');
      if (error) {
        // Non-critical card — log, render nothing extra
        Sentry.captureException(error, { tags: { source: 'dashboard', card: 'daily_brief' } });
        return;
      }
      try {
        const d = assertRpcResult<BriefFinancials>(data, 'financial_dashboard_summary');
        if (!cancelled) setFin(d);
      } catch (err) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'dashboard', card: 'daily_brief' } });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!fin) return null;

  const over60 = (fin.ar_aging_buckets?.days_61_90 || 0) + (fin.ar_aging_buckets?.days_90_plus || 0);
  const period = fin.current_period;

  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-crx-green-tint flex items-center justify-center flex-shrink-0">
          <Sunrise className="w-5 h-5 text-crx-green" />
        </div>
        <div className="text-sm text-nav-dark space-y-1.5">
          <p className="font-semibold font-heading text-base">{greeting()}, here's where things stand.</p>
          <p>
            Open AR is <button onClick={() => navigate('/ar-aging')} className="font-semibold text-crx-green hover:underline">{formatUSD(fin.open_ar_balance || 0)}</button>
            {over60 > 0 && <> — <span className="font-semibold text-red-600">{formatUSD(over60)}</span> of it is past 60 days</>}
            {fin.customers_over_credit_count > 0 && <>, and <span className="font-semibold text-amber-600">{fin.customers_over_credit_count} customer{fin.customers_over_credit_count === 1 ? ' is' : 's are'} over credit limit</span></>}
            . Unallocated prepay on hand: <span className="font-semibold">{formatUSD(fin.total_prepay_unallocated || 0)}</span>; commissions owed: <span className="font-semibold">{formatUSD(fin.total_commission_owed || 0)}</span>.
          </p>
          <p>
            Today: <button onClick={() => navigate('/deliveries')} className="font-semibold text-crx-green hover:underline">{deliveriesToday} deliver{deliveriesToday === 1 ? 'y' : 'ies'}</button>
            {deliveryUnassigned > 0 && <> (<span className="font-semibold text-amber-600">{deliveryUnassigned} unassigned</span>)</>}
            , {activeOrders} active order{activeOrders === 1 ? '' : 's'}
            {actionItemsCount > 0 && <>, and <button onClick={() => navigate('/team-board')} className="font-semibold text-crx-green hover:underline">{actionItemsCount} open action item{actionItemsCount === 1 ? '' : 's'}</button></>}
            .
            {period && <> Accounting period <span className="font-semibold">{period.name}</span> is {period.status}{period.status === 'open' && period.days_remaining >= 0 ? ` — ${period.days_remaining} day${period.days_remaining === 1 ? '' : 's'} to close` : ''}.</>}
          </p>
        </div>
      </div>
    </Card>
  );
}
