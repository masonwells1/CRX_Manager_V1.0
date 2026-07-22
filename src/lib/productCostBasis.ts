import { assertRpcResult, supabase } from './db';
import type { ProductCostBasis, ProductCostBasisSelectionSource } from '../types';
import {
  exactIntegerCents,
  requiredExactIntegerCents,
  type PricingPreviewInputRow,
} from './productPricing';

export type ProductCostBasisRecord = Pick<
  ProductCostBasis,
  | 'id'
  | 'basis_type'
  | 'cost_cents'
  | 'supplier_price_observation_id'
  | 'purchase_order_item_id'
  | 'selection_source'
  | 'reason'
  | 'selected_at'
>;

export interface ProductCostBasisProduct {
  id: string;
  product_name: string;
  sku: string | null;
  pricing_version: number;
  current_cost_cents: bigint | null;
  tier1_margin_percent: string | null;
  tier2_margin_percent: string | null;
  tier3_margin_percent: string | null;
}

export interface SupplierCostBasisCandidate {
  supplier_price_observation_id: string;
  vendor_id: string;
  vendor_name: string;
  quoted_package_cost_cents: bigint;
  normalized_cost_cents: bigint;
  effective_from: string;
  price_kind: string;
}

export interface PurchaseCostBasisCandidate {
  purchase_order_item_id: string;
  purchase_order_id: string;
  po_number: string;
  vendor_name: string;
  normalized_cost_cents: bigint;
  purchased_at: string;
}

export interface ProductCostBasisWorkspace {
  enabled: boolean;
  product: ProductCostBasisProduct;
  current_basis: ProductCostBasisRecord | null;
  supplier_candidates: SupplierCostBasisCandidate[];
  purchase_candidates: PurchaseCostBasisCandidate[];
}

export type CostBasisPricingBehavior = 'keep_sell_prices' | 'keep_margins_and_reprice';

type CentsWire = string | number | bigint;
type ProductCostBasisRecordWire = Omit<ProductCostBasisRecord, 'cost_cents'> & {
  cost_cents: CentsWire;
};
type ProductCostBasisWorkspaceWire = Omit<
  ProductCostBasisWorkspace,
  'product' | 'current_basis' | 'supplier_candidates' | 'purchase_candidates'
> & {
  product: Omit<ProductCostBasisProduct, 'current_cost_cents'> & {
    current_cost_cents: CentsWire | null;
  };
  current_basis: ProductCostBasisRecordWire | null;
  supplier_candidates: Array<Omit<
    SupplierCostBasisCandidate,
    'quoted_package_cost_cents' | 'normalized_cost_cents'
  > & {
    quoted_package_cost_cents: CentsWire;
    normalized_cost_cents: CentsWire;
  }>;
  purchase_candidates: Array<Omit<PurchaseCostBasisCandidate, 'normalized_cost_cents'> & {
    normalized_cost_cents: CentsWire;
  }>;
};

function exactCents(value: CentsWire, field: string): bigint {
  try {
    const cents = requiredExactIntegerCents(value, field);
    if (cents < 0n) throw new Error('negative cents');
    return cents;
  } catch {
    throw new Error(`Cost basis RPC returned unsafe ${field}.`);
  }
}

function optionalExactCents(value: CentsWire | null, field: string): bigint | null {
  if (value === null) return null;
  try {
    const cents = exactIntegerCents(value, field);
    if (cents === null || cents < 0n) throw new Error('invalid cents');
    return cents;
  } catch {
    throw new Error(`Cost basis RPC returned unsafe ${field}.`);
  }
}

