import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const b1Surfaces = [
  'src/pages/QuoteBuilder.tsx',
  'src/pages/NewOrder.tsx',
  'src/pages/OrderDetail.tsx',
  'src/components/deliveries/QuickDeliveryModal.tsx',
  'src/pages/DeliveryDetail.tsx',
  'src/pages/Returns.tsx',
  'src/pages/SupplierPricing.tsx',
  'src/pages/InvoiceDetail.tsx',
  'src/pages/FieldAppSplitInvoiceEditor.tsx',
];

describe('Stage B1 Product presentation adoption', () => {
  it.each(b1Surfaces)('%s uses the shared exact-SKU presentation contract', (file) => {
    const source = readFileSync(resolve(root, file), 'utf8');
    expect(source).toContain('ProductOptionPresentation');
  });

  it('keeps the Returns no-return UI and stable server refusal visible', () => {
    const source = readFileSync(resolve(root, 'src/pages/Returns.tsx'), 'utf8');
    expect(source).toContain("disabled={normalizeReturnPolicy(p.product?.return_policy) === 'no_return'}");
    expect(source).toContain('hasRpcCode(error, RpcErrorCodes.RETURN_POLICY_NO_RETURN)');
  });

  it('keeps Supplier Pricing selected by exact Product ID', () => {
    const source = readFileSync(resolve(root, 'src/pages/SupplierPricing.tsx'), 'utf8');
    expect(source).toContain('setSelectedProductId(event.target.value)');
    expect(source).toContain('getProductCostBasisWorkspace(productId)');
  });
});
