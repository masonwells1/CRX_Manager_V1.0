import { useState, useRef, useEffect, useCallback, Fragment } from 'react';
import { Plus, Trash2, AlertTriangle, ShieldAlert, Clock, CalendarClock } from 'lucide-react';
import Button from '../ui/Button';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import type { Product, UnitConversion } from '../../types';
import { formatCents as fmt } from '../../lib/money';
import { MONEY_PRECISION_MESSAGE, parseDollarsToCents } from '../../lib/parseCents';
import { useToast } from '../ui/Toast';
import { toGallonOrLbEquivalent, fieldAppPricedQuantity } from '../../lib/chemCalculator';
import { unitOptionsForForm, isKnownUnit } from '../../lib/units';
import {
  compareToMaxRate,
  phiHarvestWarning,
  formatRei,
  formatPhi,
} from '../../lib/labelGuardrails';
import type { GuardrailMode } from '../../lib/labelGuardrailSetting';
import { ProductSearchResultRow } from '../products/ProductSearchResultRow';
import type { ProductOptionPresentationModel } from '../products/ProductOptionPresentation';

type PickerProduct = Product & ProductOptionPresentationModel;

export interface ChemicalLine {
  id: string;
  product_id: string | null;
  product_name: string;
  rate_per_acre: number | null;
  rate_unit: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  price_unit: string;
  extended_cents: number;
  unit_cost_cents: number;
  sort_order: number;
  epa_registration?: string;
  /**
   * #25 (ChemMan parity): per-line Warehouse (free text — products has no warehouse
   * column, so this is a typed location/shed) and Vendor (defaults from the product's
   * vendor on select, editable). Both are informational and never affect pricing; the
   * server persists them on invoice_items.warehouse / .vendor.
   */
  warehouse?: string | null;
  vendor?: string | null;
  /**
   * #25: the product form drives the gallon-vs-pound choice for the Total Applied
   * conversion display (liquid -> gal, dry -> lb). Captured on product select; the
   * server is authoritative via convert_to_gl_lb().
   */
  product_form?: 'liquid' | 'dry' | null;
  /**
   * Phase 1 (2026-04-29): when true, the unit_price_cents on this line is a
   * deliberate manual override. The server records price_source = 'manual'.
   * When false, the server uses tier/quoted pricing per customer; the price
   * shown here is just a display preview based on the primary customer's tier.
   */
  manual_override?: boolean;
  /**
   * §5 (Label-Rate Guardrails): the product's label data captured at select time so
   * the rate-vs-max check + REI/PHI windows can be shown on the line WITHOUT a re-fetch.
   * All optional/nullable — a product with no label data degrades gracefully (the line
   * shows "no label max on file", never blocks, never errors). These are DISPLAY/SAFETY
   * only — they don't affect pricing and are not persisted by the line.
   */
  max_label_rate?: number | null;
  max_label_rate_unit?: string | null;
  rei_hours?: number | null;
  phi_days?: number | null;
  /**
   * #56 (UI-only, NOT persisted): a hand-entered "custom line" with no catalog
   * product. Renders a free-text name input instead of the product search box.
   * The server already supports manual lines (product_id NULL + free-text name +
   * editable price); this flag just drives the local rendering.
   */
  is_custom?: boolean;
}

