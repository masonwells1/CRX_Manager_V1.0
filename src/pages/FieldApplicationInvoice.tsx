import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Save, Send, Trash2, MapPin, FlaskConical, Users, ClipboardList, ArrowLeft, Eye, AlertTriangle,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, assertRpcResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { logActivity } from '../lib/activityLogger';
import { Sentry } from '../lib/sentry';
import { formatCents as fmt } from '../lib/money';
import { billableAcres, acreDivergence } from '../lib/fieldGeometry';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import ConfirmModal from '../components/ui/ConfirmModal';
import SelectLocationsModal from '../components/field-app/SelectLocationsModal';
import FieldAppChemicalEntry, { type ChemicalLine } from '../components/field-app/FieldAppChemicalEntry';
import CustomerSharesTable from '../components/field-app/CustomerSharesTable';
import ApplicationServicePicker from '../components/field-app/ApplicationServicePicker';
import type {
  Field,
  CustomerShareResult,
  InvoiceStatus,
  DeriveCustomerSharesResult,
  FieldAppInvoiceResult,
  PreviewFieldAppSplitResult,
} from '../types';

interface SiblingInvoice {
  id: string;
  invoice_number: string;
  customer_id: string;
  customer_name: string;
  total_amount_cents: number;
  status: InvoiceStatus;
}

interface FieldLocation {
  field_id: string;
  field_name: string;
  map_number: number | null;
  total_acres: number | null;
  /** Billable acreage on file for this field: override ?? measured ?? legacy total.
   *  The reference the applied-acres divergence flag compares against. */
  system_acres: number | null;
  planted_acres: number | null;
  applied_acres: number | null;
  crop_type: string | null;
  wind_direction: string | null;
  sort_order: number;
  customer_name?: string;
}

type TabKey = 'locations' | 'chemicals' | 'customers' | 'applied_info';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'locations', label: 'Locations', icon: <MapPin className="w-4 h-4" /> },
  { key: 'chemicals', label: 'Chemicals/Charges', icon: <FlaskConical className="w-4 h-4" /> },
  { key: 'customers', label: 'Customers', icon: <Users className="w-4 h-4" /> },
  { key: 'applied_info', label: 'Applied Info', icon: <ClipboardList className="w-4 h-4" /> },
];

