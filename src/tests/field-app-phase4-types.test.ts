/**
 * Type safety net for Field Application Workflow Phase 4 (2026-04-30) — Application Service Fees.
 *
 * Phase 4 added jobs.application_service_id and compute_application_service_fee().
 * See: supabase/migrations/20260430170000_field_app_workflow_phase4.sql
 */

import { describe, it, expect } from 'vitest';
import type { Job, ComputeApplicationServiceFeeResult } from '../types/index';

describe('Field App Phase 4 — type contract', () => {
  it('Job carries application_service_id for fee carry-forward to invoice', () => {
    const sample: Pick<Job, 'application_service_id'> = {
      application_service_id: 'svc-uuid',
    };
    expect(sample.application_service_id).toBe('svc-uuid');
  });

  it('Job.application_service_id is nullable (jobs without a service have null)', () => {
    const sample: Pick<Job, 'application_service_id'> = {
      application_service_id: null,
    };
    expect(sample.application_service_id).toBeNull();
  });

  it('ComputeApplicationServiceFeeResult exposes rate, totals, and source provenance', () => {
    const sample: ComputeApplicationServiceFeeResult = {
      rate_per_acre_cents: 1500,
      total_fee_cents: 75000,
      cost_per_acre_cents: 800,
      total_cost_cents: 40000,
      source: 'customer_override',
      service_name: 'Hagie Y-Drop',
    };
    expect(sample.rate_per_acre_cents).toBe(1500);
    expect(sample.source).toBe('customer_override');
  });

  it('source field is the closed union { customer_override | service_default | inactive | none }', () => {
    const sources: ComputeApplicationServiceFeeResult['source'][] = [
      'customer_override',
      'service_default',
      'inactive',
      'none',
    ];
    expect(sources).toHaveLength(4);
  });

  it('zero-fee shape (no service / inactive) returns 0s with appropriate source', () => {
    const noService: ComputeApplicationServiceFeeResult = {
      rate_per_acre_cents: 0,
      total_fee_cents: 0,
      cost_per_acre_cents: 0,
      total_cost_cents: 0,
      source: 'none',
      service_name: null,
    };
    expect(noService.total_fee_cents).toBe(0);
    expect(noService.service_name).toBeNull();
  });
});
