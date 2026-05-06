import { supabase } from './db';
import { sendEmail, buildEmailHtml } from './emailService';
import { Sentry } from './sentry';

const fmt = (n: number | null | undefined) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n ?? 0);

interface OrderRow {
  id: string;
  order_number: string;
  order_date: string;
  total_price: number;
  customer_id: string;
}

interface CustomerRow {
  email: string | null;
  contact_name: string | null;
}

interface OrderItemRow {
  product_name: string;
  total_units_needed: number;
  price_per_unit: number;
}

/**
 * Sends the "Order Confirmed" customer email after an order is created.
 *
 * Wave A.2 / audit finding P1-7. Replaces the dead block in OrderDetail.tsx
 * that was gated on `targetStatus === 'confirmed'` — orders are born at
 * status='confirmed' by both convert_quote_to_order and create_direct_order,
 * so the transition path was structurally unreachable.
 *
 * This helper is fire-and-forget: it never throws. If the customer has no
 * email, or if the send fails, it logs to Sentry at warning level and
 * returns. Callers should NOT await it for correctness — the order is
 * already created and the email is a best-effort notification.
 *
 * Idempotency: uses a stable key `order-confirmed-${orderId}` so the
 * send-email Edge Function dedupes if this is somehow called twice for
 * the same order.
 */
export async function sendOrderConfirmedEmail(orderId: string): Promise<void> {
  try {
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, order_number, order_date, total_price, customer_id')
      .eq('id', orderId)
      .single<OrderRow>();
    if (orderErr || !order) {
      Sentry.captureException(orderErr ?? new Error('Order not found for confirmation email'), {
        level: 'warning',
        extra: { context: 'order_confirmed_email_lookup', orderId },
      });
      return;
    }

    const { data: customer } = await supabase
      .from('customers')
      .select('email, contact_name')
      .eq('id', order.customer_id)
      .single<CustomerRow>();
    if (!customer?.email) return;

    const { data: itemRows } = await supabase
      .from('order_items')
      .select('product_name, total_units_needed, price_per_unit')
      .eq('order_id', orderId);
    const items: OrderItemRow[] = (itemRows ?? []) as OrderItemRow[];

    const itemSummary = items
      .slice(0, 10)
      .map((i) => `<tr>
        <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;">${i.product_name}</td>
        <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${i.total_units_needed}</td>
        <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${fmt(i.price_per_unit)}</td>
      </tr>`)
      .join('');
    const moreItems = items.length > 10
      ? `<p style="color:#64748b;font-size:12px;">...and ${items.length - 10} more item(s)</p>`
      : '';

    const html = buildEmailHtml(`
      <h2 style="color:#1e293b;margin:0 0 12px;">Order Confirmed</h2>
      <p style="color:#475569;font-size:14px;line-height:1.6;">
        Hi${customer.contact_name ? ` ${customer.contact_name}` : ''},
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.6;">
        Your order <strong>${order.order_number}</strong> has been confirmed and is being processed.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr>
          <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;color:#166534;">Order Number</td>
          <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;font-weight:600;color:#166534;">${order.order_number}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Order Date</td>
          <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${new Date(order.order_date + 'T00:00:00').toLocaleDateString()}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Total</td>
          <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${fmt(order.total_price)}</td>
        </tr>
      </table>
      <h3 style="color:#1e293b;font-size:14px;margin:16px 0 8px;">Items</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#f8fafc;">
          <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#64748b;">Product</th>
          <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Qty</th>
          <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Price/Unit</th>
        </tr>
        ${itemSummary}
      </table>
      ${moreItems}
      <p style="color:#475569;font-size:14px;line-height:1.6;margin-top:16px;">
        We'll notify you when deliveries are scheduled. Thank you for your business!
      </p>
    `);

    await sendEmail({
      to: customer.email,
      subject: `Order ${order.order_number} Confirmed — Crop RX Solutions`,
      html,
      email_type: 'order_confirmed',
      customer_id: order.customer_id,
      resource_type: 'order',
      resource_id: order.id,
      idempotency_key: `order-confirmed-${order.id}`,
    });
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      level: 'warning',
      extra: { context: 'order_confirmed_email_send', orderId },
    });
  }
}
