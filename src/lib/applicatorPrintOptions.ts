/**
 * applicatorPrintOptions — persisted, packet-level choices for the Applicator
 * Sheet. The visual format intentionally is not part of these preferences: it
 * remains a deliberate choice each time the full print dialog is opened.
 */
import { supabase } from './db';

export type ApplicatorMapPages = 'none' | 'overview' | 'per-field' | 'both';

export interface ApplicatorPrintOptions {
  mapPages: ApplicatorMapPages;
  includePreviousApplications: boolean;
  previousApplicationsPerField: number;
  blankSections: number;
  includeBillingSplits: boolean;
  showBanner: boolean;
}

export const APPLICATOR_PRINT_OPTIONS_KEY = 'applicator_print_options';

export const DEFAULT_APPLICATOR_PRINT_OPTIONS: ApplicatorPrintOptions = {
  mapPages: 'both',
  includePreviousApplications: false,
  previousApplicationsPerField: 3,
  blankSections: 0,
  includeBillingSplits: true,
  showBanner: true,
};

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

/** Parse a saved setting defensively so a malformed preference never blocks printing. */
export function parseApplicatorPrintOptions(raw: string | null | undefined): ApplicatorPrintOptions {
  if (!raw || raw.trim() === '') return { ...DEFAULT_APPLICATOR_PRINT_OPTIONS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_APPLICATOR_PRINT_OPTIONS };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_APPLICATOR_PRINT_OPTIONS };
  const value = parsed as Record<string, unknown>;
  const mapPages = value.mapPages;
  return {
    mapPages: mapPages === 'none' || mapPages === 'overview' || mapPages === 'per-field' || mapPages === 'both'
      ? mapPages
      : DEFAULT_APPLICATOR_PRINT_OPTIONS.mapPages,
    includePreviousApplications: value.includePreviousApplications === true,
    previousApplicationsPerField: boundedInteger(
      value.previousApplicationsPerField,
      DEFAULT_APPLICATOR_PRINT_OPTIONS.previousApplicationsPerField,
      1,
      5,
    ),
    blankSections: boundedInteger(value.blankSections, DEFAULT_APPLICATOR_PRINT_OPTIONS.blankSections, 0, 5),
    includeBillingSplits: value.includeBillingSplits !== false,
    showBanner: value.showBanner !== false,
  };
}

export function serializeApplicatorPrintOptions(options: ApplicatorPrintOptions): string {
  return JSON.stringify({
    mapPages: options.mapPages,
    includePreviousApplications: options.includePreviousApplications,
    previousApplicationsPerField: boundedInteger(options.previousApplicationsPerField, 3, 1, 5),
    blankSections: boundedInteger(options.blankSections, 0, 0, 5),
    includeBillingSplits: options.includeBillingSplits,
    showBanner: options.showBanner,
  });
}

/** Read the saved defaults. RLS/read failures deliberately retain safe local defaults. */
export async function loadApplicatorPrintOptions(): Promise<ApplicatorPrintOptions> {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', APPLICATOR_PRINT_OPTIONS_KEY)
      .maybeSingle();
    if (error) return { ...DEFAULT_APPLICATOR_PRINT_OPTIONS };
    const row = data as { setting_value?: string | null } | null;
    return parseApplicatorPrintOptions(row?.setting_value);
  } catch {
    return { ...DEFAULT_APPLICATOR_PRINT_OPTIONS };
  }
}

/** Translate the modal choice to the existing map helper's flags. */
export function mapImageOptions(mapPages: ApplicatorMapPages): { overview: boolean; perField: boolean } {
  return {
    overview: mapPages === 'overview' || mapPages === 'both',
    perField: mapPages === 'per-field' || mapPages === 'both',
  };
}
