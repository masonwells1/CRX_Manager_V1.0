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
import type { Json } from '../types/supabase';
import { Sentry } from './sentry';
import { createNotification, notifyAdmins } from './activityLogger';
import { localToday, formatLocalDate, parseLocalDate } from './dateUtils';

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

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
      p_entity_type: entityType ?? undefined,
      p_entity_id: entityId ?? undefined,
      p_error_message: errorMessage,
      p_payload: (payload ?? {}) as Json,
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
      `You've been assigned delivery ${deliveryNumber} for ${customerName} on ${parseLocalDate(scheduledDate).toLocaleDateString()}`,
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
 * Notify an applicator when a job is dispatched/assigned to them — either the
 * whole-job legacy assign (JobDetail assigning jobs.applicator_id) or a
 * per-location dispatch (DispatchWizard / DispatchBoard reassign). Mirrors
 * notifyDriverAssigned's shape exactly. U12 (2026-07-06): applicators had NO
 * notification at all before this — verified by grepping JobDetail.tsx/
 * DispatchWizard.tsx/DispatchBoard.tsx for any notify-style/createNotification
 * call around the assign/dispatch RPCs; none existed.
 */
export async function notifyApplicatorDispatched(
  applicatorId: string,
  jobNumber: string,
  customerName: string,
  jobDate: string | null,
  jobId: string
) {
  try {
    // parseLocalDate, not new Date(): jobs.job_date is a bare YYYY-MM-DD, which
    // new Date() parses as UTC midnight → the message names the PREVIOUS day in
    // US timezones (U12 Codex P2).
    const dateLabel = jobDate ? parseLocalDate(jobDate).toLocaleDateString() : 'an upcoming date';
    await createNotification(
      applicatorId,
      'New Job Assigned',
      `You've been assigned job ${jobNumber} for ${customerName} on ${dateLabel}`,
      'job_dispatched',
      'job',
      jobId
    );
  } catch (err) {
    await logNotificationFailure('job_dispatched', err, 'job', jobId, {
      context: 'notifyApplicatorDispatched',
      applicatorId,
      jobNumber,
    });
  }
}

/**
 * Notify an applicator when a job THEY were assigned to gets rescheduled to a
 * different date (job_date changed while the same applicator stays assigned).
 */
export async function notifyApplicatorRescheduled(
  applicatorId: string,
  jobNumber: string,
  customerName: string,
  newJobDate: string | null,
  jobId: string
) {
  try {
    // parseLocalDate — same UTC-midnight-shift reason as notifyApplicatorDispatched.
    const dateLabel = newJobDate ? parseLocalDate(newJobDate).toLocaleDateString() : 'an unscheduled date';
    await createNotification(
      applicatorId,
      'Job Rescheduled',
      `Job ${jobNumber} for ${customerName} was moved to ${dateLabel}`,
      'job_rescheduled',
      'job',
      jobId
    );
  } catch (err) {
    await logNotificationFailure('job_rescheduled', err, 'job', jobId, {
      context: 'notifyApplicatorRescheduled',
      applicatorId,
      jobNumber,
    });
  }
}

/**
 * Notify an applicator when they're REMOVED from a job — the whole-job
 * applicator was changed/cleared, or their per-location dispatch was
 * undispatched/reassigned to someone else. Lets them know it's off their plate
 * without them discovering it only when the card silently disappears.
 */
export async function notifyApplicatorUndispatched(
  applicatorId: string,
  jobNumber: string,
  customerName: string,
  jobId: string
) {
  try {
    await createNotification(
      applicatorId,
      'Job Removed From Your Schedule',
      `Job ${jobNumber} for ${customerName} is no longer assigned to you`,
      'job_undispatched',
      'job',
      jobId
    );
  } catch (err) {
    await logNotificationFailure('job_undispatched', err, 'job', jobId, {
      context: 'notifyApplicatorUndispatched',
      applicatorId,
      jobNumber,
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
    // PR-07 follow-up: read role via profile_public_view so non-admin
    // callers can still resolve another user's role (admin-or-self RLS
    // would block this on `from('profiles')`).
    if (createdBy) {
      const { data: profile } = await supabase
        .from('profile_public_view')
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
 * Notify admins + sales reps that a rush order was created and needs pricing
 * (ship-now/price-later, #2). Call from NewOrder after create_rush_order — the
 * people who can price it (admin/sales_rep) get an actionable alert.
 */
export async function notifyOrderNeedsPricing(
  orderId: string,
  orderNumber: string,
  customerName: string
) {
  try {
    // Read via profile_public_view so a non-admin creator (driver/applicator)
    // can still fan out the alert (admin-or-self RLS would zero-out a direct
    // profiles read) — same rationale as notifyAdmins.
    const { data: staff } = await supabase
      .from('profile_public_view')
      .select('id')
      .in('role', ['admin', 'sales_rep'])
      .eq('is_active', true);
    if (staff && staff.length > 0) {
      const rows = staff
        .filter((s): s is { id: string } => s.id != null)
        .map((s) => ({
          user_id: s.id,
          title: 'Order needs pricing',
          message: `Rush order ${orderNumber} for ${customerName} shipped without pricing — set its prices so it can be invoiced.`,
          notification_type: 'needs_pricing',
          related_entity_type: 'order',
          related_entity_id: orderId,
        }));
      const { error } = await supabase.from('notifications').insert(rows);
      if (error) Sentry.captureException(error, { tags: { source: 'notification_trigger', action: 'notify_order_needs_pricing' } });
    }
  } catch (err) {
    await logNotificationFailure('needs_pricing', err, 'order', orderId, {
      context: 'notifyOrderNeedsPricing',
      orderNumber,
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
  poId: string,
  receiptIntentIds: string[],
) {
  if (!damagedItems || damagedItems.length === 0) return;
  if (receiptIntentIds.length === 0) return;

  try {
    const receiptIntentDigest = await sha256Hex(
      JSON.stringify([...receiptIntentIds].sort()),
    );
    const summary = damagedItems
      .map((i) => `${i.productName} (${i.quantity} — ${i.condition})`)
      .join(', ');

    // RETURNS void — use .throwOnError() so the regex coverage check sees
    // this as fire-and-forget (no `=` capture). Errors funnel through the
    // outer catch and into logNotificationFailure with the same shape.
    await supabase.rpc('notify_damaged_receiving', {
      p_po_number: poNumber,
      p_items_summary: summary,
      p_po_id: poId,
      // The receive RPC returns immutable receiving-record IDs. Binding the
      // notification to that set makes a lost-response retry replay safely
      // instead of emitting a second damaged-receipt alert.
      p_idempotency_key: `damaged-receiving:${poId}:${receiptIntentDigest}`,
    }).throwOnError();
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
    // PR-07 follow-up: read role via profile_public_view (see notifyAdmins).
    if (createdBy) {
      const { data: profile } = await supabase
        .from('profile_public_view')
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
          // PR-07 follow-up: read role via profile_public_view (see notifyAdmins).
          const { data: recipientProfile } = await supabase
            .from('profile_public_view')
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
 * Retired from Dashboard-load in favor of the run_morning_notification_checks cron (U18).
 */
export async function runPeriodicNotificationChecks() {
  await Promise.all([
    checkLowStockNotifications(),
    checkExpiringQuoteNotifications(),
  ]);
}
