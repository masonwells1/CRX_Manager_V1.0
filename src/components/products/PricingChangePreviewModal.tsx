import type { PricingEffect, PricingPreviewResult, PricingPreviewRow } from '../../lib/productPricing';
import Button from '../ui/Button';
import Modal from '../ui/Modal';

interface PricingChangePreviewModalProps {
  open: boolean;
  preview: PricingPreviewResult | null;
  applying: boolean;
  title?: string;
  onClose: () => void;
  onApprove: () => void;
}

const ERROR_MESSAGES: Record<string, string> = {
  PRICING_ROW_CONFLICT:
    'This product changed after the pricing data was loaded. Refresh the product and preview it again.',
  WORKBOOK_FORMULA_REJECTED:
    'This row contains an Excel formula. Replace the formula with a plain value and upload the worksheet again.',
  WORKBOOK_IDENTITY_OR_BASELINE_TAMPERED:
    'Protected product or baseline pricing details no longer match the exported worksheet.',
  WORKBOOK_BLANK_MODE_CHANGED_VALUES:
    'Pricing values changed, but no pricing mode was selected for this row.',
};

const STATUS_LABELS: Record<PricingPreviewRow['row_status'], string> = {
  ready: 'Ready',
  conflict: 'Conflict',
  invalid: 'Invalid',
  unchanged: 'Unchanged',
};

const STATUS_CLASSES: Record<PricingPreviewRow['row_status'], string> = {
  ready: 'bg-green-50 text-green-700 border-green-200',
  conflict: 'bg-amber-50 text-amber-800 border-amber-200',
  invalid: 'bg-red-50 text-red-700 border-red-200',
  unchanged: 'bg-gray-50 text-gray-600 border-gray-200',
};

