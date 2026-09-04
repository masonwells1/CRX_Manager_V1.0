import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Save, Send, Trash2, MapPin, FlaskConical, Users, ClipboardList, ArrowLeft, Eye, AlertTriangle,
  Printer, Bell, Lock, X, CornerUpLeft, RotateCcw, Wind, Thermometer, Tractor, Gauge, CalendarDays, Clock,
  Ban, Mail, CloudSun, Droplets,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { assertInvoiceLifecycleSendable, assertInvoiceSendable } from '../lib/invoiceSendDisposition';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { generateIdempotencyKey } from '../lib/idempotency';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { logActivity } from '../lib/activityLogger';
import { Sentry } from '../lib/sentry';
import { formatCents as fmt } from '../lib/money';
import { todayInBusinessTz } from '../lib/dateUtils';
import { billableAcres, acreDivergence, appliedMatchesSystem } from '../lib/fieldGeometry';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import ConfirmModal from '../components/ui/ConfirmModal';
import WatchdogFlagBanner from '../components/watchdog/WatchdogFlagBanner';
import Modal from '../components/ui/Modal';
import SelectLocationsModal from '../components/field-app/SelectLocationsModal';
import FieldAppChemicalEntry, { type ChemicalLine } from '../components/field-app/FieldAppChemicalEntry';
import {
  LABEL_RATE_GUARDRAIL_MODE_KEY,
  DEFAULT_GUARDRAIL_MODE,
  parseGuardrailMode,
  type GuardrailMode,
} from '../lib/labelGuardrailSetting';
import { compareToMaxRate, phiHarvestWarning } from '../lib/labelGuardrails';
import { computeSeason } from '../utils/season';
import CustomerSharesTable from '../components/field-app/CustomerSharesTable';
import type { CustomerSharesBasis } from '../components/field-app/customerSplit';
import ApplicationServicePicker from '../components/field-app/ApplicationServicePicker';
import { downloadInvoicePdf, buildInvoicePdfDataFromRow, generateInvoicePdf } from '../lib/invoicePdf';
import { fetchWeatherForDateTime, parseCentroid } from '../lib/weatherCapture';
import {
  parseDiluentRate,
  isDiluentInputValid,
  computeTotalDiluentGallons,
  formatGallons,
} from '../lib/fieldAppDiluent';
import {
  EMPTY_WEATHER_SET,
  weatherSetFromRow,
  applyCapturedWeather,
  applyManualEdit,
  buildWeatherRpcParams,
  invalidateAutoWeather,
  WEATHER_DISCLAIMER,
  type WeatherSetForm,
} from '../lib/fieldAppWeather';
import { sendEmail, pdfToBase64, buildInvoiceEmailPayload, isInvoiceEmailSuppressed } from '../lib/emailService';
import {
  countSentPostNotifications,
  describePostNotificationSend,
} from '../lib/postNotification';
// §6: "Your Field Was Sprayed" rich proof — assembled from get_job_proof_data and
// sent through the SAME record/confirm post-notification RPCs (office one-tap, not auto).
import {
  buildProofDraft,
  buildProofEmailPayload,
  proofSubject,
  renderProofText,
  type JobProofData,
  type ProofDraft,
} from '../lib/proofNotification';
import { runCriticalAction } from '../lib/criticalAction';
import {
  carryoverRowsFromRecords,
  realApplicatorName,
  applicatorNameFor,
  type AppliedCarryoverRow,
} from '../components/field-app/invoiceAppliedCarryover';
import type {
  Field,
  CustomerShareResult,
  InvoiceStatus,
  DeriveCustomerSharesResult,
  FieldAppInvoiceResult,
  PreviewFieldAppSplitResult,
  JobAppliedRecordRow,
  JobNotification,
  JobStatus,
  Profile,
} from '../types';

// Joined applicator/vehicle/weather/crew record is read with the same shape
// AppliedRecordsManager uses, so the carry-over panel and the job's Applied Info
// tab never drift. profiles is intentionally NOT embedded (RLS nulls it for
// non-admins) — applicator names come from a profile_public_view name map.
const APPLIED_RECORD_SELECT =
  '*, vehicle:vehicles!job_applied_records_vehicle_id_fkey(vehicle_name, vehicle_type), job_applied_record_fields(id, application_record_id, field_id, applied_acres, created_at, updated_at), job_applied_record_crew(id, application_record_id, member_id, member_name_snapshot, crew_id_snapshot, crew_name_snapshot, created_at, member:ground_crew_members(name, is_active))';

// One notification entry addressed to the current viewer about this invoice / its
// source job. The notifications table is RLS-scoped to user_id = auth.uid(), so this
// can only show the VIEWER'S OWN notices — never customer-facing ones. The CUSTOMER
// pre/post-application notification system is built separately in #40/#41; this tab
// just surfaces whatever in-app notices keyed to this invoice or job the viewer has.
interface NotificationRow {
  id: string;
  title: string;
  message: string | null;
  notification_type: string | null;
  created_at: string;
  related_entity_type: string | null;
}

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

type TabKey = 'locations' | 'chemicals' | 'customers' | 'applied_info' | 'notifications';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'locations', label: 'Locations', icon: <MapPin className="w-4 h-4" /> },
  { key: 'chemicals', label: 'Chemicals/Charges', icon: <FlaskConical className="w-4 h-4" /> },
  { key: 'customers', label: 'Customers', icon: <Users className="w-4 h-4" /> },
  { key: 'applied_info', label: 'Applied Info', icon: <ClipboardList className="w-4 h-4" /> },
  { key: 'notifications', label: 'Notifications', icon: <Bell className="w-4 h-4" /> },
];

// Translate the field-app server error codes into plain, actionable sentences for
// non-technical staff (the page surfaces raw codes like ZERO_APPLIED_ACRES otherwise).
// Falls back to sanitizeError for anything unrecognized.
function fieldAppError(err: unknown): string {
  if (hasRpcCode(err, RpcErrorCodes.ZERO_APPLIED_ACRES)) return 'A location has 0 or blank applied acres. Open the Locations tab and enter the acres sprayed for each field.';
  if (hasRpcCode(err, RpcErrorCodes.ACTOR_MISMATCH)) return 'Your sign-in could not be verified. Refresh the page and try again.';
  // U7: this invoice is one member of a multi-owner split group — it can't be reversed
  // member-by-member (that would reopen the job while the other owners' invoices stay live).
  if (hasRpcCode(err, RpcErrorCodes.JOB_BILLED_AS_GROUP)) return 'This job was invoiced as a multi-owner split. To return it to scheduling, void each owner’s invoice — voiding the last one reopens the job.';
  // check_period_open() raises a plain-English sentence ("Date X falls in closed
  // accounting period (...)"), which sanitizeError passes through readably — no token to match.
  return sanitizeError(err);
}

