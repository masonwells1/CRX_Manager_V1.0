export interface JobFieldRouteOrderField {
  id: string;
  field_name: string;
  sort_order: number | null;
}

function compareRouteOrder(a: JobFieldRouteOrderField, b: JobFieldRouteOrderField): number {
  if (a.sort_order === null && b.sort_order !== null) return 1;
  if (a.sort_order !== null && b.sort_order === null) return -1;

  if (a.sort_order !== b.sort_order) {
    return (a.sort_order ?? 0) - (b.sort_order ?? 0);
  }

  return a.field_name.localeCompare(b.field_name);
}

/** Return 1-based route labels without mutating the input array. */
export function getJobFieldRouteNumbers(
  fields: readonly JobFieldRouteOrderField[]
): Map<string, string> {
  return new Map(
    [...fields]
      .sort(compareRouteOrder)
      .map((field, index) => [field.id, String(index + 1)])
  );
}