export function formatCostBasisDollars(cents: bigint): string {
  const whole = (cents / 100n).toString();
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

export async function getProductCostBasisWorkspace(
  productId: string,
): Promise<ProductCostBasisWorkspace> {
  const { data, error } = await supabase.rpc('get_product_cost_basis_workspace', {
    p_product_id: productId,
  });
  if (error) throw error;
  const result = assertRpcResult<ProductCostBasisWorkspaceWire>(
    data,
    'get_product_cost_basis_workspace',
  );
  return {
    ...result,
    product: {
      ...result.product,
      current_cost_cents: optionalExactCents(
        result.product.current_cost_cents,
        'current cost cents',
      ),
    },
    current_basis: result.current_basis ? {
      ...result.current_basis,
      cost_cents: exactCents(result.current_basis.cost_cents, 'selected cost cents'),
    } : null,
    supplier_candidates: result.supplier_candidates.map((candidate) => ({
      ...candidate,
      quoted_package_cost_cents: exactCents(
        candidate.quoted_package_cost_cents,
        'supplier package cents',
      ),
      normalized_cost_cents: exactCents(
        candidate.normalized_cost_cents,
        'supplier normalized cents',
      ),
    })),
    purchase_candidates: result.purchase_candidates.map((candidate) => ({
      ...candidate,
      normalized_cost_cents: exactCents(
        candidate.normalized_cost_cents,
        'purchase normalized cents',
      ),
    })),
  };
}

interface BasisRowOptions {
  reason: string;
  basisSource: Extract<
    ProductCostBasisSelectionSource,
    'supplier_pricing' | 'product_detail'
  >;
  pricingBehavior?: CostBasisPricingBehavior;
  currentTierPrices?: {
    tier1: string;
    tier2: string;
    tier3: string;
  };
}

function basePricingRow(
  workspace: ProductCostBasisWorkspace,
  costCents: bigint,
  options: BasisRowOptions,
): PricingPreviewInputRow {
  const { tier1_margin_percent, tier2_margin_percent, tier3_margin_percent } = workspace.product;
  const pricingBehavior = options.pricingBehavior ?? 'keep_sell_prices';
  const row: PricingPreviewInputRow = {
    product_id: workspace.product.id,
    product_name: workspace.product.product_name,
    sku: workspace.product.sku ?? undefined,
    row_version: workspace.product.pricing_version,
    pricing_mode: pricingBehavior === 'keep_sell_prices' ? 'price_driven' : 'margin_driven',
    new_cost: formatCostBasisDollars(costCents),
    change_reason: options.reason,
    basis_reason: options.reason,
    basis_source: options.basisSource,
    basis_selection: true,
  };
  if (pricingBehavior === 'keep_sell_prices') {
    const prices = options.currentTierPrices;
    if (!prices?.tier1 || !prices.tier2 || !prices.tier3) {
      throw new Error('Set all three Product tier prices before keeping sell prices.');
    }
    return {
      ...row,
      tier1_price: prices.tier1,
      tier2_price: prices.tier2,
      tier3_price: prices.tier3,
    };
  }
  if (tier1_margin_percent === null
      || tier2_margin_percent === null
      || tier3_margin_percent === null) {
    throw new Error('Set all three Product margins before repricing from the selected cost basis.');
  }
  return {
    ...row,
    tier1_margin_percent,
    tier2_margin_percent,
    tier3_margin_percent,
  };
}

export function supplierCandidatePricingRow(
  workspace: ProductCostBasisWorkspace,
  candidate: SupplierCostBasisCandidate,
  options: BasisRowOptions,
): PricingPreviewInputRow {
  return {
    ...basePricingRow(workspace, candidate.normalized_cost_cents, options),
    basis_type: 'selected_supplier_price',
    supplier_price_observation_id: candidate.supplier_price_observation_id,
  };
}

export function purchaseCandidatePricingRow(
  workspace: ProductCostBasisWorkspace,
  candidate: PurchaseCostBasisCandidate,
  options: BasisRowOptions,
): PricingPreviewInputRow {
  return {
    ...basePricingRow(workspace, candidate.normalized_cost_cents, options),
    basis_type: 'actual_purchase',
    purchase_order_item_id: candidate.purchase_order_item_id,
  };
}

export function manualCostBasisPricingRow(
  workspace: ProductCostBasisWorkspace,
  costCents: bigint,
  options: BasisRowOptions,
): PricingPreviewInputRow {
  return {
    ...basePricingRow(workspace, costCents, options),
    basis_type: 'manual_override',
  };
}
