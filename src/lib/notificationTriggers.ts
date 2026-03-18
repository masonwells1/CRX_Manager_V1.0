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
 *
 * Failed notifications are logged to `failed_notifications` table
 * for admin visibility and automatic retry.
 */
import { supabase } from './db';
import { Sentry } from './sentry';
import { createNotification, notifyAdmins } from './activityLogger';
import { localToday, formatLocalDate } from './dateUtils';

/**
 * Log a notification failure to the failed_notifications table.
 * This replaces silent console.error swallowing with persistent tracking.
 */
async function logNotificationFailure(
  notificationType: string,
  error: unknown,
  entityType?: string,
  entityId?: string,
  payload?: Record<string, unknown>
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Report to Sentry for visibility
  Sentry.captureException(error, { tags: { source: 'notification_failure', notification_type: notificationType } });

  try {
    await supabase.rpc('log_failed_notification', {
      p_notification_type: notificationType,
      p_entity_type: entityType || null,
      p_entity_id: entityId || null,
      p_error_message: errorMessage,
      p_payload: payload || {},
      p_idempotency_key: crypto.randomUUID(),
    });
  } catch (logErr) {
    // Last-resort: if even logging fails, report to Sentry
    Sentry.captureException(logErr, { tags: { source: 'notification_failure_log', notification_type: notificationType } });
  }
}

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
      (i) => Number(i.quantity_available) <= Number(i.reorder_point)
    );

    if (alerts.length === 0) return;

    // Check which products already had a notification today (dedup)
    const todayStr = localToday();
    const { data: existingToday } = await supabase
      .from('notifications')
      .select('related_entity_id')
      .eq('notification_type', 'low_stock')
      .gte('created_at', `${todayStr}T00:00:00Z`);

    const alreadyNotified = new Set((existingToday || []).map((n) => n.related_entity_id));

    for (const item of alerts) {
      if (alreadyNotified.has(item.product_id)) continue;

      // Supabase returns joined relations as nested objects
      const product = item.product as unknown as { product_name: string } | null;
      const productName = product?.product_name || 'Unknown product';
      await notifyAdmins(
        'Low Stock Alert',
        `${productName} is low — ${item.quantity_available} units available (reorder point: ${item.reorder_point})`,
        'low_stock',
        'product',
        item.product_id
      );
    }
  } catch (err) {
    await logNotificationFailure('low_stock', err, 'product', undefined, {
      context: 'checkLowStockNotifications',
    });
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
      .lte('expires_at', formatLocalDate(threeDaysFromNow))
      .gte('expires_at', formatLocalDate(now));

    if (!expiringQuotes || expiringQuotes.length === 0) return;

    // Dedup: check existing notifications for today
    const today = formatLocalDate(now);
    const { data: existingToday } = await supabase
      .from('notifications')
      .select('related_entity_id')
      .eq('notification_type', 'quote_expiring')
      .gte('created_at', `${today}T00:00:00Z`);

    const alreadyNotified = new Set((existingToday || []).map((n) => n.related_entity_id));

    for (const quote of expiringQuotes) {
      if (alreadyNotified.has(quote.id)) continue;

      // Supabase may return joined relations as object or array depending on relationship type
      const customer = quote.customer as unknown as { farm_name: string } | { farm_name: string }[] | null;
      const customerName = Array.isArray(customer)
        ? customer[0]?.farm_name || 'customer'
        : customer?.farm_name || 'customer';
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
    await logNotificationFailure('quote_expiring', err, 'quote', undefined, {
      context: 'checkExpiringQuoteNotifications',
    });
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
    await logNotificationFailure('delivery_assigned', err, 'delivery', deliveryId, {
      context: 'notifyDriverAssigned',
      driverId,
      deliveryNumber,
    });
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
    await logNotificationFailure('order_status', err, 'order', orderId, {
      context: 'notifyOrderStatusChange',
      orderNumber,
      newStatus,
    });
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
    await logNotificationFailure('large_order', err, 'order', orderId, {
      context: 'notifyLargeOrder',
      orderNumber,
      totalPrice,
    });
  }
}

/**
 * Notify admins when PO items are received in damaged/wrong condition.
 * Call this from PurchaseOrderDetail after receive_po_items() completes.
 */
export async function notifyDamagedReceiving(
  poNumber: string,
  damagedItems: Array<{ productName: string; quantity: number; condition: string }>,
  poId: string
) {
  if (!damagedItems || damagedItems.length === 0) return;

  try {
    const summary = damagedItems
      .map((i) => `${i.productName} (${i.quantity} — ${i.condition})`)
      .join(', ');

    const { error } = await supabase.rpc('notify_damaged_receiving', {
      p_po_number: poNumber,
      p_items_summary: summary,
      p_po_id: poId,
      p_idempotency_key: crypto.randomUUID(),
    });
    if (error) {
      await logNotificationFailure('damaged_receiving', error, 'purchase_order', poId, {
        context: 'notifyDamagedReceiving_rpc',
        poNumber,
      });
    }
  } catch (err) {
    await logNotificationFailure('damaged_receiving', err, 'purchase_order', poId, {
      context: 'notifyDamagedReceiving',
      poNumber,
    });
  }
}

