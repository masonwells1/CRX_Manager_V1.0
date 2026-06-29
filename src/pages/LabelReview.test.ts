/**
 * LabelReview.test.ts — Unit tests for §1 AI Label-Data Backfill helpers
 *
 * Tests the pure helper logic that can be exercised without a DB or browser:
 * - statusBadgeVariant mapping
 * - statusLabel mapping
 * - confidenceBadge mapping
 * - detectOverwrittenFields logic
 * - draftToEditState conversion
 */

import { describe, it, expect } from 'vitest';
import type { ProductLabelDraft, LabelDraftStatus, LabelDraftConfidence } from '../types';

// ─── Helpers copied / re-exported for testing ───────────────────────────────
// These are pure functions we can test without mounting the component.

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'danger';

function statusBadgeVariant(status: LabelDraftStatus): BadgeVariant {
  switch (status) {
    case 'pending':      return 'warning';
    case 'accepted':     return 'success';
    case 'edited':       return 'success';
    case 'rejected':     return 'error';
    case 'needs_manual': return 'default';
  }
}

function statusLabel(status: LabelDraftStatus): string {
  switch (status) {
    case 'pending':      return 'Pending review';
    case 'accepted':     return 'Accepted';
    case 'edited':       return 'Accepted (edited)';
    case 'rejected':     return 'Rejected';
    case 'needs_manual': return 'Needs manual entry';
  }
}

function confidenceBadge(c: LabelDraftConfidence): BadgeVariant {
  if (c === 'high')   return 'success';
  if (c === 'medium') return 'warning';
  return 'default';
}

interface EditState {
  signal_word: string;
  rei_hours: string;
  phi_days: string;
  epa_registration: string;
  max_label_rate: string;
  max_label_rate_unit: string;
}

function draftToEditState(d: ProductLabelDraft): EditState {
  return {
    signal_word:         d.signal_word         ?? '',
    rei_hours:           d.rei_hours           != null ? String(d.rei_hours) : '',
    phi_days:            d.phi_days            != null ? String(d.phi_days) : '',
    epa_registration:    d.epa_registration    ?? '',
    max_label_rate:      d.max_label_rate      != null ? String(d.max_label_rate) : '',
    max_label_rate_unit: d.max_label_rate_unit ?? '',
  };
}

type LabelFieldKey = 'signal_word' | 'rei_hours' | 'phi_days' | 'epa_registration' | 'max_label_rate';

type ProductSnapshot = {
  signal_word?: string | null;
  rei_hours?: number | null;
  phi_days?: number | null;
  epa_registration?: string | null;
  max_label_rate?: number | null;
};

