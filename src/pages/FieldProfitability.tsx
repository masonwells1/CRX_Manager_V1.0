import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Loader2 } from 'lucide-react';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { assertRpcResult, supabase } from '../lib/db';
import { exportToCSV } from '../lib/csvExport';
import { formatCents } from '../lib/money';
import { computeSeason } from '../utils/season';
import type { FieldProfitabilityRow } from '../types';

type SortKey = keyof Pick<
  FieldProfitabilityRow,
  | 'customer_name'
  | 'field_name'
  | 'season'
  | 'total_acres_applied'
  | 'revenue_cents'
  | 'cost_cents'
  | 'margin_cents'
  | 'margin_per_acre_cents'
>;

interface SortState {
  key: SortKey;
  direction: 'asc' | 'desc';
}

const numericKeys = new Set<SortKey>([
  'total_acres_applied',
  'revenue_cents',
  'cost_cents',
  'margin_cents',
  'margin_per_acre_cents',
]);

const headers: Array<{ key: SortKey; label: string; align?: 'right' }> = [
  { key: 'customer_name', label: 'Customer' },
  { key: 'field_name', label: 'Field' },
  { key: 'season', label: 'Season' },
  { key: 'total_acres_applied', label: 'Acres Applied', align: 'right' },
  { key: 'revenue_cents', label: 'Revenue', align: 'right' },
  { key: 'cost_cents', label: 'Cost', align: 'right' },
  { key: 'margin_cents', label: 'Margin', align: 'right' },
  { key: 'margin_per_acre_cents', label: 'Margin / Acre', align: 'right' },
];

function normalizeRow(row: FieldProfitabilityRow): FieldProfitabilityRow {
  return {
    ...row,
    total_acres_applied: Number(row.total_acres_applied) || 0,
    revenue_cents: Number(row.revenue_cents) || 0,
    cost_cents: Number(row.cost_cents) || 0,
    margin_cents: Number(row.margin_cents) || 0,
    margin_per_acre_cents: Number(row.margin_per_acre_cents) || 0,
  };
}

