import { describe, it, expect } from 'vitest';
import {
  BELOW_COST_APPROVAL_PREFIX,
  appendBelowCostApproval,
  stripInternalNotes,
} from './internalNotes';

describe('appendBelowCostApproval', () => {
  it('appends the marker below existing notes', () => {
    expect(appendBelowCostApproval('Deliver to the south shed', 'matched competitor')).toBe(
      'Deliver to the south shed\nBelow-cost approved: matched competitor'
    );
  });

  it('produces the marker alone when there are no existing notes', () => {
    expect(appendBelowCostApproval(null, 'clearance')).toBe('Below-cost approved: clearance');
    expect(appendBelowCostApproval('   ', 'clearance')).toBe('Below-cost approved: clearance');
  });

  it('uses the shared prefix so the stripper cannot drift', () => {
    expect(appendBelowCostApproval(null, 'x').startsWith(BELOW_COST_APPROVAL_PREFIX)).toBe(true);
  });

  it('replaces a prior approval reason while preserving notes on both sides', () => {
    const prior = `Gate code 4412\n${BELOW_COST_APPROVAL_PREFIX} old clearance\nDeliver Tuesday`;
    expect(appendBelowCostApproval(prior, 'fresh price match')).toBe(
      `Gate code 4412\nDeliver Tuesday\n${BELOW_COST_APPROVAL_PREFIX} fresh price match`
    );
  });
});

describe('stripInternalNotes', () => {
  it('removes the approval reason and keeps the customer-visible remainder', () => {
    const notes = appendBelowCostApproval('Deliver to the south shed', 'goodwill after spray complaint');
    expect(stripInternalNotes(notes)).toBe('Deliver to the south shed');
  });

  it('returns null when the approval reason was the only content', () => {
    expect(stripInternalNotes(appendBelowCostApproval(null, 'matched Helena'))).toBeNull();
  });

  it('strips the em-dash separated form written by the bulk import path', () => {
    const notes = "Spring prepay — Below-cost approved: price match";
    expect(stripInternalNotes(notes)).toBe('Spring prepay');
  });

  // Codex round 8: swapping the backtracking regex for a character class only
  // strips the TRAILING separator, so the .trim() has to stay or an operator's
  // leading whitespace reaches the customer document.
  it('trims whitespace surrounding the visible notes', () => {
    const notes = `  Gate code 4412  \n${BELOW_COST_APPROVAL_PREFIX} clearance`;
    expect(stripInternalNotes(notes)).toBe('Gate code 4412');
  });

  it('returns null when only whitespace precedes the marker', () => {
    expect(stripInternalNotes(`   \n\t${BELOW_COST_APPROVAL_PREFIX} clearance`)).toBeNull();
  });

  it('passes ordinary notes through unchanged', () => {
    expect(stripInternalNotes('Call before delivery')).toBe('Call before delivery');
  });

  it('handles null and empty input', () => {
    expect(stripInternalNotes(null)).toBeNull();
    expect(stripInternalNotes(undefined)).toBeNull();
    expect(stripInternalNotes('')).toBeNull();
    expect(stripInternalNotes('   ')).toBeNull();
  });

  it('keeps multiple customer-visible lines while dropping only the marker', () => {
    const notes = `Gate code 4412\nDeliver Tuesday\n${BELOW_COST_APPROVAL_PREFIX} clearance`;
    expect(stripInternalNotes(notes)).toBe('Gate code 4412\nDeliver Tuesday');
  });

  // The reason is free-form textarea input, so it can carry its own newlines
  // and em dashes. Every character from the marker onward must go.
  it('removes a multi-line reason in full, not just its first line', () => {
    const notes = appendBelowCostApproval(
      'Deliver Tuesday',
      'price match\ncustomer threatened to move to Helena'
    );
    expect(stripInternalNotes(notes)).toBe('Deliver Tuesday');
    expect(stripInternalNotes(notes)).not.toContain('Helena');
  });

  it('removes a reason containing an em dash in full', () => {
    const notes = appendBelowCostApproval('Gate code 4412', 'clearance — moving old stock');
    expect(stripInternalNotes(notes)).toBe('Gate code 4412');
    expect(stripInternalNotes(notes)).not.toContain('moving old stock');
  });

  // Codex round 31: the marker stays in the raw notes after an approval is
  // recorded, so anything the operator types on a LATER edit lands below it.
  // Truncating from the marker hid that text from the customer while it still
  // looked present in the editor.
  it('keeps customer notes added after the marker', () => {
    const notes = `${BELOW_COST_APPROVAL_PREFIX} matched Helena\nDeliver to the south shed`;
    expect(stripInternalNotes(notes)).toBe('Deliver to the south shed');
    expect(stripInternalNotes(notes)).not.toContain('Helena');
  });

  it('keeps customer notes on both sides of the marker', () => {
    const notes = `Gate code 4412\n${BELOW_COST_APPROVAL_PREFIX} clearance\nDeliver Tuesday`;
    expect(stripInternalNotes(notes)).toBe('Gate code 4412\nDeliver Tuesday');
    expect(stripInternalNotes(notes)).not.toContain('clearance');
  });

  // Line-scoped stripping is only safe because the writer collapses the reason
  // to one line -- otherwise its second line would print as a customer note.
  it('collapses a multi-line reason to a single line when writing', () => {
    expect(appendBelowCostApproval('Deliver Tuesday', 'price match\nmoving to Helena')).toBe(
      'Deliver Tuesday\nBelow-cost approved: price match moving to Helena'
    );
  });

  it('removes a multi-line reason appended by the bulk import path', () => {
    const notes = appendBelowCostApproval('Spring prepay', 'goodwill\nsee Mason');
    expect(stripInternalNotes(notes)).toBe('Spring prepay');
    expect(stripInternalNotes(notes)).not.toContain('see Mason');
  });
});
