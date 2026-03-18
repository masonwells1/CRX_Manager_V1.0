import { supabase } from './db';
import { Sentry } from './sentry';

export interface LogActivityParams {
  event: string;
  description: string;
  performedBy: string;
  entityType?: string;
  entityId?: string;
  customerId?: string;
}

/**
 * Log an event to the activity_feed table.
 * Call this whenever something important happens in the app.
 */
export async function logActivity(params: LogActivityParams) {
  try {
    const { error: logErr } = await supabase.from('activity_feed').insert({
      event_type: params.event,
      description: params.description,
      performed_by: params.performedBy,
      related_entity_type: params.entityType || null,
      related_entity_id: params.entityId || null,
      customer_id: params.customerId || null,
    });
    if (logErr) Sentry.captureException(logErr, { tags: { source: 'activity_logger', action: 'log_activity' } });
  } catch (err) {
    // Activity logging should never break the main flow
    Sentry.captureException(err, { tags: { source: 'activity_logger', action: 'log_activity' } });
  }
}

/**
 * Create a notification for a specific user.
 * 
 * @param userId - Who should see this notification
 * @param title - Short title like "Low Stock Alert"
 * @param message - Longer description
 * @param notificationType - Category: 'low_stock', 'delivery_assigned', 'quote_expiring', 'order_status', 'general'
 * @param relatedEntityType - Optional: 'quote', 'order', 'delivery', etc.
 * @param relatedEntityId - Optional: UUID of related record
 */
export async function createNotification(
  userId: string,
  title: string,
  message: string,
  notificationType: string,
  relatedEntityType?: string,
  relatedEntityId?: string
) {
  try {
    const { error: logErr } = await supabase.from('notifications').insert({
      user_id: userId,
      title,
      message,
      notification_type: notificationType,
      related_entity_type: relatedEntityType || null,
      related_entity_id: relatedEntityId || null,
    });
    if (logErr) Sentry.captureException(logErr, { tags: { source: 'activity_logger', action: 'create_notification' } });
  } catch (err) {
    Sentry.captureException(err, { tags: { source: 'activity_logger', action: 'create_notification' } });
  }
}

/**
 * Notify all admins about something.
 */
export async function notifyAdmins(
  title: string,
  message: string,
  notificationType: string,
  relatedEntityType?: string,
  relatedEntityId?: string
) {
  try {
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .eq('is_active', true);

    if (admins && admins.length > 0) {
      const notifications = admins.map((admin) => ({
        user_id: admin.id,
        title,
        message,
        notification_type: notificationType,
        related_entity_type: relatedEntityType || null,
        related_entity_id: relatedEntityId || null,
      }));
      const { error: logErr } = await supabase.from('notifications').insert(notifications);
      if (logErr) Sentry.captureException(logErr, { tags: { source: 'activity_logger', action: 'notify_admins' } });
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { source: 'activity_logger', action: 'notify_admins' } });
  }
}
