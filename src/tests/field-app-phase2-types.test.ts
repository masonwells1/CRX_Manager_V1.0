/**
 * Type safety net for Field Application Workflow Phase 2 (2026-04-30) — Job Lifecycle Repair.
 *
 * Phase 2 added the start_job() RPC, rewrote complete_job() to write per-field
 * application_record_fields rows, and reverted jobs.customer_id to NOT NULL.
 * Compile-time Pick<> assertions on the new shapes catch drift; runtime expects
 * exist so vitest treats this as a real test file.
 *
 * See: supabase/migrations/20260430150000_field_app_workflow_phase2.sql
 */

import { describe, it, expect } from 'vitest';
import type {
  Job,
  ApplicationRecord,
  ApplicationRecordField,
  StartJobResult,
  CompleteJobResult,
} from '../types/index';

describe('Field App Phase 2 — type contract', () => {
  it('Job.customer_id stays string (NOT NULL revert is back-compat at the type level)', () => {
    const sample: Pick<Job, 'customer_id' | 'status'> = {
      customer_id: 'cust-uuid',
      status: 'in_progress',
    };
    expect(sample.customer_id).toBe('cust-uuid');
    expect(sample.status).toBe('in_progress');
  });

  it('ApplicationRecord.field_id is now nullable (legacy single-field anchor)', () => {
    const sample: Pick<ApplicationRecord, 'field_id'> = { field_id: null };
    expect(sample.field_id).toBeNull();
  });

  it('ApplicationRecord exposes joined application_record_fields[] for multi-field display', () => {
    const sample: Pick<ApplicationRecord, 'application_record_fields'> = {
      application_record_fields: [],
    };
    expect(Array.isArray(sample.application_record_fields)).toBe(true);
  });

  it('ApplicationRecordField has the join table shape (record_id + field_id + acres)', () => {
    const sample: ApplicationRecordField = {
      id: 'arf-1',
      application_record_id: 'rec-1',
      field_id: 'field-1',
      acres: 30,
      sort_order: 0,
      created_at: '2026-04-30T00:00:00Z',
    };
    expect(sample.acres).toBe(30);
    expect(sample.application_record_id).toBe('rec-1');
  });

  it('StartJobResult shape includes status="in_progress" and already_started flag', () => {
    const fresh: StartJobResult = {
      job_id: 'job-1',
      status: 'in_progress',
      started_at: '2026-04-30T10:00:00Z',
      already_started: false,
    };
    const replay: StartJobResult = {
      job_id: 'job-1',
      status: 'in_progress',
      started_at: '2026-04-30T10:00:00Z',
      already_started: true,
    };
    expect(fresh.already_started).toBe(false);
    expect(replay.already_started).toBe(true);
  });

  it('CompleteJobResult includes field_count and short_stock_count', () => {
    const sample: CompleteJobResult = {
      success: true,
      job_id: 'job-1',
      application_record_id: 'rec-1',
      record_number: 'AR-0042',
      field_count: 3,
      short_stock_count: 0,
    };
    expect(sample.field_count).toBe(3);
    expect(sample.short_stock_count).toBe(0);
  });
});
