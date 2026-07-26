import type { ReactNode } from 'react';
import { ProductOptionDetails, type ProductOptionPresentationModel } from './ProductOptionPresentation';

/** Shared responsive result row for transactional Product search pickers. */
export function ProductSearchResultRow({ product, onClick, trailing }: {
  product: ProductOptionPresentationModel;
  onClick: () => void;
  trailing: ReactNode;
}) {
  return <button
    type="button"
    onClick={onClick}
    className="w-full min-w-0 text-left px-3 py-2 hover:bg-gray-50 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
  >
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium text-nav-dark">{product.product_name}</div>
      <ProductOptionDetails product={product} />
    </div>
    <div className="text-left text-xs text-secondary sm:text-right">{trailing}</div>
  </button>;
}
