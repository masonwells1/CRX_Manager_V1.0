import { describe, it, expect } from 'vitest';
import { preferredQuoteNotes } from './quoteNotes';
import type { Product } from '../types';

/**
 * preferredQuoteNotes picks what a customer sees on a quote: the deliberate
 * customer-facing `quoting_notes`, with the internal-ish grower `notes` only as a
 * legacy fallback. Whitespace-only quoting_notes must NOT win — otherwise a stray
 * space silently blanks the guidance instead of falling back.
 */
function product(overrides: Partial<Pick<Product, 'quoting_notes' | 'notes'>>) {
  return overrides as Pick<Product, 'quoting_notes' | 'notes'>;
}

describe('preferredQuoteNotes', () => {
  it('prefers quoting_notes when both are present', () => {
    expect(
      preferredQuoteNotes(product({ quoting_notes: 'Apply pre-emerge', notes: 'grower memo' })),
    ).toBe('Apply pre-emerge');
  });

  it('falls back to notes when quoting_notes is absent', () => {
    expect(preferredQuoteNotes(product({ quoting_notes: null, notes: 'grower memo' }))).toBe(
      'grower memo',
    );
  });

  it('returns empty string when neither is set', () => {
    expect(preferredQuoteNotes(product({ quoting_notes: null, notes: null }))).toBe('');
    expect(preferredQuoteNotes(product({}))).toBe('');
  });

  it('trims surrounding whitespace from the chosen value', () => {
    expect(preferredQuoteNotes(product({ quoting_notes: '  spaced  ', notes: null }))).toBe('spaced');
    expect(preferredQuoteNotes(product({ quoting_notes: null, notes: '\n memo \t' }))).toBe('memo');
  });

  describe('whitespace-only values do not win', () => {
    it.each(['   ', '\t', '\n', '  \n  '])(
      'quoting_notes of %j falls back to notes',
      (blank) => {
        expect(preferredQuoteNotes(product({ quoting_notes: blank, notes: 'grower memo' }))).toBe(
          'grower memo',
        );
      },
    );

    it('whitespace on both sides yields empty string', () => {
      expect(preferredQuoteNotes(product({ quoting_notes: '  ', notes: '  ' }))).toBe('');
    });

    it('empty-string quoting_notes falls back', () => {
      expect(preferredQuoteNotes(product({ quoting_notes: '', notes: 'grower memo' }))).toBe(
        'grower memo',
      );
    });
  });
});
