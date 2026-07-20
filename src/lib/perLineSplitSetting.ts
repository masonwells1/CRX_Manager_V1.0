export const PER_LINE_SPLIT_SETTING_KEY = 'feature_per_line_split_billing';
export const DEFAULT_PER_LINE_SPLIT_ENABLED = false;

/** Fail-safe parser: only the exact server literal `true` enables the new path. */
export function parsePerLineSplitEnabled(raw: string | null | undefined): boolean {
  return raw === 'true';
}

/** Parse a UI percentage into integer micro-percent without floating-point math. */
export function parsePercentToMicro(raw: string): number | null {
  if (!/^\d{0,3}(?:\.\d{0,6})?$/.test(raw) || raw === '' || raw === '.') return null;
  const [wholeRaw = '0', fractionRaw = ''] = raw.split('.');
  const whole = Number.parseInt(wholeRaw || '0', 10);
  const fraction = Number.parseInt(fractionRaw.padEnd(6, '0') || '0', 10);
  const micro = whole * 1_000_000 + fraction;
  return micro <= 100_000_000 ? micro : null;
}

export function perLineBillingModeBlocker(
  enabled: boolean | null,
  growerShareFields: string[],
  jobId: string | null | undefined,
  modeACheckReady = true,
): string | null {
  if (enabled === null) return 'The per-line billing mode could not be verified. Reload before continuing.';
  if (!enabled) return null;
  if (!modeACheckReady) return 'Grower-share Mode A status could not be verified. Reload before continuing.';
  if (growerShareFields.length > 0) return `Per-line billing cannot save grower-share Mode A fields: ${growerShareFields.join(', ')}.`;
  if (!jobId) return 'Per-line billing requires a source job.';
  return null;
}
