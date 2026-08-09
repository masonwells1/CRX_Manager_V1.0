/**
 * Internal-only annotations that live inside a customer-visible notes field.
 *
 * The below-cost approval reason has to be durable — it is the record of who
 * accepted a sale under cost and why — so it is written onto the entity itself
 * rather than only into an activity log that can fail independently of the
 * write it describes. There is no internal-notes column on orders, invoice
 * items, or quote items today, so it rides along in `notes`.
 *
 * That field is also printed on customer-facing documents. An approval reason
 * is exactly the kind of thing that must not reach a grower: "matched Helena's
 * price", "clearance", "goodwill after the spray complaint". Every customer-
 * facing PDF must therefore run its notes through `stripInternalNotes` before
 * rendering. Internal documents (pick lists, loader worksheets) may print the
 * raw value.
 *
 * Writers must use `BELOW_COST_APPROVAL_PREFIX` rather than repeating the
 * literal, so the stripper cannot drift out of sync with the writers.
 */

export const BELOW_COST_APPROVAL_PREFIX = 'Below-cost approved:';

/** Every internal marker recognized by `stripInternalNotes`. */
const INTERNAL_PREFIXES = [BELOW_COST_APPROVAL_PREFIX];

/**
 * Compose a notes value carrying an internal approval reason.
 * Kept here so the separator and prefix match what the stripper expects.
 */
export function appendBelowCostApproval(notes: string | null | undefined, reason: string): string {
  const base = notes?.trim();
  return base
    ? `${base}\n${BELOW_COST_APPROVAL_PREFIX} ${reason}`
    : `${BELOW_COST_APPROVAL_PREFIX} ${reason}`;
}

/**
 * Remove internal-only annotations from a notes value bound for a customer
 * document. Returns null when nothing customer-visible remains, so callers can
 * skip the notes block entirely rather than printing an empty heading.
 *
 * Splits on both newline and the em-dash separator used by the bulk import
 * path, and drops any segment that opens with an internal marker.
 */
export function stripInternalNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;

  const kept = notes
    .split(/\n|\s+—\s+/)
    .filter((segment) => {
      const trimmed = segment.trim();
      if (!trimmed) return false;
      return !INTERNAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
    })
    .map((segment) => segment.trim());

  return kept.length > 0 ? kept.join('\n') : null;
}
