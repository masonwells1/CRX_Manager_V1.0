/**
 * Customer "delivery completed" receipt email, sent from Field Mode (FieldStop.tsx).
 *
 * The HTML comes from buildDeliveryReceiptHtml (src/lib/deliveryReceiptEmail.ts), the same
 * builder DeliveryDetail uses for completion and resend, so all three escape typed names.
 */
import { sendEmail } from './emailService';
import { buildDeliveryReceiptHtml } from './deliveryReceiptEmail';
import { Sentry } from './sentry';
import { parseLocalDate } from './dateUtils';

export interface CompletionEmailItem {
  /** Product name */
  name: string;
  /** Quantity delivered (only rows with qty > 0 are shown) */
  qty: number;
}

// No delivery photos in this email (Mason, 2026-10-14): photos are private staff
// records, and a link in an email would work for anyone holding it.
export interface DeliveryCompletionEmailParams {
  customerEmail: string;
  contactName?: string | null;
  deliveryNumber: string;
  deliveryId: string;
  customerId: string;
  items: CompletionEmailItem[];
  isPartial: boolean;
  signedBy: string;
  /** YYYY-MM-DD the delivery happened (paper-ticket path); defaults to today. */
  deliveredOn?: string;
}

/**
 * Build and send the delivery-completion receipt to the customer.
 *
 * Mirrors the desktop behavior: failures are swallowed (logged to Sentry at
 * warning level) because the delivery itself has already succeeded — a failed
 * receipt email must never surface as a completion error.
 */
// Returns false when the email could not be sent (the delivery itself already completed),
// so the caller can tell the driver instead of failing silently.
export const RECEIPT_NOT_SENT_MESSAGE =
  'Delivery completed, but the customer receipt email did not send. Ask the office to send it with Email Confirmation on this delivery.';

// Paper-ticket path: this phone had no customer email to send a receipt to (none on file, or the
// customer record is not visible to this driver). Say so rather than skip it silently.
export const RECEIPT_NO_EMAIL_MESSAGE =
  'Delivery completed, but no customer receipt was sent from this phone (no customer email available here). Ask the office to send it with Email Confirmation on this delivery.';

// The customer record IS visible here and has no email: Email Confirmation could not send one either.
export const RECEIPT_NO_EMAIL_ON_FILE_MESSAGE = 'No customer email on file, so no receipt was sent.';

export async function sendDeliveryCompletionEmail(params: DeliveryCompletionEmailParams): Promise<boolean> {
  const { customerEmail, contactName, deliveryNumber, deliveryId, customerId, items, isPartial, signedBy, deliveredOn } = params;
  const receiptDate = deliveredOn ? parseLocalDate(deliveredOn).toLocaleDateString() : new Date().toLocaleDateString();

  try {
    const html = buildDeliveryReceiptHtml({
      variant: 'completed',
      deliveryNumber,
      contactName: contactName ?? null,
      dateText: receiptDate,
      lines: items.filter((row) => row.qty > 0),
      signedBy: signedBy || null,
      isPartial,
    });

    await sendEmail({
      to: customerEmail,
      subject: `Delivery ${deliveryNumber} Completed — Crop RX Solutions`,
      html,
      email_type: 'delivery_completed',
      customer_id: customerId,
      resource_type: 'delivery',
      resource_id: deliveryId,
      idempotency_key: `delivery-completed-${deliveryId}`,
    });
    return true;
  } catch (emailErr) {
    Sentry.captureException(emailErr instanceof Error ? emailErr : new Error(String(emailErr)), {
      level: 'warning',
      extra: { context: 'Field Mode delivery completion email failed — delivery already succeeded' },
    });
    return false;
  }
}
