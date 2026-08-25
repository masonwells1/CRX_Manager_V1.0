import { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, Save, AlertCircle, Beaker } from 'lucide-react';
import Button from '../ui/Button';
import Card from '../ui/Card';
import Input from '../ui/Input';
import SearchableSelect from '../ui/SearchableSelect';
import { supabase, assertRpcResult } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { validateBlendMath, type BlendMathWarning } from '../../lib/blendMathValidator';
import { localToday } from '../../lib/dateUtils';
import type { Customer, Product, BlendRecipe, BlendRecipeItem, UnitConversion } from '../../types';
import { Sentry } from '../../lib/sentry';
import { blockedUnitSaveMessage, type UnitLoadState } from '../../lib/units';
import { ProductOptionDetails, productOptionLabel, type ProductOptionPresentationModel } from '../products/ProductOptionPresentation';
import UnitSelect from './UnitSelect';

type PickerProduct = Product & ProductOptionPresentationModel;

interface ManualTicketCreateProps {
  customers: Customer[];
  onComplete: () => void;
}

interface ManualProduct {
  tempId: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit: string;
  rate_per_acre: number | null;
  rate_per_acre_unit: string;
  lot_number: string;
}

interface ManualTicketPayload {
  [key: string]: string | number | null;
  customer_id: string;
  ticket_date: string | null;
  ticket_time: string | null;
  job_number: string | null;
  invoice_number: string | null;
  driver_name: string | null;
  applicator_name: string | null;
  mixer_name: string | null;
  tank_number: string | null;
  vehicle_info: string | null;
  field_names: string | null;
  total_acres: number | null;
  application_rate: string | null;
  total_volume: number | null;
  total_volume_unit: string | null;
  notes: string | null;
}

interface ManualTicketProductPayload {
  [key: string]: string | number | null;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit: string | null;
  rate_per_acre: number | null;
  rate_per_acre_unit: string | null;
  lot_number: string | null;
  sequence_order: number;
}

interface PersistedUncertainManualTicket {
  version: 1;
  userId: string;
  ticketId: string;
  idempotencyKey: string;
  expiresAt: number;
  ticketPayload: ManualTicketPayload;
  products: ManualTicketProductPayload[];
}

const UNCERTAIN_MANUAL_TICKET_TTL_MS = 2 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uncertainManualTicketStorageKey = (userId: string) =>
  `crx:blend-ticket-manual:uncertain:v1:${userId}`;

const initialManualFormData = () => ({
  customer_id: '',
  ticket_date: localToday(),
  ticket_time: '',
  job_number: '',
  invoice_number: '',
  driver_name: '',
  applicator_name: '',
  mixer_name: '',
  tank_number: '',
  vehicle_info: '',
  field_names: '',
  total_acres: '',
  application_rate: '',
  total_volume: '',
  total_volume_unit: '',
  notes: '',
});

