import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { History, ChevronDown, ChevronUp, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import type { YesterdayRecapData } from '../../types';
import Badge from '../ui/Badge';

export default function YesterdayRecap() {
  const navigate = useNavigate();
  const [data, setData] = useState<YesterdayRecapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    async function fetchRecap() {
      const { data: recap, error } = await supabase.rpc('get_yesterday_delivery_recap');
      if (error) {
        Sentry.captureException(new Error(`Failed to load yesterday recap: ${error.message}`));
        setLoading(false);
        return;
      }
      const result = recap as unknown as YesterdayRecapData;
      setData(result);
      // Default expanded if there are issues
      if (result?.summary?.total_with_issues > 0) {
        setExpanded(true);
      }
      setLoading(false);
    }
    fetchRecap();
  }, []);

  // Loading state: single skeleton row
  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 shadow-card p-4">
        <div className="flex items-center gap-3 animate-pulse">
          <div className="w-5 h-5 bg-gray-200 rounded" />
          <div className="h-5 bg-gray-200 rounded w-48" />
        </div>
      </div>
    );
  }

  // Hide entirely if no deliveries yesterday
  if (
    !data ||
    !data.summary ||
    (data.summary.total_completed === 0 &&
      data.summary.total_with_issues === 0 &&
      data.summary.total_cancelled === 0)
  ) {
    return null;
  }

  const { summary, issues } = data;

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-card">
      {/* Header */}
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 rounded-xl transition-colors min-h-[44px]"
      >
        <div className="flex items-center gap-2">
          <History className="w-5 h-5 text-secondary" />
          <h3 className="font-semibold text-nav-dark text-sm sm:text-base">Yesterday&apos;s Recap</h3>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Summary row — hidden on mobile to save space, shown inline on sm+ */}
          <div className="hidden sm:flex items-center gap-3 text-sm">
            <span className="flex items-center gap-1 text-emerald-600">
              <CheckCircle className="w-4 h-4" />
              {summary.total_completed} completed
            </span>
            {summary.total_with_issues > 0 && (
              <span className="flex items-center gap-1 text-red-600">
                <AlertTriangle className="w-4 h-4" />
                {summary.total_with_issues} issues
              </span>
            )}
            {summary.total_cancelled > 0 && (
              <span className="flex items-center gap-1 text-gray-500">
                <XCircle className="w-4 h-4" />
                {summary.total_cancelled} cancelled
              </span>
            )}
          </div>
          {/* Mobile-only: compact badge counts */}
          <div className="flex sm:hidden items-center gap-1.5 text-xs">
            <span className="text-emerald-600 font-medium">{summary.total_completed}</span>
            {summary.total_with_issues > 0 && (
              <span className="text-red-600 font-medium">{summary.total_with_issues}!</span>
            )}
          </div>
          {expanded ? (
            <ChevronUp className="w-5 h-5 text-gray-400" />
          ) : (
            <ChevronDown className="w-5 h-5 text-gray-400" />
          )}
        </div>
      </button>

      {/* Collapsible content */}
      {expanded && issues.length > 0 && (
        <div className="px-4 pb-4 space-y-3">
          <div className="border-t border-gray-100 pt-3" />
          {issues.map((issue) => (
            <div
              key={issue.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/deliveries/${issue.id}`)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/deliveries/${issue.id}`); } }}
              className="border-l-4 border-red-400 bg-red-50/50 rounded-r-lg p-3 cursor-pointer hover:bg-red-50 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-nav-dark">
                      {issue.delivery_number}
                    </span>
                    <Badge variant="error">{issue.issue_type}</Badge>
                  </div>
                  <p className="text-sm text-secondary mt-1">
                    {issue.customer_name}
                    {issue.driver_name && (
                      <span className="text-gray-400"> &middot; {issue.driver_name}</span>
                    )}
                  </p>
                  {issue.issue_description && (
                    <p className="text-sm text-gray-500 mt-1">{issue.issue_description}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
