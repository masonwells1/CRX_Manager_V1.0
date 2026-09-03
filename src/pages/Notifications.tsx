import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { sanitizeError, supabase, checkMutationResult } from '../lib/db';
import { Sentry } from '../lib/sentry';
import type { Notification as NotificationType } from '../types';

export default function Notifications() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<NotificationType[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchNotifications = useCallback(async () => {
    // Guard: Ensure profile is loaded
    if (!profile) {
      setLoading(false);
      return;
    }

    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(200);
    setNotifications((data || []) as NotificationType[]);
    setLoading(false);
  }, [profile]);

  useEffect(() => {
    if (profile) fetchNotifications();
  }, [profile, fetchNotifications]);

  const markAsRead = async (notification: NotificationType) => {
    if (!notification.is_read) {
      try {
        const readResult = await supabase
          .from('notifications')
          .update({ is_read: true })
          .eq('id', notification.id)
          .select();
        checkMutationResult(readResult, 'Mark notification as read');
        setNotifications((prev) =>
          prev.map((n) => (n.id === notification.id ? { ...n, is_read: true } : n))
        );
      } catch (err: unknown) {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'mark_notification_read' } });
        toast('error', sanitizeError(err));
      }
    }
    if (notification.related_entity_type && notification.related_entity_id) {
      // Team notes live on the board behind a query param, not a /:id route
      // (mirrors NotificationsPanel — covers 'mention' and 'task_assigned').
      if (notification.related_entity_type === 'team_note') {
        navigate(`/team-board?note=${notification.related_entity_id}`);
        return;
      }
      const routes: Record<string, string> = {
        quote: '/quotes',
        order: '/orders',
        delivery: '/deliveries',
        purchase_order: '/purchase-orders',
        invoice: '/invoices',
        payment: '/payments',
        return: '/returns',
        job: '/jobs',
        product: '/products',
        customer: '/customers',
        commission: '/commission-payments',
        blend_ticket: '/blend-tickets',
      };
      const base = routes[notification.related_entity_type];
      if (base) navigate(`${base}/${notification.related_entity_id}`);
    }
  };

  const markAllRead = async () => {
    // Guard: Ensure profile is loaded
    if (!profile) return;
    // No unread notifications — nothing to do. Skip the call so the
    // zero-rows-affected outcome below doesn't surface a false error toast.
    if (!notifications.some((n) => !n.is_read)) return;

    try {
      const markAllResult = await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('user_id', profile.id)
        .eq('is_read', false)
        .select();
      // Zero rows is a valid outcome here (a concurrent read may have already
      // cleared them), so only a real error counts as failure — do NOT use
      // checkMutationResult, which treats an empty result array as denial.
      if (markAllResult.error) throw markAllResult.error;
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'mark_all_notifications_read' } });
      toast('error', sanitizeError(err));
    }
  };

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <SplitHeading title="Your" accent="Notifications" />
        {unreadCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            icon={<CheckCheck className="w-4 h-4" />}
            showChevron={false}
            onClick={markAllRead}
          >
            Mark All Read
          </Button>
        )}
      </div>

      {notifications.length === 0 ? (
        <Card>
          <EmptyState
            icon={<BellOff className="w-6 h-6 text-gray-400" />}
            title="No notifications"
            description="You're all caught up!"
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {notifications.map((n) => (
            <Card
              key={n.id}
              hover
              className={`cursor-pointer ${!n.is_read ? 'border-crx-green/30 bg-crx-green-tint/30' : ''}`}
              onClick={() => markAsRead(n)}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                    n.is_read ? 'bg-gray-100' : 'bg-crx-green-light'
                  }`}
                >
                  <Bell className={`w-5 h-5 ${n.is_read ? 'text-gray-400' : 'text-crx-green'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className={`text-sm ${n.is_read ? 'text-secondary' : 'font-medium text-nav-dark'}`}>
                      {n.title}
                    </h4>
                    {!n.is_read && (
                      <span className="w-2 h-2 rounded-full bg-crx-green shrink-0" />
                    )}
                  </div>
                  <p className="text-xs text-secondary mt-0.5 line-clamp-2">{n.message}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {new Date(n.created_at).toLocaleString()}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
