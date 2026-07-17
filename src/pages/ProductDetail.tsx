import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, DollarSign, ExternalLink, Search, Save } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Combobox from '../components/ui/Combobox';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import PricingChangePreviewModal from '../components/products/PricingChangePreviewModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { logActivity } from '../lib/activityLogger';
import { assertRpcResult, checkMutationResult, supabase, supabaseUntyped } from '../lib/db';
import { localToday } from '../lib/dateUtils';
import { waitForEpaRequestSlot } from '../lib/epaRequestThrottle';
import { Sentry } from '../lib/sentry';
import { unitOptionsForForm, isKnownUnit } from '../lib/units';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import type { CostHistory, EpaLookupResult, Product, UnitConversion } from '../types';
import {
  applyProductPricingChangeSet,
  formatPricingMarginPercent,
  previewProductPricingChanges,
  type PricingMode,
  type PricingPreviewInputRow,
  type PricingPreviewResult,
} from '../lib/productPricing';

const PRODUCT_NONPRICING_FIELDS = [
  'product_name', 'sku', 'category', 'vendor', 'manufacturer',
  'container_size', 'unit_size', 'suggested_rate', 'rate_per_acre', 'rate_unit',
  'notes', 'is_active', 'epa_registration', 'product_form', 'inventory_unit',
  'container_unit', 'container_type', 'is_rup', 'signal_word', 'internal_notes',
  'rei_hours', 'phi_days', 'max_label_rate', 'max_label_rate_unit', 'use_timing',
] as const satisfies ReadonlyArray<keyof Product>;

const PRODUCT_PRICING_FIELDS = [
  'current_cost', 'tier1_margin', 'tier2_margin', 'tier3_margin',
  'tier1_price', 'tier2_price', 'tier3_price',
] as const satisfies ReadonlyArray<keyof Product>;

function nonpricingProductPayload(product: Partial<Product>): Record<string, unknown> {
  return Object.fromEntries([
    ...PRODUCT_NONPRICING_FIELDS.map((field) => [field, product[field]] as const),
    ['updated_at', new Date().toISOString()],
  ]);
}

function pricingModeFor(product: Partial<Product>): PricingMode | '' {
  if ([product.tier1_margin, product.tier2_margin, product.tier3_margin]
    .every((value) => value !== null && value !== undefined)) return 'margin_driven';
  if ([product.tier1_price, product.tier2_price, product.tier3_price]
    .every((value) => value !== null && value !== undefined)) return 'price_driven';
  return '';
}

function pricingChanged(product: Partial<Product>, persisted: Product | null): boolean {
  if (!persisted) return false;
  return PRODUCT_PRICING_FIELDS.some((field) => product[field] !== persisted[field]);
}

function productDetailsChanged(product: Partial<Product>, persisted: Product | null): boolean {
  if (!persisted) return false;
  return PRODUCT_NONPRICING_FIELDS.some((field) => product[field] !== persisted[field]);
}

function pricingPreviewRow(
  product: Partial<Product>,
  persisted: Product,
  mode: PricingMode,
  reason: string,
  costOverride?: string,
): PricingPreviewInputRow {
  if (!Number.isInteger(persisted.pricing_version) || (persisted.pricing_version ?? 0) < 1) {
    throw new Error('This Product does not have a pricing version yet. Refresh after the Phase 1a database migration is available.');
  }
  const cost = costOverride ?? (product.current_cost == null ? null : String(product.current_cost));
  if (cost === null || cost === '') throw new Error('Enter the Product cost before reviewing pricing.');
  const row: PricingPreviewInputRow = {
    product_id: persisted.id,
    product_name: persisted.product_name,
    sku: persisted.sku ?? '',
    row_version: persisted.pricing_version!,
    pricing_mode: mode,
    new_cost: cost,
    change_reason: reason.trim() || 'Product page pricing update',
  };
  if (mode === 'margin_driven') {
    for (const tier of [1, 2, 3] as const) {
      const value = product[`tier${tier}_margin` as const];
      if (value === null || value === undefined) {
        throw new Error('Margin-driven pricing requires all three net margins.');
      }
      row[`tier${tier}_margin_percent` as const] = formatPricingMarginPercent(value);
    }
  } else {
    for (const tier of [1, 2, 3] as const) {
      const value = product[`tier${tier}_price` as const];
      if (value === null || value === undefined) {
        throw new Error('Price-driven pricing requires all three tier prices.');
      }
      row[`tier${tier}_price` as const] = String(value);
    }
  }
  return row;
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function namesClearlyDiffer(productName: string | null | undefined, epaName: string | null): boolean {
  if (!hasText(productName) || !hasText(epaName)) return false;

  const normalize = (value: string) => value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const current = normalize(productName);
  const epa = normalize(epaName);
  const currentCompact = current.replace(/\s+/g, '');
  const epaCompact = epa.replace(/\s+/g, '');
  if (currentCompact === epaCompact
      || currentCompact.includes(epaCompact)
      || epaCompact.includes(currentCompact)) {
    return false;
  }

  const currentTokens = new Set(current.split(' ').filter((token) => token.length >= 3));
  const epaTokens = epa.split(' ').filter((token) => token.length >= 3);
  return !epaTokens.some((token) => currentTokens.has(token));
}

function isEpaLookupResult(value: unknown): value is EpaLookupResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<EpaLookupResult>;
  const nullableString = (field: unknown) => field === null || typeof field === 'string';
  const canonicalSignalWord = result.signalWordCanonical === null
    || result.signalWordCanonical === 'Danger'
    || result.signalWordCanonical === 'Warning'
    || result.signalWordCanonical === 'Caution';
  const activeIngredientsValid = Array.isArray(result.activeIngredients)
    && result.activeIngredients.every((ingredient) => (
      ingredient
      && typeof ingredient === 'object'
      && typeof ingredient.name === 'string'
      && (ingredient.percent === null
        || (typeof ingredient.percent === 'number' && Number.isFinite(ingredient.percent)))
      && nullableString(ingredient.pcCode)
      && nullableString(ingredient.casNumber)
    ));
  const labelPdfsValid = Array.isArray(result.labelPdfs)
    && result.labelPdfs.every((pdf) => (
      pdf
      && typeof pdf === 'object'
      && typeof pdf.fileName === 'string'
      && nullableString(pdf.acceptedDate)
      && typeof pdf.url === 'string'
    ));
  return typeof result.found === 'boolean'
    && (result.regType === 'section3' || result.regType === 'distributor')
    && nullableString(result.eparegno)
    && nullableString(result.productname)
    && canonicalSignalWord
    && typeof result.needsManual === 'boolean'
    && nullableString(result.manufacturer)
    && (result.rupYn === null || result.rupYn === 'Yes' || result.rupYn === 'No')
    && nullableString(result.productStatus)
    && typeof result.isCancelled === 'boolean'
    && nullableString(result.latestLabelPdfUrl)
    && activeIngredientsValid
    && labelPdfsValid;
}

