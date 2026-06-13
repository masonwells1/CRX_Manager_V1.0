import { useEffect, useRef, useState , useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Save, Plus, Trash2, Check, FileText, Beaker, Ban, MessageSquarePlus, Printer, CloudSun } from 'lucide-react';
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
import { overrideSaveApplicatorId, shouldReassignApplicatorAfterSave, canGenerateWpsNotice } from '../lib/jobSaveHelpers';
import { fetchCurrentWeather, parseCentroid } from '../lib/weatherCapture';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import QuickTaskModal from '../components/team/QuickTaskModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import RelatedNotes from '../components/team/RelatedNotes';
import { Sentry } from '../lib/sentry';
import type { JobStatus, Customer, Product, Field, Vehicle, Profile, BlendRecipe, LinkedEntityType } from '../types';

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
  job_fields?: Array<{
    field_id: string;
    acres_to_treat?: number | null;
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
    sort_order: number;
    product?: { product_name: string } | null;
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
}

interface SaveJobResult { job_id: string }
interface CompleteJobResult { record_number: string }
interface TransferJobResult { invoice_id: string; invoice_number: string }
interface LoadRecipeResult { items_loaded: number }

const statusVariant: Record<JobStatus, BadgeVariant> = {
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'default',
  invoiced: 'success',
};

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
  sort_order: number;
}

