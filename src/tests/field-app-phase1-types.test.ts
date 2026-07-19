/**
 * Type safety net for Field Application Workflow Phase 1 (2026-04-29).
 *
 * Phase 1 reshaped two RPCs (return type uuid → jsonb on
 * create_invoice_from_blend_ticket; +1 arg on save_field_app_invoice)
 * and added two new RPCs (post_invoice_group, preview_field_app_invoice_split).
 *
 * If anyone deletes a field from one of these result types — or the
 * underlying TS interface drifts away from what the migration actually
 * returns — these compile-time Pick<> assertions will fail and the test
 * will not build. Runtime expect()s exist only so vitest treats this as
 * a real test file.
 *
 * See: supabase/migrations/20260429140635_field_app_workflow_phase1.sql
 */
import { describe, it, expect } from 'vitest';
import type {
  Invoice,
  BlendTicket,
  FieldAppLocation,
  FieldAppLocationShare,
  DeriveCustomerSharesRow,
  DeriveCustomerSharesCustomer,
  DeriveCustomerSharesResult,
  FieldAppInvoiceResult,
  PostInvoiceGroupResult,
  PreviewFieldAppSplitLine,
  PreviewFieldAppSplitCustomer,
  PreviewFieldAppSplitResult,
} from '../types/index';

describe('Field App Phase 1 — type contract', () => {
  it('Invoice carries Phase 1 grouping columns (invoice_group_id, application_service_id)', () => {
    const sample: Pick<Invoice, 'invoice_group_id' | 'application_service_id'> = {
      invoice_group_id: 'group-uuid',
      application_service_id: 'svc-uuid',
    };
    expect(sample.invoice_group_id).toBe('group-uuid');
    expect(sample.application_service_id).toBe('svc-uuid');
  });

  it('BlendTicket carries application_service_id (drives Mode-B service fee)', () => {
    const sample: Pick<BlendTicket, 'application_service_id'> = {
      application_service_id: 'svc-uuid',
    };
    expect(sample.application_service_id).toBe('svc-uuid');
  });

  it('FieldAppLocation can be parented by group (invoice_group_id) instead of invoice_id', () => {
    const sample: Pick<FieldAppLocation, 'invoice_id' | 'invoice_group_id' | 'job_id'> = {
      invoice_id: null,
      invoice_group_id: 'group-uuid',
      job_id: null,
    };
    expect(sample.invoice_group_id).toBe('group-uuid');
    expect(sample.invoice_id).toBeNull();
  });

  it('FieldAppLocationShare carries the TRUE per-customer split (split_pct, acres)', () => {
    const sample: Pick<FieldAppLocationShare, 'location_id' | 'customer_id' | 'split_pct' | 'acres'> = {
      location_id: 'loc-uuid',
      customer_id: 'cust-uuid',
      split_pct: 60,
      acres: 30,
    };
    expect(sample.split_pct).toBe(60);
  });

  it('DeriveCustomerSharesRow exposes per-field per-customer detail with override + fallback flags', () => {
    const sample: DeriveCustomerSharesRow = {
      field_id: 'field-uuid',
      field_name: 'North 40',
      customer_id: 'cust-uuid',
      customer_name: 'Farm Alpha',
      is_primary: true,
      split_pct: 60,
      share_acres: 30,
      price_override_cents: 2000,
      pricing_note: 'verbal agreement',
      tier: 1,
      field_total_acres: 50,
      field_applied_acres: 50,
      used_fallback: false,
    };
    expect(sample.price_override_cents).toBe(2000);
    expect(sample.used_fallback).toBe(false);
  });

  it('DeriveCustomerSharesCustomer aggregates across fields with has_override flag', () => {
    const sample: DeriveCustomerSharesCustomer = {
      customer_id: 'cust-uuid',
      customer_name: 'Farm Alpha',
      is_primary: true,
      total_share_acres: 30,
      overall_split_pct: 60,
      tier: 1,
      has_override: true,
    };
    expect(sample.has_override).toBe(true);
  });

  it('DeriveCustomerSharesResult exposes top-level rows + customers + fallback_used_field_ids', () => {
    const sample: DeriveCustomerSharesResult = {
      rows: [],
      customers: [],
      total_applied_acres: 50,
      field_count: 1,
      fallback_used_field_ids: [],
    };
    expect(sample.field_count).toBe(1);
    expect(Array.isArray(sample.fallback_used_field_ids)).toBe(true);
  });

  it('FieldAppInvoiceResult is the unified shape returned by save_field_app_invoice AND create_invoice_from_blend_ticket', () => {
    const single: FieldAppInvoiceResult = { invoice_ids: ['inv-1'], invoice_group_id: null };
    const grouped: FieldAppInvoiceResult = { invoice_ids: ['inv-1', 'inv-2'], invoice_group_id: 'group-uuid' };
    expect(single.invoice_group_id).toBeNull();
    expect(grouped.invoice_ids).toHaveLength(2);
    expect(grouped.invoice_group_id).toBe('group-uuid');
  });

  it('PostInvoiceGroupResult includes posted_invoice_ids, total_posted_cents, member_count', () => {
    const sample: PostInvoiceGroupResult = {
      posted_invoice_ids: ['inv-1', 'inv-2'],
      invoice_group_id: 'group-uuid',
      total_posted_cents: 250000,
      member_count: 2,
    };
    expect(sample.member_count).toBe(2);
    expect(sample.total_posted_cents).toBe(250000);
  });

  it('PreviewFieldAppSplitLine.kind includes every server-emitted billing line kind', () => {
    const kinds: PreviewFieldAppSplitLine['kind'][] = [
      'grower_share',
      'chemical',
      'service_fee',
      'fuel_surcharge',
      'flat_fee',
    ];
    expect(kinds).toHaveLength(5);
  });

  it('PreviewFieldAppSplitCustomer aggregates lines + total_cents per customer', () => {
    const sample: PreviewFieldAppSplitCustomer = {
      customer_id: 'cust-uuid',
      customer_name: 'Farm Alpha',
      is_primary: true,
      tier: 1,
      total_cents: 100000,
      lines: [],
    };
    expect(sample.total_cents).toBe(100000);
  });

  it('PreviewFieldAppSplitResult exposes per_customer + grand_total_cents + shares_detail', () => {
    const sample: PreviewFieldAppSplitResult = {
      per_customer: [],
      grand_total_cents: 0,
      customer_count: 0,
      shares_detail: {
        rows: [],
        customers: [],
        total_applied_acres: 0,
        field_count: 0,
        fallback_used_field_ids: [],
      },
    };
    expect(sample.grand_total_cents).toBe(0);
    expect(sample.shares_detail.rows).toEqual([]);
  });
});
