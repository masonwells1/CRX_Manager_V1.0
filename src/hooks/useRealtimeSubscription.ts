import { useEffect, useRef } from 'react';
import { supabase } from '../lib/db';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';

type RealtimePayload = RealtimePostgresChangesPayload<Record<string, unknown>>;
type SubscriptionCallback = (payload: RealtimePayload) => void;

interface SubscriptionConfig {
  table: string;
  event?: 'INSERT' | 'UPDATE' | 'DELETE' | '*';
  filter?: string;
  disabled?: boolean;
  onInsert?: SubscriptionCallback;
  onUpdate?: SubscriptionCallback;
  onDelete?: SubscriptionCallback;
  onChange?: SubscriptionCallback;
}

export function useRealtimeSubscription(config: SubscriptionConfig) {
  // Store callbacks in refs to avoid stale closures
  const onChangeRef = useRef(config.onChange);
  const onInsertRef = useRef(config.onInsert);
  const onUpdateRef = useRef(config.onUpdate);
  const onDeleteRef = useRef(config.onDelete);

  onChangeRef.current = config.onChange;
  onInsertRef.current = config.onInsert;
  onUpdateRef.current = config.onUpdate;
  onDeleteRef.current = config.onDelete;

  useEffect(() => {
    if (config.disabled) return;

    let channel: RealtimeChannel;

    const setupSubscription = () => {
      const channelName = `${config.table}-changes-${Date.now()}`;
      channel = supabase.channel(channelName);

      const eventType = config.event || '*';

      channel
        .on(
          'postgres_changes' as 'system',
          {
            event: eventType,
            schema: 'public',
            table: config.table,
            filter: config.filter,
          } as Record<string, string | undefined>,
          (payload: RealtimePayload) => {
            onChangeRef.current?.(payload);

            if (payload.eventType === 'INSERT') {
              onInsertRef.current?.(payload);
            } else if (payload.eventType === 'UPDATE') {
              onUpdateRef.current?.(payload);
            } else if (payload.eventType === 'DELETE') {
              onDeleteRef.current?.(payload);
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
  }, [config.table, config.event, config.filter, config.disabled]);
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
    disabled: !noteId,
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
    disabled: !noteId,
    onChange: onActivityChange,
  });
}
