import { useEffect, useRef, useState , useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Save, Plus, Trash2, Check, FileText, Beaker, Ban, MessageSquarePlus, Printer, CloudSun, MapPin, Truck, ClipboardList, FlaskConical, Bell, History, BookmarkPlus, GripVertical, ChevronUp, ChevronDown } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { logActivity } from '../lib/activityLogger';
import { supabase, checkMutationResult, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { getLicenseStatus, licenseStatusLabel } from '../lib/licenseStatus';
import { generateWpsNoticePdf } from '../lib/wpsNoticePdf';
import { generateApplicatorSheetPdf } from '../lib/applicatorSheetPdf';
import {
  buildApplicatorSheetData,
  parseCustomConfig,
  SHEET_FORMAT_LABELS,
  type ApplicatorSheetData,
  type ApplicatorSheetFormat,
} from '../lib/applicatorSheetData';
import { generateChemicalApplicationReportPdf } from '../lib/chemicalApplicationReportPdf';
import { resolveBilledCustomers } from '../lib/billedCustomersResolver';
import { generateLoaderWorksheetPdf } from '../lib/loaderWorksheetPdf';
import { computeLoaderWorksheet, isGallonCapacityUnit } from '../lib/loaderWorksheet';
import { overrideSaveApplicatorId, shouldReassignApplicatorAfterSave, canGenerateWpsNotice } from '../lib/jobSaveHelpers';
import { fetchCurrentWeather, parseCentroid } from '../lib/weatherCapture';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import { applyChemEdit, recomputeChemRowForAcres, sumAcres, toGallonOrLbEquivalent } from '../lib/chemCalculator';
import { recipeItemToChemRowSeed, chemRowsToRecipeItems, getLastRecipeId, setLastRecipeId } from '../lib/recipeHelpers';
import { moveItem, moveUp, moveDown } from '../lib/routeOrder';
import AppliedRecordsManager from '../components/jobs/AppliedRecordsManager';
import QuickTaskModal from '../components/team/QuickTaskModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import RelatedNotes from '../components/team/RelatedNotes';
import { Sentry } from '../lib/sentry';
import type { JobStatus, Customer, Product, Field, Vehicle, Profile, BlendRecipe, BlendRecipeItem, LinkedEntityType } from '../types';
import type { Json } from '../types/supabase';

interface JobDbRow {
  id: string;
  job_number: string;
  status: JobStatus;
  customer_id: string;
  job_date: string;
  scheduled_time?: string | null;
  applicator_id?: string | null;
  vehicle_id?: string | null;
  recipe_id?: string | null;
  notes?: string | null;
  batch_id?: string | null;
  // Field-app parity #1: scheduling + memo fields.
  call_date?: string | null;
  date_proposed?: string | null;
  time_proposed?: string | null;
  schedule_date?: string | null;
  date_expires?: string | null;
  consultant_id?: string | null;
  // Field-app parity #6: filterable ground crew (set via direct .update()).
  ground_crew_id?: string | null;
  loader_comment?: string | null;
  additional_info?: string | null;
  internal_memo?: string | null;
  // Field-app parity #10: loader-worksheet inputs (set via direct .update(), like
  // ground_crew_id — the save_job 6-arg contract is frozen). carrier_rate_gpa =
  // gallons of carrier (water) per acre; loader_tank_capacity = optional per-job
  // tank-capacity override (else the assigned vehicle's capacity_gallons).
  carrier_rate_gpa?: number | null;
  loader_tank_capacity?: number | null;
  job_fields?: Array<{
    field_id: string;
    acres_to_treat?: number | null;
    planted_acres?: number | null;
    crop?: string | null;
    strip?: string | null;
    pests?: string | null;
    sort_order: number;
    field?: { field_name: string } | null;
  }>;
  job_chemicals?: Array<{
    id: string;
    product_id: string;
    quantity?: number | null;
    unit?: string | null;
    rate_per_acre?: number | null;
    rate_unit?: string | null;
    cost_per_unit_cents?: number | null;
    price_per_unit_cents?: number | null;
    diluent_rate?: number | null;
    rei_hours?: number | null;
    phi_days?: number | null;
    warehouse?: string | null;
    vendor?: string | null;
    sort_order: number;
    product?: { product_name: string } | null;
  }>;
  job_field_shares?: Array<{
    field_id: string;
    customer_id: string;
    split_pct: number;
    is_primary: boolean;
  }>;
  applied_info?: Array<{
    wind_speed?: number | null;
    wind_direction?: string | null;
    temperature?: number | null;
    humidity?: number | null;
    actual_gallons_applied?: number | null;
    notes?: string | null;
  }> | {
    wind_speed?: number | null;
    wind_direction?: string | null;
    temperature?: number | null;
    humidity?: number | null;
    actual_gallons_applied?: number | null;
    notes?: string | null;
  } | null;
  quote_id?: string | null;
  quote_section_id?: string | null;
  quote?: { quote_number: string } | null;
  quote_section?: { section_name: string } | null;
  // #10: the assigned vehicle's capacity, embedded so the loader worksheet keeps
  // a capacity fallback even when the vehicle is INACTIVE (loadLookups filters
  // vehicles to status='active', so selectedVehicle would be undefined for it).
  vehicle?: { vehicle_name: string; capacity_gallons?: number | null; capacity_unit?: string | null } | null;
}

interface SaveJobResult { job_id: string }
interface CompleteJobResult { record_number: string }
interface TransferJobResult { invoice_id: string; invoice_number: string }

const statusVariant: Record<JobStatus, BadgeVariant> = {
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'default',
  invoiced: 'success',
};

type TabKey = 'locations' | 'chemicals' | 'loader' | 'applied' | 'notifications';
const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'locations', label: 'Locations', icon: <MapPin className="w-4 h-4" /> },
  { key: 'chemicals', label: 'Chemicals / Charges', icon: <Beaker className="w-4 h-4" /> },
  { key: 'loader', label: 'Loader Worksheet', icon: <Truck className="w-4 h-4" /> },
  { key: 'applied', label: 'Applied Info', icon: <ClipboardList className="w-4 h-4" /> },
  { key: 'notifications', label: 'Notifications', icon: <Bell className="w-4 h-4" /> },
];

interface ChemRow {
  id?: string;
  product_id: string;
  product_name: string;
  quantity: string;
  unit: string;
  rate_per_acre: string;
  rate_unit: string;
  cost_per_unit_cents: string;
  price_per_unit_cents: string;
  // Field-app parity #1: chemical extras.
  diluent_rate: string;
  rei_hours: string;
  phi_days: string;
  warehouse: string;
  vendor: string;
  sort_order: number;
  /** UI-only (NOT persisted): which field the user last drove — so an acreage
   *  change re-derives the OTHER field and never silently rewrites a
   *  hand-entered quantity (Codex P2). 'rate' = quantity follows; 'qty' = rate
   *  follows; undefined = untouched (a loaded line follows its rate if it has one). */
  driver?: 'rate' | 'qty';
}

interface FieldRow {
  field_id: string;
  field_name: string;
  acres_to_treat: string;
  // Field-app parity #1: per-field agronomy.
  planted_acres: string;
  crop: string;
  strip: string;
  pests: string;
  sort_order: number;
}

/** One customer's share of a single field (per-field customer share %). */
interface ShareRow {
  field_id: string;
  customer_id: string;
  split_pct: string;
  is_primary: boolean;
}