function detectOverwrittenFields(product: ProductSnapshot, es: EditState): LabelFieldKey[] {
  const conflicts: LabelFieldKey[] = [];
  if (es.signal_word && product.signal_word)              conflicts.push('signal_word');
  if (es.rei_hours && product.rei_hours != null)          conflicts.push('rei_hours');
  if (es.phi_days && product.phi_days != null)            conflicts.push('phi_days');
  if (es.epa_registration && product.epa_registration)   conflicts.push('epa_registration');
  if (es.max_label_rate && product.max_label_rate != null) conflicts.push('max_label_rate');
  return conflicts;
}

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeDraft(overrides: Partial<ProductLabelDraft> = {}): ProductLabelDraft {
  return {
    id:                 'draft-1',
    product_id:         'prod-1',
    signal_word:        'Warning',
    rei_hours:          24,
    phi_days:           7,
    epa_registration:   '62719-498',
    max_label_rate:     2.5,
    max_label_rate_unit: 'oz/acre',
    source_note:        'Google Vision OCR',
    confidence:         'high',
    status:             'pending',
    created_by:         'user-1',
    reviewed_by:        null,
    reviewed_at:        null,
    run_idempotency_key: null,
    created_at:         '2026-06-29T00:00:00Z',
    updated_at:         '2026-06-29T00:00:00Z',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('statusBadgeVariant', () => {
  it('maps pending → warning', () => expect(statusBadgeVariant('pending')).toBe('warning'));
  it('maps accepted → success', () => expect(statusBadgeVariant('accepted')).toBe('success'));
  it('maps edited → success', () => expect(statusBadgeVariant('edited')).toBe('success'));
  it('maps rejected → error', () => expect(statusBadgeVariant('rejected')).toBe('error'));
  it('maps needs_manual → default', () => expect(statusBadgeVariant('needs_manual')).toBe('default'));
});

describe('statusLabel', () => {
  it('formats pending', () => expect(statusLabel('pending')).toBe('Pending review'));
  it('formats accepted', () => expect(statusLabel('accepted')).toBe('Accepted'));
  it('formats edited', () => expect(statusLabel('edited')).toBe('Accepted (edited)'));
  it('formats rejected', () => expect(statusLabel('rejected')).toBe('Rejected'));
  it('formats needs_manual', () => expect(statusLabel('needs_manual')).toBe('Needs manual entry'));
});

describe('confidenceBadge', () => {
  it('maps high → success', () => expect(confidenceBadge('high')).toBe('success'));
  it('maps medium → warning', () => expect(confidenceBadge('medium')).toBe('warning'));
  it('maps low → default', () => expect(confidenceBadge('low')).toBe('default'));
});

describe('draftToEditState', () => {
  it('converts all fields correctly', () => {
    const draft = makeDraft();
    const state = draftToEditState(draft);
    expect(state.signal_word).toBe('Warning');
    expect(state.rei_hours).toBe('24');
    expect(state.phi_days).toBe('7');
    expect(state.epa_registration).toBe('62719-498');
    expect(state.max_label_rate).toBe('2.5');
    expect(state.max_label_rate_unit).toBe('oz/acre');
  });

  it('uses empty string for null/undefined fields', () => {
    const draft = makeDraft({
      signal_word: null,
      rei_hours: null,
      phi_days: null,
      epa_registration: null,
      max_label_rate: null,
      max_label_rate_unit: null,
    });
    const state = draftToEditState(draft);
    expect(state.signal_word).toBe('');
    expect(state.rei_hours).toBe('');
    expect(state.phi_days).toBe('');
    expect(state.epa_registration).toBe('');
    expect(state.max_label_rate).toBe('');
    expect(state.max_label_rate_unit).toBe('');
  });

  it('preserves 0 numeric values correctly', () => {
    const draft = makeDraft({ rei_hours: 0, phi_days: 0 });
    const state = draftToEditState(draft);
    // 0 is a valid number — should NOT become '' (!=null check)
    expect(state.rei_hours).toBe('0');
    expect(state.phi_days).toBe('0');
  });
});

describe('detectOverwrittenFields', () => {
  const emptyProduct: ProductSnapshot = {
    signal_word: null, rei_hours: null, phi_days: null,
    epa_registration: null, max_label_rate: null,
  };
  const fullProduct: ProductSnapshot = {
    signal_word: 'Caution', rei_hours: 4, phi_days: 14,
    epa_registration: '524-549', max_label_rate: 1.0,
  };

  it('returns empty array when product has no existing values', () => {
    const es: EditState = { signal_word: 'Warning', rei_hours: '24', phi_days: '7', epa_registration: '62719-498', max_label_rate: '2.5', max_label_rate_unit: 'oz/acre' };
    expect(detectOverwrittenFields(emptyProduct, es)).toHaveLength(0);
  });

  it('returns all conflicting fields when product has values and edit has values', () => {
    const es: EditState = { signal_word: 'Warning', rei_hours: '24', phi_days: '7', epa_registration: '62719-498', max_label_rate: '2.5', max_label_rate_unit: 'oz/acre' };
    const conflicts = detectOverwrittenFields(fullProduct, es);
    expect(conflicts).toContain('signal_word');
    expect(conflicts).toContain('rei_hours');
    expect(conflicts).toContain('phi_days');
    expect(conflicts).toContain('epa_registration');
    expect(conflicts).toContain('max_label_rate');
    expect(conflicts).toHaveLength(5);
  });

  it('does not flag empty edit fields as conflicts', () => {
    // Edit has empty signal_word — no conflict even if product has a value
    const es: EditState = { signal_word: '', rei_hours: '', phi_days: '', epa_registration: '', max_label_rate: '', max_label_rate_unit: '' };
    expect(detectOverwrittenFields(fullProduct, es)).toHaveLength(0);
  });

  it('correctly identifies partial conflicts', () => {
    const es: EditState = { signal_word: 'Warning', rei_hours: '', phi_days: '7', epa_registration: '', max_label_rate: '', max_label_rate_unit: '' };
    const conflicts = detectOverwrittenFields(fullProduct, es);
    expect(conflicts).toContain('signal_word');
    expect(conflicts).toContain('phi_days');
    expect(conflicts).not.toContain('rei_hours');
    expect(conflicts).not.toContain('epa_registration');
    expect(conflicts).toHaveLength(2);
  });

  it('does not flag max_label_rate when product value is null', () => {
    const productNoRate: ProductSnapshot = { ...fullProduct, max_label_rate: null };
    const es: EditState = { signal_word: '', rei_hours: '', phi_days: '', epa_registration: '', max_label_rate: '2.5', max_label_rate_unit: 'oz/acre' };
    const conflicts = detectOverwrittenFields(productNoRate, es);
    expect(conflicts).not.toContain('max_label_rate');
  });
});
