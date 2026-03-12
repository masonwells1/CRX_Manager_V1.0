import { supabase } from './db';

// ── Types ──────────────────────────────────────────────────────────────

export type EmailType =
  | 'invoice'
  | 'statement'
  | 'order_confirmed'
  | 'delivery_completed'
  | 'quote'
  | 'ar_reminder'
  | 'low_stock_alert'
  | 'month_end_close';

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  email_type: EmailType;
  customer_id?: string;
  idempotency_key?: string;
  attachments?: Array<{ filename: string; content: string }>; // base64
}

export interface SendEmailResult {
  success: boolean;
  email_log_id?: string;
  resend_message_id?: string;
  error?: string;
}

// ── sendEmail ──────────────────────────────────────────────────────────

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new Error(`Auth session error: ${sessionError.message}`);
  if (!session) throw new Error('Not authenticated');

  const resp = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-email`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(params),
    },
  );

  let result: Record<string, unknown>;
  try {
    result = await resp.json();
  } catch {
    throw new Error(`Email service returned invalid response (HTTP ${resp.status})`);
  }
  if (!resp.ok) throw new Error((result.error as string) || 'Email send failed');
  return result as unknown as SendEmailResult;
}

// ── pdfToBase64 ────────────────────────────────────────────────────────
// Converts a jsPDF doc instance to a raw base64 string (no data URI prefix).

export function pdfToBase64(doc: { output: (type: string) => string }): string {
  // jsPDF.output('datauristring') returns "data:application/pdf;filename=...;base64,<data>"
  const dataUri = doc.output('datauristring');
  const base64Part = dataUri.split('base64,')[1];
  return base64Part;
}

// ── buildEmailHtml ─────────────────────────────────────────────────────
// Wraps body content in a CRX-branded HTML email template.

export function buildEmailHtml(bodyContent: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="background-color:#16a34a;padding:20px 24px;border-radius:8px 8px 0 0;">
              <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700;">
                Crop RX Solutions
              </h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
              ${bodyContent}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;padding:16px 24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:0;">
              <p style="margin:0 0 4px;color:#6b7280;font-size:12px;">
                Crop RX Solutions &bull; croprxsolutions.app
              </p>
              <p style="margin:0;color:#9ca3af;font-size:11px;">
                This is an automated message. Please contact us if you have questions.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
