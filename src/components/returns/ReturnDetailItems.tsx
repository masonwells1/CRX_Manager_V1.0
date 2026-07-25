import Badge from '../ui/Badge';
import { ProductOptionDetails, normalizeReturnPolicy, type ProductOptionPresentationModel } from '../products/ProductOptionPresentation';

export interface ReturnDetailItemPresentation {
  id: string;
  product_name: string | null;
  quantity: number;
  unit: string;
  condition: string;
  extended_cents: number;
  restock: boolean;
  restocked: boolean;
  product?: ProductOptionPresentationModel | null;
}

export function ReturnDetailItems({ items, formatCents }: {
  items: ReturnDetailItemPresentation[];
  formatCents: (value: number) => string;
}) {
  const totalCredit = items.reduce((sum, item) => sum + item.extended_cents, 0);
  const productDetail = (item: ReturnDetailItemPresentation) => <>
    {item.product && <ProductOptionDetails product={item.product} />}
    {normalizeReturnPolicy(item.product?.return_policy) === 'no_return' && <p className="mt-1 break-words text-xs font-medium text-red-700">No return policy — the database remains the authority for every return action.</p>}
  </>;

  return <>
    <div className="space-y-3 sm:hidden" data-testid="return-detail-mobile-cards">
      {items.map((item) => (
        <div key={item.id} className="min-w-0 rounded-lg border border-gray-200 p-3 text-sm">
          <div className="font-medium">{item.product_name || item.product?.product_name}</div>
          {productDetail(item)}
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <div><dt className="text-gray-500">Quantity</dt><dd>{item.quantity} {item.unit}</dd></div>
            <div><dt className="text-gray-500">Condition</dt><dd className="capitalize">{item.condition}</dd></div>
            <div><dt className="text-gray-500">Credit</dt><dd className="font-medium text-emerald-600">{formatCents(item.extended_cents)}</dd></div>
            <div><dt className="text-gray-500">Restock</dt><dd>{item.restock ? (item.restocked ? 'Restocked' : 'Pending') : 'No'}</dd></div>
          </dl>
        </div>
      ))}
      <div className="rounded-lg bg-gray-50 p-3 text-right text-sm font-semibold">Total Credit: <span className="text-emerald-600">{formatCents(totalCredit)}</span></div>
    </div>
    <div className="hidden overflow-hidden rounded-lg border border-gray-200 sm:block" data-testid="return-detail-desktop-table">
      <table className="w-full text-sm">
        <thead className="bg-gray-50"><tr><th className="text-left py-2 px-3 font-medium text-gray-600">Product</th><th className="text-right py-2 px-3 font-medium text-gray-600">Qty</th><th className="text-left py-2 px-3 font-medium text-gray-600">Condition</th><th className="text-right py-2 px-3 font-medium text-gray-600">Credit</th><th className="text-center py-2 px-3 font-medium text-gray-600">Restock</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id} className="border-t border-gray-100"><td className="min-w-0 py-2 px-3 font-medium"><div>{item.product_name || item.product?.product_name}</div>{productDetail(item)}</td><td className="py-2 px-3 text-right">{item.quantity} {item.unit}</td><td className="py-2 px-3 capitalize">{item.condition}</td><td className="py-2 px-3 text-right text-emerald-600">{formatCents(item.extended_cents)}</td><td className="py-2 px-3 text-center">{item.restock ? (item.restocked ? <Badge variant="success">Restocked</Badge> : <span className="text-gray-500">Pending</span>) : <span className="text-gray-400">No</span>}</td></tr>)}</tbody>
        <tfoot className="bg-gray-50"><tr className="border-t"><td colSpan={3} className="py-2 px-3 text-right font-medium">Total Credit:</td><td className="py-2 px-3 text-right font-semibold text-emerald-600">{formatCents(totalCredit)}</td><td /></tr></tfoot>
      </table>
    </div>
  </>;
}
