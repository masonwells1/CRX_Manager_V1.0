import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POST_NOTIFICATION_TEMPLATE,
  parsePostNotificationTemplate,
  interpolatePostNotification,
  renderPostNotification,
  buildPostNotificationEmailPayload,
  countSentPostNotifications,
  describePostNotificationSend,
  type PostNotificationTokens,
  type PostNotificationEmailInput,
} from './postNotification';

const tokens: PostNotificationTokens = {
  customer: 'Green Acres Farm',
  jobNumber: 'JOB-2026-0042',
  jobDate: '2026-06-30',
};

describe('parsePostNotificationTemplate', () => {
  it('falls back to the default on null/blank input', () => {
    expect(parsePostNotificationTemplate(null)).toEqual(DEFAULT_POST_NOTIFICATION_TEMPLATE);
    expect(parsePostNotificationTemplate(undefined)).toEqual(DEFAULT_POST_NOTIFICATION_TEMPLATE);
    expect(parsePostNotificationTemplate('   ')).toEqual(DEFAULT_POST_NOTIFICATION_TEMPLATE);
  });

  it('falls back to the default on unparseable JSON (never throws)', () => {
    expect(parsePostNotificationTemplate('{not json')).toEqual(DEFAULT_POST_NOTIFICATION_TEMPLATE);
  });

  it('uses the owner-edited subject + body when present', () => {
    const raw = JSON.stringify({ subject: 'All done', body: 'Hi {{customer}}' });
    expect(parsePostNotificationTemplate(raw)).toEqual({ subject: 'All done', body: 'Hi {{customer}}' });
  });

  it('fills only the missing field from the default (partial override)', () => {
    const raw = JSON.stringify({ subject: 'Custom subject only' });
    const t = parsePostNotificationTemplate(raw);
    expect(t.subject).toBe('Custom subject only');
    expect(t.body).toBe(DEFAULT_POST_NOTIFICATION_TEMPLATE.body);
  });
});

describe('interpolatePostNotification', () => {
  it('replaces all supported placeholders (every occurrence)', () => {
    const out = interpolatePostNotification(
      '{{customer}} / {{job_number}} / {{job_date}} / {{customer}}',
      tokens,
    );
    expect(out).toBe('Green Acres Farm / JOB-2026-0042 / 2026-06-30 / Green Acres Farm');
  });

  it('tolerates inner whitespace in the token braces', () => {
    expect(interpolatePostNotification('Hi {{ customer }}', tokens)).toBe('Hi Green Acres Farm');
  });

  it('leaves unknown placeholders untouched (visible typo, not silent blank)', () => {
    expect(interpolatePostNotification('Hi {{grower}}', tokens)).toBe('Hi {{grower}}');
  });
});

describe('renderPostNotification', () => {
  it('renders subject + body together', () => {
    const r = renderPostNotification(
      { subject: 'Complete for {{customer}}', body: 'Job {{job_number}} on {{job_date}}' },
      tokens,
    );
    expect(r.subject).toBe('Complete for Green Acres Farm');
    expect(r.body).toBe('Job JOB-2026-0042 on 2026-06-30');
  });

  it('the seeded default renders with the real customer/job tokens', () => {
    const r = renderPostNotification(DEFAULT_POST_NOTIFICATION_TEMPLATE, tokens);
    expect(r.body).toContain('Hello Green Acres Farm,');
    expect(r.body).toContain('Job JOB-2026-0042');
    expect(r.body).toContain('2026-06-30');
    // no leftover placeholder markers
    expect(r.body).not.toContain('{{');
  });
});