interface FieldAppChemicalEntryProps {
  chemicals: ChemicalLine[];
  onChemicalsChange: (chemicals: ChemicalLine[]) => void;
  totalAppliedAcres: number;
  /**
   * Phase 1: tier of the primary customer derived from billing splits.
   * Used as the *display* price when a product is selected (so the user
   * sees something reasonable). Final per-customer pricing is computed
   * server-side; this is just a preview hint.
   * Defaults to 1 when no fields/customers are selected yet.
   */
  primaryCustomerTier?: number;
  /**
   * #24/#25 posted-lock: when true the whole Chemical/Charges tab is read-only —
   * a posted/voided/paid field-app invoice's committed lines must not be editable.
   * Driven by the editor's !canEdit. (The Save button is already hidden and the
   * save RPC guards status, but the UI must reflect the lock too — closing the #24
   * carry-forward hole where these inputs stayed interactive.)
   */
  readOnly?: boolean;
  /**
   * §5 (Label-Rate Guardrails): the configurable policy. 'warn' (default) flags an
   * over-label rate but NEVER blocks the save. 'block' is owner-opt-in: an over-label
   * line needs an admin override (logged) before save. This component only renders the
   * WARNING UI; the parent decides what to do with the over-label state (and gates save
   * in block mode). Defaults to 'warn' so a missing prop never silently blocks.
   */
  guardrailMode?: GuardrailMode;
  /**
   * §5: earliest planned harvest date (YYYY-MM-DD) across the selected fields, from
   * field_crop_history. When a product's PHI window (application + phi_days) would extend
   * PAST this date, the user is warned. Null/undefined => the PHI-vs-harvest check is
   * skipped (graceful — no false warning).
   */
  earliestHarvestDate?: string | null;
  /**
   * §5: the application/scheduled date (YYYY-MM-DD) used as the PHI window start. Defaults
   * to today inside the guardrail when omitted.
   */
  applicationDate?: string | null;
}


let nextLineId = 1;
function genId() {
  return `chem_${Date.now()}_${nextLineId++}`;
}

function tierPrice(product: Product, tier: number): number {
  // Returns dollars (number); caller converts to cents.
  if (tier === 2) return product.tier2_price ?? product.tier1_price ?? 0;
  if (tier === 3) return product.tier3_price ?? product.tier1_price ?? 0;
  return product.tier1_price ?? 0;
}

