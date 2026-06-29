/**
 * Field-app parity #41 — post-application customer notification helpers.
 *
 * Close mirror of preNotification.ts (#40). Pure, unit-testable logic for the
 * "Send Post-Notification" action:
 *   - the EDITABLE template lives in app_settings.post_application_notice_template
 *     (owner-configurable; criterion #4 — wording is NOT hard-coded). This module
 *     parses that setting, falls back to a sensible default, and interpolates the
 *     {{customer}} / {{job_number}} / {{job_date}} placeholders.
 *   - buildPostNotificationEmailPayload() centralises the recipient guard + subject
 *     + branded body + idempotency key into one SendEmailParams, mirroring
 *     buildPreNotificationEmailPayload so every send is identical + correctly addressed.
 *
 * The RPC record_job_post_notifications records the per-job log; this module owns
 * only the message construction + the per-recipient email payload, which is the part
 * worth testing without a DB.
 */

import { buildEmailHtml, type SendEmailParams } from './emailService';

// ── Template ───────────────────────────────────────────────────────────────

export interface PostNotificationTemplate {
  subject: string;
  /** Plain-text body with {{customer}}, {{job_number}}, {{job_date}} tokens. */
  body: string;
}

/**
 * The seeded default (must stay in sync with the seed in
 * 20260628130000_job_post_notifications.sql). Used only when the setting row is
 * missing or unparseable — the live default is the DB-seeded one the owner edits.
 */
export const DEFAULT_POST_NOTIFICATION_TEMPLATE: PostNotificationTemplate = {
  subject: 'Your field application is complete',
  body:
    'Hello {{customer}},\n\n' +
    'This is to confirm that Crop RX Solutions has completed the field application ' +
    'for you (Job {{job_number}}) on {{job_date}}. Please observe any posted ' +
    're-entry (REI) and pre-harvest (PHI) intervals for the products applied.\n\n' +
    'If you have any questions about this application, just reply to this email or ' +
    'give us a call.\n\n' +
    'Thank you,\nCrop RX Solutions',
};

/**
 * Parse the raw app_settings.setting_value JSON into a template, falling back to the
 * default on any missing/blank field or parse error. Never throws — a bad setting
 * must not break the send flow (it just uses the default wording).
 */
export function parsePostNotificationTemplate(
  rawSettingValue: string | null | undefined,
): PostNotificationTemplate {
  if (!rawSettingValue || !rawSettingValue.trim()) {
    return DEFAULT_POST_NOTIFICATION_TEMPLATE;
  }
  try {
    const parsed = JSON.parse(rawSettingValue) as Partial<PostNotificationTemplate>;
    const subject = typeof parsed.subject === 'string' && parsed.subject.trim()
      ? parsed.subject
      : DEFAULT_POST_NOTIFICATION_TEMPLATE.subject;
    const body = typeof parsed.body === 'string' && parsed.body.trim()
      ? parsed.body
      : DEFAULT_POST_NOTIFICATION_TEMPLATE.body;
    return { subject, body };
  } catch {
    return DEFAULT_POST_NOTIFICATION_TEMPLATE;
  }
}

export interface PostNotificationTokens {
  customer: string;
  jobNumber: string;
  jobDate: string;
}

/**
 * Replace ALL occurrences of the supported placeholders. Unknown tokens are left
 * untouched (so a typo'd {{foo}} is visible rather than silently blanked). A blank
 * token value renders as an empty string, not the literal placeholder.
 */
export function interpolatePostNotification(
  template: string,
  tokens: PostNotificationTokens,
): string {
  return template
    .replace(/\{\{\s*customer\s*\}\}/g, tokens.customer ?? '')
    .replace(/\{\{\s*job_number\s*\}\}/g, tokens.jobNumber ?? '')
    .replace(/\{\{\s*job_date\s*\}\}/g, tokens.jobDate ?? '');
}

/** Resolve the final subject + plain-text body for ONE recipient. */
export function renderPostNotification(
  template: PostNotificationTemplate,
  tokens: PostNotificationTokens,
): { subject: string; body: string } {
  return {
    subject: interpolatePostNotification(template.subject, tokens),
    body: interpolatePostNotification(template.body, tokens),
  };
}

// ── Email payload builder ────────────────────────────────────────────────────

export interface PostNotificationEmailInput {
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
 * Build the SendEmailParams for a single recipient's post-application notice. Throws
 * the honest user-facing error when there is no email on file, so the caller never
 * sends to a blank/wrong address (mirrors buildPreNotificationEmailPayload).
 */
export function buildPostNotificationEmailPayload(
  input: PostNotificationEmailInput,
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
    email_type: 'post_application_notice',
    customer_id: input.customerId,
    resource_type: 'customer',
    resource_id: input.customerId,
    idempotency_key: `post-notice-${input.jobId}-${input.customerId}-${input.nowMs ?? Date.now()}`,
  };
}

// ── Re-send safety (#41, mirrors #40 MED) ────────────────────────────────────

/**
 * How many POST notifications for a job have already been confirmed 'sent'. Counts
 * only `notification_type === 'post'` rows with `status === 'sent'` — a 'failed' row
 * is NOT a prior notification (the customer was never emailed), so it must NOT trigger
 * the re-send warning. Pure so it's unit-testable without a DB.
 */
export function countSentPostNotifications(
  notifications: ReadonlyArray<{ notification_type: string; status: string }>,
): number {
  return notifications.filter(
    (n) => n.notification_type === 'post' && n.status === 'sent',
  ).length;
}

/**
 * Resolve the Send-control label + confirm-modal copy for the post-notification
 * action, given how many recipients have ALREADY been notified.
 *
 * When `alreadySentCount > 0` the job has live post-notices: relabel to "Re-send", and
 * the confirm modal must explicitly warn that confirming notifies those customers a
 * SECOND time. A stray second click sees the warning; a deliberate re-send is an
 * explicit, informed confirmation (mirrors #40's pre-notice re-send safety).
 */
export function describePostNotificationSend(alreadySentCount: number): {
  isResend: boolean;
  buttonLabel: string;
  confirmTitle: string;
  confirmMessage: string;
  confirmLabel: string;
} {
  const baseMessage =
    'Email an after-application notice to this job’s billed customer(s)? '
    + 'Each notification is recorded in the log below. Customers with no email on '
    + 'file are logged but not emailed.';
  if (alreadySentCount > 0) {
    const plural = alreadySentCount === 1 ? 'customer' : 'customers';
    return {
      isResend: true,
      buttonLabel: 'Re-send Post-Notification',
      confirmTitle: 'Re-send Post-Notification',
      confirmMessage:
        `This job already has post-notifications sent to ${alreadySentCount} ${plural}. `
        + 'Sending again will notify them a second time. '
        + 'Only continue if you intend a deliberate re-send.',
      confirmLabel: 'Re-send Anyway',
    };
  }
  return {
    isResend: false,
    buttonLabel: 'Send Post-Notification',
    confirmTitle: 'Send Post-Notification',
    confirmMessage: baseMessage,
    confirmLabel: 'Send Post-Notification',
  };
}

/** Minimal HTML escaping so a customer/job value with <, >, & renders safely. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