function readableError(errorCode: string | null): string | null {
  if (!errorCode) return null;
  if (ERROR_MESSAGES[errorCode]) return ERROR_MESSAGES[errorCode];

  const words = errorCode.toLowerCase().split('_').join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

function submittedValue(row: PricingPreviewRow, key: string): string | null {
  const value = row.submitted_row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function productLabel(row: PricingPreviewRow): { name: string; detail: string | null } {
  const productName = row.effect?.product_name ?? submittedValue(row, 'product_name');
  const sku = row.effect?.sku ?? submittedValue(row, 'sku');
  const productId = row.product_id ?? submittedValue(row, 'product_id');

  return {
    name: productName ?? sku ?? productId ?? 'Unknown product',
    detail: productName && sku ? `SKU ${sku}` : productName && productId ? productId : null,
  };
}

function ChangePair({ oldValue, newValue }: { oldValue: string; newValue: string }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <span className="text-gray-500 line-through">{oldValue}</span>
      <span aria-hidden="true" className="text-gray-400">→</span>
      <span className="font-semibold text-nav-dark">{newValue}</span>
    </span>
  );
}

function displayDollars(value: string | null): string {
  return value === null ? '—' : `$${value}`;
}

function displayMargin(value: string | null): string {
  return value === null ? '—' : `${value}%`;
}

function displayPerAcre(value: bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const wholeDollars = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${wholeDollars}.${cents} / acre`;
}

function PricingEffectDetails({ effect }: { effect: PricingEffect }) {
  const before = effect.before;
  const tiers = [
    {
      label: 'Tier 1',
      oldPrice: before?.tier1_price ?? null,
      price: effect.tier1_price,
      oldMarginPercent: before?.tier1_margin_percent ?? null,
      marginPercent: effect.tier1_margin_percent,
      margin: effect.tier1_margin,
      grossMargin: effect.tier1_gross_margin,
      oldPerAcreCents: before?.tier1_price_per_acre_cents,
      perAcreCents: effect.tier1_price_per_acre_cents,
    },
    {
      label: 'Tier 2',
      oldPrice: before?.tier2_price ?? null,
      price: effect.tier2_price,
      oldMarginPercent: before?.tier2_margin_percent ?? null,
      marginPercent: effect.tier2_margin_percent,
      margin: effect.tier2_margin,
      grossMargin: effect.tier2_gross_margin,
      oldPerAcreCents: before?.tier2_price_per_acre_cents,
      perAcreCents: effect.tier2_price_per_acre_cents,
    },
    {
      label: 'Tier 3',
      oldPrice: before?.tier3_price ?? null,
      price: effect.tier3_price,
      oldMarginPercent: before?.tier3_margin_percent ?? null,
      marginPercent: effect.tier3_margin_percent,
      margin: effect.tier3_margin,
      grossMargin: effect.tier3_gross_margin,
      oldPerAcreCents: before?.tier3_price_per_acre_cents,
      perAcreCents: effect.tier3_price_per_acre_cents,
    },
  ];

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-secondary">Cost</span>
        {before ? (
          <ChangePair oldValue={displayDollars(before.cost)} newValue={displayDollars(effect.cost)} />
        ) : (
          <span className="font-semibold text-nav-dark">{displayDollars(effect.cost)}</span>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {tiers.map((tier) => {
          const belowCost = typeof tier.margin === 'number' && tier.margin < 0;
          const perAcre = displayPerAcre(tier.perAcreCents);
          const oldPerAcre = displayPerAcre(tier.oldPerAcreCents);
          const grossMargin = tier.grossMargin == null
            ? null
            : `${Number((tier.grossMargin * 100).toFixed(8))}%`;

          return (
            <div
              key={tier.label}
              className={`rounded-lg border bg-white p-3 ${
                belowCost ? 'border-amber-300 bg-amber-50' : 'border-gray-200'
              }`}
            >
              <div className="text-xs font-medium uppercase tracking-wide text-secondary">
                {tier.label}
              </div>
              <div className="mt-1 text-sm text-nav-dark">
                {before ? (
                  <ChangePair oldValue={displayDollars(tier.oldPrice)} newValue={displayDollars(tier.price)} />
                ) : displayDollars(tier.price)}
              </div>
              <div className={`text-xs ${belowCost ? 'font-semibold text-amber-800' : 'text-secondary'}`}>
                {before ? (
                  <><ChangePair oldValue={displayMargin(tier.oldMarginPercent)} newValue={displayMargin(tier.marginPercent)} /> <span>margin</span></>
                ) : <>{displayMargin(tier.marginPercent)} margin</>}
              </div>
              {grossMargin && (
                <div className="text-xs text-secondary">Gross / markup: {grossMargin}</div>
              )}
              {perAcre && (
                <div className="mt-1 text-xs text-secondary">
                  {before && oldPerAcre ? (
                    <ChangePair oldValue={oldPerAcre} newValue={perAcre} />
                  ) : perAcre}
                </div>
              )}
              {belowCost && (
                <div className="mt-2 text-xs font-semibold text-amber-800" role="note">
                  Warning: this price is below cost.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PricingChangePreviewModal({
  open,
  preview,
  applying,
  title = 'Review pricing changes',
  onClose,
  onApprove,
}: PricingChangePreviewModalProps) {
  const canApprove = Boolean(
    preview?.apply_allowed && preview.status === 'previewed' && preview.ready_count > 0,
  );
  const orderedRows = preview ? [...preview.rows].sort((a, b) => a.sequence - b.sequence) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={applying}
      title={title}
      size="large"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={applying}>
            Close
          </Button>
          {preview?.status === 'previewed' && (
            <Button onClick={onApprove} disabled={!canApprove} loading={applying}>
              Apply approved changes
            </Button>
          )}
        </div>
      }
    >
      {!preview ? (
        <p className="text-sm text-secondary">No pricing preview is available.</p>
      ) : (
        <div className="space-y-5">
          <section aria-label="Preview summary">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-nav-dark">
                  {preview.status === 'previewed' && 'Ready for approval'}
                  {preview.status === 'invalid' && 'Some rows need attention'}
                  {preview.status === 'no_changes' && 'No pricing changes found'}
                  {preview.status === 'applied' && 'Pricing changes applied'}
                  {preview.status === 'expired' && 'This preview expired'}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {preview.submitted_row_count} submitted row{preview.submitted_row_count === 1 ? '' : 's'}
                </div>
              </div>
              <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-secondary">
                {preview.source.split('_').join(' ')}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                <div className="text-lg font-semibold text-green-700">{preview.ready_count}</div>
                <div className="text-xs text-green-700">Ready</div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="text-lg font-semibold text-gray-700">{preview.unchanged_count}</div>
                <div className="text-xs text-gray-600">Unchanged</div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="text-lg font-semibold text-amber-800">{preview.conflict_count}</div>
                <div className="text-xs text-amber-800">Conflicts</div>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                <div className="text-lg font-semibold text-red-700">{preview.invalid_count}</div>
                <div className="text-xs text-red-700">Invalid</div>
              </div>
            </div>
          </section>

          <ol className="space-y-3" aria-label="Pricing preview rows">
            {orderedRows.map((row) => {
              const product = productLabel(row);
              const errorMessage = readableError(row.error_code);
              const hasNegativeMargin = Boolean(
                row.effect && [
                  row.effect.tier1_margin,
                  row.effect.tier2_margin,
                  row.effect.tier3_margin,
                ].some((margin) => typeof margin === 'number' && margin < 0),
              );

              return (
                <li
                  key={`${row.sequence}-${row.product_id ?? 'unknown'}`}
                  className={`rounded-xl border p-4 ${
                    hasNegativeMargin ? 'border-amber-300' : 'border-gray-200'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-nav-dark">{product.name}</div>
                      {product.detail && <div className="mt-0.5 text-xs text-secondary">{product.detail}</div>}
                    </div>
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_CLASSES[row.row_status]}`}
                    >
                      {STATUS_LABELS[row.row_status]}
                    </span>
                  </div>
                  {errorMessage && (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
                      {errorMessage}
                    </div>
                  )}
                  {row.effect && <PricingEffectDetails effect={row.effect} />}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Modal>
  );
}
