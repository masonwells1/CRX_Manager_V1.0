import { describe, it, expect } from 'vitest';
import {
  parseProofCentroid,
  proofFieldLatLng,
  boundaryMapImageUrl,
  boundaryMapLink,
  formatAcres,
  formatProductLine,
  formatWeatherSummary,
  safeTimingLine,
  buildProofDraft,
  escapeHtml,
  proofSubject,
  renderProofHtml,
  renderProofText,
  buildProofEmailPayload,
  type JobProofData,
  type ProofField,
  type ProofProduct,
} from './proofNotification';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const fieldWithBoundary: ProofField = {
  field_id: 'f1',
  field_name: 'South Creek',
  county: 'Dakota',
  state: 'MN',
  acres: 118.4,
  acres_source: 'measured',
  centroid_geojson: '{"type":"Point","coordinates":[-93.05,44.75]}',
  boundary_geojson:
    '{"type":"MultiPolygon","coordinates":[[[[-93.1,44.7],[-93.0,44.7],[-93.0,44.8],[-93.1,44.8],[-93.1,44.7]]]]}',
  harvest_date: '2026-07-01',
  sort_order: 0,
};

const product: ProofProduct = {
  product_name: 'Headline Fungicide',
  rate_per_acre: 1,
  rate_unit: 'oz/ac',
  rei_hours: 12,
  phi_days: 21,
  signal_word: 'Caution',
  epa_registration: 'EPA-123',
  sort_order: 0,
};

const fullData: JobProofData = {
  job_id: 'job-1',
  job_number: 'FJOB-003',
  status: 'completed',
  application_date: '2026-06-12',
  applicator_name: 'Carl Applicator',
  fields: [fieldWithBoundary],
  products: [product],
  weather: { temperature: 78, wind_speed: 6.5, wind_direction: 'NW', humidity: 55, actual_start: null, actual_end: null },
};

// ── parseProofCentroid / proofFieldLatLng ────────────────────────────────────

describe('parseProofCentroid', () => {
  it('parses a GeoJSON Point to {lat,lng}', () => {
    expect(parseProofCentroid('{"type":"Point","coordinates":[-93.05,44.75]}')).toEqual({ lat: 44.75, lng: -93.05 });
  });
  it('returns null on null/blank/garbage (never throws)', () => {
    expect(parseProofCentroid(null)).toBeNull();
    expect(parseProofCentroid('not json')).toBeNull();
    expect(parseProofCentroid('{"type":"LineString","coordinates":[]}')).toBeNull();
  });
});

describe('proofFieldLatLng', () => {
  it('prefers the centroid', () => {
    expect(proofFieldLatLng(fieldWithBoundary)).toEqual({ lat: 44.75, lng: -93.05 });
  });
  it('falls back to the boundary ring average when no centroid', () => {
    const f = { ...fieldWithBoundary, centroid_geojson: null };
    const ll = proofFieldLatLng(f);
    expect(ll).not.toBeNull();
    expect(ll!.lat).toBeGreaterThan(44.7);
    expect(ll!.lat).toBeLessThan(44.8);
  });
  it('returns null when the field has no location at all', () => {
    expect(proofFieldLatLng({ ...fieldWithBoundary, centroid_geojson: null, boundary_geojson: null })).toBeNull();
  });
});

// ── boundary map representation ──────────────────────────────────────────────

describe('boundaryMapImageUrl / boundaryMapLink', () => {
  it('builds a free, keyless OpenStreetMap static-map URL centered on the field', () => {
    const url = boundaryMapImageUrl(fieldWithBoundary);
    expect(url).toContain('staticmap.openstreetmap.de');
    expect(url).toContain('center=44.75000,-93.05000');
    expect(url).toContain('markers=44.75000,-93.05000');
  });
  it('builds a live-map deep link', () => {
    expect(boundaryMapLink(fieldWithBoundary)).toContain('openstreetmap.org/?mlat=44.75000&mlon=-93.05000');
  });
  it('returns null for a field with no location (graceful — proof omits the map)', () => {
    const f = { ...fieldWithBoundary, centroid_geojson: null, boundary_geojson: null };
    expect(boundaryMapImageUrl(f)).toBeNull();
    expect(boundaryMapLink(f)).toBeNull();
  });
});

// ── display formatting ───────────────────────────────────────────────────────

describe('formatAcres', () => {
  it('formats positive acres and dashes for missing/zero', () => {
    expect(formatAcres(118.4)).toBe('118.4 ac');
    expect(formatAcres(0)).toBe('—');
    expect(formatAcres(null)).toBe('—');
    expect(formatAcres(NaN)).toBe('—');
  });
});

describe('formatProductLine', () => {
  it('includes the per-acre rate when present', () => {
    expect(formatProductLine(product)).toBe('Headline Fungicide @ 1 oz/ac');
  });
  it('drops the rate when absent', () => {
    expect(formatProductLine({ ...product, rate_per_acre: null })).toBe('Headline Fungicide');
  });
  it('falls back to a generic name when blank', () => {
    expect(formatProductLine({ ...product, product_name: null, rate_per_acre: null })).toBe('Product');
  });
});

describe('formatWeatherSummary', () => {
  it('summarizes only the captured parts', () => {
    expect(formatWeatherSummary(fullData.weather)).toBe('78°F, wind 6.5 mph NW, humidity 55%');
  });
  it('returns null when no weather', () => {
    expect(formatWeatherSummary(null)).toBeNull();
    expect(formatWeatherSummary({ temperature: null, wind_speed: null, wind_direction: null, humidity: null, actual_start: null, actual_end: null })).toBeNull();
  });
});

// ── safe REI/PHI timing (reuses §5 helpers) ──────────────────────────────────

