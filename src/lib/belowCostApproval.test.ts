import { describe, expect, it } from 'vitest';
import {
  parseBelowCostApprovalError,
  stripBelowCostApprovalNote,
  withBelowCostReason,
} from './belowCostApproval';

const detail = {
  operation: 'save_invoice',
  entity_type: 'invoice',
  entity_id: 'invoice-1',
  line_id: 'line-1',
  product_id: 'product-1',
  product_name: 'Atrazine 4L',
  unit_price_cents: 1050,
  locked_unit_cost_cents: 1225,
};

describe('parseBelowCostApprovalError', () => {
  it.each([
    ['BELOW_COST_CONTEXT_REQUIRED', 'context'],
    ['BELOW_COST_ADMIN_REQUIRED', 'admin'],
    ['BELOW_COST_REASON_REQUIRED', 'reason'],
  ] as const)('parses %s from a Supabase RPC error', (prefix, kind) => {
    expect(parseBelowCostApprovalError({
      code: 'P0001',
      message: `${prefix}:${JSON.stringify(detail)}`,
    })).toEqual({ kind, detail });
  });

  it('parses a thrown Error', () => {
    expect(parseBelowCostApprovalError(new Error(
      `BELOW_COST_REASON_REQUIRED:${JSON.stringify(detail)}`,
    ))).toEqual({ kind: 'reason', detail });
  });

  it('fails soft when the JSON detail is truncated or malformed', () => {
    expect(parseBelowCostApprovalError({
      message: 'BELOW_COST_REASON_REQUIRED:{"product_name":"Atrazine',
    })).toEqual({ kind: 'reason', detail: null });
  });

  it('returns null for unrelated errors', () => {
    expect(parseBelowCostApprovalError({ message: 'QUOTE_STALE_WRITE' })).toBeNull();
    expect(parseBelowCostApprovalError(null)).toBeNull();
  });
});

describe('withBelowCostReason', () => {
  it('uses the exact wrapper-specific reason transport', () => {
    expect(withBelowCostReason('create_direct_order', { p_notes: 'Deliver south' }, ' price match '))
      .toEqual({ p_notes: 'Deliver south\nBelow-cost approved: price match' });
    expect(withBelowCostReason('update_order_items', { p_items: [{ id: 'line-1' }] }, 'approved'))
      .toEqual({ p_items: [{ id: 'line-1', below_cost_reason: 'approved' }] });
    expect(withBelowCostReason('save_quote', { p_sections: [{ section_name: 'A' }] }, 'approved'))
      .toEqual({ p_sections: [{ section_name: 'A', below_cost_reason: 'approved' }] });
    expect(withBelowCostReason('duplicate_quote', { p_source_quote_id: 'quote-1' }, 'approved'))
      .toEqual({ p_source_quote_id: 'quote-1', p_below_cost_reason: 'approved' });
  });

  it.each([
    'convert_quote_to_order',
    'draw_down_quote',
    'restore_quote_version',
    'duplicate_quote',
  ] as const)('sends an explicit null reason to the governed %s wrapper', (operation) => {
    expect(withBelowCostReason(operation, { p_id: 'entity-1' }, null))
      .toEqual({ p_id: 'entity-1', p_below_cost_reason: null });
  });

  it('marks JSON payloads as a fresh reasonless attempt', () => {
    expect(withBelowCostReason('save_invoice', {
      p_items: [{ id: 'line-1', notes: 'Below-cost approved: old price match' }],
    }, null)).toEqual({
      p_items: [{
        id: 'line-1',
        notes: 'Below-cost approved: old price match',
        below_cost_reason: null,
      }],
    });
    expect(withBelowCostReason('save_quote', {
      p_sections: [{ section_name: 'A', items: [{ notes: 'Below-cost approved: old quote' }] }],
    }, null)).toEqual({
      p_sections: [{
        section_name: 'A',
        items: [{ notes: 'Below-cost approved: old quote' }],
        below_cost_reason: null,
      }],
    });
  });

  it.each([
    'create_direct_order',
    'bulk_import_order',
  ] as const)('strips a persisted note marker before the reasonless %s attempt', (operation) => {
    expect(withBelowCostReason(operation, {
      p_notes: 'Deliver south\nBelow-cost approved: old price match',
    }, null)).toEqual({ p_notes: 'Deliver south' });
  });

  it('strips the internal order-note marker from customer output', () => {
    expect(stripBelowCostApprovalNote('Deliver south\nBelow-cost approved: price match'))
      .toBe('Deliver south');
  });
});