function isNullableBoundedString(value: unknown, maxLength: number): boolean {
  return value === null || (typeof value === 'string' && value.length <= maxLength);
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function readPersistedUncertainManualTicket(userId: string): PersistedUncertainManualTicket | null {
  const key = uncertainManualTicketStorageKey(userId);
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    if (raw.length > 128 * 1024) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    const value = JSON.parse(raw) as Partial<PersistedUncertainManualTicket>;
    const payload = value.ticketPayload as Partial<ManualTicketPayload> | undefined;
    const products = Array.isArray(value.products) ? value.products : [];
    const validPayload = payload
      && typeof payload.customer_id === 'string'
      && payload.customer_id.length > 0
      && payload.customer_id.length <= 64
      && isNullableBoundedString(payload.ticket_date, 32)
      && isNullableBoundedString(payload.ticket_time, 64)
      && isNullableBoundedString(payload.job_number, 128)
      && isNullableBoundedString(payload.invoice_number, 128)
      && isNullableBoundedString(payload.driver_name, 256)
      && isNullableBoundedString(payload.applicator_name, 256)
      && isNullableBoundedString(payload.mixer_name, 256)
      && isNullableBoundedString(payload.tank_number, 128)
      && isNullableBoundedString(payload.vehicle_info, 512)
      && isNullableBoundedString(payload.field_names, 2_000)
      && isNullableFiniteNumber(payload.total_acres)
      && isNullableBoundedString(payload.application_rate, 128)
      && isNullableFiniteNumber(payload.total_volume)
      && isNullableBoundedString(payload.total_volume_unit, 64)
      && isNullableBoundedString(payload.notes, 10_000);
    const validProducts = products.length <= 200 && products.every((product, index) => product
      && isNullableBoundedString(product.product_id, 64)
      && typeof product.product_name === 'string'
      && product.product_name.length <= 512
      && typeof product.quantity === 'number'
      && Number.isFinite(product.quantity)
      && isNullableBoundedString(product.unit, 64)
      && isNullableFiniteNumber(product.rate_per_acre)
      && isNullableBoundedString(product.rate_per_acre_unit, 64)
      && isNullableBoundedString(product.lot_number, 256)
      && product.sequence_order === index + 1);
    const valid = value.version === 1
      && value.userId === userId
      && typeof value.ticketId === 'string'
      && UUID_PATTERN.test(value.ticketId)
      && typeof value.idempotencyKey === 'string'
      && value.idempotencyKey.length > 0
      && value.idempotencyKey.length <= 256
      && typeof value.expiresAt === 'number'
      && value.expiresAt > Date.now()
      && validPayload
      && validProducts;
    if (!valid) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return value as PersistedUncertainManualTicket;
  } catch {
    try { window.sessionStorage.removeItem(key); } catch { /* best effort */ }
    return null;
  }
}