export default function FieldApplicationInvoice() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const saveIdem = useIdempotencyKey('save_field_app_invoice', profile?.id || '');
  // #33: per-invoice key cache for the billing-details RPC (PO/terms/due/footer/memo
  // + per-invoice Discount Earned). Keyed by the editor's invoice id (or '__new__'
  // before the first save) so a retry after a timeout reuses the SAME idempotency key
  // and the server dedup never double-applies.
  const billingKeysRef = useRef<Record<string, string>>({});
  const postIdem = useIdempotencyKey('post_invoice_group', profile?.id || '');
  const deleteIdem = useIdempotencyKey('delete_invoices', profile?.id || '');
  // #27: reverse "Transfer to Scheduling" — push a job-built invoice back to its job.
  const transferToSchedulingIdem = useIdempotencyKey('transfer_invoice_to_job', profile?.id || '');
  // #28: Unpost — reverse a posting (posted/overdue -> unposted) right on this screen.
  // Per-invoice key cache (keyed by invoice id) for the SINGLE-invoice path.
  // FIX 4 (Wave 2a): a SPLIT GROUP routes through the atomic unpost_invoice_group under
  // its own group key (all-or-nothing) instead of looping members in JS.
  // #28/FIX 4: per-invoice AND per-group key cache (keyed by invoice id, or `grp:<groupId>`
  // for the atomic group unpost) so a retry reuses the same key while a different
  // invoice/group always gets its own — no useIdempotencyKey hook (its per-render object
  // would loop a fetch effect; a ref map is render-stable and inherently per-group).
  const unpostKeysRef = useRef<Record<string, string>>({});
  // #29: Void — cancel/void this bill right on this screen (draft/unposted -> cancelled,
  // posted/overdue -> voided). Same per-invoice key cache so a split group is voided
  // member-by-member (no group RPC) with one stable, idempotent key per member.
  const voidKeysRef = useRef<Record<string, string>>({});

  const [activeTab, setActiveTab] = useState<TabKey>('locations');
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showLocationsModal, setShowLocationsModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // #28: Post confirm + Unpost confirm/in-flight state.
  const [showPostConfirm, setShowPostConfirm] = useState(false);
  const [showUnpostConfirm, setShowUnpostConfirm] = useState(false);
  const [unposting, setUnposting] = useState(false);
  // #29: Void modal + required-reason + in-flight state. Void needs its own Modal
  // (not a ConfirmModal) because the reason is mandatory — the confirm button is
  // disabled until a non-empty reason is entered (acceptance criterion: forced reason).
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);
  // #27: reverse "Transfer to Scheduling" — confirm + in-flight state.
  const [showTransferToSchedulingConfirm, setShowTransferToSchedulingConfirm] = useState(false);
  const [transferringToScheduling, setTransferringToScheduling] = useState(false);

  const [invoiceNumber, setInvoiceNumber] = useState('');
  // todayInBusinessTz(), NOT new Date().toISOString() and NOT localToday().
  // toISOString() converts to UTC, so from ~7 pm Chicago this pre-filled TOMORROW — the same
  // UTC/Chicago bug the server-side invoice_date fallbacks fixed on 2026-09-04. Because this
  // page ALWAYS sends invoice_date, the server fallback never engages here, so the wrong day
  // could only be fixed on the client. On 2026-09-30 after 7 pm it pre-filled 2026-10-01,
  // filing the invoice in season 2027.
  // localToday() fixes that only for a browser whose own clock is Chicago. An invoice date is a
  // company-wide accounting fact, so it must follow Crop RX's business timezone regardless of
  // where the user is sitting — otherwise a salesman on Pacific time creates 2026-09-30
  // invoices while Chicago is already on 2026-10-01, landing them in the wrong season.
  const [transactionDate, setTransactionDate] = useState(todayInBusinessTz());
  const [notes, setNotes] = useState(''); // header_notes (printed)
  // #33: ChemMan billing details. Header/footer notes + PO + due date already
  // existed on invoices; payment_terms / internal_notes / discount are new (migration
  // 20260625150000). The header fields apply uniformly to the whole split group; the
  // Discount Earned is per-invoice (one invoice row per customer in a split).
  // poRef/terms/dueDate/footerNotes/internalMemo are uniform across the group.
  const [poRef, setPoRef] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('Net 30');
  // A non-standard terms string loaded from the DB (e.g. legacy 'Net 45') shows as
  // 'Custom date…' in the picker; preserve the original text so saving doesn't
  // overwrite it with the picker's sentinel label.
  const [customTermsText, setCustomTermsText] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [footerNotes, setFooterNotes] = useState('');
  const [internalMemo, setInternalMemo] = useState(''); // internal_notes — NOT printed
  // #33: Discount Earned is owner-driven + DISPLAY-ONLY (it NEVER folds into the
  // GENERATED balance_cents). The editor draft is keyed by CUSTOMER_ID — not by
  // invoice id — so it works on a brand-NEW invoice too, where no invoice id exists
  // yet (the Customers-tab editor is reachable pre-save via Preview). Each customer's
  // typed dollars string (blank/partial mid-edit allowed) + optional date is held
  // here and translated to per-invoice bigint cents only at SAVE, once the created
  // invoice id(s) are known. Loaded from each member's discount_earned_cents/date
  // keyed by that member's customer_id.
  // (Pre-fix this was keyed by invoice id, so on a new invoice the editor dropped
  // every keystroke — customerToInvoiceId resolved to {} and handleDiscountChange
  // early-returned. money-lens MED #1.)
  const [discountByCustomer, setDiscountByCustomer] =
    useState<Record<string, { dollars: string; date: string }>>({});
  const [status, setStatus] = useState<InvoiceStatus>('draft');
  // #24: the Consultant (responsible salesperson) on this invoice. Backed by the
  // existing invoices.salesman_id column — now user-selectable instead of being
  // forced implicitly to the saving user. Defaults to the current user on a new
  // invoice. NO migration: salesman_id already exists.
  const [consultantId, setConsultantId] = useState('');
  const [consultants, setConsultants] = useState<Profile[]>([]);
  // #24 (money-lens LOW#1): an UNFILTERED id -> name map (active AND inactive) used
  // ONLY to resolve the as-applied applicator's REAL name for the printed legal PDF.
  // The Consultant picker (`consultants`) stays active-only — you should not assign a
  // new invoice to an inactive person — but a now-inactive applicator who actually
  // sprayed the field is still a real, printable legal name (#17 LESSON). Resolving
  // the PDF name from the active-only list leaked '(removed applicator)' onto the bill.
  const [applicatorNameMap, setApplicatorNameMap] = useState<Map<string, string>>(new Map());

  const [locations, setLocations] = useState<FieldLocation[]>([]);
  const [chemicals, setChemicals] = useState<ChemicalLine[]>([]);
  const [shares, setShares] = useState<CustomerShareResult[]>([]);
  const [growerShareFieldNames, setGrowerShareFieldNames] = useState<string[]>([]);

  // §5 (Label-Rate Guardrails): the configurable policy (warn vs block). WARN is the
  // shipped/empty default and NEVER blocks the save. Loaded from app_settings once.
  const [guardrailMode, setGuardrailMode] = useState<GuardrailMode>(DEFAULT_GUARDRAIL_MODE);
  // §5 (Codex r6): TRUE once the mode read resolves. The block-mode save gate FAILS CLOSED
  // until then — a click before the read returns must not slip through as warn and skip a
  // required override.
  const [guardrailModeLoaded, setGuardrailModeLoaded] = useState(false);
  // §5: earliest planned harvest date across the selected fields (field_crop_history),
  // used for the PHI-vs-harvest warning. Null when none of the fields have a harvest date.
  const [earliestHarvestDate, setEarliestHarvestDate] = useState<string | null>(null);
  // §5: block-mode admin-override modal state + the captured reason.
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');

  const [windDirection, setWindDirection] = useState('');
  const [temperature, setTemperature] = useState('');
  const [applicator, setApplicator] = useState('');

  // ChemMan Gap-Closeout #1: structured START/END weather captured on the
  // invoice (mirrors job_applied_records + AppliedRecordsManager). Auto-fill via
  // the free Open-Meteo helper for the invoice's field + application date; manual
  // entry always works (offline fallback). Persisted via update_field_app_applied_info.
  const [startWeather, setStartWeather] = useState<WeatherSetForm>(EMPTY_WEATHER_SET);
  const [endWeather, setEndWeather] = useState<WeatherSetForm>(EMPTY_WEATHER_SET);
  // Field centroid {lat,lng} for the FIRST mapped location on this invoice — the
  // lookup point for Get Weather. Null when no location has a drawn boundary.
  const [weatherCentroid, setWeatherCentroid] = useState<{ lat: number; lng: number } | null>(null);
  // Which set is mid-fetch ('start' | 'end' | null) — drives the button spinner.
  const [fetchingWeather, setFetchingWeather] = useState<'start' | 'end' | null>(null);

  // ChemMan Gap-Closeout #2: diluent / carrier-water RATE per acre (gallons/acre),
  // mirroring the job-side jobs.carrier_rate_gpa. Held as a free-text string for the
  // controlled input (blank = not recorded). The TOTAL (rate x applied acres) is
  // derived for display + PDF; only the RATE is persisted (invoices.diluent_rate_gpa)
  // because invoices.total_acres is not reliably written on save. Diluent is a
  // QUANTITY, never money/cents.
  const [diluentRate, setDiluentRate] = useState('');
  // The weather lookup key (field + application date) last seen as SETTLED. Used to
  // invalidate stale AUTO readings when the user later changes the field or date — but
  // NOT on the initial load (which legitimately hydrates auto readings from the saved row).
  const weatherLookupKeyRef = useRef<string | null>(null);

  // #24: when this invoice was TRANSFERRED from a job (job_id set), read that
  // job's as-applied legal record(s) for a read-only carry-over panel on the
  // Applied Info tab — applicator/vehicle/date/weather/tach/crew. jobId stays null
  // for an engine-built invoice with no source job (the carry-over panel hides).
  const [jobId, setJobId] = useState<string | null>(null);
  // #41: the source job's status — gates the "Send Post-Notification" action (a post
  // notice requires an APPLIED job: completed or invoiced). Null for an engine-built
  // invoice with no source job (then the post action is hidden).
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  // #41 (Codex P2): the source job's APPLICATION date (jobs.job_date), used for the
  // post-notice {{job_date}} token. The invoice's transaction date is the BILLING
  // date and can differ — telling a customer the application happened on the billing
  // date would be wrong, so the notice uses the real application date from the job.
  const [jobApplicationDate, setJobApplicationDate] = useState<string | null>(null);
  const [appliedRecords, setAppliedRecords] = useState<JobAppliedRecordRow[]>([]);
  // #24: notification history addressed to the viewer for this invoice / its job.
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  // #41 (SHARED HISTORY — the load-bearing parity detail): the SAME customer-facing
  // job_notifications log shown on the job. Read by the invoice's source job_id, so a
  // pre/post notice sent from the job shows here and a post sent from here shows on the
  // job — one continuous history (criterion #3/#5). Distinct from `notifications`
  // above (the viewer's in-app notices). Empty when this invoice has no source job.
  const [jobNotifications, setJobNotifications] = useState<JobNotification[]>([]);
  const [loadingJobNotifications, setLoadingJobNotifications] = useState(false);
  // #41 (mirrors #40 MED): TRUE only after a SUCCESSFUL load — the re-send count is
  // only trustworthy once we've actually read the log (a failed load reads as "0 sent"
  // and would bypass the re-send warning). Gate the send on this so we FAIL CLOSED.
  const [jobNotificationsLoaded, setJobNotificationsLoaded] = useState(false);
  const [jobNotificationsError, setJobNotificationsError] = useState(false);
  // #41 (Codex P2): drop a STALE in-flight load from a PREVIOUSLY viewed invoice/job —
  // this component is reused across /invoices/field-app/:id navigation, so a slow load
  // for the old job must not clobber the new job's log + loaded flag (which would
  // compute the Send control's re-send state off the wrong job).
  const jobNotifLoadReqRef = useRef<string | null>(null);
  // #41: post-application notice send action state (mirrors JobDetail's).
  const [sendingPostNotice, setSendingPostNotice] = useState(false);
  const postNoticeIdem = useIdempotencyKey('record_job_post_notifications', profile?.id || '');
  const alreadySentPostCount = countSentPostNotifications(jobNotifications);
  const postSendCopy = describePostNotificationSend(alreadySentPostCount);
  // §6: the office-reviewable "your field was sprayed" PROOF draft. Built on demand from
  // get_job_proof_data when the office opens the preview; null until then. The same draft
  // is reused for the per-recipient email body when they approve the one-tap send, so the
  // proof they reviewed is exactly what goes out.
  const [proofDraft, setProofDraft] = useState<ProofDraft | null>(null);
  const [showProofPreview, setShowProofPreview] = useState(false);
  const [loadingProof, setLoadingProof] = useState(false);
  // #24 (money-lens LOW#2): surface a fetch error instead of a silent empty list, so
  // a broken query reads as an error rather than a misleading "No notifications yet".
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  // #24: print state + the money snapshot the PDF builder needs (kept off the
  // visible form — read from the loaded invoice row so the printed Balance Due
  // reconciles with payments/prepay).
  const [printing, setPrinting] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [pdfSnapshot, setPdfSnapshot] = useState<{
    customer_id: string;
    customer_name: string;
    due_date: string | null;
    purchase_order_ref: string | null;
    footer_notes: string | null;
    payment_terms: string | null;
    discount_earned_cents: number;
    total_amount_cents: number;
    total_cost_cents: number | null;
    paid_amount_cents: number | null;
    prepay_applied_cents: number | null;
    write_off_cents: number | null;
    balance_cents: number;
    /** Per-line split billing: server-computed send disposition. A
     *  'suppressed_zero_total' $0 split child is recorded + shown in the account
     *  summary but never emailed. Undefined until the split-billing migration lands. */
    send_disposition?: 'normal' | 'suppressed_zero_total';
  } | null>(null);

  // Phase 1 (2026-04-29) state
  const [appServiceId, setAppServiceId] = useState<string | null>(null);
  const [invoiceGroupId, setInvoiceGroupId] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<SiblingInvoice[]>([]);
  const [primaryCustomerTier, setPrimaryCustomerTier] = useState<number>(1);
  const [previewData, setPreviewData] = useState<PreviewFieldAppSplitResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // #26: source job number for the ChemMan "<jobnumber>-<NNN>" split-ref. Set
  // when this field invoice was transferred from / linked to a job (job_id);
  // null for a pure engine-built invoice (then the split-ref falls back to the
  // group's primary invoice number).
  const [jobNumber, setJobNumber] = useState<string | null>(null);
  // #26: "Customer Shares By" basis (Locations / Share %). Presentation only —
  // the engine always splits by acres-weighted per-location share.
  const [sharesBasis, setSharesBasis] = useState<CustomerSharesBasis>('location');

  const blocker = useUnsavedChanges(dirty);

  const isNew = !id;
  // #24: only an ADMIN may attribute the invoice to another consultant. The save
  // RPC rejects a non-admin who sets salesman_id to anyone but themselves
  // ([B1.5]), so the picker is read-only for sales_reps and a non-admin save
  // always sends their own id.
  const isAdmin = profile?.role === 'admin';
  const isAdminOrRep = isAdmin || profile?.role === 'sales_rep';

  // #24: load the Consultant picker list from profile_public_view (admin /
  // sales_rep / applicator, active only). profile_public_view is the non-PII view
  // readable by sales_rep — NEVER a profiles embed (RLS nulls it for non-admins).
  // Same source the JobDetail Consultant selector uses, so the two agree.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Active-only list for the Consultant picker.
      const { data } = await supabase
        .from('profile_public_view')
        .select('id, full_name, role, is_active')
        .in('role', ['applicator', 'admin', 'sales_rep'])
        .eq('is_active', true)
        .order('full_name');
      if (!cancelled) setConsultants((data || []) as Profile[]);

      // #24 (LOW#1): UNFILTERED id -> name map (active AND inactive) for resolving the
      // as-applied applicator's real legal name on the PDF. profile_public_view is the
      // non-PII view readable by sales_rep — never a profiles embed (RLS nulls it).
      const { data: allRows } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('role', ['applicator', 'admin', 'sales_rep']);
      if (!cancelled) {
        setApplicatorNameMap(
          new Map((allRows || []).map((r) => [r.id as string, (r.full_name as string | null) ?? ''])),
        );
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // On a brand-new invoice, default the Consultant to the current user (matches
  // the prior implicit salesman_id = profile.id behaviour, now visible + editable).
  useEffect(() => {
    if (isNew && profile?.id) setConsultantId((prev) => prev || profile.id);
  }, [isNew, profile?.id]);

  // §5: load the label-rate guardrail policy once. A failed/absent read falls back to
  // the safe default ('warn') — we never silently switch to 'block'.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('app_settings')
        .select('setting_value')
        .eq('setting_key', LABEL_RATE_GUARDRAIL_MODE_KEY)
        .maybeSingle();
      if (!cancelled) {
        setGuardrailMode(parseGuardrailMode((data as { setting_value?: string } | null)?.setting_value ?? null));
        setGuardrailModeLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // §5: load the earliest planned harvest date across the selected fields from
  // field_crop_history (for the PHI-vs-harvest warning). SCOPED to the application's SEASON
  // (Codex P2 fix) — field_crop_history holds one row per field/season, so without the
  // season filter an OLD prior-season harvest would falsely trip the PHI window. Re-runs
  // when the field set OR the application date changes. A field with no harvest row in the
  // season contributes nothing (graceful — no warning).
  const locationFieldKey = locations.map((l) => l.field_id).sort().join(',');
  const guardrailAppDate = jobApplicationDate ?? transactionDate;

  // #1 (weather auto-fill): resolve the lookup point for Get Weather — the
  // centroid of the FIRST mapped location on this invoice — via get_field_geojson
  // + parseCentroid (the AppliedRecordsManager pattern). Null when no location has
  // a drawn boundary; the Get Weather button then disables and the user types
  // weather by hand. Re-runs when the field set changes (a slow lookup for the old
  // field is dropped via the cancelled flag so it can't clobber the new centroid).
  const firstFieldId = locations.length > 0 ? locations[0].field_id : null;
  useEffect(() => {
    let cancelled = false;
    // Clear the previous field's centroid IMMEDIATELY so that while the new lookup is in
    // flight the Get Weather button disables (no centroid) — otherwise the stale coords
    // could attach the prior field's weather to the newly selected location (Codex race).
    setWeatherCentroid(null);
    if (!firstFieldId) { return; }
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_field_geojson', { p_field_id: firstFieldId });
        if (cancelled) return;
        if (error) { setWeatherCentroid(null); return; }
        // get_field_geojson RETURNS TABLE(centroid_geojson text, boundary_geojson text)
        // → PostgREST yields an array of rows; mirror JobDetail's centroid resolution.
        const rows = assertRpcResult<Array<{ centroid_geojson?: string | null }>>(data, 'get_field_geojson');
        setWeatherCentroid(parseCentroid(rows[0]?.centroid_geojson));
      } catch {
        if (!cancelled) setWeatherCentroid(null);
      }
    })();
    return () => { cancelled = true; };
  }, [firstFieldId]);
  useEffect(() => {
    let cancelled = false;
    const fieldIds = locationFieldKey ? locationFieldKey.split(',') : [];
    if (fieldIds.length === 0) { setEarliestHarvestDate(null); return; }
    // Parse the YYYY-MM-DD as a LOCAL date (NOT UTC) so a season-boundary date like
    // Oct 1 doesn't shift into the prior season's evening before computeSeason reads the
    // month. (Codex r2 P2.)
    const appSeason = computeSeason(guardrailAppDate ? new Date(guardrailAppDate + 'T00:00:00') : new Date());
    (async () => {
      const { data, error } = await supabase
        .from('field_crop_history')
        .select('harvest_date')
        .in('field_id', fieldIds)
        .eq('season', appSeason)
        .not('harvest_date', 'is', null)
        .order('harvest_date', { ascending: true })
        .limit(1);
      if (cancelled) return;
      if (error) { setEarliestHarvestDate(null); return; }
      const first = (data as Array<{ harvest_date: string | null }> | null)?.[0]?.harvest_date ?? null;
      setEarliestHarvestDate(first);
    })();
    return () => { cancelled = true; };
  }, [locationFieldKey, guardrailAppDate]);

  // §5 (Codex P2 fix): the aggregate guardrail state is computed HERE in the parent from
  // `chemicals` — NOT inside the Chemicals-tab component — so the BLOCK-mode save gate is
  // correct even when the Chemicals tab was never opened (e.g. saving header/location edits
  // on a reopened invoice). 'cannot_compare' / 'no_label_max' never count toward the gate.
  const guardrailState = useMemo(() => {
    const overRateProducts: string[] = [];
    let phiHarvestWarnCount = 0;
    const appDate = jobApplicationDate ?? transactionDate;
    for (const c of chemicals) {
      if (c.product_id == null) continue;
      const cmp = compareToMaxRate(c.rate_per_acre, c.rate_unit, c.max_label_rate ?? null, c.max_label_rate_unit ?? null);
      if (cmp.status === 'over') overRateProducts.push(c.product_name || 'Unnamed product');
      if (phiHarvestWarning(c.phi_days ?? null, earliestHarvestDate, appDate).status === 'inside_window') {
        phiHarvestWarnCount += 1;
      }
    }
    return { overRateCount: overRateProducts.length, overRateProducts, phiHarvestWarnCount };
  }, [chemicals, earliestHarvestDate, jobApplicationDate, transactionDate]);

  // Resolve an applicator id -> name for the carry-over panel (live name map).
  const applicatorNames = useMemo(
    () => new Map(consultants.map((c) => [c.id, c.full_name ?? ''])),
    [consultants],
  );

  // #24: derive the read-only carry-over display rows from the raw as-applied
  // records + the (possibly-later-loaded) name map. Computed at render time so a
  // late-arriving consultant list refreshes names WITHOUT re-fetching the invoice
  // (which would clobber unsaved form edits).
  const carryover = useMemo<AppliedCarryoverRow[]>(
    () => carryoverRowsFromRecords(appliedRecords, applicatorNames),
    [appliedRecords, applicatorNames],
  );

  const totalAppliedAcres = useMemo(
    () => locations.reduce((sum, l) => sum + (l.applied_acres || 0), 0),
    [locations]
  );

  // #2: the diluent rate parsed from the input (null when blank/non-numeric),
  // whether the RAW input is a valid save value, and the derived total diluent
  // (rate x applied acres — null, never 0, when the rate is absent/invalid).
  // diluentRateValid checks the RAW string (not the parsed value) so a non-empty
  // unparseable typo ("-", "e") is rejected rather than read as "blank" and used
  // to silently clear a saved rate on save (Codex P2).
  const diluentRateNum = useMemo(() => parseDiluentRate(diluentRate), [diluentRate]);
  const diluentRateValid = useMemo(() => isDiluentInputValid(diluentRate), [diluentRate]);
  const totalDiluentGallons = useMemo(
    () => computeTotalDiluentGallons(diluentRateNum, totalAppliedAcres),
    [diluentRateNum, totalAppliedAcres],
  );

  // #1 (weather auto-fill) handlers ─────────────────────────────────────────
  // The application date used for the lookup mirrors the rest of the page: the
  // source job's application date when transferred, else the invoice's date.
  const weatherAppDate = jobApplicationDate ?? transactionDate;

  // A modeled (auto) reading is keyed to a specific field + application date. When the
  // user CHANGES the field or the date, any auto reading no longer describes the new
  // application — clear it (manual entries are kept) so stale modeled conditions can't be
  // saved as current compliance data (Codex r2 P2).
  //
  // Ordering hazard (Codex r3 P1): on initial load the key settles in TWO steps — the
  // invoice row arrives first (key '|<date>'), then `locations` supply the field a tick
  // later (key '<field>|<date>'). We must NOT treat that async hydration as a user change
  // and wipe the just-loaded auto weather. So invalidation runs ONLY when the form is
  // already `dirty` (a real user edit set it) — initial load leaves dirty=false, so the
  // hydrated values survive. We still keep the ref current during load so the FIRST
  // user-driven change after load is detected correctly.
  const weatherLookupKey = `${firstFieldId ?? ''}|${weatherAppDate ?? ''}`;
  useEffect(() => {
    const prevKey = weatherLookupKeyRef.current;
    weatherLookupKeyRef.current = weatherLookupKey;
    // Only a real user edit (dirty) on a genuinely-changed key invalidates auto readings;
    // load-time hydration (dirty=false) and the first settle (prevKey null) are no-ops.
    if (prevKey === null || prevKey === weatherLookupKey || !dirty) return;
    setStartWeather((prev) => invalidateAutoWeather(prev));
    setEndWeather((prev) => invalidateAutoWeather(prev));
  }, [weatherLookupKey, dirty]);

  // Edit one reading of a weather set by hand. Any manual edit flips source ->
  // 'manual' (the value is no longer a pristine auto pull — legal-record integrity).
  const updateWeather = useCallback(
    (set: 'start' | 'end', key: 'time' | 'temp_f' | 'wind_mph' | 'wind_direction' | 'humidity_pct', value: string) => {
      const setter = set === 'start' ? setStartWeather : setEndWeather;
      setter((prev) => applyManualEdit(prev, key, value));
      setDirty(true);
    },
    [],
  );

  // NOW: stamp the current local clock time (HH:MM) into a set's time.
  const stampWeatherNow = useCallback((set: 'start' | 'end') => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    updateWeather(set, 'time', hhmm);
  }, [updateWeather]);

  // Get Weather: auto-pull from Open-Meteo for the application date + the set's
  // time (midday fallback when blank) at the field centroid. On success the four
  // readings fill and source -> 'auto'; on failure (offline / no data / no
  // coordinates) the user gets a clear message and can still type by hand —
  // auto-pull failure NEVER blocks saving (manual fallback is always available).
  const getWeather = useCallback(async (set: 'start' | 'end') => {
    if (!weatherCentroid) {
      toast('error', 'No mapped field location for this invoice — enter weather manually.');
      return;
    }
    if (!weatherAppDate) {
      toast('error', 'Set the invoice date first, then Get Weather.');
      return;
    }
    const cur = set === 'start' ? startWeather : endWeather;
    // Snapshot the lookup key AND the set's time at request time. If the user changes the
    // field/date (key) OR this set's time while the request is in flight, the resolved reading
    // describes the OLD inputs and must be dropped (Codex r3/r7 P2) — otherwise stale modeled
    // conditions, or readings under the wrong clock time, land on the record.
    const keyAtRequest = weatherLookupKey;
    const timeAtRequest = cur.time;
    setFetchingWeather(set);
    const w = await fetchWeatherForDateTime(weatherCentroid.lat, weatherCentroid.lng, weatherAppDate, cur.time || null);
    setFetchingWeather(null);
    if (weatherLookupKeyRef.current !== keyAtRequest) {
      toast('error', 'Field or date changed while fetching — Get Weather again for the new values.');
      return;
    }
    if (!w) {
      toast('error', 'Could not fetch weather — enter conditions manually.');
      return;
    }
    const setter = set === 'start' ? setStartWeather : setEndWeather;
    let staleTime = false;
    setter((prev) => {
      // The set's time was edited mid-fetch → the reading is for the old hour; drop it
      // (the functional updater sees the freshest time, avoiding a stale-closure compare).
      if (prev.time !== timeAtRequest) { staleTime = true; return prev; }
      return applyCapturedWeather(prev, w);
    });
    if (staleTime) {
      toast('error', 'Time changed while fetching — Get Weather again for the new time.');
      return;
    }
    setDirty(true);
    toast('success', 'Weather filled from Open-Meteo — verify on-site before relying on it.');
  }, [weatherCentroid, weatherAppDate, weatherLookupKey, startWeather, endWeather, toast]);

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

  // #33: map each billed customer to THEIR invoice id (each customer has one invoice
  // row in a split; an un-split invoice maps its single customer to `id`). Used ONLY
  // to resolve which customer's draft prints on THIS (the URL) invoice's PDF — the
  // editor draft itself is keyed by customer_id and needs no invoice id. siblings
  // carries {id, customer_id} for the group (1 invoice per customer — a true 1:1 map).
  // For an UN-split invoice there is exactly ONE invoice (and so one Discount Earned),
  // even when multiple growers SHARE it; the preview rows are keyed by the SHARE
  // customer_id, which can differ from invoices.customer_id. So we anchor the single
  // discount to the PRIMARY share customer (the row the preview marks is_primary),
  // falling back to any share, then to the invoice's own customer_id.
  const customerToInvoiceId = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    if (siblings.length > 0) {
      siblings.forEach((s) => { map[s.customer_id] = s.id; });
    } else if (id) {
      // Un-split: one invoice, one billed customer. Anchor the single editable
      // discount to the invoice's OWN billed customer (invoices.customer_id, via
      // pdfSnapshot) so load (keyed by invoices.customer_id) and save (writes back
      // to that invoice) agree. Fall back to the primary share customer only when the
      // invoice's customer isn't known yet (pre-snapshot).
      const anchor = pdfSnapshot?.customer_id
        ?? shares.find((s) => s.is_primary)?.customer_id
        ?? shares[0]?.customer_id;
      if (anchor) map[anchor] = id;
    }
    return map;
  }, [siblings, id, shares, pdfSnapshot?.customer_id]);

  // #33: the customer_id whose Discount Earned prints on THIS (the URL) invoice's PDF.
  // For a split, each sibling invoice carries its own customer; for an un-split invoice
  // it's the anchored primary-share customer (or the invoice's own customer_id).
  const customerForThisInvoice = useMemo<string | null>(() => {
    if (!id) return null;
    const entry = Object.entries(customerToInvoiceId).find(([, invId]) => invId === id);
    return entry?.[0] ?? null;
  }, [id, customerToInvoiceId]);

  // #33: typed dollars → bigint cents for a given customer (0 when blank/invalid).
  // Used to print the THIS-invoice Discount Earned line on the PDF.
  const discountCentsForCustomer = useCallback((custId: string | null): number => {
    if (!custId) return 0;
    const dollars = parseFloat(discountByCustomer[custId]?.dollars ?? '');
    return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
  }, [discountByCustomer]);

  // #33: editor edit handler — writes the per-customer draft DIRECTLY (no invoice id
  // needed), so a brand-new invoice's Preview discount edits are captured and reach
  // the save translation instead of being silently dropped. Sets dirty so Save persists.
  const handleDiscountChange = useCallback((customerId: string, patch: { dollars?: string; date?: string }) => {
    setDiscountByCustomer((prev) => ({
      ...prev,
      [customerId]: { ...(prev[customerId] || { dollars: '', date: '' }), ...patch },
    }));
    setDirty(true);
  }, []);

  // #26: base for the ChemMan "<base>-<NNN>" split reference. Prefer the source
  // job number; else the group's PRIMARY (lowest) saved invoice number; else the
  // current invoice number. Display-only — the real invoice_number is untouched.
  const splitRefBase = useMemo<string | null>(() => {
    if (jobNumber) return jobNumber;
    if (siblings.length > 0) {
      return [...siblings]
        .map((s) => s.invoice_number)
        .filter(Boolean)
        .sort()[0] ?? null;
    }
    return invoiceNumber || null;
  }, [jobNumber, siblings, invoiceNumber]);

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
    // #24 (refines the #22 discriminator): the per-acre field-app editor owns any
    // field invoice that has per-acre LOCATIONS (field_app_locations). A field
    // invoice with NO locations but WITH a job_id/blend_ticket_id is a quantity-
    // line invoice built from a job/blend ticket — that belongs to the generic
    // editor. Using locations (not "job_id is set") as the test lets a TRANSFERRED
    // field-app invoice (#27 — it has both job_id AND locations) stay HERE so its
    // Locations / Applied-Info carry-over / Notifications tabs render, instead of
    // being bounced to the generic editor that has none of them.
    const hasJobOrBlend = (chk as { job_id?: string | null }).job_id
        || (chk as { blend_ticket_id?: string | null }).blend_ticket_id;
    if (hasJobOrBlend) {
      const { count: locCount } = await supabase
        .from('field_app_locations')
        .select('field_id', { count: 'exact', head: true })
        .eq('invoice_id', id);
      if (!locCount || locCount === 0) {
        navigate(`/field-invoices/${id}`, { replace: true });
        return;
      }
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
    // #A (Codex round-2): a per-line SPLIT child must never be edited in this per-acre editor —
    // its save_field_app_invoice would rewrite invoice_items and cascade away the split's
    // invoice_line_shares. This load uses select('*') (tolerant of the column's absence before the
    // split migration), so detecting it here is deploy-order-safe. Send it to the read-only Split
    // Billing view keyed by the billing set (breaks any redirect loop with InvoiceDetail).
    const splitSetId = (invoice.field_app_billing_set_id as string | null) ?? null;
    if (splitSetId) {
      navigate(`/split-billing/${splitSetId}`, { replace: true });
      return;
    }
    setInvoiceNumber((invoice.invoice_number as string) || '');
    setTransactionDate((invoice.invoice_date as string) || '');
    setNotes((invoice.header_notes as string) || '');
    // #33: load the ChemMan billing details from the loaded invoice. These header
    // fields are uniform across a split group (the save RPC writes them to every
    // member), so reading them off the URL invoice is correct.
    setPoRef((invoice.purchase_order_ref as string | null) || '');
    const loadedPaymentTerms = (invoice.payment_terms as string | null) || '';
    const loadedDueDate = (invoice.due_date as string | null) || '';
    // Picker mode from BOTH fields (CodeRabbit P1s on PR #195):
    // - an explicit due_date on a draft/unposted invoice means a deliberate override —
    //   show Custom mode with the date so a save round-trips it instead of erasing it;
    // - receipt-form aliases the parser understands normalize to the preset;
    // - any other legacy free-text (e.g. 'Net 45') keeps its own picker entry (rendered
    //   dynamically) so it never gets reclassified as Custom and never demands a date.
    const isPreset = ['Net 30', 'Net 15', 'Due on receipt'].includes(loadedPaymentTerms);
    const isReceiptAlias = ['due on receipt', 'due upon receipt', 'receipt', 'immediately'].includes(
      loadedPaymentTerms.trim().toLowerCase(),
    );
    // An unposted invoice keeps the due_date the posting RPC stamped. If the stored
    // date is exactly what the preset terms would stamp from invoice_date, it's a
    // stamp — reload as the preset (clearing the date so a repost re-derives it),
    // not as a deliberate Custom override (CodeRabbit P2 on PR #195).
    // Mirror parse_payment_terms_days for ANY stored terms (incl. legacy 'Net 45' /
    // 'net_30'), not just the three presets, so their posting stamps are recognized too.
    const termDays = isReceiptAlias
      ? 0
      : (() => {
          const m = /(\d+)/.exec(loadedPaymentTerms);
          const n = m ? Number(m[1]) : NaN;
          return Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
        })();
    const loadedInvoiceDate = (invoice.invoice_date as string) || '';
    let stampedDate = '';
    if (loadedInvoiceDate) {
      const d = new Date(loadedInvoiceDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + termDays);
      stampedDate = d.toISOString().slice(0, 10);
    }
    const isPostingStamp = loadedDueDate !== '' && loadedDueDate === stampedDate;
    if (
      loadedDueDate &&
      !isPostingStamp &&
      ['draft', 'unposted'].includes((invoice.status as string) || 'draft')
    ) {
      setPaymentTerms('Custom date…');
      // keep the stored terms text (even a preset like 'Net 30') so the save
      // round-trips it verbatim; the explicit due_date wins server-side anyway.
      setCustomTermsText(loadedPaymentTerms);
    } else if (isPreset) {
      setPaymentTerms(loadedPaymentTerms);
      setCustomTermsText('');
    } else if (isReceiptAlias) {
      setPaymentTerms('Due on receipt');
      setCustomTermsText('');
    } else {
      // legacy free-text (or blank -> Net 30 default)
      setPaymentTerms(loadedPaymentTerms || 'Net 30');
      setCustomTermsText('');
    }
    // A recognized posting stamp on a still-editable invoice is NOT kept as local
    // state: the print path would treat it as explicit and skip re-deriving after a
    // transaction-date edit. Posted/locked invoices keep it for read-only display.
    setDueDate(
      isPostingStamp && ['draft', 'unposted'].includes((invoice.status as string) || 'draft')
        ? ''
        : loadedDueDate,
    );
    setFooterNotes((invoice.footer_notes as string | null) || '');
    setInternalMemo((invoice.internal_notes as string | null) || '');
    setStatus((invoice.status as InvoiceStatus) || 'draft');
    setAppServiceId((invoice.application_service_id as string | null) || null);
    // #24: Consultant = invoices.salesman_id (the responsible salesperson),
    // now user-selectable. Carry the existing value into the picker.
    setConsultantId((invoice.salesman_id as string | null) || '');
    // #24: the source job, when this invoice was transferred from one. Used to
    // load the as-applied carry-over panel below. NULL for an engine-built invoice.
    const srcJobId = (invoice.job_id as string | null) || null;
    setJobId(srcJobId);
    // #26: when this invoice came from a job, read the job number so the
    // Customers tab can render the ChemMan "<jobnumber>-<NNN>" split-ref. A pure
    // engine-built invoice (no job_id) falls back to the primary invoice number.
    if (srcJobId) {
      const { data: jobRow } = await supabase
        .from('jobs')
        .select('job_number, status, job_date')
        .eq('id', srcJobId)
        .maybeSingle();
      setJobNumber((jobRow as { job_number?: string } | null)?.job_number ?? null);
      // #41: source job status gates the post-notification action (completed/invoiced).
      setJobStatus(((jobRow as { status?: string } | null)?.status as JobStatus | undefined) ?? null);
      // #41 (Codex P2): the real application date for the post-notice {{job_date}}.
      setJobApplicationDate(((jobRow as { job_date?: string | null } | null)?.job_date) ?? null);
    } else {
      setJobNumber(null);
      setJobStatus(null);
      setJobApplicationDate(null);
    }
    // #24: snapshot the money + header fields the PDF builder needs so Print
    // reconciles (Balance Due = Total − payments − prepay). balance_cents is the
    // GENERATED source of truth for AR; never recompute it client-side.
    setPdfSnapshot({
      customer_id: (invoice.customer_id as string) || '',
      customer_name: '', // filled from shares/customer by buildInvoicePdfDataFromRow
      due_date: (invoice.due_date as string | null) || null,
      purchase_order_ref: (invoice.purchase_order_ref as string | null) || null,
      footer_notes: (invoice.footer_notes as string | null) || null,
      payment_terms: (invoice.payment_terms as string | null) || null,
      discount_earned_cents: (invoice.discount_earned_cents as number | null) ?? 0,
      total_amount_cents: (invoice.total_amount_cents as number) || 0,
      total_cost_cents: (invoice.total_cost_cents as number | null) ?? null,
      paid_amount_cents: (invoice.paid_amount_cents as number | null) ?? null,
      prepay_applied_cents: (invoice.prepay_applied_cents as number | null) ?? null,
      write_off_cents: (invoice.write_off_cents as number | null) ?? null,
      balance_cents: (invoice.balance_cents as number) || 0,
      // Carry the server-computed suppression flag so the email gate (isInvoiceEmailSuppressed)
      // actually fires for a $0 split child opened here (Codex P2 #10).
      send_disposition: (invoice.send_disposition as 'normal' | 'suppressed_zero_total' | undefined) ?? undefined,
    });
    // Wave B.1 / P2-1: load Applied Info from the invoice row. These are
    // free-form text columns added so the values persist round-trip.
    // temperature_text was renamed from "temperature" in B audit B-3 to
    // disambiguate from sibling numeric temperature columns elsewhere.
    setWindDirection((invoice.wind_direction as string | null) || '');
    setTemperature((invoice.temperature_text as string | null) || '');
    setApplicator((invoice.applicator_name as string | null) || '');

    // #1: load the structured START/END weather from the invoice row. The row
    // carries the same column shape as job_applied_records; weatherSetFromRow
    // turns the nullable columns into controlled-input strings (blank, not "null").
    const weatherRow = {
      start_temp_f: (invoice.start_temp_f as number | null) ?? null,
      start_wind_mph: (invoice.start_wind_mph as number | null) ?? null,
      start_wind_direction: (invoice.start_wind_direction as string | null) ?? null,
      start_humidity_pct: (invoice.start_humidity_pct as number | null) ?? null,
      start_weather_time: (invoice.start_weather_time as string | null) ?? null,
      start_weather_source: (invoice.start_weather_source as 'auto' | 'manual' | null) ?? null,
      end_temp_f: (invoice.end_temp_f as number | null) ?? null,
      end_wind_mph: (invoice.end_wind_mph as number | null) ?? null,
      end_wind_direction: (invoice.end_wind_direction as string | null) ?? null,
      end_humidity_pct: (invoice.end_humidity_pct as number | null) ?? null,
      end_weather_time: (invoice.end_weather_time as string | null) ?? null,
      end_weather_source: (invoice.end_weather_source as 'auto' | 'manual' | null) ?? null,
      weather_manual_override: (invoice.weather_manual_override as boolean | null) ?? null,
    };
    setStartWeather(weatherSetFromRow(weatherRow, 'start'));
    setEndWeather(weatherSetFromRow(weatherRow, 'end'));
    // Reset the stale-auto-weather guard so the FIRST settled lookup key after this load is
    // recorded (not treated as a user change) — the auto readings just hydrated from the row
    // must survive the initial render; only a later field/date change invalidates them.
    weatherLookupKeyRef.current = null;

    // #2: load the persisted diluent RATE (gal/acre) into the controlled input
    // (blank when not recorded). The total is derived from the live acres, not loaded.
    const diluentRaw = invoice.diluent_rate_gpa as number | null | undefined;
    setDiluentRate(diluentRaw != null ? String(diluentRaw) : '');

    const groupId = (invoice.invoice_group_id as string | null) || null;
    setInvoiceGroupId(groupId);

    // Helper: cents → typed dollars string for the Discount Earned editor (blank at 0).
    const centsToDollars = (cents: number | null | undefined) =>
      cents && cents > 0 ? (cents / 100).toFixed(2) : '';

    // If grouped, load sibling invoices for the banner
    if (groupId) {
      const { data: sibs } = await supabase
        .from('invoices')
        .select('id, invoice_number, customer_id, total_amount_cents, status, discount_earned_cents, discount_date, customer:customers!invoices_customer_id_fkey(farm_name)')
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
        // #33: Discount Earned draft for the whole group, keyed by each member's
        // CUSTOMER_ID (the key the Customers-tab editor reads/writes). One invoice
        // row per customer in a split, so customer_id is a stable 1:1 key.
        const discMap: Record<string, { dollars: string; date: string }> = {};
        (sibs as Array<Record<string, unknown>>).forEach((s) => {
          discMap[s.customer_id as string] = {
            dollars: centsToDollars(s.discount_earned_cents as number | null),
            date: (s.discount_date as string | null) || '',
          };
        });
        setDiscountByCustomer(discMap);
      }
    } else {
      setSiblings([]);
      // #33: single (un-split) invoice — its own Discount Earned, keyed by the
      // invoice's billed CUSTOMER_ID. customerToInvoiceId anchors the un-split editor
      // to the primary share customer (which equals invoices.customer_id in the normal
      // case), so this key matches what the editor renders.
      setDiscountByCustomer({
        [invoice.customer_id as string]: {
          dollars: centsToDollars(invoice.discount_earned_cents as number | null),
          date: (invoice.discount_date as string | null) || '',
        },
      });
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
      // §5 (Codex P2): invoice_items does NOT carry label data, so hydrate the per-line
      // label fields (max_label_rate / unit / rei / phi) from products for the lines that
      // have a product_id. Without this, a REOPENED over-label invoice would read as
      // 'no_label_max' and block mode would not require an override. A failed/empty fetch
      // degrades gracefully (no label data => the line shows "no label max on file").
      const productIds = Array.from(
        new Set((items as Array<Record<string, unknown>>).map((it) => it.product_id as string | null).filter((x): x is string => !!x)),
      );
      const labelByProduct = new Map<string, { max_label_rate: number | null; max_label_rate_unit: string | null; rei_hours: number | null; phi_days: number | null }>();
      if (productIds.length > 0) {
        const { data: prodRows } = await supabase
          .from('products')
          .select('id, max_label_rate, max_label_rate_unit, rei_hours, phi_days')
          .in('id', productIds);
        for (const p of (prodRows as Array<{ id: string; max_label_rate: number | null; max_label_rate_unit: string | null; rei_hours: number | null; phi_days: number | null }> | null) ?? []) {
          labelByProduct.set(p.id, {
            max_label_rate: p.max_label_rate,
            max_label_rate_unit: p.max_label_rate_unit,
            rei_hours: p.rei_hours,
            phi_days: p.phi_days,
          });
        }
      }
      setChemicals(
        (items as Array<Record<string, unknown>>).map((it, idx) => {
          const pid = it.product_id as string | null;
          const label = pid ? (labelByProduct.get(pid) ?? null) : null;
          return {
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
            // #25: per-line Warehouse / Vendor and the product form (for the gl/lb display).
            warehouse: (it.warehouse as string | null) ?? null,
            vendor: (it.vendor as string | null) ?? null,
            product_form: (it.product_form as 'liquid' | 'dry' | null) ?? null,
            epa_registration: (it.epa_registration as string | null) || undefined,
            // U4 (Codex R4): rehydrate manual pricing — a persisted manual price
            // (price_source='manual') or ANY product-less line (no tier fallback
            // exists) must reload as manual_override=true, or the next save would
            // treat the price as tier-derived and zero a custom line's charge.
            manual_override: (it.price_source as string | null) === 'manual' || it.product_id == null,
            // §5: hydrated label data (null when the product has none / fetch failed).
            max_label_rate: label?.max_label_rate ?? null,
            max_label_rate_unit: label?.max_label_rate_unit ?? null,
            rei_hours: label?.rei_hours ?? null,
            phi_days: label?.phi_days ?? null,
          };
        })
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

    // #24: Applied Info carry-over — read the source job's as-applied legal
    // record(s) for the read-only panel. Only when this invoice came from a job.
    if (srcJobId) {
      const { data: recs } = await supabase
        .from('job_applied_records')
        .select(APPLIED_RECORD_SELECT)
        .eq('job_id', srcJobId)
        .order('application_date', { ascending: false })
        .order('created_at', { ascending: false });
      setAppliedRecords((recs as JobAppliedRecordRow[]) ?? []);
    } else {
      setAppliedRecords([]);
    }

    // #24: Notifications history for this invoice (or its job). NOTE: the notifications
    // table is RLS-scoped to user_id = auth.uid(), so this shows only notices addressed
    // to the CURRENT VIEWER about this invoice/job — NOT customer-facing notices (the
    // customer pre/post-application notice system is #40/#41). The copy on the tab says
    // so. (LOW#2) Capture a fetch error rather than silently showing "No notifications".
    const notifOrFilters = [`and(related_entity_type.eq.invoice,related_entity_id.eq.${id})`];
    if (srcJobId) notifOrFilters.push(`and(related_entity_type.eq.job,related_entity_id.eq.${srcJobId})`);
    const { data: notifs, error: notifsError } = await supabase
      .from('notifications')
      .select('id, title, message, notification_type, created_at, related_entity_type')
      .or(notifOrFilters.join(','))
      .order('created_at', { ascending: false });
    if (notifsError) {
      setNotificationsError(sanitizeError(notifsError));
      setNotifications([]);
    } else {
      setNotificationsError(null);
      setNotifications((notifs as NotificationRow[]) ?? []);
    }
  }, [id, toast, navigate]);

  useEffect(() => {
    fetchInvoice();
  }, [fetchInvoice]);

  // U16b: surface fields using all-inclusive grower-share pricing. This follows the
  // currently selected/loaded locations, so it works for both a saved invoice and a
  // new invoice before Preview. Read-only and best-effort; the server remains the
  // pricing authority if this advisory lookup fails.
  useEffect(() => {
    const fieldIds = Array.from(new Set(locations.map((location) => location.field_id).filter(Boolean)));
    if (fieldIds.length === 0) {
      setGrowerShareFieldNames([]);
      return;
    }

    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('field_billing_defaults')
        .select('field_id')
        .in('field_id', fieldIds)
        .not('price_override_cents', 'is', null);
      if (cancelled) return;
      if (error) {
        Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-application-invoice', context: 'grower_share_banner' } });
        setGrowerShareFieldNames([]);
        return;
      }

      const overrideIds = new Set(
        ((data || []) as Array<{ field_id: string }>).map((row) => row.field_id),
      );
      setGrowerShareFieldNames(
        Array.from(new Set(
          locations
            .filter((location) => overrideIds.has(location.field_id))
            .map((location) => location.field_name),
        )),
      );
    })();
    return () => { cancelled = true; };
  }, [locations]);

  // #41 (SHARED HISTORY): load the SAME customer-facing job_notifications log the job
  // shows, keyed by THIS invoice's source job_id. Reading by job_id (not invoice id)
  // is what makes the history CONTINUOUS — a notice sent from the job appears here and
  // a post sent from here appears on the job (criterion #3/#5). RLS allows only
  // admin/sales (the log carries co-billed customer emails); a non-admin/sales read is
  // RLS-denied and surfaces as the error+retry state, not a misleading empty log.
  // Skips entirely when this invoice has no source job (engine-built) — the log is
  // job-scoped, so there is nothing to show.
  const loadJobNotifications = useCallback(async () => {
    if (!jobId) {
      jobNotifLoadReqRef.current = null;
      setJobNotifications([]);
      setJobNotificationsLoaded(false);
      setJobNotificationsError(false);
      return;
    }
    const reqId = jobId;                   // the job this load is FOR
    jobNotifLoadReqRef.current = reqId;    // mark it the latest requested job
    setLoadingJobNotifications(true);
    setJobNotificationsLoaded(false);
    setJobNotificationsError(false);
    try {
      const { data, error } = await supabase
        .from('job_notifications')
        .select('id, job_id, notification_type, customer_id, recipient_email, channel, subject, message, status, sent_at, sent_by, idempotency_key, created_at, customer:customers(farm_name)')
        .eq('job_id', reqId)
        // Order by created_at (NOT NULL on every row), NOT sent_at — a failed/unsent
        // row has sent_at=NULL and Postgres sorts NULLS FIRST, floating failed rows
        // above real sends (the #40 LOW fix).
        .order('created_at', { ascending: false });
      // A newer invoice/job load superseded this one — drop the stale result so we
      // never compute the new job's Send control off the old log (Codex P2).
      if (jobNotifLoadReqRef.current !== reqId) return;
      if (error) throw error;
      setJobNotifications((data as unknown as JobNotification[]) ?? []);
      setJobNotificationsLoaded(true);
    } catch (err) {
      if (jobNotifLoadReqRef.current !== reqId) return; // stale — don't clobber current state
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'invoice_load_job_notifications', jobId: reqId } });
      setJobNotifications([]);
      setJobNotificationsLoaded(false);
      setJobNotificationsError(true);
    } finally {
      if (jobNotifLoadReqRef.current === reqId) setLoadingJobNotifications(false);
    }
  }, [jobId]);

  useEffect(() => {
    loadJobNotifications();
  }, [loadJobNotifications]);

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
        // [2026-06-24] pass the invoice being edited so preview excludes deleted split
        // members exactly like save (group-aware). NULL for a new invoice = no exclusion.
        p_invoice_id: (id || null) as string,
      });
      if (error) throw error;
      const result = assertRpcResult<PreviewFieldAppSplitResult>(data, 'preview_field_app_invoice_split');
      setPreviewData(result);
      setActiveTab('customers');
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: 'preview_field_app_invoice_split' } });
      toast('error', `Preview failed: ${fieldAppError(err)}`);
    } finally {
      setPreviewing(false);
    }
  };

  // §5: the save gate. In WARN mode (default) this is a straight pass-through — an
  // over-label rate is flagged in the UI but NEVER blocks the save. In BLOCK mode (owner
  // opt-in), an over-label line opens the admin-override modal (admins only) so the save
  // proceeds only with a LOGGED reason; a non-admin is told to fix the rate (still no
  // silent data corruption). 'cannot_compare' / 'no_label_max' never gate a save.
  const handleSave = async () => {
    if (!profile) return;
    if ((isNew || ['draft', 'unposted'].includes(status)) && paymentTerms === 'Custom date…' && !dueDate) {
      toast('error', 'Choose a custom due date before saving.');
      return;
    }
    // §5 (Codex r6): if any line is over-label but the guardrail mode hasn't loaded yet,
    // FAIL CLOSED — don't let a pending read default to warn and skip a block-mode override.
    if (guardrailState.overRateCount > 0 && !guardrailModeLoaded) {
      toast('error', 'Checking the label-rate policy — try Save again in a moment.');
      return;
    }
    if (guardrailMode === 'block' && guardrailState.overRateCount > 0) {
      if (!isAdmin) {
        toast('error',
          `${guardrailState.overRateCount} line(s) exceed the product's max label rate ` +
          `(${guardrailState.overRateProducts.join(', ')}). An admin must override to save — ` +
          `lower the rate or ask an admin.`,
        );
        return;
      }
      // Admin: require a logged reason before saving an over-label mix.
      setOverrideReason('');
      setShowOverrideModal(true);
      return;
    }
    await performSave();
  };

  // §5: admin confirms the block-mode override. The override reason is carried INTO the
  // save and the audit row is written only AFTER the save SUCCEEDS, linked to the real
  // saved invoice id (Codex follow-up P2). Writing it up front orphaned a 'they overrode'
  // audit row whenever the save then failed (validation / RPC error) and was retried.
  const handleOverrideConfirm = async () => {
    if (!profile) return;
    const reason = overrideReason.trim();
    if (reason === '') {
      toast('error', 'Enter a reason for the over-label-rate override.');
      return;
    }
    setShowOverrideModal(false);
    setOverrideReason('');
    await performSave(reason);
  };

  // §5: after a SUCCESSFUL save, write the override audit row linked to the real saved id.
  //
  // DELIBERATE TRADE-OFF (owner-directed; do not "fix" to atomic without that direction):
  // the audit is written AFTER the save so a FAILED/retried save never orphans a phantom
  // "they overrode" row (the bug this replaced). The unavoidable flip side is that if the
  // save succeeds but THIS audit insert then fails (RLS/network), the invoice is already
  // committed and cannot be un-committed client-side. We do NOT silently swallow it: we
  // raise a LOUD toast + an error-level Sentry so the gap is visible and an admin can
  // re-record it. Making this truly atomic would require moving the audit INTO the frozen
  // save_field_app_invoice RPC (a server migration) — out of scope for this UI fix.
  const writeOverrideAudit = async (reason: string, savedInvoiceId: string | null) => {
    if (!profile) return;
    const description =
      `Admin override of over-label-rate guardrail (block mode) on field-app invoice ` +
      `${invoiceNumber || savedInvoiceId || 'new'}. Over-rate product(s): ` +
      `${guardrailState.overRateProducts.join(', ')}. Reason: ${reason}`;
    const logResult = await supabase.from('activity_feed').insert({
      event_type: 'label_rate_override',
      description,
      performed_by: profile.id,
      related_entity_type: 'invoice',
      related_entity_id: savedInvoiceId,
    });
    if (logResult.error) {
      Sentry.captureException(logResult.error, { level: 'error', extra: { context: 'label_rate_override_log', invoice_id: savedInvoiceId } });
      toast('error', `The invoice saved, but the over-label-rate override reason could NOT be recorded — tell an admin: ${sanitizeError(logResult.error)}`);
    }
  };

  const performSave = async (overrideReasonForAudit?: string) => {
    if (!profile) return;
    if (fetchingWeather !== null) {
      toast('error', 'Wait for Get Weather to finish before saving.');
      return;
    }
    // [B1.1] Never bill 0 / blank applied acres. The server rejects it
    // (ZERO_APPLIED_ACRES); block here too with a clear message so the user fixes
    // it before the round-trip rather than seeing a raw RPC error. (The empty-
    // locations case is handled server-side + by handlePreview's guard.)
    const missingAcres = locations.find((l) => l.applied_acres == null || l.applied_acres <= 0);
    if (missingAcres) {
      toast('error', `Enter applied acres for "${missingAcres.field_name}" (greater than 0), or remove the field.`);
      return;
    }
    // #2: reject an invalid diluent rate before the round-trip (the RPC also guards
    // negatives). Blank/empty is fine (optional field, clears the rate); a non-empty
    // value that is non-numeric or negative is rejected here so a typo can't slip
    // through as "blank" and silently clear a saved rate (Codex P2).
    if (!diluentRateValid) {
      toast('error', 'Enter a valid diluent / carrier-water rate (a number 0 or greater, gal/acre), or leave it blank.');
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
          // #24: persist the chosen Consultant. Only an ADMIN may attribute the
          // invoice to another user — the save RPC rejects a non-admin who sends a
          // salesman_id other than their own ([B1.5]). A non-admin therefore sends
          // their own id (matches the prior implicit salesman_id = profile.id and
          // what the RPC would coerce to anyway), so editing an admin-assigned
          // invoice never fails. Admins send the picked consultant (or themselves).
          salesman_id: isAdmin ? (consultantId || profile.id) : profile.id,
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
        // #25: warehouse / vendor / epa_registration ride along so the server persists
        // them on invoice_items (informational ChemMan per-line fields; never priced).
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
          warehouse: c.warehouse ?? null,
          vendor: c.vendor ?? null,
          epa_registration: c.epa_registration ?? null,
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

      // §5: the save RPC committed the invoice atomically — NOW (and only now) write the
      // block-mode override audit, linked to the real saved id. If the save had failed, we
      // never reach here, so no orphan 'they overrode' row is left behind.
      if (overrideReasonForAudit) {
        await writeOverrideAudit(overrideReasonForAudit, ids[0] ?? (id || null));
      }

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
        // #1: structured START/END weather params (nulls clear the columns when a
        // set is blank — same "blank intentionally clears" semantics as the text fields).
        const weatherParams = buildWeatherRpcParams(startWeather, endWeather);
        // supabase-js now rejects explicit nulls for defaulted RPC params; omitting the
        // param (undefined) hits the same NULL default, so null → undefined is equivalent
        // and preserves the "blank set clears the columns" semantics.
        const weatherRpcParams = Object.fromEntries(
          Object.entries(weatherParams).map(([k, v]) => [k, v ?? undefined]),
        ) as { [K in keyof typeof weatherParams]: NonNullable<(typeof weatherParams)[K]> | undefined };
        const appliedResult = await supabase.rpc('update_field_app_applied_info', {
          p_invoice_ids: ids,
          // Omit (undefined) when blank → the RPC's NULL default clears the column,
          // preserving the "blank fields intentionally clear stale Applied Info" behavior.
          p_wind_direction: windDirection || undefined,
          p_temperature_text: temperature || undefined,
          p_applicator_name: applicator || undefined,
          p_performed_by: profile.id,
          // p_update_weather: TRUE — this (current-bundle) UI intends to write the structured
          // weather columns. The RPC only writes them on TRUE, so a stale old-bundle tab (which
          // omits this and the weather params) can't silently erase captured weather.
          p_update_weather: true,
          ...weatherRpcParams,
          // #2: persist the diluent RATE (gal/acre). blank → null (clears the column).
          // p_update_diluent: TRUE — this UI intends to write diluent; a stale old-bundle
          // caller omits it (defaults false) so it can never erase a recorded rate. The
          // negative-rate guard above already blocked an invalid value before we get here.
          p_diluent_rate_gpa: diluentRateNum ?? undefined,
          p_update_diluent: true,
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

      // #33: persist the ChemMan billing details (PO / terms / due date / footer
      // notes / internal memo + per-invoice Discount Earned) via the SECURITY DEFINER
      // RPC — same reason as Applied Info: invoices_update RLS is admin-only, so a raw
      // update silently no-ops for a sales_rep. Header fields apply uniformly to every
      // member; p_discounts carries the per-invoice {amount_cents, date}. The Discount
      // Earned is informational ONLY — it NEVER reduces the GENERATED balance_cents.
      let billingOk = true;
      if (ids.length > 0) {
        // #33 (money-lens MED #1): the editor draft is keyed by CUSTOMER_ID, so to
        // build the per-INVOICE p_discounts map we must resolve each created/updated
        // invoice id → its billed customer_id. save_field_app_invoice returns only
        // invoice_ids (no customer mapping), so fetch the customer_id for exactly
        // those ids and join to the customer-keyed draft. This works for a NEW invoice
        // (where siblings/customerToInvoiceId are still empty at save time), a split
        // (each id → its own customer), and an un-split invoice (single id → single
        // customer). A blank/0 dollars entry resolves to amount 0 (off, bigint cents).
        const { data: idRows } = await supabase
          .from('invoices')
          .select('id, customer_id')
          .in('id', ids);
        const customerByInvoiceId = new Map<string, string>(
          ((idRows as Array<{ id: string; customer_id: string }> | null) ?? [])
            .map((r) => [r.id, r.customer_id]),
        );
        const discounts: Record<string, { amount_cents: number; date: string | null }> = {};
        for (const invId of ids) {
          const custId = customerByInvoiceId.get(invId);
          const entry = custId ? discountByCustomer[custId] : undefined;
          const dollars = entry ? parseFloat(entry.dollars) : NaN;
          const cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
          discounts[invId] = { amount_cents: cents, date: (entry?.date || null) };
        }
        const billingKey =
          billingKeysRef.current[id || '__new__'] ||
          (billingKeysRef.current[id || '__new__'] = generateIdempotencyKey('update_field_app_invoice_billing', profile.id));
        const billingResult = await supabase.rpc('update_field_app_invoice_billing', {
          p_invoice_ids: ids,
          // Omit (undefined) when blank → the RPC's NULL default clears the column,
          // matching the Applied-Info "blank intentionally clears" behavior.
          p_purchase_order_ref: poRef || undefined,
          p_payment_terms:
            (paymentTerms === 'Custom date…' ? customTermsText || 'Custom' : paymentTerms) ||
            undefined,
          p_header_notes: notes || undefined,
          p_due_date: paymentTerms === 'Custom date…' ? dueDate || undefined : undefined,
          p_footer_notes: footerNotes || undefined,
          p_internal_notes: internalMemo || undefined,
          p_discounts: discounts,
          p_performed_by: profile.id,
          p_idempotency_key: billingKey,
        });
        if (billingResult.error) {
          billingOk = false;
          Sentry.captureException(billingResult.error, {
            level: 'error',
            extra: { context: 'field_app_invoice_billing_persist', invoice_ids: ids },
          });
        } else {
          assertRpcResult(billingResult.data, 'update_field_app_invoice_billing');
          // Clear the per-id key only on success so a retry after a failure reuses it.
          delete billingKeysRef.current[id || '__new__'];
        }
      }

      // Only consider the form clean when ALL writes succeeded. If any failed,
      // leave dirty=true so the leave-page warning still fires and the user can
      // retry without re-entering the rest of the form.
      if (appliedInfoOk && billingOk) {
        setDirty(false);
      }

      if (appliedInfoOk && billingOk) {
        toast('success', isNew ? `Invoice created${groupNote}` : `Invoice saved${groupNote}`);
      } else if (!appliedInfoOk) {
        toast('error',
          (isNew ? 'Invoice created' : 'Invoice saved') + groupNote +
          ', but Applied Info (wind/temp/applicator) did NOT persist. Re-enter and save again.'
        );
      } else {
        toast('error',
          (isNew ? 'Invoice created' : 'Invoice saved') + groupNote +
          ', but the billing details (PO / terms / due date / notes / discount) did NOT persist. Re-enter and save again.'
        );
      }

      if (isNew && ids[0]) {
        navigate(`/invoices/field-app/${ids[0]}`, { replace: true });
      } else {
        // Keep the form frozen until the server copy has finished hydrating.
        // Otherwise a quick edit after the RPC but before this reload resolves
        // can be overwritten by the older fetch response.
        await fetchInvoice();
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: 'save_field_app_invoice' } });
      toast('error', `Save failed: ${fieldAppError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePost = async () => {
    if (!profile || !id) return;
    // Saving is a multi-step financial write (invoice, applied info, billing details).
    // Never let Post race it or commit stale form values. The button is disabled too,
    // but this guard also covers a queued/double-clicked handler.
    if (saving || fetchingWeather !== null) {
      toast('error', fetchingWeather !== null
        ? 'Wait for the weather lookup to finish before posting.'
        : 'Wait for the invoice save to finish before posting.');
      return;
    }
    if (dirty) {
      toast('error', 'Save all invoice changes before posting.');
      return;
    }
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
      await fetchInvoice();
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: invoiceGroupId ? 'post_invoice_group' : 'post_invoice' } });
      toast('error', `Post failed: ${fieldAppError(err)}`);
    } finally {
      setPosting(false);
    }
  };

  // #28: Unpost — reverse the posting (posted/overdue -> unposted) right on this
  // editor, the inverse of Post. The gated RPC refuses a paid/voided invoice or one
  // in a closed period with a plain-English error surfaced as a toast.
  // FIX 4 (Wave 2a): a SPLIT GROUP routes through unpost_invoice_group — ALL members
  // unpost in ONE transaction (all-or-nothing); a mid-loop failure can no longer leave
  // a half-unposted group. A single invoice still uses unpost_invoice.
  const handleUnpost = async () => {
    if (!profile || !id) return;
    // Route on invoiceGroupId ALONE (mirrors handlePost): if this invoice belongs to a
    // split group we ALWAYS use unpost_invoice_group so ALL members move atomically — even
    // if the client `siblings` query came back empty (a transient fetch/RLS error). The RPC
    // owns membership (it locks + unposts every group member), so we never fall back to a
    // single-member unpost that could leave the group half-unposted (Codex).
    const isGroup = !!invoiceGroupId;
    // For a single invoice, guard the "nothing to unpost" case up front. For a group,
    // the RPC decides (it unposts every member; a non-posted member is an honest error).
    if (!isGroup && !(status === 'posted' || status === 'overdue')) {
      toast('error', 'Nothing to unpost — this invoice is not posted.');
      return;
    }
    setUnposting(true);
    try {
      if (isGroup) {
        // Per-GROUP key cache (keyed by invoice_group_id) so a timeout retry reuses the
        // SAME key (idempotent) while a DIFFERENT group always gets its own key — the
        // client can't accidentally replay group A's key onto group B (the server also
        // rejects a cross-group replay as a backstop). Cleared on success.
        const groupKeyId = `grp:${invoiceGroupId}`;
        if (!unpostKeysRef.current[groupKeyId]) {
          unpostKeysRef.current[groupKeyId] = generateIdempotencyKey('unpost_invoice_group', `${profile.id}:${invoiceGroupId}`);
        }
        const { data, error } = await supabase.rpc('unpost_invoice_group', {
          p_invoice_group_id: invoiceGroupId,
          p_performed_by: profile.id,
          p_idempotency_key: unpostKeysRef.current[groupKeyId],
        });
        if (error) throw error;
        assertRpcResult(data, 'unpost_invoice_group');
        delete unpostKeysRef.current[groupKeyId];
        toast('success', 'Invoice group unposted');
      } else {
        // Per-invoice key cache: a retry after a timeout reuses the SAME key so the
        // server dedup matches (never a double unpost). Cleared on success.
        if (!unpostKeysRef.current[id]) {
          unpostKeysRef.current[id] = generateIdempotencyKey('unpost_invoice', `${profile.id}:${id}`);
        }
        const { data, error } = await supabase.rpc('unpost_invoice', {
          p_invoice_id: id,
          p_performed_by: profile.id,
          p_idempotency_key: unpostKeysRef.current[id],
        });
        if (error) throw error;
        assertRpcResult(data, 'unpost_invoice');
        delete unpostKeysRef.current[id];
        toast('success', 'Invoice unposted');
      }
      fetchInvoice();
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: isGroup ? 'unpost_invoice_group' : 'unpost_invoice' } });
      toast('error', `Unpost failed: ${fieldAppError(err)}`);
    } finally {
      setUnposting(false);
    }
  };

  // #29: Void — cancel/void this bill right on this editor. void_invoice owns the
  // money + lifecycle: a draft/unposted invoice is routed to 'cancelled' (nothing to
  // reverse), a posted/overdue one to 'voided' (the RPC reverses allocations + prepay,
  // cancels pending commissions, writes the append-only financial_audit_log, and zeroes
  // AR — we never recompute money here). It refuses an already voided/cancelled invoice
  // and respects the closed-period gate; those come back as honest toasts.
  // Field-application groups do not carry governed order-split provenance, so they
  // remain member-by-member here. Governed order splits use void_invoice_group from
  // Invoice Detail. Each field-app call carries its own stable idempotency key.
  const handleVoid = async () => {
    if (!profile || !id) return;
    const reason = voidReason.trim();
    // Belt-and-suspenders: the confirm button is disabled while blank, but never
    // send an empty reason (the audit record must carry a real reason).
    if (!reason) {
      toast('error', 'Enter a reason for voiding.');
      return;
    }
    // Target every NON-terminal member of the group (or just this invoice). A member
    // already voided/cancelled is skipped — the RPC would reject it, and there is
    // nothing to do.
    const groupMembers = invoiceGroupId && siblings.length > 0 ? siblings : [{ id, status }];
    const targets = groupMembers.filter((m) => m.status !== 'voided' && m.status !== 'cancelled');
    if (targets.length === 0) {
      toast('error', 'Nothing to void — this invoice is already voided or cancelled.');
      return;
    }
    setVoiding(true);
    let ok = 0;
    const failures: string[] = [];
    try {
      for (const m of targets) {
        // Per-invoice key cache: a retry reuses the SAME key so a server-side dedup
        // matches (never a double void). Cleared per id on success.
        if (!voidKeysRef.current[m.id]) {
          voidKeysRef.current[m.id] = generateIdempotencyKey('void_invoice', `${profile.id}:${m.id}`);
        }
        try {
          // void_invoice RETURNS void — use .throwOnError() (no `=` capture).
          await supabase.rpc('void_invoice', {
            p_invoice_id: m.id,
            p_void_reason: reason,
            p_idempotency_key: voidKeysRef.current[m.id],
          }).throwOnError();
          ok += 1;
          delete voidKeysRef.current[m.id];
        } catch (err) {
          Sentry.captureException(err, { tags: { rpc: 'void_invoice' } });
          failures.push(fieldAppError(err));
        }
      }
      if (failures.length === 0) {
        toast('success', targets.length > 1 ? `Voided ${ok} invoice(s)` : 'Invoice voided');
        setShowVoidModal(false);
        setVoidReason('');
      } else if (ok > 0) {
        toast('error', `Voided ${ok}, but ${failures.length} failed: ${failures[0]}`);
      } else {
        toast('error', `Void failed: ${failures[0]}`);
      }
      fetchInvoice();
    } finally {
      setVoiding(false);
    }
  };

  // Phase 1: edit lock covers the whole group — any sibling not in draft/unposted blocks edits.
  const canEdit = isNew || (
    ['draft', 'unposted'].includes(status) &&
    (siblings.length === 0 || siblings.every((s) => ['draft', 'unposted'].includes(s.status)))
  );
  // Terms stay editable in every state the billing RPC accepts (draft AND unposted —
  // 20260625150000 permits both), matching canEdit for the rest of the header fields.
  const canEditPaymentTerms = canEdit && (isNew || ['draft', 'unposted'].includes(status));
  const canPost = !isNew && canEdit && isAdminOrRep;
  // #28: Unpost is available when this saved invoice (or any group member) is
  // posted/overdue — the inverse condition to Post. paid/voided/cancelled invoices
  // are NOT unpostable here (the RPC also refuses them); a paid invoice must have
  // its payment unapplied first, and a voided/cancelled one is terminal.
  const unpostTargets =
    invoiceGroupId && siblings.length > 0
      ? siblings.filter((s) => s.status === 'posted' || s.status === 'overdue')
      : (status === 'posted' || status === 'overdue' ? [{ id, status }] : []);
  const canUnpost = !isNew && unpostTargets.length > 0;
  // #29: Void is admin-only (the void_invoice RPC rejects a non-admin) and available
  // on any SAVED, non-terminal invoice — draft/unposted (-> cancelled) OR posted/overdue
  // (-> voided). It is hidden once the invoice (or, for a group, every member) is already
  // voided/cancelled. A paid invoice still shows Void: void_invoice reverses its
  // allocations/prepay; if a guard refuses, the error surfaces as a toast. Both Void and
  // Unpost coexist on a posted invoice — Void is terminal, Unpost returns it to editable.
  const voidTargets =
    invoiceGroupId && siblings.length > 0
      ? siblings.filter((s) => s.status !== 'voided' && s.status !== 'cancelled')
      : (status !== 'voided' && status !== 'cancelled' ? [{ id, status }] : []);
  const canVoid = !isNew && isAdmin && voidTargets.length > 0;
  // #24: a posted/voided/paid invoice is LOCKED — committed money must not change
  // (#23 lifecycle). canEdit already encodes this; isLocked is its inverse for an
  // existing invoice, used to drive the posted-lock banner + read-only chrome.
  const isLocked = !isNew && !canEdit;
  // The Consultant picker is editable only by an admin (see isAdmin above).
  const canEditConsultant = canEdit && isAdmin;

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

  // #24: Print the invoice. Reuses the money-correct buildInvoicePdfDataFromRow
  // (it re-fetches line items / shares / customer billing by id) so the printed
  // Total and Balance Due reconcile with payments/prepay. Only meaningful for a
  // saved invoice; a brand-new unsaved invoice has nothing to print.
  // #24/#30/#31: build the money-correct PDF data for this saved invoice. Shared by
  // Print (#30) and Email (#31) so the emailed attachment is byte-identical to the
  // printed sheet — same Total/Balance reconciliation, same legal applicator name.
  // Re-fetches line items / shares / customer billing by id via buildInvoicePdfDataFromRow.
  const buildEditorPdfData = (format: 'current' | 'legacy' = 'current') => {
    const primaryShare = shares.find((s) => s.is_primary) || shares[0];
    return buildInvoicePdfDataFromRow({
      id: id!,
      invoice_number: invoiceNumber,
      invoice_date: transactionDate,
      invoice_type: 'field_application',
      status,
      customer_id: pdfSnapshot!.customer_id,
      customer_name: primaryShare?.customer_name || pdfSnapshot!.customer_name || '',
      salesman_name: consultants.find((c) => c.id === consultantId)?.full_name || null,
      // #33: print the LIVE form values so an in-editor edit prints without a reload
      // (matches the existing header_notes: notes pattern). payment_terms is the
      // invoice-level override and wins over the customer default in the builder.
      purchase_order_ref: poRef || null,
      payment_terms:
        (paymentTerms === 'Custom date…' ? customTermsText || 'Custom' : paymentTerms) || null,
      header_notes: notes || null,
      footer_notes: footerNotes || null,
      // Display-only: before posting the DB has no stamped due_date yet, and the PDF
      // renders null as "On receipt" — which would contradict a printed "Net 30". Derive
      // the same date the posting RPC will stamp (invoice_date + terms days) so a
      // pre-posting print matches the eventual invoice. Server stamping stays authoritative.
      due_date:
        dueDate ||
        (() => {
          // Mirror the server's parse_payment_terms_days for ANY terms string so a
          // pre-posting print (incl. legacy 'Net 45') matches the eventual stamp:
          // receipt aliases -> 0; first digit run clamped 1..365; else default 30.
          if (paymentTerms === 'Custom date…') return null;
          const t = paymentTerms.trim().toLowerCase();
          let days: number;
          if (['due on receipt', 'due upon receipt', 'receipt', 'immediately'].includes(t)) {
            days = 0;
          } else {
            const m = /(\d+)/.exec(paymentTerms);
            const n = m ? Number(m[1]) : NaN;
            days = Number.isFinite(n) && n >= 1 && n <= 365 ? n : 30;
          }
          // A cleared transaction-date input falls back to today — the server stamps
          // invoice_date with the America/Chicago business date on save (migration
          // 20260904160000, applied 2026-09-04), so the print still matches.
          const base = transactionDate || todayInBusinessTz();
          const d = new Date(base + 'T00:00:00Z');
          d.setUTCDate(d.getUTCDate() + days);
          return d.toISOString().slice(0, 10);
        })(),
      // #33: Discount Earned for THIS invoice (the URL invoice), resolved from the
      // customer-keyed draft via the URL invoice's billed customer. Informational line
      // on the PDF — it does NOT change the Total/Balance math (passed through untouched).
      discount_earned_cents: discountCentsForCustomer(customerForThisInvoice),
      crop_type: locations[0]?.crop_type ?? null,
      field_names: locations.length > 0 ? locations.map((l) => l.field_name) : null,
      total_acres: totalAppliedAcres || null,
      // #2: print the LIVE diluent rate (gal/acre) so an in-editor edit prints without a
      // reload; the PDF renderer derives the total from total_acres above. null = omit.
      diluent_gpa: diluentRateNum,
      // #24 (LOW#1): the printed legal Applicator name. Prefer the typed free-text
      // value; otherwise resolve the as-applied applicator's REAL name from the
      // UNFILTERED name map (so a now-inactive applicator still prints correctly),
      // never the on-screen placeholder. Falls back to null (blank) when there is no
      // real name — a placeholder like '(removed applicator)' must not reach the PDF.
      applicator_name:
        realApplicatorName(applicator) ??
        realApplicatorName(applicatorNameFor(carryover[0]?.applicator_id ?? null, applicatorNameMap)) ??
        null,
      total_amount_cents: pdfSnapshot!.total_amount_cents,
      total_cost_cents: pdfSnapshot!.total_cost_cents,
      paid_amount_cents: pdfSnapshot!.paid_amount_cents,
      prepay_applied_cents: pdfSnapshot!.prepay_applied_cents,
      write_off_cents: pdfSnapshot!.write_off_cents,
      balance_cents: pdfSnapshot!.balance_cents,
    }, {
      // #30: format toggles the layout only; share/price/EPA detail stay on so
      // the printed sheet is complete in either format. Money is identical
      // (same pdfData) — Total/Balance Due reconcile regardless of format.
      show_shares: true,
      show_price_per_acre: true,
      show_epa_registration: true,
      format,
    });
  };

  const handlePrint = async (format: 'current' | 'legacy' = 'current') => {
    if (!id || !pdfSnapshot) {
      toast('error', 'Save the invoice before printing.');
      return;
    }
    setPrinting(true);
    try {
      const pdfData = await buildEditorPdfData(format);
      await downloadInvoicePdf(pdfData);
    } catch (err) {
      Sentry.captureException(err, { tags: { action: 'print_field_app_invoice', format } });
      toast('error', `Print failed: ${sanitizeError(err)}`);
    } finally {
      setPrinting(false);
    }
  };

  // #31: Email this field invoice (current-format PDF attached) to the customer's
  // billing email. Recipient is resolved from THIS invoice's own customer
  // (pdfSnapshot.customer_id = invoices.customer_id — for a split/grouped invoice
  // that is the per-invoice billed customer, never the wrong party); a missing
  // email gives an honest error instead of a blank/wrong send. The send is
  // idempotent (per invoice + timestamp) and logged via invoice_emailed. Mirrors
  // the list emailRow handlers and InvoiceDetail.handleEmailInvoice.
  const handleEmailInvoice = async () => {
    if (!id || !pdfSnapshot) {
      toast('error', 'Save the invoice before emailing.');
      return;
    }
    if (!profile) {
      toast('error', 'Profile not loaded — please refresh.');
      return;
    }
    if (isInvoiceEmailSuppressed(pdfSnapshot)) {
      toast('info', 'This $0 invoice is recorded and shown in the account summary, but is not emailed.');
      return;
    }
    await runCriticalAction({
      action: async () => {
        const { data: cust } = await supabase
          .from('customers')
          .select('email')
          .eq('id', pdfSnapshot.customer_id)
          .maybeSingle();
        const email = (cust as { email?: string | null } | null)?.email;

        // Build the money-correct attachment FIRST, then the addressed payload.
        // buildInvoiceEmailPayload throws the honest "no email on file" error
        // before any send, so a customer without an email never gets a blank send.
        const pdfData = await buildEditorPdfData('current');
        const doc = await generateInvoicePdf(pdfData);
        const base64 = pdfToBase64(doc);

        const payload = buildInvoiceEmailPayload({
          customerEmail: email,
          customerId: pdfSnapshot.customer_id,
          invoiceId: id,
          invoiceNumber,
          invoiceDate: transactionDate,
          balanceCents: pdfSnapshot.balance_cents,
          attachmentBase64: base64,
        });
        await assertInvoiceSendable(id);
        const result = await sendEmail(payload);
        if (!result.success) throw new Error(result.error || 'Email failed to send');

        logActivity({
          event: 'invoice_emailed',
          description: `Field invoice ${invoiceNumber} emailed to ${payload.to}`,
          performedBy: profile.id,
          entityType: 'invoice',
          entityId: id,
          customerId: pdfSnapshot.customer_id,
        });
      },
      toast,
      successMessage: `Emailed ${invoiceNumber}`,
      setLoading: setEmailing,
      sentryTag: 'field_app_invoice_email',
    });
  };

  // §6: load the rich "your field was sprayed" PROOF draft from the source job. Reads
  // get_job_proof_data (read-only, admin/sales-gated) and assembles the office-reviewable
  // draft (fields+acres+boundary map, products, weather, applicator, REI/PHI). Returns the
  // draft so the SEND path can reuse the exact draft the office reviewed. Throws on failure
  // so a transient error never silently falls back to the generic notice.
  const loadProofDraft = useCallback(async (): Promise<ProofDraft | null> => {
    if (!jobId) return null;
    const { data, error } = await supabase.rpc('get_job_proof_data', { p_job_id: jobId });
    if (error) throw error;
    const proof = assertRpcResult<JobProofData>(data, 'get_job_proof_data');
    const draft = buildProofDraft(proof);
    setProofDraft(draft);
    return draft;
  }, [jobId]);

  // §6: open the proof preview (office reviews the rich draft before approving the send).
  const handleOpenProofPreview = async () => {
    if (!jobId) {
      toast('error', 'This invoice has no source job to build a proof from.');
      return;
    }
    setLoadingProof(true);
    try {
      await loadProofDraft();
      setShowProofPreview(true);
    } catch (err) {
      const msg = hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)
        ? 'Only admin or sales can preview the proof.'
        : err instanceof Error ? err.message : 'Could not build the proof preview.';
      toast('error', msg);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'invoice_proof_preview', jobId } });
    } finally {
      setLoadingProof(false);
    }
  };

  // §6: Send the rich "your field was sprayed" PROOF to the source job's resolved share
  // customer(s), RIGHT FROM THE INVOICE — OFFICE-APPROVED ONE-TAP (never auto-send; the
  // office reviews the proof, then taps Send). Builds ON the parity post-notification
  // infra unchanged:
  //   RECORD  -> record_job_post_notifications (resolves recipients off the PERSISTED job,
  //              logs one row each, returns a DETERMINISTIC per-recipient idempotency key)
  //   SEND    -> the rich proof body (buildProofEmailPayload), via the gated send-email edge
  //              fn (email_type='post_application_notice' — PREPARED, deploy GATED for Mason)
  //   CONFIRM -> confirm_job_notification_sent (flips a row failed->sent ONLY after the
  //              email actually goes out; reused from #40)
  // Per-recipient idempotency (the RPC's email_idempotency_key, NOT Date.now()) means a
  // retry never double-sends; a recipient with no email on file is logged as failed, never
  // dropped. Same fail-closed gating on a successfully-loaded log + same re-send safety.
  const handleSendPostNotification = async () => {
    if (!jobId || !profile) {
      toast('error', 'This invoice has no source job to notify.');
      return;
    }
    // FAIL CLOSED: never decide first-send vs re-send off a log we haven't
    // SUCCESSFULLY read (a failed load reads as "0 sent" and would skip the warning).
    if (loadingJobNotifications || !jobNotificationsLoaded) {
      toast('error', 'Could not load the notification log yet — reload before sending, so an already-sent notice is not duplicated.');
      return;
    }
    // Block on unsaved edits — the RPC resolves recipients from the PERSISTED job, so
    // the message must match the saved record.
    if (dirty) {
      toast('error', 'Save the invoice before sending a post-notification.');
      return;
    }
    setSendingPostNotice(true);
    const key = postNoticeIdem.getKey();
    try {
      // §6: build the rich "your field was sprayed" PROOF draft from the source job.
      // Reuse the draft the office just previewed if present, else build it now. ABORT
      // on a failed build so a transient error never sends an empty/wrong proof.
      const draft = proofDraft ?? (await loadProofDraft());
      if (!draft) throw new Error('Could not build the proof for this job.');

      // The application date + job number live on the draft (from the source job — the
      // proof tells the customer when the application happened, not the billing date).
      const primaryFarm = pdfSnapshot?.customer_name
        || shares.find((s) => s.is_primary)?.customer_name
        || shares[0]?.customer_name
        || '';
      // The recorded log row carries only a NEUTRAL subject + a placeholder body (no
      // per-field detail) so a split-billed customer's pre-confirm log row can NEVER hold
      // another customer's field names. Each recipient's row is re-stamped on confirm with
      // their OWN scoped proof text (the exact text they were emailed). (Codex P1 leak.)
      const recordedSubject = proofSubject(draft);
      const recordedBody = 'Proof of application — per-recipient details are recorded when each notice is sent.';

      // 1) Record the per-recipient log (admin/sales only; resolves recipients off the
      // PERSISTED job; returns a DETERMINISTIC per-recipient idempotency key).
      const rpcRes = await supabase.rpc('record_job_post_notifications', {
        p_job_id: jobId,
        p_subject: recordedSubject,
        p_message: recordedBody,
        p_performed_by: profile.id,
        p_idempotency_key: key,
      });
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

      // 2) Send the rich proof email to each recipient WITH an email; confirm -> 'sent'
      // only on success. The per-recipient deterministic key (email_idempotency_key) is
      // REQUIRED — buildProofEmailPayload refuses to invent a timestamp key, so a missing
      // key means "do not send" rather than a double-send risk.
      //
      // CROSS-CUSTOMER LEAK FIX (Codex P1): a split-billing job has different customers on
      // different fields, so each recipient's proof MUST contain ONLY their own field(s) —
      // never the whole-job `draft`. We re-fetch get_job_proof_data SCOPED to this
      // recipient's customer_id and build a per-recipient draft. The whole-job `draft` is
      // ONLY for the office preview; it never reaches a customer email.
      let emailedOk = 0;
      let emailErr = 0;
      for (const r of result.recipients) {
        if (!r.has_email || !r.email) continue;
        if (!r.email_idempotency_key) {
          // Defensive: a recipient WITH an email should always carry a key. If not, skip
          // (logged 'failed') rather than send with a non-deterministic key.
          emailErr += 1;
          Sentry.captureMessage('post-notification recipient missing email_idempotency_key', { level: 'warning', extra: { jobId, customerId: r.customer_id } });
          continue;
        }
        try {
          const recipientName = r.farm_name ?? primaryFarm ?? 'Customer';
          // Per-recipient SCOPED proof — only this customer's fields/acres/maps.
          const scopedRes = await supabase.rpc('get_job_proof_data', { p_job_id: jobId, p_customer_id: r.customer_id });
          if (scopedRes.error) throw scopedRes.error;
          const scopedProof = assertRpcResult<JobProofData>(scopedRes.data, 'get_job_proof_data');
          const recipientDraft = buildProofDraft(scopedProof);
          const recipientText = renderProofText({ customerName: recipientName, draft: recipientDraft });
          const recipientInvoiceId = customerToInvoiceId[r.customer_id] ?? (!invoiceGroupId ? id : null);
          if (!recipientInvoiceId) throw new Error('Could not resolve this customer’s invoice send gate.');
          const payload = buildProofEmailPayload({
            customerEmail: r.email,
            customerId: r.customer_id,
            customerName: recipientName,
            jobId,
            invoiceId: recipientInvoiceId,
            draft: recipientDraft,
            emailIdempotencyKey: r.email_idempotency_key,
          });
          await assertInvoiceLifecycleSendable(recipientInvoiceId);
          await sendEmail(payload);
          const confirmRes = await supabase.rpc('confirm_job_notification_sent', {
            p_notification_id: r.notification_id,
            p_subject: proofSubject(recipientDraft),
            p_message: recipientText,
            p_performed_by: profile.id,
          });
          if (confirmRes.error) throw confirmRes.error;
          assertRpcResult(confirmRes.data, 'confirm_job_notification_sent');
          emailedOk += 1;
        } catch (sendErr) {
          emailErr += 1;
          Sentry.captureException(sendErr instanceof Error ? sendErr : new Error(String(sendErr)), { extra: { context: 'invoice_send_post_notification_email', jobId, customerId: r.customer_id } });
        }
      }

      logActivity({ event: 'job_post_notification_sent', description: `Post-application notice for job ${jobNumber ?? jobId}: ${result.recipients_with_email} recipient(s) with email, ${emailedOk} emailed (from invoice ${invoiceNumber})`, performedBy: profile.id, entityType: 'job', entityId: jobId });

      const noEmail = result.recipients_without_email;
      if (emailErr > 0) {
        const noEmailSuffix = noEmail > 0 ? ` ${noEmail} had no email on file.` : '';
        toast('error', `${emailedOk} sent; ${emailErr} email(s) failed.${noEmailSuffix} Fix and click Send again to retry.`);
      } else if (emailedOk === 0) {
        postNoticeIdem.resetKey();
        toast('error', `No email sent — ${noEmail} billed customer(s) have no email on file. Add an email and try again.`);
      } else {
        postNoticeIdem.resetKey();
        setShowProofPreview(false);
        if (noEmail > 0) {
          toast('success', `Proof sent to ${emailedOk} customer(s). ${noEmail} had no email on file (logged as failed).`);
        } else {
          toast('success', `Proof sent to ${emailedOk} customer(s).`);
        }
      }
      await loadJobNotifications();
    } catch (err) {
      let msg = err instanceof Error ? err.message : 'Failed to send post-notification';
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) msg = 'Only admin or sales can send notifications.';
      else if (hasRpcCode(err, RpcErrorCodes.JOB_NOT_POST_NOTIFIABLE)) msg = 'A post-notification can only be sent on a completed or invoiced job.';
      toast('error', msg);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'invoice_send_post_notification', jobId } });
    } finally {
      setSendingPostNotice(false);
    }
  };

  // #27: Transfer back to Scheduling (reverse the job->invoice transfer). Calls
  // transfer_invoice_to_job: cancels this draft/unposted job-built invoice, deletes
  // its items + shares, detaches the as-applied records, and returns the source job
  // to 'completed' so it can be re-worked / re-transferred. Idempotent (a double
  // click / retry returns the saved result, never double-reverses). Only reachable
  // when this invoice HAS a source job AND is still editable (canEdit gates a posted/
  // paid invoice out — the RPC also refuses anything past 'unposted' with a plain
  // message). On success we navigate to the reopened job.
  const handleTransferToScheduling = async () => {
    if (!id || !profile || !jobId) return;
    setTransferringToScheduling(true);
    try {
      const idemKey = transferToSchedulingIdem.getKey();
      const { data, error } = await supabase.rpc('transfer_invoice_to_job', {
        p_invoice_id: id,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      transferToSchedulingIdem.resetKey();
      const result = assertRpcResult<{ job_id: string; job_number: string }>(data, 'transfer_invoice_to_job');
      // The invoice is now cancelled and the form holds stale, deleted contents —
      // clear the unsaved-changes guard so leaving doesn't prompt, then go to the job.
      setDirty(false);
      toast('success', `Invoice returned to scheduling — job ${result.job_number} reopened`);
      navigate(`/jobs/${result.job_id}`);
    } catch (err) {
      Sentry.captureException(err, { tags: { action: 'transfer_invoice_to_job' } });
      toast('error', `Transfer to scheduling failed: ${fieldAppError(err)}`);
    } finally {
      setTransferringToScheduling(false);
    }
  };

  // #24: explicit Cancel (Cancel Without Saving). Navigates away; the
  // useUnsavedChanges guard still prompts if there are unsaved edits.
  const handleCancel = () => {
    navigate('/field-invoices');
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
          <button aria-label="Back to field invoices" onClick={() => navigate('/field-invoices')} className="p-1 rounded hover:bg-gray-100">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold">
              {isNew ? 'New Field Application Invoice' : `Field Application ${invoiceNumber}`}
            </h1>
            <p className="text-sm text-gray-500">
              {totalAppliedAcres.toFixed(1)} acres &middot; {locations.length} locations &middot; {fmt(invoiceTotalCents)} <span className="text-gray-400">est.</span>
            </p>
          </div>
          {/* #29: canonical status→variant map so a voided/cancelled invoice reads as a
              clear error (red), not amber — the prior inline ternary mislabeled both. */}
          {!isNew && <Badge variant={statusToBadgeVariant[status] || 'default'}>{status}</Badge>}
        </div>
        <div className="flex flex-wrap gap-2 justify-end">
          {!isNew && canEdit && (
            <Button variant="danger" size="sm" icon={<Trash2 className="w-4 h-4" />} onClick={() => setShowDeleteConfirm(true)}>
              Delete
            </Button>
          )}
          {/* #27: Transfer back to Scheduling — only when this invoice came from a
              job AND is still editable (a posted/paid invoice can't be pushed back). */}
          {!isNew && canEdit && jobId && (
            <Button
              variant="secondary"
              size="sm"
              icon={<CornerUpLeft className="w-4 h-4" />}
              onClick={() => setShowTransferToSchedulingConfirm(true)}
              loading={transferringToScheduling}
              disabled={transferringToScheduling}
            >
              Transfer to Scheduling
            </Button>
          )}
          {!isNew && canPost && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Send className="w-4 h-4" />}
              onClick={() => {
                if (dirty) {
                  toast('error', 'Save all invoice changes before posting.');
                  return;
                }
                setShowPostConfirm(true);
              }}
              loading={posting}
              disabled={posting || saving || fetchingWeather !== null}
            >
              {invoiceGroupId ? `Post Group (${siblings.length || 1})` : 'Post'}
            </Button>
          )}
          {/* #28: Unpost — reverse the posting on a posted/overdue invoice, returning
              it to the editable Unposted list. Mirrors Post; group-aware. */}
          {!isNew && canUnpost && (
            <Button variant="secondary" size="sm" icon={<RotateCcw className="w-4 h-4" />} onClick={() => setShowUnpostConfirm(true)} loading={unposting} disabled={unposting}>
              {invoiceGroupId && unpostTargets.length > 1 ? `Unpost Group (${unpostTargets.length})` : 'Unpost'}
            </Button>
          )}
          {/* #29: Void — cancel/void the bill with a required reason. Admin-only;
              available on any saved, non-terminal invoice (draft/unposted -> cancelled,
              posted/overdue -> voided). Group-aware: voids each member. Terminal. */}
          {!isNew && canVoid && (
            <Button variant="danger" size="sm" icon={<Ban className="w-4 h-4" />} onClick={() => { setVoidReason(''); setShowVoidModal(true); }} loading={voiding} disabled={voiding}>
              {invoiceGroupId && voidTargets.length > 1 ? `Void Group (${voidTargets.length})` : 'Void'}
            </Button>
          )}
          {/* #24/#30: Print (current) + Old Print (legacy). Both available for any
              saved invoice (draft or posted); money is identical between formats. */}
          {!isNew && (
            <Button variant="secondary" size="sm" icon={<Printer className="w-4 h-4" />} onClick={() => handlePrint('current')} loading={printing} disabled={printing}>
              Print
            </Button>
          )}
          {!isNew && (
            <Button variant="secondary" size="sm" icon={<Printer className="w-4 h-4" />} onClick={() => handlePrint('legacy')} loading={printing} disabled={printing}>
              Old Print
            </Button>
          )}
          {/* #31: Email the invoice (current-format PDF attached) to the customer.
              Available on any saved invoice, mirroring Print — admin + sales rep
              (the page itself is gated to those roles). Honest error if the
              customer has no email on file. */}
          {!isNew && (
            <Button variant="secondary" size="sm" icon={<Mail className="w-4 h-4" />} onClick={handleEmailInvoice} loading={emailing} disabled={emailing}>
              Email
            </Button>
          )}
          {/* §6: "Your Field Was Sprayed" PROOF — opens an office-reviewable preview of the
              rich proof (fields+acres+boundary map, products, weather, applicator, REI/PHI),
              from which the office one-taps Send. NOT a silent auto-send. Only when this
              invoice came from a job that has been applied (completed / invoiced). Re-send
              safety: relabels + warns once a 'post' notice is already sent. Fail-closed until
              the shared log has loaded so it never bypasses the re-send warning. */}
          {!isNew && jobId && (jobStatus === 'completed' || jobStatus === 'invoiced') && (
            <Button
              variant={postSendCopy.isResend ? 'secondary' : 'primary'}
              size="sm"
              icon={<Bell className="w-4 h-4" />}
              onClick={handleOpenProofPreview}
              loading={loadingProof || sendingPostNotice}
              disabled={loadingProof || sendingPostNotice || loadingJobNotifications || !jobNotificationsLoaded}
            >
              {postSendCopy.isResend ? 'Re-send Proof' : 'Send Proof'}
            </Button>
          )}
          {locations.length > 0 && (
            <Button variant="secondary" size="sm" icon={<Eye className="w-4 h-4" />} onClick={handlePreview} loading={previewing} disabled={previewing || !canEdit}>
              Preview
            </Button>
          )}
          {/* #24: explicit Cancel Without Saving (the unsaved-changes guard still prompts). */}
          <Button variant="secondary" size="sm" icon={<X className="w-4 h-4" />} onClick={handleCancel}>
            Cancel
          </Button>
          {canEdit && (
            <Button
              icon={<Save className="w-4 h-4" />}
              onClick={handleSave}
              loading={saving}
              disabled={saving || posting || fetchingWeather !== null}
            >
              Save
            </Button>
          )}
        </div>
      </div>

      {/* §2 Watchdog — inline advisory flags for this invoice (double-bill) and its
          source job (acre/rate/REI). Auto-refreshes the source job's flags on open. */}
      {!isNew && id && (
        <WatchdogFlagBanner
          invoiceId={id}
          jobId={jobId ?? undefined}
          autoRefresh
        />
      )}

      {/* #24: posted-lock banner — a committed invoice is read-only (the posted
          records warning from #23). Editing inputs are also disabled via canEdit.
          #29: a voided/cancelled invoice is TERMINAL — it can't be unposted, so show a
          distinct red banner instead of the amber "unpost to edit" copy. */}
      {isLocked && (status === 'voided' || status === 'cancelled') && (
        <Card>
          <div className="flex items-start gap-2 px-4 py-3 bg-red-50 border-l-4 border-red-400 rounded text-sm text-red-800">
            <Ban className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              This invoice is <strong>{status}</strong> and is permanently locked for audit. It is excluded from
              open and AR totals and can&apos;t be edited or reopened. It stays visible here for the record. Print is still available.
            </span>
          </div>
        </Card>
      )}
      {isLocked && status !== 'voided' && status !== 'cancelled' && (
        <Card>
          <div className="flex items-start gap-2 px-4 py-3 bg-amber-50 border-l-4 border-amber-400 rounded text-sm text-amber-800">
            <Lock className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              This invoice is <strong>{status}</strong> and is locked. Committed amounts can&apos;t be edited.
              To make changes, unpost it from the posted-invoice list first. Print is still available.
            </span>
          </div>
        </Card>
      )}

      {/* A save snapshots the current form into one RPC. Disable every editable
          control until that RPC settles so a mid-flight keystroke cannot be erased
          when the saved invoice is reloaded. Posting uses the same guard. */}
      <fieldset disabled={saving || posting} className="contents" aria-busy={saving || posting}>

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
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 p-4">
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
          {/* #24: Consultant selector (invoices.salesman_id). Editable only by an
              admin — the save RPC rejects a non-admin attributing to another user,
              so a sales_rep sees their own name read-only. */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Consultant</label>
            <select
              value={consultantId}
              onChange={(e) => { setConsultantId(e.target.value); setDirty(true); }}
              disabled={!canEditConsultant}
              className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
              title={!canEditConsultant && canEdit ? 'Only an admin can change the consultant' : undefined}
            >
              <option value="">Select consultant...</option>
              {consultants.map((c) => (
                <option key={c.id} value={c.id}>{c.full_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Application Service</label>
            <ApplicationServicePicker
              value={appServiceId}
              onChange={(v) => { setAppServiceId(v); setDirty(true); setPreviewData(null); }}
              disabled={!canEdit}
            />
          </div>
          {/* #33: PO Reference — ChemMan purchase-order ref, printed. */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">PO Reference</label>
            <input
              type="text"
              value={poRef}
              onChange={(e) => { setPoRef(e.target.value); setDirty(true); }}
              placeholder="Customer PO #"
              disabled={!canEdit}
              className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
            />
          </div>
          {/* #33: Payment Terms — invoice-level override, printed. */}
          <div>
            <label htmlFor="payment-terms" className="block text-xs font-medium text-gray-500 mb-1">Payment Terms</label>
            <select
              id="payment-terms"
              value={paymentTerms}
              onChange={(e) => {
                setPaymentTerms(e.target.value);
                if (e.target.value !== 'Custom date…') setDueDate('');
                setDirty(true);
              }}
              disabled={!canEditPaymentTerms}
              className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
            >
              <option value="Net 30">Net 30</option>
              <option value="Net 15">Net 15</option>
              <option value="Due on receipt">Due on receipt</option>
              {!['Net 30', 'Net 15', 'Due on receipt', 'Custom date…'].includes(paymentTerms) && (
                <option value={paymentTerms}>{paymentTerms} (legacy)</option>
              )}
              <option value="Custom date…">Custom date…</option>
            </select>
          </div>
          {/* Custom mode: editable date. Otherwise: keep the stamped due date visible
              (read-only) on posted/locked invoices — never hide a real due date. */}
          {(paymentTerms === 'Custom date…' || (!canEditPaymentTerms && !!dueDate)) && (
            <div>
              <label htmlFor="custom-due-date" className="block text-xs font-medium text-gray-500 mb-1">Due Date</label>
              <input
                id="custom-due-date"
                type="date"
                value={dueDate}
                onChange={(e) => { setDueDate(e.target.value); setDirty(true); }}
                disabled={!canEditPaymentTerms}
                required
                className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
              />
            </div>
          )}
          {/* header_notes (printed at the top of the invoice). */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Header Notes</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
              placeholder="Printed at top of invoice"
              disabled={!canEdit}
              className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
            />
          </div>
          {/* #33: Footer Notes — printed at the bottom of the invoice. */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Footer Notes</label>
            <input
              type="text"
              value={footerNotes}
              onChange={(e) => { setFooterNotes(e.target.value); setDirty(true); }}
              placeholder="Printed at bottom of invoice"
              disabled={!canEdit}
              className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
            />
          </div>
          {/* #33: Internal Memo — saved with the invoice but NEVER printed on the
              customer copy. Spans the full row for visibility. */}
          <div className="col-span-2 lg:col-span-3">
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Internal Memo <span className="font-normal text-gray-400">(not printed)</span>
            </label>
            <textarea
              value={internalMemo}
              onChange={(e) => { setInternalMemo(e.target.value); setDirty(true); }}
              placeholder="Internal note — stays off the customer invoice"
              disabled={!canEdit}
              rows={2}
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
                disabled={!canEdit}
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
                            disabled={!canEdit}
                            className={`w-24 ml-auto px-2 py-1 border rounded text-right text-sm tabular-nums disabled:bg-gray-50 ${div ? 'border-amber-400 bg-amber-50' : ''}`}
                          />
                          {div && (
                            <div className="mt-1 flex items-center justify-end gap-1 text-xs font-medium text-amber-700">
                              <AlertTriangle className="w-3 h-3" />
                              {Math.round(div.pct)}% {div.direction} &mdash; review
                            </div>
                          )}
                          {/* F2 Branch B: make the common auto-fill case visible — the >=10% flag above
                              never fires when applied == system, so show whether this row still bills the
                              full field (the unedited default) or was changed. Advisory only. */}
                          {!div && loc.applied_acres != null && loc.applied_acres > 0 && loc.system_acres != null && (
                            appliedMatchesSystem(loc.applied_acres, loc.system_acres) ? (
                              <div className="mt-1 text-right text-xs text-gray-500">
                                Full field &mdash; matches acres on file
                              </div>
                            ) : (
                              <div className="mt-1 text-right text-xs text-gray-500">
                                Edited (field is {loc.system_acres.toFixed(1)} ac)
                              </div>
                            )
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
              readOnly={!canEdit}
              guardrailMode={guardrailMode}
              earliestHarvestDate={earliestHarvestDate}
              applicationDate={jobApplicationDate ?? transactionDate}
            />
          </div>
        )}

        {activeTab === 'customers' && (
          <div className="p-4">
            {growerShareFieldNames.length > 0 && (
              <div className="mb-4 px-3 py-2 bg-blue-50 border-l-4 border-blue-300 text-xs text-blue-800 rounded">
                Grower-share pricing is active on: <strong>{growerShareFieldNames.join(', ')}</strong> — chemicals bill at the per-acre override; product lines print &apos;— included in grower share&apos; at $0 for those growers.
              </div>
            )}
            {!previewData && shares.length > 0 && (
              <div className="mb-4 px-3 py-2 bg-amber-50 border-l-4 border-amber-300 text-xs text-amber-800 rounded">
                Click <strong>Preview</strong> to see exact per-customer amounts (server-computed with tier, grower-share overrides, and service fees applied).
              </div>
            )}
            <CustomerSharesTable
              shares={shares}
              invoiceTotalCents={invoiceTotalCents}
              preview={previewData}
              sharesBasis={sharesBasis}
              onSharesBasisChange={canEdit ? setSharesBasis : undefined}
              splitRefBase={splitRefBase}
              discountByCustomer={discountByCustomer}
              onDiscountChange={canEdit ? handleDiscountChange : undefined}
            />
          </div>
        )}

        {activeTab === 'applied_info' && (
          <div className="p-4 space-y-6">
            {/* #24: read-only carry-over from the source job's as-applied legal
                record (applicator / vehicle / date / start+end weather / tach /
                ground crew). Shown only when this invoice came from a job. */}
            {jobId && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">As-Applied Record (from Job)</h3>
                  <Badge variant="default">read-only</Badge>
                </div>
                {carryover.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No as-applied record has been entered on the source job yet. Open the job and add an
                    Applied Info entry; it will carry over here.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {carryover.map((rec) => (
                      <div key={rec.id} className="border rounded-lg p-3 bg-gray-50 text-sm">
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                          <div className="flex items-center gap-1.5 text-gray-700">
                            <ClipboardList className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-gray-500">Applicator:</span> {rec.applicator_name}
                          </div>
                          <div className="flex items-center gap-1.5 text-gray-700">
                            <Tractor className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-gray-500">Vehicle:</span> {rec.vehicle_name}
                          </div>
                          <div className="flex items-center gap-1.5 text-gray-700">
                            <CalendarDays className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-gray-500">Date:</span> {rec.application_date}
                          </div>
                          <div className="flex items-center gap-1.5 text-gray-700">
                            <Wind className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-gray-500">Start:</span> {rec.start_weather}
                          </div>
                          <div className="flex items-center gap-1.5 text-gray-700">
                            <Thermometer className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-gray-500">End:</span> {rec.end_weather}
                          </div>
                          <div className="flex items-center gap-1.5 text-gray-700">
                            <Clock className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-gray-500">Total time:</span> {rec.total_time}
                          </div>
                          <div className="flex items-center gap-1.5 text-gray-700">
                            <Gauge className="w-3.5 h-3.5 text-gray-400" />
                            <span className="text-gray-500">Net tach:</span> {rec.net_tach}
                          </div>
                          {rec.crew_members.length > 0 && (
                            <div className="flex items-center gap-1.5 text-gray-700 col-span-2 md:col-span-3">
                              <Users className="w-3.5 h-3.5 text-gray-400" />
                              <span className="text-gray-500">Ground crew:</span> {rec.crew_members.join(', ')}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <h3 className="font-semibold">Application Details</h3>
                <p className="text-xs text-gray-500">
                  Free-text summary printed on this invoice. {jobId ? 'Overrides nothing on the job record above.' : ''}
                </p>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Wind Direction</label>
                  <input
                    type="text"
                    value={windDirection}
                    onChange={(e) => { setWindDirection(e.target.value); setDirty(true); }}
                    placeholder="e.g. NW 5-10 mph"
                    disabled={!canEdit}
                    className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Temperature</label>
                  <input
                    type="text"
                    value={temperature}
                    onChange={(e) => { setTemperature(e.target.value); setDirty(true); }}
                    placeholder="e.g. 72F"
                    disabled={!canEdit}
                    className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Applicator</label>
                  <input
                    type="text"
                    value={applicator}
                    onChange={(e) => { setApplicator(e.target.value); setDirty(true); }}
                    placeholder="Applicator name"
                    disabled={!canEdit}
                    className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50"
                  />
                </div>
              </div>
            </div>

            {/* #2 (ChemMan Gap-Closeout): diluent / carrier-water RATE per acre.
                Mirrors the job-side jobs.carrier_rate_gpa (gal/acre). The TOTAL
                (rate x applied acres) is derived live and printed; only the rate
                is persisted. Optional — blank means "not recorded". A QUANTITY of
                water (gallons), never money. */}
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold flex items-center gap-2">
                  <Droplets className="w-4 h-4 text-crx-green" /> Diluent / Carrier Water
                </h3>
                <p className="text-xs text-gray-500">
                  Carrier-water rate the chemical was mixed into, in gallons per acre. The total
                  spray volume is computed from the applied acres and printed on the invoice.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    Diluent / Carrier Water (gal/acre)
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={diluentRate}
                    onChange={(e) => { setDiluentRate(e.target.value); setDirty(true); }}
                    placeholder="e.g. 15"
                    disabled={!canEdit}
                    aria-label="Diluent or carrier water rate in gallons per acre"
                    aria-invalid={!diluentRateValid}
                    className={`w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-50 ${
                      diluentRateValid ? '' : 'border-red-400 focus:ring-red-400'
                    }`}
                  />
                  {!diluentRateValid && (
                    <p className="mt-1 text-xs text-red-600">
                      Enter a number 0 or greater (gal/acre), or leave it blank.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">
                    Total Diluent (gallons)
                  </label>
                  <div className="w-full px-3 py-2 border rounded-lg text-sm bg-gray-50 tabular-nums text-gray-700">
                    {totalDiluentGallons != null ? (
                      <>
                        {new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(totalDiluentGallons)} gal
                        <span className="text-gray-400">
                          {' '}&middot; {formatGallons(diluentRateNum)} gal/ac &times; {totalAppliedAcres.toFixed(1)} ac
                        </span>
                      </>
                    ) : (
                      <span className="text-gray-400">
                        {diluentRateNum == null
                          ? 'Enter a rate to see the total'
                          : 'Add applied acres to see the total'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* #1 (ChemMan Gap-Closeout): structured START + END weather capture.
                One-tap auto-fill from the free Open-Meteo model for the field's
                location + the application date; every value stays editable and
                manual-only entry works offline. The legacy free-text Wind
                Direction / Temperature above are kept for back-compat. */}
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold">Weather Conditions (Start &amp; End)</h3>
                <p className="text-xs text-gray-500">
                  One-tap auto-fill from Open-Meteo for the field&apos;s location and the application date, or enter by hand.
                </p>
              </div>

              {/* Mandatory compliance disclaimer — modeled, not measured. */}
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-amber-800">{WEATHER_DISCLAIMER}</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {(['start', 'end'] as const).map((set) => {
                  const w = set === 'start' ? startWeather : endWeather;
                  const label = set === 'start' ? 'Start' : 'End';
                  const busy = fetchingWeather === set;
                  return (
                    <div key={set} className="rounded-lg border border-gray-200 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{label} Conditions</span>
                          {w.source === 'auto' && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-crx-green/10 text-crx-green">Auto</span>
                          )}
                          {w.source === 'manual' && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">Manual</span>
                          )}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => getWeather(set)}
                          loading={busy}
                          disabled={!canEdit || !weatherCentroid || fetchingWeather !== null}
                          title={weatherCentroid ? 'Auto-fill from Open-Meteo' : 'No mapped field location on this invoice'}
                        >
                          <CloudSun className="w-3.5 h-3.5" /> Get Weather
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            <Clock className="w-3 h-3 inline mr-1" />Time
                          </label>
                          <div className="flex items-center gap-1">
                            <input
                              type="time"
                              value={w.time}
                              onChange={(e) => updateWeather(set, 'time', e.target.value)}
                              disabled={!canEdit || busy}
                              aria-label={`${label} weather time`}
                              className="flex-1 px-2 py-2 text-sm border rounded-lg disabled:bg-gray-50"
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => stampWeatherNow(set)}
                              disabled={!canEdit || busy}
                              title="Stamp the current time"
                            >
                              Now
                            </Button>
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            <Thermometer className="w-3 h-3 inline mr-1" />Temp (&deg;F)
                          </label>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={w.temp_f}
                            onChange={(e) => updateWeather(set, 'temp_f', e.target.value)}
                            disabled={!canEdit || busy}
                            placeholder="e.g. 72"
                            aria-label={`${label} temperature in Fahrenheit`}
                            className="w-full px-2 py-2 text-sm border rounded-lg disabled:bg-gray-50"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            <Wind className="w-3 h-3 inline mr-1" />Wind Dir
                          </label>
                          <input
                            type="text"
                            value={w.wind_direction}
                            onChange={(e) => updateWeather(set, 'wind_direction', e.target.value)}
                            disabled={!canEdit || busy}
                            placeholder="e.g. NW"
                            aria-label={`${label} wind direction`}
                            className="w-full px-2 py-2 text-sm border rounded-lg disabled:bg-gray-50"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            <Wind className="w-3 h-3 inline mr-1" />Wind (mph)
                          </label>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={w.wind_mph}
                            onChange={(e) => updateWeather(set, 'wind_mph', e.target.value)}
                            disabled={!canEdit || busy}
                            placeholder="e.g. 8"
                            aria-label={`${label} wind speed in mph`}
                            className="w-full px-2 py-2 text-sm border rounded-lg disabled:bg-gray-50"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            <Droplets className="w-3 h-3 inline mr-1" />Humidity (%)
                          </label>
                          <input
                            type="number"
                            inputMode="decimal"
                            value={w.humidity_pct}
                            onChange={(e) => updateWeather(set, 'humidity_pct', e.target.value)}
                            disabled={!canEdit || busy}
                            placeholder="e.g. 55"
                            aria-label={`${label} humidity percent`}
                            className="w-full px-2 py-2 text-sm border rounded-lg disabled:bg-gray-50"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {!weatherCentroid && (
                <p className="text-xs text-gray-500">
                  No mapped field boundary found for this invoice&apos;s first location, so auto-fill is unavailable &mdash; enter weather by hand.
                </p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'notifications' && (
          <div className="p-4 space-y-6">
            {/* #41 SHARED HISTORY (the load-bearing parity detail): the SAME customer
                pre/post-application notification log the source JOB shows — read by
                job_id, so a notice sent from the job appears here and a post sent from
                this invoice appears on the job (criterion #3/#5). Only when this
                invoice came from a job. */}
            {jobId && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold flex items-center gap-2">
                      <Bell className="w-4 h-4 text-crx-green" /> Customer Notifications
                    </h3>
                    <p className="text-xs text-gray-500">
                      Pre- and post-application notices sent to this job&apos;s billed
                      customer(s). This history is shared with the job &mdash; sending a
                      notice from either place shows in both.
                    </p>
                  </div>
                </div>
                {loadingJobNotifications ? (
                  <p className="text-sm text-gray-500 py-4 text-center">Loading customer notifications…</p>
                ) : jobNotificationsError ? (
                  <div className="text-center py-4">
                    <p className="text-sm text-red-600">Couldn&apos;t load the customer notification log.</p>
                    <p className="text-xs text-gray-500 mt-1">Sending is disabled until it loads, so an already-sent notice isn&apos;t duplicated.</p>
                    <Button size="sm" variant="secondary" className="mt-2" onClick={loadJobNotifications}>Retry</Button>
                  </div>
                ) : jobNotifications.length === 0 ? (
                  <p className="text-sm text-gray-500 py-4 text-center">No customer notifications have been sent yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50 border-b">
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Type</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Recipient</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Channel</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Sent</th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {jobNotifications.map((n) => (
                          <tr key={n.id} className="hover:bg-gray-50">
                            <td className="px-3 py-2">
                              <Badge variant={n.notification_type === 'pre' ? 'info' : 'success'}>
                                {n.notification_type === 'pre' ? 'Pre' : 'Post'}
                              </Badge>
                            </td>
                            <td className="px-3 py-2">
                              <div className="font-medium">{n.customer?.farm_name ?? 'Customer'}</div>
                              <div className="text-xs text-gray-500">{n.recipient_email || 'no email on file'}</div>
                            </td>
                            <td className="px-3 py-2 capitalize text-gray-600">{n.channel}</td>
                            <td className="px-3 py-2 text-gray-600">{n.sent_at ? new Date(n.sent_at).toLocaleString() : '—'}</td>
                            <td className="px-3 py-2">
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
              </div>
            )}

            <div>
              <h3 className="font-semibold">Your Notifications</h3>
              <p className="text-xs text-gray-500">
                Notifications addressed to you about this invoice and its job. (Customer
                pre/post-application notices are shown above.)
              </p>
            </div>
            {notificationsError ? (
              <div className="flex items-start gap-2 px-3 py-2 bg-red-50 border-l-4 border-red-400 text-sm text-red-800 rounded">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>Could not load notifications: {notificationsError}</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="text-center py-10 text-gray-400">
                <Bell className="w-8 h-8 mx-auto mb-2" />
                <p>No notifications yet</p>
                <p className="text-sm">
                  Notifications addressed to you about this invoice or job will appear here.
                </p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b">
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Date</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Type</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Title</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {notifications.map((n) => (
                    <tr key={n.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                        {new Date(n.created_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{n.notification_type || '—'}</td>
                      <td className="px-3 py-2 font-medium">{n.title}</td>
                      <td className="px-3 py-2 text-gray-600">{n.message || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Card>

      </fieldset>

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

      {/* §6: "Your Field Was Sprayed" PROOF preview — the office REVIEWS the rich proof
          (field/acres/boundary map, products, weather, applicator, REI/PHI) and one-taps
          Send. NOTHING auto-sends. On a RE-SEND (a 'post' notice already sent) the warning
          copy switches to an explicit "notify a SECOND time" caution. */}
      <Modal
        open={showProofPreview}
        onClose={() => setShowProofPreview(false)}
        title={postSendCopy.isResend ? 'Re-send "Your Field Was Sprayed" Proof' : '"Your Field Was Sprayed" Proof'}
        size="large"
      >
        {proofDraft ? (
          <div className="space-y-4">
            {/* Re-send warning (explicit second-notify caution). */}
            {postSendCopy.isResend && (
              <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border-l-4 border-amber-400 rounded text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{postSendCopy.confirmMessage}</span>
              </div>
            )}

            {/* Summary line. */}
            <div className="text-sm text-gray-700 space-y-1">
              <div><span className="font-medium">Job:</span> {proofDraft.jobNumber}{proofDraft.applicationDate ? ` · applied ${proofDraft.applicationDate}` : ''}</div>
              {proofDraft.applicator && <div><span className="font-medium">Applicator:</span> {proofDraft.applicator}</div>}
              {proofDraft.totalAcres !== '—' && <div><span className="font-medium">Total acres:</span> {proofDraft.totalAcres}</div>}
              {proofDraft.weatherSummary && <div><span className="font-medium">Weather at application:</span> {proofDraft.weatherSummary}</div>}
            </div>

            {/* Fields with their boundary-map snapshots. */}
            {proofDraft.fields.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-1.5"><MapPin className="w-4 h-4 text-crx-green" /> Fields treated</h4>
                <div className="space-y-3">
                  {proofDraft.fields.map((f) => (
                    <div key={`${f.field_name}-${f.acres}`} className="text-sm text-gray-700">
                      <div className="font-medium">{f.field_name}{f.location ? ` — ${f.location}` : ''} ({f.acres})</div>
                      {f.mapImageUrl && (
                        <a href={f.mapLink ?? f.mapImageUrl} target="_blank" rel="noopener noreferrer">
                          <img
                            src={f.mapImageUrl}
                            alt={`Map of ${f.field_name}`}
                            width={480}
                            loading="lazy"
                            className="mt-1 max-w-full rounded border border-gray-200"
                          />
                        </a>
                      )}
                      {!f.mapImageUrl && (
                        <div className="text-xs text-gray-400 mt-0.5">No mapped boundary on file for this field &mdash; map omitted.</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Products with REI/PHI safe-timing. */}
            {proofDraft.products.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-1.5"><FlaskConical className="w-4 h-4 text-crx-green" /> Products applied</h4>
                <ul className="space-y-1.5">
                  {proofDraft.products.map((p) => (
                    <li key={p.label} className="text-sm text-gray-700">
                      <span className="font-medium">{p.label}</span>
                      {p.signalWord && <span className="text-amber-700"> ({p.signalWord})</span>}
                      {p.safeTiming && <div className="text-xs text-gray-500">{p.safeTiming}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="text-xs text-gray-500 border-t pt-3">
              This proof is emailed to the job&apos;s billed customer(s). Customers with no email on file are
              logged but not emailed. Each send is recorded in the notification log below.
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={() => setShowProofPreview(false)} disabled={sendingPostNotice}>
                Cancel
              </Button>
              <Button
                size="sm"
                icon={<Send className="w-4 h-4" />}
                onClick={handleSendPostNotification}
                loading={sendingPostNotice}
                disabled={sendingPostNotice}
              >
                {postSendCopy.isResend ? 'Re-send Proof' : 'Send Proof'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-gray-500">Building the proof&hellip;</div>
        )}
      </Modal>

      {/* #28: Post confirm — posting commits the bill to its month-end batch. */}
      <ConfirmModal
        open={showPostConfirm}
        onClose={() => setShowPostConfirm(false)}
        onConfirm={() => { setShowPostConfirm(false); handlePost(); }}
        title={invoiceGroupId ? 'Post Invoice Group' : 'Post Invoice'}
        message={
          invoiceGroupId
            ? `Post all ${siblings.length || 1} invoice(s) in this split group? This commits them to the month-end batch for their invoice date. They become read-only; use Unpost to reverse.`
            : 'Post this invoice? This commits it to the month-end batch for its invoice date and makes it read-only. Use Unpost to reverse.'
        }
        confirmLabel={invoiceGroupId ? 'Post Group' : 'Post Invoice'}
        variant="info"
        loading={posting}
      />

      {/* #28: Unpost confirm — reverse a posting back to the Unposted list. */}
      <ConfirmModal
        open={showUnpostConfirm}
        onClose={() => setShowUnpostConfirm(false)}
        onConfirm={() => { setShowUnpostConfirm(false); handleUnpost(); }}
        title={invoiceGroupId && unpostTargets.length > 1 ? 'Unpost Invoice Group' : 'Unpost Invoice'}
        message={
          (invoiceGroupId && unpostTargets.length > 1
            ? `Return all ${unpostTargets.length} posted invoice(s) in this group to the Unposted list? `
            : 'Return this invoice to the Unposted list? ') +
          'This reverses the posting so it can be edited again and updates the affected month-end batch totals. An invoice with payments or prepay applied, or one in a closed accounting period, cannot be unposted.'
        }
        confirmLabel={invoiceGroupId && unpostTargets.length > 1 ? 'Unpost Group' : 'Unpost Invoice'}
        variant="warning"
        loading={unposting}
      />

      {/* #29: Void modal — a required reason (button disabled until non-empty), then
          void_invoice (draft/unposted -> cancelled, posted/overdue -> voided). Group-aware. */}
      <Modal open={showVoidModal} onClose={() => { if (!voiding) setShowVoidModal(false); }} title={invoiceGroupId && voidTargets.length > 1 ? 'Void Invoice Group' : 'Void Invoice'}>
        <div className="space-y-4">
          <div className="flex items-start gap-3 p-3 bg-red-50 rounded-lg">
            <Ban className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800">
              {invoiceGroupId && voidTargets.length > 1
                ? `Void all ${voidTargets.length} invoice(s) in this split group? `
                : 'Void this invoice? '}
              A draft/unposted invoice is <strong>cancelled</strong>; a posted invoice is <strong>voided</strong> and its
              balance, allocations, and prepay are reversed. This is terminal and can&apos;t be undone. The invoice stays
              visible for audit but drops out of open and AR totals.
            </p>
          </div>
          <div>
            <label htmlFor="void-reason" className="block text-sm font-medium text-gray-700 mb-1">
              Reason for voiding <span className="text-red-600">*</span>
            </label>
            <textarea
              id="void-reason"
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              rows={3}
              placeholder="e.g., Entered in error, duplicate invoice, wrong customer"
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-red-200"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setShowVoidModal(false)} disabled={voiding}>Cancel</Button>
            <Button
              variant="danger"
              icon={<Ban className="w-4 h-4" />}
              onClick={handleVoid}
              loading={voiding}
              disabled={voiding || !voidReason.trim()}
            >
              {invoiceGroupId && voidTargets.length > 1 ? 'Void Group' : 'Void Invoice'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* #27: reverse Transfer to Scheduling confirm. */}
      <ConfirmModal
        open={showTransferToSchedulingConfirm}
        onClose={() => setShowTransferToSchedulingConfirm(false)}
        onConfirm={() => { setShowTransferToSchedulingConfirm(false); handleTransferToScheduling(); }}
        title="Transfer to Scheduling"
        message="Return this invoice to its source job? This cancels the invoice (its chemical lines and customer shares are removed) and returns the job to Completed so it can be re-invoiced or cancelled. Only works on an unposted invoice."
        confirmLabel="Transfer to Scheduling"
        variant="info"
        loading={transferringToScheduling}
      />

      {/* §5: block-mode over-label-rate admin override — a required reason (button disabled
          until non-empty). Only reached in 'block' mode for an admin; logs the reason to
          the activity feed then saves. This is the escape hatch — never a hard wall. */}
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
            <label htmlFor="override-reason" className="block text-sm font-medium text-gray-700 mb-1">
              Reason for the override <span className="text-red-600">*</span>
            </label>
            <textarea
              id="override-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              rows={3}
              placeholder="e.g., Split application across two passes; per-pass rate is within label."
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-200"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setShowOverrideModal(false)} disabled={saving}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleOverrideConfirm}
              loading={saving}
              disabled={saving || !overrideReason.trim()}
            >
              Override &amp; Save
            </Button>
          </div>
        </div>
      </Modal>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
