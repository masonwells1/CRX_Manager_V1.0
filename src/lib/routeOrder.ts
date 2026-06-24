/**
 * routeOrder — pure, framework-free array-reorder helpers for the Locations-tab
 * field list (field-app parity #5: "Field/location route-ordering").
 *
 * The deliberate field order IS the applicator's drive/route order. On Save,
 * JobDetail maps fieldRows -> { sort_order: arrayIndex }, so persisting a new
 * route order is simply persisting a new array order: these helpers produce a
 * reordered COPY of the array (never mutate in place), and the page saves it on
 * the normal Save path. `job_fields.sort_order` is the single source of truth
 * that downstream printouts (#9 Applicator Field Sheet) and the map (#16 pin
 * numbering) read for route order — see NEXT-SECTION-NOTES.
 *
 * Two input methods both route through here:
 *   - drag-and-drop (native HTML5 DnD) -> moveItem(list, from, to)
 *   - keyboard / touch up-down buttons -> moveUp / moveDown (accessible fallback)
 *
 * Pure so the reorder logic is unit-tested without mounting the page.
 */

/** Clamp an index into [0, len-1]; returns -1 for an empty list. */
function clampIndex(index: number, len: number): number {
  if (len <= 0) return -1;
  if (index < 0) return 0;
  if (index > len - 1) return len - 1;
  return index;
}

/**
 * Move the item at `from` to position `to`, returning a NEW array (the input is
 * never mutated). Out-of-range indices are clamped into the array. A no-op move
 * (same effective index, or a list with <2 items) returns a shallow copy
 * unchanged in order — callers can compare by reference if they want to skip
 * marking dirty, but JobDetail's snapshot diff already handles that.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice();
  const len = next.length;
  if (len < 2) return next;
  const fromIdx = clampIndex(from, len);
  const toIdx = clampIndex(to, len);
  if (fromIdx === toIdx) return next;
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

/** Move the item at `index` one slot earlier. No-op (copy) if already first. */
export function moveUp<T>(list: readonly T[], index: number): T[] {
  return moveItem(list, index, index - 1);
}

/** Move the item at `index` one slot later. No-op (copy) if already last. */
export function moveDown<T>(list: readonly T[], index: number): T[] {
  return moveItem(list, index, index + 1);
}