interface FieldRow {
  field_id: string;
  field_name: string;
  acres_to_treat: string;
  sort_order: number;
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
  const loadRecipeIdem = useIdempotencyKey('load_recipe_into_job', profile?.id || '');
  const isNew = id === 'new';
  const isEditable = role === 'admin' || role === 'sales_rep';

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

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
  // The applicator currently saved on the job — the license gate only fires on a CHANGE
  const [savedApplicatorId, setSavedApplicatorId] = useState<string | null>(null);
  const [showLicenseOverrideConfirm, setShowLicenseOverrideConfirm] = useState(false);
  const assignIdem = useIdempotencyKey('assign_job_applicator', profile?.id || '');
  // B3: WPS pre-application notice PDF
  const [printingWps, setPrintingWps] = useState(false);
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
            const p = allProducts.find((ap) => ap.id === c.product_id);
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
      if (profile) logActivity({ event: 'wps_notice_printed', description: `WPS pre-application notice generated for job ${jobNumber}`, performedBy: profile.id, entityType: 'job', entityId: id });
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'wps_notice_pdf' } });
      toast('error', 'Failed to generate WPS notice');
    }
    setPrintingWps(false);
  };
  const [vehicleId, setVehicleId] = useState('');
  const [recipeId, setRecipeId] = useState('');
  const [notes, setNotes] = useState('');
  const [batchId, setBatchId] = useState('');
  const [quoteLinkage, setQuoteLinkage] = useState<{ quote_id: string; quote_number: string; section_name: string } | null>(null);

  // Sub-collections
  const [fieldRows, setFieldRows] = useState<FieldRow[]>([]);
  const [chemRows, setChemRows] = useState<ChemRow[]>([]);

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

  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  }, [customerId, jobDate, scheduledTime, applicatorId, vehicleId, notes, batchId, fieldRows, chemRows]);

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
    const { data, error } = await supabase
      // PR-07 follow-up: dropped applicator FK embed — full_name isn't read
      // anywhere in this page; only applicator_id is consumed (line 235).
      .from('jobs')
      .select(`
        *,
        customer:customers(farm_name),
        vehicle:vehicles(vehicle_name),
        quote:quotes!jobs_quote_id_fkey(quote_number),
        quote_section:quote_sections!jobs_quote_section_id_fkey(section_name),
        job_fields(*, field:fields(field_name)),
        job_chemicals(*, product:products(product_name)),
        applied_info:job_applied_info(*)
      `)
      .eq('id', id)
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
    setRecipeId(j.recipe_id || '');
    setNotes(j.notes || '');
    setBatchId(j.batch_id || '');
    // Quote traceability (typed via JobDbRow)
    if (j.quote_id) {
      
      
      setQuoteLinkage({ quote_id: j.quote_id, quote_number: j.quote?.quote_number || '', section_name: j.quote_section?.section_name || '' });
    }

    setFieldRows(
      (j.job_fields || []).map((f) => ({
        field_id: f.field_id,
        field_name: f.field?.field_name || '',
        acres_to_treat: f.acres_to_treat?.toString() || '',
        sort_order: f.sort_order,
      }))
    );

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
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  }, [id, toast, navigate]);

  useEffect(() => {
    loadLookups();
    if (!isNew && id) {
      fetchJob();
    } else {
      // Check for recipe_id from search params
      const recipeParam = searchParams.get('recipe_id');
      if (recipeParam) setRecipeId(recipeParam);
      setTimeout(() => { initialLoadDone.current = true; }, 0);
    }
  }, [id, fetchJob, isNew, searchParams]);

  // Computed
  const customerFields = allFields.filter(f => !customerId || f.customer_id === customerId);
  const totalAcres = fieldRows.reduce((sum, f) => sum + (parseFloat(f.acres_to_treat) || 0), 0);
  const totalCostCents = chemRows.reduce((sum, c) => sum + Math.round((parseFloat(c.quantity) || 0) * (parseInt(c.cost_per_unit_cents) || 0)), 0);
  const totalPriceCents = chemRows.reduce((sum, c) => sum + Math.round((parseFloat(c.quantity) || 0) * (parseInt(c.price_per_unit_cents) || 0)), 0);

  // Loader worksheet
  const selectedVehicle = vehicles.find(v => v.id === vehicleId);
  const totalGallons = chemRows.reduce((sum, c) => {
    if ((c.unit || '').toLowerCase().includes('gal')) return sum + (parseFloat(c.quantity) || 0);
    return sum;
  }, 0);
  const loadsNeeded = selectedVehicle?.capacity_gallons && totalGallons > 0
    ? Math.ceil(totalGallons / selectedVehicle.capacity_gallons)
    : null;

  // C4: weather auto-capture at completion (first selected field's centroid).
  // fields.centroid is a PostGIS geometry — its GeoJSON text is exposed only by
  // the get_field_geojson RPC (a plain fields.select('*') has NO centroid_geojson
  // column), so fetch it for the first selected field. Fail-soft: any miss just
  // hides the weather button, leaving manual entry (weather prefill is never a gate).
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

  const handleSave = async () => {
    // Codex P2 fix (PR #59, 2026-05-16): reset saveJobIdem per save attempt.
    // The job form is always-editable (no separate edit toggle), so any
    // change between failed submits is a new intent.
    saveJobIdem.resetKey();
    if (!customerId) { toast('error', 'Customer is required'); return; }
    if (!jobDate) { toast('error', 'Job date is required'); return; }

    // B5 license gate pre-check — only when assigning or CHANGING the applicator
    // (editing other fields on a job that already has this applicator stays allowed,
    // matching the DB trigger's IS NOT DISTINCT FROM skip).
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
        // #4 (atomic-safe override): never change the applicator INSIDE save_job. New
        // job -> create unassigned; existing job -> keep the persisted applicator (a
        // same-value UPDATE OF applicator_id is a no-op for the license trigger, which
        // returns early when NEW.applicator_id IS NOT DISTINCT FROM OLD). The override
        // (re)assignment runs via assign_job_applicator AFTER save_job commits, so a
        // failed save can never leave a committed applicator change behind.
        applicator_id: overrideSaveApplicatorId({ licenseOverride, isNew, applicatorId, savedApplicatorId }),
        vehicle_id: vehicleId || null,
        recipe_id: recipeId || null,
        notes: notes || null,
        batch_id: batchId || null,
        total_acres: totalAcres,
        total_cost_cents: totalCostCents,
        total_price_cents: totalPriceCents,
      };

      const fieldsPayload = fieldRows.map((f, i) => ({
        field_id: f.field_id,
        acres_to_treat: parseFloat(f.acres_to_treat) || 0,
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
        sort_order: i,
      }));

      const idemKey = saveJobIdem.getKey();
      const { data, error } = await supabase.rpc('save_job', {
        p_job_id: isNew ? null : id,
        p_job_payload: payload,
        p_fields: fieldsPayload,
        p_chemicals: chemsPayload,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });

      if (error) throw error;
      saveJobIdem.resetKey();
      const result = assertRpcResult<SaveJobResult>(data, 'save_job');

      // #4: the job is now persisted with its applicator UNCHANGED. Flip the
      // applicator via assign_job_applicator (admin override) ONLY after the save
      // committed. If THIS fails, the edits are already saved and the applicator is
      // simply unchanged — a clean, retryable state, never a partial "applicator
      // changed but the save was lost" (the failure-after-override-assignment case).
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
        p_job_id: id,
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
    // Only scheduled or in_progress jobs can be cancelled
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
        p_job_id: id,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      transferJobIdem.resetKey();
      const result = assertRpcResult<TransferJobResult>(data, 'transfer_job_to_invoice');
      if (profile) logActivity({ event: 'job_invoiced', description: `Job ${jobNumber} → Invoice ${result.invoice_number}`, performedBy: profile.id });
      toast('success', `Invoice ${result.invoice_number} created`);
      setIsDirty(false);
      navigate(`/invoices/${result.invoice_id}`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'transfer_job_to_invoice' } });
      toast('error', err instanceof Error ? err.message : 'Failed to transfer to invoice');
    }
    setTransferring(false);
  };

  const handleLoadRecipe = async () => {
    if (!selectedRecipeId || !id) return;
    setLoadingRecipe(true);
    try {
      const idemKey = loadRecipeIdem.getKey();
      const { data, error } = await supabase.rpc('load_recipe_into_job', {
        p_job_id: id,
        p_recipe_id: selectedRecipeId,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      loadRecipeIdem.resetKey();
      const recipeResult = assertRpcResult<LoadRecipeResult>(data, 'load_recipe_into_job');
      toast('success', `Loaded ${recipeResult.items_loaded} items from recipe`);
      setShowRecipeModal(false);
      setIsDirty(false);
      await fetchJob();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'load_recipe_into_job' } });
      toast('error', err instanceof Error ? err.message : 'Failed to load recipe');
    }
    setLoadingRecipe(false);
  };

  // Field row handlers
  const addFieldRow = () => {
    setFieldRows([...fieldRows, { field_id: '', field_name: '', acres_to_treat: '', sort_order: fieldRows.length }]);
  };
  const removeFieldRow = (i: number) => setFieldRows(fieldRows.filter((_, idx) => idx !== i));
  const updateFieldRow = (i: number, key: keyof FieldRow, value: string) => {
    const updated = [...fieldRows];
    updated[i] = { ...updated[i], [key]: value };
    if (key === 'field_id') {
      const f = allFields.find(af => af.id === value);
      updated[i].field_name = f?.field_name || '';
      if (f && f.total_acres && !updated[i].acres_to_treat) {
        updated[i].acres_to_treat = f.total_acres.toString();
      }
    }
    setFieldRows(updated);
  };

  // Chem row handlers
  const addChemRow = () => {
    setChemRows([...chemRows, {
      product_id: '', product_name: '', quantity: '0', unit: '', rate_per_acre: '', rate_unit: '',
      cost_per_unit_cents: '0', price_per_unit_cents: '0', sort_order: chemRows.length,
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
        updated[i].unit = p.unit_size || '';
        updated[i].cost_per_unit_cents = Math.round((p.current_cost || 0) * 100).toString();
      }
    }
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
            {isNew ? 'New Job' : jobNumber}
          </h1>
          {!isNew && (
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant={statusVariant[status]}>{status.replace('_', ' ')}</Badge>
              <span className="text-sm text-secondary">{parseLocalDate(jobDate).toLocaleDateString()}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isNew && fieldRows.some((f) => f.field_id) && chemRows.some((c) => c.product_id) && (
            <Button variant="secondary" onClick={handleWpsNotice} loading={printingWps}>
              <Printer className="w-4 h-4" />
              WPS Notice
            </Button>
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
              {isNew ? 'Create Job' : 'Save Changes'}
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
              onChange={(e) => { setCustomerId(e.target.value); setFieldRows([]); }}
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
        <div className="mt-4">
          <label className="block text-sm font-medium text-nav-dark mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            disabled={!canEdit}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none disabled:bg-gray-50"
            placeholder="Job notes..."
          />
        </div>
      </Card>

      {/* Fields */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-nav-dark">Fields ({fieldRows.length})</h2>
          {canEdit && (
            <Button size="sm" variant="secondary" onClick={addFieldRow} disabled={!customerId}>
              <Plus className="w-4 h-4" /> Add Field
            </Button>
          )}
        </div>
        {fieldRows.length === 0 ? (
          <p className="text-sm text-secondary text-center py-4">
            {customerId ? 'No fields added. Click "Add Field" to assign fields.' : 'Select a customer first.'}
          </p>
        ) : (
          <div className="space-y-2">
            {fieldRows.map((f, i) => (
              <div key={i} className="flex items-center gap-3 bg-gray-50 rounded-lg p-3">
                <select
                  value={f.field_id}
                  onChange={(e) => updateFieldRow(i, 'field_id', e.target.value)}
                  disabled={!canEdit}
                  className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
                >
                  <option value="">Select field...</option>
                  {customerFields.map((cf) => (
                    <option key={cf.id} value={cf.id}>{cf.field_name}</option>
                  ))}
                </select>
                <Input
                  type="number"
                  value={f.acres_to_treat}
                  onChange={(e) => updateFieldRow(i, 'acres_to_treat', e.target.value)}
                  placeholder="Acres"
                  disabled={!canEdit}
                  className="w-28"
                  min={0}
                />
                {canEdit && (
                  <button onClick={() => removeFieldRow(i)} className="text-red-500 hover:text-red-700 p-1">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
            <p className="text-xs text-secondary text-right">Total: {totalAcres.toLocaleString()} acres</p>
          </div>
        )}
      </Card>

      {/* Chemicals */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-nav-dark">Chemicals ({chemRows.length})</h2>
          <div className="flex gap-2">
            {canEdit && !isNew && (
              <Button size="sm" variant="secondary" onClick={() => { loadRecipeIdem.resetKey(); setSelectedRecipeId(''); setShowRecipeModal(true); }}>
                <Beaker className="w-4 h-4" /> Load Recipe
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
          <div className="space-y-2">
            {chemRows.map((c, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center bg-gray-50 rounded-lg p-3">
                <div className="col-span-12 md:col-span-3">
                  <select
                    value={c.product_id}
                    onChange={(e) => updateChemRow(i, 'product_id', e.target.value)}
                    disabled={!canEdit}
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg"
                  >
                    <option value="">Select product...</option>
                    {allProducts.map((p) => (
                      <option key={p.id} value={p.id}>{p.product_name}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-3 md:col-span-1">
                  <input type="number" value={c.quantity} onChange={(e) => updateChemRow(i, 'quantity', e.target.value)}
                    disabled={!canEdit} placeholder="Qty" step="0.01" min="0"
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg" />
                </div>
                <div className="col-span-3 md:col-span-1">
                  <input type="text" value={c.unit} onChange={(e) => updateChemRow(i, 'unit', e.target.value)}
                    disabled={!canEdit} placeholder="Unit"
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg" />
                </div>
                <div className="col-span-3 md:col-span-1">
                  <input type="number" value={c.rate_per_acre} onChange={(e) => updateChemRow(i, 'rate_per_acre', e.target.value)}
                    disabled={!canEdit} placeholder="Rate" step="0.01"
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg" />
                </div>
                <div className="col-span-3 md:col-span-1">
                  <input type="text" value={c.rate_unit} onChange={(e) => updateChemRow(i, 'rate_unit', e.target.value)}
                    disabled={!canEdit} placeholder="oz/ac"
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg" />
                </div>
                <div className="col-span-4 md:col-span-2">
                  <input type="number" value={c.cost_per_unit_cents} onChange={(e) => updateChemRow(i, 'cost_per_unit_cents', e.target.value)}
                    disabled={!canEdit} placeholder="Cost ¢" step="1"
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg" />
                </div>
                <div className="col-span-4 md:col-span-2">
                  <input type="number" value={c.price_per_unit_cents} onChange={(e) => updateChemRow(i, 'price_per_unit_cents', e.target.value)}
                    disabled={!canEdit} placeholder="Price ¢" step="1"
                    className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg" />
                </div>
                {canEdit && (
                  <div className="col-span-4 md:col-span-1">
                    <button onClick={() => removeChemRow(i)} className="text-red-500 hover:text-red-700 p-1">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}
            <div className="flex justify-between text-sm text-secondary pt-2">
              <span>Total Cost: ${(totalCostCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              <span>Total Price: ${(totalPriceCents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
          </div>
        )}
      </Card>

      {/* Loader Worksheet */}
      {selectedVehicle && totalGallons > 0 && (
        <Card>
          <h2 className="text-lg font-semibold text-nav-dark mb-3">Loader Worksheet</h2>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-2xl font-bold text-nav-dark">{totalGallons.toLocaleString()}</p>
              <p className="text-xs text-secondary">Total Gallons</p>
            </div>
            <div className="bg-gray-50 rounded-lg p-3">
              <p className="text-2xl font-bold text-nav-dark">
                {selectedVehicle.capacity_gallons?.toLocaleString() || '-'}
              </p>
              <p className="text-xs text-secondary">Tank Capacity ({selectedVehicle.capacity_unit || 'gal'})</p>
            </div>
            <div className="bg-crx-green-tint rounded-lg p-3">
              <p className="text-2xl font-bold text-crx-green">{loadsNeeded ?? '-'}</p>
              <p className="text-xs text-secondary">Loads Needed</p>
            </div>
          </div>
        </Card>
      )}

      {/* Applied Info (read-only for completed/invoiced) */}
      {!isNew && (status === 'completed' || status === 'invoiced') && (
        <Card>
          <h2 className="text-lg font-semibold text-nav-dark mb-3">Applied Information</h2>
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
      <Modal open={showRecipeModal} onClose={() => setShowRecipeModal(false)} title="Load Recipe">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Select a blend recipe to load its chemicals into this job. This will replace existing chemicals.
          </p>
          <select
            value={selectedRecipeId}
            onChange={(e) => setSelectedRecipeId(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
          >
            <option value="">Select recipe...</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowRecipeModal(false)}>Cancel</Button>
            <Button onClick={handleLoadRecipe} disabled={!selectedRecipeId} loading={loadingRecipe}>
              <Beaker className="w-4 h-4" /> Load Recipe
            </Button>
          </div>
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

      {/* Complete Job Confirm */}
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