describe('safeTimingLine', () => {
  it('renders REI + PHI + earliest-harvest', () => {
    const line = safeTimingLine(product, '2026-06-12', '2026-09-01');
    expect(line).toContain('Re-entry: 12 hr');
    expect(line).toContain('Pre-harvest: 21 d');
    expect(line).toContain('safe to harvest on/after 2026-07-03');
  });
  it('warns when the planned harvest is INSIDE the PHI window', () => {
    const line = safeTimingLine(product, '2026-06-12', '2026-06-20');
    expect(line).toContain('planned harvest falls inside this window');
  });
  it('returns null when the product has neither REI nor PHI (omit the line)', () => {
    expect(safeTimingLine({ ...product, rei_hours: null, phi_days: null }, '2026-06-12', null)).toBeNull();
  });
});

// ── buildProofDraft (graceful degrade) ───────────────────────────────────────

describe('buildProofDraft', () => {
  it('assembles a rich draft from full data', () => {
    const d = buildProofDraft(fullData);
    expect(d.jobNumber).toBe('FJOB-003');
    expect(d.applicator).toBe('Carl Applicator');
    expect(d.weatherSummary).toBe('78°F, wind 6.5 mph NW, humidity 55%');
    expect(d.totalAcres).toBe('118.4 ac');
    expect(d.fields).toHaveLength(1);
    expect(d.fields[0].mapImageUrl).toContain('staticmap.openstreetmap.de');
    expect(d.fields[0].location).toBe('Dakota County, MN');
    expect(d.products[0].safeTiming).toContain('Re-entry: 12 hr');
    expect(d.hasRichContent).toBe(true);
  });
  it('degrades gracefully with no weather, no boundary, no REI/PHI', () => {
    const bare: JobProofData = {
      ...fullData,
      weather: null,
      fields: [{ ...fieldWithBoundary, centroid_geojson: null, boundary_geojson: null, harvest_date: null }],
      products: [{ ...product, rei_hours: null, phi_days: null, signal_word: null }],
    };
    const d = buildProofDraft(bare);
    expect(d.weatherSummary).toBeNull();
    expect(d.fields[0].mapImageUrl).toBeNull();
    expect(d.products[0].safeTiming).toBeNull();
    // products still present => still has rich content
    expect(d.hasRichContent).toBe(true);
  });
  it('uses the job_id when no job_number, and dashes total acres with no acres', () => {
    const d = buildProofDraft({ ...fullData, job_number: null, fields: [{ ...fieldWithBoundary, acres: null }] });
    expect(d.jobNumber).toBe('job-1');
    expect(d.totalAcres).toBe('—');
  });
});

// ── escaping / rendering (no injection) ──────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes <, >, &, "', () => {
    expect(escapeHtml('<script>"&</script>')).toBe('&lt;script&gt;&quot;&amp;&lt;/script&gt;');
  });
});

describe('renderProofHtml', () => {
  const draft = buildProofDraft(fullData);
  it('produces branded HTML with field, weather, products, and a map img', () => {
    const html = renderProofHtml({ customerName: 'Green Acres Farm', draft });
    expect(html).toContain('Your field was sprayed');
    expect(html).toContain('Green Acres Farm');
    expect(html).toContain('South Creek');
    expect(html).toContain('Headline Fungicide @ 1 oz/ac');
    expect(html).toContain('78°F, wind 6.5 mph NW, humidity 55%');
    expect(html).toContain('staticmap.openstreetmap.de');
    expect(html).toContain('Re-entry: 12 hr');
  });
  it('escapes a malicious field/customer name (no injection)', () => {
    const evil = buildProofDraft({
      ...fullData,
      fields: [{ ...fieldWithBoundary, field_name: '<img src=x onerror=alert(1)>' }],
    });
    const html = renderProofHtml({ customerName: '<b>x</b>', draft: evil });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('renderProofText / proofSubject', () => {
  const draft = buildProofDraft(fullData);
  it('subject names the job', () => {
    expect(proofSubject(draft)).toContain('Job FJOB-003');
  });
  it('text body carries the key facts', () => {
    const txt = renderProofText({ customerName: 'Green Acres Farm', draft });
    expect(txt).toContain('YOUR FIELD WAS SPRAYED');
    expect(txt).toContain('South Creek');
    expect(txt).toContain('Headline Fungicide @ 1 oz/ac');
    expect(txt).toContain('Map: https://www.openstreetmap.org');
  });
});

// ── email payload (no silent send, deterministic key) ────────────────────────

describe('buildProofEmailPayload', () => {
  const draft = buildProofDraft(fullData);
  it('builds a post_application_notice payload with the supplied deterministic key', () => {
    const p = buildProofEmailPayload({
      customerEmail: 'farm@example.com',
      customerId: 'c1',
      customerName: 'Green Acres Farm',
      jobId: 'job-1',
      draft,
      emailIdempotencyKey: 'rpc-key-abc:c1',
    });
    expect(p.email_type).toBe('post_application_notice');
    expect(p.to).toBe('farm@example.com');
    expect(p.idempotency_key).toBe('rpc-key-abc:c1');
    expect(p.subject).toContain('Job FJOB-003');
  });
  it('throws (never silently sends) when there is no email on file', () => {
    expect(() =>
      buildProofEmailPayload({ customerEmail: '  ', customerId: 'c1', customerName: 'X', jobId: 'j', draft, emailIdempotencyKey: 'k' }),
    ).toThrow(/email address on file/);
  });
  it('throws rather than inventing a timestamp key when the deterministic key is missing', () => {
    expect(() =>
      buildProofEmailPayload({ customerEmail: 'a@b.com', customerId: 'c1', customerName: 'X', jobId: 'j', draft, emailIdempotencyKey: '' }),
    ).toThrow(/idempotency key/i);
  });
});