export default function JobDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const saveJobIdem = useIdempotencyKey('save_job', profile?.id || '');
  const completeJobIdem = useIdempotencyKey('complete_job', profile?.id || '');
  const startJobIdem = useIdempotencyKey('start_job', profile?.id || '');
  const transferJobIdem = useIdempotencyKey('transfer_job_to_invoice', profile?.id || '');
  const isNew = id === 'new';
  const isEditable = role === 'admin' || role === 'sales_rep';

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  // Dirty = current form differs from the baseline captured at load/save. This is
  // CONTENT-based (not a ref-flag armed on a timer), so it is immune to render
  // timing and React 18 StrictMode's dev mount→remount double-invoke — a freshly
  // loaded job is never wrongly flagged "unsaved". Baseline is re-captured after
  // every successful save/start/complete (which re-run fetchJob).
  const [isDirty, setIsDirty] = useState(false);
  const baselineRef = useRef<string | null>(null);
  const blocker = useUnsavedChanges(isDirty);
  const [activeTab, setActiveTab] = useState<TabKey>('locations');

  // Lookup data
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [allFields, setAllFields] = useState<Field[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [applicators, setApplicators] = useState<Profile[]>([]);
  // Staff-held license rows per profile (B5 license gates)
  const [licensesByProfile, setLicensesByProfile] = useState<Record<string, { expiry_date: string; is_active: boolean }[]>>({});
  const [recipes, setRecipes] = useState<BlendRecipe[]>([]);

  // Job form
  const [jobNumber, setJobNumber] = useState('');
  const [status, setStatus] = useState<JobStatus>('scheduled');
  const [customerId, setCustomerId] = useState('');
  const [jobDate, setJobDate] = useState(localToday());
  const [scheduledTime, setScheduledTime] = useState('');
  const [applicatorId, setApplicatorId] = useState('');
  // Scheduling fields (Locations tab)
  const [callDate, setCallDate] = useState('');
  const [dateProposed, setDateProposed] = useState('');
  const [timeProposed, setTimeProposed] = useState('');
  const [scheduleDate, setScheduleDate] = useState('');
  const [dateExpires, setDateExpires] = useState('');
  const [consultantId, setConsultantId] = useState('');
  // Field-app parity #6: ground crew (a filterable job attribute). Persisted via
  // a direct .update() after save_job — NOT through the save_job payload, since
  // that RPC's 6-arg contract is frozen and does not handle ground_crew_id.
  const [groundCrewId, setGroundCrewId] = useState('');
  const [groundCrews, setGroundCrews] = useState<{ id: string; name: string }[]>([]);
  // Memo fields
  const [loaderComment, setLoaderComment] = useState('');
  const [additionalInfo, setAdditionalInfo] = useState('');
  const [internalMemo, setInternalMemo] = useState('');
  // Field-app parity #10: loader-worksheet inputs. carrierRateGpa = gallons of
  // carrier (water) per acre → spray volume = total acres × this. tankCapacity =
  // optional per-job capacity override (blank = use the assigned vehicle's). Both
  // persisted via the direct .update() after save_job (frozen RPC contract).
  const [carrierRateGpa, setCarrierRateGpa] = useState('');
  const [tankCapacity, setTankCapacity] = useState('');
  // #10: the assigned vehicle's capacity from the SAVED job embed — survives even
  // when that vehicle is inactive (the active-only `vehicles` lookup wouldn't carry
  // it), so the loader worksheet doesn't false-trip the "enter capacity" state.
  const [savedVehicleCapacity, setSavedVehicleCapacity] = useState<{ name: string | null; gallons: number | null; unit: string | null } | null>(null);
  // The vehicle_id SAVED on the job (distinct from the editable `vehicleId`). The
  // inactive-vehicle capacity fallback only applies while the chosen vehicle still
  // equals this — switching to another vehicle drops the saved-embed fallback.
  const [savedJobVehicleId, setSavedJobVehicleId] = useState<string | null>(null);
  // #10: Loader Worksheet print in progress.
  const [printingLoader, setPrintingLoader] = useState(false);
  // The applicator currently saved on the job — the license gate only fires on a CHANGE
  const [savedApplicatorId, setSavedApplicatorId] = useState<string | null>(null);
  const [showLicenseOverrideConfirm, setShowLicenseOverrideConfirm] = useState(false);
  const assignIdem = useIdempotencyKey('assign_job_applicator', profile?.id || '');
  // B3: WPS pre-application notice PDF
  const [printingWps, setPrintingWps] = useState(false);
  // #9: applicator field sheet (Original / Custom / Enhanced) print picker.
  const [sheetPickerOpen, setSheetPickerOpen] = useState(false);
  const [generatingSheet, setGeneratingSheet] = useState<ApplicatorSheetFormat | null>(null);
  // #11: Chemical Application Report (per-job chemical-centric PDF) print in progress.
  const [generatingChemReport, setGeneratingChemReport] = useState(false);
  // C4: weather auto-capture at completion
  const [fetchingWeather, setFetchingWeather] = useState(false);

  const handleWpsNotice = async () => {
    // #5: the notice is built from current form state, so it MUST reflect the saved
    // job. Block while there are unsaved edits — the printed REI/PHI, fields, products
    // and applicator must match the persisted record, not in-progress form values.
    if (!canGenerateWpsNotice({ isDirty })) {
      toast('error', 'Save the job before printing the WPS notice — it must match the saved record.');
      return;
    }
    setPrintingWps(true);
    try {
      // Pull label fields for EVERY product on the job, INCLUDING any since-
      // deactivated ones — allProducts is is_active=true only, so a historical or
      // scheduled job with a retired product would otherwise print a notice missing
      // its EPA reg / signal word / REI / PHI (Codex 2026-06-13 finding 2).
      const wpsPids = chemRows.filter((c) => c.product_id).map((c) => c.product_id);
      const labelById = new Map<string, { product_name: string; epa_registration: string | null; signal_word: string | null; rei_hours: number | null; phi_days: number | null }>();
      if (wpsPids.length > 0) {
        const { data: lp, error: lpErr } = await supabase
          .from('products')
          .select('id, product_name, epa_registration, signal_word, rei_hours, phi_days')
          .in('id', wpsPids);
        // A WPS notice is a compliance document — never print it with missing label
        // data. Supabase returns { data:null, error } without throwing, so abort the
        // PDF on a failed lookup, or if any job product has no label row at all
        // (Codex 2026-06-13 round-3 finding 1).
        if (lpErr || !lp) {
          toast('error', 'Could not load product label data — try again before printing the WPS notice.');
          setPrintingWps(false);
          return;
        }
        (lp as Array<{ id: string; product_name: string; epa_registration: string | null; signal_word: string | null; rei_hours: number | null; phi_days: number | null }>).forEach((p) => labelById.set(p.id, p));
        const missingLabel = wpsPids.filter((pid) => !labelById.has(pid));
        if (missingLabel.length > 0) {
          toast('error', 'Some products on this job have no label data on file — the WPS notice cannot be completed.');
          setPrintingWps(false);
          return;
        }
      }
      await generateWpsNoticePdf({
        job_number: jobNumber || 'draft',
        customer_name: customers.find((c) => c.id === customerId)?.farm_name || 'Customer',
        application_date: jobDate,
        scheduled_time: scheduledTime || null,
        applicator_name: applicators.find((a) => a.id === applicatorId)?.full_name || null,
        fields: fieldRows
          .filter((f) => f.field_id)
          .map((f) => {
            const fld = allFields.find((af) => af.id === f.field_id);
            return {
              field_name: fld?.field_name || 'Field',
              county: fld?.county || null,
              state: fld?.state || null,
              acres: parseFloat(f.acres_to_treat) || 0,
            };
          }),
        products: chemRows
          .filter((c) => c.product_id)
          .map((c) => {
            const p = labelById.get(c.product_id);
            return {
              product_name: p?.product_name || c.product_name || 'Product',
              epa_registration: p?.epa_registration || null,
              signal_word: p?.signal_word || null,
              rei_hours: p?.rei_hours ?? null,
              phi_days: p?.phi_days ?? null,
              rate_per_acre: parseFloat(c.rate_per_acre) || null,
              rate_unit: c.rate_unit || null,
            };
          }),
      });
      // Stamp the printed status (ChemMan "Printed" column) + who printed it.
      // Best-effort: a failed stamp must not block the already-generated PDF.
      if (!isNew && id) {
        const stampRes = await supabase.from('jobs').update({ printed_at: new Date().toISOString(), last_printed_by: profile?.id ?? null }).eq('id', id).select();
        try { checkMutationResult(stampRes, 'Stamp printed_at'); } catch { /* non-blocking */ }
      }
      if (profile) logActivity({ event: 'wps_notice_printed', description: `WPS pre-application notice generated for job ${jobNumber}`, performedBy: profile.id, entityType: 'job', entityId: id });
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'wps_notice_pdf' } });
      toast('error', 'Failed to generate WPS notice');
    }
    setPrintingWps(false);
  };

  // Shared builder: assemble the SHARED ApplicatorSheetData from current (saved)
  // form state. Used by BOTH the Applicator Field Sheet (#9) and the Chemical
  // Application Report (#11) so their products, rates, totals and gal/lb
  // conversions are byte-identical for the same job. Returns null on a failed
  // product-label lookup (caller toasts + aborts). Caller must have already
  // verified the job is saved (not dirty).
  // `strict` (default) = COMPLIANCE mode (#11 chemical report): billed customers are
  // resolved via the SECURITY DEFINER RPC and an INCOMPLETE resolution ABORTS (returns
  // null → caller toasts, no PDF, no printed_at). `strict = false` = the #9 field sheet:
  // it still resolves via the RPC, but on an incomplete/empty result it falls back to
  // the shipped #9 semantics (a null-named billed customer prints as "Customer", and an
  // empty customer set falls back to the primary customer) rather than refusing.
  const buildSheetDataFromState = async (strict = true): Promise<ApplicatorSheetData | null> => {
    // Pull REI/PHI/EPA/product_form for EVERY product on the job, including any
    // since-deactivated ones (allProducts is is_active=true only) — mirrors the
    // WPS-notice label fetch so a retired product still prints its compliance data.
    const pids = chemRows.filter((c) => c.product_id).map((c) => c.product_id);
    const labelById = new Map<string, { rei_hours: number | null; phi_days: number | null; epa_registration: string | null; product_form: 'liquid' | 'dry' | null }>();
    if (pids.length > 0) {
      const { data: lp, error: lpErr } = await supabase
        .from('products')
        .select('id, rei_hours, phi_days, epa_registration, product_form')
        .in('id', pids);
      if (lpErr || !lp) return null;
      (lp as Array<{ id: string; rei_hours: number | null; phi_days: number | null; epa_registration: string | null; product_form: string | null }>).forEach((p) => {
        const form = p.product_form === 'liquid' || p.product_form === 'dry' ? p.product_form : null;
        labelById.set(p.id, { rei_hours: p.rei_hours, phi_days: p.phi_days, epa_registration: p.epa_registration, product_form: form });
      });
      // A short array (RLS-hidden / deleted product) returns NO error, but a missing
      // label row would silently blank that product's EPA reg / gal-lb / REI / PHI —
      // abort (return null → caller toasts) so a compliance printout is never built
      // with missing label data (Codex P2; mirrors the WPS-notice path).
      if (pids.some((pid) => !labelById.has(pid))) return null;
    }

    // Billed customers via the SECURITY DEFINER RPC (saved job_field_shares →
    // field_billing_defaults → primary customer_id), which resolves the CO-billed
    // customers an applicator's customers_select RLS hides (the #11 split-bill
    // omission). Only a SAVED job has rows to resolve; a brand-new/unsaved job (no id)
    // uses the in-memory fallback below.
    let billedCustomers: ApplicatorSheetData['customers'] = [];
    let resolveComplete = false;
    if (!isNew && id) {
      const resolved = await resolveBilledCustomers(id);
      billedCustomers = resolved.customers;
      resolveComplete = resolved.complete;
    }

    if (strict) {
      // COMPLIANCE (#11): refuse a silently-partial customer set — abort, no PDF/stamp.
      if (!resolveComplete) return null;
    } else {
      // #9 FIELD SHEET: restore the shipped fallback semantics. If the RPC produced no
      // usable customers (unsaved job, or resolution gap), seed from the in-memory
      // share/primary state — a null-named billed customer prints as "Customer", and an
      // empty set falls back to the primary customer (so the sheet always has a line).
      if (billedCustomers.length === 0) {
        const billedIds = [...new Set((shareRows.length > 0 ? shareRows.map((s) => s.customer_id) : [customerId]).filter(Boolean))];
        const custMap = new Map<string, { customer_name: string; account_number: string | null }>();
        billedIds.forEach((cid) => {
          const c = customers.find((cc) => cc.id === cid);
          // A billed customer with a null/blank farm_name still prints as "Customer"
          // (shipped #9 behavior) rather than being silently dropped.
          const name = c?.farm_name || 'Customer';
          custMap.set(`${name}|${c?.account_number ?? ''}`, { customer_name: name, account_number: c?.account_number ?? null });
        });
        // Empty custMap → fall back to the primary customer (never print no customer).
        if (custMap.size === 0 && customerId) {
          const c = customers.find((cc) => cc.id === customerId);
          const name = c?.farm_name || 'Customer';
          custMap.set(`${name}|${c?.account_number ?? ''}`, { customer_name: name, account_number: c?.account_number ?? null });
        }
        billedCustomers = [...custMap.values()];
      }
    }

    // Applicator name: the `applicators` picker list is active-only, so a job whose
    // saved applicator has since been DEACTIVATED would print a blank name. Resolve
    // it directly from profile_public_view by id when it's not in the active list
    // (never a profiles embed — RLS) so the compliance printout keeps the name (Codex P2).
    let applicatorName = applicators.find((a) => a.id === applicatorId)?.full_name || null;
    if (applicatorId && !applicatorName) {
      const { data: prof } = await supabase
        .from('profile_public_view')
        .select('full_name')
        .eq('id', applicatorId)
        .maybeSingle();
      applicatorName = (prof as { full_name?: string | null } | null)?.full_name ?? null;
    }

    return buildApplicatorSheetData({
      job_number: jobNumber || 'draft',
      customers: billedCustomers,
      scheduled_date: jobDate,
      scheduled_time: scheduledTime || null,
      applicator_name: applicatorName,
      vehicle_name: vehicles.find((v) => v.id === vehicleId)?.vehicle_name || null,
      loader_comment: loaderComment || null,
      fields: fieldRows
        .filter((f) => f.field_id)
        .map((f) => {
          const fld = allFields.find((af) => af.id === f.field_id);
          return {
            field_id: f.field_id,
            field_name: fld?.field_name || 'Field',
            county: fld?.county || null,
            state: fld?.state || null,
            acres: parseFloat(f.acres_to_treat) || 0,
            crop: f.crop || fld?.crop_type || null,
            pest: f.pests || null,
            sort_order: f.sort_order,
          };
        }),
      products: chemRows
        .filter((c) => c.product_id)
        .map((c) => {
          const lbl = labelById.get(c.product_id);
          return {
            product_name: c.product_name || 'Product',
            rate_per_acre: parseFloat(c.rate_per_acre) || null,
            rate_unit: c.rate_unit || null,
            // The Total Applied quantity's measure unit (e.g. GAL/LB) — drives the
            // gal/lb conversion + labels Total Applied, matching the in-page
            // preview + loader worksheet. NOT rate_unit (per-acre).
            unit: c.unit || null,
            // Preserve a real 0 (only a BLANK quantity → null), matching the raw-quantity
            // convention the fetch path uses — so JobDetail's #11 report and the Jobs-list
            // report print byte-identical totals for a zero-quantity line (was
            // `parseFloat(c.quantity) || null`, which coerced a real 0 → null).
            total_quantity: c.quantity.trim() === '' ? null : parseFloat(c.quantity),
            product_form: lbl?.product_form ?? null,
            rei_hours: c.rei_hours !== '' ? parseFloat(c.rei_hours) : (lbl?.rei_hours ?? null),
            phi_days: c.phi_days !== '' ? parseFloat(c.phi_days) : (lbl?.phi_days ?? null),
            epa_registration: lbl?.epa_registration ?? null,
          };
        }),
    });
  };

  // #9: generate the Applicator Field Sheet in one of three formats. Built from
  // the SAVED job (blocked while dirty, like the WPS notice) so the printed
  // figures match the persisted record. Fields print IN ROUTE ORDER (sort_order).
  const handleGenerateSheet = async (format: ApplicatorSheetFormat) => {
    if (!canGenerateWpsNotice({ isDirty })) {
      toast('error', 'Save the job before printing the field sheet — it must match the saved record.');
      return;
    }
    setGeneratingSheet(format);
    try {
      // #9 FIELD SHEET: non-strict — fall back to "Customer"/primary if billed-customer
      // resolution is incomplete (it's an internal crew sheet, not a compliance record).
      const sheetData = await buildSheetDataFromState(false);
      if (!sheetData) {
        toast('error', 'Could not load product data — try again before printing the field sheet.');
        setGeneratingSheet(null);
        return;
      }

      // Resolve the Custom layout config (only needed for the Custom format).
      // A failed/absent settings read falls back to the inert default (no error).
      let customCfg = null;
      if (format === 'custom') {
        const { data: cfgRow } = await supabase
          .from('app_settings')
          .select('setting_value')
          .eq('setting_key', 'applicator_sheet_custom')
          .maybeSingle();
        customCfg = parseCustomConfig((cfgRow as { setting_value?: string } | null)?.setting_value ?? null);
      }

      await generateApplicatorSheetPdf(sheetData, format, customCfg);

      // Stamp printed status + who (ChemMan "Printed" column). Best-effort.
      if (!isNew && id) {
        const stampRes = await supabase.from('jobs').update({ printed_at: new Date().toISOString(), last_printed_by: profile?.id ?? null }).eq('id', id).select();
        try { checkMutationResult(stampRes, 'Stamp printed_at'); } catch { /* non-blocking */ }
      }
      if (profile) logActivity({ event: 'applicator_sheet_printed', description: `${SHEET_FORMAT_LABELS[format]} generated for job ${jobNumber}`, performedBy: profile.id, entityType: 'job', entityId: id });
      setSheetPickerOpen(false);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'applicator_sheet_pdf' } });
      toast('error', 'Failed to generate field sheet');
    }
    setGeneratingSheet(null);
  };

  // #11: generate the Chemical Application Report — the official per-job record of
  // exactly what chemical went on each field (handed to a customer or regulator).
  // Built from the SAVED job (blocked while dirty) via the SAME shared gatherer as
  // the applicator field sheet, so every product, rate, total and gal/lb conversion
  // is byte-identical between the two documents.
  const handleChemicalReport = async () => {
    if (!canGenerateWpsNotice({ isDirty })) {
      toast('error', 'Save the job before printing the chemical report — it must match the saved record.');
      return;
    }
    setGeneratingChemReport(true);
    try {
      // #11 COMPLIANCE: strict (default) — a null result means product-label data or a
      // billed customer could not be fully resolved; refuse to print a partial record
      // and do NOT stamp printed_at.
      const sheetData = await buildSheetDataFromState(true);
      if (!sheetData) {
        toast('error', 'Could not complete the chemical report — some product or billed-customer data could not be resolved. Try again.');
        setGeneratingChemReport(false);
        return;
      }
      await generateChemicalApplicationReportPdf(sheetData);
      // Stamp printed status + who (ChemMan "Printed" column). Best-effort.
      if (!isNew && id) {
        const stampRes = await supabase.from('jobs').update({ printed_at: new Date().toISOString(), last_printed_by: profile?.id ?? null }).eq('id', id).select();
        try { checkMutationResult(stampRes, 'Stamp printed_at'); } catch { /* non-blocking */ }
      }
      if (profile) logActivity({ event: 'chemical_application_report_printed', description: `Chemical Application Report generated for job ${jobNumber}`, performedBy: profile.id, entityType: 'job', entityId: id });
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'chemical_application_report_pdf' } });
      toast('error', 'Failed to generate chemical report');
    }
    setGeneratingChemReport(false);
  };

  // #10: generate the Loader Worksheet PDF for this field job. Built from the SAVED
  // job (blocked while dirty, like the field sheet / WPS notice) so the printed
  // loads + per-load amounts match the persisted record. The per-load split is
  // computed inside generateLoaderWorksheetPdf from the SAME pure function the
  // in-page preview uses, so screen and paper agree.
  const handleLoaderWorksheet = async () => {
    if (!canGenerateWpsNotice({ isDirty })) {
      toast('error', 'Save the job before printing the loader worksheet — it must match the saved record.');
      return;
    }
    setPrintingLoader(true);
    try {
      // Billed customers via the SECURITY DEFINER RPC (saved job_field_shares →
      // field_billing_defaults → primary customer_id), which resolves the CO-billed
      // customers an applicator's customers_select RLS hides. A saved job resolves via
      // the RPC and ABORTS (no PDF/stamp) if resolution is incomplete; a brand-new
      // unsaved job uses the in-memory "Customer"/primary fallback.
      let loaderCustomers: ApplicatorSheetData['customers'] = [];
      if (!isNew && id) {
        const resolved = await resolveBilledCustomers(id);
        if (!resolved.complete) {
          toast('error', 'Could not complete the loader worksheet — some billed-customer data could not be resolved. Try again.');
          setPrintingLoader(false);
          return;
        }
        loaderCustomers = resolved.customers;
      } else {
        const billedIds = [...new Set((shareRows.length > 0 ? shareRows.map((s) => s.customer_id) : [customerId]).filter(Boolean))];
        const custMap = new Map<string, { customer_name: string; account_number: string | null }>();
        billedIds.forEach((cid) => {
          const c = customers.find((cc) => cc.id === cid);
          const name = c?.farm_name || 'Customer';
          custMap.set(`${name}|${c?.account_number ?? ''}`, { customer_name: name, account_number: c?.account_number ?? null });
        });
        if (custMap.size === 0 && customerId) {
          const c = customers.find((cc) => cc.id === customerId);
          const name = c?.farm_name || 'Customer';
          custMap.set(`${name}|${c?.account_number ?? ''}`, { customer_name: name, account_number: c?.account_number ?? null });
        }
        loaderCustomers = [...custMap.values()];
      }

      await generateLoaderWorksheetPdf({
        job_number: jobNumber || 'draft',
        customers: loaderCustomers,
        scheduled_date: jobDate,
        scheduled_time: scheduledTime || null,
        applicator_name: applicators.find((a) => a.id === applicatorId)?.full_name || null,
        vehicle_name: selectedVehicle?.vehicle_name || savedVehicleName || null,
        total_acres: totalAcres,
        // Pass the RAW parsed carrier rate (the same value the in-page preview's
        // computeLoaderWorksheet consumed) — NOT the 4dp-rounded display value — so
        // the PDF recomputes the identical split and can't disagree with the screen
        // for a high-precision rate near a tank-capacity boundary (Codex).
        carrier_rate_gpa: !Number.isNaN(parsedCarrierRate) && parsedCarrierRate > 0 ? parsedCarrierRate : null,
        tank_capacity: effectiveCapacity,
        capacity_unit: (tankCapacity.trim() !== '' && effectiveCapacity === overrideCapacity) ? 'gal' : (assignedVehicleCapacityUnit || 'gal'),
        products: chemRows
          .filter((c) => c.product_id)
          .map((c) => ({
            product_name: c.product_name || 'Product',
            // Preserve a real 0 (only a BLANK quantity → null), matching the raw-quantity
            // convention the bulk loaderWorksheetFetch path uses, so single-job and bulk
            // loader worksheets print identical totals for a zero-quantity line.
            total_quantity: c.quantity.trim() === '' ? null : parseFloat(c.quantity),
            unit: c.unit || null,
          })),
        loader_comment: loaderComment || null,
      });

      // Stamp printed status + who (ChemMan "Printed" column). Best-effort.
      if (!isNew && id) {
        const stampRes = await supabase.from('jobs').update({ printed_at: new Date().toISOString(), last_printed_by: profile?.id ?? null }).eq('id', id).select();
        try { checkMutationResult(stampRes, 'Stamp printed_at'); } catch { /* non-blocking */ }
      }
      if (profile) logActivity({ event: 'loader_worksheet_printed', description: `Loader worksheet generated for job ${jobNumber}`, performedBy: profile.id, entityType: 'job', entityId: id });
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'loader_worksheet_pdf' } });
      toast('error', 'Failed to generate loader worksheet');
    }
    setPrintingLoader(false);
  };

  const [vehicleId, setVehicleId] = useState('');
  const [recipeId, setRecipeId] = useState('');
  const [notes, setNotes] = useState('');
  const [batchId, setBatchId] = useState('');
  const [quoteLinkage, setQuoteLinkage] = useState<{ quote_id: string; quote_number: string; section_name: string } | null>(null);

  // Sub-collections
  const [fieldRows, setFieldRows] = useState<FieldRow[]>([]);
  // Field-app parity #5: index of the field row currently being dragged to set
  // the applicator route order (null when no drag is in progress).
  const [dragFieldIndex, setDragFieldIndex] = useState<number | null>(null);
  const [chemRows, setChemRows] = useState<ChemRow[]>([]);
  // Per-field customer shares, keyed by field. Empty until a field is added /
  // shares are loaded — then defaulted from field_billing_defaults.
  const [shareRows, setShareRows] = useState<ShareRow[]>([]);

  // Applied info (completion)
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [appliedInfo, setAppliedInfo] = useState({
    wind_speed: '',
    wind_direction: '',
    temperature: '',
    humidity: '',
    actual_gallons_applied: '',
    notes: '',
  });

  const [quickTaskOpen, setQuickTaskOpen] = useState(false);

  // Transfer to invoice
  const [transferring, setTransferring] = useState(false);

  // Confirm modals
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);

  // Recipe load modal
  const [showRecipeModal, setShowRecipeModal] = useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [loadingRecipe, setLoadingRecipe] = useState(false);
  // 'replace' wipes the current chem lines; 'append' merges the recipe in (so a
  // recipe can be loaded WITHOUT discarding hand-entered lines). Client-side, so
  // it never touches unrelated job data and works on a brand-new unsaved job.
  const [recipeMode, setRecipeMode] = useState<'replace' | 'append'>('replace');
  // "Use last used recipe" — per-browser shortcut (localStorage, no DB change).
  const [lastRecipeId, setLastRecipeIdState] = useState<string | null>(() => getLastRecipeId());
  // Save-current-chemicals-as-a-new-recipe modal
  const [showSaveRecipeModal, setShowSaveRecipeModal] = useState(false);
  const [newRecipeName, setNewRecipeName] = useState('');
  const [savingRecipe, setSavingRecipe] = useState(false);
  const saveRecipeIdem = useIdempotencyKey('save_blend_recipe', profile?.id || '');

  // A stable string of every editable form field — the unit of dirty comparison.
  const formSnapshot = useCallback(() => JSON.stringify({
    customerId, jobDate, scheduledTime, applicatorId, vehicleId, notes, batchId,
    callDate, dateProposed, timeProposed, scheduleDate, dateExpires, consultantId, groundCrewId,
    loaderComment, additionalInfo, internalMemo, carrierRateGpa, tankCapacity,
    fieldRows, chemRows, shareRows,
  }), [customerId, jobDate, scheduledTime, applicatorId, vehicleId, notes, batchId,
       callDate, dateProposed, timeProposed, scheduleDate, dateExpires, consultantId, groundCrewId,
       loaderComment, additionalInfo, internalMemo, carrierRateGpa, tankCapacity,
       fieldRows, chemRows, shareRows]);

  // Single dirty engine: when no baseline is set yet, ADOPT the current form as the
  // clean baseline (but only once the load has settled, so we don't adopt a half-
  // populated form); thereafter compare. fetchJob / the new-job init reset the
  // baseline to null so a fresh load (or a post-save refetch) re-adopts cleanly.
  useEffect(() => {
    const snap = formSnapshot();
    if (baselineRef.current === null) {
      if (!loading) {
        baselineRef.current = snap;
        setIsDirty(false);
      }
      return;
    }
    setIsDirty(snap !== baselineRef.current);
  }, [formSnapshot, loading]);

  const loadLookups = async () => {
    const [custResult, fieldResult, prodResult, vehicleResult, appResult, recipeResult] = await Promise.all([
      supabase.from('customers').select('*').eq('is_active', true).order('farm_name'),
      supabase.from('fields').select('*').order('field_name'),
      supabase.from('products').select('*').eq('is_active', true).order('product_name'),
      supabase.from('vehicles').select('*').eq('status', 'active').order('vehicle_name'),
      // PR-07 follow-up: applicator picker only uses a.id + a.full_name + a.role; safe via view.
      supabase.from('profile_public_view').select('id, full_name, role, is_active').in('role', ['applicator', 'admin', 'sales_rep']).eq('is_active', true).order('full_name'),
      supabase.from('blend_recipes').select('*').eq('is_active', true).order('name'),
    ]);
    setCustomers((custResult.data || []) as Customer[]);
    setAllFields((fieldResult.data || []) as Field[]);
    setAllProducts((prodResult.data || []) as Product[]);
    setVehicles((vehicleResult.data || []) as Vehicle[]);
    setApplicators((appResult.data || []) as Profile[]);
    setRecipes((recipeResult.data || []) as BlendRecipe[]);

    // Field-app parity #6: active ground crews for the crew picker.
    const crewResult = await supabase
      .from('ground_crews').select('id, name').eq('is_active', true).order('name');
    setGroundCrews((crewResult.data || []) as { id: string; name: string }[]);

    // Staff-held license rows for the license-gate badge + pre-save check (B5)
    const licResult = await supabase
      .from('applicator_licenses')
      .select('profile_id, expiry_date, is_active')
      .not('profile_id', 'is', null);
    const byProfile: Record<string, { expiry_date: string; is_active: boolean }[]> = {};
    ((licResult.data || []) as { profile_id: string; expiry_date: string; is_active: boolean }[]).forEach((l) => {
      (byProfile[l.profile_id] ||= []).push({ expiry_date: l.expiry_date, is_active: l.is_active });
    });
    setLicensesByProfile(byProfile);
  };

  const fetchJob = useCallback(async () => {
    // Drop the baseline so the freshly-loaded form is re-adopted as clean once it
    // settles (also covers post-save refetches where loading stays false).
    baselineRef.current = null;
    const { data, error } = await supabase
      // PR-07 follow-up: dropped applicator FK embed — full_name isn't read
      // anywhere in this page; only applicator_id is consumed (line 235).
      .from('jobs')
      .select(`
        *,
        customer:customers(farm_name),
        vehicle:vehicles(vehicle_name, capacity_gallons, capacity_unit),
        quote:quotes!jobs_quote_id_fkey(quote_number),
        quote_section:quote_sections!jobs_quote_section_id_fkey(section_name),
        job_fields(*, field:fields(field_name)),
        job_chemicals(*, product:products(product_name)),
        job_field_shares(*),
        applied_info:job_applied_info(*)
      `)
      .eq('id', id!)
      .single();

    if (error || !data) {
      toast('error', 'Job not found');
      navigate('/jobs');
      return;
    }

    const j = data as unknown as JobDbRow;
    setJobNumber(j.job_number);
    setStatus(j.status);
    setCustomerId(j.customer_id);
    setJobDate(j.job_date);
    setScheduledTime(j.scheduled_time || '');
    setApplicatorId(j.applicator_id || '');
    setSavedApplicatorId(j.applicator_id || null);
    setVehicleId(j.vehicle_id || '');
    // #10: keep the assigned vehicle's id + capacity from the embed (works even if
    // the vehicle is now inactive and absent from the active-only `vehicles` lookup).
    setSavedJobVehicleId(j.vehicle_id || null);
    setSavedVehicleCapacity(j.vehicle ? { name: j.vehicle.vehicle_name ?? null, gallons: j.vehicle.capacity_gallons ?? null, unit: j.vehicle.capacity_unit ?? null } : null);
    setRecipeId(j.recipe_id || '');
    setNotes(j.notes || '');
    setBatchId(j.batch_id || '');
    setCallDate(j.call_date || '');
    setDateProposed(j.date_proposed || '');
    setTimeProposed(j.time_proposed || '');
    setScheduleDate(j.schedule_date || '');
    setDateExpires(j.date_expires || '');
    setConsultantId(j.consultant_id || '');
    setGroundCrewId(j.ground_crew_id || '');
    setLoaderComment(j.loader_comment || '');
    setAdditionalInfo(j.additional_info || '');
    setInternalMemo(j.internal_memo || '');
    // #10 loader-worksheet inputs (numbers stored as strings in the form).
    setCarrierRateGpa(j.carrier_rate_gpa != null ? String(j.carrier_rate_gpa) : '');
    setTankCapacity(j.loader_tank_capacity != null ? String(j.loader_tank_capacity) : '');
    // Quote traceability (typed via JobDbRow)
    if (j.quote_id) {
      setQuoteLinkage({ quote_id: j.quote_id, quote_number: j.quote?.quote_number || '', section_name: j.quote_section?.section_name || '' });
    }

    setFieldRows(
      // Field-app parity #5: sort_order is the deliberate applicator route order.
      // PostgREST does not guarantee embedded-row order, so sort explicitly here
      // (stable index tiebreak) — the field list, save (index -> sort_order), and
      // downstream printouts/map all read this single ordering.
      (j.job_fields || [])
        .map((f, idx) => ({ f, idx }))
        .sort((a, b) => (a.f.sort_order - b.f.sort_order) || (a.idx - b.idx))
        .map(({ f }) => ({
          field_id: f.field_id,
          field_name: f.field?.field_name || '',
          acres_to_treat: f.acres_to_treat?.toString() || '',
          planted_acres: f.planted_acres?.toString() || '',
          crop: f.crop || '',
          strip: f.strip || '',
          pests: f.pests || '',
          sort_order: f.sort_order,
        }))
    );

    // Load saved shares; then SEED defaults for any field that has no saved
    // shares (existing jobs created before this migration, or a field never
    // touched), so the list/#26 split don't collapse to the primary customer
    // (Codex). Defaults come from field_billing_defaults, else field owner 100%.
    const savedShares: ShareRow[] = (j.job_field_shares || []).map((s) => ({
      field_id: s.field_id,
      customer_id: s.customer_id,
      split_pct: s.split_pct?.toString() || '',
      is_primary: s.is_primary,
    }));
    const fieldsWithShares = new Set(savedShares.map((s) => s.field_id));
    const fieldsNeedingSeed = (j.job_fields || [])
      .map((f) => f.field_id)
      .filter((fid) => fid && !fieldsWithShares.has(fid));
    if (fieldsNeedingSeed.length > 0) {
      const { data: fbd } = await supabase
        .from('field_billing_defaults')
        .select('field_id, customer_id, split_pct, is_primary')
        .in('field_id', fieldsNeedingSeed);
      const fbdByField = new Map<string, { customer_id: string; split_pct: number; is_primary: boolean }[]>();
      ((fbd || []) as { field_id: string; customer_id: string; split_pct: number; is_primary: boolean }[])
        .forEach((d) => {
          const list = fbdByField.get(d.field_id) ?? [];
          list.push(d);
          fbdByField.set(d.field_id, list);
        });
      for (const fid of fieldsNeedingSeed) {
        const defs = fbdByField.get(fid);
        if (defs && defs.length > 0) {
          defs.forEach((d) => savedShares.push({ field_id: fid, customer_id: d.customer_id, split_pct: d.split_pct.toString(), is_primary: d.is_primary }));
        } else if (j.customer_id) {
          // No billing default on file — fall back to the job's customer at 100%
          // (matches the server's derive_customer_shares_from_fields fallback).
          savedShares.push({ field_id: fid, customer_id: j.customer_id, split_pct: '100', is_primary: true });
        }
      }
    }
    setShareRows(savedShares);

    setChemRows(
      (j.job_chemicals || []).map((c) => ({
        id: c.id,
        product_id: c.product_id,
        product_name: c.product?.product_name || '',
        quantity: c.quantity?.toString() || '0',
        unit: c.unit || '',
        rate_per_acre: c.rate_per_acre?.toString() || '',
        rate_unit: c.rate_unit || '',
        cost_per_unit_cents: c.cost_per_unit_cents?.toString() || '0',
        price_per_unit_cents: c.price_per_unit_cents?.toString() || '0',
        diluent_rate: c.diluent_rate?.toString() || '',
        rei_hours: c.rei_hours?.toString() || '',
        phi_days: c.phi_days?.toString() || '',
        warehouse: c.warehouse || '',
        vendor: c.vendor || '',
        sort_order: c.sort_order,
      }))
    );

    const aiData = Array.isArray(j.applied_info) ? j.applied_info[0] : j.applied_info;
    if (aiData) {
      setAppliedInfo({
        wind_speed: aiData.wind_speed?.toString() || '',
        wind_direction: aiData.wind_direction || '',
        temperature: aiData.temperature?.toString() || '',
        humidity: aiData.humidity?.toString() || '',
        actual_gallons_applied: aiData.actual_gallons_applied?.toString() || '',
        notes: aiData.notes || '',
      });
    }

    setLoading(false);
    // initialLoadDone is armed by the loading-settle effect (rAF after loading=false).
  }, [id, toast, navigate]);

  useEffect(() => {
    // Await lookups FIRST so every lookup-driven re-render happens before the job
    // rows are populated and dirty-tracking is armed — otherwise a late-landing
    // lookup re-render after arming would mark a freshly-opened job dirty.
    (async () => {
      await loadLookups();
      if (!isNew && id) {
        await fetchJob();
      } else {
        const { data, error } = await supabase.rpc('next_job_number');
        if (!error && data) setJobNumber(assertRpcResult<string>(data, 'next_job_number'));
        const recipeParam = searchParams.get('recipe_id');
        if (recipeParam) setRecipeId(recipeParam);
        // New job: loading is already false; the loading-settle effect arms
        // initialLoadDone after the first committed frame.
      }
    })();
  }, [id, fetchJob, isNew, searchParams]);

  // Computed
  const customerFields = allFields.filter(f => !customerId || f.customer_id === customerId);
  const totalAcres = fieldRows.reduce((sum, f) => sum + (parseFloat(f.acres_to_treat) || 0), 0);
  const totalCostCents = chemRows.reduce((sum, c) => sum + Math.round((parseFloat(c.quantity) || 0) * (parseInt(c.cost_per_unit_cents) || 0)), 0);
  const totalPriceCents = chemRows.reduce((sum, c) => sum + Math.round((parseFloat(c.quantity) || 0) * (parseInt(c.price_per_unit_cents) || 0)), 0);

  // Loader worksheet (#10) — the spray tank is sized by SPRAY VOLUME, not by the
  // sum of chemical gallons. Spray volume = total acres × the carrier rate (gal/
  // acre); loads = ceil(spray volume / tank capacity). The effective capacity is
  // the per-job override (if entered) else the assigned vehicle's capacity_gallons.
  // computeLoaderWorksheet does the per-load split + the Invalid guard (no crash /
  // no wrong number when capacity or carrier rate is missing). The PDF prints from
  // this SAME function, so the on-screen preview and the paper always agree.
  const selectedVehicle = vehicles.find(v => v.id === vehicleId);
  // The assigned vehicle's capacity. If the chosen vehicle IS in the active lookup,
  // its capacity is authoritative (even when null — a real active vehicle with no
  // capacity must NOT borrow some other vehicle's number). Only when the assigned
  // vehicle is ABSENT from the active list (an inactive vehicle still on the saved
  // job) do we fall back to the SAVED job's embedded vehicle, and ONLY when the
  // chosen vehicleId still equals the saved job's vehicle (not after switching to a
  // different vehicle). Otherwise the worksheet would false-trip "enter capacity".
  const assignedVehicleIsInactive = !!vehicleId && !selectedVehicle && vehicleId === savedJobVehicleId;
  const rawAssignedVehicleCapacity = selectedVehicle
    ? (selectedVehicle.capacity_gallons ?? null)
    : (assignedVehicleIsInactive && savedVehicleCapacity ? savedVehicleCapacity.gallons : null);
  const assignedVehicleCapacityUnit = selectedVehicle
    ? (selectedVehicle.capacity_unit ?? null)
    : (assignedVehicleIsInactive && savedVehicleCapacity ? savedVehicleCapacity.unit : null);
  // Only use the vehicle's capacity as the GALLON tank size when its unit measures
  // gallons. A dry spreader rated in lbs/tons can't seed gallon loads — the user
  // supplies a per-job gallon override instead (Codex).
  const assignedVehicleCapacity = isGallonCapacityUnit(assignedVehicleCapacityUnit)
    ? rawAssignedVehicleCapacity
    : null;
  const savedVehicleName = selectedVehicle
    ? selectedVehicle.vehicle_name
    : (assignedVehicleIsInactive && savedVehicleCapacity ? savedVehicleCapacity.name : null);
  // The per-job override: a non-blank value that is NOT a positive number is
  // treated as INVALID (capacity null → the worksheet shows its guard), never as a
  // silent fall-through to the vehicle capacity (Codex). Blank => use the vehicle.
  const overrideCapacity = parseFloat(tankCapacity);
  const overrideIsBlank = tankCapacity.trim() === '';
  const overrideIsValid = !overrideIsBlank && !Number.isNaN(overrideCapacity) && overrideCapacity > 0;
  const effectiveCapacity = overrideIsBlank
    ? (assignedVehicleCapacity ?? null)        // no override → assigned vehicle
    : (overrideIsValid ? overrideCapacity : null); // bad override → invalid (guard)
  const parsedCarrierRate = parseFloat(carrierRateGpa);
  const loaderWorksheet = computeLoaderWorksheet({
    total_acres: totalAcres,
    carrier_rate_gpa: carrierRateGpa.trim() !== '' && !Number.isNaN(parsedCarrierRate) ? parsedCarrierRate : null,
    tank_capacity: effectiveCapacity,
    products: chemRows
      .filter((c) => c.product_id)
      .map((c) => ({
        product_name: c.product_name || 'Product',
        total_quantity: parseFloat(c.quantity) || null,
        unit: c.unit || null,
      })),
  });

  // C4: weather auto-capture at completion (first selected field's centroid).
  const firstFieldId = fieldRows.find((r) => r.field_id)?.field_id ?? null;
  const [jobFieldCentroid, setJobFieldCentroid] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!firstFieldId) {
      setJobFieldCentroid(null);
      return;
    }
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_field_geojson', { p_field_id: firstFieldId });
        if (cancelled) return;
        if (error) {
          setJobFieldCentroid(null);
          return;
        }
        const rows = assertRpcResult<Array<{ centroid_geojson?: string | null }>>(data, 'get_field_geojson');
        setJobFieldCentroid(parseCentroid(rows[0]?.centroid_geojson));
      } catch {
        if (!cancelled) setJobFieldCentroid(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [firstFieldId]);

  const handleFetchWeather = async () => {
    if (!jobFieldCentroid) return;
    setFetchingWeather(true);
    const w = await fetchCurrentWeather(jobFieldCentroid.lat, jobFieldCentroid.lng);
    setFetchingWeather(false);
    if (!w) {
      toast('error', 'Could not fetch weather — enter conditions manually');
      return;
    }
    setAppliedInfo((prev) => ({
      ...prev,
      wind_speed: w.wind_speed_mph.toString(),
      wind_direction: w.wind_direction,
      temperature: w.temperature_f.toString(),
      humidity: w.humidity_pct.toString(),
    }));
    toast('success', 'Weather filled from current conditions — adjust if needed');
  };

  // ── Per-field customer-share validation: each field's shares must total 100% ──
  const fieldShareTotals = (() => {
    const byField: Record<string, number> = {};
    shareRows.forEach((s) => {
      byField[s.field_id] = (byField[s.field_id] || 0) + (parseFloat(s.split_pct) || 0);
    });
    return byField;
  })();
  const sharesValid = fieldRows
    .filter((f) => f.field_id)
    .every((f) => {
      const fieldShares = shareRows.filter((s) => s.field_id === f.field_id);
      // No explicit shares = single-owner field (server defaults to 100% owner). OK.
      if (fieldShares.length === 0) return true;
      return Math.abs((fieldShareTotals[f.field_id] || 0) - 100) < 0.01;
    });

  const handleSave = async () => {
    saveJobIdem.resetKey();
    if (!customerId) { toast('error', 'Customer is required'); return; }
    if (!jobDate) { toast('error', 'Job date is required'); return; }
    if (!sharesValid) {
      toast('error', "Each field's customer shares must total 100%. Open the Locations tab to fix.");
      return;
    }

    // #10: validate the loader-worksheet numbers BEFORE saving (don't silently
    // drop a value). A present-but-out-of-range value is rejected here with a
    // clear message — otherwise the post-save direct .update() would clear the
    // previously-saved value (or be rejected by the CHECK). Blank stays allowed
    // (it clears intentionally). Mirrors the mass-edit loaderInputsValid guard.
    if (carrierRateGpa.trim() !== '') {
      const c = parseFloat(carrierRateGpa);
      if (Number.isNaN(c) || c < 0) {
        toast('error', 'Carrier rate must be zero or more — fix it on the Loader Worksheet tab (or clear it).');
        return;
      }
    }
    if (tankCapacity.trim() !== '') {
      const cap = parseFloat(tankCapacity);
      if (Number.isNaN(cap) || cap <= 0) {
        toast('error', 'Tank capacity must be greater than zero — fix it on the Loader Worksheet tab (or clear it to use the vehicle).');
        return;
      }
    }

    // B5 license gate pre-check — only when assigning or CHANGING the applicator.
    if (applicatorId && applicatorId !== (savedApplicatorId || '')) {
      const st = getLicenseStatus(licensesByProfile[applicatorId] || []);
      if (st.status === 'expired') {
        if (profile?.role === 'admin') {
          setShowLicenseOverrideConfirm(true);
        } else {
          toast('error', "This applicator's license has expired — an admin can override if needed.");
        }
        return;
      }
    }

    await performSave(false);
  };

  /** Assign the applicator via the override RPC (admin-only path, B5). */
  const assignWithOverride = async (jobId: string) => {
    assignIdem.resetKey();
    const { data, error } = await supabase.rpc('assign_job_applicator', {
      p_job_id: jobId,
      p_applicator_id: applicatorId,
      p_license_override: true,
      p_performed_by: profile!.id,
      p_idempotency_key: assignIdem.getKey(),
    });
    if (error) throw error;
    assertRpcResult(data, 'assign_job_applicator');
    assignIdem.resetKey();
  };

  const performSave = async (licenseOverride: boolean) => {
    setSaving(true);
    try {
      const payload = {
        customer_id: customerId,
        job_date: jobDate,
        scheduled_time: scheduledTime || null,
        applicator_id: overrideSaveApplicatorId({ licenseOverride, isNew, applicatorId, savedApplicatorId }),
        vehicle_id: vehicleId || null,
        recipe_id: recipeId || null,
        notes: notes || null,
        batch_id: batchId || null,
        total_acres: totalAcres,
        total_cost_cents: totalCostCents,
        total_price_cents: totalPriceCents,
        // Field-app parity #1: scheduling + memo fields.
        call_date: callDate || null,
        date_proposed: dateProposed || null,
        time_proposed: timeProposed || null,
        schedule_date: scheduleDate || null,
        date_expires: dateExpires || null,
        consultant_id: consultantId || null,
        loader_comment: loaderComment || null,
        additional_info: additionalInfo || null,
        internal_memo: internalMemo || null,
        // Per-field customer shares (only fields that have explicit shares).
        field_shares: shareRows
          .filter((s) => s.field_id && s.customer_id && (parseFloat(s.split_pct) || 0) > 0)
          .map((s) => ({
            field_id: s.field_id,
            customer_id: s.customer_id,
            split_pct: parseFloat(s.split_pct),
            is_primary: s.is_primary,
          })),
      };

      const fieldsPayload = fieldRows.map((f, i) => ({
        field_id: f.field_id,
        acres_to_treat: parseFloat(f.acres_to_treat) || 0,
        planted_acres: f.planted_acres || null,
        crop: f.crop || null,
        strip: f.strip || null,
        pests: f.pests || null,
        sort_order: i,
      }));

      const chemsPayload = chemRows.map((c, i) => ({
        product_id: c.product_id,
        quantity: parseFloat(c.quantity) || 0,
        unit: c.unit || null,
        rate_per_acre: parseFloat(c.rate_per_acre) || null,
        rate_unit: c.rate_unit || null,
        cost_per_unit_cents: parseInt(c.cost_per_unit_cents) || 0,
        price_per_unit_cents: parseInt(c.price_per_unit_cents) || 0,
        diluent_rate: c.diluent_rate || null,
        rei_hours: c.rei_hours || null,
        phi_days: c.phi_days || null,
        warehouse: c.warehouse || null,
        vendor: c.vendor || null,
        sort_order: i,
      }));

      const idemKey = saveJobIdem.getKey();
      const { data, error } = await supabase.rpc('save_job', {
        p_job_id: (isNew ? null : id) as string,
        p_job_payload: payload,
        p_fields: fieldsPayload,
        p_chemicals: chemsPayload,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;
      saveJobIdem.resetKey();
      const result = assertRpcResult<SaveJobResult>(data, 'save_job');

      // Field-app parity #6 + #10: persist the ground crew AND the loader-worksheet
      // inputs (carrier rate + per-job tank-capacity override) via a direct
      // .update(). save_job's contract is frozen (6 args, one overload) and never
      // touches these columns, so this dedicated write is safe — it won't be
      // clobbered on the next save. RLS gates it to admin/sales_rep. Blank numeric
      // inputs persist as NULL (the worksheet then shows its "enter …" guard state).
      {
        const savedJobId = isNew ? result.job_id : id!;
        const parsedCarrier = parseFloat(carrierRateGpa);
        const parsedCapacity = parseFloat(tankCapacity);
        // handleSave already BLOCKS an out-of-range value before we get here, so
        // these only ever see a blank or a CHECK-valid number. This final guard
        // (NULL unless carrier_rate_gpa >= 0 / loader_tank_capacity > 0) is a
        // defense-in-depth backstop: this direct .update() runs AFTER save_job has
        // committed, so it must never send a value the CHECK would reject.
        const carrierVal = carrierRateGpa.trim() !== '' && !Number.isNaN(parsedCarrier) && parsedCarrier >= 0 ? parsedCarrier : null;
        const capacityVal = tankCapacity.trim() !== '' && !Number.isNaN(parsedCapacity) && parsedCapacity > 0 ? parsedCapacity : null;
        const crewResult = await supabase
          .from('jobs')
          .update({
            ground_crew_id: groundCrewId || null,
            carrier_rate_gpa: carrierVal,
            loader_tank_capacity: capacityVal,
          })
          .eq('id', savedJobId)
          .select('id');
        checkMutationResult(crewResult, 'Assign ground crew / loader worksheet');
      }

      if (shouldReassignApplicatorAfterSave({ licenseOverride, applicatorId, savedApplicatorId })) {
        try {
          await assignWithOverride(isNew ? result.job_id : id!);
        } catch (assignErr) {
          Sentry.captureException(assignErr instanceof Error ? assignErr : new Error(String(assignErr)), { extra: { context: 'assign_job_applicator_after_save' } });
          toast('error', isNew
            ? 'Job created, but the override applicator assignment failed — assign the applicator from this page.'
            : 'Job saved, but the override applicator change failed — retry the applicator assignment.');
          setIsDirty(false);
          if (isNew) {
            navigate(`/jobs/${result.job_id}`);
          } else {
            await fetchJob();
          }
          setSaving(false);
          return;
        }
      }

      if (profile) logActivity({ event: isNew ? 'job_created' : 'job_updated', description: isNew ? `Job created for ${customers.find(c => c.id === customerId)?.farm_name}` : `Job ${jobNumber} updated`, performedBy: profile.id });

      toast('success', isNew ? 'Job created' : 'Job saved');
      setIsDirty(false);
      setSavedApplicatorId(applicatorId || null);

      if (isNew) {
        navigate(`/jobs/${result.job_id}`);
      } else {
        await fetchJob();
      }
    } catch (err: unknown) {
      // Race: licenses changed since page load and the DB trigger fired.
      if (hasRpcCode(err, RpcErrorCodes.LICENSE_EXPIRED)) {
        if (profile?.role === 'admin') {
          setShowLicenseOverrideConfirm(true);
        } else {
          toast('error', "This applicator's license has expired — an admin can override if needed.");
        }
      } else if (err instanceof Error && err.message.includes('SHARE_NOT_100')) {
        toast('error', "Each field's customer shares must total 100%.");
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_job' } });
        toast('error', err instanceof Error ? err.message : 'Failed to save job');
      }
    }
    setSaving(false);
  };

  const handleStart = async () => {
    if (!profile || !id) return;
    setStarting(true);
    try {
      const idemKey = startJobIdem.getKey();
      const { data, error } = await supabase.rpc('start_job', {
        p_job_id: id,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      assertRpcResult(data, 'start_job');
      startJobIdem.resetKey();
      logActivity({ event: 'job_started', description: `Job ${jobNumber} started`, performedBy: profile.id });
      toast('success', 'Job started');
      await fetchJob();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'start_job' } });
      toast('error', err instanceof Error ? err.message : 'Failed to start job');
    }
    setStarting(false);
  };

  const handleComplete = async () => {
    setCompleting(true);
    try {
      const idemKey = completeJobIdem.getKey();
      const { data, error } = await supabase.rpc('complete_job', {
        p_job_id: id!,
        p_applied_info: appliedInfo,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      completeJobIdem.resetKey();
      const result = assertRpcResult<CompleteJobResult>(data, 'complete_job');
      if (profile) logActivity({ event: 'job_completed', description: `Job ${jobNumber} completed → App Record ${result.record_number}`, performedBy: profile.id });
      toast('success', `Job completed! Application record ${result.record_number} created.`);
      setShowCompleteModal(false);
      setIsDirty(false);
      await fetchJob();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'complete_job' } });
      toast('error', err instanceof Error ? err.message : 'Failed to complete job');
    }
    setCompleting(false);
  };

  const handleCancelJob = async () => {
    if (status !== 'scheduled' && status !== 'in_progress') {
      toast('error', `Cannot cancel a job in '${status}' status — only scheduled or in-progress jobs can be cancelled`);
      return;
    }
    setCancelling(true);
    try {
      const result = await supabase
        .from('jobs')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', id!)
        .select();
      checkMutationResult(result, 'Cancel job');
      if (profile) logActivity({ event: 'job_cancelled', description: `Job ${jobNumber} cancelled`, performedBy: profile.id });
      toast('success', 'Job cancelled');
      setIsDirty(false);
      await fetchJob();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'cancel_job' } });
      toast('error', err instanceof Error ? err.message : 'Failed to cancel job');
    }
    setCancelling(false);
  };

  const handleTransferToInvoice = async () => {
    setTransferring(true);
    try {
      const idemKey = transferJobIdem.getKey();
      const { data, error } = await supabase.rpc('transfer_job_to_invoice', {
        p_job_id: id!,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      transferJobIdem.resetKey();
      const result = assertRpcResult<TransferJobResult>(data, 'transfer_job_to_invoice');
      toast('success', `Invoice ${result.invoice_number} created`);
      setIsDirty(false);
      navigate(`/field-invoices/${result.invoice_id}`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'transfer_job_to_invoice' } });
      toast('error', err instanceof Error ? err.message : 'Failed to transfer to invoice');
    }
    setTransferring(false);
  };

  /**
   * Load a recipe's products into the in-memory chem rows (client-side).
   *
   * Unlike the old load_recipe_into_job RPC (which DELETEd all job_chemicals
   * server-side and required a saved job), this maps the recipe items into the
   * editable grid and lets the user choose REPLACE or ADD. It never touches
   * unrelated job data, keeps every line editable, and works on a brand-new
   * unsaved job — the lines persist on the next Save like any other edit. The
   * recipe id is remembered as the per-browser "last used recipe" shortcut.
   */
  const loadRecipeById = async (recipeId: string, mode: 'replace' | 'append') => {
    if (!recipeId) return;
    setLoadingRecipe(true);
    try {
      const { data, error } = await supabase
        .from('blend_recipe_items')
        .select('*')
        .eq('recipe_id', recipeId)
        .order('sort_order');
      if (error) throw error;
      const items = (data || []) as BlendRecipeItem[];
      if (items.length === 0) {
        toast('error', 'That recipe has no products.');
        setLoadingRecipe(false);
        return;
      }

      const cust = customers.find((c) => c.id === customerId);
      const tier = (cust?.assigned_tier ?? 1) as 1 | 2 | 3;
      const acres = sumAcres(fieldRows);
      const seeds: ChemRow[] = items.map((item, idx) => {
        const product = allProducts.find((p) => p.id === item.product_id);
        const seed = recipeItemToChemRowSeed(item, product, tier);
        // With fields on the job, re-derive quantity = rate × acres so the loaded
        // line reflects THIS job's acreage. With NO fields yet (acres === 0),
        // keep the recipe's saved quantity instead of zeroing it — it re-derives
        // automatically once fields are added (recomputeChemQtyFromAcres).
        const row = acres > 0
          ? recomputeChemRowForAcres({ ...seed, sort_order: idx }, acres)
          : { ...seed, sort_order: idx };
        return row as ChemRow;
      });

      setChemRows((prev) => {
        const base = mode === 'append' ? prev : [];
        const merged = [...base, ...seeds];
        return merged.map((c, i) => ({ ...c, sort_order: i }));
      });
      setRecipeId(recipeId);
      // Remember as the last-used recipe (per-browser shortcut).
      setLastRecipeId(recipeId);
      setLastRecipeIdState(recipeId);

      const verb = mode === 'append' ? 'Added' : 'Loaded';
      toast('success', `${verb} ${items.length} product${items.length === 1 ? '' : 's'} from recipe — review and Save.`);
      setShowRecipeModal(false);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'load_recipe_into_job' } });
      toast('error', err instanceof Error ? err.message : 'Failed to load recipe');
    }
    setLoadingRecipe(false);
  };

  const handleLoadRecipe = () => loadRecipeById(selectedRecipeId, recipeMode);

  /** One-click "use last used recipe" — loads the per-browser last recipe (replace). */
  const handleUseLastRecipe = () => {
    if (!lastRecipeId) return;
    if (!recipes.some((r) => r.id === lastRecipeId)) {
      toast('error', 'Your last recipe is no longer available.');
      return;
    }
    loadRecipeById(lastRecipeId, 'replace');
  };

  /** Save the current chemical lines as a NEW blend recipe via save_blend_recipe. */
  const handleSaveAsRecipe = async () => {
    if (!profile) return;
    if (!newRecipeName.trim()) { toast('error', 'Recipe name is required'); return; }
    const items = chemRowsToRecipeItems(chemRows);
    if (items.length === 0) { toast('error', 'Add at least one chemical with a product first.'); return; }
    setSavingRecipe(true);
    try {
      const idemKey = saveRecipeIdem.getKey();
      const { data, error } = await supabase.rpc('save_blend_recipe', {
        p_recipe_id: null as unknown as string,
        p_name: newRecipeName.trim(),
        p_recipe_type: 'generic',
        p_items: items as unknown as Json,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ recipe_id: string; created: boolean }>(data, 'save_blend_recipe');
      saveRecipeIdem.resetKey();
      logActivity({ event: 'recipe_created', description: `Recipe "${newRecipeName.trim()}" saved from job ${jobNumber}`, performedBy: profile.id });
      toast('success', `Recipe "${newRecipeName.trim()}" saved`);
      // Refresh the picker so the new recipe is selectable, and mark it last-used.
      await loadLookups();
      setSelectedRecipeId(result.recipe_id);
      setRecipeId(result.recipe_id);
      setLastRecipeId(result.recipe_id);
      setLastRecipeIdState(result.recipe_id);
      setShowSaveRecipeModal(false);
      setNewRecipeName('');
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_blend_recipe' } });
      toast('error', err instanceof Error ? err.message : 'Failed to save recipe');
    }
    setSavingRecipe(false);
  };

  // ── Field row handlers ──────────────────────────────────────────────────
  const recomputeChemQtyFromAcres = (rows: FieldRow[]) => {
    const acres = sumAcres(rows);
    setChemRows(prev => prev.map(c => recomputeChemRowForAcres(c, acres)));
  };

  /** Default a field's customer shares from field_billing_defaults (the canonical
   *  per-field owner shares); fall back to the field owner at 100%. */
  const seedSharesForField = async (fieldId: string) => {
    if (!fieldId) return;
    // Don't clobber shares already set for this field.
    if (shareRows.some((s) => s.field_id === fieldId)) return;
    const { data } = await supabase
      .from('field_billing_defaults')
      .select('customer_id, split_pct, is_primary')
      .eq('field_id', fieldId);
    let seeded: ShareRow[];
    if (data && data.length > 0) {
      seeded = (data as { customer_id: string; split_pct: number; is_primary: boolean }[]).map((d) => ({
        field_id: fieldId,
        customer_id: d.customer_id,
        split_pct: d.split_pct.toString(),
        is_primary: d.is_primary,
      }));
    } else {
      // Fall back to the field's owner at 100%.
      const fld = allFields.find((f) => f.id === fieldId);
      const ownerId = fld?.customer_id || customerId;
      seeded = ownerId ? [{ field_id: fieldId, customer_id: ownerId, split_pct: '100', is_primary: true }] : [];
    }
    if (seeded.length > 0) setShareRows((prev) => [...prev, ...seeded]);
  };

  const addFieldRow = () => {
    setFieldRows([...fieldRows, { field_id: '', field_name: '', acres_to_treat: '', planted_acres: '', crop: '', strip: '', pests: '', sort_order: fieldRows.length }]);
  };
  const removeFieldRow = (i: number) => {
    const removed = fieldRows[i];
    const updated = fieldRows.filter((_, idx) => idx !== i);
    setFieldRows(updated);
    if (removed?.field_id) setShareRows((prev) => prev.filter((s) => s.field_id !== removed.field_id));
    recomputeChemQtyFromAcres(updated);
  };
  const updateFieldRow = (i: number, key: keyof FieldRow, value: string) => {
    const updated = [...fieldRows];
    const prevFieldId = updated[i].field_id;
    updated[i] = { ...updated[i], [key]: value };
    if (key === 'field_id') {
      const f = allFields.find(af => af.id === value);
      updated[i].field_name = f?.field_name || '';
      if (f && f.total_acres && !updated[i].acres_to_treat) {
        updated[i].acres_to_treat = f.total_acres.toString();
      }
      if (f && f.crop_type && !updated[i].crop) {
        updated[i].crop = f.crop_type;
      }
      // Re-seed shares for the newly chosen field; drop the old field's shares.
      if (prevFieldId) setShareRows((prev) => prev.filter((s) => s.field_id !== prevFieldId));
      if (value) seedSharesForField(value);
    }
    setFieldRows(updated);
    if (key === 'acres_to_treat' || key === 'field_id') {
      recomputeChemQtyFromAcres(updated);
    }
  };

  // ── Field route-ordering (field-app parity #5) ──────────────────────────
  // The field order IS the applicator's drive/route order. Reordering only
  // changes the in-memory array order; on Save, fieldsPayload maps each row to
  // sort_order = array index, so the new route order persists via the normal
  // save path. Acreage totals and chemical quantities are order-independent, so
  // a reorder needs no recompute.
  const reorderFieldRows = (from: number, to: number) => {
    if (!canEdit || from === to) return;
    setFieldRows((prev) => moveItem(prev, from, to));
  };
  const moveFieldUp = (i: number) => {
    if (!canEdit || i <= 0) return;
    setFieldRows((prev) => moveUp(prev, i));
  };
  const moveFieldDown = (i: number) => {
    if (!canEdit) return;
    setFieldRows((prev) => (i >= prev.length - 1 ? prev : moveDown(prev, i)));
  };
  const handleFieldDragStart = (i: number) => {
    if (!canEdit) return;
    setDragFieldIndex(i);
  };
  const handleFieldDragOver = (e: React.DragEvent, i: number) => {
    if (!canEdit || dragFieldIndex === null || dragFieldIndex === i) return;
    e.preventDefault(); // allow drop
  };
  const handleFieldDrop = (i: number) => {
    if (!canEdit || dragFieldIndex === null) return;
    reorderFieldRows(dragFieldIndex, i);
    setDragFieldIndex(null);
  };
  const handleFieldDragEnd = () => setDragFieldIndex(null);

  // ── Per-field customer share handlers ───────────────────────────────────
  const addShareRow = (fieldId: string) => {
    setShareRows([...shareRows, { field_id: fieldId, customer_id: '', split_pct: '', is_primary: false }]);
  };
  const removeShareRow = (idx: number) => setShareRows(shareRows.filter((_, i) => i !== idx));
  const updateShareRow = (idx: number, key: keyof ShareRow, value: string | boolean) => {
    const updated = [...shareRows];
    updated[idx] = { ...updated[idx], [key]: value } as ShareRow;
    setShareRows(updated);
  };

  // ── Chem row handlers ───────────────────────────────────────────────────
  const addChemRow = () => {
    setChemRows([...chemRows, {
      product_id: '', product_name: '', quantity: '0', unit: '', rate_per_acre: '', rate_unit: '',
      cost_per_unit_cents: '0', price_per_unit_cents: '0',
      diluent_rate: '', rei_hours: '', phi_days: '', warehouse: '', vendor: '',
      sort_order: chemRows.length,
    }]);
  };
  const removeChemRow = (i: number) => setChemRows(chemRows.filter((_, idx) => idx !== i));
  const updateChemRow = (i: number, key: keyof ChemRow, value: string) => {
    const updated = [...chemRows];
    updated[i] = { ...updated[i], [key]: value };
    if (key === 'product_id') {
      const p = allProducts.find(ap => ap.id === value);
      updated[i].product_name = p?.product_name || '';
      if (p) {
        // Auto-fill from the product (criterion #8/#9): warehouse has no product
        // source so it stays whatever the user enters.
        updated[i].unit = p.unit_size || '';
        updated[i].cost_per_unit_cents = Math.round((p.current_cost || 0) * 100).toString();
        updated[i].vendor = p.vendor || '';
        updated[i].rei_hours = p.rei_hours != null ? p.rei_hours.toString() : '';
        updated[i].phi_days = p.phi_days != null ? p.phi_days.toString() : '';
        if (p.rate_per_acre != null && !updated[i].rate_per_acre) {
          updated[i].rate_per_acre = p.rate_per_acre.toString();
          updated[i].driver = 'rate';
        }
        if (p.rate_unit && !updated[i].rate_unit) updated[i].rate_unit = p.rate_unit;
        // Default the per-acre price from the customer's tier (chemical preview).
        const cust = customers.find((c) => c.id === customerId);
        const tier = cust?.assigned_tier ?? 1;
        const tierPrice = tier === 3 ? p.tier3_price : tier === 2 ? p.tier2_price : p.tier1_price;
        if (tierPrice != null) updated[i].price_per_unit_cents = Math.round(tierPrice * 100).toString();
        // Re-derive the quantity now that a rate auto-filled.
        updated[i] = recomputeChemRowForAcres(updated[i], sumAcres(fieldRows));
      }
    }
    // 3-way calculator (rate ⇄ quantity via total acres).
    updated[i] = applyChemEdit(updated[i], key, value, sumAcres(fieldRows));
    setChemRows(updated);
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-gray-100 rounded w-48 animate-pulse" />
        <div className="h-64 bg-gray-100 rounded animate-pulse" />
      </div>
    );
  }

  const canEdit = isEditable && (isNew || status === 'scheduled' || status === 'in_progress');
  const canComplete = !isNew && status === 'in_progress';
  const canTransfer = !isNew && status === 'completed';

  // Selectable customers for a share row = the field owner + any customer (cross-bill).
  const shareInputCls = 'w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50';

  return (
    <div className="space-y-6">
      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />

      {/* Header */}
      <Breadcrumbs items={[
        { label: 'Jobs', href: '/jobs' },
        { label: isNew ? 'New Job' : (jobNumber || 'Job') },
      ]} />
      {quoteLinkage && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg text-sm">
          <FileText className="w-4 h-4 text-blue-500 shrink-0" />
          <span className="text-blue-800">Created from Quote{' '}
            <button onClick={() => navigate(`/quotes/${quoteLinkage.quote_id}`)} className="font-semibold underline hover:text-blue-600">{quoteLinkage.quote_number}</button>
            {quoteLinkage.section_name && <> &mdash; {quoteLinkage.section_name}</>}
          </span>
        </div>
      )}
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-nav-dark">
            {isNew ? (jobNumber ? `New Job — ${jobNumber}` : 'New Job') : jobNumber}
          </h1>
          {isNew && jobNumber && (
            <p className="text-xs text-secondary mt-0.5">Next job number (assigned on save)</p>
          )}
          {!isNew && (
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant={statusVariant[status]}>{status.replace('_', ' ')}</Badge>
              <span className="text-sm text-secondary">{parseLocalDate(jobDate).toLocaleDateString()}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isNew && fieldRows.some((f) => f.field_id) && chemRows.some((c) => c.product_id) && (
            <>
              <Button variant="secondary" onClick={() => setSheetPickerOpen(true)} loading={generatingSheet !== null}>
                <ClipboardList className="w-4 h-4" />
                Field Sheet
              </Button>
              <Button variant="secondary" onClick={handleChemicalReport} loading={generatingChemReport}>
                <FlaskConical className="w-4 h-4" />
                Chem Report
              </Button>
              <Button variant="secondary" onClick={handleLoaderWorksheet} loading={printingLoader}>
                <Truck className="w-4 h-4" />
                Loader
              </Button>
              <Button variant="secondary" onClick={handleWpsNotice} loading={printingWps}>
                <Printer className="w-4 h-4" />
                WPS Notice
              </Button>
            </>
          )}
          {!isNew && (status === 'scheduled' || status === 'in_progress') && (
            <Button variant="danger" onClick={() => setShowCancelConfirm(true)} loading={cancelling}>
              <Ban className="w-4 h-4" />
              Cancel Job
            </Button>
          )}
          {!isNew && status === 'scheduled' && isEditable && (
            <Button variant="secondary" onClick={handleStart} loading={starting} disabled={starting}>
              <Check className="w-4 h-4" />
              Start Job
            </Button>
          )}
          {canComplete && (
            <Button variant="secondary" onClick={() => { completeJobIdem.resetKey(); setShowCompleteModal(true); }}>
              <Check className="w-4 h-4" />
              Complete Job
            </Button>
          )}
          {canTransfer && (
            <Button variant="secondary" onClick={() => setShowTransferConfirm(true)} loading={transferring}>
              <FileText className="w-4 h-4" />
              Transfer to Invoice
            </Button>
          )}
          {!isNew && (
            <Button
              variant="secondary"
              icon={<MessageSquarePlus className="w-4 h-4" />}
              showChevron={false}
              onClick={() => setQuickTaskOpen(true)}
            >
              Create Task
            </Button>
          )}
          {canEdit && (
            <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
              {isNew ? `Save Job ${jobNumber || ''}`.trim() : 'Save Changes'}
            </Button>
          )}
        </div>
      </div>

      {/* Job Header */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Customer *</label>
            <select
              value={customerId}
              onChange={(e) => { setCustomerId(e.target.value); setFieldRows([]); setShareRows([]); }}
              disabled={!canEdit}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
            >
              <option value="">Select customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.farm_name}</option>
              ))}
            </select>
          </div>
          <Input
            label="Job Date *"
            type="date"
            value={jobDate}
            onChange={(e) => setJobDate(e.target.value)}
            disabled={!canEdit}
          />
          <Input
            label="Scheduled Time"
            type="time"
            value={scheduledTime}
            onChange={(e) => setScheduledTime(e.target.value)}
            disabled={!canEdit}
          />
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Applicator</label>
            <select
              value={applicatorId}
              onChange={(e) => setApplicatorId(e.target.value)}
              disabled={!canEdit}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
            >
              <option value="">Select applicator...</option>
              {applicators.map((a) => (
                <option key={a.id} value={a.id}>{a.full_name} ({a.role})</option>
              ))}
            </select>
            {applicatorId && (() => {
              const st = getLicenseStatus(licensesByProfile[applicatorId] || []);
              if (st.status === 'valid') return null;
              return (
                <p className={`mt-1 text-xs font-medium ${
                  st.status === 'expired' ? 'text-red-600' : st.status === 'expiring_soon' ? 'text-yellow-600' : 'text-gray-500'
                }`}>
                  {licenseStatusLabel(st)}
                </p>
              );
            })()}
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Vehicle</label>
            <select
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
              disabled={!canEdit}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
            >
              <option value="">Select vehicle...</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>{v.vehicle_name} ({v.vehicle_type})</option>
              ))}
            </select>
          </div>
          <Input
            label="Batch ID"
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
            placeholder="Group related jobs"
            disabled={!canEdit}
          />
        </div>
      </Card>

      {/* Tabs */}
      <div className="border-b">
        <nav className="flex gap-1 px-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'border-crx-green text-crx-green'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.key === 'locations' && fieldRows.length > 0 && (
                <span className="ml-1 text-xs bg-gray-100 rounded-full px-1.5">{fieldRows.length}</span>
              )}
              {tab.key === 'chemicals' && chemRows.length > 0 && (
                <span className="ml-1 text-xs bg-gray-100 rounded-full px-1.5">{chemRows.length}</span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* ─────────────── LOCATIONS TAB ─────────────── */}
      {activeTab === 'locations' && (
        <>
          {/* Scheduling fields */}
          <Card>
            <h2 className="text-lg font-semibold text-nav-dark mb-3">Scheduling</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input label="Call Date" type="date" value={callDate} onChange={(e) => setCallDate(e.target.value)} disabled={!canEdit} />
              <Input label="Date Proposed" type="date" value={dateProposed} onChange={(e) => setDateProposed(e.target.value)} disabled={!canEdit} />
              <Input label="Time Proposed" type="time" value={timeProposed} onChange={(e) => setTimeProposed(e.target.value)} disabled={!canEdit} />
              <Input label="Schedule Date" type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} disabled={!canEdit} />
              <Input label="Date Expires" type="date" value={dateExpires} onChange={(e) => setDateExpires(e.target.value)} disabled={!canEdit} />
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">Consultant</label>
                <select
                  value={consultantId}
                  onChange={(e) => setConsultantId(e.target.value)}
                  disabled={!canEdit}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
                >
                  <option value="">Select consultant...</option>
                  {applicators.map((a) => (
                    <option key={a.id} value={a.id}>{a.full_name} ({a.role})</option>
                  ))}
                </select>
              </div>
              {/* Field-app parity #6: ground crew — a filterable job attribute. */}
              <div>
                <label className="block text-sm font-medium text-nav-dark mb-1">Ground Crew</label>
                <select
                  value={groundCrewId}
                  onChange={(e) => setGroundCrewId(e.target.value)}
                  disabled={!canEdit}
                  aria-label="Ground crew"
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
                >
                  <option value="">No crew</option>
                  {groundCrews.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </Card>

          {/* Fields + per-field agronomy + customer shares */}
          <Card>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-semibold text-nav-dark">Fields ({fieldRows.length})</h2>
              {canEdit && (
                <Button size="sm" variant="secondary" onClick={addFieldRow} disabled={!customerId}>
                  <Plus className="w-4 h-4" /> Add Field
                </Button>
              )}
            </div>
            {fieldRows.length > 1 && (
              <p className="text-xs text-secondary mb-4 flex items-center gap-1">
                <GripVertical className="w-3.5 h-3.5 text-gray-400" />
                Drag the handle (or use the up/down arrows) to set the applicator&rsquo;s drive order. Stop&nbsp;1 is visited first.
              </p>
            )}
            {fieldRows.length <= 1 && <div className="mb-4" />}
            {fieldRows.length === 0 ? (
              <p className="text-sm text-secondary text-center py-4">
                {customerId ? 'No fields added. Click "Add Field" to assign fields.' : 'Select a customer first.'}
              </p>
            ) : (
              <div className="space-y-4">
                {fieldRows.map((f, i) => {
                  const fieldShares = shareRows
                    .map((s, idx) => ({ ...s, idx }))
                    .filter((s) => f.field_id && s.field_id === f.field_id);
                  const shareSum = fieldShares.reduce((sum, s) => sum + (parseFloat(s.split_pct) || 0), 0);
                  const shareOk = fieldShares.length === 0 || Math.abs(shareSum - 100) < 0.01;
                  const isDragging = dragFieldIndex === i;
                  const isDropTarget = dragFieldIndex !== null && dragFieldIndex !== i;
                  return (
                    <div
                      key={i}
                      onDragOver={(e) => handleFieldDragOver(e, i)}
                      onDrop={() => handleFieldDrop(i)}
                      className={`flex gap-2 border rounded-lg p-3 transition-colors ${
                        isDragging ? 'border-crx-green bg-crx-green/5 opacity-60' : 'border-gray-200'
                      } ${isDropTarget ? 'border-dashed border-crx-green/60' : ''}`}
                    >
                      {/* Route-order rail (field-app parity #5): drag handle, stop
                          number, and keyboard/touch up-down fallback. */}
                      <div className="flex flex-col items-center gap-1 pt-5 shrink-0">
                        <span
                          draggable={canEdit && fieldRows.length > 1}
                          onDragStart={() => handleFieldDragStart(i)}
                          onDragEnd={handleFieldDragEnd}
                          className={`${canEdit && fieldRows.length > 1 ? 'cursor-grab active:cursor-grabbing text-gray-400 hover:text-crx-green' : 'text-gray-300'}`}
                          title={canEdit && fieldRows.length > 1 ? 'Drag to set route order' : undefined}
                          aria-hidden="true"
                        >
                          <GripVertical className="w-4 h-4" />
                        </span>
                        <span
                          className="text-xs font-semibold text-secondary tabular-nums"
                          title={`Route stop ${i + 1} of ${fieldRows.length}`}
                        >
                          {i + 1}
                        </span>
                        {canEdit && fieldRows.length > 1 && (
                          <div className="flex flex-col">
                            <button
                              type="button"
                              onClick={() => moveFieldUp(i)}
                              disabled={i === 0}
                              className="text-gray-400 enabled:hover:text-crx-green disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Move earlier in route"
                              aria-label={`Move ${f.field_name || `field ${i + 1}`} earlier in the route`}
                            >
                              <ChevronUp className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveFieldDown(i)}
                              disabled={i === fieldRows.length - 1}
                              className="text-gray-400 enabled:hover:text-crx-green disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Move later in route"
                              aria-label={`Move ${f.field_name || `field ${i + 1}`} later in the route`}
                            >
                              <ChevronDown className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Field content (selection + agronomy + shares) */}
                      <div className="flex-1 min-w-0 space-y-3">
                      {/* Field selection + agronomy grid */}
                      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end">
                        <div className="col-span-2 md:col-span-2">
                          <label className="block text-xs font-medium text-secondary mb-1">Field</label>
                          <select
                            value={f.field_id}
                            onChange={(e) => updateFieldRow(i, 'field_id', e.target.value)}
                            disabled={!canEdit}
                            className={shareInputCls}
                          >
                            <option value="">Select field...</option>
                            {customerFields.map((cf) => (
                              <option key={cf.id} value={cf.id}>{cf.field_name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">Acres</label>
                          <input type="number" value={f.acres_to_treat} onChange={(e) => updateFieldRow(i, 'acres_to_treat', e.target.value)}
                            disabled={!canEdit} min={0} className={shareInputCls} />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">Planted ac</label>
                          <input type="number" value={f.planted_acres} onChange={(e) => updateFieldRow(i, 'planted_acres', e.target.value)}
                            disabled={!canEdit} min={0} className={shareInputCls} />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">Crop</label>
                          <input type="text" value={f.crop} onChange={(e) => updateFieldRow(i, 'crop', e.target.value)}
                            disabled={!canEdit} className={shareInputCls} />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-secondary mb-1">Strip</label>
                          <input type="text" value={f.strip} onChange={(e) => updateFieldRow(i, 'strip', e.target.value)}
                            disabled={!canEdit} placeholder="N/Y" className={shareInputCls} />
                        </div>
                        <div className="flex items-end gap-1">
                          <div className="flex-1">
                            <label className="block text-xs font-medium text-secondary mb-1">Pests</label>
                            <input type="text" value={f.pests} onChange={(e) => updateFieldRow(i, 'pests', e.target.value)}
                              disabled={!canEdit} className={shareInputCls} />
                          </div>
                          {canEdit && (
                            <button onClick={() => removeFieldRow(i)} className="text-red-500 hover:text-red-700 p-1.5" title="Remove field">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Per-field customer shares */}
                      {f.field_id && (
                        <div className="bg-gray-50 rounded-lg p-2.5">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-semibold text-nav-dark">Customer Shares</span>
                            <span className={`text-xs font-medium ${shareOk ? 'text-secondary' : 'text-red-600'}`}>
                              Total: {shareSum.toFixed(1)}%{!shareOk && ' — must equal 100%'}
                            </span>
                          </div>
                          <div className="space-y-1.5">
                            {fieldShares.map((s) => (
                              <div key={s.idx} className="flex items-center gap-2">
                                <select
                                  value={s.customer_id}
                                  onChange={(e) => updateShareRow(s.idx, 'customer_id', e.target.value)}
                                  disabled={!canEdit}
                                  className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded disabled:bg-gray-50"
                                >
                                  <option value="">Select customer...</option>
                                  {customers.map((c) => (
                                    <option key={c.id} value={c.id}>{c.farm_name}</option>
                                  ))}
                                </select>
                                <input
                                  type="number" min={0} max={100} step="0.01"
                                  value={s.split_pct}
                                  onChange={(e) => updateShareRow(s.idx, 'split_pct', e.target.value)}
                                  disabled={!canEdit} placeholder="%"
                                  className="w-20 px-2 py-1 text-sm border border-gray-200 rounded text-right disabled:bg-gray-50"
                                />
                                <label className="flex items-center gap-1 text-xs text-secondary whitespace-nowrap">
                                  <input type="checkbox" checked={s.is_primary} disabled={!canEdit}
                                    onChange={(e) => updateShareRow(s.idx, 'is_primary', e.target.checked)} />
                                  Primary
                                </label>
                                {canEdit && (
                                  <button onClick={() => removeShareRow(s.idx)} className="text-red-500 hover:text-red-700 p-1" title="Remove share">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                          {canEdit && (
                            <button onClick={() => addShareRow(f.field_id)} className="mt-1.5 text-xs font-medium text-crx-green hover:underline inline-flex items-center gap-0.5">
                              <Plus className="w-3 h-3" /> Add customer share
                            </button>
                          )}
                        </div>
                      )}
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-secondary text-right">Total: {totalAcres.toLocaleString()} acres</p>
              </div>
            )}
          </Card>
        </>
      )}

      {/* ─────────────── CHEMICALS / CHARGES TAB ─────────────── */}
      {activeTab === 'chemicals' && (
        <Card>
          <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
            <h2 className="text-lg font-semibold text-nav-dark">Chemicals / Charges ({chemRows.length})</h2>
            <div className="flex gap-2 flex-wrap">
              {canEdit && (
                <Button size="sm" variant="secondary" onClick={() => { setSelectedRecipeId(''); setRecipeMode('replace'); setShowRecipeModal(true); }}>
                  <Beaker className="w-4 h-4" /> Select Recipe
                </Button>
              )}
              {canEdit && lastRecipeId && recipes.some((r) => r.id === lastRecipeId) && (
                <Button size="sm" variant="secondary" onClick={handleUseLastRecipe} loading={loadingRecipe}
                  title={`Load "${recipes.find((r) => r.id === lastRecipeId)?.name || 'last recipe'}" (replaces current chemicals)`}>
                  <History className="w-4 h-4" /> Use Last Recipe
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="secondary"
                  disabled={chemRowsToRecipeItems(chemRows).length === 0}
                  onClick={() => { saveRecipeIdem.resetKey(); setNewRecipeName(''); setShowSaveRecipeModal(true); }}
                  title="Save the current chemical lines as a reusable recipe">
                  <BookmarkPlus className="w-4 h-4" /> Save as Recipe
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="secondary" onClick={addChemRow}>
                  <Plus className="w-4 h-4" /> Add Chemical
                </Button>
              )}
            </div>
          </div>
          {chemRows.length === 0 ? (
            <p className="text-sm text-secondary text-center py-4">No chemicals added.</p>
          ) : (
            <div className="space-y-3">
              {chemRows.map((c, i) => {
                const totalApplied = parseFloat(c.quantity) || 0;
                const conv = toGallonOrLbEquivalent(totalApplied, c.unit);
                return (
                  <div key={i} className="border border-gray-200 rounded-lg p-3 space-y-2">
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-12 md:col-span-3">
                        <label className="block text-xs font-medium text-secondary mb-1">Chemical</label>
                        <select value={c.product_id} onChange={(e) => updateChemRow(i, 'product_id', e.target.value)}
                          disabled={!canEdit} className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50">
                          <option value="">Select product...</option>
                          {allProducts.map((p) => (<option key={p.id} value={p.id}>{p.product_name}</option>))}
                        </select>
                      </div>
                      <div className="col-span-6 md:col-span-2">
                        <label className="block text-xs font-medium text-secondary mb-1">Warehouse</label>
                        <input type="text" value={c.warehouse} onChange={(e) => updateChemRow(i, 'warehouse', e.target.value)}
                          disabled={!canEdit} placeholder="Warehouse" className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-6 md:col-span-2">
                        <label className="block text-xs font-medium text-secondary mb-1">Vendor</label>
                        <input type="text" value={c.vendor} onChange={(e) => updateChemRow(i, 'vendor', e.target.value)}
                          disabled={!canEdit} placeholder="Vendor" className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-4 md:col-span-2">
                        <label className="block text-xs font-medium text-secondary mb-1">Rate/ac</label>
                        <input type="number" value={c.rate_per_acre} onChange={(e) => updateChemRow(i, 'rate_per_acre', e.target.value)}
                          disabled={!canEdit} step="0.01" className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-4 md:col-span-2">
                        {/* The per-acre RATE unit (e.g. pt/ac) — this is what the job
                            list summary and the WPS notice read from rate_unit. */}
                        <label className="block text-xs font-medium text-secondary mb-1">Rate Unit</label>
                        <input type="text" value={c.rate_unit} onChange={(e) => updateChemRow(i, 'rate_unit', e.target.value)}
                          disabled={!canEdit} placeholder="pt/ac" className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-4 md:col-span-1 flex items-end">
                        {canEdit && (
                          <button onClick={() => removeChemRow(i)} className="text-red-500 hover:text-red-700 p-1.5" title="Remove chemical">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-6 md:col-span-2">
                        <label className="block text-xs font-medium text-secondary mb-1">Total Applied</label>
                        <input type="number" value={c.quantity} onChange={(e) => updateChemRow(i, 'quantity', e.target.value)}
                          disabled={!canEdit} step="0.01" min="0" className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-6 md:col-span-1">
                        {/* Measure unit of the total applied (e.g. GAL / LB) — drives the
                            gallon/lb conversion and the loader-worksheet total. */}
                        <label className="block text-xs font-medium text-secondary mb-1">Unit</label>
                        <input type="text" value={c.unit} onChange={(e) => updateChemRow(i, 'unit', e.target.value)}
                          disabled={!canEdit} placeholder="gal/lb" className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-6 md:col-span-1">
                        <label className="block text-xs font-medium text-secondary mb-1">Equiv.</label>
                        <div className="px-2 py-1.5 text-sm bg-gray-50 border border-gray-100 rounded-lg text-secondary">
                          {conv ? `${conv.value.toLocaleString()} ${conv.unit}` : '—'}
                        </div>
                      </div>
                      <div className="col-span-6 md:col-span-2">
                        <label className="block text-xs font-medium text-secondary mb-1">Diluent Rate</label>
                        <input type="number" value={c.diluent_rate} onChange={(e) => updateChemRow(i, 'diluent_rate', e.target.value)}
                          disabled={!canEdit} step="0.01" className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-6 md:col-span-2">
                        <label className="block text-xs font-medium text-secondary mb-1">REI (hrs)</label>
                        <input type="number" value={c.rei_hours} onChange={(e) => updateChemRow(i, 'rei_hours', e.target.value)}
                          disabled={!canEdit} className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-6 md:col-span-2">
                        <label className="block text-xs font-medium text-secondary mb-1">PHI (days)</label>
                        <input type="number" value={c.phi_days} onChange={(e) => updateChemRow(i, 'phi_days', e.target.value)}
                          disabled={!canEdit} className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-6 md:col-span-2">
                        {/* Cost stays editable — current_cost can be stale/0; total_cost_cents
                            persists from this value (Codex P2). */}
                        <label className="block text-xs font-medium text-secondary mb-1">Cost ¢/unit</label>
                        <input type="number" value={c.cost_per_unit_cents} onChange={(e) => updateChemRow(i, 'cost_per_unit_cents', e.target.value)}
                          disabled={!canEdit} step="1" className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                      <div className="col-span-6 md:col-span-2">
                        <label className="block text-xs font-medium text-secondary mb-1">Price ¢/unit</label>
                        <input type="number" value={c.price_per_unit_cents} onChange={(e) => updateChemRow(i, 'price_per_unit_cents', e.target.value)}
                          disabled={!canEdit} step="1" className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50" />
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="flex justify-between text-sm text-secondary pt-2">
                <span>Total Cost: ${(totalCostCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                <span>Total Price: ${(totalPriceCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* ─────────────── LOADER WORKSHEET TAB ─────────────── */}
      {activeTab === 'loader' && (
        <Card>
          <h2 className="text-lg font-semibold text-nav-dark mb-3">Loader Worksheet</h2>

          {/* Inputs: carrier rate (gal/acre) drives spray volume; tank capacity is
              the per-job override (blank = use the assigned vehicle's capacity). */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">Carrier Rate (gal/acre)</label>
              <input
                type="number"
                value={carrierRateGpa}
                onChange={(e) => setCarrierRateGpa(e.target.value)}
                disabled={!canEdit}
                step="0.1"
                min="0"
                placeholder="e.g. 15"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
              />
              <p className="mt-1 text-xs text-secondary">Spray volume = total acres × carrier rate.</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">Tank Capacity (gal)</label>
              <input
                type="number"
                value={tankCapacity}
                onChange={(e) => setTankCapacity(e.target.value)}
                disabled={!canEdit}
                step="1"
                min="0"
                placeholder={assignedVehicleCapacity ? `Vehicle: ${assignedVehicleCapacity}` : 'Enter capacity'}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
              />
              <p className="mt-1 text-xs text-secondary">
                {tankCapacity.trim() !== ''
                  ? 'Per-job override.'
                  : assignedVehicleCapacity
                    ? `Using the ${savedVehicleName || 'vehicle'} capacity (${assignedVehicleCapacity} ${assignedVehicleCapacityUnit || 'gal'}).`
                    : 'No vehicle capacity — enter one to plan loads.'}
              </p>
            </div>
          </div>

          {loaderWorksheet.valid ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-2xl font-bold text-nav-dark">{loaderWorksheet.spray_volume.toLocaleString()}</p>
                  <p className="text-xs text-secondary">Spray Volume (gal)</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-2xl font-bold text-nav-dark">{loaderWorksheet.tank_capacity.toLocaleString()}</p>
                  <p className="text-xs text-secondary">Tank Capacity (gal)</p>
                </div>
                <div className="bg-crx-green-tint rounded-lg p-3">
                  <p className="text-2xl font-bold text-crx-green">{loaderWorksheet.loads_count}</p>
                  <p className="text-xs text-secondary">Loads Needed</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-2xl font-bold text-nav-dark">
                    {loaderWorksheet.partial_load_volume > 0 ? `${loaderWorksheet.partial_load_volume.toLocaleString()}` : 'None'}
                  </p>
                  <p className="text-xs text-secondary">Partial Last Load (gal)</p>
                </div>
              </div>

              {/* Per-load mix preview (matches the printed PDF). */}
              {loaderWorksheet.loads[0]?.products.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-left py-2 px-2 font-medium text-secondary">Product</th>
                        {loaderWorksheet.loads.map((l) => (
                          <th key={l.load_number} className="text-right py-2 px-2 font-medium text-secondary whitespace-nowrap">
                            Load {l.load_number}
                            <span className="block text-[10px] font-normal">
                              {l.volume.toLocaleString()} gal{l.is_partial ? ' (partial)' : ''}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {loaderWorksheet.loads[0].products.map((p, pi) => (
                        <tr key={pi} className="border-b border-gray-100">
                          <td className="py-1.5 px-2 text-nav-dark">{p.product_name}{p.unit ? ` (${p.unit})` : ''}</td>
                          {loaderWorksheet.loads.map((l) => (
                            <td key={l.load_number} className="text-right py-1.5 px-2 text-nav-dark">
                              {l.products[pi]?.amount.toLocaleString() ?? '—'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3">
              <p className="text-sm font-medium text-amber-800">Loads cannot be calculated</p>
              <p className="text-xs text-amber-700 mt-0.5">{loaderWorksheet.invalid_reason}</p>
            </div>
          )}

          <div className="mt-4">
            <label className="block text-sm font-medium text-nav-dark mb-1">Loader Comment</label>
            <textarea
              value={loaderComment}
              onChange={(e) => setLoaderComment(e.target.value)}
              rows={2}
              disabled={!canEdit}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none disabled:bg-gray-50"
              placeholder="Instructions for the loader (mix order, etc.)..."
            />
          </div>
        </Card>
      )}

      {/* ─────────────── APPLIED INFO TAB ─────────────── */}
      {activeTab === 'applied' && (
        <div className="space-y-4">
          {/* As-applied entry records (#17): MANY per job — applicator, vehicle,
              date. This is the Phase-2 foundation that #18 (acres), #19
              (weather), #20 (tach), #21 (crew) extend off each record's id.
              Only available once the job is saved (records reference a job_id). */}
          <Card>
            {isNew ? (
              <p className="text-sm text-secondary py-2">
                Save the job first, then add as-applied entries (applicator, vehicle, date).
              </p>
            ) : (
              <AppliedRecordsManager
                jobId={id!}
                applicators={applicators}
                vehicles={vehicles}
                jobVehicleId={vehicleId || null}
                jobFields={fieldRows
                  .filter((f) => f.field_id)
                  .map((f) => ({
                    field_id: f.field_id,
                    field_name: f.field_name,
                    acres: parseFloat(f.acres_to_treat) || 0,
                  }))}
                totalAcres={totalAcres}
                fieldCentroid={jobFieldCentroid}
                canEdit={canEdit}
                performedBy={profile?.id ?? null}
              />
            )}
          </Card>

          {/* Completion weather snapshot (legacy job_applied_info, 1:1) — set by
              Complete Job. Distinct from the per-pass as-applied entries above. */}
          <Card>
            <h2 className="text-lg font-semibold text-nav-dark mb-3">Completion Weather Snapshot</h2>
            {!isNew && (status === 'completed' || status === 'invoiced') ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div><span className="text-xs text-secondary">Wind Speed</span><p className="font-medium">{appliedInfo.wind_speed || '-'} mph</p></div>
                <div><span className="text-xs text-secondary">Wind Direction</span><p className="font-medium">{appliedInfo.wind_direction || '-'}</p></div>
                <div><span className="text-xs text-secondary">Temperature</span><p className="font-medium">{appliedInfo.temperature || '-'}&deg;F</p></div>
                <div><span className="text-xs text-secondary">Humidity</span><p className="font-medium">{appliedInfo.humidity || '-'}%</p></div>
                <div><span className="text-xs text-secondary">Actual Gallons</span><p className="font-medium">{appliedInfo.actual_gallons_applied || '-'}</p></div>
                {appliedInfo.notes && (
                  <div className="col-span-2 md:col-span-3"><span className="text-xs text-secondary">Notes</span><p className="font-medium">{appliedInfo.notes}</p></div>
                )}
              </div>
            ) : (
              <p className="text-sm text-secondary py-2">
                {canComplete
                  ? 'Applied weather + actual data is captured when you Complete the job.'
                  : 'Applied information is recorded once the job is started and completed.'}
              </p>
            )}
          </Card>
        </div>
      )}

      {/* ─────────────── NOTIFICATIONS TAB ─────────────── */}
      {activeTab === 'notifications' && (
        <Card>
          <h2 className="text-lg font-semibold text-nav-dark mb-3">Notifications &amp; Memos</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">Job Notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} disabled={!canEdit}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none disabled:bg-gray-50"
                placeholder="Job notes..." />
            </div>
            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">Additional Info</label>
              <textarea value={additionalInfo} onChange={(e) => setAdditionalInfo(e.target.value)} rows={2} disabled={!canEdit}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none disabled:bg-gray-50"
                placeholder="Gate codes, directions, customer requests..." />
            </div>
            <div>
              <label className="block text-sm font-medium text-nav-dark mb-1">
                Internal Job/Invoice Memo
                <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">Not printed</span>
              </label>
              <textarea value={internalMemo} onChange={(e) => setInternalMemo(e.target.value)} rows={2} disabled={!canEdit}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none disabled:bg-gray-50"
                placeholder="Internal only — never appears on customer-facing documents." />
            </div>
            {!isNew && (
              <p className="text-xs text-secondary">
                Print status: {' '}
                <span className="font-medium">{/* printed_at lives on the row; the list shows it */}Generate the WPS notice to mark this job printed.</span>
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Related Notes */}
      {!isNew && id && (
        <RelatedNotes
          entityType={'job' as LinkedEntityType}
          entityId={id}
          onCreateTask={() => setQuickTaskOpen(true)}
        />
      )}

      {/* Complete Job Modal */}
      <Modal open={showCompleteModal} onClose={() => setShowCompleteModal(false)} title="Complete Job">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Record weather conditions and actual application data. This will create an application record and deduct inventory.
          </p>
          {jobFieldCentroid && (
            <Button variant="ghost" size="sm" onClick={handleFetchWeather} loading={fetchingWeather}>
              <CloudSun className="w-4 h-4" />
              Use current weather at {allFields.find(f => f.id === fieldRows.find(r => r.field_id)?.field_id)?.field_name || 'field'}
            </Button>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Wind Speed (mph)" type="number" value={appliedInfo.wind_speed}
              onChange={(e) => setAppliedInfo({ ...appliedInfo, wind_speed: e.target.value })} />
            <Input label="Wind Direction" value={appliedInfo.wind_direction}
              onChange={(e) => setAppliedInfo({ ...appliedInfo, wind_direction: e.target.value })} placeholder="e.g. NW" />
            <Input label="Temperature (&deg;F)" type="number" value={appliedInfo.temperature}
              onChange={(e) => setAppliedInfo({ ...appliedInfo, temperature: e.target.value })} />
            <Input label="Humidity (%)" type="number" value={appliedInfo.humidity}
              onChange={(e) => setAppliedInfo({ ...appliedInfo, humidity: e.target.value })} />
            <div className="col-span-2">
              <Input label="Actual Gallons Applied" type="number" value={appliedInfo.actual_gallons_applied}
                onChange={(e) => setAppliedInfo({ ...appliedInfo, actual_gallons_applied: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-nav-dark mb-1">Notes</label>
              <textarea value={appliedInfo.notes} onChange={(e) => setAppliedInfo({ ...appliedInfo, notes: e.target.value })}
                rows={2} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg resize-none" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowCompleteModal(false)}>Cancel</Button>
            <Button onClick={() => setShowCompleteConfirm(true)} loading={completing}>
              <Check className="w-4 h-4" /> Complete Job
            </Button>
          </div>
        </div>
      </Modal>

      {/* Load Recipe Modal */}
      <Modal open={showRecipeModal} onClose={() => setShowRecipeModal(false)} title="Select Recipe">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Load a saved tank-mix recipe's products (with rates and units) into this job. The lines stay editable — review them and Save the job to keep them.
          </p>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Recipe</label>
            <select
              value={selectedRecipeId}
              onChange={(e) => setSelectedRecipeId(e.target.value)}
              aria-label="Select recipe"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
            >
              <option value="">Select recipe...</option>
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Load mode</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-sm text-secondary">
                <input type="radio" name="recipeMode" checked={recipeMode === 'replace'}
                  onChange={() => setRecipeMode('replace')} />
                Replace current chemicals
              </label>
              <label className="flex items-center gap-1.5 text-sm text-secondary">
                <input type="radio" name="recipeMode" checked={recipeMode === 'append'}
                  onChange={() => setRecipeMode('append')} />
                Add to current chemicals
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowRecipeModal(false)}>Cancel</Button>
            <Button onClick={handleLoadRecipe} disabled={!selectedRecipeId} loading={loadingRecipe}>
              <Beaker className="w-4 h-4" /> Load Recipe
            </Button>
          </div>
        </div>
      </Modal>

      {/* Save As Recipe Modal */}
      <Modal open={showSaveRecipeModal} onClose={() => setShowSaveRecipeModal(false)} title="Save as Recipe">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Save this job's chemical lines as a reusable recipe. Products, rates, units and prices are stored so you can load them into another job in one click.
          </p>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">New Recipe Name *</label>
            <Input
              type="text"
              value={newRecipeName}
              onChange={(e) => setNewRecipeName(e.target.value)}
              placeholder="e.g., Corn Pre-Emerge Standard"
            />
          </div>
          <p className="text-xs text-secondary">
            {chemRowsToRecipeItems(chemRows).length} product{chemRowsToRecipeItems(chemRows).length === 1 ? '' : 's'} will be saved.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowSaveRecipeModal(false)}>Cancel</Button>
            <Button onClick={handleSaveAsRecipe} disabled={!newRecipeName.trim()} loading={savingRecipe}>
              <BookmarkPlus className="w-4 h-4" /> Save Recipe
            </Button>
          </div>
        </div>
      </Modal>

      {/* #9: Applicator Field Sheet format picker (Original / Custom / Enhanced). */}
      <Modal open={sheetPickerOpen} onClose={() => setSheetPickerOpen(false)} title="Print Applicator Field Sheet">
        <div className="space-y-3">
          <p className="text-sm text-secondary">
            The crew's carry sheet — fields in route order with the tank mix, plus blank spaces to record as-applied acres and start/end weather in the field. Choose a format:
          </p>
          {(['original', 'custom', 'enhanced'] as ApplicatorSheetFormat[]).map((fmt) => (
            <button
              key={fmt}
              type="button"
              onClick={() => handleGenerateSheet(fmt)}
              disabled={generatingSheet !== null}
              className="w-full flex items-start gap-3 rounded-lg border border-gray-200 p-3 text-left hover:border-crx-green hover:bg-green-50 disabled:opacity-50 transition-colors"
            >
              <ClipboardList className="w-5 h-5 text-crx-green mt-0.5 flex-shrink-0" />
              <span>
                <span className="block text-sm font-medium text-charcoal">
                  {SHEET_FORMAT_LABELS[fmt]}{generatingSheet === fmt ? ' …' : ''}
                </span>
                <span className="block text-xs text-secondary mt-0.5">
                  {fmt === 'original' && 'Compact: job #, customers + IDs, fields (acres/crop/pest), chemicals with rate/acre.'}
                  {fmt === 'custom' && 'Same data as Enhanced, with the company header/logo/footer and columns set in Settings.'}
                  {fmt === 'enhanced' && 'Adds total applied + gallon/lb conversion, applicator, vehicle, date, and per-product REI/PHI.'}
                </span>
              </span>
            </button>
          ))}
        </div>
      </Modal>

      {!isNew && id && (
        <QuickTaskModal
          open={quickTaskOpen}
          onClose={() => setQuickTaskOpen(false)}
          entityType={'job' as LinkedEntityType}
          entityId={id}
          prefillTitle={`Issue: Job ${jobNumber || id.slice(0, 8)}`}
          prefillContent={`Customer: ${customers.find(c => c.id === customerId)?.farm_name || 'Unknown'}`}
        />
      )}

      {/* License-override confirm (admin only, B5) */}
      <ConfirmModal
        open={showLicenseOverrideConfirm}
        onClose={() => setShowLicenseOverrideConfirm(false)}
        onConfirm={() => { setShowLicenseOverrideConfirm(false); performSave(true); }}
        title="Applicator License Expired"
        message="This applicator's license has expired. Save the job and assign them anyway? The override is recorded in the activity log."
        confirmLabel="Assign Anyway"
        variant="warning"
        loading={saving}
      />

      <ConfirmModal
        open={showCompleteConfirm}
        onClose={() => setShowCompleteConfirm(false)}
        onConfirm={() => { setShowCompleteConfirm(false); handleComplete(); }}
        title="Complete Job"
        message="Complete this job? This will deduct inventory and create application records."
        confirmLabel="Complete Job"
        variant="warning"
        loading={completing}
      />

      {/* Cancel Job Confirm */}
      <ConfirmModal
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={() => { setShowCancelConfirm(false); handleCancelJob(); }}
        title="Cancel Job"
        message="Cancel this job? This action cannot be undone."
        confirmLabel="Cancel Job"
        variant="danger"
        loading={cancelling}
      />

      {/* Transfer to Invoice Confirm */}
      <ConfirmModal
        open={showTransferConfirm}
        onClose={() => setShowTransferConfirm(false)}
        onConfirm={() => { setShowTransferConfirm(false); handleTransferToInvoice(); }}
        title="Transfer to Invoice"
        message="Transfer this job to an invoice? This will create a new invoice from the job chemicals."
        confirmLabel="Transfer to Invoice"
        variant="warning"
        loading={transferring}
      />
    </div>
  );
}
