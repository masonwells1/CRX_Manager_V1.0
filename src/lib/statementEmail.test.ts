import { describe, expect, it } from 'vitest';
import type { DetailedStatementData } from '../types';
import { getStatementAccountPosition } from './statementBalance';
import { buildStatementEmailContent } from './statementEmail';

const statement = {
  customer: {
    id: 'customer-1',
    farm_name: 'Example Farms',
    contact_name: null,
    account_number: 'A-1',
    email: 'office@example.test',
    phone: null,
    billing_address: null,
    city: null,
    state: null,
    zip: null,
    payment_terms: 'Net 30',
  },
  transactions: [{ invoice_number: 'INV-1' }],
  aging: {
    current_cents: 10_000,
    days_30_cents: 0,
    days_60_cents: 0,
    days_90_cents: 0,
    over_120_cents: 0,
  },
  outstanding_balance_cents: 10_000,
  open_credit_cents: 2_500,
  net_account_position_cents: 7_500,
  as_of_date: '2026-08-03',
  mode: 'summary',
} as DetailedStatementData;

describe('statement email account position', () => {
  it('keeps gross invoices separate from unapplied credits', () => {
    expect(getStatementAccountPosition(statement)).toEqual({
      grossOpenInvoiceCents: 10_000,
      openCreditCents: 2_500,
      netAccountPositionCents: 7_500,
    });

    const html = buildStatementEmailContent(statement, '2026-08-03');
    expect(html).toContain('Gross Open Invoices');
    expect(html).toContain('Unapplied Credits');
    expect(html).toContain('Net Account Position');
    expect(html).toContain('$100.00');
    expect(html).toContain('$25.00');
    expect(html).toContain('$75.00');
    expect(html).not.toContain('Balance Due');
  });

  it('fails closed while frontend and RPC versions overlap during rollout', () => {
    const legacyPayload = {
      ...statement,
      open_credit_cents: undefined,
      net_account_position_cents: undefined,
    } as unknown as DetailedStatementData;

    expect(() => getStatementAccountPosition(legacyPayload)).toThrow(
      'Statement generation is temporarily unavailable because the database balance disclosure is not ready.',
    );
    expect(() => buildStatementEmailContent(legacyPayload, '2026-08-03')).toThrow(
      'Statement generation is temporarily unavailable because the database balance disclosure is not ready.',
    );
  });

  it('does not request payment when unapplied credits cover the gross invoices', () => {
    const creditPosition = {
      ...statement,
      open_credit_cents: 12_500,
      net_account_position_cents: -2_500,
    };

    const html = buildStatementEmailContent(creditPosition, '2026-08-03');
    expect(html).not.toContain('Please remit payment');
    expect(html).toContain('unapplied credits equal or exceed');
    expect(html).toContain('contact Crop RX before sending payment');
  });

  it('does not request payment when credits exactly cover the gross invoices', () => {
    const exactCredit = {
      ...statement,
      open_credit_cents: 10_000,
      net_account_position_cents: 0,
    };

    const html = buildStatementEmailContent(exactCredit, '2026-08-03');
    expect(html).not.toContain('Please remit payment');
    expect(html).toContain('contact Crop RX before sending payment');
  });

  it('escapes customer and date text before inserting it into email HTML', () => {
    const unsafeText = {
      ...statement,
      customer: {
        ...statement.customer,
        farm_name: '<script>alert("farm")</script> & Sons',
      },
    };

    const html = buildStatementEmailContent(unsafeText, '08/03/2026 & final');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;farm&quot;)&lt;/script&gt; &amp; Sons');
    expect(html).toContain('08/03/2026 &amp; final');
  });
});