export default function FieldApplicationInvoice() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const saveIdem = useIdempotencyKey('save_field_app_invoice', profile?.id || '');
  const postIdem = useIdempotencyKey('post_invoice_group', profile?.id || '');
  const deleteIdem = useIdempotencyKey('delete_invoices', profile?.id || '');

  const [activeTab, setActiveTab] = useState<TabKey>('locations');
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showLocationsModal, setShowLocationsModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [transactionDate, setTransactionDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<InvoiceStatus>('draft');

  const [locations, setLocations] = useState<FieldLocation[]>([]);
  const [chemicals, setChemicals] = useState<ChemicalLine[]>([]);
  const [shares, setShares] = useState<CustomerShareResult[]>([]);

  const [windDirection, setWindDirection] = useState('');
  const [temperature, setTemperature] = useState('');
  const [applicator, setApplicator] = useState('');

  // Phase 1 (2026-04-29) state
  const [appServiceId, setAppServiceId] = useState<string | null>(null);
  const [invoiceGroupId, setInvoiceGroupId] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<SiblingInvoice[]>([]);
  const [primaryCustomerTier, setPrimaryCustomerTier] = useState<number>(1);
  const [previewData, setPreviewData] = useState<PreviewFieldAppSplitResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useUnsavedChanges(dirty);

  const isNew = !id;

  const totalAppliedAcres = useMemo(
    () => locations.reduce((sum, l) => sum + (l.applied_acres || 0), 0),
    [locations]
  );

  // Applicator-mix-up review flag: locations whose applied acres are 10%+ off (over OR under)
  // the field's billable acreage on file. Advisory only — never blocks billing.
  const divergentCount = useMemo(
    () => locations.filter((l) => acreDivergence(l.applied_acres, l.system_acres) !== null).length,
    [locations]
  );

  const invoiceTotalCents = useMemo(
    () => chemicals.reduce((sum, c) => sum + c.extended_cents, 0),
    [chemicals]
  );

  const fetchInvoice = useCallback(async () => {
    if (!id) return;
    // #3 segregation: validate the invoice belongs in THIS (per-acre, field-app)
    // editor BEFORE pulling the full row, so a denied / wrong-editor URL doesn't
    // expose invoice data — only the type + job_id/blend_ticket_id discriminators are
    // read first (Codex P1). Then redirect: a non-field invoice -> field list; a
    // JOB-built (job_id) OR BLEND-TICKET-built (blend_ticket_id) field invoice has
    // quantity lines + no field_app_locations -> the generic editor. Only an
    // ENGINE-built field invoice (NEITHER set) belongs here. (Codex r13)
    const { data: chk, error: chkErr } = await supabase
      .from('invoices')
      .select('invoice_type, job_id, blend_ticket_id')
      .eq('id', id)
      .maybeSingle();
    if (chkErr || !chk) {
      toast('error', 'Failed to load invoice');
      navigate('/field-invoices');
      return;
    }
    if ((chk as { invoice_type?: string }).invoice_type !== 'field_application') {
      toast('error', 'Not a field invoice');
      navigate('/field-invoices');
      return;
    }
    if ((chk as { job_id?: string | null }).job_id
        || (chk as { blend_ticket_id?: string | null }).blend_ticket_id) {
      navigate(`/field-invoices/${id}`, { replace: true });
      return;
    }

    const { data: inv, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !inv) {
      toast('error', 'Failed to load invoice');
      navigate('/field-invoices');
      return;
    }

    const invoice = inv as Record<string, unknown>;
    setInvoiceNumber((invoice.invoice_number as string) || '');
    setTransactionDate((invoice.invoice_date as string) || '');
    setNotes((invoice.header_notes as string) || '');
    setStatus((invoice.status as InvoiceStatus) || 'draft');
    setAppServiceId((invoice.application_service_id as string | null) || null);
    // Wave B.1 / P2-1: load Applied Info from the invoice row. These are
    // free-form text columns added so the values persist round-trip.
    // temperature_text was renamed from "temperature" in B audit B-3 to
    // disambiguate from sibling numeric temperature columns elsewhere.
    setWindDirection((invoice.wind_direction as string | null) || '');
    setTemperature((invoice.temperature_text as string | null) || '');
    setApplicator((invoice.applicator_name as string | null) || '');

    const groupId = (invoice.invoice_group_id as string | null) || null;
    setInvoiceGroupId(groupId);

    // If grouped, load sibling invoices for the banner
    if (groupId) {
      const { data: sibs } = await supabase
        .from('invoices')
        .select('id, invoice_number, customer_id, total_amount_cents, status, customer:customers!invoices_customer_id_fkey(farm_name)')
        .eq('invoice_group_id', groupId)
        .is('deleted_at', null) // [B1.2] don't surface a soft-deleted split member in the banner
        .order('invoice_number');
      if (sibs) {
        setSiblings(
          (sibs as Array<Record<string, unknown>>).map((s) => ({
            id: s.id as string,
            invoice_number: (s.invoice_number as string) || '',
            customer_id: s.customer_id as string,
            customer_name: ((s.customer as { farm_name?: string } | null)?.farm_name) || '',
            total_amount_cents: (s.total_amount_cents as number) || 0,
            status: (s.status as InvoiceStatus) || 'draft',
          }))
        );
      }
    } else {
      setSiblings([]);
    }

    // Locations: when grouped, locations are keyed by invoice_group_id;
    // otherwise by invoice_id.
    const locQuery = supabase
      .from('field_app_locations')
      .select('*, field:fields!field_app_locations_field_id_fkey(field_name, crop_type, total_acres, measured_acres, override_acres, customer:customers!fields_customer_id_fkey(farm_name))')
      .order('sort_order');
    const { data: locs } = groupId
      ? await locQuery.eq('invoice_group_id', groupId)
      : await locQuery.eq('invoice_id', id);

    if (locs) {
      setLocations(
        (locs as Array<Record<string, unknown>>).map((l) => {
          const field = l.field as { field_name: string; crop_type: string | null; total_acres: number | null; measured_acres: number | null; override_acres: number | null; customer: { farm_name: string } | null } | null;
          return {
            field_id: l.field_id as string,
            field_name: field?.field_name || 'Unknown',
            map_number: l.map_number as number | null,
            total_acres: (l.total_acres as number | null) ?? field?.total_acres ?? null,
            system_acres: billableAcres(field?.override_acres, field?.measured_acres, field?.total_acres),
            planted_acres: l.planted_acres as number | null,
            applied_acres: l.applied_acres as number | null,
            crop_type: (l.crop_type as string | null) ?? field?.crop_type ?? null,
            wind_direction: l.wind_direction as string | null,
            sort_order: l.sort_order as number,
            customer_name: field?.customer?.farm_name,
          };
        })
      );
    }

    const { data: items } = await supabase
      .from('invoice_items')
      .select('*')
      .eq('invoice_id', id)
      .order('sort_order');

    if (items) {
      setChemicals(
        (items as Array<Record<string, unknown>>).map((it, idx) => ({
          id: (it.id as string) || `chem_${idx}`,
          product_id: it.product_id as string | null,
          product_name: (it.description as string) || '',
          rate_per_acre: it.rate_per_acre as number | null,
          rate_unit: (it.rate_unit as string) || 'oz',
          quantity: (it.quantity as number) || 0,
          unit: (it.unit_size as string) || 'oz',
          unit_price_cents: (it.unit_price_cents as number) || 0,
          price_unit: (it.unit_size as string) || 'oz',
          extended_cents: (it.extended_cents as number) || 0,
          unit_cost_cents: (it.cost_cents as number) || 0,
          sort_order: (it.sort_order as number) || idx,
        }))
      );
    }

    const { data: shareData } = await supabase
      .from('invoice_shares')
      .select('customer_id, customer_name, split_percentage, acres, amount_cents, is_primary')
      .eq('invoice_id', id)
      .order('sort_order');

    if (shareData) {
      setShares(
        (shareData as Array<Record<string, unknown>>).map((s) => ({
          customer_id: s.customer_id as string,
          customer_name: (s.customer_name as string) || '',
          is_primary: (s.is_primary as boolean) || false,
          total_acres: (s.acres as number) || 0,
          split_pct: (s.split_percentage as number) || 0,
        }))
      );
    }
  }, [id, toast, navigate]);

  useEffect(() => {
    fetchInvoice();
  }, [fetchInvoice]);

  const deriveShares = useCallback(async (fieldIds: string[], appliedAcresMap: Record<string, number>) => {
    if (fieldIds.length === 0) {
      setShares([]);
      setPrimaryCustomerTier(1);
      return;
    }
    try {
      const { data, error } = await supabase.rpc('derive_customer_shares_from_fields', {
        p_field_ids: fieldIds,
        p_applied_acres_map: appliedAcresMap,
      });
      if (error) throw error;
      // Phase 1: new shape returns { rows, customers, ... }. Map customers to legacy
      // CustomerShareResult for the table; use primary's tier for chemical preview.
      const result = assertRpcResult<DeriveCustomerSharesResult>(data, 'derive_customer_shares_from_fields');
      const legacyShares: CustomerShareResult[] = (result.customers || []).map((c) => ({
        customer_id: c.customer_id,
        customer_name: c.customer_name,
        is_primary: c.is_primary,
        total_acres: c.total_share_acres,
        split_pct: c.overall_split_pct,
      }));
      setShares(legacyShares);
      const primary = (result.customers || []).find((c) => c.is_primary) || result.customers?.[0];
      setPrimaryCustomerTier(primary?.tier ?? 1);
      // Reset preview whenever shares change — it's stale until user re-clicks Preview
      setPreviewData(null);
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: 'derive_customer_shares_from_fields' } });
      toast('error', 'Failed to derive customer shares');
    }
  }, [toast]);

  const handleLocationsSelected = useCallback((selectedFields: (Field & { customer_name?: string })[]) => {
    const newLocations: FieldLocation[] = selectedFields.map((f, idx) => {
      // Default applied acres to the field's BILLABLE acreage (override ?? measured ?? legacy
      // total) — the corrected per-acre number, not the raw full-field total. Editable per row.
      const billable = billableAcres(f.override_acres, f.measured_acres, f.total_acres);
      return {
        field_id: f.id,
        field_name: f.field_name,
        map_number: idx + 1,
        total_acres: f.total_acres,
        system_acres: billable,
        planted_acres: null,
        applied_acres: billable,
        crop_type: f.crop_type,
        wind_direction: null,
        sort_order: idx,
        customer_name: f.customer_name,
      };
    });
    setLocations(newLocations);
    setDirty(true);

    const fieldIds = newLocations.map((l) => l.field_id);
    const acresMap: Record<string, number> = {};
    newLocations.forEach((l) => {
      acresMap[l.field_id] = l.applied_acres || 0;
    });
    deriveShares(fieldIds, acresMap);
  }, [deriveShares]);

  const updateLocationAcres = (fieldId: string, acres: number) => {
    setLocations((prev) =>
      prev.map((l) => (l.field_id === fieldId ? { ...l, applied_acres: acres } : l))
    );
    setDirty(true);

    const acresMap: Record<string, number> = {};
    locations.forEach((l) => {
      acresMap[l.field_id] = l.field_id === fieldId ? acres : (l.applied_acres || 0);
    });
    deriveShares(locations.map((l) => l.field_id), acresMap);
  };

  const handleChemicalsChange = (updated: ChemicalLine[]) => {
    setChemicals(updated);
    setDirty(true);
    setPreviewData(null);
  };

  const handlePreview = async () => {
    if (locations.length === 0) {
      toast('error', 'Select at least one location first');
      return;
    }
    setPreviewing(true);
    try {
      const { data, error } = await supabase.rpc('preview_field_app_invoice_split', {
        p_locations: locations.map((l, idx) => ({
          field_id: l.field_id,
          map_number: l.map_number || idx + 1,
          total_acres: l.total_acres,
          planted_acres: l.planted_acres,
          applied_acres: l.applied_acres,
          crop_type: l.crop_type,
          wind_direction: l.wind_direction || windDirection || null,
          sort_order: idx,
        })),
        p_chemicals: chemicals.map((c, idx) => ({
          product_id: c.product_id,
          description: c.product_name,
          quantity: c.quantity,
          unit_size: c.unit,
          unit_price_cents: c.unit_price_cents,
          cost_cents: c.unit_cost_cents,
          sort_order: idx,
          rate_per_acre: c.rate_per_acre,
          rate_unit: c.rate_unit,
          manual_override: c.manual_override === true,
        })),
        p_application_service_id: (appServiceId || null) as string,
      });
      if (error) throw error;
      const result = assertRpcResult<PreviewFieldAppSplitResult>(data, 'preview_field_app_invoice_split');
      setPreviewData(result);
      setActiveTab('customers');
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: 'preview_field_app_invoice_split' } });
      toast('error', `Preview failed: ${sanitizeError(err)}`);
    } finally {
      setPreviewing(false);
    }
  };

  const handleSave = async () => {
    if (!profile) return;
    // [B1.1] Never bill 0 / blank applied acres. The server rejects it
    // (ZERO_APPLIED_ACRES); block here too with a clear message so the user fixes
    // it before the round-trip rather than seeing a raw RPC error. (The empty-
    // locations case is handled server-side + by handlePreview's guard.)
    const missingAcres = locations.find((l) => l.applied_acres == null || l.applied_acres <= 0);
    if (missingAcres) {
      toast('error', `Enter applied acres for "${missingAcres.field_name}" (greater than 0), or remove the field.`);
      return;
    }
    setSaving(true);
    try {
      const key = saveIdem.getKey();
      const { data, error } = await supabase.rpc('save_field_app_invoice', {
        // save_field_app_invoice accepts NULL p_invoice_id to create a new
        // invoice (live signature is nullable; generated type narrows to string).
        p_invoice_id: (id || null) as string,
        p_invoice: {
          invoice_number: invoiceNumber || null,
          invoice_date: transactionDate,
          salesman_id: profile.id,
          header_notes: notes || null,
        },
        p_locations: locations.map((l, idx) => ({
          field_id: l.field_id,
          map_number: l.map_number || idx + 1,
          total_acres: l.total_acres,
          planted_acres: l.planted_acres,
          applied_acres: l.applied_acres,
          crop_type: l.crop_type,
          wind_direction: l.wind_direction || windDirection || null,
          sort_order: idx,
        })),
        // Phase 1: Drop client-computed extended_cents — server is source of truth.
        // Pass manual_override flag so server records price_source correctly.
        p_chemicals: chemicals.map((c, idx) => ({
          product_id: c.product_id,
          description: c.product_name,
          quantity: c.quantity,
          unit_size: c.unit,
          unit_price_cents: c.unit_price_cents,
          cost_cents: c.unit_cost_cents,
          sort_order: idx,
          rate_per_acre: c.rate_per_acre,
          rate_unit: c.rate_unit,
          manual_override: c.manual_override === true,
        })),
        p_performed_by: profile.id,
        p_application_service_id: (appServiceId || null) as string,
        p_idempotency_key: key,
      });

      if (error) throw error;
      const result = assertRpcResult<FieldAppInvoiceResult>(data, 'save_field_app_invoice');
      saveIdem.resetKey();
      const ids = result.invoice_ids || [];
      const groupNote = result.invoice_group_id ? ` (group of ${ids.length})` : '';

      // Wave B.1 / P2-1 (audit B-4 + B-5 + B-8): persist Applied Info on
      // every invoice in the group. Always runs when there is at least one
      // invoice id — including when ALL three fields are blank, so the user
      // can intentionally clear stale Applied Info. Failure here is treated
      // as data loss: setDirty(false) is held until success, the Sentry
      // level is "error" not "warning", and a single combined toast tells
      // the user the financial save succeeded but Applied Info did not.
      let appliedInfoOk = true;
      if (ids.length > 0) {
        // Persist via the SECURITY DEFINER RPC (migration 20260622030000), NOT a raw
        // invoices UPDATE: the invoices_update RLS policy is admin-only, so a raw update
        // silently matched 0 rows for a sales_rep and surfaced a false "Save failed" +
        // a duplicate invoice on retry. The RPC re-gates on admin/sales_rep, binds the
        // actor, and restricts the write to editable field-application invoices.
        const appliedResult = await supabase.rpc('update_field_app_applied_info', {
          p_invoice_ids: ids,
          // Omit (undefined) when blank → the RPC's NULL default clears the column,
          // preserving the "blank fields intentionally clear stale Applied Info" behavior.
          p_wind_direction: windDirection || undefined,
          p_temperature_text: temperature || undefined,
          p_applicator_name: applicator || undefined,
          p_performed_by: profile.id,
        });
        if (appliedResult.error) {
          appliedInfoOk = false;
          Sentry.captureException(appliedResult.error, {
            level: 'error',
            extra: { context: 'field_app_applied_info_persist', invoice_ids: ids },
          });
        } else {
          assertRpcResult(appliedResult.data, 'update_field_app_applied_info');
        }
      }

      // Only consider the form clean when BOTH writes succeeded. If Applied
      // Info failed, leave dirty=true so the leave-page warning still fires
      // and the user can retry without re-entering the rest of the form.
      if (appliedInfoOk) {
        setDirty(false);
      }

      if (appliedInfoOk) {
        toast('success', isNew ? `Invoice created${groupNote}` : `Invoice saved${groupNote}`);
      } else {
        toast('error',
          (isNew ? 'Invoice created' : 'Invoice saved') + groupNote +
          ', but Applied Info (wind/temp/applicator) did NOT persist. Re-enter and save again.'
        );
      }

      if (isNew && ids[0]) {
        navigate(`/invoices/field-app/${ids[0]}`, { replace: true });
      } else {
        fetchInvoice();
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: 'save_field_app_invoice' } });
      toast('error', `Save failed: ${sanitizeError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePost = async () => {
    if (!profile || !id) return;
    setPosting(true);
    try {
      const key = postIdem.getKey();
      // Group-aware: route through post_invoice_group when a group exists, otherwise post_invoice.
      if (invoiceGroupId) {
        const { data, error } = await supabase.rpc('post_invoice_group', {
          p_invoice_group_id: invoiceGroupId,
          p_performed_by: profile.id,
          p_idempotency_key: key,
        });
        if (error) throw error;
        assertRpcResult(data, 'post_invoice_group');
      } else {
        // post_invoice RETURNS void — use .throwOnError() (no `=` capture).
        await supabase.rpc('post_invoice', {
          p_invoice_id: id,
          p_idempotency_key: key,
        }).throwOnError();
      }
      postIdem.resetKey();
      toast('success', invoiceGroupId ? 'Invoice group posted' : 'Invoice posted');
      fetchInvoice();
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: invoiceGroupId ? 'post_invoice_group' : 'post_invoice' } });
      toast('error', `Post failed: ${sanitizeError(err)}`);
    } finally {
      setPosting(false);
    }
  };

  // Phase 1: edit lock covers the whole group — any sibling not in draft/unposted blocks edits.
  const canEdit = isNew || (
    ['draft', 'unposted'].includes(status) &&
    (siblings.length === 0 || siblings.every((s) => ['draft', 'unposted'].includes(s.status)))
  );
  const canPost = !isNew && canEdit;

  const handleDelete = async () => {
    if (!id || !profile) return;
    if (!canEdit) {
      toast('error', 'Cannot delete a posted/voided invoice');
      return;
    }
    try {
      // Route through the guarded RPC (admin-only, audited, idempotent) instead
      // of a raw .update({ deleted_at }). See migration delete_invoices.
      const deleteKey = deleteIdem.getKey();
      const { data, error } = await supabase.rpc('delete_invoices', {
        p_invoice_ids: [id],
        p_performed_by: profile.id,
        p_idempotency_key: deleteKey,
      });
      if (error) throw error;
      deleteIdem.resetKey();
      const deleted = assertRpcResult<number>(data, 'delete_invoices');
      if (deleted < 1) {
        throw new Error('Invoice could not be deleted — it may be posted/paid or already removed.');
      }

      await logActivity({
        event: 'field_app_invoice_deleted',
        description: `Deleted field application invoice ${invoiceNumber}`,
        performedBy: profile.id,
        entityType: 'invoice',
        entityId: id,
      });

      toast('success', 'Invoice deleted');
      navigate('/field-invoices');
    } catch (err) {
      Sentry.captureException(err, { tags: { action: 'delete_field_app_invoice' } });
      toast('error', `Delete failed: ${sanitizeError(err)}`);
    }
  };

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { label: 'Invoices', href: '/invoices' },
          { label: isNew ? 'New Field Application' : `Invoice ${invoiceNumber || id?.slice(0, 8)}` },
        ]}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/field-invoices')} className="p-1 rounded hover:bg-gray-100">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold">
              {isNew ? 'New Field Application Invoice' : `Field Application ${invoiceNumber}`}
            </h1>
            <p className="text-sm text-gray-500">
              {totalAppliedAcres.toFixed(1)} acres &middot; {locations.length} locations &middot; {fmt(invoiceTotalCents)}
            </p>
          </div>
          {!isNew && <Badge variant={status === 'draft' ? 'default' : status === 'posted' ? 'success' : 'warning'}>{status}</Badge>}
        </div>
        <div className="flex gap-2">
          {!isNew && canEdit && (
            <Button variant="danger" size="sm" icon={<Trash2 className="w-4 h-4" />} onClick={() => setShowDeleteConfirm(true)}>
              Delete
            </Button>
          )}
          {!isNew && canPost && (
            <Button variant="secondary" size="sm" icon={<Send className="w-4 h-4" />} onClick={handlePost} loading={posting} disabled={posting}>
              {invoiceGroupId ? `Post Group (${siblings.length || 1})` : 'Post'}
            </Button>
          )}
          {locations.length > 0 && (
            <Button variant="secondary" size="sm" icon={<Eye className="w-4 h-4" />} onClick={handlePreview} loading={previewing} disabled={previewing || !canEdit}>
              Preview
            </Button>
          )}
          {canEdit && (
            <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving} disabled={saving}>
              Save
            </Button>
          )}
        </div>
      </div>

      {/* Phase 1: sibling banner for grouped split invoices */}
      {invoiceGroupId && siblings.length > 1 && (
        <Card>
          <div className="px-4 py-3 bg-blue-50 border-l-4 border-blue-400 rounded">
            <div className="text-sm font-medium text-blue-900 mb-1">
              This invoice is part of a {siblings.length}-customer split.
            </div>
            <div className="text-xs text-blue-700 flex flex-wrap gap-x-4 gap-y-1">
              {siblings.map((s) => (
                <Link
                  key={s.id}
                  to={`/invoices/field-app/${s.id}`}
                  className={`underline hover:no-underline ${s.id === id ? 'font-semibold text-blue-900' : ''}`}
                >
                  {s.invoice_number} &middot; {s.customer_name} &middot; {fmt(s.total_amount_cents)}
                  {s.id === id && ' (this)'}
                </Link>
              ))}
            </div>
          </div>
        </Card>
      )}

      <Card>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 p-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Invoice #</label>
            <input
              type="text"
              value={invoiceNumber}
              onChange={(e) => { setInvoiceNumber(e.target.value); setDirty(true); }}
              placeholder="Auto-generated"
              disabled={!canEdit}
              className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Transaction Date</label>
            <input
              type="date"
              value={transactionDate}
              onChange={(e) => { setTransactionDate(e.target.value); setDirty(true); }}
              disabled={!canEdit}
              className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Application Service</label>
            <ApplicationServicePicker
              value={appServiceId}
              onChange={(v) => { setAppServiceId(v); setDirty(true); setPreviewData(null); }}
              disabled={!canEdit}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
              placeholder="Optional notes"
              disabled={!canEdit}
              className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
            />
          </div>
        </div>
      </Card>

      <div className="border-b">
        <nav className="flex gap-1 px-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-crx-green text-crx-green'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.key === 'locations' && locations.length > 0 && (
                <span className="ml-1 text-xs bg-gray-100 rounded-full px-1.5">{locations.length}</span>
              )}
              {tab.key === 'chemicals' && chemicals.length > 0 && (
                <span className="ml-1 text-xs bg-gray-100 rounded-full px-1.5">{chemicals.length}</span>
              )}
              {tab.key === 'customers' && shares.length > 0 && (
                <span className="ml-1 text-xs bg-gray-100 rounded-full px-1.5">{shares.length}</span>
              )}
            </button>
          ))}
        </nav>
      </div>

      <Card>
        {activeTab === 'locations' && (
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Application Locations</h3>
              <Button
                size="sm"
                icon={<MapPin className="w-4 h-4" />}
                onClick={() => setShowLocationsModal(true)}
              >
                {locations.length > 0 ? 'Change Locations' : 'Select Locations'}
              </Button>
            </div>

            {divergentCount > 0 && (
              <div className="mb-3 flex items-start gap-2 px-3 py-2 bg-amber-50 border-l-4 border-amber-400 text-sm text-amber-800 rounded">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  <strong>{divergentCount} field{divergentCount > 1 ? 's' : ''}</strong>{' '}
                  {divergentCount > 1 ? 'have' : 'has'} applied acres 10%+ off the acreage on file
                  (over or under). Review before billing &mdash; an applicator may have sprayed part of one
                  field under another field&apos;s name.
                </span>
              </div>
            )}

            {locations.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b">
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Map #</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Field Name</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Crop</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Customer</th>
                    <th
                      className="px-3 py-2 text-right text-xs font-medium text-gray-500"
                      title="Billable acreage on file for this field (your typed override, else the measured map acres, else the legacy acreage)."
                    >
                      System Acres
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Applied Acres</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {locations.map((loc) => {
                    const div = acreDivergence(loc.applied_acres, loc.system_acres);
                    return (
                      <tr key={loc.field_id} className="hover:bg-gray-50">
                        <td className="px-3 py-2 tabular-nums">{loc.map_number}</td>
                        <td className="px-3 py-2 font-medium">{loc.field_name}</td>
                        <td className="px-3 py-2 text-gray-600">{loc.crop_type || '\u2014'}</td>
                        <td className="px-3 py-2 text-gray-600">{loc.customer_name || '\u2014'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{loc.system_acres?.toFixed(1) ?? '\u2014'}</td>
                        <td className="px-3 py-2">
                          <input
                            type="number"
                            step="0.1"
                            value={loc.applied_acres ?? ''}
                            onChange={(e) => updateLocationAcres(loc.field_id, Number(e.target.value))}
                            className={`w-24 ml-auto px-2 py-1 border rounded text-right text-sm tabular-nums ${div ? 'border-amber-400 bg-amber-50' : ''}`}
                          />
                          {div && (
                            <div className="mt-1 flex items-center justify-end gap-1 text-xs font-medium text-amber-700">
                              <AlertTriangle className="w-3 h-3" />
                              {Math.round(div.pct)}% {div.direction} &mdash; review
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 font-semibold border-t">
                    <td colSpan={4} className="px-3 py-2">Totals</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {locations.reduce((s, l) => s + (l.system_acres || 0), 0).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {totalAppliedAcres.toFixed(1)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <div className="text-center py-12 text-gray-400">
                <MapPin className="w-8 h-8 mx-auto mb-2" />
                <p>No locations selected</p>
                <p className="text-sm">Click Select Locations to choose fields for this application</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'chemicals' && (
          <div className="p-4">
            <FieldAppChemicalEntry
              chemicals={chemicals}
              onChemicalsChange={handleChemicalsChange}
              totalAppliedAcres={totalAppliedAcres}
              primaryCustomerTier={primaryCustomerTier}
            />
          </div>
        )}

        {activeTab === 'customers' && (
          <div className="p-4">
            {!previewData && shares.length > 0 && (
              <div className="mb-4 px-3 py-2 bg-amber-50 border-l-4 border-amber-300 text-xs text-amber-800 rounded">
                Click <strong>Preview</strong> to see exact per-customer amounts (server-computed with tier, grower-share overrides, and service fees applied).
              </div>
            )}
            <CustomerSharesTable
              shares={shares}
              invoiceTotalCents={invoiceTotalCents}
              preview={previewData}
            />
          </div>
        )}

        {activeTab === 'applied_info' && (
          <div className="p-4 space-y-4">
            <h3 className="font-semibold">Application Details</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Wind Direction</label>
                <input
                  type="text"
                  value={windDirection}
                  onChange={(e) => { setWindDirection(e.target.value); setDirty(true); }}
                  placeholder="e.g. NW 5-10 mph"
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Temperature</label>
                <input
                  type="text"
                  value={temperature}
                  onChange={(e) => { setTemperature(e.target.value); setDirty(true); }}
                  placeholder="e.g. 72F"
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Applicator</label>
                <input
                  type="text"
                  value={applicator}
                  onChange={(e) => { setApplicator(e.target.value); setDirty(true); }}
                  placeholder="Applicator name"
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
            </div>
          </div>
        )}
      </Card>

      <SelectLocationsModal
        isOpen={showLocationsModal}
        onClose={() => setShowLocationsModal(false)}
        onSelect={handleLocationsSelected}
        initialSelectedIds={locations.map((l) => l.field_id)}
      />

      <ConfirmModal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete Invoice"
        message="Are you sure you want to delete this field application invoice? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
