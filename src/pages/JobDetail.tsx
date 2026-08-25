import { useEffect, useRef, useState , useCallback, useMemo, lazy, Suspense } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Save, Plus, Trash2, Check, FileText, Beaker, Ban, MessageSquarePlus, Printer, CloudSun, MapPin, Truck, ClipboardList, FlaskConical, Bell, History, BookmarkPlus, GripVertical, ChevronUp, ChevronDown, Map as MapIcon, ShieldAlert, CalendarClock, AlertTriangle, Sprout, Send } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import SearchableSelect from '../components/ui/SearchableSelect';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { logActivity } from '../lib/activityLogger';
import { notifyApplicatorDispatched, notifyApplicatorRescheduled, notifyApplicatorUndispatched } from '../lib/notificationTriggers';
import { supabase, checkMutationResult, assertRpcResult, hasRpcCode, RpcErrorCodes, sanitizeError } from '../lib/db';
import { warnIfOverCreditLimit } from '../lib/creditLimit';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { getLicenseStatus, licenseStatusLabel } from '../lib/licenseStatus';
import { generateWpsNoticePdf } from '../lib/wpsNoticePdf';
import { generateApplicatorSheetPdf } from '../lib/applicatorSheetPdf';
import { prepareApplicatorSheetPrintData } from '../lib/applicatorSheetPrintData';
import PrintOptionsDialog, { type ApplicatorPrintSelection } from '../components/jobs/PrintOptionsDialog';
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
import { fetchLoaderWorksheetData } from '../lib/loaderWorksheetFetch';
import { computeLoaderWorksheet, isGallonCapacityUnit } from '../lib/loaderWorksheet';
import { stampJobPrinted } from '../lib/printStamp';
import {
  ASSIGNED_VEHICLE_VESSEL_VALUE,
  buildLoaderVesselOptions,
  capacityForLoaderVesselSelection,
} from '../lib/loaderVesselOptions';
import { overrideSaveApplicatorId, shouldReassignApplicatorAfterSave, canGenerateWpsNotice, anySelectedFieldSharesLoading } from '../lib/jobSaveHelpers';
import { fetchCurrentWeather, parseCentroid } from '../lib/weatherCapture';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import { centsTimesQuantity, isExactDecimalText, quantitySurvivesSave } from '../lib/money';
import { applyChemEdit, chemLineBillingHazard, chemUnitUnspecifiedSides, fmt4, rateDenominatorIsUnrecognized, recomputeChemRowForAcres, reconcileChemAutofillUnits, sumAcres, toGallonOrLbEquivalent, type ChemBillingHazard } from '../lib/chemCalculator';
import { compareToMaxRate, normalizeRateUnit, phiHarvestWarning } from '../lib/labelGuardrails';
import { unitOptionsForForm, isKnownUnit } from '../lib/units';
import {
  LABEL_RATE_GUARDRAIL_MODE_KEY,
  DEFAULT_GUARDRAIL_MODE,
  parseGuardrailMode,
  type GuardrailMode,
} from '../lib/labelGuardrailSetting';
import { computeSeason } from '../utils/season';
import { recipeItemToChemRowSeed, chemRowsToRecipeItems, getLastRecipeId, setLastRecipeId } from '../lib/recipeHelpers';
import { programItemToChemRowSeed, parseCropPrograms, orderProgramsForJob, type CropProgram } from '../lib/cropProgramHelpers';
import { moveItem, moveUp, moveDown } from '../lib/routeOrder';
import { billableAcres } from '../lib/fieldGeometry';
import AppliedRecordsManager from '../components/jobs/AppliedRecordsManager';
import type { JobFieldPickerSelection } from '../components/jobs/jobFieldPicker';
import ApplicationServicePicker from '../components/field-app/ApplicationServicePicker';
import WatchdogFlagBanner from '../components/watchdog/WatchdogFlagBanner';
// U13 (#15-21/#111): job-scoped "Dispatch Locations" — reuses the SAME 3-step
// wizard the Dispatch Board uses, pre-scoped + pre-selected to this job.
import DispatchWizard from '../components/dispatch/DispatchWizard';
import type { DispatchLocation } from '../lib/dispatchWizard';
// Codex #16 P2: lazy-load the map component so the mapbox bundle is only fetched when
// the user actually opens the Map / Logs tab — not on every JobDetail page load (matters
// on field/mobile connections). JobAttachments is light, so it stays a static import.
const JobFieldMap = lazy(() => import('../components/jobs/JobFieldMap'));
// The picker contains Mapbox GL, so keep it out of the normal job-editor load.
const JobFieldPickerModal = lazy(() => import('../components/jobs/JobFieldPickerModal'));
import JobAttachments from '../components/jobs/JobAttachments';
import { LegacyLoaderWorksheet } from '../components/jobs/LegacyLoaderWorksheet';
import { LoaderWorksheetsPanel } from '../components/jobs/LoaderWorksheetsPanel';
import type { LoaderWorksheetDisplayMode } from '../lib/loaderWorksheets';
import QuickTaskModal from '../components/team/QuickTaskModal';
import ConfirmModal from '../components/ui/ConfirmModal';
import RelatedNotes from '../components/team/RelatedNotes';
import { Sentry } from '../lib/sentry';
import type { JobStatus, Customer, Product, Field, Vehicle, Profile, BlendRecipe, BlendRecipeItem, LinkedEntityType, JobNotification, UnitConversion } from '../types';
import type { Json } from '../types/supabase';
import type { ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';
import { JobChemicalProductPicker } from '../components/jobs/JobChemicalProductPicker';
import { buildJobChemicalsPayload } from '../lib/jobChemicalPayload';
import { sendEmail } from '../lib/emailService';
import {
  parsePreNotificationTemplate,
  renderPreNotification,
  buildPreNotificationEmailPayload,
  countSentPreNotifications,
  describePreNotificationSend,
} from '../lib/preNotification';
import {
  parsePostNotificationTemplate,
  renderPostNotification,
  buildPostNotificationEmailPayload,
  countSentPostNotifications,
  describePostNotificationSend,
} from '../lib/postNotification';

type PickerProduct = Product & ProductOptionPresentationModel;

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
  /** U3 (#52): drives the per-acre service fee on transfer_job_to_invoice. */
  application_service_id?: string | null;
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
    customer_supplied?: boolean | null;
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
interface TransferJobResult {
  invoice_id: string;
  // single-owner path returns the invoice number; the multi-owner group path returns
  // the group fields instead (U7). invoice_id is always the anchor member to navigate to.
  invoice_number?: string;
  invoice_ids?: string[];
  invoice_group_id?: string;
  invoice_count?: number;
  split?: boolean;
}

const statusVariant: Record<JobStatus, BadgeVariant> = {
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'default',
  invoiced: 'success',
};

type TabKey = 'locations' | 'chemicals' | 'loader' | 'applied' | 'map_logs' | 'notifications';
const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'locations', label: 'Locations', icon: <MapPin className="w-4 h-4" /> },
  { key: 'chemicals', label: 'Chemicals / Charges', icon: <Beaker className="w-4 h-4" /> },
  { key: 'loader', label: 'Loader Worksheet', icon: <Truck className="w-4 h-4" /> },
  { key: 'applied', label: 'Applied Info', icon: <ClipboardList className="w-4 h-4" /> },
  // Field-app parity #16: per-job field map + attach log files (the last Phase-4 printout).
  { key: 'map_logs', label: 'Map / Logs', icon: <MapIcon className="w-4 h-4" /> },
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
  /** #53/#54: grower brought this product — apply it, but don't deduct our
   *  inventory or bill for it. Persisted to job_chemicals.customer_supplied. */
  customer_supplied: boolean;
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
  // Post-save refetch race guard: fetchJob nulls the baseline BEFORE its network
  // read resolves, and loading stays false on refetches — so any render in that
  // window (the save handler's own state sets, for one) would adopt the STALE
  // pre-refetch form as "clean", leaving isDirty stuck true once fresh rows land.
  // While the guard is up, adoption waits; the settle tick forces one adoption
  // pass on the render that contains the fully-refetched state.
  const baselineSettleGuardRef = useRef(false);
  const [baselineSettleTick, setBaselineSettleTick] = useState(0);
  const blocker = useUnsavedChanges(isDirty);
  // Field-app parity #16: allow a deep-link to a tab (e.g. the Jobs-list "Map / Logs"
  // row action opens /jobs/:id?tab=map_logs). Falls back to 'locations'.
  const initialTab = ((): TabKey => {
    const t = searchParams.get('tab');
    const valid: TabKey[] = ['locations', 'chemicals', 'loader', 'applied', 'map_logs', 'notifications'];
    return (valid as string[]).includes(t ?? '') ? (t as TabKey) : 'locations';
  })();
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);

  // Lookup data
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [allFields, setAllFields] = useState<Field[]>([]);
  // The field picker and manual field selector derive billable acres from this
  // lookup. Keep those entry points closed until the lookup has succeeded so
  // neither can fall back to legacy total_acres while it is unavailable.
  const [fieldsLookupReady, setFieldsLookupReady] = useState(false);
  const [allProducts, setAllProducts] = useState<PickerProduct[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [applicators, setApplicators] = useState<Profile[]>([]);
  // Staff-held license rows per profile (B5 license gates)
  const [licensesByProfile, setLicensesByProfile] = useState<Record<string, { expiry_date: string; is_active: boolean }[]>>({});
  const [recipes, setRecipes] = useState<BlendRecipe[]>([]);

  // Job form
  const [jobNumber, setJobNumber] = useState('');
  const [status, setStatus] = useState<JobStatus>('scheduled');
  // #23: pre-fill the customer when arriving from a customer page
  // (/jobs/new?customer_id=…). Only for a NEW job; existing jobs load their own
  // customer in fetchJob. A stale/bogus id simply renders as no selection.
  const [customerId, setCustomerId] = useState(() => (isNew ? (searchParams.get('customer_id') ?? '') : ''));
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
  // The vessel selection is convenience UI only. The persisted job value remains
  // loader_tank_capacity, so a reloaded job intentionally starts at Assigned vehicle.
  const [loaderVesselId, setLoaderVesselId] = useState(ASSIGNED_VEHICLE_VESSEL_VALUE);
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
  const [loaderDisplayMode, setLoaderDisplayMode] = useState<LoaderWorksheetDisplayMode>('individual');
  // The applicator currently saved on the job — the license gate only fires on a CHANGE
  const [savedApplicatorId, setSavedApplicatorId] = useState<string | null>(null);
  // U12: mirrors savedApplicatorId — lets performSave detect a RESCHEDULE
  // (job_date changed while the same applicator stays assigned) so the
  // assigned applicator can be notified.
  const [savedJobDate, setSavedJobDate] = useState<string | null>(null);
  // U12 Codex R3 #2: true when the CURRENT applicator holds an ACTIVE
  // ('dispatched') job_location_dispatches row on this job. The assignment-
  // unification migration authorizes such a dispatchee to start/complete the
  // job server-side — this state lets the Start/Complete buttons show for them
  // (previously only the legacy jobs.applicator_id assignee saw them).
  const [hasActiveDispatch, setHasActiveDispatch] = useState(false);
  const [showLicenseOverrideConfirm, setShowLicenseOverrideConfirm] = useState(false);
  const assignIdem = useIdempotencyKey('assign_job_applicator', profile?.id || '');
  // U13 (#15-21/#111): job-scoped Dispatch Locations wizard.
  const [dispatchWizardOpen, setDispatchWizardOpen] = useState(false);
  const [dispatchWizardLocations, setDispatchWizardLocations] = useState<DispatchLocation[]>([]);
  const [dispatchWizardLoading, setDispatchWizardLoading] = useState(false);
  // B3: WPS pre-application notice PDF
  const [printingWps, setPrintingWps] = useState(false);
  // Applicator-sheet packet options (format, maps, history, hand-fill blocks).
  const [printOptionsOpen, setPrintOptionsOpen] = useState(false);
  const [generatingSheet, setGeneratingSheet] = useState<ApplicatorSheetFormat | null>(null);
  // #11: Chemical Application Report (per-job chemical-centric PDF) print in progress.
  const [generatingChemReport, setGeneratingChemReport] = useState(false);
  // C4: weather auto-capture at completion
  const [fetchingWeather, setFetchingWeather] = useState(false);
  // Field-app parity #40: per-job customer pre-notification log + send action.
  const [jobNotifications, setJobNotifications] = useState<JobNotification[]>([]);
  const [loadingNotifications, setLoadingNotifications] = useState(false);
  // #40 MED (Codex review): TRUE only after a SUCCESSFUL log load. The sent-count
  // (alreadySentPreCount) is only trustworthy once we've actually read the log — a
  // FAILED load leaves jobNotifications=[] with loadingNotifications=false, which
  // would otherwise read as "0 sent" and silently enable the FIRST-send flow on a
  // job that already has sent notices. Gate the send on this so we FAIL CLOSED.
  const [notificationsLoaded, setNotificationsLoaded] = useState(false);
  // #40 MED (Codex re-review): a FAILED load must be VISIBLE (not a silently-disabled
  // Send button + a misleading "no notifications" empty state) → drives an error+Retry
  // panel. And notifLoadReqRef drops a STALE in-flight response from a PREVIOUSLY viewed
  // job (this component is reused across /jobs/:id navigation) so the new job's Send
  // control is never computed from the old job's log.
  const [notificationsLoadError, setNotificationsLoadError] = useState(false);
  const notifLoadReqRef = useRef<string | null>(null);
  const [sendingPreNotice, setSendingPreNotice] = useState(false);
  const [showPreNoticeConfirm, setShowPreNoticeConfirm] = useState(false);
  const { getKey: getPreNoticeKey, resetKey: resetPreNoticeKey } = useIdempotencyKey('record_job_pre_notifications', profile?.id || '');
  // #40 MED: how many pre-notifications have ALREADY been confirmed 'sent' for this
  // job. > 0 means a click is a RE-SEND — relabel the control + warn in the confirm
  // modal that confirming notifies those customers a SECOND time (a stray double
  // click should NOT silently re-notify; only an explicit, informed confirm proceeds).
  const alreadySentPreCount = countSentPreNotifications(jobNotifications);
  const preSendCopy = describePreNotificationSend(alreadySentPreCount);
  // Field-app parity #41: post-application notice send action (AFTER application).
  // Reuses the SAME jobNotifications log + load + fail-closed gating as #40; only the
  // type ('post') + lifecycle gate (completed/invoiced) differ. The re-send-safety
  // count is over 'post' rows so a pre send never relabels the post control (or v.v.).
  const [sendingPostNotice, setSendingPostNotice] = useState(false);
  const [showPostNoticeConfirm, setShowPostNoticeConfirm] = useState(false);
  const { getKey: getPostNoticeKey, resetKey: resetPostNoticeKey } = useIdempotencyKey('record_job_post_notifications', profile?.id || '');
  const alreadySentPostCount = countSentPostNotifications(jobNotifications);
  const postSendCopy = describePostNotificationSend(alreadySentPostCount);

  // Field-app parity #40: load the per-job customer notification log. Read-only;
  // the job_notifications RLS policy allows ONLY admin/sales (the log carries
  // co-billed customer emails). Skip the query entirely for any other role so we
  // don't fire a guaranteed-RLS-denied read that gets swallowed into the empty
  // state AND logged to Sentry as noise every time (Codex #40 P3).
  const loadJobNotifications = useCallback(async () => {
    if (isNew || !id || !isEditable) { setJobNotifications([]); setNotificationsLoaded(false); setNotificationsLoadError(false); return; }
    const reqId = id;                  // the job this load is FOR
    notifLoadReqRef.current = reqId;   // mark it the latest requested job
    setLoadingNotifications(true);
    setNotificationsLoaded(false); // reset until THIS load confirms the count is trustworthy
    setNotificationsLoadError(false);
    try {
      const { data, error } = await supabase
        .from('job_notifications')
        .select('id, job_id, notification_type, customer_id, recipient_email, channel, subject, message, status, sent_at, sent_by, idempotency_key, created_at, customer:customers(farm_name)')
        .eq('job_id', reqId)
        // #40 LOW: order by created_at (NOT NULL on every row), NOT sent_at — a
        // failed/unsent row has sent_at=NULL and Postgres sorts NULLS FIRST, which
        // floated failed rows ABOVE real sends and read the log backwards.
        .order('created_at', { ascending: false });
      // #40 MED (Codex re-review): a newer job's load superseded this one — drop the
      // stale result so we never compute the new job's Send control off the old log.
      if (notifLoadReqRef.current !== reqId) return;
      if (error) throw error;
      setJobNotifications((data as unknown as JobNotification[]) ?? []);
      setNotificationsLoaded(true); // ONLY a clean read makes the sent-count safe to send off
    } catch (err) {
      if (notifLoadReqRef.current !== reqId) return; // stale — don't clobber the current job's state
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'load_job_notifications', jobId: reqId } });
      setJobNotifications([]);
      setNotificationsLoaded(false); // failed load: count is NOT trustworthy → keep the send disabled
      setNotificationsLoadError(true); // ...but make it VISIBLE + retryable (don't strand the user)
    } finally {
      if (notifLoadReqRef.current === reqId) setLoadingNotifications(false);
    }
  }, [id, isNew, isEditable]);

  // Send a before-application pre-notification to the job's resolved share
  // customer(s). Flow: (1) record the per-recipient log via the SECURITY DEFINER
  // RPC (resolves the distinct share customers; EVERY row starts 'failed'); (2) for
  // each recipient WITH an email, send through the gated send-email edge fn using
  // the OWNER-EDITABLE template, then confirm the row -> 'sent' ONLY on a successful
  // send (so the log never shows 'Sent' for an email that didn't leave). The
  // outbound idempotency key is the DETERMINISTIC per-recipient key the RPC returns,
  // so a retry de-dupes at the edge and a recipient already emailed isn't emailed
  // twice. The action key is preserved on any failure so a retry reuses it.
  const handleSendPreNotification = async () => {
    if (isNew || !id) return;
    // #40 MED (Codex review) FAIL CLOSED: never decide first-send vs re-send off a
    // log we haven't SUCCESSFULLY read — alreadySentPreCount reads 0 both when there
    // are genuinely no notices AND when the load FAILED, so a failed/incomplete load
    // would skip the re-send warning and re-notify customers. Require a confirmed
    // load (notificationsLoaded) — the button is also disabled in both cases.
    if (loadingNotifications || !notificationsLoaded) {
      toast('error', 'Could not load the notification log yet — reload the page before sending, so an already-sent notice is not duplicated.');
      return;
    }
    // Codex #40 P2 (save-first): the subject/body are built from CURRENT form state
    // but the RPC resolves recipients from the PERSISTED job. Block on unsaved edits
    // so we never email the saved customers with in-progress (or stale) details —
    // same guard the WPS/compliance actions use.
    if (isDirty) {
      toast('error', 'Save the job before sending a pre-notification — it must match the saved record.');
      return;
    }
    setSendingPreNotice(true);
    const key = getPreNoticeKey();
    try {
      // Resolve the editable template (criterion #5). ABORT on a failed read — a
      // null-on-error would silently fall back to the hard-coded default and email
      // the WRONG (not owner-edited) wording to the customer (Codex #40 P2). A
      // genuinely-absent row (no error, data null) correctly uses the default.
      const { data: tplRow, error: tplErr } = await supabase
        .from('app_settings')
        .select('setting_value')
        .eq('setting_key', 'pre_application_notice_template')
        .maybeSingle();
      if (tplErr) throw new Error(`Could not load the pre-notification message: ${tplErr.message}`);
      const template = parsePreNotificationTemplate((tplRow as { setting_value?: string } | null)?.setting_value ?? null);

      // Render once with the primary customer's name for the recorded log subject/
      // message; per-recipient bodies are re-rendered with each farm name below.
      const primaryFarm = customers.find((c) => c.id === customerId)?.farm_name ?? '';
      const recorded = renderPreNotification(template, {
        customer: primaryFarm,
        jobNumber,
        jobDate,
      });

      // 1) Record the per-recipient log (admin/sales only; resolves recipients).
      const rpcRes = await supabase.rpc('record_job_pre_notifications', {
        p_job_id: id,
        p_subject: recorded.subject,
        p_message: recorded.body,
        p_performed_by: profile?.id ?? undefined,
        p_idempotency_key: key,
      });
      // Throw the RPC error FIRST so the machine-readable code (INSUFFICIENT_ROLE /
      // JOB_NOT_PRE_NOTIFIABLE) reaches the hasRpcCode branches below — asserting a
      // null data on a raise would otherwise swallow it as a generic no-data error
      // (Codex #40 re-review P2).
      if (rpcRes.error) throw rpcRes.error;
      const result = assertRpcResult<{
        success: boolean;
        recipients_with_email: number;
        recipients_without_email: number;
        recipients: Array<{
          notification_id: string;
          customer_id: string;
          farm_name: string | null;
          email: string | null;
          has_email: boolean;
          email_idempotency_key: string | null;
        }>;
      }>(rpcRes.data, 'record_job_pre_notifications');

      // 2) Send the actual email to each recipient WITH an email; confirm -> 'sent'
      // only on success.
      let emailedOk = 0;
      let emailErr = 0;
      for (const r of result.recipients) {
        if (!r.has_email || !r.email) continue;
        if (!r.email_idempotency_key) {
          // codex-driven hunt cycle 7 — fail-closed (matches FieldApplicationInvoice):
          // a recipient WITH an email must carry a deterministic edge idempotency key.
          // Without one, SKIP (logged 'failed') rather than send with no key — a retry
          // would otherwise double-send this customer's pre-application notice.
          emailErr += 1;
          Sentry.captureMessage('job pre-notification recipient missing email_idempotency_key', { level: 'warning', extra: { jobId: id, customerId: r.customer_id } });
          continue;
        }
        try {
          const rendered = renderPreNotification(template, {
            customer: r.farm_name ?? primaryFarm,
            jobNumber,
            jobDate,
          });
          const payload = buildPreNotificationEmailPayload({
            customerEmail: r.email,
            customerId: r.customer_id,
            jobId: id,
            subject: rendered.subject,
            body: rendered.body,
          });
          // Deterministic edge idempotency key from the RPC (NOT Date.now()): a
          // retry reuses it so the edge fn de-dupes the same recipient's send.
          // Guaranteed present by the fail-closed guard above.
          payload.idempotency_key = r.email_idempotency_key;
          await sendEmail(payload);
          // Flip THIS row failed -> sent now that the email actually went out, and
          // store the EXACT per-recipient text that was emailed so the audit row
          // matches what the (co-billed) customer received. No idempotency key
          // needed: the RPC is naturally idempotent (re-confirming a 'sent' row is a
          // no-op) and scoped to a single stable notification_id.
          const confirmRes = await supabase.rpc('confirm_job_notification_sent', {
            p_notification_id: r.notification_id,
            p_subject: rendered.subject,
            p_message: rendered.body,
            p_performed_by: profile?.id ?? undefined,
          });
          if (confirmRes.error) throw confirmRes.error;
          assertRpcResult(confirmRes.data, 'confirm_job_notification_sent');
          emailedOk += 1;
        } catch (sendErr) {
          // Row stays 'failed' — honest. Keep the action key so a retry de-dupes.
          emailErr += 1;
          Sentry.captureException(sendErr instanceof Error ? sendErr : new Error(String(sendErr)), { extra: { context: 'send_pre_notification_email', jobId: id, customerId: r.customer_id } });
        }
      }

      if (profile) {
        logActivity({ event: 'job_pre_notification_sent', description: `Pre-application notice for job ${jobNumber}: ${result.recipients_with_email} recipient(s) with email, ${emailedOk} emailed`, performedBy: profile.id, entityType: 'job', entityId: id });
      }

      const noEmail = result.recipients_without_email;
      if (emailErr > 0) {
        // Do NOT reset the key — a retry reuses it so already-sent recipients
        // de-dupe at the edge and aren't emailed twice.
        // #40 LOW: include the no-email count (co-billed recipients recorded
        // 'failed' for lack of an address), mirroring the success-branch wording —
        // otherwise they're silently under-reported.
        const noEmailSuffix = noEmail > 0 ? ` ${noEmail} had no email on file.` : '';
        toast('error', `${emailedOk} sent; ${emailErr} email(s) failed.${noEmailSuffix} Fix and click Send again to retry.`);
      } else if (emailedOk === 0) {
        // No email actually went out (every billed customer lacks an email on
        // file). Surface this as a warning — NOT a "sent" success — so the user
        // doesn't believe the customer was notified (Codex #40 P3). Reset the key:
        // there is nothing to retry-dedupe (no send succeeded), and the recorded
        // 'failed' rows already show who had no email.
        resetPreNoticeKey();
        toast('error', `No email sent — ${noEmail} billed customer(s) have no email on file. Add an email and try again.`);
      } else {
        // Clean success — reset the key so the NEXT distinct action gets a fresh
        // key. The guard against an ACCIDENTAL duplicate is the warning modal (#40
        // MED): a re-send is relabelled + warns "will notify a second time" and only
        // proceeds on an explicit "Re-send Anyway" click. Keeping the key stable here
        // would instead make a DELIBERATE re-send silently de-dupe at the edge (no
        // email sent) while the UI reports success (Codex #40-fix P2) — so reset it
        // and let the modal, not the key, prevent the unintended re-fire.
        resetPreNoticeKey();
        if (noEmail > 0) {
          toast('success', `Pre-notification sent to ${emailedOk} customer(s). ${noEmail} had no email on file (logged as failed).`);
        } else {
          toast('success', `Pre-notification sent to ${emailedOk} customer(s).`);
        }
      }
      await loadJobNotifications();
    } catch (err) {
      // Keep the key so a retry de-dupes the recorded log on the same intent.
      let msg = err instanceof Error ? err.message : 'Failed to send pre-notification';
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) msg = 'Only admin or sales can send notifications.';
      else if (hasRpcCode(err, RpcErrorCodes.JOB_NOT_PRE_NOTIFIABLE)) msg = 'A pre-notification can only be sent on a scheduled or in-progress job.';
      toast('error', msg);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'send_pre_notification', jobId: id } });
    } finally {
      setSendingPreNotice(false);
    }
  };

  // Send an after-application post-notification to the job's resolved share
  // customer(s). Close mirror of handleSendPreNotification — same RECORD -> SEND ->
  // CONFIRM flow, same fail-closed gating on a successfully-loaded log, same
  // save-first guard, same deterministic per-recipient idempotency. Differs only in
  // the RPC (record_job_post_notifications), the template setting key, and the
  // honest error mapping for the post lifecycle gate.
  const handleSendPostNotification = async () => {
    if (isNew || !id) return;
    // FAIL CLOSED: never decide first-send vs re-send off a log we haven't
    // SUCCESSFULLY read (a failed load reads as "0 sent" and would skip the re-send
    // warning). Require a confirmed load — the button is also disabled in both cases.
    if (loadingNotifications || !notificationsLoaded) {
      toast('error', 'Could not load the notification log yet — reload the page before sending, so an already-sent notice is not duplicated.');
      return;
    }
    // The subject/body are built from CURRENT form state but the RPC resolves
    // recipients from the PERSISTED job. Block on unsaved edits so we never email the
    // saved customers with in-progress (or stale) details.
    if (isDirty) {
      toast('error', 'Save the job before sending a post-notification — it must match the saved record.');
      return;
    }
    setSendingPostNotice(true);
    const key = getPostNoticeKey();
    try {
      // Resolve the editable template (criterion #4). ABORT on a failed read — a
      // null-on-error would silently fall back to the hard-coded default and email
      // the WRONG (not owner-edited) wording. A genuinely-absent row (no error, data
      // null) correctly uses the default.
      const { data: tplRow, error: tplErr } = await supabase
        .from('app_settings')
        .select('setting_value')
        .eq('setting_key', 'post_application_notice_template')
        .maybeSingle();
      if (tplErr) throw new Error(`Could not load the post-notification message: ${tplErr.message}`);
      const template = parsePostNotificationTemplate((tplRow as { setting_value?: string } | null)?.setting_value ?? null);

      // Render once with the primary customer's name for the recorded log subject/
      // message; per-recipient bodies are re-rendered with each farm name below.
      const primaryFarm = customers.find((c) => c.id === customerId)?.farm_name ?? '';
      const recorded = renderPostNotification(template, {
        customer: primaryFarm,
        jobNumber,
        jobDate,
      });

      // 1) Record the per-recipient log (admin/sales only; resolves recipients).
      const rpcRes = await supabase.rpc('record_job_post_notifications', {
        p_job_id: id,
        p_subject: recorded.subject,
        p_message: recorded.body,
        p_performed_by: profile?.id ?? undefined,
        p_idempotency_key: key,
      });
      // Throw the RPC error FIRST so the machine-readable code reaches the hasRpcCode
      // branches below (asserting null data on a raise would swallow it generically).
      if (rpcRes.error) throw rpcRes.error;
      const result = assertRpcResult<{
        success: boolean;
        recipients_with_email: number;
        recipients_without_email: number;
        recipients: Array<{
          notification_id: string;
          customer_id: string;
          farm_name: string | null;
          email: string | null;
          has_email: boolean;
          email_idempotency_key: string | null;
        }>;
      }>(rpcRes.data, 'record_job_post_notifications');

      // 2) Send the actual email to each recipient WITH an email; confirm -> 'sent'
      // only on success.
      let emailedOk = 0;
      let emailErr = 0;
      for (const r of result.recipients) {
        if (!r.has_email || !r.email) continue;
        if (!r.email_idempotency_key) {
          // codex-driven hunt cycle 7 — fail-closed (matches FieldApplicationInvoice):
          // a recipient WITH an email must carry a deterministic edge idempotency key.
          // Without one, SKIP (logged 'failed') rather than send with no key — a retry
          // would otherwise double-send this customer's post-application notice.
          emailErr += 1;
          Sentry.captureMessage('job post-notification recipient missing email_idempotency_key', { level: 'warning', extra: { jobId: id, customerId: r.customer_id } });
          continue;
        }
        try {
          const rendered = renderPostNotification(template, {
            customer: r.farm_name ?? primaryFarm,
            jobNumber,
            jobDate,
          });
          const payload = buildPostNotificationEmailPayload({
            customerEmail: r.email,
            customerId: r.customer_id,
            jobId: id,
            subject: rendered.subject,
            body: rendered.body,
          });
          // Deterministic edge idempotency key from the RPC (NOT Date.now()): a retry
          // reuses it so the edge fn de-dupes the same recipient's send.
          // Guaranteed present by the fail-closed guard above.
          payload.idempotency_key = r.email_idempotency_key;
          await sendEmail(payload);
          // Flip THIS row failed -> sent now that the email actually went out, and
          // store the EXACT per-recipient text emailed. confirm_job_notification_sent
          // is REUSED from #40 (notification_type-agnostic).
          const confirmRes = await supabase.rpc('confirm_job_notification_sent', {
            p_notification_id: r.notification_id,
            p_subject: rendered.subject,
            p_message: rendered.body,
            p_performed_by: profile?.id ?? undefined,
          });
          if (confirmRes.error) throw confirmRes.error;
          assertRpcResult(confirmRes.data, 'confirm_job_notification_sent');
          emailedOk += 1;
        } catch (sendErr) {
          // Row stays 'failed' — honest. Keep the action key so a retry de-dupes.
          emailErr += 1;
          Sentry.captureException(sendErr instanceof Error ? sendErr : new Error(String(sendErr)), { extra: { context: 'send_post_notification_email', jobId: id, customerId: r.customer_id } });
        }
      }

      if (profile) {
        logActivity({ event: 'job_post_notification_sent', description: `Post-application notice for job ${jobNumber}: ${result.recipients_with_email} recipient(s) with email, ${emailedOk} emailed`, performedBy: profile.id, entityType: 'job', entityId: id });
      }

      const noEmail = result.recipients_without_email;
      if (emailErr > 0) {
        // Do NOT reset the key — a retry reuses it so already-sent recipients de-dupe.
        const noEmailSuffix = noEmail > 0 ? ` ${noEmail} had no email on file.` : '';
        toast('error', `${emailedOk} sent; ${emailErr} email(s) failed.${noEmailSuffix} Fix and click Send again to retry.`);
      } else if (emailedOk === 0) {
        // No email actually went out (every billed customer lacks an email on file).
        // Surface as a warning — NOT a "sent" success. Reset the key: nothing to
        // retry-dedupe, and the recorded 'failed' rows already show who had no email.
        resetPostNoticeKey();
        toast('error', `No email sent — ${noEmail} billed customer(s) have no email on file. Add an email and try again.`);
      } else {
        // Clean success — reset the key so the NEXT distinct action gets a fresh key.
        // The guard against an ACCIDENTAL duplicate is the warning modal (a re-send is
        // relabelled + warns "will notify a second time" and only proceeds on an
        // explicit "Re-send Anyway" click).
        resetPostNoticeKey();
        if (noEmail > 0) {
          toast('success', `Post-notification sent to ${emailedOk} customer(s). ${noEmail} had no email on file (logged as failed).`);
        } else {
          toast('success', `Post-notification sent to ${emailedOk} customer(s).`);
        }
      }
      await loadJobNotifications();
    } catch (err) {
      // Keep the key so a retry de-dupes the recorded log on the same intent.
      let msg = err instanceof Error ? err.message : 'Failed to send post-notification';
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) msg = 'Only admin or sales can send notifications.';
      else if (hasRpcCode(err, RpcErrorCodes.JOB_NOT_POST_NOTIFIABLE)) msg = 'A post-notification can only be sent on a completed or invoiced job.';
      toast('error', msg);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'send_post_notification', jobId: id } });
    } finally {
      setSendingPostNotice(false);
    }
  };

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
        try { await stampJobPrinted(id); } catch { /* non-blocking */ }
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

  // Generate the Applicator Field Sheet packet in the chosen format. Built from
  // the SAVED job (blocked while dirty, like the WPS notice) so the printed
  // figures match the persisted record. Fields print IN ROUTE ORDER (sort_order).
  const handleGenerateSheet = async ({ format, options }: ApplicatorPrintSelection) => {
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

      const printableData = !isNew && id
        ? await prepareApplicatorSheetPrintData(id, sheetData, options)
        : sheetData;
      await generateApplicatorSheetPdf(printableData, format, customCfg, {
        includeBillingSplits: options.includeBillingSplits,
        blankSections: options.blankSections,
        includePreviousApplications: options.includePreviousApplications,
        showBanner: options.showBanner,
      });

      // Stamp printed status + who (ChemMan "Printed" column). Best-effort.
      if (!isNew && id) {
        try { await stampJobPrinted(id); } catch { /* non-blocking */ }
      }
      if (profile) logActivity({ event: 'applicator_sheet_printed', description: `${SHEET_FORMAT_LABELS[format]} generated for job ${jobNumber}`, performedBy: profile.id, entityType: 'job', entityId: id });
      setPrintOptionsOpen(false);
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
        try { await stampJobPrinted(id); } catch { /* non-blocking */ }
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
      // Saved jobs always go through the shared fetcher. It resolves a selected
      // saved worksheet first (or the untouched legacy fields when none is
      // selected), so the detail print and Jobs-list bulk print cannot diverge.
      if (!isNew && id) {
        const [savedWorksheetData] = await fetchLoaderWorksheetData([id]);
        if (!savedWorksheetData) {
          toast('error', 'Could not load the saved loader worksheet for printing.');
          setPrintingLoader(false);
          return;
        }
        await generateLoaderWorksheetPdf({ ...savedWorksheetData, display_mode: loaderDisplayMode });
      } else {
        // A brand-new, unsaved job still prints exactly from its form state.
        let loaderCustomers: ApplicatorSheetData['customers'] = [];
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
        await generateLoaderWorksheetPdf({
          job_number: jobNumber || 'draft',
          customers: loaderCustomers,
          scheduled_date: jobDate,
          scheduled_time: scheduledTime || null,
          applicator_name: applicators.find((a) => a.id === applicatorId)?.full_name || null,
          vehicle_name: selectedVehicle?.vehicle_name || savedVehicleName || null,
          total_acres: totalAcres,
          // Pass the raw carrier rate so the PDF matches the in-page preview.
          carrier_rate_gpa: !Number.isNaN(parsedCarrierRate) && parsedCarrierRate > 0 ? parsedCarrierRate : null,
          tank_capacity: effectiveCapacity,
          capacity_unit: (tankCapacity.trim() !== '' && effectiveCapacity === overrideCapacity) ? 'gal' : (assignedVehicleCapacityUnit || 'gal'),
          products: chemRows
            .filter((c) => c.product_id)
            .map((c) => ({
              product_name: c.product_name || 'Product',
              total_quantity: c.quantity.trim() === '' ? null : parseFloat(c.quantity),
              unit: c.unit || null,
            })),
          loader_comment: loaderComment || null,
        });
      }

      // Stamp printed status + who (ChemMan "Printed" column). Best-effort.
      if (!isNew && id) {
        try { await stampJobPrinted(id); } catch { /* non-blocking */ }
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
  // U3 (#52): optional per-acre machine fee (e.g. Hagie Y-Drop). NULL = no service fee.
  const [applicationServiceId, setApplicationServiceId] = useState<string | null>(null);
  // U3 follow-up (Codex P2): true only while the current applicationServiceId came
  // from a customer's default, not the user's hand. An auto-filled value must be
  // RE-evaluated when the customer changes (a manual pick is never clobbered).
  const svcAutoFilledRef = useRef(false);
  const [notes, setNotes] = useState('');
  const [batchId, setBatchId] = useState('');
  const [quoteLinkage, setQuoteLinkage] = useState<{ quote_id: string; quote_number: string; section_name: string } | null>(null);

  // Sub-collections
  const [fieldRows, setFieldRows] = useState<FieldRow[]>([]);
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);
  const [growerShareFieldNames, setGrowerShareFieldNames] = useState<string[]>([]);
  // Field-app parity #5: index of the field row currently being dragged to set
  // the applicator route order (null when no drag is in progress).
  const [dragFieldIndex, setDragFieldIndex] = useState<number | null>(null);
  const [chemRows, setChemRows] = useState<ChemRow[]>([]);
  // §5 (Label-Rate Guardrails): policy mode (warn default, never blocks) + earliest
  // planned harvest across the job's fields (for the PHI-vs-harvest warning) + the
  // block-mode admin-override modal state.
  const [guardrailMode, setGuardrailMode] = useState<GuardrailMode>(DEFAULT_GUARDRAIL_MODE);
  // §5 (Codex r6): the block-mode save gate FAILS CLOSED until BOTH the mode read AND the
  // by-id label fetch resolve, so an early Save can't slip an over-label line past block mode.
  const [guardrailModeLoaded, setGuardrailModeLoaded] = useState(false);
  const [jobLabelsLoaded, setJobLabelsLoaded] = useState(false);
  const [jobEarliestHarvestDate, setJobEarliestHarvestDate] = useState<string | null>(null);
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  // §5 (Codex follow-up): carries the confirmed over-label override reason ACROSS the
  // separate license-override confirmation round-trip, so an over-label job that ALSO needs
  // a license override still records its label-rate audit on the eventual save. Null when
  // there's no pending label override.
  const pendingOverrideReasonRef = useRef<string | null>(null);
  // §5: label max per product for the lines ON THIS JOB — fetched by product_id WITHOUT an
  // is_active filter (Codex P2), so a now-INACTIVE product on a saved job still gets its
  // label max for the guardrail (allProducts is active-only). Authoritative over allProducts.
  //
  // Also carries product_form, for the same reason and a sharper one (Codex P2, 2026-08-23):
  // the form picks which conversion table fieldAppPricedQuantity uses, so a MISSING form
  // silently takes the liquid branch. On a discontinued DRY product that turns a correctly
  // carried line (1 oz/ac × 100 ac stored as 6.25 lb) into one that cannot be proven safe —
  // and chemLineBillingHazard fails closed, so the whole job becomes unsaveable. Resolving
  // the form by id, inactive included, is what keeps the guard from firing on good rows.
  const [jobProductLabels, setJobProductLabels] = useState<Map<string, { max_label_rate: number | null; max_label_rate_unit: string | null; product_form: 'liquid' | 'dry' | null }>>(new Map());
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);

  useEffect(() => {
    supabase.from('unit_conversions').select('*').order('unit').then(({ data, error }) => {
      if (error) return;
      setUnitConversions((data || []) as UnitConversion[]);
    });
  }, []);
  // Per-field customer shares, keyed by field. Empty until a field is added /
  // shares are loaded — then defaulted from field_billing_defaults.
  const [shareRows, setShareRows] = useState<ShareRow[]>([]);
  // FIX 3 (Wave 2b): field_ids whose customer-share defaults are still being looked
  // up (async seedSharesForField). A save while a selected field is still loading
  // would see an EMPTY shareRows for it, pass sharesValid (no shares = OK), and send
  // an empty field_shares array — so save_job persists NO frozen split snapshot for a
  // split-billed field. Block save until every selected field's shares have resolved.
  const [sharesLoading, setSharesLoading] = useState<Set<string>>(new Set());

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
  // P2-4: crop-program templates loadable into the job chemicals (append-only).
  const [cropPrograms, setCropPrograms] = useState<CropProgram[]>([]);
  const [showProgramModal, setShowProgramModal] = useState(false);
  const [selectedProgramId, setSelectedProgramId] = useState('');
  const [loadingProgram, setLoadingProgram] = useState(false);
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
    customerId, jobDate, scheduledTime, applicatorId, vehicleId, applicationServiceId, notes, batchId,
    callDate, dateProposed, timeProposed, scheduleDate, dateExpires, consultantId, groundCrewId,
    loaderComment, additionalInfo, internalMemo, carrierRateGpa, tankCapacity,
    fieldRows, chemRows, shareRows,
  }), [customerId, jobDate, scheduledTime, applicatorId, vehicleId, applicationServiceId, notes, batchId,
       callDate, dateProposed, timeProposed, scheduleDate, dateExpires, consultantId, groundCrewId,
       loaderComment, additionalInfo, internalMemo, carrierRateGpa, tankCapacity,
       fieldRows, chemRows, shareRows]);

  // §5: load the earliest planned harvest date across the job's fields, SCOPED to the
  // job-date's season (field_crop_history holds one row per field/season, so without the
  // season filter an old prior-season harvest would falsely trip the PHI window). Re-runs
  // when the field set OR the job date changes. No harvest row => no warning (graceful).
  const jobFieldKey = fieldRows.map((f) => f.field_id).filter(Boolean).sort().join(',');
  useEffect(() => {
    let cancelled = false;
    const fieldIds = jobFieldKey ? jobFieldKey.split(',') : [];
    if (fieldIds.length === 0) { setJobEarliestHarvestDate(null); return; }
    const season = computeSeason(jobDate ? new Date(jobDate + 'T00:00:00') : new Date());
    (async () => {
      const { data, error } = await supabase
        .from('field_crop_history')
        .select('harvest_date')
        .in('field_id', fieldIds)
        .eq('season', season)
        .not('harvest_date', 'is', null)
        .order('harvest_date', { ascending: true })
        .limit(1);
      if (cancelled) return;
      if (error) { setJobEarliestHarvestDate(null); return; }
      setJobEarliestHarvestDate((data as Array<{ harvest_date: string | null }> | null)?.[0]?.harvest_date ?? null);
    })();
    return () => { cancelled = true; };
  }, [jobFieldKey, jobDate]);

  // §5 (Codex P2): fetch the label max for THIS job's chemical products by id (no is_active
  // filter) so an inactive product still has its max for the rate-vs-max guardrail. Re-runs
  // when the set of product ids on the lines changes. A failed fetch => empty map (the row
  // falls back to allProducts, then degrades to "no label max" — never blocks/errors).
  const chemProductIdKey = Array.from(new Set(chemRows.map((c) => c.product_id).filter(Boolean))).sort().join(',');
  useEffect(() => {
    let cancelled = false;
    const ids = chemProductIdKey ? chemProductIdKey.split(',') : [];
    if (ids.length === 0) { setJobProductLabels(new Map()); setJobLabelsLoaded(true); return; }
    setJobLabelsLoaded(false);
    (async () => {
      const { data, error } = await supabase
        .from('products')
        .select('id, max_label_rate, max_label_rate_unit, product_form')
        .in('id', ids);
      if (cancelled) return;
      if (error) { setJobProductLabels(new Map()); setJobLabelsLoaded(true); return; }
      const m = new Map<string, { max_label_rate: number | null; max_label_rate_unit: string | null; product_form: 'liquid' | 'dry' | null }>();
      for (const p of (data as unknown as Array<{ id: string; max_label_rate: number | null; max_label_rate_unit: string | null; product_form: string | null }> | null) ?? []) {
        m.set(p.id, {
          max_label_rate: p.max_label_rate,
          max_label_rate_unit: p.max_label_rate_unit,
          product_form: p.product_form === 'liquid' || p.product_form === 'dry' ? p.product_form : null,
        });
      }
      setJobProductLabels(m);
      setJobLabelsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [chemProductIdKey]);

  // §5: resolve a line's label max — the by-id fetch (inactive-safe) wins, then allProducts.
  const labelMaxFor = useCallback((productId: string): { max_label_rate: number | null; max_label_rate_unit: string | null } => {
    const fromJob = jobProductLabels.get(productId);
    if (fromJob) return fromJob;
    const lp = allProducts.find((p) => p.id === productId);
    return { max_label_rate: lp?.max_label_rate ?? null, max_label_rate_unit: lp?.max_label_rate_unit ?? null };
  }, [jobProductLabels, allProducts]);

  // Resolve a line's liquid/dry form the same inactive-safe way: the by-id fetch wins, then
  // allProducts. Every caller that feeds a UNIT CONVERSION must come through here — reading
  // allProducts directly is what mis-classified discontinued products (Codex P2, 2026-08-23).
  const productFormFor = useCallback((productId: string): 'liquid' | 'dry' | null => {
    const fromJob = jobProductLabels.get(productId);
    if (fromJob) return fromJob.product_form;
    const form = allProducts.find((p) => p.id === productId)?.product_form ?? null;
    return form === 'liquid' || form === 'dry' ? form : null;
  }, [jobProductLabels, allProducts]);

  // §5: aggregate guardrail state from chemRows + allProducts (the live label max). Drives
  // the BLOCK-mode save gate — computed here in the page so it's correct regardless of the
  // active tab. 'cannot_compare' / 'no_label_max' never count toward the gate.
  const guardrailState = useMemo(() => {
    const overRateProducts: string[] = [];
    let phiHarvestWarnCount = 0;
    for (const c of chemRows) {
      if (!c.product_id) continue;
      const lbl = labelMaxFor(c.product_id);
      const cmp = compareToMaxRate(parseFloat(c.rate_per_acre) || null, c.rate_unit, lbl.max_label_rate, lbl.max_label_rate_unit);
      if (cmp.status === 'over') overRateProducts.push(c.product_name || allProducts.find((p) => p.id === c.product_id)?.product_name || 'Unnamed product');
      if (phiHarvestWarning(parseFloat(c.phi_days) || null, jobEarliestHarvestDate, jobDate).status === 'inside_window') {
        phiHarvestWarnCount += 1;
      }
    }
    return { overRateCount: overRateProducts.length, overRateProducts, phiHarvestWarnCount };
  }, [chemRows, allProducts, labelMaxFor, jobEarliestHarvestDate, jobDate]);

  // BILLING-HAZARD GUARD. A row whose quantity is counted in the RATE's unit but priced per a
  // DIFFERENT `unit` invoices wrong by exactly their ratio, because transfer_job_to_invoice
  // multiplies quantity × price_per_unit_cents with NO conversion. The live trigger is a
  // 'Dry oz' rate on pound stock (75 live products): reconcileChemAutofillUnits cannot size
  // 'dry oz' in DRY_TO_POUNDS, falls back to keeping the pound price, and the line bills 16×.
  // Keyed by row index so the grid can mark the exact offending line.
  const chemBillingHazards = useMemo(() => {
    const byIndex = new Map<number, ChemBillingHazard>();
    const acres = sumAcres(fieldRows);
    chemRows.forEach((c, i) => {
      if (!c.product_id) return;
      const h = chemLineBillingHazard(c, acres, productFormFor(c.product_id));
      if (h.hazard) byIndex.set(i, h);
    });
    return byIndex;
  }, [chemRows, fieldRows, productFormFor]);

  // Rows whose numbers are not fit to save at all, for reasons the billing-hazard guard
  // does not cover. Both fail closed rather than being silently coerced:
  //  • a rate unit with a NON-ACRE denominator ('oz/cwt'): baseUnitOfRate strips everything
  //    after the first '/', so the rate is treated as per-acre and quantity = rate × acres
  //    is simply the wrong amount. The live SQL normalize_rate_unit keeps such a string whole
  //    precisely so it can never match; the client did the opposite.
  //  • a blank / non-numeric / non-finite quantity or per-unit amount: buildJobChemicalsPayload
  //    coerces these with `parseFloat(...) || 0` and `parseInt(...) || 0`, so a typo silently
  //    saves a ZERO quantity or a ZERO price — a line that bills nothing and deducts nothing.
  const chemRowDefects = useMemo(() => {
    const byIndex = new Map<number, string>();
    chemRows.forEach((c, i) => {
      if (!c.product_id) return;
      if (rateDenominatorIsUnrecognized(c.rate_unit)) {
        byIndex.set(i, `the rate unit "${c.rate_unit}" is measured per something other than acres, so a per-acre quantity cannot be derived from it`);
        return;
      }
      // BLANK UNIT on a line that BILLS. chemLineBillingHazard can only flag a PROVEN
      // mismatch, so it stays silent when either unit is blank — which made clearing a
      // unit an off switch for the guard: the warning vanished while the same quantity ×
      // price still billed (Codex High, 2026-08-24). Mirrors the server's
      // CHEM_UNIT_UNSPECIFIED refusal (PR #446), including its exemptions: a
      // customer-supplied line and a line with neither a cost nor a price contribute
      // nothing to either total, and a zero quantity bills nothing — a line that cannot
      // bill cannot bill wrongly. parseFloat('') is NaN, which fails the ≠ 0 test toward
      // BLOCKING, so an unparseable quantity stays gated (the grammar rule below also
      // refuses it on its own).
      const blankSides = chemUnitUnspecifiedSides(c.rate_unit, c.unit);
      if (blankSides
          && !(c.customer_supplied ?? false)
          && parseFloat(c.quantity) !== 0
          && ((parseInt(c.cost_per_unit_cents) || 0) !== 0 || (parseInt(c.price_per_unit_cents) || 0) !== 0)) {
        const side = blankSides.stockBlank && blankSides.rateBlank
          ? 'its Unit and its rate unit are both blank'
          : blankSides.stockBlank
            ? 'its Unit is blank'
            : 'its rate unit names no unit';
        byIndex.set(i, `${side} while the line still carries a cost or price, so there is no way to know what the quantity would be billed per — pick the unit, or clear the cost and price if the line should not bill`);
        return;
      }
      // Gate on the money helper's OWN grammar, not on Number.isFinite. They are not the
      // same test: Number('1e3') is a finite 1000, but centsTimesQuantity refuses exponent
      // notation and returns 0. Gating on the looser test let a save persist quantity 1000
      // on the line while writing 0 into jobs.total_cost_cents / total_price_cents — a
      // nonzero line behind a zero total. `<input type="number">` accepts '1e3', so this
      // is reachable by typing. One grammar, one gate. (Codex P2)
      if (!isExactDecimalText(c.quantity)) {
        byIndex.set(i, 'its quantity is blank, or is not written as a plain number, and would not be billed correctly');
        return;
      }
      // The totals above multiply the exact decimal TEXT, but buildJobChemicalsPayload
      // persists the same field as parseFloat(quantity). A quantity carrying more precision
      // than a double can hold means those two are different numbers, so the stored total
      // and the stored line disagree by a cent. Refused, not rounded. (Codex P2, 2026-08-23)
      if (!quantitySurvivesSave(c.quantity)) {
        byIndex.set(i, 'its quantity has more decimal places than can be saved exactly, so the line total and the job total would not agree — round it to 4 decimal places or fewer');
        return;
      }
      // Cents are WHOLE, so the gate has to be stricter for them than for a quantity.
      // isExactDecimalText('150.7') is true, but the saved total (parseInt, below) and
      // buildJobChemicalsPayload both TRUNCATE it to 150 — the operator's number would
      // change under them silently, visible only after a reload. Refuse it instead.
      const badCents = ([
        ['cost', c.cost_per_unit_cents],
        ['price', c.price_per_unit_cents],
      //
      // isSAFEInteger, not isInteger: Number('9007199254740993') silently rounds to
      // ...992 and still reports as an integer, so the looser check would admit a value
      // that has already lost precision before any arithmetic runs. Refusing above 2^53
      // keeps every cents amount that reaches the total exactly representable.
      ] as const).find(([, raw]) => !isExactDecimalText(raw) || !Number.isSafeInteger(Number(raw)));
      if (badCents) {
        byIndex.set(i, `its ${badCents[0]} is blank, or is not a whole number of cents, and would not be billed correctly`);
      }
    });
    return byIndex;
  }, [chemRows]);

  // SAFE-SCOPE U7: a job is "multi-owner" when its fields' billed shares span more
  // than one distinct customer — the same customer set transfer_job_to_invoice
  // bills from (job_fields <-> field_billing_defaults GROUP BY customer_id). On a
  // multi-owner job, Transfer to Invoice collapses every owner into ONE invoice
  // to the primary tenant; other owners' shares show as unpayable annotations.
  const distinctBilledCustomers = useMemo(
    () => new Set(shareRows.map((s) => s.customer_id).filter(Boolean)),
    [shareRows]
  );
  const isMultiOwner = distinctBilledCustomers.size > 1;

  // Single dirty engine: when no baseline is set yet, ADOPT the current form as the
  // clean baseline (but only once the load has settled, so we don't adopt a half-
  // populated form); thereafter compare. fetchJob / the new-job init reset the
  // baseline to null so a fresh load (or a post-save refetch) re-adopts cleanly.
  useEffect(() => {
    const snap = formSnapshot();
    if (baselineRef.current === null) {
      // Don't adopt while a refetch is still settling — a render fired between
      // fetchJob nulling the baseline and its state landing would otherwise
      // freeze the STALE form as "clean" (live bug 2026-07-11: isDirty stuck
      // true after every save until a page reload). The settle tick re-runs
      // this effect on the fully-refetched render.
      if (!loading && !baselineSettleGuardRef.current) {
        baselineRef.current = snap;
        setIsDirty(false);
      }
      return;
    }
    setIsDirty(snap !== baselineRef.current);
  }, [formSnapshot, loading, baselineSettleTick]);

  const loadLookups = useCallback(async () => {
    setFieldsLookupReady(false);
    const [custResult, fieldResult, prodResult, vehicleResult, appResult, recipeResult] = await Promise.all([
      supabase.from('customers').select('*').eq('is_active', true).order('farm_name'),
      supabase.from('fields').select('*').order('field_name'),
      supabase.from('products').select('*, product_family:product_families(name)').eq('is_active', true).order('product_name'),
      supabase.from('vehicles').select('*').eq('status', 'active').order('vehicle_name'),
      // PR-07 follow-up: applicator picker only uses a.id + a.full_name + a.role; safe via view.
      supabase.from('profile_public_view').select('id, full_name, role, is_active').in('role', ['applicator', 'admin', 'sales_rep']).eq('is_active', true).order('full_name'),
      supabase.from('blend_recipes').select('*').eq('is_active', true).order('name'),
    ]);
    setCustomers((custResult.data || []) as Customer[]);
    if (!fieldResult.error) {
      setAllFields((fieldResult.data || []) as Field[]);
      setFieldsLookupReady(true);
    }
    if (prodResult.error) {
      Sentry.captureException(prodResult.error, { tags: { source: 'fetch', action: 'load_job_products' } });
      toast('error', 'Failed to load Products. Retry before editing job chemicals.');
    }
    setAllProducts((prodResult.data || []) as unknown as PickerProduct[]);
    setVehicles((vehicleResult.data || []) as Vehicle[]);
    setApplicators((appResult.data || []) as Profile[]);
    setRecipes((recipeResult.data || []) as BlendRecipe[]);

    // Field-app parity #6: active ground crews for the crew picker.
    const crewResult = await supabase
      .from('ground_crews').select('id, name').eq('is_active', true).order('name');
    setGroundCrews((crewResult.data || []) as { id: string; name: string }[]);

    // §5: load the label-rate guardrail policy (warn default; failed/absent => warn).
    const grResult = await supabase
      .from('app_settings').select('setting_value').eq('setting_key', LABEL_RATE_GUARDRAIL_MODE_KEY).maybeSingle();
    setGuardrailMode(parseGuardrailMode((grResult.data as { setting_value?: string } | null)?.setting_value ?? null));
    setGuardrailModeLoaded(true);

    // P2-4: load reusable crop-program templates (for "Load Program" into chemicals).
    const cpResult = await supabase
      .from('app_settings').select('setting_value').eq('setting_key', 'crop_programs').maybeSingle();
    setCropPrograms(parseCropPrograms((cpResult.data as { setting_value?: string } | null)?.setting_value ?? null));

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
  }, [toast]);

  const fetchJob = useCallback(async () => {
    // Drop the baseline so the freshly-loaded form is re-adopted as clean once it
    // settles (also covers post-save refetches where loading stays false). The
    // settle guard defers adoption until this fetch's state has actually rendered.
    baselineSettleGuardRef.current = true;
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
      baselineSettleGuardRef.current = false;
      toast('error', 'Job not found');
      navigate('/jobs');
      return;
    }

    const j = data as unknown as JobDbRow;
    setJobNumber(j.job_number);
    setStatus(j.status);
    setCustomerId(j.customer_id);
    setJobDate(j.job_date);
    setSavedJobDate(j.job_date);
    setScheduledTime(j.scheduled_time || '');
    setApplicatorId(j.applicator_id || '');
    setSavedApplicatorId(j.applicator_id || null);
    setVehicleId(j.vehicle_id || '');
    // #10: keep the assigned vehicle's id + capacity from the embed (works even if
    // the vehicle is now inactive and absent from the active-only `vehicles` lookup).
    setSavedJobVehicleId(j.vehicle_id || null);
    setSavedVehicleCapacity(j.vehicle ? { name: j.vehicle.vehicle_name ?? null, gallons: j.vehicle.capacity_gallons ?? null, unit: j.vehicle.capacity_unit ?? null } : null);
    setRecipeId(j.recipe_id || '');
    setApplicationServiceId(j.application_service_id || null);
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
    setLoaderVesselId(ASSIGNED_VEHICLE_VESSEL_VALUE);
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

    // U16b: best-effort advisory before transfer. The transfer RPC remains the
    // pricing authority; a failed read simply leaves the banner hidden.
    const jobFields = j.job_fields || [];
    const jobFieldIds = Array.from(new Set(jobFields.map((field) => field.field_id).filter(Boolean)));
    if (jobFieldIds.length > 0) {
      const { data: growerShareRows, error: growerShareError } = await supabase
        .from('field_billing_defaults')
        .select('field_id')
        .in('field_id', jobFieldIds)
        .not('price_override_cents', 'is', null);
      if (growerShareError) {
        Sentry.captureException(growerShareError, { tags: { source: 'fetch', page: 'job-detail', context: 'grower_share_banner' } });
        setGrowerShareFieldNames([]);
      } else {
        const overrideIds = new Set(
          ((growerShareRows || []) as Array<{ field_id: string }>).map((row) => row.field_id),
        );
        setGrowerShareFieldNames(Array.from(new Set(
          jobFields
            .filter((field) => overrideIds.has(field.field_id))
            .map((field) => field.field?.field_name || '')
            .filter(Boolean),
        )));
      }
    } else {
      setGrowerShareFieldNames([]);
    }

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

    // F06 IS STILL OPEN, DELIBERATELY. `driver` is UI-only and never persisted, so a reloaded
    // row comes back driverless and recomputeChemRowForAcres leaves it STALE on an acreage
    // change — a saved 1.5 pt/ac line over 100 acres still reads 150 pt at 200 acres.
    //
    // An earlier pass tried to RECOVER the provenance by testing quantity == rate x acres.
    // That is unsound and was reverted: applyChemEdit back-solves rate_per_acre whenever the
    // user types a quantity, so a hand-entered total satisfies that same equality BY
    // CONSTRUCTION. The test cannot separate the two cases, and acting on it would rewrite a
    // hand-entered total whenever acreage changed — the exact harm the driverless branch
    // exists to prevent. Under-billing is bad; silently rewriting an operator's typed
    // chemical amount is worse, so leaving the row as saved is the safe side. (Codex P1)
    //
    // The real fix is to PERSIST the driver on job_chemicals, which needs a migration.
    setChemRows(
      (j.job_chemicals || []).map((c) => {
        const quantity = c.quantity?.toString() || '0';
        const rate_per_acre = c.rate_per_acre?.toString() || '';
        return {
          id: c.id,
          product_id: c.product_id,
          product_name: c.product?.product_name || '',
          quantity,
          unit: c.unit || '',
          rate_per_acre,
          rate_unit: c.rate_unit || '',
          cost_per_unit_cents: c.cost_per_unit_cents?.toString() || '0',
          price_per_unit_cents: c.price_per_unit_cents?.toString() || '0',
          diluent_rate: c.diluent_rate?.toString() || '',
          rei_hours: c.rei_hours?.toString() || '',
          phi_days: c.phi_days?.toString() || '',
          warehouse: c.warehouse || '',
          vendor: c.vendor || '',
          customer_supplied: c.customer_supplied ?? false,
          sort_order: c.sort_order,
        };
      })
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
    // Everything this fetch sets is now queued in THIS batch — drop the guard and
    // tick so the dirty engine adopts the baseline on the settled render.
    baselineSettleGuardRef.current = false;
    setBaselineSettleTick((t) => t + 1);
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
        setGrowerShareFieldNames([]);
        setLoaderVesselId(ASSIGNED_VEHICLE_VESSEL_VALUE);
        setTankCapacity('');
        const { data, error } = await supabase.rpc('next_job_number');
        if (!error && data) setJobNumber(assertRpcResult<string>(data, 'next_job_number'));
        const recipeParam = searchParams.get('recipe_id');
        if (recipeParam) setRecipeId(recipeParam);
        // New job: loading is already false; the loading-settle effect arms
        // initialLoadDone after the first committed frame.
      }
    })();
  }, [id, fetchJob, isNew, loadLookups, searchParams]);

  // U12 Codex R3 #2: does the current APPLICATOR hold an active ('dispatched')
  // job_location_dispatches row on this job? The assignment-unification migration
  // authorizes such a dispatchee to start/complete server-side, so the UI gate
  // must match. The probe deliberately has NO applicator_id filter (A3), so a
  // CREW-member dispatch also lights the gate: RLS scopes the read to the caller's
  // own rows + their active crew's rows, and start_job (via _is_dispatched_to_me's
  // crew branch) and complete_job (direct ground_crew_members check) authorize
  // crew members server-side. Best-effort: any error leaves the gate false (office
  // roles never depend on it, and the RPC stays authoritative for the stricter
  // rules either way).
  useEffect(() => {
    setHasActiveDispatch(false);
    if (isNew || !id || !profile?.id || role !== 'applicator') {
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await supabase
        .from('job_location_dispatches')
        .select('id')
        .eq('job_id', id)
        .eq('dispatch_status', 'dispatched')
        .limit(1);
      if (!cancelled) setHasActiveDispatch(!res.error && (res.data?.length ?? 0) > 0);
    })();
    return () => { cancelled = true; };
  }, [id, isNew, profile, role]);

  // Field-app parity #16: keep the active tab in sync with the ?tab= param AFTER mount.
  // The useState initializer only reads ?tab= once, so a same-route param change (e.g.
  // clicking the Jobs-list "Map / Logs" action while already on this job) wouldn't switch
  // tabs. This effect applies a valid tab param whenever it changes; an absent/invalid
  // param leaves the current tab untouched (no snap-back to 'locations' on unrelated
  // param changes like recipe_id).
  useEffect(() => {
    const t = searchParams.get('tab');
    const valid: TabKey[] = ['locations', 'chemicals', 'loader', 'applied', 'map_logs', 'notifications'];
    if (t && (valid as string[]).includes(t)) {
      setActiveTab(t as TabKey);
    }
  }, [searchParams]);

  // Computed
  const customerFields = allFields.filter(f => !customerId || f.customer_id === customerId);
  const jobPickerBillableAcresById = useMemo(
    () => new Map(allFields.map((field) => [field.id, billableAcres(field.override_acres, field.measured_acres, field.total_acres)])),
    [allFields],
  );
  const totalAcres = fieldRows.reduce((sum, f) => sum + (parseFloat(f.acres_to_treat) || 0), 0);
  // #53/#54: a customer-supplied product is applied but not billed and cost us
  // nothing — it contributes 0 to both job totals (mirrors the server's $0 line).
  // EXACT MONEY. These two totals are SAVED (jobs.total_cost_cents / total_price_cents at
  // the save_job call below), so they are authoritative, not display. They previously
  // multiplied in binary floating point, which disagrees with the server's exact numeric
  // `safe_cents_qty` whenever the true product lands on a half cent — e.g. 25c x 0.58 is
  // exactly 14.50, which the server rounds to 15c while Math.round(0.58 * 25) gives 14c.
  // centsTimesQuantity reproduces safe_cents_qty exactly (see money.ts).
  const totalCostCents = chemRows.reduce((sum, c) => sum + (c.customer_supplied ? 0 : centsTimesQuantity(parseInt(c.cost_per_unit_cents) || 0, c.quantity)), 0);
  const totalPriceCents = chemRows.reduce((sum, c) => sum + (c.customer_supplied ? 0 : centsTimesQuantity(parseInt(c.price_per_unit_cents) || 0, c.quantity)), 0);

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
  const loaderVesselOptions = useMemo(() => buildLoaderVesselOptions(vehicles), [vehicles]);
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

  // Field-app parity #40: load the customer notification log when the
  // Notifications tab is first opened for a saved job.
  useEffect(() => {
    if (activeTab === 'notifications' && !isNew && id) {
      void loadJobNotifications();
    }
  }, [activeTab, isNew, id, loadJobNotifications]);

  // Codex #40 re-review P1: the pre-notice idempotency key is intentionally KEPT on
  // a failed send (for retry), but useIdempotencyKey stores it in a ref that
  // survives while JobDetail stays mounted across /jobs/:id navigation. Reset it
  // when the job id changes so a send on a DIFFERENT job can never replay the prior
  // job's cached recipient list / confirm the prior job's rows.
  useEffect(() => {
    resetPreNoticeKey();
  }, [id, resetPreNoticeKey]);

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

  // FIX 3: a selected field whose share defaults are still loading is NOT yet
  // save-ready (an empty shareRows for it would slip past sharesValid and persist
  // no split snapshot). Block the save until those lookups resolve.
  const selectedFieldSharesLoading = anySelectedFieldSharesLoading(fieldRows, sharesLoading);

  // §5: the save gate. WARN mode (default) is a straight pass-through — an over-label rate
  // is flagged on the grid but NEVER blocks the save. BLOCK mode (owner opt-in) opens the
  // admin-override modal (admins only) so the save proceeds only with a LOGGED reason; a
  // non-admin is told to fix the rate (no silent corruption).
  const handleSave = async () => {
    // §5 (Codex r6): FAIL CLOSED while the guardrail mode / by-id label data are still
    // loading and the mix has products — an early Save must not skip a block-mode override.
    if (chemRows.some((c) => c.product_id) && (!guardrailModeLoaded || !jobLabelsLoaded)) {
      toast('error', 'Checking the label-rate policy — try Save again in a moment.');
      return;
    }
    // FAIL CLOSED on a proven unit mismatch. There is NO admin override here: unlike an
    // over-label rate (a judgement call an admin may own), this line is arithmetically
    // wrong — its quantity is counted in one unit and priced per another, so saving it
    // can only produce a wrong invoice and a wrong applied amount. Blocked for customer-
    // supplied lines too: they bill nothing, but the dose still reaches the applicator's
    // field sheet, and a 16x dose is an over-application hazard in its own right.
    if (chemBillingHazards.size > 0) {
      const [firstIndex, first] = [...chemBillingHazards.entries()][0];
      const name = chemRows[firstIndex]?.product_name
        || allProducts.find((p) => p.id === chemRows[firstIndex]?.product_id)?.product_name
        || 'A chemical line';
      const overBy = first.billedRatio && first.billedRatio > 1
        ? ` — it would bill about ${fmt4(first.billedRatio)}x too much`
        : '';
      toast('error',
        `${chemBillingHazards.size} chemical line(s) cannot be saved. On the Chemicals tab, "${name}" ` +
        `has a quantity counted in ${first.quantityUnit} but a price quoted per ${first.priceUnit}${overBy}. ` +
        // Must match the on-row banner EXACTLY in substance. An earlier version of this toast
        // still carried the relabel-only remedy after the banner had been corrected, which
        // handed the operator a working bypass at the very moment they were blocked: changing
        // rate_unit alone makes the units match and silences the guard while the quantity and
        // price stay put, saving the identical over-charge in silence. (Codex, 2026-08-20)
        `Set the line's Unit to ${first.quantityUnit} (and its cost/price per ${first.quantityUnit}). ` +
        `If the rate really is in ${first.priceUnit}, change the rate unit to ${first.priceUnit}/ac ` +
        `AND re-enter the rate so the quantity is recalculated — relabelling the unit on its own ` +
        `does not change the amount, and would bill the same wrong total silently.`,
      );
      return;
    }
    if (chemRowDefects.size > 0) {
      const [firstIndex, reason] = [...chemRowDefects.entries()][0];
      const name = chemRows[firstIndex]?.product_name
        || allProducts.find((p) => p.id === chemRows[firstIndex]?.product_id)?.product_name
        || 'A chemical line';
      toast('error',
        `${chemRowDefects.size} chemical line(s) cannot be saved. On the Chemicals tab, ` +
        `"${name}" cannot be saved because ${reason}. Fix it and save again.`,
      );
      return;
    }
    if (guardrailMode === 'block' && guardrailState.overRateCount > 0) {
      if (role !== 'admin') {
        toast('error',
          `${guardrailState.overRateCount} chemical line(s) exceed the product's max label rate ` +
          `(${guardrailState.overRateProducts.join(', ')}). An admin must override to save — ` +
          `lower the rate or ask an admin.`,
        );
        return;
      }
      setOverrideReason('');
      setShowOverrideModal(true);
      return;
    }
    await runJobSave();
  };

  // §5: admin confirms the block-mode override. The reason is carried INTO the save and the
  // audit row is written only AFTER the save SUCCEEDS, linked to the real saved job id
  // (Codex follow-up P2). Writing it up front orphaned a 'they overrode' row whenever the
  // save then failed (shares ≠ 100%, missing customer, RPC error) and was retried.
  const handleOverrideConfirm = async () => {
    if (!profile) return;
    const reason = overrideReason.trim();
    if (reason === '') { toast('error', 'Enter a reason for the over-label-rate override.'); return; }
    setShowOverrideModal(false);
    setOverrideReason('');
    await runJobSave(reason);
  };

  // §5: after a SUCCESSFUL save, write the override audit linked to the real saved job id.
  //
  // DELIBERATE TRADE-OFF (owner-directed; do not "fix" to atomic without that direction):
  // the audit is written AFTER the save so a FAILED/retried save never orphans a phantom
  // override row (the bug this replaced). The flip side is that if the save succeeds but
  // THIS insert then fails (RLS/network), the job is already committed and can't be undone
  // client-side. We do NOT swallow it: a LOUD toast + error-level Sentry make the gap
  // visible so an admin can re-record it. True atomicity would require moving the audit
  // INTO the frozen save_job RPC (a server migration) — out of scope for this UI fix.
  const writeOverrideAudit = async (reason: string, savedJobId: string | null) => {
    if (!profile) return;
    const description =
      `Admin override of over-label-rate guardrail (block mode) on job ${jobNumber || savedJobId || 'new'}. ` +
      `Over-rate product(s): ${guardrailState.overRateProducts.join(', ')}. Reason: ${reason}`;
    const logResult = await supabase.from('activity_feed').insert({
      event_type: 'label_rate_override',
      description,
      performed_by: profile.id,
      related_entity_type: 'job',
      related_entity_id: savedJobId,
    });
    if (logResult.error) {
      Sentry.captureException(logResult.error, { level: 'error', extra: { context: 'label_rate_override_log_job', job_id: savedJobId } });
      toast('error', `The job saved, but the over-label-rate override reason could NOT be recorded — tell an admin: ${sanitizeError(logResult.error)}`);
    }
  };

  const runJobSave = async (overrideReasonForAudit?: string) => {
    saveJobIdem.resetKey();
    // Second layer of the billing-hazard guard. handleSave already blocks this and is the
    // only path a user can reach today, but runJobSave is the chokepoint EVERY save funnels
    // through (including the admin over-label-rate override), so the arithmetic guarantee
    // lives here too: no future caller can route around it.
    if (chemBillingHazards.size > 0) {
      toast('error', 'A chemical line is counted in one unit but priced per another — fix the highlighted line before saving.');
      return;
    }
    if (chemRowDefects.size > 0) {
      toast('error', 'A chemical line has a unit or a number that cannot be saved — fix the highlighted line before saving.');
      return;
    }
    // The SUMMED totals get their own gate. Every per-line cents amount is individually
    // safe-integer-checked in chemRowDefects, but a line EXTENSION (cents × quantity) or
    // the sum of extensions can still pass 2^53 − 1, where Number arithmetic silently
    // lands on a neighbouring cent — and centsTimesQuantity now reports its own overflow
    // as NaN for the same reason. Either way these two numbers are about to be SAVED as
    // jobs.total_cost_cents / total_price_cents, so a total that is not an exact integer
    // is refused, never rounded. (Codex Medium, 2026-08-24)
    if (!Number.isSafeInteger(totalCostCents) || !Number.isSafeInteger(totalPriceCents)) {
      toast('error', 'The job total is too large to save exactly — check the chemical quantities and per-unit amounts for a typo.');
      return;
    }
    if (!customerId) { toast('error', 'Customer is required'); return; }
    if (!jobDate) { toast('error', 'Job date is required'); return; }
    if (selectedFieldSharesLoading) {
      toast('error', 'Field shares are still loading — try again in a moment.');
      return;
    }
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
          // §5: stash the label-override reason so confirming the license modal still
          // records the audit (the modal's performSave(true) reads this ref).
          pendingOverrideReasonRef.current = overrideReasonForAudit ?? null;
          setShowLicenseOverrideConfirm(true);
        } else {
          toast('error', "This applicator's license has expired — an admin can override if needed.");
        }
        return;
      }
    }

    await performSave(false, overrideReasonForAudit);
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

  // U13 (#15-21/#111): open the Dispatch Board wizard SCOPED to just this job's
  // locations, pre-selected. Requires a SAVED, non-dirty job — the wizard needs
  // real job_fields.id values (only exist after save_job has run), and any
  // unsaved edit could change which locations should be offered.
  const openDispatchWizard = async () => {
    if (isNew || !id) {
      toast('error', 'Save the job before dispatching its locations.');
      return;
    }
    if (isDirty) {
      toast('error', 'Save the job before dispatching its locations — the wizard must match the saved record.');
      return;
    }
    setDispatchWizardLoading(true);
    try {
      const [jfRes, dispatchRes] = await Promise.all([
        supabase
          .from('job_fields')
          .select('id, acres_to_treat, field:fields(field_name)')
          .eq('job_id', id)
          .order('sort_order'),
        supabase
          .from('job_location_dispatches')
          .select('job_field_id, applicator_id, crew_id')
          .eq('job_id', id)
          .eq('dispatch_status', 'dispatched'),
      ]);
      if (jfRes.error) throw jfRes.error;
      if (dispatchRes.error) throw dispatchRes.error;

      type JfRow = { id: string; acres_to_treat: number | null; field?: { field_name?: string } | null };
      const jfRows = (jfRes.data || []) as JfRow[];
      if (jfRows.length === 0) {
        toast('error', 'This job has no field locations to dispatch — add a location on the Locations tab first.');
        setDispatchWizardLoading(false);
        return;
      }

      type DispatchRow = { job_field_id: string; applicator_id: string | null; crew_id: string | null };
      const currentByField = new Map<string, DispatchRow>();
      ((dispatchRes.data || []) as DispatchRow[]).forEach((d) => currentByField.set(d.job_field_id, d));

      const customerName = customers.find((c) => c.id === customerId)?.farm_name || 'Customer';
      // U13 (Codex R2 #3): legacy fallback — a saved job can carry a whole-job
      // jobs.applicator_id with NO per-location dispatch rows yet (assigned
      // before the U13 triggers landed; no backfill). Treat that applicator as
      // each such location's current assignee so the "Currently: X" chip
      // renders and the steal-confirmation still fires when reassigning away
      // from them. The wizard only opens on a NON-DIRTY job, so
      // savedApplicatorId is the authoritative saved value.
      const jobLevelAssignee: DispatchLocation['currentAssignee'] = savedApplicatorId
        ? {
            kind: 'applicator',
            id: savedApplicatorId,
            name: applicators.find((ap) => ap.id === savedApplicatorId)?.full_name || 'Unknown applicator',
          }
        : null;
      const locs: DispatchLocation[] = jfRows.map((jf) => {
        const d = currentByField.get(jf.id);
        let currentAssignee: DispatchLocation['currentAssignee'] = null;
        if (d?.applicator_id) {
          const a = applicators.find((ap) => ap.id === d.applicator_id);
          currentAssignee = { kind: 'applicator', id: d.applicator_id, name: a?.full_name || 'Unknown applicator' };
        } else if (d?.crew_id) {
          const c = groundCrews.find((gc) => gc.id === d.crew_id);
          currentAssignee = { kind: 'crew', id: d.crew_id, name: c?.name || 'Unknown crew' };
        } else {
          currentAssignee = jobLevelAssignee;
        }
        return {
          jobFieldId: jf.id,
          jobId: id,
          jobNumber,
          customerName,
          fieldName: jf.field?.field_name || 'Field',
          acres: jf.acres_to_treat ?? null,
          currentAssignee,
        };
      });
      setDispatchWizardLocations(locs);
      setDispatchWizardOpen(true);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'open_job_dispatch_wizard', jobId: id } });
      toast('error', 'Could not load this job’s locations for dispatch — try again.');
    }
    setDispatchWizardLoading(false);
  };

  const performSave = async (licenseOverride: boolean, overrideReasonForAudit?: string) => {
    setSaving(true);
    try {
      const payload = {
        customer_id: customerId,
        job_date: jobDate,
        scheduled_time: scheduledTime || null,
        applicator_id: overrideSaveApplicatorId({ licenseOverride, isNew, applicatorId, savedApplicatorId }),
        vehicle_id: vehicleId || null,
        recipe_id: recipeId || null,
        application_service_id: applicationServiceId,
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

      const chemsPayload = buildJobChemicalsPayload(chemRows);

      const newAssigneeIsApplicator = applicators.some((p) => p.id === applicatorId && p.role === 'applicator');
      // Mirrors the trigger's role='applicator' + active guard; the picker is active-only, so we never notify about a displacement that didn't happen.
      const isWholeJobApplicatorReassign = !isNew && !!applicatorId && applicatorId !== savedApplicatorId && newAssigneeIsApplicator;
      const newApplicatorId = applicatorId || null;
      const custNameForNotify = customers.find((c) => c.id === customerId)?.farm_name || 'Unknown';
      let displacedApplicatorIds: string[] = [];
      // This pre-save snapshot is not atomic with save; concurrent dispatch edits or a retry-after-commit can mis-target advisory notifications.
      // That best-effort window is accepted because notifications are advisory and the server data remains correct.
      if (isWholeJobApplicatorReassign) {
        try {
          const dispRes = await supabase
            .from('job_location_dispatches')
            .select('applicator_id')
            .eq('job_id', id!)
            .eq('dispatch_status', 'dispatched')
            .not('applicator_id', 'is', null);
          if (dispRes.error) throw dispRes.error;
          displacedApplicatorIds = [...new Set(
            (dispRes.data || [])
              .map((r) => r.applicator_id)
              .filter((aid): aid is string => !!aid),
          )];
        } catch (snapshotErr) {
          Sentry.captureException(snapshotErr instanceof Error ? snapshotErr : new Error(String(snapshotErr)), { extra: { context: 'snapshot_displaced_dispatchees' } });
        }
      }

      let displacementCommitted = false;
      // A2: fire as soon as a displacement commits so no later fallible sub-step or
      // early return can silently drop the split-assignee un-dispatch notices.
      const notifyDisplacedApplicators = (savedJobId: string) => {
        if (!isWholeJobApplicatorReassign || !displacementCommitted) return;
        const notified = new Set<string>();
        if (newApplicatorId) notified.add(newApplicatorId);
        if (savedApplicatorId) notified.add(savedApplicatorId);
        if (profile?.id) notified.add(profile.id);
        for (const idToNotify of displacedApplicatorIds) {
          if (notified.has(idToNotify)) continue;
          notified.add(idToNotify);
          void notifyApplicatorUndispatched(idToNotify, jobNumber || '', custNameForNotify, savedJobId);
        }
      };

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
      if (isWholeJobApplicatorReassign && !licenseOverride) {
        displacementCommitted = true;
        notifyDisplacedApplicators(id as string);
      }
      saveJobIdem.resetKey();
      const result = assertRpcResult<SaveJobResult>(data, 'save_job');
      const savedJobIdForNotify = isNew ? result.job_id : (id as string);

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
        // FIX 2 (Wave 2b): wrap this crew/loader sub-write in its OWN try/catch.
        // save_job has already INSERTED the row and the idempotency key was reset
        // above. If this separate .update() then fails (e.g. ground_crew_id FK
        // rejected because the crew was deleted by another user), the outer catch
        // would toast but NOT navigate — leaving an isNew user on /jobs/new with
        // isDirty still true. A retry there mints a FRESH idempotency key and
        // save_job INSERTS A SECOND job (silent duplicate → duplicate-invoicing
        // risk). Instead, on failure we move the user onto the SAVED job (exactly
        // the applicator-reassign-failure pattern below) so any retry edits the
        // existing row rather than inserting again.
        try {
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
        } catch (crewErr) {
          Sentry.captureException(crewErr instanceof Error ? crewErr : new Error(String(crewErr)), { extra: { context: 'job_crew_loader_after_save' } });
          toast('error', 'Job created, but the crew/loader settings did not save — adjust them on this page.');
          // §5: the job + over-label mix DID commit (only the crew/loader sub-write failed),
          // so still record the override audit linked to the saved job before bailing.
          if (overrideReasonForAudit) {
            await writeOverrideAudit(overrideReasonForAudit, isNew ? result.job_id : (id || null));
          }
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

      if (shouldReassignApplicatorAfterSave({ licenseOverride, applicatorId, savedApplicatorId })) {
        try {
          await assignWithOverride(isNew ? result.job_id : id!);
          if (isWholeJobApplicatorReassign) {
            displacementCommitted = true;
            notifyDisplacedApplicators(savedJobIdForNotify);
          }
        } catch (assignErr) {
          Sentry.captureException(assignErr instanceof Error ? assignErr : new Error(String(assignErr)), { extra: { context: 'assign_job_applicator_after_save' } });
          toast('error', isNew
            ? 'Job created, but the override applicator assignment failed — assign the applicator from this page.'
            : 'Job saved, but the override applicator change failed — retry the applicator assignment.');
          // §5: the job + over-label mix DID commit (only the applicator reassign failed),
          // so still record the override audit linked to the saved job before bailing.
          if (overrideReasonForAudit) {
            await writeOverrideAudit(overrideReasonForAudit, isNew ? result.job_id : (id || null));
          }
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

      // §5: the job + chemicals committed — NOW write the block-mode override audit, linked
      // to the real saved job id. Reached only on a SUCCESSFUL save, so a failed/retried
      // save leaves NO orphan override row. (Codex follow-up P2.)
      if (overrideReasonForAudit) {
        await writeOverrideAudit(overrideReasonForAudit, isNew ? result.job_id : (id || null));
      }

      // U12: notify the assigned applicator on dispatch / reschedule / undispatch.
      // Best-effort (each notify* fn swallows its own errors into Sentry via
      // logNotificationFailure) — never blocks the save that already committed.
      // Applicators previously got NO notification at all for any of these three
      // (verified: no notify*/createNotification call existed around this save
      // path before U12).
      if (newApplicatorId && newApplicatorId !== savedApplicatorId) {
        void notifyApplicatorDispatched(newApplicatorId, jobNumber || '', custNameForNotify, jobDate, savedJobIdForNotify);
      } else if (newApplicatorId && newApplicatorId === savedApplicatorId && jobDate !== savedJobDate) {
        void notifyApplicatorRescheduled(newApplicatorId, jobNumber || '', custNameForNotify, jobDate, savedJobIdForNotify);
      }
      if (savedApplicatorId && savedApplicatorId !== newApplicatorId) {
        void notifyApplicatorUndispatched(savedApplicatorId, jobNumber || '', custNameForNotify, savedJobIdForNotify);
      }

      // U12 Codex R5 #1: a reschedule must ALSO reach the active PER-LOCATION
      // dispatch assignees, not just the legacy jobs.applicator_id (the branches
      // above never see wizard-dispatched applicators). Fetch this job's active
      // ('dispatched') applicator rows, dedupe, and skip anyone already covered:
      // the legacy applicator (notified above — the dispatched notice carries the
      // new date too) and the saver themselves. Best-effort like the others —
      // each notify* self-swallows; a fetch failure only logs to Sentry and never
      // blocks the already-committed save. Skipped for a brand-new job (its id
      // was just minted — no dispatch rows can exist). RLS: the saver here is an
      // office role (the save UI is isEditable-gated), which reads all rows.
      if (!isNew && jobDate !== savedJobDate) {
        void (async () => {
          try {
            const dispRes = await supabase
              .from('job_location_dispatches')
              .select('applicator_id')
              .eq('job_id', savedJobIdForNotify)
              .eq('dispatch_status', 'dispatched')
              .not('applicator_id', 'is', null);
            if (dispRes.error) throw dispRes.error;
            const notified = new Set<string>();
            if (newApplicatorId) notified.add(newApplicatorId);
            if (profile?.id) notified.add(profile.id);
            for (const r of (dispRes.data || []) as { applicator_id: string | null }[]) {
              if (!r.applicator_id || notified.has(r.applicator_id)) continue;
              notified.add(r.applicator_id);
              void notifyApplicatorRescheduled(r.applicator_id, jobNumber || '', custNameForNotify, jobDate, savedJobIdForNotify);
            }
          } catch (notifyErr) {
            Sentry.captureException(notifyErr instanceof Error ? notifyErr : new Error(String(notifyErr)), { extra: { context: 'notify_dispatchees_rescheduled' } });
          }
        })();
      }

      toast('success', isNew ? 'Job created' : 'Job saved');
      setIsDirty(false);
      setSavedApplicatorId(applicatorId || null);
      setSavedJobDate(jobDate);

      if (isNew) {
        navigate(`/jobs/${result.job_id}`);
        void warnIfOverCreditLimit(customerId, toast);
      } else {
        await fetchJob();
      }
    } catch (err: unknown) {
      // Race: licenses changed since page load and the DB trigger fired.
      if (hasRpcCode(err, RpcErrorCodes.LICENSE_EXPIRED)) {
        if (profile?.role === 'admin') {
          // §5: the save was rejected (LICENSE_EXPIRED) — NOTHING committed — so carry the
          // label-override reason into the license-override retry to record the audit then.
          pendingOverrideReasonRef.current = overrideReasonForAudit ?? null;
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
      // #68: after-the-fact completion — the office is recording a job that was
      // already sprayed. complete_job requires status 'in_progress', so if the job
      // is still 'scheduled' start it first (chained) to skip the click-wait-click
      // Start→Complete dance. Timing is approximate; a start/end-time field on the
      // modal is the nicer follow-up the review noted.
      if (status === 'scheduled') {
        const startKey = startJobIdem.getKey();
        const { data: startData, error: startErr } = await supabase.rpc('start_job', {
          p_job_id: id!,
          p_performed_by: profile!.id,
          p_idempotency_key: startKey,
        });
        if (startErr) throw startErr;
        assertRpcResult(startData, 'start_job');
        startJobIdem.resetKey();
      }
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
      // U12 Codex R5 #2: same translation as FieldView — a dispatch-only
      // applicator on a SPLIT job gets the RPC's raw authorization rejection;
      // explain the business reason instead.
      const completeMsg = err instanceof Error ? err.message : 'Failed to complete job';
      toast('error', completeMsg.includes('Not authorized to complete this job')
        ? 'This job is split with another applicator or crew — the office will complete and close it.'
        : completeMsg);
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
      setIsDirty(false);
      if (result.split && (result.invoice_count ?? 0) > 1) {
        // U7 multi-owner split: one payable invoice was created per field owner. Navigate to
        // the anchor (primary owner) member; the invoice view links to the sibling invoices.
        toast('success', `Created ${result.invoice_count} split invoices — one per field owner`);
      } else {
        toast('success', `Invoice ${result.invoice_number} created`);
      }
      navigate(`/field-invoices/${result.invoice_id}`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'transfer_job_to_invoice' } });
      if (hasRpcCode(err, RpcErrorCodes.BLEND_TICKET_ALREADY_BILLED)) {
        // U6 #91b: a blend ticket for this job was already billed — invoicing the job
        // too would double-bill. Point the user at the existing bill instead.
        toast('error', 'A blend ticket for this job has already been billed. Invoicing the job as well would double-charge the customer — void that blend-ticket invoice first if you meant to re-bill here.');
      } else if (hasRpcCode(err, RpcErrorCodes.SPLIT_OVERRIDE_UNSUPPORTED)) {
        // U7: a multi-owner job with per-field $/acre price overrides can't be percentage-split.
        toast('error', 'This job has more than one field owner AND per-field $/acre pricing, which the automatic split does not support. Bill it as a single invoice, or price each owner in the field-application invoice editor.');
      } else if (hasRpcCode(err, RpcErrorCodes.FIELD_SPLIT_NOT_100)) {
        toast('error', 'One of this job’s fields has ownership splits that don’t add up to 100%. Fix the field billing splits, then transfer again.');
      } else if (hasRpcCode(err, RpcErrorCodes.SPLIT_NO_ACRES)) {
        toast('error', 'This multi-owner job has no billable acres to split. Enter acres to treat on its fields, then transfer again.');
      } else {
        toast('error', err instanceof Error ? err.message : 'Failed to transfer to invoice');
      }
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

  // P2-4: load a crop program's products into the chem rows. APPENDS (owner
  // decision 2026-07-03) — never wipes existing lines; the user reviews + Saves.
  // Reads the in-memory program (no fetch); mirrors loadRecipeById's seed → acres
  // re-derive so a loaded line reflects THIS job's acreage.
  const loadProgramById = async (programId: string) => {
    if (loadingProgram) return; // in-flight guard: a double-click must not append twice
    const program = cropPrograms.find((p) => p.id === programId);
    if (!program) return;
    if (program.items.length === 0) {
      toast('error', 'That program has no products.');
      return;
    }
    setLoadingProgram(true);
    try {
    const cust = customers.find((c) => c.id === customerId);
    const tier = (cust?.assigned_tier ?? 1) as 1 | 2 | 3;
    const acres = sumAcres(fieldRows);

    // Build a product lookup that ALSO includes any since-deactivated products the
    // program references (allProducts is is_active=true only) so cost/price/REI/PHI
    // are still correct — otherwise a discontinued line would load at $0 with no
    // label data (Codex P2). Mirrors the applicator-sheet compliance fetch by id.
    const byId = new Map(allProducts.map((p) => [p.id, p] as const));
    const missingIds = [...new Set(program.items.map((it) => it.product_id).filter((id) => id && !byId.has(id)))];
    if (missingIds.length > 0) {
      const { data: extra, error: extraErr } = await supabase.from('products').select('*').in('id', missingIds);
      if (extraErr) {
        Sentry.captureException(extraErr, { tags: { source: 'fetch', action: 'load_program_inactive_products' } });
      } else {
        (extra as Product[] | null)?.forEach((p) => byId.set(p.id, p));
      }
    }

    const seeds: ChemRow[] = program.items.map((item, idx) => {
      const product = byId.get(item.product_id);
      const seed = programItemToChemRowSeed(item, product, tier);
      const row = acres > 0
        ? recomputeChemRowForAcres({ ...seed, sort_order: idx }, acres)
        : { ...seed, sort_order: idx };
      return row as ChemRow;
    });
    setChemRows((prev) => [...prev, ...seeds].map((c, i) => ({ ...c, sort_order: i })));
    toast('success', `Added ${program.items.length} product${program.items.length === 1 ? '' : 's'} from "${program.name}" — review and Save.`);
    setShowProgramModal(false);
    setSelectedProgramId('');
    } finally {
      setLoadingProgram(false);
    }
  };

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
    // FIX 3: mark this field as "shares loading" so handleSave/sharesValid block a
    // save that would otherwise race ahead of the async lookup and persist an empty
    // split snapshot. Cleared in finally regardless of success/error.
    setSharesLoading((prev) => new Set(prev).add(fieldId));
    try {
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
    } finally {
      setSharesLoading((prev) => {
        const next = new Set(prev);
        next.delete(fieldId);
        return next;
      });
    }
  };

  const addFieldRow = () => {
    setFieldRows([...fieldRows, { field_id: '', field_name: '', acres_to_treat: '', planted_acres: '', crop: '', strip: '', pests: '', sort_order: fieldRows.length }]);
  };
  const addPickerFieldRows = (selections: JobFieldPickerSelection[]) => {
    const existingIds = new Set(fieldRows.map((field) => field.field_id).filter(Boolean));
    const newSelections = selections.filter((selection) => !existingIds.has(selection.field_id));
    if (newSelections.length === 0) {
      setFieldPickerOpen(false);
      return;
    }

    const newRows = newSelections.map((selection, index) => ({
      field_id: selection.field_id,
      field_name: selection.field_name,
      acres_to_treat: selection.billable_acres?.toString() ?? '',
      planted_acres: '',
      crop: selection.crop ?? '',
      strip: '',
      pests: '',
      sort_order: fieldRows.length + index,
    }));
    const updatedRows = [...fieldRows, ...newRows];
    setFieldRows(updatedRows);
    newSelections.forEach((selection) => seedSharesForField(selection.field_id));
    recomputeChemQtyFromAcres(updatedRows);
    setFieldPickerOpen(false);
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
      const defaultAcres = f && billableAcres(f.override_acres, f.measured_acres, f.total_acres);
      if (defaultAcres != null && !updated[i].acres_to_treat) {
        updated[i].acres_to_treat = defaultAcres.toString();
      }
      if (f && f.crop_type && !updated[i].crop) {
        updated[i].crop = f.crop_type;
      }
      // Re-seed shares for the newly chosen field; drop the old field's shares.
      if (prevFieldId) {
        setShareRows((prev) => prev.filter((s) => s.field_id !== prevFieldId));
        // FIX 3: also clear any in-flight loading flag for the field being replaced,
        // so a stale flag can't permanently block save after a field swap.
        setSharesLoading((prev) => {
          if (!prev.has(prevFieldId)) return prev;
          const next = new Set(prev);
          next.delete(prevFieldId);
          return next;
        });
      }
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
      customer_supplied: false,
      sort_order: chemRows.length,
    }]);
  };
  const removeChemRow = (i: number) => setChemRows(chemRows.filter((_, idx) => idx !== i));
  const toggleChemSupplied = (i: number) => {
    const updated = [...chemRows];
    updated[i] = { ...updated[i], customer_supplied: !updated[i].customer_supplied };
    setChemRows(updated);
  };
  const updateChemRow = (i: number, key: keyof ChemRow, value: string) => {
    const updated = [...chemRows];
    // RELABELLING THE STOCK UNIT MUST NOT KEEP THE OLD UNIT'S MONEY (Codex P1, 2026-08-24).
    // The banner's remedy tells the operator to set the Unit AND re-enter its cost/price —
    // but nothing enforced the second half: changing only `unit` from Lb to Dry oz swapped
    // the label, the units then compared equal, the guard cleared, and the same 150¢
    // figures billed per OUNCE — the 16× overbill wearing the fix as a disguise. The
    // per-unit amounts were entered per the OLD unit, so once the unit's meaning changes
    // they no longer state anything provable: clear them and say so, and the blank-cents
    // save gate holds the row until amounts are re-entered per the new unit. Deliberately
    // NOT auto-converted — 150¢/lb is 9.375¢/oz, which is not whole cents, and silently
    // rounding money is the exact failure class this page exists to refuse.
    // Labelling a BLANK or unrecognised unit is not a relabel — the operator is naming the
    // unit their amounts were always meant in (the blank-unit defect's own remedy), so
    // entered amounts are kept.
    if (key === 'unit') {
      const beforeRaw = updated[i]?.unit;
      const beforeNorm = normalizeRateUnit(beforeRaw);
      const afterNorm = normalizeRateUnit(value);
      const carriesMoney = (parseInt(updated[i].cost_per_unit_cents) || 0) !== 0
        || (parseInt(updated[i].price_per_unit_cents) || 0) !== 0;
      if (carriesMoney && beforeNorm != null && afterNorm != null && beforeNorm !== afterNorm) {
        updated[i] = { ...updated[i], cost_per_unit_cents: '', price_per_unit_cents: '' };
        toast('info',
          `The Unit changed from ${beforeRaw} to ${value}. The line's cost and price were entered per ${beforeRaw}, `
          + `so they were cleared — re-enter them per ${value} before saving.`);
      }
    }
    updated[i] = { ...updated[i], [key]: value };
    if (key === 'product_id') {
      const p = allProducts.find(ap => ap.id === value);
      updated[i].product_name = p?.product_name || '';
      if (p) {
        // Auto-fill from the product (criterion #8/#9): warehouse has no product
        // source so it stays whatever the user enters.
        updated[i].vendor = p.vendor || '';
        updated[i].rei_hours = p.rei_hours != null ? p.rei_hours.toString() : '';
        updated[i].phi_days = p.phi_days != null ? p.phi_days.toString() : '';
        if (p.rate_per_acre != null && !updated[i].rate_per_acre) {
          updated[i].rate_per_acre = p.rate_per_acre.toString();
          updated[i].driver = 'rate';
        }
        if (p.rate_unit && !updated[i].rate_unit) updated[i].rate_unit = p.rate_unit;
        // P1 MONEY fix: quantity = rate × acres comes out in the RATE's base unit
        // (e.g. pt), but the STOCK unit (unit_size, e.g. GAL) and per-unit cost/price
        // are per stock unit. Reconcile them into ONE measure (the rate's base unit)
        // so the saved quantity/unit agree and the line cost/price + loader gallons
        // are NOT inflated. When the stock unit already equals the rate unit (or the
        // units can't be reconciled), this returns the stock unit + per-stock
        // cost/price unchanged — the common case is untouched.
        const cust = customers.find((c) => c.id === customerId);
        const tier = cust?.assigned_tier ?? 1;
        const tierPrice = tier === 3 ? p.tier3_price : tier === 2 ? p.tier2_price : p.tier1_price;
        const costPerStockCents = Math.round((p.current_cost || 0) * 100);
        const pricePerStockCents = tierPrice != null ? Math.round(tierPrice * 100) : 0;
        const reconciled = reconcileChemAutofillUnits(
          p.unit_size,
          updated[i].rate_unit || p.rate_unit,
          costPerStockCents,
          pricePerStockCents,
          p.product_form,
        );
        updated[i].unit = reconciled.unit;
        updated[i].cost_per_unit_cents = reconciled.costPerUnitCents.toString();
        // Only default the price when the product has a tier price; otherwise leave
        // whatever was there (mirrors the prior tierPrice != null guard).
        if (tierPrice != null) updated[i].price_per_unit_cents = reconciled.pricePerUnitCents.toString();
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
  // U12: the assigned applicator (job-level applicator_id match — mirrors the
  // existing AppliedRecordsManager canEdit gate a few hundred lines down) can
  // see Start/Complete on THEIR OWN job even though isEditable is office-only.
  // Verified server-side: start_job/complete_job already authorize
  // `is_applicator() AND jobs.applicator_id = actor` (and, after migration
  // 20260706060000, a per-location dispatchee too) — this UI gate was simply
  // narrower than what the RPC already allowed, hiding a legitimate action.
  const isAssignedApplicator = profile?.role === 'applicator' && !!applicatorId && applicatorId === profile?.id;
  // U12 Codex R3 #2: an applicator holding an ACTIVE per-location dispatch row
  // (hasActiveDispatch) can also start/complete — mirrors the assignment-
  // unification migration's server-side authorization. Cancel/Transfer stay
  // office-only (isEditable) — deliberately NOT widened.
  const canStart = !isNew && status === 'scheduled' && (isEditable || isAssignedApplicator || hasActiveDispatch);
  // #68: also allow completing a still-'scheduled' job (sprayed earlier, keyed in
  // now). handleComplete chains start_job → complete_job so the office skips the
  // fake Start-then-Complete click. Start Job also stays available for the
  // start-now-spray-later flow.
  const canComplete = !isNew && (status === 'in_progress' || status === 'scheduled') && (isEditable || isAssignedApplicator || hasActiveDispatch);
  // Cancel/Transfer are OFFICE decisions (cancelling work or converting it to a
  // billable invoice) — not verified-safe to hand an applicator: Cancel had NO
  // role gate at all before U12 (any of admin/sales_rep/applicator viewing this
  // page could click it), and Transfer's only gate was the job's status.
  const canCancel = !isNew && (status === 'scheduled' || status === 'in_progress') && isEditable;
  const canTransfer = !isNew && status === 'completed' && isEditable;

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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
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
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {!isNew && fieldRows.some((f) => f.field_id) && chemRows.some((c) => c.product_id) && (
            <>
              <Button variant="secondary" onClick={() => setPrintOptionsOpen(true)} loading={generatingSheet !== null}>
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
          {canCancel && (
            <Button variant="danger" onClick={() => setShowCancelConfirm(true)} loading={cancelling}>
              <Ban className="w-4 h-4" />
              Cancel Job
            </Button>
          )}
          {canStart && (
            <Button
              variant="secondary"
              onClick={() => {
                // U3 (Codex R2 P1): starting refetches the job and resets the dirty
                // baseline — an unsaved Application Service (or any edit) would be
                // silently lost and the later invoice would under-bill. Save first.
                if (isDirty) {
                  toast('warning', 'You have unsaved changes — click Save Changes first, then start the job.');
                  return;
                }
                void handleStart();
              }}
              loading={starting}
              disabled={starting}
            >
              <Check className="w-4 h-4" />
              Start Job
            </Button>
          )}
          {canComplete && (
            <Button
              variant="secondary"
              onClick={() => {
                // U3 (Codex P1): completion reads billing-impacting fields (e.g. the
                // Application Service) from the DATABASE — unsaved edits would be
                // silently lost and the invoice would under-bill. Save first.
                if (isDirty) {
                  toast('warning', 'You have unsaved changes — click Save Changes first, then complete the job.');
                  return;
                }
                completeJobIdem.resetKey();
                setShowCompleteModal(true);
              }}
            >
              <Check className="w-4 h-4" />
              Complete Job
            </Button>
          )}
          {canTransfer && growerShareFieldNames.length > 0 && (
            <div className="max-w-sm px-3 py-1.5 rounded-lg bg-blue-50 text-xs text-blue-800">
              Grower-share override active on <strong>{growerShareFieldNames.join(', ')}</strong> — the invoice will bill those growers at the override rate.
            </div>
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

      {/* §2 Watchdog — inline advisory flags for this job (auto-refreshes on open) */}
      {!isNew && id && <WatchdogFlagBanner jobId={id} autoRefresh />}

      {/* Job Header */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Customer *</label>
            <select
              value={customerId}
              onChange={(e) => {
                const newCustomerId = e.target.value;
                setCustomerId(newCustomerId);
                setFieldRows([]);
                setShareRows([]);
                // New jobs only: prefill the application service from the
                // customer's default. A MANUAL pick is never clobbered, but an
                // AUTO-FILLED one is re-evaluated on every customer change
                // (Codex P2: Customer A's default must not silently ride into
                // Customer B's job and bill the wrong per-acre fee).
                if (isNew && (!applicationServiceId || svcAutoFilledRef.current)) {
                  const selected = customers.find((c) => c.id === newCustomerId);
                  const def = selected?.default_application_service_id ?? null;
                  setApplicationServiceId(def);
                  svcAutoFilledRef.current = def !== null;
                }
              }}
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
            {/* U13 (#15-21/#111): saving this dropdown auto-syncs a whole-job
                per-location dispatch via a DB trigger (no click needed). This
                button is for the OTHER case — splitting the job across
                different applicators/crews per location, or reviewing/
                reassigning an existing split. */}
            {/* Codex R4 P2: only render for dispatchable statuses — the wizard's
                RPC rejects anything else with JOB_NOT_DISPATCHABLE at Finish. */}
            {!isNew && isEditable && (status === 'scheduled' || status === 'in_progress') && (
              <button
                type="button"
                onClick={openDispatchWizard}
                disabled={dispatchWizardLoading}
                className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-crx-green hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-3.5 h-3.5" />
                {dispatchWizardLoading ? 'Loading locations…' : 'Dispatch Locations'}
              </button>
            )}
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
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Application Service</label>
            <ApplicationServicePicker
              value={applicationServiceId}
              onChange={(v) => {
                // Any change through the picker is the user's hand — from here
                // on, customer switches must not overwrite it (Codex P2).
                svcAutoFilledRef.current = false;
                setApplicationServiceId(v);
              }}
              disabled={!canEdit}
            />
            <p className="mt-1 text-xs text-gray-500">Adds a per-acre machine fee to this job's invoice.</p>
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
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setFieldPickerOpen(true)}
                    disabled={!fieldsLookupReady}
                    title={!fieldsLookupReady ? 'Loading fields…' : undefined}
                  >
                    <MapPin className="w-4 h-4" /> Select locations on map
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={addFieldRow}
                    disabled={!customerId || !fieldsLookupReady}
                    title={!fieldsLookupReady ? 'Loading fields…' : undefined}
                  >
                    <Plus className="w-4 h-4" /> Add Field
                  </Button>
                </div>
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
                          <SearchableSelect
                            options={customerFields.map((cf) => ({ value: cf.id, label: cf.field_name }))}
                            value={f.field_id}
                            onChange={(value) => updateFieldRow(i, 'field_id', value)}
                            disabled={!canEdit}
                            placeholder="Select field..."
                          />
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
                                <SearchableSelect
                                  options={customers.map((c) => ({ value: c.id, label: c.farm_name }))}
                                  value={s.customer_id}
                                  onChange={(value) => updateShareRow(s.idx, 'customer_id', value)}
                                  disabled={!canEdit}
                                  placeholder="Select customer..."
                                />
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

      {fieldPickerOpen && (
        <Suspense fallback={null}>
          <JobFieldPickerModal
            open={fieldPickerOpen}
            onClose={() => setFieldPickerOpen(false)}
            onAdd={addPickerFieldRows}
            alreadyOnJobIds={new Set(fieldRows.map((field) => field.field_id).filter(Boolean))}
            billableAcresById={jobPickerBillableAcresById}
          />
        </Suspense>
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
              {canEdit && cropPrograms.some((p) => p.is_active) && (
                <Button size="sm" variant="secondary" onClick={() => { setSelectedProgramId(''); setShowProgramModal(true); }}
                  title="Add a saved crop program's products to this job">
                  <Sprout className="w-4 h-4" /> Load Program
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
                // FIX 1 (Wave 2b): pass the product's form so this in-page gal/lb
                // preview matches the server convert_to_gl_lb (and the #11 report at
                // ~813-926 / FieldAppChemicalEntry). Without it a LIQUID line measured
                // in bare 'oz' takes the legacy branch and is mis-classified as POUNDS
                // (oz = 1/16 lb) instead of FLUID ounces (1/128 gal) — the preview then
                // disagrees with the saved/invoiced value.
                // Inactive-safe (Codex P2, 2026-08-23): a discontinued product read straight
                // out of allProducts has no form, which silently takes the liquid branch.
                const previewForm = productFormFor(c.product_id);
                const conv = toGallonOrLbEquivalent(totalApplied, c.unit, previewForm);
                const hazard = chemBillingHazards.get(i);
                const rowDefect = chemRowDefects.get(i);
                return (
                  <div key={i} className={`border rounded-lg p-3 space-y-2 ${hazard || rowDefect ? 'border-red-400 bg-red-50' : 'border-gray-200'}`}>
                    {rowDefect && (
                      <div className="flex items-start gap-2 text-sm text-red-800 bg-red-100 border border-red-300 rounded-lg px-3 py-2">
                        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <span><strong>This line cannot be saved</strong> because {rowDefect}.</span>
                      </div>
                    )}
                    {hazard && (
                      <div className="flex items-start gap-2 text-sm text-red-800 bg-red-100 border border-red-300 rounded-lg px-3 py-2">
                        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        <span>
                          <strong>This line cannot be saved.</strong> Its quantity ({totalApplied}) is counted in{' '}
                          <strong>{hazard.quantityUnit}</strong>, but its cost and price are quoted per{' '}
                          <strong>{hazard.priceUnit}</strong>
                          {hazard.billedRatio && hazard.billedRatio > 1
                            ? <> — invoicing it would charge about <strong>{fmt4(hazard.billedRatio)}×</strong> too much</>
                            : null}
                          . Set <strong>Unit</strong> to {hazard.quantityUnit} and quote cost/price per{' '}
                          {hazard.quantityUnit} — or, if the rate really is in {hazard.priceUnit},
                          change the rate unit to {hazard.priceUnit}/ac <strong>and re-enter the rate</strong>{' '}
                          so the quantity is recalculated. Relabelling the unit on its own does not change
                          the amount, and would leave this line billing the same wrong total silently.
                        </span>
                      </div>
                    )}
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <div className="col-span-12 md:col-span-3">
                        <label className="block text-xs font-medium text-secondary mb-1">Chemical</label>
                        <JobChemicalProductPicker
                          products={allProducts}
                          value={c.product_id}
                          onChange={(value) => updateChemRow(i, 'product_id', value)}
                          disabled={!canEdit}
                        />
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
                        <select value={c.rate_unit} onChange={(e) => updateChemRow(i, 'rate_unit', e.target.value)}
                          disabled={!canEdit} className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50">
                          <option value="">-- unit --</option>
                          {/* WaveB: canonical bare units filtered by product form (Codex P2); grandfather a legacy/mismatched value */}
                          {c.rate_unit && !isKnownUnit(unitConversions, previewForm, c.rate_unit) && (
                            <option value={c.rate_unit}>{c.rate_unit} (existing)</option>
                          )}
                          {unitOptionsForForm(unitConversions, previewForm).map((uc) => (
                            <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                          ))}
                        </select>
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
                        <select value={c.unit} onChange={(e) => updateChemRow(i, 'unit', e.target.value)}
                          disabled={!canEdit} className="w-full px-2 py-1.5 text-sm border border-gray-200 rounded-lg disabled:bg-gray-50">
                          <option value="">-- unit --</option>
                          {/* WaveB: canonical bare units filtered by product form (Codex P2); grandfather a legacy/mismatched value */}
                          {c.unit && !isKnownUnit(unitConversions, previewForm, c.unit) && (
                            <option value={c.unit}>{c.unit} (existing)</option>
                          )}
                          {unitOptionsForForm(unitConversions, previewForm).map((uc) => (
                            <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                          ))}
                        </select>
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
                    {/* #53/#54: grower-supplied product — applied but not deducted or billed. */}
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="checkbox"
                        id={`cust-supp-${i}`}
                        checked={c.customer_supplied}
                        onChange={() => toggleChemSupplied(i)}
                        disabled={!canEdit}
                        className="h-4 w-4 rounded border-gray-300 text-crx-green focus:ring-crx-green disabled:opacity-50"
                      />
                      <label htmlFor={`cust-supp-${i}`} className="text-xs font-medium text-secondary select-none">
                        Customer supplied &mdash; apply it, but don&rsquo;t deduct our inventory or bill for this product
                      </label>
                    </div>
                    {/* §5 Label-Rate Guardrails: rate-vs-max + PHI-vs-harvest on the job mix
                        grid (unit-safe; never blocks here — the save gate handles block mode).
                        Label max is read live from allProducts so it works on reopen too. */}
                    {(() => {
                      if (!c.product_id) return null;
                      const lbl = labelMaxFor(c.product_id);
                      const cmp = compareToMaxRate(parseFloat(c.rate_per_acre) || null, c.rate_unit, lbl.max_label_rate, lbl.max_label_rate_unit);
                      const phi = phiHarvestWarning(parseFloat(c.phi_days) || null, jobEarliestHarvestDate, jobDate);
                      if (cmp.status === 'no_rate' && phi.status !== 'inside_window') return null;
                      return (
                        <div className="flex flex-wrap items-center gap-2 text-xs pt-1">
                          {cmp.status === 'over' && (
                            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-medium ${guardrailMode === 'block' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800'}`}>
                              <ShieldAlert className="w-3 h-3" /> {guardrailMode === 'block' ? 'Over label rate — override required' : 'Over label rate'} ({cmp.rate} &gt; {cmp.maxRate} {lbl.max_label_rate_unit})
                            </span>
                          )}
                          {cmp.status === 'no_label_max' && (
                            <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-gray-500">
                              <AlertTriangle className="w-3 h-3" /> No label max on file
                            </span>
                          )}
                          {cmp.status === 'cannot_compare' && (
                            <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-gray-500">
                              <AlertTriangle className="w-3 h-3" /> Units differ — rate not checked
                            </span>
                          )}
                          {phi.status === 'inside_window' && (
                            <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                              <CalendarClock className="w-3 h-3" /> Harvest {phi.harvestDate} is inside the {phi.phiDays}-day PHI window (earliest {phi.earliestHarvest})
                            </span>
                          )}
                        </div>
                      );
                    })()}
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
          {isNew ? (
            <>
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
              <label className="block text-sm font-medium text-nav-dark mb-1">Vessel being loaded</label>
              <select
                value={loaderVesselId}
                onChange={(e) => {
                  const selectedVesselId = e.target.value;
                  setLoaderVesselId(selectedVesselId);
                  setTankCapacity(capacityForLoaderVesselSelection(selectedVesselId, loaderVesselOptions));
                }}
                disabled={!canEdit}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50"
              >
                {loaderVesselOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <label className="block text-sm font-medium text-nav-dark mt-3 mb-1">Tank Capacity (gal)</label>
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
            </>
          ) : (
            <LoaderWorksheetsPanel
              jobId={id!}
              vehicles={vehicles}
              jobVehicleId={vehicleId || null}
              totalAcres={totalAcres}
              products={chemRows
                .filter((chemical) => chemical.product_id)
                .map((chemical) => ({
                  product_name: chemical.product_name || 'Product',
                  total_quantity: chemical.quantity.trim() === '' ? null : parseFloat(chemical.quantity),
                  unit: chemical.unit || null,
                }))}
              defaultCarrierRateGpa={!Number.isNaN(parsedCarrierRate) ? parsedCarrierRate : null}
              legacyWorksheet={{
                vehicleId: vehicleId || null,
                capacityGal: effectiveCapacity,
                carrierRateGpa: !Number.isNaN(parsedCarrierRate) ? parsedCarrierRate : null,
                comment: loaderComment || null,
              }}
              legacyContent={
                <LegacyLoaderWorksheet
                  carrierRateGpa={carrierRateGpa}
                  onCarrierRateChange={setCarrierRateGpa}
                  loaderVesselId={loaderVesselId}
                  loaderVesselOptions={loaderVesselOptions}
                  onVesselChange={(selectedVesselId) => {
                    setLoaderVesselId(selectedVesselId);
                    setTankCapacity(capacityForLoaderVesselSelection(selectedVesselId, loaderVesselOptions));
                  }}
                  tankCapacity={tankCapacity}
                  onTankCapacityChange={setTankCapacity}
                  assignedVehicleCapacity={assignedVehicleCapacity}
                  assignedVehicleName={savedVehicleName}
                  assignedVehicleCapacityUnit={assignedVehicleCapacityUnit}
                  loaderWorksheet={loaderWorksheet}
                  loaderComment={loaderComment}
                  onLoaderCommentChange={setLoaderComment}
                  canEdit={canEdit}
                />
              }
              canEdit={canEdit}
              displayMode={loaderDisplayMode}
              onDisplayModeChange={setLoaderDisplayMode}
            />
          )}
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
      {/* ─────────────── MAP / LOGS TAB (#16) ─────────────── */}
      {activeTab === 'map_logs' && (
        <div className="space-y-4">
          {isNew || !id ? (
            <Card>
              <p className="text-sm text-secondary text-center py-6">
                Save this job first to see its field map.
              </p>
            </Card>
          ) : (
            <Suspense
              fallback={
                <Card>
                  <p className="text-sm text-gray-500 py-10 text-center">Loading map…</p>
                </Card>
              }
            >
              <JobFieldMap jobId={id} />
            </Suspense>
          )}
          {isNew || !id ? (
            <Card>
              <p className="text-sm text-secondary text-center py-6">
                Save this job first to attach log files.
              </p>
            </Card>
          ) : (
            // Codex #16 P2: the RLS lets the assigned applicator attach/delete their
            // OWN logs (they hold the GPS/equipment files), so the upload/delete
            // controls must be available to them too — not just admin/sales. The
            // DELETE policy still restricts an applicator to files they uploaded.
            <JobAttachments
              jobId={id}
              canEdit={isEditable || (role === 'applicator' && applicatorId === profile?.id)}
            />
          )}
        </div>
      )}

      {activeTab === 'notifications' && (
        <div className="space-y-4">
        {/* ── Customer Notifications log (#40 pre-application notice) ── */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-nav-dark flex items-center gap-2">
              <Bell className="w-4 h-4 text-crx-green" /> Customer Notifications
            </h2>
            <div className="flex items-center gap-2">
              {/* #40 Codex P2: a PRE-application notice only on a not-yet-applied job
                  (scheduled / in_progress); hidden on completed / invoiced / cancelled. */}
              {isEditable && !isNew && id && (status === 'scheduled' || status === 'in_progress') && (
                <Button
                  size="sm"
                  variant={preSendCopy.isResend ? 'secondary' : 'primary'}
                  onClick={() => setShowPreNoticeConfirm(true)}
                  loading={sendingPreNotice}
                  // #40 MED (Codex review): block until the log has SUCCESSFULLY loaded.
                  // A still-loading OR failed load leaves alreadySentPreCount=0, which
                  // would give the FIRST-send modal and bypass the re-send warning on a
                  // job that already has sent notices. notificationsLoaded fails closed.
                  disabled={sendingPreNotice || loadingNotifications || !notificationsLoaded}
                >
                  <Bell className="w-4 h-4" /> {preSendCopy.buttonLabel}
                </Button>
              )}
              {/* #41: a POST-application notice only on an APPLIED job (completed /
                  invoiced); hidden on scheduled / in_progress / cancelled. Same
                  fail-closed gating + re-send safety as the pre control above. */}
              {isEditable && !isNew && id && (status === 'completed' || status === 'invoiced') && (
                <Button
                  size="sm"
                  variant={postSendCopy.isResend ? 'secondary' : 'primary'}
                  onClick={() => setShowPostNoticeConfirm(true)}
                  loading={sendingPostNotice}
                  disabled={sendingPostNotice || loadingNotifications || !notificationsLoaded}
                >
                  <Bell className="w-4 h-4" /> {postSendCopy.buttonLabel}
                </Button>
              )}
            </div>
          </div>
          {isNew || !id ? (
            <p className="text-sm text-secondary text-center py-6">
              Save this job first to send and track customer notifications.
            </p>
          ) : loadingNotifications ? (
            <p className="text-sm text-gray-500 py-6 text-center">Loading notifications…</p>
          ) : notificationsLoadError ? (
            <div className="text-center py-6">
              <p className="text-sm text-red-600">Couldn't load the notification log.</p>
              <p className="text-xs text-secondary mt-1">Sending is disabled until it loads, so an already-sent notice isn't duplicated.</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={loadJobNotifications}>Retry</Button>
            </div>
          ) : jobNotifications.length === 0 ? (
            <p className="text-sm text-secondary text-center py-6">
              No notifications have been sent yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-secondary border-b border-gray-200">
                    <th className="py-2 pr-3">Type</th>
                    <th className="py-2 pr-3">Recipient</th>
                    <th className="py-2 pr-3">Channel</th>
                    <th className="py-2 pr-3">Sent</th>
                    <th className="py-2 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {jobNotifications.map((n) => (
                    <tr key={n.id} className="border-b border-gray-100 last:border-0">
                      <td className="py-2 pr-3">
                        <Badge variant={n.notification_type === 'pre' ? 'info' : 'success'}>
                          {n.notification_type === 'pre' ? 'Pre' : 'Post'}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-charcoal">
                        <div className="font-medium">{n.customer?.farm_name ?? 'Customer'}</div>
                        <div className="text-xs text-secondary">{n.recipient_email || 'no email on file'}</div>
                      </td>
                      <td className="py-2 pr-3 capitalize text-secondary">{n.channel}</td>
                      <td className="py-2 pr-3 text-secondary">
                        {n.sent_at ? new Date(n.sent_at).toLocaleString() : '—'}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={n.status === 'sent' ? 'success' : 'danger'}>
                          {n.status === 'sent' ? 'Sent' : 'Failed'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-secondary">
            The pre- and post-notification messages are configured in Settings (editable wording) and go to the job&apos;s billed customer(s) by email. This history carries over to the job&apos;s field-application invoice.
          </p>
        </Card>

        {/* ── Job notes / memos (internal) ── */}
        <Card>
          <h2 className="text-lg font-semibold text-nav-dark mb-3">Job Notes &amp; Memos</h2>
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
        </div>
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
          {status === 'scheduled' && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-blue-50 text-xs text-blue-800">
              <Check className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>This job hasn&apos;t been started yet &mdash; completing it will mark it started and finished in one step (for a job sprayed earlier and recorded now).</span>
            </div>
          )}
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

      {/* P2-4: Load Crop Program Modal (append-only) */}
      <Modal open={showProgramModal} onClose={() => setShowProgramModal(false)} title="Load Crop Program">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Add a saved crop program's products (with their per-acre rates) to this job. The lines are <strong>added</strong> to the current chemicals and stay editable — review them and Save the job to keep them. Programs matching this job's crop are listed first.
          </p>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Program</label>
            <select
              value={selectedProgramId}
              onChange={(e) => setSelectedProgramId(e.target.value)}
              aria-label="Select crop program"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
            >
              <option value="">Select program...</option>
              {orderProgramsForJob(cropPrograms, fieldRows.map((f) => f.crop)).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.crop_type} {p.season} ({p.items.length} product{p.items.length === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowProgramModal(false)}>Cancel</Button>
            <Button onClick={() => loadProgramById(selectedProgramId)} disabled={!selectedProgramId || loadingProgram} loading={loadingProgram}>
              <Sprout className="w-4 h-4" /> Load Program
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

      <PrintOptionsDialog
        open={printOptionsOpen}
        onClose={() => setPrintOptionsOpen(false)}
        onPrint={handleGenerateSheet}
      />

      {/* §5: block-mode over-label-rate admin override — a required reason; logs it then
          saves. Only reached in 'block' mode for an admin. Never a hard wall. */}
      <Modal open={showOverrideModal} onClose={() => { if (!saving) setShowOverrideModal(false); }} title="Over-label-rate override">
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-amber-800">
              {guardrailState.overRateCount} chemical line(s) exceed the product&rsquo;s maximum label rate
              {guardrailState.overRateProducts.length > 0 && <> (<strong>{guardrailState.overRateProducts.join(', ')}</strong>)</>}.
              The guardrail is set to <strong>block</strong>, so saving requires an admin override. Your reason is logged for the audit trail.
            </p>
          </div>
          <div>
            <label htmlFor="job-override-reason" className="block text-sm font-medium text-gray-700 mb-1">
              Reason for the override <span className="text-red-600">*</span>
            </label>
            <textarea
              id="job-override-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              rows={3}
              placeholder="e.g., Split application across two passes; per-pass rate is within label."
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-200"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setShowOverrideModal(false)} disabled={saving}>Cancel</Button>
            <Button variant="primary" onClick={handleOverrideConfirm} loading={saving} disabled={saving || !overrideReason.trim()}>
              Override &amp; Save
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

      {/* License-override confirm (admin only, B5) */}
      <ConfirmModal
        open={showLicenseOverrideConfirm}
        onClose={() => { pendingOverrideReasonRef.current = null; setShowLicenseOverrideConfirm(false); }}
        onConfirm={() => {
          setShowLicenseOverrideConfirm(false);
          // §5: pass the stashed label-override reason (if any) so the license-override save
          // still records the over-label audit. Clear the ref after reading it.
          const reason = pendingOverrideReasonRef.current ?? undefined;
          pendingOverrideReasonRef.current = null;
          performSave(true, reason);
        }}
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
        message={isMultiOwner
          ? `This job has fields billed to more than one owner. Transfer to Invoice creates ONE invoice to ${customers.find((c) => c.id === customerId)?.farm_name || 'the primary customer'}; each landlord's share shows on statements but CANNOT be paid separately (per-owner billing for spray jobs is coming soon). Continue only if the tenant is collecting from the other owners.`
          : 'Transfer this job to an invoice? This will create a new invoice from the job chemicals.'}
        confirmLabel="Transfer to Invoice"
        variant="warning"
        loading={transferring}
      />

      {/* #40: Send Pre-Notification Confirm (customer-facing — explicit confirm). On
          a RE-SEND (the job already has 'sent' pre rows) the title/copy/label switch
          to an explicit warning that confirming notifies those customers a SECOND
          time (#40 MED — no silent duplicate; deliberate re-send must be informed). */}
      <ConfirmModal
        open={showPreNoticeConfirm}
        onClose={() => setShowPreNoticeConfirm(false)}
        onConfirm={() => { setShowPreNoticeConfirm(false); handleSendPreNotification(); }}
        title={preSendCopy.confirmTitle}
        message={preSendCopy.confirmMessage}
        confirmLabel={preSendCopy.confirmLabel}
        variant="warning"
        loading={sendingPreNotice}
      />

      {/* #41: Send Post-Notification Confirm (customer-facing — explicit confirm). On
          a RE-SEND (the job already has 'sent' post rows) the title/copy/label switch
          to an explicit warning that confirming notifies those customers a SECOND time
          (no silent duplicate; deliberate re-send must be informed). */}
      <ConfirmModal
        open={showPostNoticeConfirm}
        onClose={() => setShowPostNoticeConfirm(false)}
        onConfirm={() => { setShowPostNoticeConfirm(false); handleSendPostNotification(); }}
        title={postSendCopy.confirmTitle}
        message={postSendCopy.confirmMessage}
        confirmLabel={postSendCopy.confirmLabel}
        variant="warning"
        loading={sendingPostNotice}
      />

      {/* U13 (#15-21/#111): job-scoped Dispatch Locations wizard. */}
      <DispatchWizard
        open={dispatchWizardOpen}
        onClose={() => setDispatchWizardOpen(false)}
        locations={dispatchWizardLocations}
        initialSelectedIds={dispatchWizardLocations.map((l) => l.jobFieldId)}
        applicators={applicators
          .filter((a) => a.role === 'applicator')
          .map((a) => ({ id: a.id, full_name: a.full_name }))}
        crews={groundCrews}
        performedBy={profile?.id || ''}
        isAdmin={role === 'admin'}
        onDispatched={() => setDispatchWizardOpen(false)}
      />
    </div>
  );
}