async function epaFunctionErrorMessage(error: unknown): Promise<string> {
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context;
    if (typeof Response !== 'undefined' && context instanceof Response) {
      try {
        const payload = await context.clone().json() as { error?: unknown };
        if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
      } catch {
        // Fall through to the SDK error message when the response is not JSON.
      }
    }
  }
  if (error && typeof error === 'object' && 'message' in error
      && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'EPA lookup failed. Please try again.';
}

export default function ProductDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const isNew = id === 'new';
  const isAdmin = role === 'admin';

  const [product, setProduct] = useState<Partial<Product>>({
    product_name: '',
    sku: '',
    category: '',
    vendor: '',
    manufacturer: '',
    container_size: undefined,
    unit_size: '',
    epa_registration: '',
    is_rup: false,
    signal_word: null,
    rei_hours: null,
    phi_days: null,
    product_form: null,
    inventory_unit: null,
    container_unit: null,
    container_type: null,
    current_cost: undefined,
    tier1_price: undefined,
    tier2_price: undefined,
    tier3_price: undefined,
    suggested_rate: '',
    rate_per_acre: undefined,
    rate_unit: '',
    notes: '',
    is_active: true,
  });
  const [costHistory, setCostHistory] = useState<CostHistory[]>([]);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);
  const [vendorOptions, setVendorOptions] = useState<string[]>([]);
  const [manufacturerOptions, setManufacturerOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [costModal, setCostModal] = useState(false);
  const [newCost, setNewCost] = useState('');
  const [costNote, setCostNote] = useState('');
  const [persistedProduct, setPersistedProduct] = useState<Product | null>(null);
  const [pricingMode, setPricingMode] = useState<PricingMode | ''>('');
  const [pricingPreview, setPricingPreview] = useState<PricingPreviewResult | null>(null);
  const [applyingPricing, setApplyingPricing] = useState(false);
  const [persistedLabelFields, setPersistedLabelFields] = useState<{
    signalWord: Product['signal_word'];
    epaRegistration: string | null;
  }>({ signalWord: null, epaRegistration: null });
  const [epaLookupResult, setEpaLookupResult] = useState<EpaLookupResult | null>(null);
  const [epaLookupRegNumber, setEpaLookupRegNumber] = useState('');
  const [epaLookupLoading, setEpaLookupLoading] = useState(false);
  const [epaDraftCreating, setEpaDraftCreating] = useState(false);
  const epaDraftKey = useIdempotencyKey('create_label_draft', profile?.id ?? '');
  const previewPricingIdem = useIdempotencyKey('preview_product_pricing_changes', profile?.id ?? '');
  const applyPricingIdem = useIdempotencyKey('apply_product_pricing_change_set', profile?.id ?? '');

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const blocker = useUnsavedChanges(isDirty);

  const fetchProduct = useCallback(async (reportError = true): Promise<boolean> => {
    const { data, error } = await supabase.from('products').select('*').eq('id', id!).maybeSingle();
    if (error) {
      Sentry.captureException(error);
      if (reportError) toast('error', 'Failed to load product');
      setLoading(false);
      return false;
    }
    if (data) {
      const loadedProduct = data as Product;
      setProduct(loadedProduct);
      setPersistedProduct(loadedProduct);
      setPricingMode(pricingModeFor(loadedProduct));
      setIsDirty(false);
      setPersistedLabelFields({
        signalWord: loadedProduct.signal_word,
        epaRegistration: loadedProduct.epa_registration,
      });
    }
    setLoading(false);
    return data !== null;
  }, [id, toast]);

  const fetchCostHistory = useCallback(async (reportError = true): Promise<boolean> => {
    const { data, error } = await supabase
      .from('cost_history')
      .select('*')
      .eq('product_id', id!)
      .order('changed_at', { ascending: false })
      .limit(20);
    if (error) {
      Sentry.captureException(error);
      if (reportError) toast('error', 'Failed to load pricing history');
      return false;
    }
    setCostHistory((data || []) as CostHistory[]);
    return true;
  }, [id, toast]);

  useEffect(() => {
    if (!isNew && id) {
      void fetchProduct();
      void fetchCostHistory();
    }
  }, [id, isNew, fetchProduct, fetchCostHistory]);

  useEffect(() => {
    supabase.from('unit_conversions').select('*').order('unit').then(({ data, error }) => {
      if (error) { Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_unit_conversions' } }); return; }
      setUnitConversions((data || []) as UnitConversion[]);
    });
    // Fetch distinct values for combobox dropdowns
    supabase.from('products').select('category, vendor, manufacturer').then(({ data, error }) => {
      if (error) { Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_product_options' } }); return; }
      if (!data) return;
      const cats = [...new Set(data.map((p) => p.category).filter(Boolean) as string[])].sort();
      const vends = [...new Set(data.map((p) => p.vendor).filter(Boolean) as string[])].sort();
      const mfrs = [...new Set(data.map((p) => p.manufacturer).filter(Boolean) as string[])].sort();
      setCategoryOptions(cats);
      setVendorOptions(vends);
      setManufacturerOptions(mfrs);
    });
  }, []);

  const saveExistingProductDetails = async () => {
    const result = await supabaseUntyped
      .from('products')
      .update(nonpricingProductPayload(product))
      .eq('id', id!)
      .select();
    checkMutationResult(result, 'Update product details');
    setPersistedLabelFields({
      signalWord: product.signal_word ?? null,
      epaRegistration: product.epa_registration?.trim() || null,
    });
  };

  const requestPricingReview = async ({
    costOverride,
    reason,
  }: {
    costOverride?: string;
    reason: string;
  }) => {
    if (!profile || !persistedProduct) throw new Error('Reload this Product before changing pricing.');
    if (productDetailsChanged(product, persistedProduct)) {
      throw new Error('Save or discard the unsaved Product details before reviewing a pricing change.');
    }
    if (pricingMode !== 'margin_driven' && pricingMode !== 'price_driven') {
      throw new Error('Choose margin-driven or price-driven before reviewing pricing.');
    }
    const preview = await previewProductPricingChanges({
      source: 'product_page',
      rows: [pricingPreviewRow(product, persistedProduct, pricingMode, reason, costOverride)],
      performedBy: profile.id,
      idempotencyKey: previewPricingIdem.getKey(),
    });
    previewPricingIdem.resetKey();

    setPricingPreview(preview);
  };

  const handleSave = async () => {
    if (!product.product_name) {
      toast('error', 'Product name is required');
      return;
    }

    // Cost must be non-negative
    if (product.current_cost != null && product.current_cost < 0) {
      toast('error', 'Cost cannot be negative');
      return;
    }

    // Tier prices must be non-negative
    if (product.tier1_price != null && product.tier1_price < 0) {
      toast('error', 'Tier 1 price cannot be negative');
      return;
    }
    if (product.tier2_price != null && product.tier2_price < 0) {
      toast('error', 'Tier 2 price cannot be negative');
      return;
    }
    if (product.tier3_price != null && product.tier3_price < 0) {
      toast('error', 'Tier 3 price cannot be negative');
      return;
    }

    // Container size must be positive if set
    if (product.container_size != null && product.container_size <= 0) {
      toast('error', 'Container size must be greater than 0');
      return;
    }

    // Label intervals must be non-negative (printed on WPS compliance notices)
    if (product.rei_hours != null && product.rei_hours < 0) {
      toast('error', 'REI (hours) cannot be negative');
      return;
    }
    if (product.phi_days != null && product.phi_days < 0) {
      toast('error', 'PHI (days) cannot be negative');
      return;
    }

    // Warn (but allow) if price < cost. The server preview remains authoritative.
    const cost = product.current_cost ?? 0;
    const prices = [product.tier1_price, product.tier2_price, product.tier3_price].filter((p): p is number => p != null && p > 0);
    if (cost > 0 && prices.some((p) => p < cost)) {
      toast('warning', 'Warning: One or more tier prices are below cost (negative margin)');
    }

    setSaving(true);
    try {
      if (isNew) {
        const productInsertResult = await supabaseUntyped
          .from('products')
          .insert([nonpricingProductPayload(product)])
          .select();
        if (productInsertResult.error) throw productInsertResult.error;
        checkMutationResult(productInsertResult, 'Insert product');
        setIsDirty(false);
        toast('success', 'Product created');
        logActivity({ event: 'product_created', description: `Product ${product.product_name} created`, performedBy: profile!.id, entityType: 'product' });
        navigate('/products');
        return;
      }

      const hasPricingChanges = pricingChanged(product, persistedProduct);
      const hasProductDetailChanges = productDetailsChanged(product, persistedProduct);
      if (hasPricingChanges && hasProductDetailChanges) {
        throw new Error('Save Product details and pricing in separate review steps. Revert one kind of change, save the other, then make the remaining change.');
      }

      if (hasPricingChanges) {
        await requestPricingReview({
          reason: 'Product page pricing update',
        });
        return;
      }

      await saveExistingProductDetails();
      await fetchProduct();
      setIsDirty(false);
      toast('success', 'Product updated');
      logActivity({ event: 'product_updated', description: `Product ${product.product_name} updated`, performedBy: profile!.id, entityType: 'product', entityId: id });
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_product' } });
      toast('error', err instanceof Error ? err.message : 'Failed to save Product');
    } finally {
      setSaving(false);
    }
  };

  const handleCostUpdate = async () => {
    const cost = parseFloat(newCost);
    if (isNaN(cost)) {
      toast('error', 'Enter a valid cost');
      return;
    }
    if (cost < 0) {
      toast('error', 'Cost cannot be negative');
      return;
    }
    if (pricingMode === 'margin_driven' && cost === 0) {
      toast('error', 'Margin-driven pricing requires a cost greater than $0. No prices were changed.');
      return;
    }
    try {
      await requestPricingReview({
        costOverride: newCost,
        reason: costNote || 'Minor mid-month supplier increase',
      });
      setCostModal(false);
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to preview cost change');
    }
  };

  const handleApplyPricing = async () => {
    if (!pricingPreview || !profile) return;
    setApplyingPricing(true);
    try {
      const result = await applyProductPricingChangeSet({
        changeSetId: pricingPreview.change_set_id,
        requestFingerprint: pricingPreview.request_fingerprint,
        performedBy: profile.id,
        idempotencyKey: applyPricingIdem.getKey(),
      });
      applyPricingIdem.resetKey();
      setPricingPreview(null);
      setNewCost('');
      setCostNote('');
      const [productReloaded, historyReloaded] = await Promise.all([
        fetchProduct(false),
        fetchCostHistory(false),
      ]);
      setIsDirty(false);
      if (productReloaded && historyReloaded) {
        toast('success', `Applied pricing to ${result.applied_count} Product.`);
      } else {
        toast('warning', 'Pricing was applied, but the latest Product values could not be reloaded. Refresh this page before making another change.');
      }
      logActivity({ event: 'product_cost_updated', description: `Product pricing updated through approved preview`, performedBy: profile.id, entityType: 'product', entityId: id });
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to apply pricing');
    } finally {
      setApplyingPricing(false);
    }
  };

  const handleEpaLookup = async () => {
    const regNumber = product.epa_registration?.trim() ?? '';
    if (!regNumber) {
      toast('warning', 'Enter an EPA registration number first.');
      return;
    }

    setEpaLookupLoading(true);
    setEpaLookupResult(null);
    setEpaLookupRegNumber('');
    try {
      const slotReady = await waitForEpaRequestSlot(() => false);
      if (!slotReady) return;
      const { data, error } = await supabase.functions.invoke<EpaLookupResult>('epa-lookup', {
        body: { regNumber },
      });
      if (error) throw new Error(await epaFunctionErrorMessage(error));
      if (data && typeof data === 'object' && 'error' in data
          && typeof (data as { error?: unknown }).error === 'string') {
        throw new Error((data as { error: string }).error);
      }
      if (!isEpaLookupResult(data)) {
        throw new Error('EPA lookup returned an invalid response. Please try again.');
      }

      setEpaLookupResult(data);
      setEpaLookupRegNumber(regNumber);
      if (!data.found) {
        toast('warning', `EPA did not find registration ${regNumber}.`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { source: 'edge_function', action: 'epa_lookup' },
      });
      toast('error', err instanceof Error ? err.message : 'EPA lookup failed. Please try again.');
    } finally {
      setEpaLookupLoading(false);
    }
  };

  const handleCreateEpaDraft = async () => {
    if (!profile || !id || isNew || !epaLookupResult?.found) return;

    const currentRegNumber = product.epa_registration?.trim() ?? '';
    if (!currentRegNumber || currentRegNumber !== epaLookupRegNumber) {
      toast('warning', 'The EPA registration changed after lookup. Look it up again before applying.');
      return;
    }

    const validatedRegNumber = epaLookupResult.eparegno?.trim();
    if (!validatedRegNumber) {
      toast('error', 'EPA did not return a validated registration number.');
      return;
    }

    const existingSignalWord = hasText(persistedLabelFields.signalWord)
      ? persistedLabelFields.signalWord.trim()
      : null;
    const existingRegistration = hasText(persistedLabelFields.epaRegistration)
      ? persistedLabelFields.epaRegistration.trim()
      : null;

    // A product's label data may only be filled from a lookup of ITS OWN saved
    // registration number. If it already has a (different) saved registration,
    // applying data from an unrelated lookup would attach the wrong hazard word
    // to it — empty-fields-only keeps the saved (mismatched) registration while
    // still filling the signal word from the unrelated lookup. Block that.
    // (Codex ship-gate blocker, 2026-07-10 — regulatory-data corruption.)
    if (existingRegistration && existingRegistration !== validatedRegNumber) {
      toast(
        'warning',
        "This lookup is for a different registration number than the one saved on this product. To fill its label data, look up the product's own saved registration number, or correct the saved number first.",
      );
      return;
    }

    const proposedSignalWord = !existingSignalWord && !epaLookupResult.needsManual
      ? epaLookupResult.signalWordCanonical
      : null;
    const proposedRegistration = !existingRegistration ? validatedRegNumber : null;

    if (!proposedSignalWord && !proposedRegistration && !epaLookupResult.needsManual) {
      toast('warning', 'Nothing to apply — the supported product fields are already filled.');
      return;
    }

    const sourceNotes = [`EPA PPLS lookup ${validatedRegNumber} ${localToday()}`];
    if (epaLookupResult.needsManual) {
      sourceNotes.push('EPA signal word was unrecognized and was omitted for manual review.');
    } else if (existingSignalWord && epaLookupResult.signalWordCanonical
        && existingSignalWord !== epaLookupResult.signalWordCanonical) {
      sourceNotes.push(
        `Signal word differs: product has ${existingSignalWord}; EPA reports ${epaLookupResult.signalWordCanonical}. Omitted per empty-fields-only policy.`,
      );
    }
    if (existingRegistration && existingRegistration !== validatedRegNumber) {
      sourceNotes.push(
        `EPA registration differs: product has ${existingRegistration}; EPA validated ${validatedRegNumber}. Omitted per empty-fields-only policy.`,
      );
    }

    setEpaDraftCreating(true);
    try {
      const { data, error } = await supabaseUntyped.rpc('create_label_draft', {
        p_product_id: id,
        p_signal_word: proposedSignalWord,
        p_epa_registration: proposedRegistration,
        p_source_note: sourceNotes.join(' '),
        p_confidence: epaLookupResult.needsManual ? 'medium' : 'high',
        p_status: epaLookupResult.needsManual ? 'needs_manual' : 'pending',
        p_idempotency_key: epaDraftKey.getKey(),
      });
      if (error) throw error;
      const draftId = assertRpcResult<string>(data, 'create_label_draft');
      await logActivity({
        event: 'label_draft_created',
        description: `Created EPA label draft ${draftId} for product ${id}`,
        performedBy: profile.id,
        entityType: 'product',
        entityId: id,
      });
      epaDraftKey.resetKey();
      toast('success', 'EPA draft created — review it before applying any product changes.');
      navigate('/label-review');
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : String(err);
      toast('error', `Could not create EPA draft: ${message}`);
    } finally {
      setEpaDraftCreating(false);
    }
  };

  const update = (field: string, value: unknown) => {
    setProduct((p) => ({ ...p, [field]: value }));
    setIsDirty(true);
    if (field === 'epa_registration'
        && (typeof value !== 'string' || value.trim() !== epaLookupRegNumber)) {
      setEpaLookupResult(null);
      setEpaLookupRegNumber('');
    }
  };

  if (loading) {
    return <div className="animate-pulse space-y-4"><div className="h-8 bg-gray-200 rounded w-1/3" /><div className="h-64 bg-gray-200 rounded" /></div>;
  }

  if (!isNew && !product.id) {
    return (
      <div className="flex flex-col items-center justify-center py-16 space-y-4">
        <p className="text-secondary text-lg">Product not found</p>
        <Button variant="secondary" onClick={() => navigate('/products')}>Back to Products</Button>
      </div>
    );
  }

  const epaNameMismatch = Boolean(
    epaLookupResult?.found
      && epaLookupResult.regType !== 'distributor'
      && namesClearlyDiffer(product.product_name, epaLookupResult.productname),
  );
  const epaRupValue = epaLookupResult?.rupYn === 'Yes'
    ? true
    : epaLookupResult?.rupYn === 'No'
      ? false
      : null;
  const epaRupMismatch = epaLookupResult?.found
    && epaRupValue !== null
    && epaRupValue !== Boolean(product.is_rup);
  const persistedSignalWord = hasText(persistedLabelFields.signalWord)
    ? persistedLabelFields.signalWord.trim()
    : null;
  const persistedRegistration = hasText(persistedLabelFields.epaRegistration)
    ? persistedLabelFields.epaRegistration.trim()
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button aria-label="Back to products" onClick={() => navigate('/products')} className="p-2 rounded-lg hover:bg-white hover:shadow-sm transition-all text-secondary">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold font-heading text-nav-dark">
          {isNew ? 'New Product' : product.product_name}
        </h2>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader title="Product" accent="Information" />

            {/* Basic Info */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Product Name" required value={product.product_name || ''} onChange={(e) => update('product_name', e.target.value)} disabled={!isAdmin} />
              <Input label="SKU" value={product.sku || ''} onChange={(e) => update('sku', e.target.value)} disabled={!isAdmin} />
              <Combobox label="Category" value={product.category || ''} onChange={(v) => update('category', v)} options={categoryOptions} disabled={!isAdmin} placeholder="Type or select..." />
              {(product.category === 'Herbicide' || product.category === 'Foliar Fertilizer') && (
                <Combobox
                  label="Use Timing"
                  value={product.use_timing || ''}
                  onChange={(v) => update('use_timing', v || null)}
                  options={product.category === 'Foliar Fertilizer'
                    ? ['Foliar']
                    : ['Post-Emergence', 'Pre-Emerge Corn', 'Pre-Emerge Soybean', 'Volunteer Corn', 'Range/Pasture/Turf']}
                  disabled={!isAdmin}
                  placeholder="Type or select..."
                />
              )}
              <Combobox label="Vendor" value={product.vendor || ''} onChange={(v) => update('vendor', v)} options={vendorOptions} disabled={!isAdmin} placeholder="Type or select..." />
              <Combobox label="Manufacturer" value={product.manufacturer || ''} onChange={(v) => update('manufacturer', v)} options={manufacturerOptions} disabled={!isAdmin} placeholder="Type or select..." />
              <div>
                <div className="flex items-end gap-2">
                  <Input
                    label="EPA Registration"
                    value={product.epa_registration || ''}
                    onChange={(e) => update('epa_registration', e.target.value)}
                    disabled={!isAdmin}
                    placeholder="e.g., 34704-69"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    showChevron={false}
                    icon={<Search className="w-4 h-4" />}
                    loading={epaLookupLoading}
                    disabled={!isAdmin}
                    onClick={() => void handleEpaLookup()}
                    className="mb-px shrink-0"
                  >
                    Look up EPA
                  </Button>
                </div>
                {isNew && (
                  <p className="mt-1 text-xs text-secondary">
                    You can preview EPA data now, but save the product before creating a review draft.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={product.is_rup || false}
                    onChange={(e) => update('is_rup', e.target.checked)}
                    disabled={!isAdmin}
                    className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                  />
                  <span className="text-sm font-medium text-nav-dark">Restricted Use (RUP)</span>
                </label>
              </div>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Signal Word</label>
                <select
                  value={product.signal_word || ''}
                  onChange={(e) => update('signal_word', e.target.value || null)}
                  disabled={!isAdmin}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                >
                  <option value="">None</option>
                  <option value="Danger">Danger</option>
                  <option value="Warning">Warning</option>
                  <option value="Caution">Caution</option>
                </select>
              </div>
              <Input
                label="REI (hours)"
                type="number"
                min={0}
                value={product.rei_hours ?? ''}
                onChange={(e) => update('rei_hours', e.target.value === '' ? null : parseInt(e.target.value, 10))}
                disabled={!isAdmin}
                placeholder="From label, e.g. 12"
              />
              <Input
                label="PHI (days)"
                type="number"
                min={0}
                value={product.phi_days ?? ''}
                onChange={(e) => update('phi_days', e.target.value === '' ? null : parseInt(e.target.value, 10))}
                disabled={!isAdmin}
                placeholder="From label, e.g. 30"
              />
            </div>

            {epaLookupResult && (
              <div className="mt-5 border-t border-gray-100 pt-5" aria-live="polite">
                {!epaLookupResult.found ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                    <div className="flex items-start gap-2 text-amber-900">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                      <div>
                        <p className="font-semibold">No EPA registration found</p>
                        <p className="mt-1 text-sm">
                          EPA returned no record for {epaLookupRegNumber}. Check the number and try again.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h3 className="font-semibold text-nav-dark">EPA lookup preview</h3>
                        <p className="text-xs text-secondary">
                          Report-only details stay here; only eligible empty fields enter Label Review.
                        </p>
                      </div>
                      {epaLookupResult.latestLabelPdfUrl && (
                        <a
                          href={epaLookupResult.latestLabelPdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm font-medium text-crx-green hover:underline"
                        >
                          Latest label PDF
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                    </div>

                    {(epaNameMismatch
                      || epaLookupResult.isCancelled
                      || epaLookupResult.regType === 'distributor'
                      || epaRupMismatch
                      || epaLookupResult.needsManual) && (
                      <div className="space-y-2" aria-label="EPA lookup warnings">
                        {epaLookupResult.isCancelled && (
                          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>Cancelled registration:</strong> informational only; no product status is changed.</span>
                          </div>
                        )}
                        {epaLookupResult.regType === 'distributor' && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>Distributor sub-registration:</strong> a different trade name is expected and is not treated as a mismatch.</span>
                          </div>
                        )}
                        {epaNameMismatch && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>Suspected product mismatch:</strong> EPA calls this “{epaLookupResult.productname}”; verify the registration before proceeding.</span>
                          </div>
                        )}
                        {epaRupMismatch && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>RUP differs:</strong> EPA reports {epaLookupResult.rupYn}, while this product is marked {product.is_rup ? 'Yes' : 'No'}. No automatic change will be made.</span>
                          </div>
                        )}
                        {epaLookupResult.needsManual && (
                          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span><strong>Signal word needs manual review:</strong> no unrecognized EPA value will be placed in the draft.</span>
                          </div>
                        )}
                      </div>
                    )}

                    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">EPA product name</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.productname ?? 'Not provided'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Signal word</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.needsManual ? 'Needs manual review' : epaLookupResult.signalWordCanonical ?? 'No signal word'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Manufacturer</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.manufacturer ?? 'Not provided'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Restricted use (RUP)</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.rupYn ?? 'Not provided'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Product status</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.productStatus ?? 'Not provided'}</dd></div>
                      <div><dt className="text-xs font-medium uppercase tracking-wide text-secondary">Registration type</dt><dd className="mt-0.5 font-medium text-nav-dark">{epaLookupResult.regType === 'distributor' ? 'Distributor sub-registration' : 'Section 3'}</dd></div>
                    </dl>

                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-secondary">Active ingredients</p>
                      {epaLookupResult.activeIngredients.length > 0 ? (
                        <ul className="mt-1 space-y-1 text-sm text-nav-dark">
                          {epaLookupResult.activeIngredients.map((ingredient) => (
                            <li key={`${ingredient.name}-${ingredient.pcCode ?? ingredient.casNumber ?? 'unknown'}`}>
                              {ingredient.name}{ingredient.percent != null ? ` — ${ingredient.percent}%` : ''}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-1 text-sm text-secondary">Not provided</p>
                      )}
                    </div>

                    <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
                      <p className="font-semibold text-nav-dark">Draft preview (empty fields only)</p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div>
                          <span className="text-secondary">Signal word: </span>
                          {persistedSignalWord
                            ? persistedSignalWord === epaLookupResult.signalWordCanonical
                              ? 'Already set — not included in draft'
                              : 'Differs — review in Label Review'
                            : epaLookupResult.needsManual
                              ? 'Omitted — manual review required'
                              : epaLookupResult.signalWordCanonical ?? 'Verified as no signal word'}
                        </div>
                        <div>
                          <span className="text-secondary">EPA registration: </span>
                          {persistedRegistration
                            ? persistedRegistration === epaLookupResult.eparegno
                              ? 'Already set — not included in draft'
                              : 'Differs — review in Label Review'
                            : epaLookupResult.eparegno}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="max-w-2xl text-xs text-secondary">
                        This creates a draft only. The product is not changed until an admin reviews and commits it in Label Review.
                      </p>
                      <Button
                        type="button"
                        onClick={() => void handleCreateEpaDraft()}
                        loading={epaDraftCreating}
                        disabled={isNew}
                      >
                        Apply to product
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Product Form */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Product Form</p>
              <p className="text-xs text-gray-400 mt-0.5 mb-3">Determines which units are available below</p>
              <div className="max-w-xs">
                <select
                  value={product.product_form || ''}
                  onChange={(e) => {
                    const form = e.target.value || null;
                    update('product_form', form);
                    if (form !== product.product_form) {
                      setProduct((p) => ({ ...p, product_form: form as Product['product_form'], inventory_unit: null, container_unit: null }));
                    }
                  }}
                  disabled={!isAdmin}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                >
                  <option value="">-- Select --</option>
                  <option value="liquid">Liquid</option>
                  <option value="dry">Dry</option>
                </select>
              </div>
            </div>

            {/* Container — grouped as one row */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Container</p>
              <p className="text-xs text-gray-400 mt-0.5 mb-3">Size, unit, and type (e.g. 2.5 Gal Jug)</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="Size" type="number" value={product.container_size ?? ''} onChange={(e) => update('container_size', e.target.value ? parseFloat(e.target.value) : null)} disabled={!isAdmin} placeholder="e.g. 2.5" />
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1">Unit</label>
                  <select
                    value={product.container_unit || ''}
                    onChange={(e) => update('container_unit', e.target.value || null)}
                    disabled={!isAdmin}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                  >
                    <option value="">-- Select --</option>
                    {unitConversions
                      .filter((uc) => {
                        const form = product.product_form;
                        if (!form) return true;
                        return uc.unit_type === form || uc.unit_type === 'both';
                      })
                      .map((uc) => (
                        <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1">Type</label>
                  <select
                    value={product.container_type || ''}
                    onChange={(e) => update('container_type', e.target.value || null)}
                    disabled={!isAdmin}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                  >
                    <option value="">-- Select --</option>
                    <option value="Jug">Jug</option>
                    <option value="Drum">Drum</option>
                    <option value="Pallet">Pallet</option>
                    <option value="Mini-Bulk">Mini-Bulk</option>
                    <option value="Shuttle">Shuttle</option>
                    <option value="Bag">Bag</option>
                    <option value="Tote">Tote</option>
                    <option value="Jar">Jar</option>
                    <option value="Ea">Ea</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Inventory Unit */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Inventory Unit</p>
              <p className="text-xs text-gray-400 mt-0.5 mb-3">Unit used for tracking inventory quantities (e.g. Gal, Lb)</p>
              <div className="max-w-xs">
                <select
                  value={product.inventory_unit || ''}
                  onChange={(e) => update('inventory_unit', e.target.value || null)}
                  disabled={!isAdmin}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                >
                  <option value="">-- Select --</option>
                  {/* WaveB: grandfather a legacy value the form filter would otherwise hide, so a save can't blank it */}
                  {!isKnownUnit(unitConversions, product.product_form, product.inventory_unit) && (
                    <option value={product.inventory_unit || ''}>{product.inventory_unit} (existing)</option>
                  )}
                  {unitOptionsForForm(unitConversions, product.product_form).map((uc) => (
                    <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Application Rates */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-xs font-semibold text-secondary uppercase tracking-wide">Application Rates</p>
              <p className="text-xs text-gray-400 mt-0.5 mb-3">Per-acre application information</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Input label="Suggested Rate" value={product.suggested_rate || ''} onChange={(e) => update('suggested_rate', e.target.value)} disabled={!isAdmin} />
                <Input label="Rate Per Acre" type="number" value={product.rate_per_acre ?? ''} onChange={(e) => update('rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)} disabled={!isAdmin} />
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1">Rate Unit</label>
                  <select
                    value={product.rate_unit || ''}
                    onChange={(e) => update('rate_unit', e.target.value)}
                    disabled={!isAdmin}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
                  >
                    <option value="">-- Select --</option>
                    {/* WaveB: grandfather a legacy value the form filter would otherwise hide, so a save can't blank it */}
                    {!isKnownUnit(unitConversions, product.product_form, product.rate_unit) && (
                      <option value={product.rate_unit || ''}>{product.rate_unit} (existing)</option>
                    )}
                    {unitOptionsForForm(unitConversions, product.product_form).map((uc) => (
                      <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Grower Description (existing notes field) */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label htmlFor="grower-description" className="block text-sm font-medium text-secondary mb-1">Grower Description</label>
              <p className="text-xs text-gray-400 mb-1">Shown to growers on quotes and PDFs. Describe what the product does, application tips, etc.</p>
              <textarea
                id="grower-description"
                value={product.notes || ''}
                onChange={(e) => update('notes', e.target.value)}
                disabled={!isAdmin}
                rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
              />
            </div>

            {/* Internal Notes */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label htmlFor="internal-notes" className="block text-sm font-medium text-secondary mb-1">Internal Notes</label>
              <p className="text-xs text-gray-400 mb-1">Internal only — never shown to growers.</p>
              <textarea
                id="internal-notes"
                value={product.internal_notes || ''}
                onChange={(e) => update('internal_notes', e.target.value)}
                disabled={!isAdmin}
                rows={3}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
              />
            </div>
          </Card>

          {isAdmin && (
            <Card>
              <CardHeader title="Pricing" accent="& Margins" />
              {isNew ? (
                <div className="p-3 mb-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
                  Create the Product details first. Pricing is added afterward through a reviewed change so a new Product can never bypass approval.
                </div>
              ) : (
                <div className="mb-4">
                  <label htmlFor="product-pricing-mode" className="block text-sm font-medium text-secondary mb-1">Pricing mode</label>
                  <select
                    id="product-pricing-mode"
                    value={pricingMode}
                    onChange={(event) => setPricingMode(event.target.value as PricingMode | '')}
                    className="w-full sm:max-w-xs px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">Choose a mode</option>
                    <option value="margin_driven">Margin-driven — cost + margins set prices</option>
                    <option value="price_driven">Price-driven — cost + prices set margins</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">Only the selected input family is editable. The server shows every resulting price before Apply.</p>
                </div>
              )}
              <div className="p-3 mb-4 bg-blue-50 border border-blue-100 rounded-lg">
                <p className="text-xs text-secondary mb-2">
                  <span className="font-medium">All prices are per inventory unit</span> (e.g., per gallon, per pound). Margin-driven mode keeps your three net margins and recalculates prices; price-driven mode keeps your three entered prices and reconciles the margins.
                </p>
                <div className="text-xs text-gray-600 space-y-1">
                  <p><span className="font-medium">Net Margin</span> = Profit % of price (e.g., 20% net → $100 price on $80 cost)</p>
                  <p><span className="font-medium">Gross Margin</span> = Markup % (auto-calculated, e.g., 25%)</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Cost</h4>
                  <div className="flex items-center gap-2">
                    <Input id="product-current-cost" label="Current Cost" type="number" value={product.current_cost ?? ''} onChange={(e) => update('current_cost', e.target.value ? parseFloat(e.target.value) : null)} disabled={isNew} />
                    {!isNew && (
                      <Button variant="secondary" size="sm" icon={<DollarSign className="w-3 h-3" />} showChevron={false} onClick={() => setCostModal(true)} className="mt-5">
                        Update
                      </Button>
                    )}
                  </div>
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Tier 1</h4>
                  <Input id="tier1-price" aria-label="Tier 1 price" label="Price" type="number" value={product.tier1_price ?? ''} onChange={(e) => update('tier1_price', e.target.value ? parseFloat(e.target.value) : null)} disabled={isNew || pricingMode !== 'price_driven'} />
                  <Input id="tier1-net-margin" aria-label="Tier 1 net margin percent" label="Net Margin %" type="number" value={product.tier1_margin != null ? (product.tier1_margin * 100).toFixed(1) : ''} onChange={(e) => update('tier1_margin', e.target.value ? parseFloat(e.target.value) / 100 : null)} placeholder="e.g., 20 for 20%" disabled={isNew || pricingMode !== 'margin_driven'} />
                  {product.tier1_gross_margin != null && (
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <span className="text-xs text-gray-500">Gross Margin: </span>
                      <span className="text-sm font-medium text-secondary">{(product.tier1_gross_margin * 100).toFixed(1)}%</span>
                    </div>
                  )}
                  {product.tier1_price_per_acre != null && (
                    <div
                      className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100"
                      title="Auto-calculated from the tier price and the product's label rate. Refreshes when you save."
                    >
                      <span className="text-xs text-gray-500">Per acre (label rate): </span>
                      <span className="text-sm font-medium text-secondary">${product.tier1_price_per_acre.toFixed(2)} / acre</span>
                    </div>
                  )}
                </div>
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Tier 2</h4>
                  <Input id="tier2-price" aria-label="Tier 2 price" label="Price" type="number" value={product.tier2_price ?? ''} onChange={(e) => update('tier2_price', e.target.value ? parseFloat(e.target.value) : null)} disabled={isNew || pricingMode !== 'price_driven'} />
                  <Input id="tier2-net-margin" aria-label="Tier 2 net margin percent" label="Net Margin %" type="number" value={product.tier2_margin != null ? (product.tier2_margin * 100).toFixed(1) : ''} onChange={(e) => update('tier2_margin', e.target.value ? parseFloat(e.target.value) / 100 : null)} placeholder="e.g., 25 for 25%" disabled={isNew || pricingMode !== 'margin_driven'} />
                  {product.tier2_gross_margin != null && (
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <span className="text-xs text-gray-500">Gross Margin: </span>
                      <span className="text-sm font-medium text-secondary">{(product.tier2_gross_margin * 100).toFixed(1)}%</span>
                    </div>
                  )}
                  {product.tier2_price_per_acre != null && (
                    <div
                      className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100"
                      title="Auto-calculated from the tier price and the product's label rate. Refreshes when you save."
                    >
                      <span className="text-xs text-gray-500">Per acre (label rate): </span>
                      <span className="text-sm font-medium text-secondary">${product.tier2_price_per_acre.toFixed(2)} / acre</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
                <div />
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-secondary">Tier 3</h4>
                  <Input id="tier3-price" aria-label="Tier 3 price" label="Price" type="number" value={product.tier3_price ?? ''} onChange={(e) => update('tier3_price', e.target.value ? parseFloat(e.target.value) : null)} disabled={isNew || pricingMode !== 'price_driven'} />
                  <Input id="tier3-net-margin" aria-label="Tier 3 net margin percent" label="Net Margin %" type="number" value={product.tier3_margin != null ? (product.tier3_margin * 100).toFixed(1) : ''} onChange={(e) => update('tier3_margin', e.target.value ? parseFloat(e.target.value) / 100 : null)} placeholder="e.g., 30 for 30%" disabled={isNew || pricingMode !== 'margin_driven'} />
                  {product.tier3_gross_margin != null && (
                    <div className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100">
                      <span className="text-xs text-gray-500">Gross Margin: </span>
                      <span className="text-sm font-medium text-secondary">{(product.tier3_gross_margin * 100).toFixed(1)}%</span>
                    </div>
                  )}
                  {product.tier3_price_per_acre != null && (
                    <div
                      className="px-3 py-2 bg-gray-50 rounded-lg border border-gray-100"
                      title="Auto-calculated from the tier price and the product's label rate. Refreshes when you save."
                    >
                      <span className="text-xs text-gray-500">Per acre (label rate): </span>
                      <span className="text-sm font-medium text-secondary">${product.tier3_price_per_acre.toFixed(2)} / acre</span>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          )}

          {isAdmin && (
            <div className="flex justify-end">
              <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
                {isNew ? 'Create Product' : 'Save Changes'}
              </Button>
            </div>
          )}
        </div>

        {!isNew && isAdmin && (
          <div className="space-y-4">
            <Card>
              <CardHeader title="Cost" accent="History" />
              {costHistory.length === 0 ? (
                <p className="text-sm text-secondary">No cost changes recorded</p>
              ) : (
                <div className="space-y-3">
                  {costHistory.map((ch) => (
                    <div key={ch.id} className="border-b border-gray-50 pb-3 last:border-0">
                      <div className="flex justify-between text-sm">
                        <span className="text-red-500 line-through">${ch.old_cost?.toFixed(2)}</span>
                        <span className="text-crx-green font-medium">${ch.new_cost?.toFixed(2)}</span>
                      </div>
                      {ch.change_note && <p className="text-xs text-secondary mt-1">{ch.change_note}</p>}
                      <p className="text-xs text-gray-400 mt-1">{new Date(ch.changed_at).toLocaleDateString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      <Modal open={costModal} onClose={() => setCostModal(false)} title="Update" accent="Cost">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Current cost: <strong>${product.current_cost?.toFixed(2) ?? 'N/A'}</strong>
          </p>
          <Input label="New Cost" type="number" value={newCost} onChange={(e) => setNewCost(e.target.value)} placeholder="0.00" />
          <div>
            <label htmlFor="cost-update-pricing-mode" className="block text-sm font-medium text-secondary mb-1">Pricing mode</label>
            <select
              id="cost-update-pricing-mode"
              value={pricingMode}
              onChange={(event) => setPricingMode(event.target.value as PricingMode | '')}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Choose a mode</option>
              <option value="margin_driven">Keep margins; recalculate prices</option>
              <option value="price_driven">Keep entered prices; reconcile margins</option>
            </select>
          </div>
          <Input label="Change Note (optional)" value={costNote} onChange={(e) => setCostNote(e.target.value)} placeholder="e.g. Supplier price increase" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" showChevron={false} onClick={() => setCostModal(false)}>Cancel</Button>
            <Button onClick={handleCostUpdate}>Review Cost Change</Button>
          </div>
        </div>
      </Modal>

      <PricingChangePreviewModal
        open={pricingPreview !== null}
        preview={pricingPreview}
        applying={applyingPricing}
        title="Review Product Pricing"
        onClose={() => {
          setPricingPreview(null);
          applyPricingIdem.resetKey();
        }}
        onApprove={() => void handleApplyPricing()}
      />

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