/**
 * Notify admins when a customer's credit limit is exceeded by a new order.
 * Call this from NewOrder after order creation.
 */
export async function notifyCreditLimitExceeded(
  customerName: string,
  outstandingAR: number,
  creditLimit: number,
  customerId: string
) {
  if (outstandingAR <= creditLimit) return;

  try {
    await notifyAdmins(
      'Credit Limit Exceeded',
      `${customerName} outstanding AR $${outstandingAR.toLocaleString()} exceeds credit limit $${creditLimit.toLocaleString()}`,
      'credit_limit_exceeded',
      'customer',
      customerId
    );
  } catch (err) {
    await logNotificationFailure('credit_limit_exceeded', err, 'customer', customerId, {
      context: 'notifyCreditLimitExceeded',
      customerName,
      outstandingAR,
      creditLimit,
    });
  }
}

/**
 * Notify sales rep + admins when a delivery is completed with partial quantities.
 * Call this from DeliveryDetail after completing a delivery with remainders.
 */
export async function notifyDeliveryRemainder(
  deliveryId: string,
  deliveryNumber: string,
  orderNumber: string,
  remainderItems: Array<{ product: string; ordered: number; delivered: number }>,
  createdBy?: string
) {
  if (!remainderItems || remainderItems.length === 0) return;

  try {
    const summary = remainderItems
      .map((i) => `${i.product}: ${i.delivered}/${i.ordered}`)
      .join(', ');

    const title = 'Delivery Completed with Remainders';
    const message = `Delivery ${deliveryNumber} (Order ${orderNumber}) had partial quantities: ${summary}`;

    // Notify admins
    await notifyAdmins(title, message, 'delivery_remainder', 'delivery', deliveryId);

    // Also notify the order creator if provided and not an admin
    if (createdBy) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', createdBy)
        .maybeSingle();

      if (profile && profile.role !== 'admin') {
        await createNotification(createdBy, title, message, 'delivery_remainder', 'delivery', deliveryId);
      }
    }
  } catch (err) {
    await logNotificationFailure('delivery_remainder', err, 'delivery', deliveryId, {
      context: 'notifyDeliveryRemainder',
      deliveryNumber,
      orderNumber,
    });
  }
}

/**
 * Notify admins when PO items are received beyond the ordered quantity.
 * Call this from PurchaseOrderDetail after receive_po_items() completes
 * with over-received items.
 */
export async function notifyOverReceive(
  poNumber: string,
  overItems: Array<{ productName: string; quantityOrdered: number; quantityReceived: number }>,
  poId: string
) {
  if (!overItems || overItems.length === 0) return;

  try {
    const summary = overItems
      .map((i) => `${i.productName} (received ${i.quantityReceived}, ordered ${i.quantityOrdered})`)
      .join(', ');

    await notifyAdmins(
      'Over-Receive Alert',
      `PO ${poNumber} has items received beyond ordered quantity: ${summary}`,
      'over_receive',
      'purchase_order',
      poId
    );
  } catch (err) {
    await logNotificationFailure('over_receive', err, 'purchase_order', poId, {
      context: 'notifyOverReceive',
      poNumber,
    });
  }
}

/**
 * Notify driver, admins, and sales rep when a delivery is completed.
 * Call this from DeliveryDetail after completing a delivery.
 */
export async function notifyDeliveryCompleted(
  deliveryId: string,
  deliveryNumber: string,
  customerName: string,
  driverUserId: string | null,
  orderId: string | null,
  isPartial: boolean
) {
  const label = isPartial ? '(partial)' : '';
  const title = `Delivery Completed ${label}`.trim();
  const message = `Delivery ${deliveryNumber} for ${customerName} has been completed${isPartial ? ' with partial quantities' : ''}.`;

  try {
    // Notify admins
    await notifyAdmins(title, message, 'delivery_completed', 'delivery', deliveryId);

    // Notify the assigned driver (confirmation their delivery is recorded)
    if (driverUserId) {
      await createNotification(
        driverUserId,
        title,
        message,
        'delivery_completed',
        'delivery',
        deliveryId
      );
    }

    // Notify sales rep from the linked order's commissions
    if (orderId) {
      const { data: commissions } = await supabase
        .from('commissions')
        .select('recipient')
        .eq('order_id', orderId)
        .neq('status', 'cancelled');

      if (commissions && commissions.length > 0) {
        const uniqueRecipients = [...new Set(commissions.map((c) => c.recipient))];
        for (const recipientId of uniqueRecipients) {
          // Skip if recipient is the driver (already notified) or an admin (already notified)
          if (recipientId === driverUserId) continue;
          const { data: recipientProfile } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', recipientId)
            .maybeSingle();
          if (recipientProfile?.role === 'admin') continue;

          await createNotification(
            recipientId,
            title,
            `Your customer ${customerName} received delivery ${deliveryNumber}${isPartial ? ' (partial)' : ''}.`,
            'delivery_completed',
            'delivery',
            deliveryId
          );
        }
      }
    }
  } catch (err) {
    await logNotificationFailure('delivery_completed', err, 'delivery', deliveryId, {
      context: 'notifyDeliveryCompleted',
      deliveryNumber,
      customerName,
    });
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
