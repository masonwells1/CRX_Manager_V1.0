import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const b2ProductWriterSurfaces = [
  'src/components/blendtickets/ManualTicketCreate.tsx',
  'src/pages/BlendTicketDetail.tsx',
  'src/components/field-app/FieldAppChemicalEntry.tsx',
  'src/pages/JobDetail.tsx',
  'src/pages/NewPurchaseOrder.tsx',
  'src/pages/PurchaseOrderDetail.tsx',
  'src/components/receiving/QuickReceivePanel.tsx',
  'src/pages/Rebates.tsx',
  'src/pages/InventoryPage.tsx',
  'src/components/purchase-orders/BulkPOImport.tsx',
];

describe('Stage B2 Product presentation adoption', () => {
  it.each(b2ProductWriterSurfaces)('%s uses the shared exact-SKU presentation contract', (file) => {
    const source = readFileSync(resolve(root, file), 'utf8');
    expect(source.includes('ProductOptionPresentation') || source.includes('ProductSearchResultRow')).toBe(true);
    expect(source).toContain('product_family:product_families(name)');
  });

  it('keeps PurchaseOrderDetail in the persistent Product-ID writer guard', () => {
    const source = readFileSync(resolve(root, 'src/pages/PurchaseOrderDetail.tsx'), 'utf8');
    expect(source).toContain('product_id: p.id');
    expect(source).toContain("supabase.rpc('save_purchase_order'");
    expect(source).toContain('product_id: item.product_id');
  });

  it('keeps the JobDetail action header wrapped at phone width', () => {
    const source = readFileSync(resolve(root, 'src/pages/JobDetail.tsx'), 'utf8');
    expect(source).toContain('flex flex-col gap-4 sm:flex-row sm:items-center');
    expect(source).toContain('flex flex-wrap items-center gap-2 sm:justify-end');
  });

  it.each([
    'src/components/quotes/BulkQuoteImport.tsx',
    'src/components/orders/BulkOrderImport.tsx',
    'src/components/purchase-orders/BulkPOImport.tsx',
  ])('%s uses the fail-closed Product identity resolver', (file) => {
    const source = readFileSync(resolve(root, file), 'utf8');
    expect(source).toMatch(/resolve(?:Exact|Fuzzy)ProductIdentity/);
  });

  it('keeps both InventoryPage Product-ID mutations in the final adoption guard', () => {
    const source = readFileSync(resolve(root, 'src/pages/InventoryPage.tsx'), 'utf8');
    expect(source).toContain("supabase.rpc('manual_inventory_add'");
    expect(source).toContain('p_product_id: addProductId');
    expect(source).toContain("supabase.rpc('create_inventory_hold'");
    // The hold request is frozen through useUncertainMutationIntent before it is
    // sent (2026-09-05): the exact picked Product id enters the intent, and the
    // RPC reads it back from the frozen request rather than from form state.
    expect(source).toContain('productId: holdProductId');
    expect(source).toContain('p_product_id: request.productId');
  });
});
