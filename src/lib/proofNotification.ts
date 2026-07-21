/**
 * proofNotification — Beyond-parity §6 "Your Field Was Sprayed" PROOF builder.
 *
 * The parity §41 post-application notice (postNotification.ts) sends a GENERIC
 * "your application is complete" line. §6 enriches that into a rich PROOF the office
 * reviews and one-taps to the grower, containing:
 *   - field name + acres
 *   - products applied (with per-acre rate)
 *   - weather at the time of application
 *   - the applicator
 *   - a boundary-map representation (a static OpenStreetMap snapshot keyed off the
 *     field's centroid/boundary — see boundaryMapImageUrl below)
 *   - safe re-entry (REI) / pre-harvest (PHI) timing, reusing §5's labelGuardrails
 *     (formatRei / formatPhi / phiHarvestWarning)
 *
 * This module is React- and DB-free: it takes the `JobProofData` the SECURITY DEFINER
 * RPC get_job_proof_data() returns and produces (a) a structured, office-reviewable
 * draft and (b) the branded HTML + plain-text body. Every block degrades gracefully —
 * a job with no weather / no boundary / no REI on a product simply omits that block
 * and NEVER throws. All customer/field/product text is HTML-escaped before it lands in
 * the email body (no injection).
 *
 * The SEND + per-recipient LOG + idempotency are NOT here — they reuse the parity
 * record_job_post_notifications + confirm_job_notification_sent RPCs unchanged, with
 * the deterministic per-recipient idempotency key the RPC returns (never Date.now()).
 */

import { buildEmailHtml, type SendEmailParams } from './emailService';
import { formatRei, formatPhi, phiHarvestWarning } from './labelGuardrails';

// ── The proof-data shape (mirrors get_job_proof_data's jsonb return) ─────────

export interface ProofField {
  field_id: string;
  field_name: string | null;
  county: string | null;
  state: string | null;
  /** Effective acres (override > measured > total), already resolved server-side. */
  acres: number | null;
  acres_source: 'applied' | 'override' | 'measured' | 'total' | null;
  /** GeoJSON Point string, or null when the field has no centroid. */
  centroid_geojson: string | null;
  /** GeoJSON (Multi)Polygon string, or null when the field has no drawn boundary. */
  boundary_geojson: string | null;
  /** Planned harvest date YYYY-MM-DD for the PHI window, or null. */
  harvest_date: string | null;
  sort_order: number | null;
}

export interface ProofProduct {
  product_name: string | null;
  rate_per_acre: number | null;
  rate_unit: string | null;
  rei_hours: number | null;
  phi_days: number | null;
  signal_word: string | null;
  epa_registration: string | null;
  sort_order: number | null;
}

export interface ProofWeather {
  temperature: number | null;
  wind_speed: number | null;
  wind_direction: string | null;
  humidity: number | null;
  actual_start: string | null;
  actual_end: string | null;
}

export interface JobProofData {
  job_id: string;
  job_number: string | null;
  status: string | null;
  /** Application date YYYY-MM-DD (the job's job_date), or null. */
  application_date: string | null;
  applicator_name: string | null;
  fields: ProofField[];
  products: ProofProduct[];
  /** Weather at application, or null when the applicator captured none. */
  weather: ProofWeather | null;
}

// ── Centroid parsing + the boundary-map representation ───────────────────────

