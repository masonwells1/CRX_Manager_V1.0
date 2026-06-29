import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PRE_NOTIFICATION_TEMPLATE,
  parsePreNotificationTemplate,
  interpolatePreNotification,
  renderPreNotification,
  buildPreNotificationEmailPayload,
  type PreNotificationTokens,
  type PreNotificationEmailInput,
} from './preNotification';

const tokens: PreNotificationTokens = {
  customer: 'Green Acres Farm',
  jobNumber: 'JOB-2026-0042',
  jobDate: '2026-06-30',
};

describe('parsePreNotificationTemplate', () => {
  it('falls back to the default on null/blank input', () => {
    expect(parsePreNotificationTemplate(null)).toEqual(DEFAULT_PRE_NOTIFICATION_TEMPLATE);
    expect(parsePreNotificationTemplate(undefined)).toEqual(DEFAULT_PRE_NOTIFICATION_TEMPLATE);
    expect(parsePreNotificationTemplate('   ')).toEqual(DEFAULT_PRE_NOTIFICATION_TEMPLATE);
  });

  it('falls back to the default on unparseable JSON (never throws)', () => {
    expect(parsePreNotificationTemplate('{not json')).toEqual(DEFAULT_PRE_NOTIFICATION_TEMPLATE);
  });

  it('uses the owner-edited subject + body when present', () => {
    const raw = JSON.stringify({ subject: 'Heads up', body: 'Hi {{customer}}' });
    expect(parsePreNotificationTemplate(raw)).toEqual({ subject: 'Heads up', body: 'Hi {{customer}}' });
  });

  it('fills only the missing field from the default (partial override)', () => {
    const raw = JSON.stringify({ subject: 'Custom subject only' });
    const t = parsePreNotificationTemplate(raw);
    expect(t.subject).toBe('Custom subject only');
    expect(t.body).toBe(DEFAULT_PRE_NOTIFICATION_TEMPLATE.body);
  });
});

describe('interpolatePreNotification', () => {
  it('replaces all supported placeholders (every occurrence)', () => {
    const out = interpolatePreNotification(
      '{{customer}} / {{job_number}} / {{job_date}} / {{customer}}',
      tokens,
    );
    expect(out).toBe('Green Acres Farm / JOB-2026-0042 / 2026-06-30 / Green Acres Farm');
  });

  it('tolerates inner whitespace in the token braces', () => {
    expect(interpolatePreNotification('Hi {{ customer }}', tokens)).toBe('Hi Green Acres Farm');
  });

  it('leaves unknown placeholders untouched (visible typo, not silent blank)', () => {
    expect(interpolatePreNotification('Hi {{grower}}', tokens)).toBe('Hi {{grower}}');
  });
});

describe('renderPreNotification', () => {
  it('renders subject + body together', () => {
    const r = renderPreNotification(
      { subject: 'Notice for {{customer}}', body: 'Job {{job_number}} on {{job_date}}' },
      tokens,
    );
    expect(r.subject).toBe('Notice for Green Acres Farm');
    expect(r.body).toBe('Job JOB-2026-0042 on 2026-06-30');
  });

  it('the seeded default renders with the real customer/job tokens', () => {
    const r = renderPreNotification(DEFAULT_PRE_NOTIFICATION_TEMPLATE, tokens);
    expect(r.body).toContain('Hello Green Acres Farm,');
    expect(r.body).toContain('Job JOB-2026-0042');
    expect(r.body).toContain('2026-06-30');
    // no leftover placeholder markers
    expect(r.body).not.toContain('{{');
  });
});

describe('buildPreNotificationEmailPayload', () => {
  const base: PreNotificationEmailInput = {
    customerEmail: 'farmer@example.com',
    customerId: 'cust-123',
    jobId: 'job-456',
    subject: 'Upcoming application',
    body: 'Hello Green Acres Farm,\n\nWe are coming out soon.',
    nowMs: 1_700_000_000_000,
  };

  it('addresses the email to the resolved customer email + correct type', () => {
    const p = buildPreNotificationEmailPayload(base);
    expect(p.to).toBe('farmer@example.com');
    expect(p.customer_id).toBe('cust-123');
    expect(p.email_type).toBe('pre_application_notice');
    expect(p.subject).toBe('Upcoming application');
  });

  it('throws an honest error (no send) when the customer has no email on file', () => {
    expect(() => buildPreNotificationEmailPayload({ ...base, customerEmail: null }))
      .toThrow('Customer does not have an email address on file');
    expect(() => buildPreNotificationEmailPayload({ ...base, customerEmail: '' }))
      .toThrow('Customer does not have an email address on file');
    expect(() => buildPreNotificationEmailPayload({ ...base, customerEmail: '   ' }))
      .toThrow('Customer does not have an email address on file');
  });

  it('trims surrounding whitespace from the recipient', () => {
    const p = buildPreNotificationEmailPayload({ ...base, customerEmail: '  farmer@example.com  ' });
    expect(p.to).toBe('farmer@example.com');
  });

  it('builds a deterministic, per-job+customer idempotency key', () => {
    const p = buildPreNotificationEmailPayload(base);
    expect(p.idempotency_key).toBe('pre-notice-job-456-cust-123-1700000000000');
  });

  it('renders the plain-text body into branded HTML and escapes HTML metachars', () => {
    const p = buildPreNotificationEmailPayload({ ...base, body: 'A & B <tag>' });
    expect(p.html).toContain('A &amp; B &lt;tag&gt;');
    // branded wrapper present
    expect(p.html).toContain('Crop RX Solutions');
  });

  it('has no attachments (pre-notice is body-only)', () => {
    const p = buildPreNotificationEmailPayload(base);
    expect(p.attachments).toBeUndefined();
  });
});
