import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import SplitHeading from '../components/ui/SplitHeading';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import type { Notification as NotificationType } from '../types';

export default function Notifications() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<NotificationType[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (profile) fetchNotifications();
  }, [profile]);

  const fetchNotifications = async () => {
    // Guard: Ensure profile is loaded
    if (!profile) {
      setLoading(false);
      return;
    }

    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false });
    setNotifications((data || []) as NotificationType[]);
    setLoading(false);
  };

  const markAsRead = async (notification: NotificationType) => {
    if (!notification.is_read) {
      await supabase
        .from('notifications')
        .update({ is_read: true })
        .eq('id', notification.id);
      setNotifications((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, is_read: true } : n))
      );
    }
    if (notification.related_entity_type && notification.related_entity_id) {
      const routes: Record<string, string> = {
        quote: '/quotes',
        order: '/orders',
        delivery: '/deliveries',
        purchase_order: '/purchase-orders',
      };
      const base = routes[notification.related_entity_type];
      if (base) navigate(`${base}/${notification.related_entity_id}`);
    }
  };

  const markAllRead = async () => {
    // Guard: Ensure profile is loaded
    if (!profile) return;

    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', profile.id)
      .eq('is_read', false);
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
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
