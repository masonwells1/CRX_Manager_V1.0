import { useEffect, useMemo, useState } from 'react';
import Badge from '../ui/Badge';
import Card, { CardHeader } from '../ui/Card';
import Select from '../ui/Select';
import { sanitizeError } from '../../lib/errorSanitizer';
import {
  formatSupplierCents,
  getProductPriceHistory,
  type SupplierPriceHistory,
  type SupplierPriceHistoryPoint,
} from '../../lib/supplierPricing';

const streamLabels: Record<SupplierPriceHistoryPoint['stream'], string> = {
  supplier_observation: 'Supplier observation',
  selected_cost_basis: 'Selected cost basis',
  actual_purchase: 'Actual paid',
};

const streamColors: Record<SupplierPriceHistoryPoint['stream'], string> = {
  supplier_observation: '#2563eb',
  selected_cost_basis: '#15803d',
  actual_purchase: '#c2410c',
};

function chartPosition(
  value: bigint,
  minimum: bigint,
  maximum: bigint,
): number {
  if (maximum === minimum) return 50;
  return 90 - (Number(((value - minimum) * 800n) / (maximum - minimum)) / 10);
}

export default function ProductPriceHistory({ productId }: { productId: string }) {
  const [history, setHistory] = useState<SupplierPriceHistory | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getProductPriceHistory(productId)
      .then((result) => {
        if (active) setHistory(result);
      })
      .catch((reason) => {
        if (active) setError(sanitizeError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [productId]);

  const points = useMemo(() => {
    const all = history?.points ?? [];
    if (!supplierId) return all;
    return all.filter((point) => (
      point.stream === 'selected_cost_basis' || point.vendor_id === supplierId
    ));
  }, [history, supplierId]);

  const plotted = useMemo(() => points.map((point) => ({
    point,
    value: point.normalized_cost_cents ?? point.cost_cents,
  })), [points]);
  const minimum = plotted.reduce<bigint | null>(
    (current, item) => current === null || item.value < current ? item.value : current,
    null,
  );
  const maximum = plotted.reduce<bigint | null>(
    (current, item) => current === null || item.value > current ? item.value : current,
    null,
  );
  const selectedBasis = [...(history?.points ?? [])]
    .reverse()
    .find((point) => point.stream === 'selected_cost_basis') ?? null;

  return (
    <Card>
      <CardHeader title="Supplier Price" accent="History" />
      <Select
        label="Filter supplier"
        value={supplierId}
        onChange={(event) => setSupplierId(event.target.value)}
        placeholder="All suppliers"
        options={(history?.suppliers ?? []).map((supplier) => ({
          value: supplier.id,
          label: supplier.name,
        }))}
      />

      {history && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-blue-700">Replacement cost</p>
            <p className="mt-1 font-semibold tabular-nums text-nav-dark">
              {formatSupplierCents(history.summary.replacement_cost_cents)}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {history.summary.best_supplier || 'No comparable supplier'}
              {history.summary.replacement_cost_as_of
                ? ` · ${new Date(history.summary.replacement_cost_as_of).toLocaleDateString()}`
                : ''}
            </p>
          </div>
          <div className="rounded-lg border border-green-100 bg-green-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-green-700">Selected cost basis</p>
            <p className="mt-1 font-semibold tabular-nums text-nav-dark">
              {formatSupplierCents(selectedBasis?.cost_cents ?? null)}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {selectedBasis ? new Date(selectedBasis.occurred_at).toLocaleDateString() : 'No history captured'}
            </p>
          </div>
          <div className="rounded-lg border border-orange-100 bg-orange-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-orange-700">Last paid (received PO)</p>
            <p className="mt-1 font-semibold tabular-nums text-nav-dark">
              {formatSupplierCents(history.summary.last_paid_cents)}
            </p>
            <p className="mt-1 text-xs text-secondary">
              {history.summary.last_paid_as_of
                ? new Date(history.summary.last_paid_as_of).toLocaleDateString()
                : 'No received purchase'}
            </p>
          </div>
          <div className="rounded-lg border border-purple-100 bg-purple-50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-purple-700">Recent-PO weighted average</p>
            <p className="mt-1 font-semibold tabular-nums text-nav-dark">
              {formatSupplierCents(history.summary.recent_po_weighted_average_cents)}
            </p>
            <p className="mt-1 text-xs text-secondary">Trailing 12 months · received quantities</p>
          </div>
        </div>
      )}

      {loading && <p className="mt-4 text-sm text-secondary">Loading supplier and purchase evidence…</p>}
      {error && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Supplier history is unavailable: {error}
        </div>
      )}
      {!loading && !error && points.length === 0 && (
        <p className="mt-4 text-sm text-secondary">No supplier observations, selected cost basis, or purchase facts yet.</p>
      )}

      {!loading && !error && plotted.length > 0 && minimum !== null && maximum !== null && (
        <>
          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
            <svg
              role="img"
              aria-label="Product supplier price history chart"
              viewBox="0 0 100 100"
              className="h-40 w-full overflow-visible"
              preserveAspectRatio="none"
            >
              <line x1="5" x2="95" y1="90" y2="90" stroke="#d1d5db" strokeWidth="0.7" />
              <line x1="5" x2="5" y1="10" y2="90" stroke="#d1d5db" strokeWidth="0.7" />
              {plotted.map(({ point, value }, index) => {
                const x = plotted.length === 1 ? 50 : 5 + ((index * 90) / (plotted.length - 1));
                const y = chartPosition(value, minimum, maximum);
                return (
                  <circle
                    key={`${point.stream}:${point.source_id}`}
                    cx={x}
                    cy={y}
                    r="2.2"
                    vectorEffect="non-scaling-stroke"
                    fill={streamColors[point.stream]}
                  >
                    <title>{`${streamLabels[point.stream]}: ${formatSupplierCents(value)} on ${new Date(point.occurred_at).toLocaleDateString()}`}</title>
                  </circle>
                );
              })}
            </svg>
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-secondary">
              {Object.entries(streamLabels).map(([stream, label]) => (
                <span key={stream} className="inline-flex items-center gap-1">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: streamColors[stream as keyof typeof streamColors] }} />
                  {label}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-4 max-h-96 space-y-3 overflow-y-auto">
            {[...points].reverse().map((point) => (
              <div key={`${point.stream}:${point.source_id}`} className="border-b border-gray-100 pb-3 last:border-0">
                <div className="flex items-start justify-between gap-3">
                  <span>
                    <Badge variant={point.stream === 'selected_cost_basis' ? 'success' : point.stream === 'actual_purchase' ? 'warning' : 'info'}>
                      {streamLabels[point.stream]}
                    </Badge>
                    <span className="ml-2 text-sm font-medium text-nav-dark">
                      {point.supplier_name || (point.stream === 'actual_purchase' ? 'supplier unknown' : 'CRX selected basis')}
                    </span>
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-nav-dark">
                    {formatSupplierCents(point.normalized_cost_cents ?? point.cost_cents)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-secondary">
                  {new Date(point.occurred_at).toLocaleDateString()} · {point.detail.replace(/_/g, ' ')}
                  {point.normalized_cost_cents === null && point.stream === 'supplier_observation'
                    ? ' · package quote cannot be normalized'
                    : ''}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
