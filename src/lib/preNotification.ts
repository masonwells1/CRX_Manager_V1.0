/**
 * Field-app parity #40 — pre-application customer notification helpers.
 *
 * Pure, unit-testable logic for the "Send Pre-Notification" action:
 *   - the EDITABLE template lives in app_settings.pre_application_notice_template
 *     (owner-configurable; criterion #5 — wording is NOT hard-coded). This module
 *     parses that setting, falls back to a sensible default, and interpolates the
 *     {{customer}} / {{job_number}} / {{job_date}} placeholders.
 *   - buildPreNotificationEmailPayload() centralises the recipient guard + subject
 *     + branded body + idempotency key into one SendEmailParams, mirroring
 *     buildInvoiceEmailPayload so every send is identical + correctly addressed.
 *
 * The RPC record_job_pre_notifications records the per-job log; this module owns
 * only the message construction + the per-recipient email payload, which is the
 * part worth testing without a DB.
 */

import { buildEmailHtml, type SendEmailParams } from './emailService';

// ── Template ───────────────────────────────────────────────────────────────

export interface PreNotificationTemplate {
  subject: string;
  /** Plain-text body with {{customer}}, {{job_number}}, {{job_date}} tokens. */
  body: string;
}

/**
 * The seeded default (must stay in sync with the seed in
 * 20260628120000_job_notifications.sql). Used only when the setting row is
 * missing or unparseable — the live default is the DB-seeded one the owner edits.
 */
export const DEFAULT_PRE_NOTIFICATION_TEMPLATE: PreNotificationTemplate = {
  subject: 'Upcoming application on your fields',
  body:
    'Hello {{customer}},\n\n' +
    'This is a courtesy notice that Crop RX Solutions has a field application ' +
    'scheduled for you (Job {{job_number}}) on {{job_date}}. Please keep people ' +
    'and livestock clear of the treated fields and observe any posted re-entry ' +
    'intervals.\n\n' +
    'If you have any questions, just reply to this email or give us a call.\n\n' +
    'Thank you,\nCrop RX Solutions',
};

/**
 * Parse the raw app_settings.setting_value JSON into a template, falling back to
 * the default on any missing/blank field or parse error. Never throws — a bad
 * setting must not break the send flow (it just uses the default wording).
 */
export function parsePreNotificationTemplate(
  rawSettingValue: string | null | undefined,
): PreNotificationTemplate {
  if (!rawSettingValue || !rawSettingValue.trim()) {
    return DEFAULT_PRE_NOTIFICATION_TEMPLATE;
  }
  try {
    const parsed = JSON.parse(rawSettingValue) as Partial<PreNotificationTemplate>;
    const subject = typeof parsed.subject === 'string' && parsed.subject.trim()
      ? parsed.subject
      : DEFAULT_PRE_NOTIFICATION_TEMPLATE.subject;
    const body = typeof parsed.body === 'string' && parsed.body.trim()
      ? parsed.body
      : DEFAULT_PRE_NOTIFICATION_TEMPLATE.body;
    return { subject, body };
  } catch {
    return DEFAULT_PRE_NOTIFICATION_TEMPLATE;
  }
}

export interface PreNotificationTokens {
  customer: string;
  jobNumber: string;
  jobDate: string;
}

/**
 * Replace ALL occurrences of the supported placeholders. Unknown tokens are left
 * untouched (so a typo'd {{foo}} is visible rather than silently blanked). A
 * blank token value renders as an empty string, not the literal placeholder.
 */
export function interpolatePreNotification(
  template: string,
  tokens: PreNotificationTokens,
): string {
  return template
    .replace(/\{\{\s*customer\s*\}\}/g, tokens.customer ?? '')
    .replace(/\{\{\s*job_number\s*\}\}/g, tokens.jobNumber ?? '')
    .replace(/\{\{\s*job_date\s*\}\}/g, tokens.jobDate ?? '');
}

/** Resolve the final subject + plain-text body for ONE recipient. */
export function renderPreNotification(
  template: PreNotificationTemplate,
  tokens: PreNotificationTokens,
): { subject: string; body: string } {
  return {
    subject: interpolatePreNotification(template.subject, tokens),
    body: interpolatePreNotification(template.body, tokens),
  };
}

// ── Email payload builder ────────────────────────────────────────────────────

export interface PreNotificationEmailInput {
  /** The resolved share customer's email — throws if blank (never a silent send). */
  customerEmail: string | null | undefined;
  customerId: string;
  jobId: string;
  subject: string;
  /** Plain-text body (already interpolated); rendered into the branded HTML. */
  body: string;
  /** Unique-per-send token; defaults to a per-job+customer+timestamp key. */
  nowMs?: number;
}

/**
 * Build the SendEmailParams for a single recipient's pre-application notice.
 * Throws the honest user-facing error when there is no email on file, so the
 * caller never sends to a blank/wrong address (mirrors buildInvoiceEmailPayload).
 */
export function buildPreNotificationEmailPayload(
  input: PreNotificationEmailInput,
): SendEmailParams {
  const email = input.customerEmail?.trim();
  if (!email) {
    throw new Error('Customer does not have an email address on file');
  }

  // Render the plain-text body into the branded template, preserving line breaks.
  const htmlBody = input.body
    .split('\n')
    .map((line) =>
      line.trim() === ''
        ? '<p style="margin:0 0 12px;">&nbsp;</p>'
        : `<p style="margin:0 0 8px;color:#374151;">${escapeHtml(line)}</p>`,
    )
    .join('');

  return {
    to: email,
    subject: input.subject,
    html: buildEmailHtml(htmlBody),
    email_type: 'pre_application_notice',
    customer_id: input.customerId,
    resource_type: 'customer',
    resource_id: input.customerId,
    idempotency_key: `pre-notice-${input.jobId}-${input.customerId}-${input.nowMs ?? Date.now()}`,
  };
}

/** Minimal HTML escaping so a customer/job value with <, >, & renders safely. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
