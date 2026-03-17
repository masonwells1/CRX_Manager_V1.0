import { supabase } from './db';
import { Sentry } from './sentry';

/**
 * Log an event to the activity_feed table.
 * Call this whenever something important happens in the app.
 * 
 * @param eventType - Short label like 'quote_created', 'order_created', 'delivery_completed'
 * @param description - Human-readable description like "Quote Q-2026-0015 sent to Smith Farms"
 * @param performedBy - The user ID who did the action
 * @param relatedEntityType - Optional: 'quote', 'order', 'delivery', 'customer', 'product', 'purchase_order'
 * @param relatedEntityId - Optional: the UUID of the related record
 * @param customerId - Optional: link to a customer for customer-specific activity views
 */
export async function logActivity(
  eventType: string,
  description: string,
  performedBy: string,
  relatedEntityType?: string,
  relatedEntityId?: string,
  customerId?: string
) {
  try {
    const { error: logErr } = await supabase.from('activity_feed').insert({
      event_type: eventType,
      description,
      performed_by: performedBy,
      related_entity_type: relatedEntityType || null,
      related_entity_id: relatedEntityId || null,
      customer_id: customerId || null,
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