export default function FieldProfitability() {
  const { toast } = useToast();
  const currentSeason = computeSeason();
  const seasonOptions = useMemo(
    () => Array.from({ length: 5 }, (_, index) => String(currentSeason - index)),
    [currentSeason],
  );
  const [selectedSeason, setSelectedSeason] = useState<string | null>(String(currentSeason));
  const [rows, setRows] = useState<FieldProfitabilityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortState>({ key: 'margin_cents', direction: 'desc' });

  useEffect(() => {
    let active = true;

    async function loadReport() {
      setLoading(true);
      try {
        const { data, error } = await supabase.rpc(
          'get_field_profitability' as never,
          { p_season: selectedSeason } as never,
        );
        if (error) throw error;

        const result = assertRpcResult<FieldProfitabilityRow[]>(data, 'get_field_profitability');
        if (active) setRows(result.map(normalizeRow));
      } catch (_error: unknown) {
        if (active) {
          setRows([]);
          toast('error', 'Failed to load field profitability.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadReport();
    return () => {
      active = false;
    };
  }, [selectedSeason, toast]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((left, right) => {
      const comparison = numericKeys.has(sort.key)
        ? Number(left[sort.key]) - Number(right[sort.key])
        : String(left[sort.key]).localeCompare(String(right[sort.key]), undefined, {
            numeric: true,
            sensitivity: 'base',
          });
      return sort.direction === 'asc' ? comparison : -comparison;
    });
  }, [rows, sort]);

  const totals = useMemo(
    () => rows.reduce(
      (sum, row) => ({
        acres: sum.acres + row.total_acres_applied,
        revenueCents: sum.revenueCents + row.revenue_cents,
        costCents: sum.costCents + row.cost_cents,
        marginCents: sum.marginCents + row.margin_cents,
      }),
      { acres: 0, revenueCents: 0, costCents: 0, marginCents: 0 },
    ),
    [rows],
  );

  const totalMarginPerAcreCents = totals.acres > 0
    ? Math.trunc(totals.marginCents / totals.acres)
    : 0;

  function changeSort(key: SortKey) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
  }

  function sortIcon(key: SortKey) {
    if (sort.key !== key) return <ArrowUpDown className="h-3.5 w-3.5" />;
    return sort.direction === 'asc'
      ? <ArrowUp className="h-3.5 w-3.5" />
      : <ArrowDown className="h-3.5 w-3.5" />;
  }

  function handleExport() {
    exportToCSV(
      sortedRows,
      [
        { key: 'customer_name', header: 'Customer' },
        { key: 'field_name', header: 'Field' },
        { key: 'season', header: 'Season' },
        { key: 'total_acres_applied', header: 'Acres Applied' },
        { key: 'revenue_cents', header: 'Revenue', format: (value) => formatCents(Number(value)) },
        { key: 'cost_cents', header: 'Cost', format: (value) => formatCents(Number(value)) },
        { key: 'margin_cents', header: 'Margin', format: (value) => formatCents(Number(value)) },
        { key: 'margin_per_acre_cents', header: 'Margin per Acre', format: (value) => formatCents(Number(value)) },
      ],
      `field_profitability_${selectedSeason ?? 'all_seasons'}`,
    );
    toast('success', 'Field profitability CSV exported.');
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <SplitHeading title="Field" accent="Profitability" />
          <p className="mt-1 text-sm text-secondary">
            Posted field-application revenue, cost, and margin allocated by field.
          </p>
        </div>
        <Button
          variant="secondary"
          icon={<Download className="h-4 w-4" />}
          showChevron={false}
          onClick={handleExport}
          disabled={rows.length === 0}
        >
          Export CSV
        </Button>
      </div>

      <Card>
        <label htmlFor="field-profitability-season" className="mb-1 block text-xs font-medium text-secondary">
          Season
        </label>
        <select
          id="field-profitability-season"
          value={selectedSeason ?? 'all'}
          onChange={(event) => setSelectedSeason(event.target.value === 'all' ? null : event.target.value)}
          className="min-w-48 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
        >
          {seasonOptions.map((season) => <option key={season} value={season}>{season}</option>)}
          <option value="all">All seasons</option>
        </select>
      </Card>

      <Card padding={false}>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-secondary">
            <Loader2 className="h-5 w-5 animate-spin text-crx-green" />
            Loading field profitability…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center">
            <p className="font-medium text-nav-dark">No field profitability data</p>
            <p className="mt-1 text-sm text-secondary">No posted field-application invoices match this season.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-secondary">
                <tr>
                  {headers.map((header) => (
                    <th key={header.key} scope="col" className={`px-4 py-3 ${header.align === 'right' ? 'text-right' : 'text-left'}`}>
                      <button
                        type="button"
                        onClick={() => changeSort(header.key)}
                        className={`inline-flex items-center gap-1 font-semibold hover:text-nav-dark ${header.align === 'right' ? 'w-full justify-end' : ''}`}
                      >
                        {header.label}
                        {sortIcon(header.key)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sortedRows.map((row) => (
                  <tr key={`${row.field_id ?? `unassigned-${row.customer_id}`}-${row.season}`} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-nav-dark">{row.customer_name}</td>
                    <td className="px-4 py-3 text-nav-dark">{row.field_name}</td>
                    <td className="px-4 py-3 text-secondary">{row.season}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{row.total_acres_applied.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatCents(row.revenue_cents)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatCents(row.cost_cents)}</td>
                    <td className={`px-4 py-3 text-right font-medium tabular-nums ${row.margin_cents < 0 ? 'text-red-600' : 'text-crx-green'}`}>{formatCents(row.margin_cents)}</td>
                    <td className={`px-4 py-3 text-right font-medium tabular-nums ${row.margin_per_acre_cents < 0 ? 'text-red-600' : 'text-crx-green'}`}>{formatCents(row.margin_per_acre_cents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-gray-200 bg-gray-50 font-semibold text-nav-dark">
                <tr>
                  <td colSpan={3} className="px-4 py-3">Totals</td>
                  <td className="px-4 py-3 text-right tabular-nums">{totals.acres.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatCents(totals.revenueCents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatCents(totals.costCents)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${totals.marginCents < 0 ? 'text-red-600' : 'text-crx-green'}`}>{formatCents(totals.marginCents)}</td>
                  <td className={`px-4 py-3 text-right tabular-nums ${totalMarginPerAcreCents < 0 ? 'text-red-600' : 'text-crx-green'}`}>{formatCents(totalMarginPerAcreCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
