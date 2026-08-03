import { describe, expect, it } from 'vitest';
import type { DetailedStatementData } from '../types';
import { generateStatementPdf } from './statementPdf';

const renderedStatement: DetailedStatementData = {
  customer: {
    id: 'customer-render',
    farm_name: 'Rendered Example Farms',
    contact_name: null,
    account_number: 'RENDER-1',
    email: null,
    phone: null,
    billing_address: '1 Test Lane',
    city: 'Olney',
    state: 'IL',
    zip: '62450',
    payment_terms: 'Net 30',
  },
  transactions: [
    {
      invoice_number: 'INV-RENDER-1',
      invoice_date: '2026-08-01',
      due_date: '2026-08-31',
      invoice_type: 'chemical_sale',
      status: 'posted',
      days_aged: 2,
      description: 'Chemical Sale',
      crop_type: null,
      field_names: null,
      total_acres: null,
      grower_names: null,
      total_amount_cents: 10_000,
      paid_amount_cents: 0,
      prepay_applied_cents: 0,
      balance_cents: 10_000,
      items: [],
      shares: [],
      finance_charge_cents: 0,
      net_due_cents: 10_000,
      price_per_acre: null,
    },
  ],
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
};

describe('statement PDF real renderer', () => {
  it('fails closed when the live RPC has not deployed balance disclosure fields', async () => {
    const legacyPayload = {
      ...renderedStatement,
      open_credit_cents: undefined,
      net_account_position_cents: undefined,
    } as unknown as DetailedStatementData;

    await expect(generateStatementPdf(legacyPayload)).rejects.toThrow(
      'Statement generation is temporarily unavailable because the database balance disclosure is not ready.',
    );
  });

  it('renders a non-empty PDF with separate gross, credit, and net labels', async () => {
    const doc = await generateStatementPdf(renderedStatement);
    const pdfBytes = doc.output('arraybuffer');
    const pageCommands = doc.internal.pages.flat().join('\n');

    expect(pdfBytes.byteLength).toBeGreaterThan(2_000);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    expect(doc.getNumberOfPages()).toBe(1);
    expect(pageCommands).toContain('GROSS OPEN INVOICES');
    expect(pageCommands).toContain('Unapplied Credits:');
    expect(pageCommands).toContain('Net Account Position:');
    expect(pageCommands).toContain('PLEASE MAIL WITH PAYMENT TO:');
    expect(pageCommands).toContain('Amount Paid  $');
    expect(pageCommands).toContain('9100 E 2000th Ave');
    expect(pageCommands).not.toContain('CONTACT CROP RX BEFORE PAYMENT:');
    expect(pageCommands).toContain('CUT HERE');
    expect(pageCommands).toContain('Page 1');
    expect(pageCommands).not.toContain('Page 2');
  });

  it('moves the complete account-position block to a new page near the footer boundary', async () => {
    const crowdedStatement = {
      ...renderedStatement,
      transactions: Array.from({ length: 21 }, (_, index) => ({
        ...renderedStatement.transactions[0],
        invoice_number: `INV-RENDER-${index + 1}`,
      })),
    };

    const doc = await generateStatementPdf(crowdedStatement);
    const pages = doc.internal.pages as unknown as string[][];
    const firstPageCommands = pages[1].join('\n');
    const secondPageCommands = pages[2].join('\n');

    expect(doc.getNumberOfPages()).toBe(2);
    expect(firstPageCommands).not.toContain('Net Account Position:');
    expect(secondPageCommands).toContain('Gross Open Invoices:');
    expect(secondPageCommands).toContain('Unapplied Credits:');
    expect(secondPageCommands).toContain('Net Account Position:');
    expect(secondPageCommands).toContain('Page 2');
  });

  it('replaces remittance instructions when credits cover the gross invoices', async () => {
    const creditCoveredStatement = {
      ...renderedStatement,
      open_credit_cents: 12_500,
      net_account_position_cents: -2_500,
    };

    const doc = await generateStatementPdf(creditCoveredStatement);
    const pageCommands = doc.internal.pages.flat().join('\n');

    expect(pageCommands).not.toContain('PLEASE MAIL WITH PAYMENT TO:');
    expect(pageCommands).not.toContain('Amount Paid  $');
    expect(pageCommands).toContain('CONTACT CROP RX BEFORE PAYMENT:');
    expect(pageCommands).toContain('Credits cover open invoices.');
    expect(pageCommands).toContain('Call before sending payment.');
    expect(pageCommands).toContain('Phone: 618-843-0413');
    expect(pageCommands).toContain('Website: www.croprxsolutions.com');
    expect(pageCommands).not.toContain('9100 E 2000th Ave');
  });

  it('suppresses remittance instructions when credits exactly cover gross invoices', async () => {
    const zeroBalanceStatement = {
      ...renderedStatement,
      open_credit_cents: 10_000,
      net_account_position_cents: 0,
    };

    const doc = await generateStatementPdf(zeroBalanceStatement);
    const pageCommands = doc.internal.pages.flat().join('\n');

    expect(pageCommands).not.toContain('PLEASE MAIL WITH PAYMENT TO:');
    expect(pageCommands).not.toContain('Amount Paid  $');
    expect(pageCommands).not.toContain('9100 E 2000th Ave');
    expect(pageCommands).toContain('CONTACT CROP RX BEFORE PAYMENT:');
    expect(pageCommands).toContain('Phone: 618-843-0413');
    expect(pageCommands).toContain('Website: www.croprxsolutions.com');
  });
});
