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
});
