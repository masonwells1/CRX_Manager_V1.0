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
 * The reason is collected in a free-form textarea, so it can itself contain
 * newlines or an em dash. Splitting the value into segments and dropping the
 * one that starts with the marker would therefore keep the rest of a multi-line
 * reason ("Below-cost approved: price match\ncustomer threatened to leave"
 * would print the second line). Because `appendBelowCostApproval` always puts
 * the marker last, everything from the first marker onward is internal — so we
 * truncate there rather than filter segments, and the reason's own formatting
 * cannot leak any part of itself.
 */
export function stripInternalNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;

  let cut = notes.length;
  for (const prefix of INTERNAL_PREFIXES) {
    const at = notes.indexOf(prefix);
    if (at !== -1 && at < cut) cut = at;
  }

  // Drop the separator that joined the marker to the preceding notes. A single
  // character class, not an alternation of quantified groups: `(\n|\s+—\s*)+`
  // nests a quantifier inside a quantified group over overlapping input (`\n`
  // is itself `\s`), which backtracks exponentially on a long run of newlines
  // and em dashes — and `notes` is free-form operator input (CodeQL alert 17).
  // .trim() as well: the character class only strips the TRAILING separator, so
  // without it leading whitespace on the operator's own notes would survive into
  // the customer document. Both passes are linear.
  const visible = notes.slice(0, cut).replace(/[\s—]+$/, '').trim();
  return visible.length > 0 ? visible : null;
}
