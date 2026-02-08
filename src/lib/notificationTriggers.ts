/**
 * notificationTriggers.ts — Automated notification triggers
 * GAP FIX #17: Automated Notifications
 *
 * This module provides functions that check for conditions and fire
 * notifications automatically. Call these from relevant pages or
 * from a periodic check on the Dashboard.
 *
 * Notifications are created in the `notifications` table and shown
 * on the Notifications page.
 */
import { supabase } from './db';
import { createNotification, notifyAdmins } from './activityLogger';

/**
 * Check inventory for low-stock items and notify admins.
 * Should be called from Dashboard load or InventoryPage.
 * Uses a simple dedup: only notifies once per product per day.
 */
export async function checkLowStockNotifications() {
  try {
    const { data: lowStockItems } = await supabase
      .from('inventory')
      .select('id, product_id, quantity_available, reorder_point, product:products(product_name)')
      .gt('reorder_point', 0);

    if (!lowStockItems) return;

    const alerts = lowStockItems.filter(
      (i: any) => Number(i.quantity_available) <= Number(i.reorder_point)
    );

    if (alerts.length === 0) return;

    // Check which products already had a notification today (dedup)
    const today = new Date().toISOString().split('T')[0];
    const { data: existingToday } = await supabase
      .from('notifications')
      .select('related_entity_id')
      .eq('notification_type', 'low_stock')
      .gte('created_at', `${today}T00:00:00Z`);

    const alreadyNotified = new Set((existingToday || []).map((n: any) => n.related_entity_id));

    for (const item of alerts) {
      if (alreadyNotified.has(item.product_id)) continue;

      const productName = (item as any).product?.product_name || 'Unknown product';
      await notifyAdmins(
        'Low Stock Alert',
        `${productName} is low — ${item.quantity_available} units available (reorder point: ${item.reorder_point})`,
        'low_stock',
        'product',
        item.product_id
      );
    }
  } catch (err) {
    console.error('Low stock notification check failed:', err);
  }
}

/**
 * Check for quotes expiring within the next 3 days and notify the quote creator.
 * Should be called from Dashboard load.
 */
export async function checkExpiringQuoteNotifications() {
  try {
    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const { data: expiringQuotes } = await supabase
      .from('quotes')
      .select('id, quote_number, created_by, expires_at, customer:customers(farm_name)')
      .in('status', ['sent', 'draft'])
      .lte('expires_at', threeDaysFromNow.toISOString().split('T')[0])
      .gte('expires_at', now.toISOString().split('T')[0]);

    if (!expiringQuotes || expiringQuotes.length === 0) return;

    // Dedup: check existing notifications for today
    const today = now.toISOString().split('T')[0];
    const { data: existingToday } = await supabase
      .from('notifications')
      .select('related_entity_id')
      .eq('notification_type', 'quote_expiring')
      .gte('created_at', `${today}T00:00:00Z`);

    const alreadyNotified = new Set((existingToday || []).map((n: any) => n.related_entity_id));

    for (const quote of expiringQuotes) {
      if (alreadyNotified.has(quote.id)) continue;

      const customerName = (quote as any).customer?.[0]?.farm_name ||
        (quote as any).customer?.farm_name || 'customer';
      const daysLeft = Math.ceil(
        (new Date(quote.expires_at!).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );

      await createNotification(
        quote.created_by,
        'Quote Expiring Soon',
        `Quote ${quote.quote_number} for ${customerName} expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
        'quote_expiring',
        'quote',
        quote.id
      );
    }
  } catch (err) {
    console.error('Expiring quote notification check failed:', err);
  }
}

/**
 * Notify a driver when they're assigned to a delivery.
 * Call this from NewDelivery page after creating a delivery.
 */
export async function notifyDriverAssigned(
  driverId: string,
  deliveryNumber: string,
  customerName: string,
  scheduledDate: string,
  deliveryId: string
) {
  try {
    await createNotification(
      driverId,
      'New Delivery Assigned',
      `You've been assigned delivery ${deliveryNumber} for ${customerName} on ${new Date(scheduledDate).toLocaleDateString()}`,
      'delivery_assigned',
      'delivery',
      deliveryId
    );
  } catch (err) {
    console.error('Driver notification failed:', err);
  }
}

/**
 * Notify relevant people when an order status changes.
 * Call this from OrderDetail when status is updated.
 */
export async function notifyOrderStatusChange(
  orderId: string,
  orderNumber: string,
  customerName: string,
  newStatus: string,
  createdBy?: string
) {
  try {
    const title = `Order ${newStatus.replace('_', ' ')}`;
    const message = `Order ${orderNumber} for ${customerName} is now ${newStatus.replace('_', ' ')}`;

    // Notify admins
    await notifyAdmins(title, message, 'order_status', 'order', orderId);

    // Also notify the creator if different from admins
    if (createdBy) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', createdBy)
        .maybeSingle();

      if (profile && profile.role !== 'admin') {
        await createNotification(createdBy, title, message, 'order_status', 'order', orderId);
      }
    }
  } catch (err) {
    console.error('Order status notification failed:', err);
  }
}

/**
 * Notify admins when a large order is created (above threshold).
 * Call this from QuoteBuilder's handleConvertToOrder.
 */
export async function notifyLargeOrder(
  orderId: string,
  orderNumber: string,
  customerName: string,
  totalPrice: number,
  threshold: number = 50000
) {
  if (totalPrice < threshold) return;

  try {
    await notifyAdmins(
      'Large Order Created',
      `Order ${orderNumber} for ${customerName} — $${totalPrice.toLocaleString()} (above $${threshold.toLocaleString()} threshold)`,
      'large_order',
      'order',
      orderId
    );
  } catch (err) {
    console.error('Large order notification failed:', err);
  }
}

/**
 * Run all periodic notification checks.
 * Call this once from Dashboard on load.
 */
export async function runPeriodicNotificationChecks() {
  await Promise.all([
    checkLowStockNotifications(),
    checkExpiringQuoteNotifications(),
  ]);
}
