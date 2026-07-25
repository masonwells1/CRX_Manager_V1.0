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
    expect(source.includes('ProductOptionPresentation') || source.includes('ProductSearchResultRow')).toBe(true);
  });

  it('keeps the Returns no-return UI and stable server refusal visible', () => {
    const source = readFileSync(resolve(root, 'src/pages/Returns.tsx'), 'utf8');
    const policyHelper = readFileSync(resolve(root, 'src/lib/returnPolicyError.ts'), 'utf8');
    expect(source).toContain("disabled={normalizeReturnPolicy(p.product?.return_policy) === 'no_return'}");
    expect(source.match(/mapReturnPolicyRpcError\(error\)/g)).toHaveLength(6);
    expect(policyHelper).toContain('hasRpcCode(error, RpcErrorCodes.RETURN_POLICY_NO_RETURN)');
    expect(source).toContain('flex min-w-0 flex-col');
    expect(source).toContain('sm:flex-row');
    expect(source).toContain('sm:flex-wrap');
  });

  it('keeps Supplier Pricing selected by exact Product ID', () => {
    const source = readFileSync(resolve(root, 'src/pages/SupplierPricing.tsx'), 'utf8');
    expect(source).toContain('setSelectedProductId(event.target.value)');
    expect(source).toContain('getProductCostBasisWorkspace(productId)');
  });

  it('keeps expanded Product queries visible when they fail instead of rendering empty pickers', () => {
    const delivery = readFileSync(resolve(root, 'src/pages/DeliveryDetail.tsx'), 'utf8');
    const fieldApp = readFileSync(resolve(root, 'src/pages/FieldAppSplitInvoiceEditor.tsx'), 'utf8');
    const invoice = readFileSync(resolve(root, 'src/pages/InvoiceDetail.tsx'), 'utf8');
    expect(delivery).toContain("context: 'load_delivery_items'");
    expect(delivery).toContain("context: 'load_delivery_edit_order_items'");
    expect(fieldApp).toContain("context: 'load_field_app_split_invoice_pickers'");
    expect(invoice).toContain("context: 'search_invoice_products'");
    expect(invoice).toContain("toast('error', 'Failed to search Products')");
  });

});
