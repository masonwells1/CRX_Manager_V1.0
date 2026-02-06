import { useEffect } from 'react';
import { supabase } from '../lib/db';
import type { RealtimeChannel } from '@supabase/supabase-js';

type SubscriptionCallback = (payload: any) => void;

interface SubscriptionConfig {
  table: string;
  event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  filter?: string;
  onInsert?: SubscriptionCallback;
  onUpdate?: SubscriptionCallback;
  onDelete?: SubscriptionCallback;
  onChange?: SubscriptionCallback;
}

export function useRealtimeSubscription(config: SubscriptionConfig) {
  useEffect(() => {
    let channel: RealtimeChannel;

    const setupSubscription = () => {
      const channelName = `${config.table}-changes-${Date.now()}`;
      channel = supabase.channel(channelName);

      const eventType = config.event || '*';
      const filterString = config.filter ? `${config.table}:${config.filter}` : config.table;

      channel
        .on(
          'postgres_changes' as any,
          {
            event: eventType,
            schema: 'public',
            table: config.table,
            filter: config.filter,
          },
          (payload: any) => {
            if (config.onChange) {
              config.onChange(payload);
            }

            if (payload.eventType === 'INSERT' && config.onInsert) {
              config.onInsert(payload);
            } else if (payload.eventType === 'UPDATE' && config.onUpdate) {
              config.onUpdate(payload);
            } else if (payload.eventType === 'DELETE' && config.onDelete) {
              config.onDelete(payload);
            }
          }
        )
        .subscribe();
    };

    setupSubscription();

    return () => {
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [config.table, config.event, config.filter]);
}

export function useRealtimeNotes(onNotesChange: () => void) {
  useRealtimeSubscription({
    table: 'team_notes',
    onChange: onNotesChange,
  });
}

export function useRealtimeComments(noteId: string | null, onCommentsChange: () => void) {
  useRealtimeSubscription({
    table: 'team_note_comments',
    filter: noteId ? `note_id=eq.${noteId}` : undefined,
    onChange: onCommentsChange,
  });
}

export function useRealtimeNotifications(userId: string, onNotificationChange: () => void) {
  useRealtimeSubscription({
    table: 'notifications',
    filter: `user_id=eq.${userId}`,
    onChange: onNotificationChange,
  });
}

export function useRealtimeActivity(noteId: string | null, onActivityChange: () => void) {
  useRealtimeSubscription({
    table: 'note_activity_log',
    filter: noteId ? `note_id=eq.${noteId}` : undefined,
    onChange: onActivityChange,
  });
}
