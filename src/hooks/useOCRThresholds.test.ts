import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOCRThresholds, OCR_CONFIDENCE_THRESHOLD } from './useOCRThresholds';

describe('useOCRThresholds', () => {
  it('returns the locked threshold (70) for both auto_approve and needs_review', () => {
    const { result } = renderHook(() => useOCRThresholds());
    expect(result.current).toEqual({ auto_approve: 70, needs_review: 70 });
  });

  it('exports OCR_CONFIDENCE_THRESHOLD = 70 as the source of truth', () => {
    expect(OCR_CONFIDENCE_THRESHOLD).toBe(70);
  });
});