export function ManualTicketCreate({ customers, onComplete }: ManualTicketCreateProps) {
  const { profile } = useAuth();
  const { getKey: getCreateKey, resetKey: resetCreateKey } = useIdempotencyKey(
    'create_blend_ticket',
    profile?.id || '',
  );
  const persistedAttemptRef = useRef<PersistedUncertainManualTicket | null>(null);
  const loadedUserIdRef = useRef<string | null | undefined>(undefined);
  const [ticketAttemptId, setTicketAttemptId] = useState<string>(() => crypto.randomUUID());

  const [formData, setFormData] = useState(initialManualFormData);

  const [products, setProducts] = useState<ManualProduct[]>([]);
  const [allProducts, setAllProducts] = useState<PickerProduct[]>([]);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);
  const [unitLoad, setUnitLoad] = useState<UnitLoadState>('pending');
  const [recipes, setRecipes] = useState<(BlendRecipe & { items: BlendRecipeItem[] })[]>([]);
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [saving, setSaving] = useState(false);
  const [attemptUncertain, setAttemptUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<BlendMathWarning[]>([]);

  const clearPersistedAttempt = () => {
    persistedAttemptRef.current = null;
    if (!profile?.id) return;
    try {
      window.sessionStorage.removeItem(uncertainManualTicketStorageKey(profile.id));
    } catch {
      // Storage is a best-effort reload guard; the current mount is still safe.
    }
  };

  const persistAttempt = (attempt: PersistedUncertainManualTicket) => {
    persistedAttemptRef.current = attempt;
    try {
      window.sessionStorage.setItem(
        uncertainManualTicketStorageKey(attempt.userId),
        JSON.stringify(attempt),
      );
    } catch {
      // Privacy/quota settings must not interrupt creation. The exact attempt
      // remains frozen in memory for retry while this component stays mounted.
    }
  };

  useEffect(() => {
    const userId = profile?.id || null;
    const isFirstUserLoad = loadedUserIdRef.current === undefined;
    const userChanged = !isFirstUserLoad && loadedUserIdRef.current !== userId;
    loadedUserIdRef.current = userId;

    if (userChanged) {
      persistedAttemptRef.current = null;
      resetCreateKey();
      setTicketAttemptId(crypto.randomUUID());
      setFormData(initialManualFormData());
      setProducts([]);
      setSelectedRecipeId('');
      setAttemptUncertain(false);
      setError(null);
    }
    if (!userId) return;

    const persisted = readPersistedUncertainManualTicket(userId);
    if (!persisted) return;
    persistedAttemptRef.current = persisted;
    setTicketAttemptId(persisted.ticketId);
    setFormData({
      customer_id: persisted.ticketPayload.customer_id,
      ticket_date: persisted.ticketPayload.ticket_date || localToday(),
      ticket_time: persisted.ticketPayload.ticket_time || '',
      job_number: persisted.ticketPayload.job_number || '',
      invoice_number: persisted.ticketPayload.invoice_number || '',
      driver_name: persisted.ticketPayload.driver_name || '',
      applicator_name: persisted.ticketPayload.applicator_name || '',
      mixer_name: persisted.ticketPayload.mixer_name || '',
      tank_number: persisted.ticketPayload.tank_number || '',
      vehicle_info: persisted.ticketPayload.vehicle_info || '',
      field_names: persisted.ticketPayload.field_names || '',
      total_acres: persisted.ticketPayload.total_acres?.toString() || '',
      application_rate: persisted.ticketPayload.application_rate || '',
      total_volume: persisted.ticketPayload.total_volume?.toString() || '',
      total_volume_unit: persisted.ticketPayload.total_volume_unit || '',
      notes: persisted.ticketPayload.notes || '',
    });
    setProducts(persisted.products.map((product) => ({
      tempId: crypto.randomUUID(),
      product_id: product.product_id,
      product_name: product.product_name,
      quantity: product.quantity,
      unit: product.unit || '',
      rate_per_acre: product.rate_per_acre,
      rate_per_acre_unit: product.rate_per_acre_unit || '',
      lot_number: product.lot_number || '',
    })));
    setAttemptUncertain(true);
    setError('A previous manual ticket save may have completed. Retry this exact ticket before creating another.');
  }, [profile?.id, resetCreateKey]);

  useEffect(() => {
    supabase.from('unit_conversions').select('*').order('unit').then(({ data, error }) => {
      if (error) {
        // The unit fields are pickers, not free text, so an empty list leaves the
        // operator no way to enter a unit at all. Say so instead of failing quietly.
        Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_unit_conversions' } });
        setUnitLoad('failed');
        setError('Failed to load Units. Retry before creating this ticket.');
        return;
      }
      setUnitConversions((data || []) as UnitConversion[]);
      setUnitLoad('loaded');
    });
  }, []);

  useEffect(() => {
    const loadData = async () => {
      const { data: prodData, error: prodError } = await supabase
        .from('products')
        .select('*, product_family:product_families(name)')
        .eq('is_active', true)
        .order('product_name');
      if (prodError) {
        Sentry.captureException(new Error(String(prodError.message)), { extra: { context: 'Failed to load products' } });
        setError('Failed to load Products. Retry before creating this ticket.');
      } else {
        setAllProducts((prodData || []) as unknown as PickerProduct[]);
      }

      // Fetch active blend recipes with their items
      const { data: recipeData, error: recipeError } = await supabase
        .from('blend_recipes')
        .select('*, items:blend_recipe_items(*)')
        .eq('is_active', true)
        .is('deleted_at', null)
        .order('name');
      if (recipeError) Sentry.captureException(new Error(String(recipeError.message)), { extra: { context: 'Failed to load recipes' } });
      if (recipeData) setRecipes(recipeData as unknown as (BlendRecipe & { items: BlendRecipeItem[] })[]);
    };
    loadData();
  }, []);

  function applyRecipe(recipeId: string) {
    setSelectedRecipeId(recipeId);
    if (!recipeId) return;

    const recipe = recipes.find((r) => r.id === recipeId);
    if (!recipe || !recipe.items) return;

    const recipeProducts: ManualProduct[] = recipe.items
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => {
        const catalog = allProducts.find((candidate) => candidate.id === item.product_id);
        return {
          tempId: crypto.randomUUID(),
          product_id: item.product_id,
          product_name: item.product_name,
          quantity: item.quantity,
          unit: item.unit,
          rate_per_acre: item.rate_per_acre,
          rate_per_acre_unit: catalog?.rate_unit || '',
          lot_number: '',
        };
      });

    setProducts(recipeProducts);
  }

  useEffect(() => {
    const ticketData = {
      total_acres: formData.total_acres ? parseFloat(formData.total_acres) : null,
      total_volume: formData.total_volume ? parseFloat(formData.total_volume) : null,
      total_volume_unit: formData.total_volume_unit || null,
      application_rate: formData.application_rate || null,
    };
    const productData = products.map(p => {
      // The rate check guards a billing path: create_invoice_from_blend_ticket
      // prices each line from rate_per_acre and its unit, falling back to the
      // product's own rate_unit when the line leaves it blank. Hand the catalog
      // row's units over so the warning and the invoice agree about the line.
      const catalog = allProducts.find((candidate) => candidate.id === p.product_id);
      return {
        product_name: p.product_name,
        quantity: p.quantity,
        unit: p.unit || null,
        rate_per_acre: p.rate_per_acre,
        rate_per_acre_unit: p.rate_per_acre_unit || null,
        product_form: catalog?.product_form ?? null,
        product_rate_unit: catalog?.rate_unit ?? null,
        product_inventory_unit: catalog?.inventory_unit || catalog?.unit_size || null,
      };
    });
    setWarnings(validateBlendMath(ticketData, productData));
    // application_rate belongs in these deps: the tank check reads it, so leaving
    // it out would freeze the warning at whatever it was before the operator typed.
  }, [products, allProducts, formData.total_acres, formData.total_volume, formData.total_volume_unit, formData.application_rate]);

  function addProduct() {
    setProducts([
      ...products,
      {
        tempId: crypto.randomUUID(),
        product_id: null,
        product_name: '',
        quantity: 0,
        unit: '',
        rate_per_acre: null,
        rate_per_acre_unit: '',
        lot_number: '',
      },
    ]);
  }

  function updateProduct(tempId: string, field: keyof ManualProduct, value: string | number | null) {
    // Functional updater: the product-select onChange fires updateProduct twice back-to-back
    // (product_id then product_name). Reading `products` from the closure made the second call
    // overwrite the first (product_id was lost -> $0 pricing / FK crash on create-order). Using
    // the previous-state form composes both updates correctly.
    setProducts(prev => prev.map(p => (p.tempId === tempId ? { ...p, [field]: value } : p)));
  }

  function removeProduct(tempId: string) {
    setProducts(products.filter(p => p.tempId !== tempId));
  }

  async function handleSave() {
    if (!profile) return;
    setError(null);

    if (!formData.customer_id) {
      setError('Please select a customer before saving.');
      return;
    }

    // Only block when the missing list is actually costing the ticket a unit. A
    // blank rate unit bills off the product's own rate_unit, but it should be a
    // choice the operator made, not one a failed fetch made for them.
    const unitBlock = blockedUnitSaveMessage(
      unitLoad,
      unitConversions,
      products.some((p) => !p.unit || !p.rate_per_acre_unit),
    );
    if (unitBlock) {
      setError(unitBlock);
      return;
    }

    setSaving(true);

    try {
      const ticketPayload: ManualTicketPayload = {
        customer_id: formData.customer_id,
        ticket_date: formData.ticket_date || null,
        ticket_time: formData.ticket_time || null,
        job_number: formData.job_number || null,
        invoice_number: formData.invoice_number || null,
        driver_name: formData.driver_name || null,
        applicator_name: formData.applicator_name || null,
        mixer_name: formData.mixer_name || null,
        tank_number: formData.tank_number || null,
        vehicle_info: formData.vehicle_info || null,
        field_names: formData.field_names || null,
        total_acres: formData.total_acres ? parseFloat(formData.total_acres) : null,
        application_rate: formData.application_rate || null,
        total_volume: formData.total_volume ? parseFloat(formData.total_volume) : null,
        total_volume_unit: formData.total_volume_unit || null,
        notes: formData.notes || null,
      };
      const productPayload: ManualTicketProductPayload[] = products.map((product, index) => ({
        product_id: product.product_id,
        product_name: product.product_name,
        quantity: product.quantity,
        unit: product.unit || null,
        rate_per_acre: product.rate_per_acre,
        rate_per_acre_unit: product.rate_per_acre_unit || null,
        lot_number: product.lot_number || null,
        sequence_order: index + 1,
      }));
      const attempt = attemptUncertain && persistedAttemptRef.current
        ? {
            ...persistedAttemptRef.current,
            expiresAt: Date.now() + UNCERTAIN_MANUAL_TICKET_TTL_MS,
          }
        : {
            version: 1 as const,
            userId: profile.id,
            ticketId: ticketAttemptId,
            idempotencyKey: getCreateKey(),
            expiresAt: Date.now() + UNCERTAIN_MANUAL_TICKET_TTL_MS,
            ticketPayload,
            products: productPayload,
          };

      // Persist before the request so a reload while the RPC is in flight still
      // recovers the exact identity and payload instead of creating a duplicate.
      persistAttempt(attempt);
      const { data, error: createError } = await supabase.rpc('create_blend_ticket', {
        p_ticket_id: attempt.ticketId,
        p_ticket_payload: attempt.ticketPayload,
        p_products: attempt.products,
        p_images: [],
        p_enqueue_ocr: false,
        p_performed_by: profile.id,
        p_idempotency_key: attempt.idempotencyKey,
      });

      if (createError) {
        const lookup = await supabase
          .from('blend_tickets')
          .select('id')
          .eq('id', attempt.ticketId)
          .maybeSingle();
        if (lookup.error) {
          setAttemptUncertain(true);
          throw new Error(`Save outcome is uncertain. Retry this same ticket without editing: ${createError.message}`);
        }
        if (!lookup.data) {
          clearPersistedAttempt();
          resetCreateKey();
          setTicketAttemptId(crypto.randomUUID());
          setAttemptUncertain(false);
          throw createError;
        }
      } else {
        const result = assertRpcResult<{
          success: boolean;
          ticket_id: string;
          ticket_number: string;
        }>(data, 'create_blend_ticket');
        if (!result.success || result.ticket_id !== attempt.ticketId) {
          throw new Error('Blend ticket retry identity mismatch');
        }
      }

      clearPersistedAttempt();
      resetCreateKey();
      setTicketAttemptId(crypto.randomUUID());
      setAttemptUncertain(false);
      onComplete();
    } catch (err: unknown) {
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { extra: { context: 'Error creating manual ticket' } },
      );
      const message = err instanceof Error ? err.message : 'Failed to create ticket';
      if (persistedAttemptRef.current) {
        setAttemptUncertain(true);
        setError(message.toLowerCase().includes('outcome is uncertain')
          ? message
          : `Save outcome is uncertain. Retry this same ticket without editing: ${message}`);
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <fieldset disabled={saving || attemptUncertain} className="contents">
      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-4">Create Manual Blend Ticket</h2>

        {error && (
          <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Customer</label>
            <SearchableSelect
              options={customers.map((customer) => ({ value: customer.id, label: customer.farm_name }))}
              value={formData.customer_id}
              onChange={(value) => setFormData({ ...formData, customer_id: value })}
              placeholder="Select Customer"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ticket Date</label>
            <Input
              type="date"
              value={formData.ticket_date}
              onChange={(e) => setFormData({ ...formData, ticket_date: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ticket Time</label>
            <Input
              type="text"
              value={formData.ticket_time}
              onChange={(e) => setFormData({ ...formData, ticket_time: e.target.value })}
              placeholder="e.g. 2:30 PM"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Job #</label>
            <Input
              type="text"
              value={formData.job_number}
              onChange={(e) => setFormData({ ...formData, job_number: e.target.value })}
              placeholder="Job / work order number"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Invoice #</label>
            <Input
              type="text"
              value={formData.invoice_number}
              onChange={(e) => setFormData({ ...formData, invoice_number: e.target.value })}
              placeholder="Invoice reference"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Driver Name</label>
            <Input
              type="text"
              value={formData.driver_name}
              onChange={(e) => setFormData({ ...formData, driver_name: e.target.value })}
              placeholder="Enter driver name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Applicator Name</label>
            <Input
              type="text"
              value={formData.applicator_name}
              onChange={(e) => setFormData({ ...formData, applicator_name: e.target.value })}
              placeholder="Enter applicator name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Mixer Name</label>
            <Input
              type="text"
              value={formData.mixer_name}
              onChange={(e) => setFormData({ ...formData, mixer_name: e.target.value })}
              placeholder="Person who mixed the blend"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tank #</label>
            <Input
              type="text"
              value={formData.tank_number}
              onChange={(e) => setFormData({ ...formData, tank_number: e.target.value })}
              placeholder="Enter tank number"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle</label>
            <Input
              type="text"
              value={formData.vehicle_info}
              onChange={(e) => setFormData({ ...formData, vehicle_info: e.target.value })}
              placeholder="Vehicle / rig description"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Field Names / Locations</label>
            <Input
              type="text"
              value={formData.field_names}
              onChange={(e) => setFormData({ ...formData, field_names: e.target.value })}
              placeholder="Comma-separated field names"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Total Acres</label>
            <Input
              type="number"
              step="0.01"
              value={formData.total_acres}
              onChange={(e) => setFormData({ ...formData, total_acres: e.target.value })}
              placeholder="0"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Application Rate</label>
            <Input
              type="text"
              value={formData.application_rate}
              onChange={(e) => setFormData({ ...formData, application_rate: e.target.value })}
              placeholder="e.g. 10 gal/acre"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Total Volume</label>
            <div className="flex gap-2">
              <Input
                type="number"
                step="0.01"
                value={formData.total_volume}
                onChange={(e) => setFormData({ ...formData, total_volume: e.target.value })}
                placeholder="0"
              />
              <Input
                type="text"
                value={formData.total_volume_unit}
                onChange={(e) => setFormData({ ...formData, total_volume_unit: e.target.value })}
                placeholder="gal"
                className="w-24"
              />
            </div>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              placeholder="Add notes..."
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
      </Card>

      {/* Recipe Quick-Fill */}
      {recipes.length > 0 && (
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-3">
            <Beaker className="h-5 w-5 text-crx-green" />
            <h2 className="text-lg font-semibold">Apply Saved Recipe</h2>
          </div>
          <p className="text-sm text-gray-500 mb-3">
            Select a saved blend recipe to pre-fill the products list below.
          </p>
          <select
            value={selectedRecipeId}
            onChange={(e) => applyRecipe(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">-- Choose a recipe --</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.crop_type ? ` (${r.crop_type})` : ''}
                {r.timing ? ` - ${r.timing}` : ''}
                {` — ${r.items?.length || 0} products`}
              </option>
            ))}
          </select>
        </Card>
      )}

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Products</h2>
          <Button size="sm" onClick={addProduct}>
            <Plus className="h-4 w-4" />
            Add Product
          </Button>
        </div>

        <div className="space-y-4">
          {products.map((product) => {
            const catalog = allProducts.find((candidate) => candidate.id === product.product_id);
            const productForm = catalog?.product_form ?? null;
            return (
            <div key={product.tempId} className="grid grid-cols-12 gap-3 items-start p-4 bg-gray-50 rounded-lg">
              <div className="col-span-12 md:col-span-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">Product</label>
                <SearchableSelect
                  options={allProducts.map((p) => ({ value: p.id, label: productOptionLabel(p) }))}
                  value={product.product_id || ''}
                  onChange={(value) => {
                    updateProduct(product.tempId, 'product_id', value || null);
                    const selected = allProducts.find(p => p.id === value);
                    if (selected) {
                      updateProduct(product.tempId, 'product_name', selected.product_name);
                    }
                  }}
                  placeholder="Select Product"
                />
                {allProducts.find((candidate) => candidate.id === product.product_id) && (
                  <ProductOptionDetails product={allProducts.find((candidate) => candidate.id === product.product_id)!} />
                )}
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">Qty</label>
                <Input
                  type="number"
                  step="0.01"
                  value={product.quantity || ''}
                  onChange={(e) => updateProduct(product.tempId, 'quantity', parseFloat(e.target.value) || 0)}
                />
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">Unit</label>
                <UnitSelect
                  unitConversions={unitConversions}
                  form={productForm}
                  value={product.unit}
                  onChange={(value) => updateProduct(product.tempId, 'unit', value)}
                  disabled={saving || attemptUncertain}
                  ariaLabel={`Quantity unit for ${product.product_name || 'product'}`}
                />
              </div>

              <div className="col-span-4 md:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">Rate/Acre</label>
                <Input
                  type="number"
                  step="0.01"
                  value={product.rate_per_acre ?? ''}
                  onChange={(e) => updateProduct(product.tempId, 'rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)}
                />
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">Rate unit (per acre)</label>
                <UnitSelect
                  unitConversions={unitConversions}
                  form={productForm}
                  value={product.rate_per_acre_unit}
                  onChange={(value) => updateProduct(product.tempId, 'rate_per_acre_unit', value)}
                  disabled={saving || attemptUncertain}
                  ariaLabel={`Rate unit per acre for ${product.product_name || 'product'}`}
                />
              </div>

              <div className="col-span-6 md:col-span-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">Lot Number</label>
                <Input
                  type="text"
                  value={product.lot_number}
                  onChange={(e) => updateProduct(product.tempId, 'lot_number', e.target.value)}
                  placeholder="Lot #"
                />
              </div>

              <div className="col-span-2 md:col-span-1 flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeProduct(product.tempId)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            );
          })}

          {products.length === 0 && (
            <p className="text-center text-gray-500 py-8">
              No products added yet. Click "Add Product" to get started.
            </p>
          )}
        </div>
      </Card>

      </fieldset>

      {/* Two tiers, deliberately. A "couldn't check this" note is the COMMON case
          on a real ticket, and rendering it in the same alarmed amber as a genuine
          mismatch is how a banner gets trained into wallpaper. Only a comparison
          that actually ran and disagreed gets the warning styling. */}
      {warnings.some((w) => w.level === 'mismatch') && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 space-y-1">
          <div className="flex items-center gap-2 text-yellow-800 font-medium text-sm">
            <AlertCircle className="h-4 w-4" />
            Math Validation Warnings
          </div>
          {warnings.filter((w) => w.level === 'mismatch').map((w, i) => (
            <p key={i} className="text-sm text-yellow-700 ml-6">- {w.message}</p>
          ))}
        </div>
      )}

      {warnings.some((w) => w.level === 'unchecked') && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-1">
          <div className="text-gray-600 font-medium text-sm">Not automatically checked</div>
          {warnings.filter((w) => w.level === 'unchecked').map((w, i) => (
            <p key={i} className="text-sm text-gray-500 ml-2">- {w.message}</p>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onComplete}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : attemptUncertain ? 'Retry Same Ticket' : 'Create Ticket'}
        </Button>
      </div>
    </div>
  );
}
