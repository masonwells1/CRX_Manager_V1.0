import { describe, expect, it } from 'vitest';
import { isCurrentSeason, openOrInSeasonFilter, otherSeasonLabel, otherSeasonLabels } from './invoiceSeasonWindow';

describe('openOrInSeasonFilter', () => {
  it('keeps every open status, and closed rows only inside the half-open season window', () => {
    expect(openOrInSeasonFilter('invoice_date', 2027)).toBe(
      'status.in.(draft,unposted,posted,overdue),and(invoice_date.gte.2026-10-01,invoice_date.lt.2027-10-01)',
    );
    expect(openOrInSeasonFilter('created_at', 2026)).toBe(
      'status.in.(draft,unposted,posted,overdue),and(created_at.gte.2025-10-01,created_at.lt.2026-10-01)',
    );
  });
});

describe('season labels and the this-season test', () => {
  it('labels any season other than the current one, earlier or later', () => {
    expect(otherSeasonLabel(2026, 2027)).toBe('Season 2026');
    expect(otherSeasonLabel(2028, 2027)).toBe('Season 2028');
    expect(otherSeasonLabel(2027, 2027)).toBeNull();
  });

  it('treats a missing season as NOT this season, so season-limited bulk actions leave it out', () => {
    expect(isCurrentSeason(2027, 2027)).toBe(true);
    expect(isCurrentSeason(2026, 2027)).toBe(false);
    expect(isCurrentSeason(null, 2027)).toBe(false);
    expect(isCurrentSeason(undefined, 2027)).toBe(false);
  });

  it('tags a missing season as "Season unknown", the same way bulk actions treat it', () => {
    expect(otherSeasonLabel(null, 2027)).toBe('Season unknown');
    expect(otherSeasonLabel(undefined, 2027)).toBe('Season unknown');
    // Every season value gets a tag exactly when it is not this season.
    for (const season of [2025, 2026, 2027, 2028, null, undefined]) {
      expect(otherSeasonLabel(season, 2027) === null).toBe(isCurrentSeason(season, 2027));
    }
  });

  it('lists the distinct other-season labels for confirm text, including a missing season', () => {
    expect(otherSeasonLabels([{ season: 2026 }, { season: 2027 }, { season: 2026 }, { season: 2028 }, { season: null }], 2027))
      .toBe('Season 2026, Season 2028, Season unknown');
    expect(otherSeasonLabels([{ season: 2027 }], 2027)).toBe('');
  });
});
