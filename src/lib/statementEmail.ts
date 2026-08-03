import type { DetailedStatementData } from '../types';
import { formatCents } from './money';
import { getStatementAccountPosition } from './statementBalance';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** Builds the customer-facing HTML body for an attached statement PDF. */
export function buildStatementEmailContent(
  data: DetailedStatementData,
  statementDate: string,
): string {
  const { grossOpenInvoiceCents, openCreditCents, netAccountPositionCents } =
    getStatementAccountPosition(data);
  const paymentMessage = netAccountPositionCents > 0
    ? 'Please remit payment at your earliest convenience.'
    : 'Your unapplied credits equal or exceed the gross open invoices shown. Please contact Crop RX before sending payment so we can apply them correctly.';
  const farmName = escapeHtml(data.customer.farm_name);
  const displayDate = escapeHtml(statementDate);

  return `
    <h2 style="color:#1e293b;margin:0 0 12px;">Monthly Statement</h2>
    <p style="color:#475569;font-size:14px;line-height:1.6;">
      Dear ${farmName},
    </p>
    <p style="color:#475569;font-size:14px;line-height:1.6;">
      Please find your account statement attached. Gross open invoices are
      <strong>${formatCents(grossOpenInvoiceCents)}</strong>. Unapplied credits on file are
      <strong>${formatCents(openCreditCents)}</strong>, leaving a net account position of
      <strong>${formatCents(netAccountPositionCents)}</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr>
        <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Account</td>
        <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${farmName}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Statement Date</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${displayDate}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Open Invoices</td>
        <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${data.transactions.length}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Gross Open Invoices</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#dc2626;">${formatCents(grossOpenInvoiceCents)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Unapplied Credits</td>
        <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:700;color:#d97706;">${formatCents(openCreditCents)}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Net Account Position</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:700;color:${netAccountPositionCents > 0 ? '#dc2626' : '#16a34a'};">${formatCents(netAccountPositionCents)}</td>
      </tr>
    </table>
    <p style="color:#475569;font-size:13px;line-height:1.6;">
      Credits are shown separately until Crop RX applies them to an invoice.
      ${paymentMessage} Questions? Contact us at 618-843-0413.
    </p>
  `;
}
