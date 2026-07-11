import { describe, expect, it } from 'vitest';
import { canRemoveSingleBoundary, shouldSyncInitialDrawFeatures } from './fieldBoundaryState';

describe('canRemoveSingleBoundary', () => {
  it('disables removal after a boundary has been persisted', () => {
    expect(canRemoveSingleBoundary(true)).toBe(false);
  });

  it('allows a newly drawn, unsaved boundary to be removed', () => {
    expect(canRemoveSingleBoundary(false)).toBe(true);
  });
});

describe('shouldSyncInitialDrawFeatures', () => {
  it('does not reload persisted features while a new polygon is being drawn', () => {
    expect(shouldSyncInitialDrawFeatures('draw_polygon')).toBe(false);
  });

  it('reloads persisted features after drawing is complete', () => {
    expect(shouldSyncInitialDrawFeatures('simple_select')).toBe(true);
  });
});
