import { buildEmailHtml } from './emailService';
import { escapeHtml } from './proofNotification';

export interface DeliveryReceiptLine {
  name: string;
  qty: number;
}

export interface DeliveryReceiptInput {
  /** 'completed' is sent when the delivery is completed; 'confirmation' is the office resend. */
  variant: 'completed' | 'confirmation';
  deliveryNumber: string;
  contactName: string | null;
  /** Already formatted for display (the completion day, or the paper-ticket day). */
  dateText: string;
  lines: DeliveryReceiptLine[];
  signedBy: string | null;
  isPartial: boolean;
}

/**
 * The customer's delivery receipt email, shared by completion and resend.
 *
 * Every typed value (product names, the contact name, the "Signed by" name) is escaped:
 * send-email does not escape the HTML it is given, so a name containing `<` or `&` would
 * otherwise break the email or inject markup into it. (Readability report B1, 2026-10-23.)
 */
export function buildDeliveryReceiptHtml(input: DeliveryReceiptInput): string {
  const completed = input.variant === 'completed';
  const deliveryNumber = escapeHtml(input.deliveryNumber);

  const lineRows = input.lines
    .map((line) => `<tr>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;">${escapeHtml(line.name)}</td>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${line.qty}</td>
            </tr>`)
    .join('');

  // No delivery photos in the customer email (Mason, 2026-10-14): photos are
  // private staff records and a link in an email would work for anyone holding it.
  const signatureNote = input.signedBy
    ? `<p style="color:#475569;font-size:13px;">${completed ? '' : '✍️ '}Signed by: <strong>${escapeHtml(input.signedBy)}</strong></p>`
    : '';
  const partialNote = input.isPartial
    ? '<p style="color:#d97706;font-size:13px;font-weight:600;margin-top:8px;">This was a partial delivery. Remaining items will be delivered separately.</p>'
    : '';
  const intro = completed
    ? `Your delivery <strong>${deliveryNumber}</strong> has been completed.`
    : `Here is your delivery confirmation for <strong>${deliveryNumber}</strong>.`;

  return buildEmailHtml(`
            <h2 style="color:#1e293b;margin:0 0 12px;">${completed ? 'Delivery Completed' : 'Delivery Confirmation'}</h2>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Hi${input.contactName ? ` ${escapeHtml(input.contactName)}` : ''},
            </p>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              ${intro}
            </p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr>
                <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;color:#166534;">Delivery #</td>
                <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;font-weight:600;color:#166534;">${deliveryNumber}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">${completed ? 'Date' : 'Completed'}</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${escapeHtml(input.dateText)}</td>
              </tr>
            </table>
            <h3 style="color:#1e293b;font-size:14px;margin:16px 0 8px;">Delivered Items</h3>
            <table style="width:100%;border-collapse:collapse;">
              <tr style="background:#f8fafc;">
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#64748b;">Product</th>
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Qty Delivered</th>
              </tr>
              ${lineRows}
            </table>
            ${partialNote}
            ${signatureNote}
            <p style="color:#475569;font-size:14px;line-height:1.6;margin-top:16px;">
              Thank you for your business!
            </p>
          `);
}
