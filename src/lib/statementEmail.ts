import type { DetailedStatementData } from '../types';
import { formatCents } from './money';

export function getStatementAccountPosition(data: DetailedStatementData) {
  if (
    typeof data.open_credit_cents !== 'number' ||
    typeof data.net_account_position_cents !== 'number'
  ) {
    throw new Error(
      'Statement generation is temporarily unavailable because the database balance disclosure is not ready.',
    );
  }

  const grossOpenInvoiceCents = data.outstanding_balance_cents;
  const openCreditCents = data.open_credit_cents;
  const netAccountPositionCents = data.net_account_position_cents;

  return { grossOpenInvoiceCents, openCreditCents, netAccountPositionCents };
}

export function buildStatementEmailContent(
  data: DetailedStatementData,
  statementDate: string,
): string {
  const { grossOpenInvoiceCents, openCreditCents, netAccountPositionCents } =
    getStatementAccountPosition(data);
  const paymentMessage = netAccountPositionCents > 0
    ? 'Please remit payment at your earliest convenience.'
    : 'Your unapplied credits equal or exceed the gross open invoices shown. Please contact Crop RX before sending payment so we can apply them correctly.';

  return `
    <h2 style="color:#1e293b;margin:0 0 12px;">Monthly Statement</h2>
    <p style="color:#475569;font-size:14px;line-height:1.6;">
      Dear ${data.customer.farm_name},
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
        <td style="padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${data.customer.farm_name}</td>
      </tr>
      <tr>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Statement Date</td>
        <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${statementDate}</td>
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