/** Parse a GeoJSON Point string to {lat,lng}, or null. Never throws. */
export function parseProofCentroid(
  centroidGeojson: string | null | undefined,
): { lat: number; lng: number } | null {
  if (!centroidGeojson || typeof centroidGeojson !== 'string') return null;
  try {
    const g = JSON.parse(centroidGeojson) as { type?: string; coordinates?: unknown };
    if (g?.type === 'Point' && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      const [lng, lat] = g.coordinates as number[];
      if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
        return { lat, lng };
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Derive a representative {lat,lng} for a field's map pin: the centroid if present,
 * else the average of the boundary's outer-ring vertices, else null.
 *
 * NOTE on scope (per §6 mandate): a true SERVER-rendered static boundary IMAGE
 * (the polygon drawn onto a basemap tile) is non-trivial to generate without a paid
 * map provider. We ship a sensible representation NOW — a static OpenStreetMap
 * snapshot centered on the field, with a pin — and a deep link the office/grower can
 * open to see the boundary on a live map. The full polygon-on-tile render is flagged
 * as a follow-on (see boundaryMapImageUrl below).
 */
export function proofFieldLatLng(field: ProofField): { lat: number; lng: number } | null {
  const c = parseProofCentroid(field.centroid_geojson);
  if (c) return c;
  // Fallback: average the first ring of the boundary polygon.
  if (field.boundary_geojson) {
    try {
      const g = JSON.parse(field.boundary_geojson) as { type?: string; coordinates?: unknown };
      let ring: number[][] | null = null;
      if (g?.type === 'Polygon' && Array.isArray(g.coordinates)) {
        ring = (g.coordinates as number[][][])[0] ?? null;
      } else if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
        ring = (g.coordinates as number[][][][])[0]?.[0] ?? null;
      }
      if (ring && ring.length > 0) {
        let sLat = 0;
        let sLng = 0;
        let n = 0;
        for (const pt of ring) {
          if (Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number') {
            sLng += pt[0];
            sLat += pt[1];
            n += 1;
          }
        }
        if (n > 0) return { lat: sLat / n, lng: sLng / n };
      }
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * A static boundary-map IMAGE url for a field, or null when the field has no
 * location data (then the proof simply omits the map for that field — graceful).
 *
 * Uses the free, keyless OpenStreetMap static-map service (staticmap.openstreetmap.de),
 * already an external image host the office controls; no paid provider, no API key,
 * consistent with the §6 weather rule (free providers only). A red marker is dropped
 * on the field's representative point at a field-scale zoom.
 *
 * FOLLOW-ON (flagged, not blocking): rendering the actual boundary POLYGON onto the
 * tile (rather than a center pin) needs either a paid static-map provider that accepts
 * a path overlay or a server-side tile compositor. The pinned snapshot + the live-map
 * deep link (boundaryMapLink) are the shipped representation.
 */
export function boundaryMapImageUrl(
  field: ProofField,
  opts?: { zoom?: number; width?: number; height?: number },
): string | null {
  const ll = proofFieldLatLng(field);
  if (!ll) return null;
  const zoom = opts?.zoom ?? 14;
  const width = opts?.width ?? 480;
  const height = opts?.height ?? 280;
  const lat = ll.lat.toFixed(5);
  const lng = ll.lng.toFixed(5);
  return (
    `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}` +
    `&zoom=${zoom}&size=${width}x${height}&markers=${lat},${lng},red-pushpin`
  );
}

/** A live-map deep link (OpenStreetMap) the grower can open to see the field. */
export function boundaryMapLink(field: ProofField): string | null {
  const ll = proofFieldLatLng(field);
  if (!ll) return null;
  const lat = ll.lat.toFixed(5);
  const lng = ll.lng.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`;
}

// ── Display formatting ───────────────────────────────────────────────────────

/** "118.4 ac" / "—" — effective acres for the field, trailing zeros dropped. */
export function formatAcres(acres: number | null | undefined): string {
  if (typeof acres !== 'number' || !Number.isFinite(acres) || acres <= 0) return '—';
  return `${(Math.round(acres * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })} ac`;
}

/** "Headline Fungicide @ 1 oz/ac" / "Headline Fungicide" — product + per-acre rate. */
export function formatProductLine(p: ProofProduct): string {
  const name = (p.product_name ?? '').trim() || 'Product';
  const rate =
    typeof p.rate_per_acre === 'number' && Number.isFinite(p.rate_per_acre) && p.rate_per_acre > 0
      ? `${(Math.round(p.rate_per_acre * 10000) / 10000).toLocaleString(undefined, { maximumFractionDigits: 4 })}${
          p.rate_unit && p.rate_unit.trim() ? ` ${p.rate_unit.trim()}` : ''
        }`
      : null;
  return rate ? `${name} @ ${rate}` : name;
}

/** "78°F, wind 6.5 mph NW, humidity 55%" — only the parts that were captured. */
export function formatWeatherSummary(w: ProofWeather | null | undefined): string | null {
  if (!w) return null;
  const parts: string[] = [];
  if (typeof w.temperature === 'number' && Number.isFinite(w.temperature)) parts.push(`${Math.round(w.temperature)}°F`);
  if (typeof w.wind_speed === 'number' && Number.isFinite(w.wind_speed)) {
    const dir = w.wind_direction && w.wind_direction.trim() ? ` ${w.wind_direction.trim()}` : '';
    parts.push(`wind ${Math.round(w.wind_speed * 10) / 10} mph${dir}`);
  } else if (w.wind_direction && w.wind_direction.trim()) {
    parts.push(`wind ${w.wind_direction.trim()}`);
  }
  if (typeof w.humidity === 'number' && Number.isFinite(w.humidity)) parts.push(`humidity ${Math.round(w.humidity)}%`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The safe re-entry / harvest timing line for ONE product, reusing §5's helpers.
 *   - REI: "Re-entry: 12 hr" (formatRei)
 *   - PHI: "Pre-harvest: 21 d" (formatPhi), plus the earliest harvest date when a
 *     PHI + application date are known (phiHarvestWarning), and an explicit warning
 *     when a field's planned harvest falls INSIDE the window.
 * Returns null when the product has neither REI nor PHI on file (omit the line).
 */
export function safeTimingLine(
  p: ProofProduct,
  applicationDate: string | null,
  harvestDate: string | null,
): string | null {
  const hasRei = typeof p.rei_hours === 'number' && Number.isFinite(p.rei_hours) && p.rei_hours > 0;
  const hasPhi = typeof p.phi_days === 'number' && Number.isFinite(p.phi_days) && p.phi_days > 0;
  if (!hasRei && !hasPhi) return null;
  const bits: string[] = [];
  if (hasRei) bits.push(`Re-entry: ${formatRei(p.rei_hours)}`);
  if (hasPhi) {
    let phiBit = `Pre-harvest: ${formatPhi(p.phi_days)}`;
    const warn = phiHarvestWarning(p.phi_days, harvestDate, applicationDate);
    if (warn.earliestHarvest) {
      phiBit += ` (safe to harvest on/after ${warn.earliestHarvest})`;
    }
    if (warn.status === 'inside_window') {
      phiBit += ' — planned harvest falls inside this window';
    }
    bits.push(phiBit);
  }
  return bits.join(' · ');
}

// ── Structured, office-reviewable draft ──────────────────────────────────────

export interface ProofDraftFieldLine {
  field_name: string;
  location: string | null; // "Dakota County, MN"
  acres: string; // "118.4 ac"
  mapImageUrl: string | null;
  mapLink: string | null;
}

export interface ProofDraftProductLine {
  label: string; // "Headline Fungicide @ 1 oz/ac"
  signalWord: string | null;
  safeTiming: string | null;
}

export interface ProofDraft {
  jobNumber: string;
  applicationDate: string;
  applicator: string | null;
  weatherSummary: string | null;
  totalAcres: string;
  fields: ProofDraftFieldLine[];
  products: ProofDraftProductLine[];
  /** True when at least one rich block is present (map/weather/REI-PHI/products). */
  hasRichContent: boolean;
}

/**
 * The EARLIEST (minimum) harvest date across a set of fields, as YYYY-MM-DD, or null.
 *
 * The PHI-vs-harvest warning must use the SOONEST harvest, not the first field in route
 * order: if a LATER field's harvest falls inside the PHI window but an earlier field's is
 * clear, taking the first field would drop the warning (a real safety miss). Comparing the
 * YYYY-MM-DD strings lexicographically is a valid chronological compare for that format.
 * Pure + tested.
 */
export function earliestHarvestDate(fields: ReadonlyArray<Pick<ProofField, 'harvest_date'>>): string | null {
  let earliest: string | null = null;
  for (const f of fields) {
    const h = f.harvest_date;
    if (h && /^\d{4}-\d{2}-\d{2}/.test(h) && (earliest === null || h < earliest)) {
      earliest = h.slice(0, 10);
    }
  }
  return earliest;
}

/**
 * Build the structured draft the office previews before approving the send. Pure —
 * exercises every graceful-degrade branch without a DB. The PHI warning uses the
 * EARLIEST harvest date across all (recipient-scoped) fields so a later in-window
 * harvest is never dropped.
 */
export function buildProofDraft(data: JobProofData): ProofDraft {
  const appDate = data.application_date ?? '';
  // The SOONEST harvest across the scoped fields drives the PHI-vs-harvest warning, so a
  // later field inside the window is never missed (a first-field-only pick would drop it).
  const harvestDate = earliestHarvestDate(data.fields);

  const fields: ProofDraftFieldLine[] = data.fields.map((f) => {
    const county = (f.county ?? '').trim();
    const state = (f.state ?? '').trim();
    const location =
      county && state ? `${county} County, ${state}` : county ? `${county} County` : state || null;
    return {
      field_name: (f.field_name ?? '').trim() || 'Field',
      location,
      acres: formatAcres(f.acres),
      mapImageUrl: boundaryMapImageUrl(f),
      mapLink: boundaryMapLink(f),
    };
  });

  const totalAcresNum = data.fields.reduce(
    (s, f) => s + (typeof f.acres === 'number' && Number.isFinite(f.acres) && f.acres > 0 ? f.acres : 0),
    0,
  );

  const products: ProofDraftProductLine[] = data.products.map((p) => ({
    label: formatProductLine(p),
    signalWord: p.signal_word && p.signal_word.trim() ? p.signal_word.trim() : null,
    safeTiming: safeTimingLine(p, appDate || null, harvestDate),
  }));

  const weatherSummary = formatWeatherSummary(data.weather);
  const hasRichContent =
    products.length > 0 ||
    fields.some((f) => f.mapImageUrl) ||
    weatherSummary != null ||
    products.some((p) => p.safeTiming);

  return {
    jobNumber: (data.job_number ?? '').trim() || data.job_id,
    applicationDate: appDate,
    applicator: data.applicator_name && data.applicator_name.trim() ? data.applicator_name.trim() : null,
    weatherSummary,
    totalAcres: formatAcres(totalAcresNum > 0 ? totalAcresNum : null),
    fields,
    products,
    hasRichContent,
  };
}

// ── HTML + plain-text rendering ──────────────────────────────────────────────

/** Minimal HTML escaping so customer/field/product text with <, >, &, " renders safely. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ProofRenderInput {
  /** The resolved recipient farm name (per recipient), already trusted as text. */
  customerName: string;
  draft: ProofDraft;
}

/** The proof email subject for a recipient. */
export function proofSubject(draft: ProofDraft): string {
  return `Your field was sprayed — application complete (Job ${draft.jobNumber})`;
}

/**
 * Render the rich proof body HTML for ONE recipient. Every interpolated value is
 * escapeHtml'd. A missing block (no fields, no weather, no products, no REI/PHI, no
 * map) is simply omitted — never an empty heading, never a crash. The map is an
 * <img> (the static snapshot) wrapped in a link to the live map; if the image host is
 * unreachable in the recipient's client the alt text + the link still convey it.
 */
export function renderProofHtml(input: ProofRenderInput): string {
  const { customerName, draft } = input;
  const blocks: string[] = [];

  blocks.push(
    `<h2 style="margin:0 0 8px;color:#111827;font-size:18px;">Your field was sprayed</h2>`,
  );
  blocks.push(
    `<p style="margin:0 0 12px;color:#374151;">Hello ${escapeHtml(customerName)}, this confirms Crop RX Solutions completed your field application` +
      `${draft.applicationDate ? ` on ${escapeHtml(draft.applicationDate)}` : ''}` +
      ` (Job ${escapeHtml(draft.jobNumber)}). Here is the record of what was done.</p>`,
  );

  // Summary line: applicator + total acres + weather.
  const summaryBits: string[] = [];
  if (draft.applicator) summaryBits.push(`<strong>Applicator:</strong> ${escapeHtml(draft.applicator)}`);
  if (draft.totalAcres !== '—') summaryBits.push(`<strong>Total acres:</strong> ${escapeHtml(draft.totalAcres)}`);
  if (draft.weatherSummary) summaryBits.push(`<strong>Weather at application:</strong> ${escapeHtml(draft.weatherSummary)}`);
  if (summaryBits.length > 0) {
    blocks.push(
      `<table style="margin:0 0 16px;width:100%;border-collapse:collapse;">` +
        summaryBits
          .map(
            (b) =>
              `<tr><td style="padding:4px 0;color:#374151;font-size:14px;border-bottom:1px solid #f3f4f6;">${b}</td></tr>`,
          )
          .join('') +
        `</table>`,
    );
  }

  // Fields, each with its boundary-map snapshot.
  if (draft.fields.length > 0) {
    blocks.push(`<h3 style="margin:16px 0 8px;color:#111827;font-size:15px;">Fields treated</h3>`);
    for (const f of draft.fields) {
      const locLine = f.location ? ` — ${escapeHtml(f.location)}` : '';
      blocks.push(
        `<p style="margin:0 0 4px;color:#374151;font-size:14px;"><strong>${escapeHtml(f.field_name)}</strong>${locLine} (${escapeHtml(f.acres)})</p>`,
      );
      if (f.mapImageUrl) {
        const imgAlt = escapeHtml(`Map of ${f.field_name}`);
        const img = `<img src="${escapeHtml(f.mapImageUrl)}" alt="${imgAlt}" width="480" style="max-width:100%;border:1px solid #e5e7eb;border-radius:6px;display:block;margin:0 0 12px;" />`;
        blocks.push(f.mapLink ? `<a href="${escapeHtml(f.mapLink)}" style="text-decoration:none;">${img}</a>` : img);
      }
    }
  }

  // Products applied.
  if (draft.products.length > 0) {
    blocks.push(`<h3 style="margin:16px 0 8px;color:#111827;font-size:15px;">Products applied</h3>`);
    blocks.push(
      `<table style="width:100%;border-collapse:collapse;margin:0 0 12px;">` +
        draft.products
          .map((p) => {
            const sig = p.signalWord ? ` <span style="color:#92400e;">(${escapeHtml(p.signalWord)})</span>` : '';
            const timing = p.safeTiming
              ? `<div style="color:#6b7280;font-size:13px;margin-top:2px;">${escapeHtml(p.safeTiming)}</div>`
              : '';
            return `<tr><td style="padding:6px 0;color:#374151;font-size:14px;border-bottom:1px solid #f3f4f6;"><strong>${escapeHtml(p.label)}</strong>${sig}${timing}</td></tr>`;
          })
          .join('') +
        `</table>`,
    );
  }

  blocks.push(
    `<p style="margin:16px 0 0;color:#374151;font-size:14px;">Please observe any posted re-entry (REI) and pre-harvest (PHI) intervals shown above. ` +
      `If you have any questions about this application, just reply to this email or give us a call.</p>`,
  );
  blocks.push(`<p style="margin:12px 0 0;color:#374151;font-size:14px;">Thank you,<br/>Crop RX Solutions</p>`);

  return buildEmailHtml(blocks.join(''));
}

/** A plain-text version of the proof (for the office preview + an email text part). */
export function renderProofText(input: ProofRenderInput): string {
  const { customerName, draft } = input;
  const lines: string[] = [];
  lines.push('YOUR FIELD WAS SPRAYED');
  lines.push('');
  lines.push(
    `Hello ${customerName}, this confirms Crop RX Solutions completed your field application` +
      `${draft.applicationDate ? ` on ${draft.applicationDate}` : ''} (Job ${draft.jobNumber}).`,
  );
  lines.push('');
  if (draft.applicator) lines.push(`Applicator: ${draft.applicator}`);
  if (draft.totalAcres !== '—') lines.push(`Total acres: ${draft.totalAcres}`);
  if (draft.weatherSummary) lines.push(`Weather at application: ${draft.weatherSummary}`);
  if (draft.fields.length > 0) {
    lines.push('');
    lines.push('Fields treated:');
    for (const f of draft.fields) {
      const loc = f.location ? ` — ${f.location}` : '';
      lines.push(`  • ${f.field_name}${loc} (${f.acres})`);
      if (f.mapLink) lines.push(`    Map: ${f.mapLink}`);
    }
  }
  if (draft.products.length > 0) {
    lines.push('');
    lines.push('Products applied:');
    for (const p of draft.products) {
      const sig = p.signalWord ? ` (${p.signalWord})` : '';
      lines.push(`  • ${p.label}${sig}`);
      if (p.safeTiming) lines.push(`    ${p.safeTiming}`);
    }
  }
  lines.push('');
  lines.push(
    'Please observe any posted re-entry (REI) and pre-harvest (PHI) intervals shown above. ' +
      'If you have any questions, reply to this email or give us a call.',
  );
  lines.push('');
  lines.push('Thank you,');
  lines.push('Crop RX Solutions');
  return lines.join('\n');
}

// ── Per-recipient email payload ──────────────────────────────────────────────

export interface ProofEmailInput {
  /** The resolved share customer's email — throws if blank (never a silent send). */
  customerEmail: string | null | undefined;
  customerId: string;
  customerName: string;
  jobId: string;
  draft: ProofDraft;
  /**
   * The DETERMINISTIC per-recipient idempotency key the record RPC returns
   * (record_job_post_notifications -> recipients[].email_idempotency_key). REQUIRED so a
   * retry never double-sends; we never fall back to Date.now() (a timestamp would defeat
   * the edge fn's de-dupe). When absent, the caller must NOT send (the recorded row had
   * no email / no key).
   */
  emailIdempotencyKey: string;
  /** Invoice that owns this post-application send; enables the server send gate. */
  invoiceId: string;
}

/**
 * Build the SendEmailParams for one recipient's "your field was sprayed" proof. Throws
 * the honest user-facing error when there is no email on file (never a silent send to a
 * blank/wrong address). Uses email_type='post_application_notice' — the SAME allow-listed
 * (deploy-gated) type the parity post-notice uses, so no NEW edge-fn type is required.
 */
export function buildProofEmailPayload(input: ProofEmailInput): SendEmailParams {
  const email = input.customerEmail?.trim();
  if (!email) {
    throw new Error('Customer does not have an email address on file');
  }
  if (!input.emailIdempotencyKey) {
    // Defensive: never invent a timestamp key — a missing key means "do not send".
    throw new Error('Missing idempotency key for this recipient — cannot send safely');
  }
  const html = renderProofHtml({ customerName: input.customerName, draft: input.draft });
  return {
    to: email,
    subject: proofSubject(input.draft),
    html,
    email_type: 'post_application_notice',
    customer_id: input.customerId,
    resource_type: 'invoice',
    resource_id: input.invoiceId,
    idempotency_key: input.emailIdempotencyKey,
  };
}
