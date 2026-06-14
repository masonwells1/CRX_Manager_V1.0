/**
 * Customer "delivery completed" receipt email.
 *
 * This is a COPY of the inline email builder in DeliveryDetail.tsx (~862-934),
 * lifted into a shared lib so Field Mode (FieldStop.tsx) can send the SAME
 * receipt the desktop screen sends — WITHOUT editing DeliveryDetail.tsx (which
 * keeps its own inline copy, untouched, per the build freeze). A future cleanup
 * can switch DeliveryDetail to this helper; until then the two are intentionally
 * duplicated. Keep them in sync if the receipt format changes.
 *
 * Source of truth for the HTML/subject: src/pages/DeliveryDetail.tsx handleComplete.
 */
import { sendEmail, buildEmailHtml } from './emailService';
import { Sentry } from './sentry';

export interface CompletionEmailItem {
  /** Product name */
  name: string;
  /** Quantity delivered (only rows with qty > 0 are shown) */
  qty: number;
}

export interface CompletionEmailPhoto {
  image_url: string;
  caption?: string | null;
}

export interface DeliveryCompletionEmailParams {
  customerEmail: string;
  contactName?: string | null;
  deliveryNumber: string;
  deliveryId: string;
  customerId: string;
  items: CompletionEmailItem[];
  isPartial: boolean;
  signedBy: string;
  photos: CompletionEmailPhoto[];
}

/**
 * Build and send the delivery-completion receipt to the customer.
 *
 * Mirrors the desktop behavior: failures are swallowed (logged to Sentry at
 * warning level) because the delivery itself has already succeeded — a failed
 * receipt email must never surface as a completion error.
 */
export async function sendDeliveryCompletionEmail(params: DeliveryCompletionEmailParams): Promise<void> {
  const { customerEmail, contactName, deliveryNumber, deliveryId, customerId, items, isPartial, signedBy, photos } = params;

  try {
    const deliveredItems = items
      .filter((row) => row.qty > 0)
      .map((row) => `<tr>
        <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;">${row.name}</td>
        <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${row.qty}</td>
      </tr>`)
      .join('');

    const photoCount = photos.length;
    const photoImages = photos.slice(0, 6).map((p) =>
      `<img src="${p.image_url}" alt="${p.caption || 'Delivery photo'}" style="width:140px;height:105px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;" />`
    ).join('');
    const photoNote = photoCount > 0
      ? `<div style="margin-top:16px;"><p style="color:#1e293b;font-size:14px;font-weight:600;margin-bottom:8px;">Delivery Photos (${photoCount})</p><div style="display:flex;flex-wrap:wrap;gap:8px;">${photoImages}</div>${photoCount > 6 ? `<p style="color:#64748b;font-size:12px;margin-top:6px;">+ ${photoCount - 6} more photo(s) on file</p>` : ''}</div>`
      : '';
    const signatureNote = signedBy
      ? `<p style="color:#475569;font-size:13px;">Signed by: <strong>${signedBy}</strong></p>`
      : '';
    const partialNote = isPartial
      ? '<p style="color:#d97706;font-size:13px;font-weight:600;margin-top:8px;">This was a partial delivery. Remaining items will be delivered separately.</p>'
      : '';

    const html = buildEmailHtml(`
      <h2 style="color:#1e293b;margin:0 0 12px;">Delivery Completed</h2>
      <p style="color:#475569;font-size:14px;line-height:1.6;">
        Hi${contactName ? ` ${contactName}` : ''},
      </p>
      <p style="color:#475569;font-size:14px;line-height:1.6;">
        Your delivery <strong>${deliveryNumber}</strong> has been completed.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr>
          <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;color:#166534;">Delivery #</td>
          <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;font-weight:600;color:#166534;">${deliveryNumber}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Date</td>
          <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${new Date().toLocaleDateString()}</td>
        </tr>
      </table>
      <h3 style="color:#1e293b;font-size:14px;margin:16px 0 8px;">Delivered Items</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#f8fafc;">
          <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#64748b;">Product</th>
          <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Qty Delivered</th>
        </tr>
        ${deliveredItems}
      </table>
      ${partialNote}
      ${signatureNote}
      ${photoNote}
      <p style="color:#475569;font-size:14px;line-height:1.6;margin-top:16px;">
        Thank you for your business!
      </p>
    `);

    await sendEmail({
      to: customerEmail,
      subject: `Delivery ${deliveryNumber} Completed — Crop RX Solutions`,
      html,
      email_type: 'delivery_completed',
      customer_id: customerId,
      resource_type: 'delivery',
      resource_id: deliveryId,
      idempotency_key: `delivery-completed-${deliveryId}-${Date.now()}`,
    });
  } catch (emailErr) {
    Sentry.captureException(emailErr instanceof Error ? emailErr : new Error(String(emailErr)), {
      level: 'warning',
      extra: { context: 'Field Mode delivery completion email failed — delivery already succeeded' },
    });
  }
}
