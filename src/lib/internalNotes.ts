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
  // A fresh approval replaces every prior internal marker. Leaving an older
  // marker in the raw notes makes the database parser select the stale reason
  // for its immutable audit row on a later save.
  const base = stripInternalNotes(notes);
  // The reason is collapsed to ONE line, and that is what makes line-scoped
  // stripping safe. It is free-form textarea input, so an operator can press
  // Enter inside it; if the marker could span lines, the stripper would have to
  // either truncate everything after it (hiding customer notes typed later) or
  // risk printing the tail of a reason. Collapsing at the single point of
  // writing removes the dilemma instead of trading one leak for the other.
  // (Codex round 31.)
  const oneLine = reason.replace(/\s+/g, ' ').trim();
  return base
    ? `${base}\n${BELOW_COST_APPROVAL_PREFIX} ${oneLine}`
    : `${BELOW_COST_APPROVAL_PREFIX} ${oneLine}`;
}

/**
 * Remove internal-only annotations from a notes value bound for a customer
 * document. Returns null when nothing customer-visible remains, so callers can
 * skip the notes block entirely rather than printing an empty heading.
 *
 * Removal is LINE-SCOPED, not truncate-from-the-marker. Truncating hid anything
 * an operator typed after an approval was already recorded — the marker stays
 * in the raw notes field, so a delivery instruction added on a later edit lands
 * below it and would silently vanish from the customer's copy while still
 * looking present in the editor. Line-scoping is only safe because
 * `appendBelowCostApproval` collapses the reason to a single line; a reason can
 * therefore never continue onto the following line and leak.
 *
 * An em-dash-separated marker (the bulk-import form, `notes — marker: reason`)
 * has no newline of its own, so within a line the text from the marker onward
 * is dropped and the separator trimmed off what remains.
 */
export function stripInternalNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;

  const visibleLines: string[] = [];
  for (const line of notes.split('\n')) {
    let cut = line.length;
    for (const prefix of INTERNAL_PREFIXES) {
      const at = line.indexOf(prefix);
      if (at !== -1 && at < cut) cut = at;
    }
    // Drop the separator that joined the marker to the notes before it on this
    // line. A single character class, not an alternation of quantified groups:
    // `(\n|\s+—\s*)+` nests a quantifier inside a quantified group over
    // overlapping input, which backtracks exponentially on a long run of
    // separators — and `notes` is free-form operator input (CodeQL alert 17).
    const visible = line.slice(0, cut).replace(/[\s—]+$/, '');
    if (cut === line.length || visible.length > 0) visibleLines.push(visible);
  }

  const result = visibleLines.join('\n').trim();
  return result.length > 0 ? result : null;
}