describe('buildPostNotificationEmailPayload', () => {
  const base: PostNotificationEmailInput = {
    customerEmail: 'farmer@example.com',
    customerId: 'cust-123',
    jobId: 'job-456',
    subject: 'Application complete',
    body: 'Hello Green Acres Farm,\n\nThe application is done.',
    nowMs: 1_700_000_000_000,
  };

  it('addresses the email to the resolved customer email + correct type', () => {
    const p = buildPostNotificationEmailPayload(base);
    expect(p.to).toBe('farmer@example.com');
    expect(p.customer_id).toBe('cust-123');
    expect(p.email_type).toBe('post_application_notice');
    expect(p.subject).toBe('Application complete');
  });

  it('throws an honest error (no send) when the customer has no email on file', () => {
    expect(() => buildPostNotificationEmailPayload({ ...base, customerEmail: null }))
      .toThrow('Customer does not have an email address on file');
    expect(() => buildPostNotificationEmailPayload({ ...base, customerEmail: '' }))
      .toThrow('Customer does not have an email address on file');
    expect(() => buildPostNotificationEmailPayload({ ...base, customerEmail: '   ' }))
      .toThrow('Customer does not have an email address on file');
  });

  it('trims surrounding whitespace from the recipient', () => {
    const p = buildPostNotificationEmailPayload({ ...base, customerEmail: '  farmer@example.com  ' });
    expect(p.to).toBe('farmer@example.com');
  });

  it('builds a deterministic, per-job+customer idempotency key', () => {
    const p = buildPostNotificationEmailPayload(base);
    expect(p.idempotency_key).toBe('post-notice-job-456-cust-123-1700000000000');
  });

  it('renders the plain-text body into branded HTML and escapes HTML metachars', () => {
    const p = buildPostNotificationEmailPayload({ ...base, body: 'A & B <tag>' });
    expect(p.html).toContain('A &amp; B &lt;tag&gt;');
    // branded wrapper present
    expect(p.html).toContain('Crop RX Solutions');
  });

  it('has no attachments (post-notice is body-only)', () => {
    const p = buildPostNotificationEmailPayload(base);
    expect(p.attachments).toBeUndefined();
  });
});

// ── #41: re-send safety (warn before re-notifying already-sent customers) ──────

describe('countSentPostNotifications', () => {
  it('counts only post rows with status sent', () => {
    const rows = [
      { notification_type: 'post', status: 'sent' },
      { notification_type: 'post', status: 'sent' },
      { notification_type: 'post', status: 'failed' }, // not yet emailed — NOT counted
      { notification_type: 'pre', status: 'sent' },     // pre notice — NOT a post-notification
    ];
    expect(countSentPostNotifications(rows)).toBe(2);
  });

  it('returns 0 when nothing has been sent (empty or all-failed)', () => {
    expect(countSentPostNotifications([])).toBe(0);
    expect(countSentPostNotifications([
      { notification_type: 'post', status: 'failed' },
      { notification_type: 'post', status: 'failed' },
    ])).toBe(0);
  });
});

describe('describePostNotificationSend', () => {
  it('first send (0 already sent): default Send label, no re-send warning', () => {
    const c = describePostNotificationSend(0);
    expect(c.isResend).toBe(false);
    expect(c.buttonLabel).toBe('Send Post-Notification');
    expect(c.confirmTitle).toBe('Send Post-Notification');
    expect(c.confirmLabel).toBe('Send Post-Notification');
    expect(c.confirmMessage).not.toMatch(/second time/i);
  });

  it('re-send (>=1 already sent): relabels + warns about a SECOND notification', () => {
    const c = describePostNotificationSend(3);
    expect(c.isResend).toBe(true);
    expect(c.buttonLabel).toBe('Re-send Post-Notification');
    expect(c.confirmTitle).toBe('Re-send Post-Notification');
    expect(c.confirmLabel).toBe('Re-send Anyway');
    // the warning must state how many and that they'll be notified again
    expect(c.confirmMessage).toContain('3 customers');
    expect(c.confirmMessage).toMatch(/second time/i);
  });

  it('singularizes the customer count in the warning', () => {
    const c = describePostNotificationSend(1);
    expect(c.confirmMessage).toContain('1 customer.');
    expect(c.confirmMessage).not.toContain('1 customers');
  });
});
