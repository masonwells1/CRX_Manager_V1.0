/**
 * Renders a customer_facts value for display. Facts carry EITHER value_text
 * (rep-typed) OR value_json (structured, e.g. from future AI intake) — the
 * table enforces the XOR and restricts value_json to objects/arrays. Reviewers
 * must be able to read the full value before verifying, so this never hides a
 * structured value behind a placeholder.
 */
export function factValueToText(valueText: string | null | undefined, valueJson: unknown): string {
  if (valueText) return valueText;
  if (valueJson === null || valueJson === undefined) return '';
  if (typeof valueJson === 'string') return valueJson;
  if (typeof valueJson === 'number' || typeof valueJson === 'boolean') return String(valueJson);
  if (Array.isArray(valueJson)) return valueJson.map((item) => factValueToText(null, item)).join(', ');
  return Object.entries(valueJson as Record<string, unknown>)
    .map(([key, item]) => `${key.replace(/_/g, ' ')}: ${factValueToText(null, item)}`)
    .join(' · ');
}
