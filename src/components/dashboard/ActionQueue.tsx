import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Receipt,
  FileText,
  Truck,
  Package,
  Clock,
  User,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import { supabase, assertRpcResult } from '../../lib/db';
import type { ActionQueueItem } from '../../types';

interface CategoryConfig {
  key: string;
  label: string;
  icon: React.ReactNode;
  bg: string;
  border: string;
  iconColor: string;
  textColor: string;
  entityPath: string;
  formatSubtitle: (item: ActionQueueItem) => string;
}

const CATEGORIES: CategoryConfig[] = [
  {
    key: 'overdue_invoices',
    label: 'Overdue Invoices',
    icon: <Receipt className="w-4 h-4" />,
    bg: 'bg-red-50', border: 'border-red-200',
    iconColor: 'text-red-600', textColor: 'text-red-800',
    entityPath: '/invoices/',
    formatSubtitle: (item) => {
      const amt = item.amount_cents
        ? '$' + (item.amount_cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })
        : '';
      const days = item.days_overdue ? item.days_overdue + 'd overdue' : '';
      return [item.secondary_text, days, amt].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'cancelled_posted',
    label: 'Cancelled + Posted Invoices',
    icon: <FileText className="w-4 h-4" />,
    bg: 'bg-red-50', border: 'border-red-200',
    iconColor: 'text-red-600', textColor: 'text-red-800',
    entityPath: '/orders/',
    formatSubtitle: (item) => [item.secondary_text, item.invoice_number].filter(Boolean).join(' \u2014 '),
  },
  {
    key: 'overdue_deliveries',
    label: 'Overdue Deliveries',
    icon: <Truck className="w-4 h-4" />,
    bg: 'bg-orange-50', border: 'border-orange-200',
    iconColor: 'text-orange-600', textColor: 'text-orange-800',
    entityPath: '/deliveries/',
    formatSubtitle: (item) => {
      const days = item.days_overdue ? item.days_overdue + 'd overdue' : '';
      return [item.secondary_text, days].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'low_stock',
    label: 'Low Stock Items',
    icon: <Package className="w-4 h-4" />,
    bg: 'bg-amber-50', border: 'border-amber-200',
    iconColor: 'text-amber-600', textColor: 'text-amber-800',
    entityPath: '/products/',
    formatSubtitle: (item) => {
      const qty = item.current_qty !== undefined ? item.current_qty + ' avail' : '';
      const rp = item.reorder_point ? 'reorder at ' + item.reorder_point : '';
      return [item.secondary_text, qty, rp].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'expiring_quotes',
    label: 'Expiring Quotes',
    icon: <Clock className="w-4 h-4" />,
    bg: 'bg-yellow-50', border: 'border-yellow-200',
    iconColor: 'text-yellow-600', textColor: 'text-yellow-800',
    entityPath: '/quotes/',
    formatSubtitle: (item) => {
      const days = item.days_until_expiry !== undefined ? 'expires in ' + item.days_until_expiry + 'd' : '';
      return [item.secondary_text, days].filter(Boolean).join(' \u2014 ');
    },
  },
  {
    key: 'unassigned_deliveries',
    label: 'Unassigned Deliveries',
    icon: <User className="w-4 h-4" />,
    bg: 'bg-sky-50', border: 'border-sky-200',
    iconColor: 'text-sky-600', textColor: 'text-sky-800',
    entityPath: '/deliveries/',
    formatSubtitle: (item) => {
      const date = item.scheduled_date
        ? new Date(item.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      return [item.secondary_text, date].filter(Boolean).join(' \u2014 ');
    },
  },
];

const DEFAULT_VISIBLE = 5;

export default function ActionQueue() {
  const navigate = useNavigate();
  const [data, setData] = useState<Record<string, ActionQueueItem[]>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const stored = sessionStorage.getItem('crx-aq-dismissed');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: result, error } = await supabase.rpc('get_dashboard_action_items', { p_limit: 5 });
      if (error) throw error;
      const parsed = assertRpcResult<Record<string, ActionQueueItem[]>>(result, 'get_dashboard_action_items');
      setData(parsed);
    } catch {
      setData({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggleCategory = useCallback((key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const dismissItem = useCallback((itemId: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(itemId);
      try { sessionStorage.setItem('crx-aq-dismissed', JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div>
        <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3">Action Queue</h2>
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const visibleCategories = CATEGORIES
    .map((cat) => {
      const items = (data[cat.key] || []).filter((item) => !dismissed.has(item.id));
      return { ...cat, items };
    })
    .filter((cat) => cat.items.length > 0);

  const totalItems = visibleCategories.reduce((sum, cat) => sum + cat.items.length, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-secondary uppercase tracking-wide">
          Action Queue {totalItems > 0 && <span className="text-xs font-normal ml-1">({totalItems})</span>}
        </h2>
      </div>

      {visibleCategories.length === 0 ? (
        <div className="flex items-center gap-3 p-4 bg-crx-green-tint rounded-xl border border-crx-green/20">
          <CheckCircle2 className="w-5 h-5 text-crx-green" />
          <p className="text-sm text-crx-green font-medium">All Clear &mdash; No action items</p>
        </div>
      ) : (
        <div className="space-y-2">
          {visibleCategories.map((cat) => {
            const isExpanded = expanded[cat.key] !== false;
            const visibleItems = isExpanded ? cat.items.slice(0, DEFAULT_VISIBLE) : [];
            const hasMore = cat.items.length > DEFAULT_VISIBLE;

            return (
              <div key={cat.key} className={`${cat.bg} border ${cat.border} rounded-xl overflow-hidden`}>
                <button
                  onClick={() => toggleCategory(cat.key)}
                  className="w-full flex items-center gap-3 p-3 text-left"
                >
                  <span className={cat.iconColor}>{cat.icon}</span>
                  <span className={`text-sm font-semibold ${cat.textColor} flex-1`}>
                    {cat.label} ({cat.items.length})
                  </span>
                  {isExpanded
                    ? <ChevronDown className={`w-4 h-4 ${cat.iconColor}`} />
                    : <ChevronRight className={`w-4 h-4 ${cat.iconColor}`} />
                  }
                </button>

                {isExpanded && (
                  <div className="border-t border-white/50">
                    {visibleItems.map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-white/50 transition-colors group"
                      >
                        <button
                          onClick={() => navigate(cat.entityPath + item.id)}
                          className="flex-1 min-w-0 text-left"
                        >
                          <span className={`text-sm font-medium ${cat.textColor} truncate block`}>
                            {item.primary_text}
                          </span>
                          <span className={`text-xs ${cat.iconColor} truncate block opacity-80`}>
                            {cat.formatSubtitle(item)}
                          </span>
                        </button>
                        <button
                          onClick={() => navigate(cat.entityPath + item.id)}
                          className={`flex-shrink-0 p-1 rounded ${cat.iconColor} opacity-0 group-hover:opacity-100 transition-opacity`}
                          aria-label={'Open ' + item.primary_text}
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); dismissItem(item.id); }}
                          className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-white/80 opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label="Dismiss for today"
                        >
                          Dismiss
                        </button>
                      </div>
                    ))}
                    {hasMore && (
                      <div className={`text-center text-xs font-medium ${cat.iconColor} py-2`}>
                        +{cat.items.length - DEFAULT_VISIBLE} more items
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
