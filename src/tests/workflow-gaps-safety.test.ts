/**
 * Safety-net tests for Workflow Gaps Remediation
 * Verifies that new columns/fields exist in TypeScript types
 */
import { describe, it, expect } from 'vitest';
import type {
  BlendTicketProduct,
  BlendTicket,
  QuoteSection,
  Invoice,
  Job,
} from '../types/index';

describe('Workflow Gaps — Type Safety', () => {
  it('BlendTicketProduct has cost/price snapshot columns (B3)', () => {
    const sample: Pick<BlendTicketProduct, 'unit_cost_cents' | 'unit_price_cents'> = {
      unit_cost_cents: 1500,
      unit_price_cents: 3000,
    };
    expect(sample.unit_cost_cents).toBe(1500);
    expect(sample.unit_price_cents).toBe(3000);
  });

  it('BlendTicket has job_id FK column (B6)', () => {
    const sample: Pick<BlendTicket, 'job_id'> = {
      job_id: 'some-uuid',
    };
    expect(sample.job_id).toBe('some-uuid');
  });

  it('QuoteSection has field_id column (Pillar 2)', () => {
    const sample: Pick<QuoteSection, 'field_id'> = {
      field_id: 'field-uuid',
    };
    expect(sample.field_id).toBe('field-uuid');
  });

  it('Invoice has invoice_group_id column (Pillar 2)', () => {
    const sample: Pick<Invoice, 'invoice_group_id'> = {
      invoice_group_id: 'group-uuid',
    };
    expect(sample.invoice_group_id).toBe('group-uuid');
  });

  it('Job has priority and estimated_hours columns (Pillar 3)', () => {
    const sample: Pick<Job, 'priority' | 'estimated_hours'> = {
      priority: 'high',
      estimated_hours: 2.5,
    };
    expect(sample.priority).toBe('high');
    expect(sample.estimated_hours).toBe(2.5);
  });

  it('Job priority allows all 4 values', () => {
    const priorities: Job['priority'][] = ['low', 'normal', 'high', 'urgent'];
    expect(priorities).toHaveLength(4);
  });
});
