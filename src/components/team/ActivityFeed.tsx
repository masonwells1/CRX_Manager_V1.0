import { useState, useEffect, useCallback } from 'react';
import { Activity, CheckCircle2, XCircle, Edit, MessageCircle, UserPlus, Plus, Trash } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useRealtimeActivity } from '../../hooks/useRealtimeSubscription';

interface ActivityEntry {
  id: string;
  note_id: string;
  user_id: string;
  action_type: string;
  changes: Record<string, unknown> | null;
  created_at: string;
  user?: {
    full_name: string;
  };
}

interface ActivityFeedProps {
  noteId: string | null;
  limit?: number;
}

export default function ActivityFeed({ noteId, limit = 20 }: ActivityFeedProps) {
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchActivities = useCallback(async () => {
    let query = supabase
      .from('note_activity_log')
      .select('*, user:profiles!note_activity_log_user_id_fkey(full_name)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (noteId) {
      query = query.eq('note_id', noteId);
    }

    const { data, error } = await query;
    if (error) {
      Sentry.captureException(new Error(`Failed to load activity feed: ${error.message}`));
      setLoading(false);
      return;
    }
    setActivities((data || []) as ActivityEntry[]);
    setLoading(false);
  }, [noteId, limit]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  useRealtimeActivity(noteId, fetchActivities);

  const getActionIcon = (actionType: string) => {
    switch (actionType) {
      case 'created':
        return <Plus className="w-4 h-4 text-blue-500" />;
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case 'reopened':
        return <XCircle className="w-4 h-4 text-amber-500" />;
      case 'updated':
        return <Edit className="w-4 h-4 text-gray-500" />;
      case 'commented':
        return <MessageCircle className="w-4 h-4 text-purple-500" />;
      case 'assigned':
        return <UserPlus className="w-4 h-4 text-cyan-500" />;
      case 'deleted':
        return <Trash className="w-4 h-4 text-red-500" />;
      default:
        return <Activity className="w-4 h-4 text-gray-400" />;
    }
  };

  const getActionText = (activity: ActivityEntry) => {
    const userName = activity.user?.full_name || 'Someone';

    switch (activity.action_type) {
      case 'created':
        return (
          <>
            <span className="font-medium">{userName}</span> created this note
          </>
        );
      case 'completed':
        return (
          <>
            <span className="font-medium">{userName}</span> marked as complete
          </>
        );
      case 'reopened':
        return (
          <>
            <span className="font-medium">{userName}</span> reopened this note
          </>
        );
      case 'updated':
        return (
          <>
            <span className="font-medium">{userName}</span> updated this note
          </>
        );
      case 'commented':
        return (
          <>
            <span className="font-medium">{userName}</span> added a comment
          </>
        );
      case 'comment_edited':
        return (
          <>
            <span className="font-medium">{userName}</span> edited a comment
          </>
        );
      case 'comment_deleted':
        return (
          <>
            <span className="font-medium">{userName}</span> deleted a comment
          </>
        );
      case 'assigned': {
        const oldAssignee = activity.changes?.old_assignee;
        const newAssignee = activity.changes?.new_assignee;
        if (!oldAssignee && newAssignee) {
          return (
            <>
              <span className="font-medium">{userName}</span> assigned this note
            </>
          );
        } else if (oldAssignee && !newAssignee) {
          return (
            <>
              <span className="font-medium">{userName}</span> unassigned this note
            </>
          );
        } else {
          return (
            <>
              <span className="font-medium">{userName}</span> changed assignment
            </>
          );
        }
      }
      case 'deleted':
        return (
          <>
            <span className="font-medium">{userName}</span> deleted this note
          </>
        );
      default:
        return (
          <>
            <span className="font-medium">{userName}</span> performed an action
          </>
        );
    }
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3 animate-pulse">
            <div className="w-8 h-8 bg-gray-200 rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="h-4 bg-gray-200 rounded w-3/4" />
              <div className="h-3 bg-gray-200 rounded w-1/4" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="w-5 h-5 text-secondary" />
        <h3 className="font-semibold text-nav-dark">Activity</h3>
      </div>

      {activities.length === 0 ? (
        <div className="text-center py-8">
          <Activity className="w-12 h-12 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-secondary">No activity yet</p>
        </div>
      ) : (
        <div className="space-y-4">
          {activities.map((activity) => (
            <div key={activity.id} className="flex gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
                {getActionIcon(activity.action_type)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-nav-dark">
                  {getActionText(activity)}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {formatTime(activity.created_at)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