export default function FieldAppChemicalEntry({
  chemicals,
  onChemicalsChange,
  totalAppliedAcres,
  primaryCustomerTier = 1,
  readOnly = false,
  guardrailMode = 'warn',
  earliestHarvestDate = null,
  applicationDate = null,
}: FieldAppChemicalEntryProps) {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PickerProduct[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);

  useEffect(() => {
    supabase.from('unit_conversions').select('*').order('unit').then(({ data, error }) => {
      if (error) { Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_unit_conversions' } }); return; }
      setUnitConversions((data || []) as UnitConversion[]);
    });
  }, []);
  const searchRef = useRef<HTMLDivElement>(null);

  const searchProducts = useCallback(async (q: string) => {
    if (q.length < 2) { setSearchResults([]); setSearching(false); setSearchError(false); return; }
    setSearching(true);
    setSearchError(false);
    const { data, error } = await supabase
      .from('products')
      .select('*, product_family:product_families(name)')
      .eq('is_active', true)
      .or(`product_name.ilike.%${q}%,epa_registration.ilike.%${q}%`)
      .order('product_name')
      .limit(15);
    setSearching(false);

    if (error) {
      Sentry.captureException(error, { tags: { component: 'FieldAppChemicalEntry' } });
      setSearchError(true);
      setSearchResults([]);
      return;
    }
    setSearchError(false);
    setSearchResults((data || []) as unknown as PickerProduct[]);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { if (searchQuery) searchProducts(searchQuery); }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, searchProducts]);

  // Close search on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearch(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const addLine = () => {
    if (readOnly) return;
    const line: ChemicalLine = {
      id: genId(),
      product_id: null,
      product_name: '',
      rate_per_acre: null,
      rate_unit: 'oz',
      quantity: 0,
      unit: 'oz',
      unit_price_cents: 0,
      price_unit: 'oz',
      extended_cents: 0,
      unit_cost_cents: 0,
      sort_order: chemicals.length,
      warehouse: null,
      vendor: null,
      product_form: null,
    };
    onChemicalsChange([...chemicals, line]);
    setActiveLineId(line.id);
    setShowSearch(true);
    setSearchQuery('');
    setSearchResults([]);
  };

  const addCustomLine = () => {
    if (readOnly) return;
    const line: ChemicalLine = {
      id: genId(),
      product_id: null,
      product_name: '',
      rate_per_acre: null,
      rate_unit: 'oz',
      quantity: 0,
      unit: 'oz',
      unit_price_cents: 0,
      price_unit: 'oz',
      extended_cents: 0,
      unit_cost_cents: 0,
      sort_order: chemicals.length,
      warehouse: null,
      vendor: null,
      product_form: null,
      is_custom: true,
    };
    onChemicalsChange([...chemicals, line]);
    setActiveLineId(line.id);
    // No product search for a custom line — the user types the name directly.
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
  };

  const removeLine = (id: string) => {
    if (readOnly) return;
    onChemicalsChange(chemicals.filter((c) => c.id !== id));
  };

  const updateLine = (id: string, updates: Partial<ChemicalLine>) => {
    if (readOnly) return;
    onChemicalsChange(
      chemicals.map((c) => {
        if (c.id !== id) return c;
        const updated = { ...c, ...updates };
        // WaveB (Codex R2c): a MANUAL line (no product) has no product inventory unit, so the
        // server stores/labels the saved invoice item in the value the parent sends as unit_size
        // (= `unit`), and prices in the rate unit. Keep `unit` + `price_unit` in lockstep with the
        // rate unit for manual lines whenever the rate unit changes, so the saved/printed line and
        // the Price-UM column match the billed quantity (e.g. an lb rate isn't mislabeled "oz").
        // Product lines are untouched: `unit` is the product's inventory unit by design.
        if (updated.product_id == null && updates.rate_unit !== undefined) {
          updated.unit = updates.rate_unit;
          updated.price_unit = updates.rate_unit;
        }
        // Recalc quantity and total
        if (updated.rate_per_acre && totalAppliedAcres > 0) {
          updated.quantity = Number((updated.rate_per_acre * totalAppliedAcres).toFixed(2));
        }
        // codex-driven hunt (PARKED-010): bill the applied amount in the product's SOLD unit.
        // quantity is in the RATE unit (e.g. oz) but unit_price_cents is per the inventory unit
        // (e.g. $/gal); convert before multiplying so the preview matches the server
        // (save_field_app_invoice) instead of over-stating by the unit ratio (~128x for oz→gal).
        // WaveB (Codex R2b): mirror the server's pricing unit EXACTLY. save_field_app_invoice sets
        // the inventory unit only when product_id is present (COALESCE(inventory_unit, rate_unit)),
        // so a MANUAL line (no product_id) has no inventory unit and prices in the rate unit itself
        // (identity). `unit` defaults to 'oz', so `unit || rate_unit` wrongly converted manual lines
        // against 'oz' — showing $0 for a cross-family choice (e.g. a dry Lb rate) while the server
        // still billed non-zero. Gate on product_id like the server does. Genuinely unconvertible
        // product line → 0 (server blocks the save with FIELD_APP_UNIT_UNCONVERTIBLE).
        const pricingUnit = updated.product_id ? (updated.unit || updated.rate_unit) : updated.rate_unit;
        const pricedQty = fieldAppPricedQuantity(
          updated.quantity, updated.rate_unit, pricingUnit, updated.product_form,
        );
        updated.extended_cents = pricedQty == null ? 0 : Math.round(pricedQty * (updated.unit_price_cents || 0));
        return updated;
      })
    );
  };

  const selectProduct = (product: Product, lineId: string) => {
    // Phase 1: use primary customer's tier as the display price hint.
    // Server still computes per-customer pricing on save.
    updateLine(lineId, {
      product_id: product.id,
      product_name: product.product_name,
      rate_per_acre: product.rate_per_acre || null,
      rate_unit: product.rate_unit || product.inventory_unit || 'oz',
      unit: product.inventory_unit || 'oz',
      unit_price_cents: Math.round(tierPrice(product, primaryCustomerTier) * 100),
      price_unit: product.inventory_unit || 'oz',
      unit_cost_cents: Math.round((product.current_cost || 0) * 100),
      epa_registration: product.epa_registration || undefined,
      // #25: default Vendor from the product (editable); capture product_form for the
      // gallon/lb conversion display. Warehouse stays a free-text field the user fills.
      vendor: product.vendor || null,
      product_form: product.product_form,
      manual_override: false,
      // §5: capture label data so the rate-vs-max guardrail + REI/PHI windows render on
      // the line. All nullable — a product with no label data shows "no label max on file".
      max_label_rate: product.max_label_rate ?? null,
      max_label_rate_unit: product.max_label_rate_unit ?? null,
      rei_hours: product.rei_hours ?? null,
      phi_days: product.phi_days ?? null,
    });
    setShowSearch(false);
    setSearchQuery('');
  };

  const invoiceTotal = chemicals.reduce((sum, c) => sum + c.extended_cents, 0);
  const pricePerAcre = totalAppliedAcres > 0 ? invoiceTotal / totalAppliedAcres : 0;

  // §5: compute the aggregate guardrail state and report it to the parent. The parent
  // gates save in 'block' mode + captures the admin override reason; this component only
  // renders the warnings. (Pure functions; recomputed only when inputs change.)
  const overRateProducts: string[] = [];
  let phiHarvestWarnCount = 0;
  for (const c of chemicals) {
    if (c.product_id == null) continue;
    const cmp = compareToMaxRate(c.rate_per_acre, c.rate_unit, c.max_label_rate ?? null, c.max_label_rate_unit ?? null);
    if (cmp.status === 'over') overRateProducts.push(c.product_name || 'Unnamed product');
    const phi = phiHarvestWarning(c.phi_days ?? null, earliestHarvestDate, applicationDate);
    if (phi.status === 'inside_window') phiHarvestWarnCount += 1;
  }
  const overRateCount = overRateProducts.length;
  // (guardrail aggregate is computed in the parent for the save gate)
  return (
    <div className="space-y-4">
      {/* Warn (don't silently bill $0) when acres are missing but rates are entered */}
      {totalAppliedAcres <= 0 && chemicals.some((c) => c.rate_per_acre != null && c.rate_per_acre > 0) && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Applied acres are 0, so these lines bill $0.00. Enter the acres sprayed on the Locations tab to price them.</span>
        </div>
      )}

      {/* §5: aggregate label-rate guardrail banner. WARN mode = informational (never blocks
          the save). BLOCK mode = the parent requires an admin override with a logged reason
          before saving (still never a hard wall). */}
      {overRateCount > 0 && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${guardrailMode === 'block' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {overRateCount} chemical line{overRateCount > 1 ? 's' : ''} {overRateCount > 1 ? 'are' : 'is'} above the product&rsquo;s max label rate
            {' '}({overRateProducts.join(', ')}).{' '}
            {guardrailMode === 'block'
              ? 'Saving requires an admin override with a reason.'
              : 'You can still save — double-check the rate against the label.'}
          </span>
        </div>
      )}
      {phiHarvestWarnCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <CalendarClock className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            {phiHarvestWarnCount} product{phiHarvestWarnCount > 1 ? 's' : ''} {phiHarvestWarnCount > 1 ? 'have' : 'has'} a pre-harvest interval that extends past a field&rsquo;s planned harvest date. Confirm the harvest timing before applying.
          </span>
        </div>
      )}

      {/* Product lines */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b">
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-[220px]">Product</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-28">Warehouse</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 w-32">Vendor</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-24">Rate/Acre</th>
              <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 w-16">UM</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-28">Total Applied</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-28">Price</th>
              <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 w-16">Price UM</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 w-28">Line Total</th>
              <th className="px-3 py-2 w-10" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {chemicals.map((line) => {
            // §5 guardrail evaluation for this line (pure, unit-safe). Only flags when the
            // rate's unit MATCHES the max-label unit; a mismatch/missing => 'cannot_compare'
            // (no false over-rate flag). A missing max => 'no_label_max' (soft note).
            const rateCmp = compareToMaxRate(
              line.rate_per_acre,
              line.rate_unit,
              line.max_label_rate ?? null,
              line.max_label_rate_unit ?? null,
            );
            const phiCheck = phiHarvestWarning(line.phi_days ?? null, earliestHarvestDate, applicationDate);
            const hasGuardrailInfo =
              line.product_id != null &&
              (rateCmp.status !== 'no_rate' || (line.rei_hours ?? null) != null || (line.phi_days ?? null) != null);
            return (
            <Fragment key={line.id}>
              <tr className="hover:bg-gray-50">
                <td className="px-3 py-2">
                  <div className="relative" ref={activeLineId === line.id ? searchRef : undefined}>
                    {/* #56 + Codex P2: a custom/manual line is identified by its
                        PERSISTED state (product_id null + a name) so it survives
                        save/reload; is_custom covers the fresh empty line just
                        added this session. A fresh "Add Chemical" line (null id,
                        empty name, no flag) still falls through to the search box. */}
                    {line.product_id == null && (line.is_custom || line.product_name !== '') ? (
                      <input
                        type="text"
                        placeholder="Custom line description..."
                        disabled={readOnly}
                        value={line.product_name}
                        onChange={(e) => updateLine(line.id, { product_name: e.target.value })}
                        className="w-full px-2 py-1 border rounded text-sm disabled:bg-gray-100 disabled:text-gray-500"
                      />
                    ) : line.product_name ? (
                      <button
                        type="button"
                        disabled={readOnly}
                        className="w-full text-left font-medium hover:text-crx-green disabled:hover:text-inherit disabled:cursor-default"
                        onClick={() => {
                          if (readOnly) return;
                          setActiveLineId(line.id);
                          setShowSearch(true);
                          setSearchQuery('');
                        }}
                      >
                        {line.product_name}
                        {line.epa_registration && (
                          <span className="text-xs text-gray-400 ml-1">EPA: {line.epa_registration}</span>
                        )}
                      </button>
                    ) : (
                      <input
                        type="text"
                        placeholder="Search product..."
                        disabled={readOnly}
                        value={activeLineId === line.id ? searchQuery : ''}
                        onChange={(e) => { setSearchQuery(e.target.value); setActiveLineId(line.id); setShowSearch(true); }}
                        onFocus={() => { setActiveLineId(line.id); setShowSearch(true); }}
                        className="w-full px-2 py-1 border rounded text-sm disabled:bg-gray-100 disabled:text-gray-500"
                      />
                    )}
                    {!readOnly && showSearch && activeLineId === line.id && (searchQuery.length >= 2 || searchResults.length > 0) && (
                      <div className="absolute z-20 top-full left-0 w-80 mt-1 bg-white border rounded-lg shadow-lg max-h-60 overflow-auto">
                        {searching && (
                          <div className="px-3 py-2 text-sm text-gray-400">Searching...</div>
                        )}
                        {!searching && searchError && (
                          <button
                            type="button"
                            onClick={() => searchProducts(searchQuery)}
                            className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                          >
                            Search failed - tap to retry
                          </button>
                        )}
                        {!searching && !searchError && searchResults.length === 0 && searchQuery.length >= 2 && (
                          <div className="px-3 py-2 text-sm text-gray-400">No products match "{searchQuery}"</div>
                        )}
                        {!searching && !searchError && searchResults.map((p) => (
                          <ProductSearchResultRow
                            key={p.id}
                            product={p}
                            onClick={() => selectProduct(p, line.id)}
                            trailing={p.epa_registration ? `EPA: ${p.epa_registration}` : null}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </td>
                {/* #25: per-line Warehouse (free text) + Vendor (defaults from product, editable) */}
                <td className="px-3 py-2">
                  <input
                    type="text"
                    placeholder="—"
                    disabled={readOnly}
                    value={line.warehouse ?? ''}
                    onChange={(e) => updateLine(line.id, { warehouse: e.target.value || null })}
                    className="w-full px-2 py-1 border rounded text-sm disabled:bg-gray-100 disabled:text-gray-500"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    placeholder="—"
                    disabled={readOnly}
                    value={line.vendor ?? ''}
                    onChange={(e) => updateLine(line.id, { vendor: e.target.value || null })}
                    className="w-full px-2 py-1 border rounded text-sm disabled:bg-gray-100 disabled:text-gray-500"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    step="0.01"
                    disabled={readOnly}
                    value={line.rate_per_acre ?? ''}
                    onChange={(e) => {
                      // codex-driven hunt cycle 8: a type=number input still accepts
                      // transient strings like "e", "-", "." -> Number() = NaN. Guard
                      // with Number.isFinite so NaN never enters line state (it survives
                      // `?? ''`, glitches the field, and silently nulls the rate on save).
                      const n = Number(e.target.value);
                      updateLine(line.id, { rate_per_acre: e.target.value !== '' && Number.isFinite(n) ? n : null });
                    }}
                    className="w-full px-2 py-1 border rounded text-right text-sm tabular-nums disabled:bg-gray-100 disabled:text-gray-500"
                  />
                </td>
                <td className="px-3 py-2 text-center">
                  {/* WaveB: the applied UM is now an editable dropdown (was read-only). updateLine
                      re-prices the line on change (fieldAppPricedQuantity), so a corrected unit
                      flows straight into the preview + save. Bare canonical units filtered by
                      product form; grandfather a legacy value so it can't be silently blanked. */}
                  <select
                    value={line.rate_unit || ''}
                    disabled={readOnly}
                    onChange={(e) => updateLine(line.id, { rate_unit: e.target.value })}
                    className="w-full px-1 py-1 border rounded text-center text-sm disabled:bg-gray-100 disabled:text-gray-500"
                  >
                    {/* Codex P1: the blank option is a disabled placeholder only — a field-app
                        line always has a rate_unit (set on product select), and actively blanking
                        it would zero the preview here while the server falls back to unit_size and
                        still invoices non-zero. Disabled => can't be selected. */}
                    <option value="" disabled>--</option>
                    {line.rate_unit && !isKnownUnit(unitConversions, line.product_form, line.rate_unit) && (
                      <option value={line.rate_unit}>{line.rate_unit}</option>
                    )}
                    {unitOptionsForForm(unitConversions, line.product_form).map((uc) => (
                      <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                    ))}
                  </select>
                </td>
                {/* #25: Total Applied + its gallon/lb equivalent (loader planning). The
                    server is authoritative via convert_to_gl_lb; this is the live preview. */}
                <td className="px-3 py-2 text-right tabular-nums">
                  <div>{line.quantity.toFixed(2)} <span className="text-gray-400">{line.rate_unit}</span></div>
                  {(() => {
                    const conv = toGallonOrLbEquivalent(line.quantity, line.rate_unit, line.product_form);
                    return conv ? (
                      <div className="text-[11px] text-gray-400">= {conv.value.toLocaleString(undefined, { maximumFractionDigits: 4 })} {conv.unit}</div>
                    ) : null;
                  })()}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <div className="relative flex-1">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">$</span>
                      <input
                        type="number"
                        step="0.01"
                        min={0}
                        disabled={readOnly}
                        value={line.unit_price_cents ? (line.unit_price_cents / 100).toFixed(2) : ''}
                        onChange={(e) => {
                          const cents = e.target.value ? parseDollarsToCents(e.target.value) : 0;
                          // null = a third decimal digit was typed. Refuse the keystroke: the
                          // controlled value stays at the last accepted price rather than
                          // saving a $0 manual override — and say why, so the vanished
                          // character is not mistaken for a typo.
                          if (cents === null) { toast('error', MONEY_PRECISION_MESSAGE); return; }
                          updateLine(line.id, { unit_price_cents: cents, manual_override: true });
                        }}
                        className="w-full pl-5 pr-2 py-1 border rounded text-right text-sm tabular-nums disabled:bg-gray-100 disabled:text-gray-500"
                        title={line.manual_override ? 'Manual price override' : 'Tier preview - final price computed per customer on save'}
                      />
                    </div>
                    {line.manual_override && (
                      <span className="text-[10px] px-1 rounded bg-amber-50 text-amber-700" title="Manual price override — server records as price_source=manual">
                        M
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-center text-gray-600">{line.price_unit}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{fmt(line.extended_cents)}</td>
                <td className="px-3 py-2">
                  {!readOnly && (
                    <button onClick={() => removeLine(line.id)} className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
              {/* §5 Label-Rate Guardrails sub-row: REI/PHI windows + over-rate flag +
                  PHI-vs-harvest warning. Renders only once a product is selected. The
                  over-rate flag NEVER blocks the save in 'warn' mode — it's a warning. */}
              {hasGuardrailInfo && (
                <tr className="border-t-0">
                  <td colSpan={10} className="px-3 pb-2 pt-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      {/* REI / PHI windows (auto-displayed; also printed on the field sheet) */}
                      <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-gray-600" title="Restricted-entry interval (label)">
                        <Clock className="w-3 h-3" /> REI {formatRei(line.rei_hours)}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-gray-600" title="Pre-harvest interval (label)">
                        <CalendarClock className="w-3 h-3" /> PHI {formatPhi(line.phi_days)}
                      </span>

                      {/* Rate-vs-max-label result */}
                      {rateCmp.status === 'over' && (
                        <span
                          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium ${guardrailMode === 'block' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}
                          title={`Entered rate ${rateCmp.rate} ${line.rate_unit} exceeds the label max ${rateCmp.maxRate} ${line.max_label_rate_unit}`}
                        >
                          <ShieldAlert className="w-3 h-3" />
                          {guardrailMode === 'block' ? 'OVER LABEL RATE — override required' : 'Over label rate'} ({rateCmp.rate} &gt; {rateCmp.maxRate} {line.max_label_rate_unit})
                        </span>
                      )}
                      {rateCmp.status === 'no_label_max' && (
                        <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-gray-500" title="No maximum label rate is on file for this product — can't check the rate. Add it on the product to enable the guardrail.">
                          <AlertTriangle className="w-3 h-3" /> No label max on file
                        </span>
                      )}
                      {rateCmp.status === 'cannot_compare' && (line.rate_per_acre ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-gray-500" title={`Can't compare: rate unit (${line.rate_unit || '—'}) differs from the label-max unit (${line.max_label_rate_unit || '—'}).`}>
                          <AlertTriangle className="w-3 h-3" /> Units differ — rate not checked
                        </span>
                      )}

                      {/* PHI-vs-harvest-date warning */}
                      {phiCheck.status === 'inside_window' && (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800" title={`Harvest ${phiCheck.harvestDate} is sooner than the earliest safe harvest ${phiCheck.earliestHarvest} (application + ${phiCheck.phiDays}-day PHI).`}>
                          <CalendarClock className="w-3 h-3" /> Harvest {phiCheck.harvestDate} is inside the {phiCheck.phiDays}-day PHI window (earliest {phiCheck.earliestHarvest})
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
            );
            })}
            {chemicals.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400">No chemicals added yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add button (recipe picker / save-as-recipe were non-functional TODO
          stubs — removed 2026-05-30 P3 hygiene; reintroduce when implemented).
          Hidden on a posted/locked invoice (#24/#25 posted-lock). */}
      {!readOnly && (
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" icon={<Plus className="w-4 h-4" />} onClick={addLine}>
              Add Chemical
            </Button>
            <Button variant="secondary" size="sm" icon={<Plus className="w-4 h-4" />} onClick={addCustomLine}>
              Add custom line
            </Button>
          </div>
        </div>
      )}

      {/* Summary — preview only, final amounts computed server-side per customer */}
      <div className="flex items-center justify-between gap-6 text-sm pt-2 border-t">
        <div className="text-xs text-gray-400 italic">
          Estimate using tier {primaryCustomerTier} pricing - the server computes each customer's real total on Preview/Save
        </div>
        <div className="flex gap-6">
          <div className="text-gray-500 text-xs">
            Est. $/Acre: <span className="font-medium text-gray-700">{fmt(Math.round(pricePerAcre))}</span>
          </div>
          <div className="text-gray-500 text-xs">
            Estimated total: <span className="font-medium text-gray-700">{fmt(invoiceTotal)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
