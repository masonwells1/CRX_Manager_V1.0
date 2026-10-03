import { useState, useMemo, type ReactNode } from 'react';
import { Search, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import EmptyState from './EmptyState';
import { applyTableSearchSort, type SortDir } from '../../lib/tableSearchSort';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  searchable?: boolean;
  searchPlaceholder?: string;
  searchKeys?: string[];
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  filters?: ReactNode;
  loading?: boolean;
  /**
   * Optional CONTROLLED search/sort. When provided, the parent owns the in-table
   * search term and column sort (so it can reuse `applyTableSearchSort` to print
   * the exact displayed rows). When omitted, the table keeps its own internal
   * state — every existing caller is unaffected.
   */
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  sortState?: { key: string | null; dir: SortDir };
  onSortChange?: (next: { key: string | null; dir: SortDir }) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function DataTable<T extends Record<string, any>>({
  data,
  columns,
  searchable = false,
  searchPlaceholder = 'Search...',
  searchKeys = [],
  onRowClick,
  emptyTitle = 'No data found',
  emptyDescription,
  emptyAction,
  filters,
  loading = false,
  searchValue,
  onSearchChange,
  sortState,
  onSortChange,
}: DataTableProps<T>) {
  // Internal fallback state — used only when the caller doesn't control it.
  const [searchInner, setSearchInner] = useState('');
  const [sortKeyInner, setSortKeyInner] = useState<string | null>(null);
  const [sortDirInner, setSortDirInner] = useState<SortDir>('asc');

  const controlledSearch = searchValue !== undefined && onSearchChange !== undefined;
  const controlledSort = sortState !== undefined && onSortChange !== undefined;

  const search = controlledSearch ? searchValue : searchInner;
  const setSearch = controlledSearch ? onSearchChange : setSearchInner;
  const sortKey = controlledSort ? sortState.key : sortKeyInner;
  const sortDir = controlledSort ? sortState.dir : sortDirInner;

  const filtered = useMemo(
    () => applyTableSearchSort(data, searchKeys, search, sortKey, sortDir),
    [data, searchKeys, search, sortKey, sortDir]
  );

  const toggleSort = (key: string) => {
    const nextDir: SortDir = sortKey === key && sortDir === 'asc' ? 'desc' : 'asc';
    const next = sortKey === key ? { key, dir: nextDir } : { key, dir: 'asc' as SortDir };
    if (controlledSort) {
      onSortChange(next);
    } else {
      setSortKeyInner(next.key);
      setSortDirInner(next.dir);
    }
  };

  return (
    <div>
      {(searchable || filters) && (
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          {searchable && (
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg
                  focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green
                  transition-colors"
              />
            </div>
          )}
          {filters && <div className="flex gap-2 flex-wrap">{filters}</div>}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={emptyTitle}
          description={emptyDescription}
          action={emptyAction}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-cream-dark/50">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={`px-4 py-3 text-left font-medium text-secondary ${col.className || ''}`}
                  >
                    {col.sortable ? (
                      <button
                        onClick={() => toggleSort(col.key)}
                        aria-label={`Sort by ${typeof col.header === 'string' ? col.header : col.key}${sortKey === col.key ? (sortDir === 'asc' ? ', sorted ascending' : ', sorted descending') : ''}`}
                        className="inline-flex items-center gap-1 hover:text-nav-dark transition-colors"
                      >
                        {col.header}
                        {sortKey === col.key ? (
                          sortDir === 'asc' ? (
                            <ArrowUp className="w-3.5 h-3.5" />
                          ) : (
                            <ArrowDown className="w-3.5 h-3.5" />
                          )
                        ) : (
                          <ArrowUpDown className="w-3.5 h-3.5 opacity-40" />
                        )}
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, idx) => (
                <tr
                  key={idx}
                  onClick={() => onRowClick?.(row)}
                  onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); } } : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  className={`
                    border-b border-gray-100 transition-colors even:bg-gray-50/50
                    ${onRowClick ? 'cursor-pointer hover:bg-crx-green-tint focus:outline-none focus:ring-2 focus:ring-crx-green/30' : ''}
                  `}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={`px-4 py-3 ${col.className || ''}`}>
                      {col.render
                        ? col.render(row)
                        : (row[col.key] as ReactNode) ?? '-'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
