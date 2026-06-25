// The PURE in-table search + sort the DataTable applies to its `data` before
// rendering. Lives in its own module (not in the DataTable component file) so a
// non-component caller — e.g. the job-list PRINT path (#15) — can reproduce the
// EXACT rows and order the table is showing (the in-table search box + the
// clicked column sort), guaranteeing paper == screen. DataTable uses this same
// function internally; keep them in lock-step.

export type SortDir = 'asc' | 'desc';

export function applyTableSearchSort<T extends object>(
  data: T[],
  searchKeys: string[],
  search: string,
  sortKey: string | null,
  sortDir: SortDir
): T[] {
  const get = (row: T, key: string): unknown => (row as Record<string, unknown>)[key];
  let result = data;
  if (search && searchKeys.length > 0) {
    const lower = search.toLowerCase();
    result = result.filter((row) =>
      searchKeys.some((key) => {
        const val = get(row, key);
        return val != null && String(val).toLowerCase().includes(lower);
      })
    );
  }
  if (sortKey) {
    result = [...result].sort((a, b) => {
      const aVal = get(a, sortKey);
      const bVal = get(b, sortKey);
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
      }
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }
  return result;
}
