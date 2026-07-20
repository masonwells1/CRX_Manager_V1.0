import type { PerLineBillingOptions, PerLineBillingPlanLine } from '../../types';
import { formatCents } from '../../lib/money';
import { parseDollarsToCents } from '../../lib/parseCents';
import { parsePercentToMicro } from '../../lib/perLineSplitSetting';

interface Props {
  lines: PerLineBillingPlanLine[];
  options: PerLineBillingOptions;
  onChange: (options: PerLineBillingOptions) => void;
  customerNames: Record<string, string>;
  readOnly?: boolean;
}

export default function PerLineSplitEditor({ lines, options, onChange, customerNames, readOnly = false }: Props) {
  const patchLine = (lineKey: string, patch: Record<string, unknown>) => {
    const current = options.lines.find((line) => line.line_key === lineKey) ?? { line_key: lineKey };
    onChange({ lines: [...options.lines.filter((line) => line.line_key !== lineKey), { ...current, ...patch }] });
  };

  return (
    <details className="border rounded-lg bg-gray-50" open={options.lines.length > 0}>
      <summary className="cursor-pointer px-4 py-3 font-medium">Advanced per-line split and price overrides</summary>
      <div className="p-4 pt-0 space-y-4">
        <p className="text-xs text-gray-600">
          Every customer and effective price is shown. Custom percentages must total 100%; every override requires a reason, then Preview again before Save.
        </p>
        {lines.map((line) => {
          const override = options.lines.find((entry) => entry.line_key === line.line_key);
          return (
            <div key={line.line_key} className="border rounded bg-white p-3 space-y-2">
              <div className="font-medium">{line.description}</div>
              {line.shares.map((share) => {
                const vector = override?.vector?.find((entry) => entry.customer_id === share.customer_id);
                const price = override?.price_overrides?.find((entry) => entry.customer_id === share.customer_id);
                return (
                  <div key={share.customer_id} className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end text-sm">
                    <div>
                      <span className="block text-xs text-gray-500">Customer</span>
                      {customerNames[share.customer_id] ?? `${share.customer_id.slice(0, 8)}…`}
                    </div>
                    <label>
                      <span className="block text-xs text-gray-500">Split %</span>
                      <input className="w-full border rounded px-2 py-1" type="number" min="0" max="100" step="0.000001"
                        disabled={readOnly} value={(vector?.split_micro_pct ?? share.split_micro_pct) / 1_000_000}
                        onChange={(event) => {
                          const parsedMicro = parsePercentToMicro(event.target.value);
                          if (parsedMicro === null) return;
                          const next = line.shares.map((candidate) => ({
                            customer_id: candidate.customer_id,
                            split_micro_pct: candidate.customer_id === share.customer_id
                              ? parsedMicro
                              : (override?.vector?.find((entry) => entry.customer_id === candidate.customer_id)?.split_micro_pct ?? candidate.split_micro_pct),
                          }));
                          patchLine(line.line_key, { split_mode: 'custom', vector: next });
                        }} />
                    </label>
                    {line.line_kind !== 'flat_fee' ? <label>
                      <span className="block text-xs text-gray-500">Unit price (current {formatCents(share.unit_price_cents)})</span>
                      <input className="w-full border rounded px-2 py-1" type="number" min="0" step="0.01" disabled={readOnly}
                        placeholder={(share.unit_price_cents / 100).toFixed(2)}
                        value={price ? (price.unit_price_cents / 100).toFixed(2) : ''}
                        onChange={(event) => {
                          const others = override?.price_overrides?.filter((entry) => entry.customer_id !== share.customer_id) ?? [];
                          const value = event.target.value;
                          patchLine(line.line_key, { price_overrides: value === '' ? others : [...others, {
                            customer_id: share.customer_id,
                            unit_price_cents: parseDollarsToCents(value),
                            reason: price?.reason ?? '',
                          }] });
                        }} />
                    </label> : <div className="text-xs text-gray-500 pb-2">Fixed fee price is allocated by split %.</div>}
                    {line.line_kind !== 'flat_fee' ? <label>
                      <span className="block text-xs text-gray-500">Price reason</span>
                      <input className="w-full border rounded px-2 py-1" disabled={readOnly || !price} value={price?.reason ?? ''}
                        onChange={(event) => patchLine(line.line_key, { price_overrides: (override?.price_overrides ?? []).map((entry) => entry.customer_id === share.customer_id ? { ...entry, reason: event.target.value } : entry) })} />
                    </label> : <div />}
                  </div>
                );
              })}
              {override?.vector && (
                <label className="block text-sm">
                  <span className="block text-xs text-gray-500">Custom split reason</span>
                  <input className="w-full border rounded px-2 py-1" disabled={readOnly} value={override.split_override_reason ?? ''}
                    onChange={(event) => patchLine(line.line_key, { split_override_reason: event.target.value })} />
                </label>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}
