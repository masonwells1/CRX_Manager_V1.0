import { useState, useEffect } from 'react';
import { DollarSign, ClipboardList, Truck, Star, Clock } from 'lucide-react';
import { supabase, assertRpcResult } from '../../lib/db';
import type { CustomerSummary } from '../../types';

interface CustomerSummaryBarProps {
  customerId: string;
  /** Optional: makes a card clickable, jumping to the matching CustomerDetail tab. */
  onCardClick?: (tab: string) => void;
}

function formatCents(cents: number): string {
  return '$' + (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

const TIER_LABELS: Record<number, string> = {
  1: 'Tier 1',
  2: 'Tier 2',
  3: 'Tier 3',
};

export default function CustomerSummaryBar({ customerId, onCardClick }: CustomerSummaryBarProps) {
  const [summary, setSummary] = useState<CustomerSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      setLoading(true);
      try {
        const { data, error } = await supabase.rpc('get_customer_summary', {
          p_customer_id: customerId,
        });
        if (error) throw error;
        const result = assertRpcResult<CustomerSummary>(data, 'get_customer_summary');
        if (!cancelled) setSummary(result);
      } catch {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetch();
    return () => { cancelled = true; };
  }, [customerId]);

  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="bg-white rounded-lg border border-gray-100 p-3 animate-pulse">
            <div className="h-4 bg-gray-100 rounded w-16 mb-2" />
            <div className="h-6 bg-gray-100 rounded w-20" />
          </div>
        ))}
      </div>
    );
  }

  if (!summary) return null;

  const cards: { label: string; value: string; icon: React.ReactNode; color: string; tab?: string }[] = [
    {
      label: 'AR Balance',
      value: formatCents(summary.ar_balance_cents),
      icon: <DollarSign className="w-4 h-4" />,
      color: summary.ar_balance_cents > 0 ? 'text-red-600' : 'text-crx-green',
      tab: 'financials',
    },
    {
      label: 'Orders (Season)',
      value: String(summary.order_count),
      icon: <ClipboardList className="w-4 h-4" />,
      color: 'text-nav-dark',
      tab: 'orders',
    },
    {
      label: 'Deliveries (Season)',
      value: String(summary.delivery_count),
      icon: <Truck className="w-4 h-4" />,
      color: 'text-nav-dark',
      tab: 'deliveries',
    },
    {
      label: 'Credit Tier',
      value: TIER_LABELS[summary.credit_tier] || `Tier ${summary.credit_tier}`,
      icon: <Star className="w-4 h-4" />,
      color: summary.credit_tier === 1 ? 'text-crx-green' : summary.credit_tier === 3 ? 'text-amber-600' : 'text-nav-dark',
      tab: 'info',
    },
    {
      label: 'Last Activity',
      value: summary.last_activity ? timeAgo(summary.last_activity) : 'None',
      icon: <Clock className="w-4 h-4" />,
      color: 'text-secondary',
      tab: 'timeline',
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4">
      {cards.map((card) => {
        const clickable = !!onCardClick && !!card.tab;
        const body = (
          <>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-gray-400">{card.icon}</span>
              <span className="text-[11px] font-medium text-secondary uppercase tracking-wide">{card.label}</span>
            </div>
            <p className={`text-lg font-semibold font-heading ${card.color}`}>{card.value}</p>
          </>
        );
        return clickable ? (
          <button
            key={card.label}
            type="button"
            onClick={() => onCardClick!(card.tab!)}
            title={`View ${card.label}`}
            className="text-left bg-white rounded-lg border border-gray-100 shadow-sm p-3 transition-colors hover:border-crx-green/40 hover:shadow focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          >
            {body}
          </button>
        ) : (
          <div key={card.label} className="bg-white rounded-lg border border-gray-100 shadow-sm p-3">
            {body}
          </div>
        );
      })}
    </div>
  );
}
