import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Truck, ChevronDown, ChevronUp, Clock, Package, AlertTriangle, User } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import Card from '../ui/Card';
import Badge from '../ui/Badge';
import type { TeamBoardDeliveryData, TeamBoardDelivery } from '../../types';

const priorityBorderColors: Record<string, string> = {
  urgent: 'border-l-red-500',
  high: 'border-l-amber-500',
  medium: 'border-l-blue-500',
  low: 'border-l-gray-300',
};

const statusBadgeVariant: Record<string, 'info' | 'warning'> = {
  scheduled: 'info',
  in_progress: 'warning',
};

function DeliveryCard({ delivery, compact = false }: { delivery: TeamBoardDelivery; compact?: boolean }) {
  const navigate = useNavigate();
  const borderClass = priorityBorderColors[delivery.priority] || 'border-l-gray-300';

  return (
    <button
      onClick={() => navigate(`/deliveries/${delivery.id}`)}
      className={`w-full text-left bg-white rounded-lg border border-gray-100 shadow-sm hover:shadow-md transition-shadow cursor-pointer border-l-4 ${borderClass} ${compact ? 'p-3' : 'p-4'}`}
      style={{ minHeight: '44px' }}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className={`font-semibold text-nav-dark ${compact ? 'text-xs' : 'text-sm'}`}>
          {delivery.delivery_number}
        </span>
        <Badge variant={statusBadgeVariant[delivery.status] || 'default'} size="sm">
          {delivery.status.replace('_', ' ')}
        </Badge>
      </div>

      <p className={`text-nav-dark font-medium truncate ${compact ? 'text-xs' : 'text-sm'}`}>
        {delivery.customer_name}
      </p>

      <div className={`flex items-center gap-3 mt-2 ${compact ? 'text-xs' : 'text-xs'} text-secondary`}>
        <span className="flex items-center gap-1">
          <User className="w-3.5 h-3.5" />
          {delivery.driver_name ? (
            delivery.driver_name
          ) : (
            <span className="text-red-600 font-medium">Unassigned</span>
          )}
        </span>

        {delivery.scheduled_time && (
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            {delivery.scheduled_time}
          </span>
        )}

        <span className="flex items-center gap-1">
          <Package className="w-3.5 h-3.5" />
          {delivery.item_count} {delivery.item_count === 1 ? 'item' : 'items'}
        </span>
      </div>
    </button>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-4 border-l-4 border-l-gray-200 animate-pulse">
      <div className="flex items-start justify-between mb-2">
        <div className="h-4 w-24 bg-gray-200 rounded" />
        <div className="h-5 w-16 bg-gray-200 rounded-full" />
      </div>
      <div className="h-4 w-40 bg-gray-200 rounded mb-3" />
      <div className="flex gap-3">
        <div className="h-3 w-20 bg-gray-200 rounded" />
        <div className="h-3 w-14 bg-gray-200 rounded" />
        <div className="h-3 w-16 bg-gray-200 rounded" />
      </div>
    </div>
  );
}

export default function TodaysDeliveries() {
  const [data, setData] = useState<TeamBoardDeliveryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tomorrowOpen, setTomorrowOpen] = useState(false);

  useEffect(() => {
    fetchDeliveries();
  }, []);

  const fetchDeliveries = async () => {
    setLoading(true);
    const { data: result, error } = await supabase.rpc('get_team_board_deliveries');
    if (error) {
      Sentry.captureException(new Error(`Failed to load deliveries: ${error.message}`));
      setLoading(false);
      return;
    }
    setData(result as unknown as TeamBoardDeliveryData);
    setLoading(false);
  };

  return (
    <Card padding={true}>
      {/* Section header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Truck className="w-5 h-5 text-crx-green" />
          <h3 className="text-lg font-semibold font-heading text-nav-dark">
            Today&apos;s Deliveries
          </h3>
          {data && (
            <span className="px-2 py-0.5 text-xs font-semibold bg-crx-green/10 text-crx-green rounded-full">
              {data.today_total}
            </span>
          )}
        </div>
      </div>

      {/* Unassigned alert bar */}
      {data && data.unassigned_count > 0 && (
        <Link
          to="/deliveries"
          className="flex items-center gap-2 px-3 py-2 mb-4 text-sm font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors"
        >
          <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
          {data.unassigned_count} {data.unassigned_count === 1 ? 'delivery' : 'deliveries'} today {data.unassigned_count === 1 ? 'has' : 'have'} no driver assigned
        </Link>
      )}

      {/* Loading state */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {/* Empty state */}
      {!loading && data && data.today.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 text-secondary">
          <Truck className="w-10 h-10 mb-3 text-gray-300" />
          <p className="text-sm font-medium">No deliveries scheduled today</p>
        </div>
      )}

      {/* Today's deliveries grid */}
      {!loading && data && data.today.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.today.map((delivery) => (
            <DeliveryCard key={delivery.id} delivery={delivery} />
          ))}
        </div>
      )}

      {/* Tomorrow preview */}
      {!loading && data && data.tomorrow.length > 0 && (
        <div className="mt-5 border-t border-gray-100 pt-4">
          <button
            onClick={() => setTomorrowOpen(!tomorrowOpen)}
            className="flex items-center gap-2 w-full text-left text-sm font-medium text-secondary hover:text-nav-dark transition-colors"
          >
            {tomorrowOpen ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
            Tomorrow &mdash; {data.tomorrow.length} {data.tomorrow.length === 1 ? 'delivery' : 'deliveries'}
          </button>

          {tomorrowOpen && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-3">
              {data.tomorrow.map((delivery) => (
                <DeliveryCard key={delivery.id} delivery={delivery} compact />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
