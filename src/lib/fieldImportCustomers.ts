/**
 * Pure helpers for per-field customer assignment on the shapefile importer (SOW-F3).
 * Kept out of the component file so they unit-test cleanly and don't trip React fast-refresh.
 */

export interface AssignableField {
  /** 1-based feature index — matches ParsedImportField.index. */
  index: number;
  name: string;
  acres: number;
}

/** Resolve the customer a given field will import as: its own assignment, else the fallback. */
export function resolveFieldCustomerId(
  index: number,
  assignments: Record<number, string>,
  fallbackCustomerId: string | null | undefined,
): string | null {
  return assignments[index] || fallbackCustomerId || null;
}

/** True only when every field resolves to a customer (gates leaving the assignment step). */
export function allFieldsAssigned(
  fields: AssignableField[],
  assignments: Record<number, string>,
  fallbackCustomerId: string | null | undefined,
): boolean {
  return fields.every((f) => !!resolveFieldCustomerId(f.index, assignments, fallbackCustomerId));
}
