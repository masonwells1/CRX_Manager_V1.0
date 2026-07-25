/* eslint-disable react-refresh/only-export-components -- formatter helpers and the presentation component are one identity contract. */
import type { ReactNode } from 'react';

/**
 * Display-only Product identity contract for transactional pickers.
 *
 * Product IDs always remain the caller's value. Family is deliberately not an
 * equivalence key: it is context for a human choosing an exact SKU.
 */
export interface ProductOptionPresentationModel {
  id: string;
  product_name: string | null;
  sku?: string | null;
  unit_size?: string | null;
  packaging_variant?: string | null;
  container_size?: number | null;
  container_unit?: string | null;
  inventory_unit?: string | null;
  return_policy?: string | null;
  is_full_tote_only?: boolean | null;
  product_family?: { name?: string | null } | null;
}

export type ProductReturnPolicy = 'returnable' | 'no_return' | 'not_applicable' | 'unknown';

export function normalizeReturnPolicy(value: string | null | undefined): ProductReturnPolicy {
  return value === 'returnable' || value === 'no_return' || value === 'not_applicable'
    ? value
    : 'unknown';
}

export function productPackageLabel(product: ProductOptionPresentationModel): string {
  if (product.packaging_variant) return product.packaging_variant;
  if (product.unit_size) return product.unit_size;
  if (product.container_size != null && product.container_unit) return `${product.container_size} ${product.container_unit}`;
  return 'Not recorded';
}

/** Stable plain text for native <option>s, which cannot render badges. */
export function productOptionLabel(product: ProductOptionPresentationModel): string {
  const policy = normalizeReturnPolicy(product.return_policy).replace(/_/g, ' ');
  return [
    product.product_name || 'Unnamed product',
    product.sku ? `SKU: ${product.sku}` : `Product ID: ${product.id}`,
    `Family: ${product.product_family?.name || 'Unassigned'}`,
    `Package: ${productPackageLabel(product)}`,
    `Unit: ${product.inventory_unit || 'Not recorded'}`,
    `Return: ${policy}`,
    product.is_full_tote_only ? 'Full tote only' : null,
  ].filter(Boolean).join(' · ');
}

function PolicyBadge({ policy }: { policy: ProductReturnPolicy }) {
  const className = policy === 'no_return'
    ? 'bg-red-100 text-red-700'
    : policy === 'returnable'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-gray-100 text-gray-700';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${className}`}>Return: {policy.replace(/_/g, ' ')}</span>;
}

export function ProductOptionDetails({ product, className = '' }: { product: ProductOptionPresentationModel; className?: string }): ReactNode {
  const policy = normalizeReturnPolicy(product.return_policy);
  return (
    <div className={`mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary ${className}`.trim()} data-product-id={product.id}>
      {product.sku
        ? <span>SKU: {product.sku}</span>
        : <span className="min-w-0 break-all">Product ID: {product.id}</span>}
      <span>Family: {product.product_family?.name || 'Unassigned'}</span>
      <span>Package: {productPackageLabel(product)}</span>
      <span>Unit: {product.inventory_unit || 'Not recorded'}</span>
      <PolicyBadge policy={policy} />
      {product.is_full_tote_only && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">Full tote only</span>}
    </div>
  );
}
