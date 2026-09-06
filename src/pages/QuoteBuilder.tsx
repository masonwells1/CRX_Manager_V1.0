import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Save,
  Send,
  ShoppingCart,
  Plus,
  Trash2,
  Search,
  ChevronDown,
  ChevronUp,
  Download,
  AlertTriangle,
  Pencil,
  History,
  RotateCcw,
  Eye,
  EyeOff,
  CheckCircle,
  Copy,
  CalendarClock,
  PackageOpen,
  XCircle,
  Ban,
  Undo2,
  MoreHorizontal,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import SearchableSelect from '../components/ui/SearchableSelect';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import RecordVersionConflictDialog from '../components/ui/RecordVersionConflictDialog';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useAuth } from '../contexts/AuthContext';
import { useBelowCostApproval } from '../contexts/BelowCostApprovalContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { sanitizeError, supabase, supabaseUntyped, assertRpcResult, checkMutationResult, hasRpcCode, rpcAuthErrorMessage, RpcErrorCodes } from '../lib/db';
import {
  convertQuoteToOrderWithRowVersion,
  createQuoteVersionWithRowVersion,
  restoreQuoteVersionWithRowVersion,
} from '../lib/quoteLifecycleRpc';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { getIdempotencyBindingRejection, getIdempotencyMismatchResult } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import { formatUSD, formatCents } from '../lib/money';
import { BelowCostApprovalHandledError, isBelowCostApprovalHandledError, withBelowCostReason } from '../lib/belowCostApproval';
import { catalogPricePerAcre, validateCommissionSplits } from '../lib/quoteCalc';
import { buildCommissionSplitPatch, nextLoadedSplitSnapshot } from '../lib/commissionSplitConcurrency';
import {
  buildRowVersionPatch,
  readRowVersion,
  resolveAuthoritativeSaveRowVersion,
  resolveDirectMutationRowVersion,
  hasReceiptId,
  NON_SAVE_RECOVERY,
  type StaleSaveConflictOrigin,
} from '../lib/recordVersionConcurrency';
import { notifyLargeOrder, notifyCreditLimitExceeded } from '../lib/notificationTriggers';
import { warnIfOverCreditLimit } from '../lib/creditLimit';
import { sendOrderConfirmedEmail } from '../lib/orderConfirmedEmail';
import { trackBusinessEvent } from '../lib/metrics';
import { localDatePlusDays, localToday, parseLocalDate } from '../lib/dateUtils';
import { downloadQuotePdf, generateQuotePdf } from '../lib/quotePdf';
import { sendEmail, pdfToBase64, buildEmailHtml } from '../lib/emailService';
import { checkRUPCompliance } from '../lib/rupCompliance';
import { preferredQuoteNotes } from '../lib/quoteNotes';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import HelpTip from '../components/ui/HelpTip';
import TransactionThread from '../components/ui/TransactionThread';
import CommissionSplitEditor from '../components/ui/CommissionSplitEditor';
import { useStaleQuoteCheck } from '../hooks/useGuardrails';
import GuardrailBanner from '../components/ui/GuardrailBanner';
import { ProductOptionDetails } from '../components/products/ProductOptionPresentation';
import { ProductSearchResultRow } from '../components/products/ProductSearchResultRow';
import type {
  Quote,
  QuoteSection,
  QuoteItem,
  QuoteVersion,
  QuotePdfTemplate,
  QuoteTemplate,
  Product,
  Customer,
  UnitConversion,
  CommissionSplit,
  QuoteStatus,
  BookingSettlement,
  JobStatus,
} from '../types';
import type { Json } from '../types/supabase';

interface LocalSection {
  _key: string;
  id?: string;
  section_name: string;
  sort_order: number;
  section_notes: string | null;
  section_header_notes: string | null;
  needed_by_date: string | null;
  field_id: string | null;
  items: LocalItem[];
}

type CalcMode = 'rate_acres' | 'units_direct';

// Keeps the reason-bearing retry key safely below PostgreSQL B-tree entry limits.
// The server independently fingerprints the full request, so the exact reason
// remains bound to the idempotency receipt rather than being trusted from the key.
const MAX_REVERT_REASON_LENGTH = 500;

interface LocalItem {
  _key: string;
  id?: string;
  product_id: string;
  sort_order: number;
  notes: string | null;
  price_per_unit: number;
  price_override: number | null;
  current_cost: number;
  suggested_rate: string | null;
  actual_rate: number | null;
  rate_unit: string | null;
  oz_per_acre: number | null;
  price_per_acre: number | null;
  acres: number | null;
  total_units_needed: number | null;
  unit_size: string | null;
  profit: number;
  total_price: number;
  net_margin: number;
  product?: Product;
  calc_mode: CalcMode;
  price_unit: string | null;
}

interface FieldOption {
  id: string;
  field_name: string;
  customer_id: string | null;
  total_acres: number | null;
  measured_acres: number | null;
  override_acres: number | null;
}

interface ActivePlannedHold {
  product_id: string;
  quantity: number;
  expires_at: string | null;
}

interface DrawRow {
  product_id: string;
  product_name: string;
  booked: number;
  drawn: number;
  remaining: number;
  qty: string;
  unit: string | null;
}

let keyCounter = 0;
function nextKey() {
  return `_k${++keyCounter}`;
}

function makeEmptyItem(): LocalItem {
  return {
    _key: nextKey(),
    product_id: '',
    sort_order: 1,
    notes: null,
    price_per_unit: 0,
    price_override: null,
    current_cost: 0,
    suggested_rate: null,
    actual_rate: null,
    rate_unit: null,
    oz_per_acre: null,
    price_per_acre: null,
    acres: null,
    total_units_needed: null,
    unit_size: null,
    profit: 0,
    total_price: 0,
    net_margin: 0,
    calc_mode: 'rate_acres',
    price_unit: null,
  };
}

function hasUserEnteredItemValues(item: LocalItem): boolean {
  return item.notes !== null
    || item.price_override !== null
    || item.actual_rate !== null
    || item.rate_unit !== null
    || item.acres !== null
    || item.total_units_needed !== null
    || item.unit_size !== null
    || item.price_unit !== null
    || item.calc_mode !== 'rate_acres';
}

function makeEmptySection(order: number): LocalSection {
  return {
    _key: nextKey(),
    section_name: `Section ${order}`,
    sort_order: order,
    section_notes: null,
    section_header_notes: null,
    needed_by_date: null,
    field_id: null,
    items: [],
  };
}

export default function QuoteBuilder() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { profile } = useAuth();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const convertQuoteIdem = useIdempotencyKey('convert_quote_to_order', profile?.id || '');
  // A committed conversion can be replayed from the idempotency cache with
  // status:'created'. Keep that marker so a lost response can still trigger
  // the client-only email/alerts once, but suppress duplicate side effects if
  // this mounted page observes the same stable order_id more than once.
  const firedConvertSideEffects = useRef<Set<string>>(new Set());
  const plannedHoldsIdem = useIdempotencyKey('create_planned_holds', profile?.id || '');
  const saveTemplateIdem = useIdempotencyKey('save_quote_template', profile?.id || '');
  const fromTemplateIdem = useIdempotencyKey('create_quote_from_template', profile?.id || '');
  const rolloverIdem = useIdempotencyKey('rollover_quote_to_season', profile?.id || '');
  // Version idempotency is quote-specific. Reusing one key after navigating
  // between Quotes could otherwise replay a version created for another Quote.
  const {
    getKey: getCreateVersionIdempotencyKey,
    resetKey: resetCreateVersionIdempotencyKey,
  } = useIdempotencyKey(
    'create_quote_version',
    `${profile?.id || ''}:${id || ''}`,
  );
  const {
    getKey: getRestoreVersionIdempotencyKey,
    resetKey: resetRestoreVersionIdempotencyKey,
  } = useIdempotencyKey(
    'restore_quote_version',
    `${profile?.id || ''}:${id || ''}`,
  );
  const scheduleJobIdem = useIdempotencyKey('create_job_from_quote_section', profile?.id || '');
  const drawDownIdem = useIdempotencyKey('draw_down_quote', profile?.id || '');
  const emailQuoteIdem = useIdempotencyKey('send_email_quote', profile?.id || '');
  const closeAppliedIdem = useIdempotencyKey('close_quote_as_applied', profile?.id || '');
  const closeShortIdem = useIdempotencyKey('close_quote_as_short', profile?.id || '');

  // Partial booking draw-down (sell-side roadmap #1): pull part of the booked
  // quantities into an order; the quote stays open with the remaining balance.
  const [showDrawModal, setShowDrawModal] = useState(false);
  const [drawRows, setDrawRows] = useState<DrawRow[]>([]);
  const [drawLoading, setDrawLoading] = useState(false);
  const [drawing, setDrawing] = useState(false);
  // Booking settlement (roadmap #6c): read-only booked/drawn/remaining + prepay
  // position for an open booking (sent/revised quote), via get_booking_settlement.
  const [bookingSettlement, setBookingSettlement] = useState<BookingSettlement | null>(null);
  const { warning: staleWarning, check: checkStaleQuote, dismiss: dismissStaleWarning } = useStaleQuoteCheck();
  const isEditing = Boolean(id);

  const [loading, setLoading] = useState(isEditing);
  const [saving, setSaving] = useState(false);
  // Kept locally rather than in generated DB types until post-apply regeneration.
  const quoteRowVersionRef = useRef<number | null>(null);
  // Unlike the dialog's open/closed state, this latch survives "Keep Editing".
  // Only a complete, stable Quote reload may clear it.
  const quoteVersionRecoveryRequiredRef = useRef(false);
  const createVersionAttemptRef = useRef<{
    key: string;
    expectedRowVersion: number | null;
  } | null>(null);
  const restoreVersionAttemptRef = useRef<{
    key: string;
    versionId: string;
    expectedRowVersion: number | null;
  } | null>(null);
  const resetCreateVersionAfterReloadRef = useRef(false);
  const resetRestoreVersionAfterReloadRef = useRef(false);
  const resetConvertAfterReloadRef = useRef(false);
  // Once this tab has observed a numeric token, recovery must never downgrade
  // it to the frontend-first legacy tokenless contract.
  const quoteNumericVersionRequiredRef = useRef(false);
  // The quote whose save was rejected with IDEMPOTENCY_PAYLOAD_CONFLICT while the
  // operator was no longer in that editing session, so the recovery dialog could
  // not be shown for it. The server has bound this key to a different payload, so
  // every later save reusing it — of ANY quote, because the key is scoped by
  // operation and user — is rejected the same way until the key rotates.
  //
  // The key is NOT rotated here. It is a receipt as well as a retry token: it may
  // represent a save that committed and lost its reply, and replaying the original
  // payload is the only deterministic way to learn that. Retiring it early is what
  // #603 shipped and reverted. Rotation happens where it is sanctioned — after an
  // authoritative reload of this existing quote resolves the outcome — which is
  // the same rule `reloadAfterStaleSave` already follows.
  const payloadConflictQuoteIdRef = useRef<string | null>(null);
  const [staleSaveOpen, setStaleSaveOpen] = useState(false);

  const getCreateVersionAttempt = useCallback(() => {
    const key = getCreateVersionIdempotencyKey();
    if (createVersionAttemptRef.current?.key === key) {
      return createVersionAttemptRef.current;
    }
    const attempt = {
      key,
      expectedRowVersion: quoteRowVersionRef.current,
    };
    createVersionAttemptRef.current = attempt;
    return attempt;
  }, [getCreateVersionIdempotencyKey]);

  const resetCreateVersionAttempt = useCallback(() => {
    createVersionAttemptRef.current = null;
    resetCreateVersionIdempotencyKey();
  }, [resetCreateVersionIdempotencyKey]);

  const getRestoreVersionAttempt = useCallback((versionId: string) => {
    if (restoreVersionAttemptRef.current?.versionId === versionId) {
      return restoreVersionAttemptRef.current;
    }
    // Selecting a different snapshot is a new action intent and must not reuse
    // a key that the server may already have bound to the previous version.
    resetRestoreVersionIdempotencyKey();
    const attempt = {
      key: getRestoreVersionIdempotencyKey(),
      versionId,
      expectedRowVersion: quoteRowVersionRef.current,
    };
    restoreVersionAttemptRef.current = attempt;
    return attempt;
  }, [getRestoreVersionIdempotencyKey, resetRestoreVersionIdempotencyKey]);

  const resetRestoreVersionAttempt = useCallback(() => {
    restoreVersionAttemptRef.current = null;
    resetRestoreVersionIdempotencyKey();
  }, [resetRestoreVersionIdempotencyKey]);

  const [converting, setConverting] = useState(false);
  const [quoteCreatedAt, setQuoteCreatedAt] = useState<string | null>(null);
  const [confirmConvertOpen, setConfirmConvertOpen] = useState(false);
  const [confirmBookAsOrderOpen, setConfirmBookAsOrderOpen] = useState(false);
  const [bookingAsOrder, setBookingAsOrder] = useState(false);
  const [duplicateOrderConfirmOpen, setDuplicateOrderConfirmOpen] = useState(false);
  const [duplicateOrderMsg, setDuplicateOrderMsg] = useState('');

  const [customerId, setCustomerId] = useState('');
  const [tier, setTier] = useState(1);
  const [validDays, setValidDays] = useState(15);
  const [headerNotes, setHeaderNotes] = useState('');
  const [footerNotes, setFooterNotes] = useState('');
  const [commissionSplit, setCommissionSplit] = useState<CommissionSplit>({
    splits: [{ recipient: '', percentage: 100 }],
  });
  // Lost-update guard: split as loaded from the DB, and whether the user has
  // changed it this session (see src/lib/commissionSplitConcurrency.ts).
  const loadedCommissionSplitRef = useRef<CommissionSplit | null>(null);
  const commissionSplitTouchedRef = useRef(false);
  const [quoteNumber, setQuoteNumber] = useState('');
  const [status, setStatus] = useState<QuoteStatus>('draft');
  const [quoteId, setQuoteId] = useState<string | null>(id || null);
  // Scoped by the quote this save actually TARGETS. F1 makes an ambiguous reply
  // RETAIN this key, and QuoteBuilder does not remount when only `:id` changes (no
  // `<x>/:id` route in src/App.tsx carries a `key` prop). Page-wide, an unresolved
  // key minted for quote A would therefore be sent with quote B's payload; the
  // server fingerprints the mismatch and answers IDEMPOTENCY_PAYLOAD_CONFLICT, so
  // it fails closed with no cross-quote write — but B gets a conflict dialog it
  // did nothing to earn. `create_quote_version` below already scopes this way, for
  // this same reason.
  //
  // The scope mirrors `p_quote_id` EXACTLY (see the save_quote call), so it binds
  // the record the RPC writes rather than the route — which is why route-id
  // scoping would be wrong here: `/quotes/new` has no route id, and `quoteId` is
  // state that the create path reassigns after the save.
  //
  // RESIDUAL, stated rather than implied: every create scopes to 'new', so an
  // unresolved create can still be inherited by the next create on this mount.
  // Binding that needs PR #535's fingerprintIntentPayload.
  const saveQuoteIntentScope = (quoteId && isEditing) ? quoteId : 'new';
  const {
    getKey: getSaveQuoteIdempotencyKey,
    resetKey: resetSaveQuoteIdempotencyKey,
    resetKeyFor: resetSaveQuoteKeyFor,
  } = useIdempotencyKey('save_quote', profile?.id || '', saveQuoteIntentScope);
  // Which scope produced the conflict the stale-save dialog is currently offering to
  // recover. Scoping the key made this necessary: the dialog stays open across a route
  // change, and `reloadAfterStaleSave` releases the CURRENT render's scope, so an
  // operator who navigates A -> B with A's dialog open and then clicks Reload would
  // release B's key and leave A's rejected one in place. Recorded at the moment the
  // conflict opens, checked before anything is released.
  //
  // EVERY site that opens this dialog must record the scope. An opener that skips it
  // leaves the PREVIOUS quote's scope standing, and the comparison below then refuses
  // to release the CURRENT quote's key after its own authoritative reload — so that
  // quote's next edited save fails closed and forces a reload that discards the
  // operator's edits. Recording at only the save-conflict branch was exactly that
  // defect. Keep Editing clears the record because the dialog it belonged to is gone;
  // the reload path clears it only when it actually releases, since a reload for a
  // DIFFERENT quote must leave the originating quote's key retained.
  const staleSaveConflictScopeRef = useRef<StaleSaveConflictOrigin>(null);

  // The wall clock one save_quote attempt is pinned to, per intent scope.
  //
  // The server fingerprints the WHOLE request — quote id, the entire quote payload,
  // the sections, and the actor — into `v_request_fingerprint`
  // (20260812115236_quote_items_cost_at_quote_snapshot.sql:348) and rejects a replay
  // whose fingerprint differs with IDEMPOTENCY_PAYLOAD_CONFLICT. `expires_at` and
  // `sent_at` are derived from `Date.now()`, so a plain re-send regenerates them to a
  // different millisecond and can never match the original.
  //
  // Without this, the recovery instruction below — press Save again on the SAME
  // retained key — is impossible to carry out: the retained key would be a receipt no
  // request this page can build could ever redeem, and a create whose first attempt
  // committed server-side would be stranded with no way back to it.
  //
  // So the first save under a given key records the instant, and every retry under
  // that same key reuses it. Retiring the key mints a new one, which is a new attempt
  // and takes a fresh instant. Keyed by scope and stamped with the key it was minted
  // for, so an A -> B -> A navigation cannot hand quote A's retry quote B's clock.
  //
  // Only the CLOCK is frozen, never the payload. If the operator edits the quote —
  // `valid_days` included — the fingerprint legitimately changes and the server is
  // right to refuse: that is a different request, not a retry.
  const saveQuoteAttemptClockRef = useRef<Map<string, { key: string; atMs: number }>>(new Map());
  const [isPlanned, setIsPlanned] = useState(false);
  const [wasPlanned, setWasPlanned] = useState(false);

  const [sections, setSections] = useState<LocalSection[]>([makeEmptySection(1)]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [activePlannedHolds, setActivePlannedHolds] = useState<ActivePlannedHold[]>([]);

  const [productSearchOpen, setProductSearchOpen] = useState<{
    sectionKey: string;
    itemKey: string;
  } | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [keepProductPickerOpen, setKeepProductPickerOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [rupWarnings, setRupWarnings] = useState<string[]>([]);
  const [quoteVersions, setQuoteVersions] = useState<QuoteVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<QuoteVersion | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [revising, setRevising] = useState(false);
  // Quote lifecycle terminal actions (sell-side roadmap #5 — unstick lifecycle):
  // decline/cancel set a terminal status (triggers release holds); un-accept/
  // reopen routes through the hardened admin-only revert_quote_status RPC.
  const [confirmDeclineOpen, setConfirmDeclineOpen] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [statusActionLoading, setStatusActionLoading] = useState(false);
  // Close a booking we fulfilled by APPLYING product (job applications), as
  // opposed to delivering it (convert/draw = chemical sale). Distinct terminal
  // status; releases any un-applied leftover; never double-bills. (owner 2026-07-03)
  const [confirmCloseAppliedOpen, setConfirmCloseAppliedOpen] = useState(false);
  const [closingApplied, setClosingApplied] = useState(false);
  // Close a booking the customer ABANDONED (walked away / took only part): the
  // un-fulfilled remainder is released back to free inventory. Distinct terminal
  // status 'closed_short'; never bills. The escape hatch for a partially-drawn
  // booking that Decline/Cancel/Expire refuse (BOOKING_PARTIALLY_DRAWN). (#1)
  const [confirmCloseShortOpen, setConfirmCloseShortOpen] = useState(false);
  const [closingShort, setClosingShort] = useState(false);
  // Draft bookings CAN be scheduled server-side (a pre-planned draft is valid),
  // but we warn first because the booking hasn't been sent to the customer. (#103)
  const [confirmDraftScheduleKey, setConfirmDraftScheduleKey] = useState<string | null>(null);
  const [showRevertModal, setShowRevertModal] = useState(false);
  const [revertReason, setRevertReason] = useState('');
  // Bind the retry key to the exact action intent. A network-uncertain retry
  // reuses its key, while navigating to another quote or editing the reason
  // produces a new key that cannot replay the prior quote's result.
  const revertStatusIdem = useIdempotencyKey(
    'revert_quote_status',
    `${profile?.id || ''}:${id || ''}:${revertReason.trim()}`,
  );
  const [reverting, setReverting] = useState(false);
  // #3 Stage A: email the quote PDF to the grower via the send-email Edge Function.
  const [emailingGrower, setEmailingGrower] = useState(false);
  const [lastQuoteEmailAt, setLastQuoteEmailAt] = useState<string | null>(null);
  const [customerView, setCustomerView] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Transaction thread: related orders, deliveries, invoices from this quote
  const [threadOrders, setThreadOrders] = useState<{ id: string; order_number: string; deliveries: { id: string; delivery_number: string }[]; invoices: { id: string; invoice_number: string }[] }[]>([]);
  const [previewPdfUrl, setPreviewPdfUrl] = useState<string | null>(null);
  const [pdfTemplates, setPdfTemplates] = useState<QuotePdfTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [customColumns, setCustomColumns] = useState<string[] | null>(null);
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  // Quote template state
  const [quoteTemplates, setQuoteTemplates] = useState<QuoteTemplate[]>([]);
  const [showSaveTemplateModal, setShowSaveTemplateModal] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [showRolloverModal, setShowRolloverModal] = useState(false);
  const [rolloverSeason, setRolloverSeason] = useState(new Date().getFullYear() + 1);
  const [createOrderMenuOpen, setCreateOrderMenuOpen] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const createOrderMenuRef = useRef<HTMLDivElement>(null);
  const moreActionsRef = useRef<HTMLDivElement>(null);

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const suppressDirtyUntilReloadSettlesRef = useRef(false);
  const initialLoadGenerationRef = useRef(0);
  const [installedLoadGeneration, setInstalledLoadGeneration] = useState(0);
  // Serial number for quote loads. App.tsx routes every /quotes/:id to this one
  // element with no `key`, so navigating between two saved quotes re-runs the id
  // effect WITHOUT remounting. A load whose serial is no longer current has been
  // superseded — by a route change, or by a newer reload of the same quote — and
  // describes a record this page is no longer showing, so it must install
  // nothing: not the form, not quoteId, not the row-version token.
  const quoteLoadSerialRef = useRef(0);
  // The quote the URL currently names. The serial above orders CALLS; this binds
  // a call to a RECORD, and the two operands have genuinely independent sources
  // (one from this component's own call order, one from the router). Both are
  // needed: `fetchQuote` is also called from stale closures that survive a
  // navigation — the stale-save reload and the post-conversion refetch — and such
  // a call MINTS THE NEWEST SERIAL for the quote the operator already left, so a
  // serial check alone would certify the stale snapshot as current instead of
  // rejecting it.
  //
  // Written in a LAYOUT EFFECT, never during render. React may begin rendering a
  // transition to another quote and then discard that render while the current
  // one is still the committed screen; a render-time write publishes the new id
  // anyway. The save guard reads this ref to decide whether its reply still
  // belongs on screen, so a route that "changed" only inside a discarded render
  // makes it drop a VALID reply after the database has committed — leaving the
  // stale row-version token and a dirty form, and sending the operator's retry
  // into stale-write recovery on a document that drives cost and price. A layout
  // effect runs on commit, and before the passive effects that start the loads,
  // so every reader still sees the committed route. Same discipline, and the same
  // reasoning, as `CustomerDetail.tsx`'s `currentIdRef`.
  const routeQuoteIdRef = useRef<string | null>(id ?? null);
  useLayoutEffect(() => {
    routeQuoteIdRef.current = id ?? null;
  }, [id]);
  const blocker = useUnsavedChanges(isDirty);

  // Status-based guards
  const currentStatus = status || 'draft';
  const canEdit = ['draft', 'revised'].includes(currentStatus);
  // Codex round-7 P2: include 'sent' so a frozen sent quote can still be re-emailed —
  // "Preview Quote" is the only route to the Email-to-Grower button, and
  // handleEmailToGrower explicitly supports re-sending an already-sent quote and
  // creates a newly confirmed version snapshot before every send.
  const canSend = ['draft', 'revised', 'sent'].includes(currentStatus);
  // The server conversion RPC deliberately resumes an accepted Quote that has
  // no Order and returns the existing Order when one already exists. Keeping
  // accepted Quotes convertible gives a sales rep a safe retry path if the
  // accepted-status save committed but its row-version response was uncertain.
  const canConvert = ['sent', 'revised', 'accepted'].includes(currentStatus);
  // Both whole conversion and draw_down_quote accept sent/revised bookings.
  const canDraw = currentStatus === 'sent' || currentStatus === 'revised';

  // Quote lifecycle terminal/reopen actions (roadmap #5). The status-transition
  // trigger allows: draft/sent/revised → cancelled; sent/revised → declined;
  // accepted/declined/expired/cancelled → sent (admin revert RPC only).
  const isAdmin = profile?.role === 'admin';
  const canCancel = isEditing && ['draft', 'sent', 'revised'].includes(currentStatus);
  const canDecline = isEditing && ['sent', 'revised'].includes(currentStatus);
  // "Close — fulfilled by application" is only for a PLANNED open booking (the
  // application channel), in parity with the close_quote_as_applied RPC
  // (sent/revised + is_planned). A plain non-planned sales quote uses convert/
  // decline, not this. (Codex 2026-07-03 P2)
  const canCloseApplied = isEditing && isPlanned && ['sent', 'revised'].includes(currentStatus);
  // "Close — Short" (customer walked away, release the remainder) is for ANY open
  // booking (planned or not) — parity with close_quote_as_short, which does NOT
  // require is_planned (a non-planned open booking can also be abandoned; it just
  // has no crop holds to release). (#1)
  const canCloseShort = isEditing && ['sent', 'revised'].includes(currentStatus);
  // A booking only takes new scheduled jobs while it's not terminal AND not
  // 'accepted' — parity with create_job_from_quote_section's status guard: once a
  // booking is closed/declined/cancelled/expired it's terminal, and 'accepted'
  // means it was converted to a chemical SALE (order) so scheduling a job would
  // double-count the product (finding #103 — QUOTE_ALREADY_CONVERTED). Draft
  // stays schedulable (warn-only). (#103)
  const canScheduleJobs = isPlanned && !['accepted', 'declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short'].includes(currentStatus);
  // Show an inline explanation where the Schedule-Job button would be, on an
  // accepted planned booking, so the user knows to make a standalone job. (#103)
  const scheduleBlockedAccepted = isPlanned && currentStatus === 'accepted';
  const canRevert = isEditing && isAdmin && ['accepted', 'declined', 'expired', 'cancelled'].includes(currentStatus);
  const revertLabel = currentStatus === 'accepted' ? 'Un-accept' : 'Reopen';

  useEffect(() => {
    if (!createOrderMenuOpen && !moreActionsOpen) return;

    const closeMenusOnOutsideClick = (event: MouseEvent) => {
      if (
        !createOrderMenuRef.current?.contains(event.target as Node)
        && !moreActionsRef.current?.contains(event.target as Node)
      ) {
        setCreateOrderMenuOpen(false);
        setMoreActionsOpen(false);
      }
    };
    const closeMenusOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCreateOrderMenuOpen(false);
        setMoreActionsOpen(false);
      }
    };

    document.addEventListener('mousedown', closeMenusOnOutsideClick);
    document.addEventListener('keydown', closeMenusOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeMenusOnOutsideClick);
      document.removeEventListener('keydown', closeMenusOnEscape);
    };
  }, [createOrderMenuOpen, moreActionsOpen]);

  // Mark dirty whenever user changes form data (after initial load)
  useEffect(() => {
    if (!initialLoadDone.current) return;
    if (suppressDirtyUntilReloadSettlesRef.current) return;
    setIsDirty(true);
  }, [customerId, tier, validDays, headerNotes, footerNotes, sections, commissionSplit]);

  // Release initial-load dirty suppression only after React has committed the
  // complete installed snapshot. Timer/frame releases can run before that
  // commit on a busy device and let a late passive update mark a saved quote
  // dirty, blocking its first draw-down attempt.
  useEffect(() => {
    if (installedLoadGeneration === 0) return;
    if (initialLoadGenerationRef.current !== installedLoadGeneration) return;
    initialLoadDone.current = true;
    suppressDirtyUntilReloadSettlesRef.current = false;
    setIsDirty(false);
  }, [installedLoadGeneration]);

  // Booking settlement (roadmap #6c): for an open booking (saved sent/revised
  // quote), load booked/drawn/remaining + prepay position. Re-runs when the
  // status changes (e.g. after a draw flips it). Read-only; clears otherwise.
  useEffect(() => {
    const isOpenBooking = isEditing && quoteId && (currentStatus === 'sent' || currentStatus === 'revised');
    if (!isOpenBooking) { setBookingSettlement(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_booking_settlement', { p_quote_id: quoteId });
        if (error) throw error;
        const s = assertRpcResult<BookingSettlement>(data, 'get_booking_settlement');
        if (!cancelled) setBookingSettlement(s && s.found ? s : null);
      } catch {
        if (!cancelled) setBookingSettlement(null);
      }
    })();
    return () => { cancelled = true; };
  }, [isEditing, quoteId, currentStatus]);

  const loadActivePlannedHolds = useCallback(async (targetQuoteId: string) => {
    const { data, error } = await supabase
      .from('inventory_holds')
      .select('product_id, quantity, expires_at')
      .eq('hold_type', 'crop_program')
      .eq('source_id', targetQuoteId)
      .eq('is_active', true);
    if (error) {
      setActivePlannedHolds([]);
      return;
    }
    setActivePlannedHolds((data || []) as ActivePlannedHold[]);
  }, []);

  useEffect(() => {
    if (!isPlanned || !quoteId) {
      setActivePlannedHolds([]);
      return;
    }
    void loadActivePlannedHolds(quoteId);
  }, [isPlanned, quoteId, loadActivePlannedHolds]);

  const loadQuoteEmailStatus = useCallback(async (targetQuoteNumber: string) => {
    // send-email records this quote reference as its attachment_name, not resource_id.
    const { data, error } = await supabase
      .from('email_log')
      .select('created_at')
      .eq('email_type', 'quote')
      .eq('attachment_name', `Quote-${targetQuoteNumber}.pdf`)
      .eq('status', 'sent')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) {
      setLastQuoteEmailAt(null);
      return;
    }
    setLastQuoteEmailAt(data?.[0]?.created_at ?? null);
  }, []);

  useEffect(() => {
    if (!quoteId || !quoteNumber) {
      setLastQuoteEmailAt(null);
      return;
    }
    void loadQuoteEmailStatus(quoteNumber);
  }, [quoteId, quoteNumber, loadQuoteEmailStatus]);

  // RUP compliance check when the customer or the PRODUCT SET changes. Keyed by a
  // stable product-set string (NOT `sections`) so editing quantities/prices/notes
  // does not re-run the check, and the activity log is deduped per
  // (customer, product-set) via lastRupLogKey — matching the NewOrder flow. Without
  // the dedup, every section edit flooded activity_feed with identical
  // rup_compliance_warning rows (Codex 2026-06-13 round-3 finding 2).
  const rupProductKey = sections.flatMap((s) => s.items.map((i) => i.product_id)).filter(Boolean).sort().join(',');
  const lastRupLogKey = useRef('');
  useEffect(() => {
    if (!customerId || !rupProductKey) { setRupWarnings([]); return; }
    let cancelled = false;
    checkRUPCompliance(customerId, rupProductKey.split(',')).then((res) => {
      if (!cancelled) {
        setRupWarnings(res.warnings);
        const logKey = `${customerId}|${rupProductKey}`;
        if (res.warnings.length > 0 && profile?.id && lastRupLogKey.current !== logKey) {
          lastRupLogKey.current = logKey;
          logActivity({ event: 'rup_compliance_warning', description: `RUP products (${res.rupProductNames.join(', ')}) on quote for customer without valid license`, performedBy: profile.id, entityType: 'customer', entityId: customerId, customerId });
        }
      }
    });
    return () => { cancelled = true; };
  }, [customerId, rupProductKey, profile?.id]);

  // Fetch transaction thread data (orders/deliveries/invoices linked to this quote)
  useEffect(() => {
    if (!isEditing || !id) { setThreadOrders([]); return; }
    let cancelled = false;
    (async () => {
      const { data: orders } = await supabase
        .from('orders').select('id, order_number')
        .eq('quote_id', id).order('order_number');
      if (cancelled || !orders?.length) { if (!cancelled) setThreadOrders([]); return; }
      const orderIds = orders.map(o => o.id);
      const [delRes, invRes] = await Promise.all([
        supabase.from('deliveries').select('id, delivery_number, order_id').in('order_id', orderIds),
        supabase.from('invoices').select('id, invoice_number, order_id').in('order_id', orderIds)
          .not('status', 'in', '("voided","cancelled")'),
      ]);
      if (cancelled) return;
      setThreadOrders(orders.map(o => ({
        id: o.id, order_number: o.order_number as string,
        deliveries: (delRes.data || []).filter((d: Record<string, unknown>) => d.order_id === o.id)
          .map((d: Record<string, unknown>) => ({ id: d.id as string, delivery_number: d.delivery_number as string })),
        invoices: (invRes.data || []).filter((i: Record<string, unknown>) => i.order_id === o.id)
          .map((i: Record<string, unknown>) => ({ id: i.id as string, invoice_number: i.invoice_number as string })),
      })));
    })();
    return () => { cancelled = true; };
  }, [isEditing, id]);

  const fetchReferenceData = useCallback(async () => {
    const [custRes, prodRes, convRes, fieldsRes] = await Promise.all([
      supabase.from('customers').select('*').eq('is_active', true).order('farm_name'),
      supabase.from('products').select('*, product_family:product_families(name)').eq('is_active', true).order('product_name'),
      supabase.from('unit_conversions').select('*'),
      supabase.from('fields').select('id, field_name, customer_id, total_acres, measured_acres, override_acres').eq('is_active', true).order('field_name'),
    ]);

    if (custRes.error) {
      Sentry.captureException(custRes.error, { tags: { source: 'fetch', page: 'quote_builder' } });
      toast('error', 'Failed to load customers.');
    }
    if (prodRes.error) {
      Sentry.captureException(prodRes.error, { tags: { source: 'fetch', page: 'quote_builder' } });
      toast('error', 'Failed to load products.');
    }
    if (convRes.error) {
      Sentry.captureException(convRes.error, { tags: { source: 'fetch', page: 'quote_builder' } });
    }

    setCustomers((custRes.data || []) as Customer[]);
    setProducts((prodRes.data || []) as Product[]);
    setUnitConversions((convRes.data || []) as UnitConversion[]);
    setFields((fieldsRes.data || []) as FieldOption[]);
  }, [toast]);

  const generateQuoteNumber = async () => {
    // Use server-side sequence to prevent race conditions
    const { data, error } = await supabase.rpc('generate_quote_number');
    if (error || !data) {
      // Fallback for backward compatibility
      const year = new Date().getFullYear();
      const { count, error: countError } = await supabase
        .from('quotes')
        .select('*', { count: 'exact', head: true })
        .like('quote_number', `Q-${year}-%`);
      if (countError) {
        toast('error', 'Failed to generate quote number. Please try again.');
        return;
      }
      const next = (count || 0) + 1;
      setQuoteNumber(`Q-${year}-${String(next).padStart(4, '0')}`);
    } else {
      setQuoteNumber(assertRpcResult<string>(data, 'generate_quote_number'));
    }
  };

  const clearQuoteRowVersionWithRefreshWarning = useCallback((action: string) => {
    if (quoteRowVersionRef.current !== null) {
      quoteNumericVersionRequiredRef.current = true;
    }
    quoteRowVersionRef.current = null;
    quoteVersionRecoveryRequiredRef.current = true;
    staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
    setStaleSaveOpen(true);
    toast('warning', `The quote was ${action}, but its save-protection version could not be confirmed. Refresh before editing, revising, or converting it.`);
    // No scope in the dep list, and none needed: this opener records the module
    // constant NON_SAVE_RECOVERY, which cannot go stale in a closure. Stamping a
    // scope here is what needed the dependency — and was the wrong thing to stamp.
  }, [toast]);

  const applyDirectQuoteMutationRowVersion = useCallback((
    previousRowVersion: number | null,
    returnedRowVersion: unknown,
    action: string,
  ): boolean => {
    const rowVersionResult = resolveDirectMutationRowVersion(previousRowVersion, returnedRowVersion);
    quoteRowVersionRef.current = rowVersionResult.rowVersion;
    if (rowVersionResult.kind !== 'recovery') {
      if (rowVersionResult.rowVersion !== null) {
        quoteNumericVersionRequiredRef.current = true;
      }
      return true;
    }

    // The direct lifecycle update committed, but a jumped/missing token could
    // belong to another writer. Do not adopt it: preserve local edits and make
    // the next whole-record save fail closed until the operator reloads.
    quoteVersionRecoveryRequiredRef.current = true;
    staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
    setStaleSaveOpen(true);
    toast('warning', `The quote was ${action}, but another edit may have completed at the same time. Your current edits were kept; reload before saving, revising, or converting it.`);
    return false;
    // No scope dependency — see clearQuoteRowVersionWithRefreshWarning above.
  }, [toast]);

  // An RPC response without row_version must never be followed by a blind
  // adoption of whatever a second writer committed after us. Only the one
  // version this mutation can produce is safe to install.
  const refreshQuoteRowVersionAfterMutation = useCallback(async (
    mutatedQuoteId: string,
    previousRowVersion: number | null,
    expectedRowVersion: number | null,
    action: string,
  ): Promise<boolean> => {
    const { data, error } = await supabase
      .from('quotes')
      .select('*')
      .eq('id', mutatedQuoteId)
      .maybeSingle();
    const nextRowVersion = readRowVersion((data as { row_version?: unknown } | null)?.row_version);

    if (!error
      && data
      && previousRowVersion === null
      && expectedRowVersion === null
      && nextRowVersion === null
      && !quoteNumericVersionRequiredRef.current) {
      quoteRowVersionRef.current = null;
      return true;
    }

    if (error || !data || previousRowVersion === null || expectedRowVersion === null || nextRowVersion !== expectedRowVersion) {
      if (error) {
        Sentry.captureException(error, { tags: { source: 'read', action: 'refresh_quote_row_version_after_mutation' } });
      }
      clearQuoteRowVersionWithRefreshWarning(action);
      return false;
    }

    quoteRowVersionRef.current = nextRowVersion;
    quoteNumericVersionRequiredRef.current = true;
    return true;
  }, [clearQuoteRowVersionWithRefreshWarning]);

  const installAuthoritativeQuoteRowVersion = useCallback((authoritativeRowVersion: unknown, action: string): boolean => {
    const rowVersionResult = resolveAuthoritativeSaveRowVersion(
      quoteRowVersionRef.current,
      authoritativeRowVersion,
    );
    quoteRowVersionRef.current = rowVersionResult.rowVersion;
    if (rowVersionResult.kind === 'recovery') {
      clearQuoteRowVersionWithRefreshWarning(action);
      return false;
    }
    if (rowVersionResult.rowVersion !== null) {
      quoteNumericVersionRequiredRef.current = true;
    }
    return true;
  }, [clearQuoteRowVersionWithRefreshWarning]);

  const fetchQuote = useCallback(async (quoteId: string, requireStableRowVersion = false): Promise<boolean> => {
    // Refuse at the door, BEFORE taking a serial. A load for a quote the operator
    // has already left is doomed either way — it would reject itself below — but
    // taking a number on the way past is NOT free. The serial is a shared resource:
    // burning one supersedes the legitimate load of the quote now on screen, which
    // then installs nothing and strands the page behind a skeleton that never
    // clears, and it makes an unrelated in-flight SAVE of that quote look like it
    // belongs to an editing session that ended.
    //
    // Reachable through the delayed post-conversion `fetchQuote(savedId)` below and
    // through `reloadAfterStaleSave`, both of which run from closures that survive a
    // navigation. Same discipline as CustomerDetail's tab loader.
    if (routeQuoteIdRef.current !== quoteId) return false;
    const loadSerial = ++quoteLoadSerialRef.current;
    // Two independent halves; neither subsumes the other, and each has its own
    // regression test. `supersededByNewerLoad` orders CALLS, so reopening the
    // SAME quote twice still resolves to the newer call. `routeLeftThisQuote`
    // binds this call to a RECORD, so a load started from a stale closure
    // cannot install merely because it holds the newest serial.
    //
    // Re-checked after every await. A load that must not install returns false
    // without touching form state, toasts, navigation or `loading` — whichever
    // load is current owns all of those now.
    const supersededByNewerLoad = () => quoteLoadSerialRef.current !== loadSerial;
    const routeLeftThisQuote = () => routeQuoteIdRef.current !== quoteId;
    const mustNotInstall = () => supersededByNewerLoad() || routeLeftThisQuote();

    const quoteRes = await supabase
      .from('quotes')
      .select('*, customer:customers(*)')
      .eq('id', quoteId)
      .maybeSingle();
    if (mustNotInstall()) return false;

    if (quoteRes.error || !quoteRes.data) {
      if (quoteRes.error) {
        Sentry.captureException(quoteRes.error, { tags: { source: 'read', action: 'load_quote_snapshot' } });
      }
      if (!quoteRes.error) {
        toast('error', 'Quote not found');
        navigate('/quotes');
      } else {
        toast('error', 'Could not load the complete quote. Your current edits were kept; try Reload again or refresh the page.');
      }
      setLoading(false);
      return false;
    }

    const initialRowVersion = readRowVersion((quoteRes.data as Quote & { row_version?: unknown }).row_version);
    const [sectionsRes, itemsRes] = await Promise.all([
      supabase.from('quote_sections').select('*').eq('quote_id', quoteId).order('sort_order'),
      supabase
        .from('quote_items')
        .select('*, product:products(*, product_family:product_families(name))')
        .eq('quote_id', quoteId)
        .order('sort_order'),
    ]);
    if (mustNotInstall()) return false;

    // Build and validate the complete editable snapshot before changing any
    // form state. A failed Reload must never replace an operator's local work
    // with an empty quote, sections, or items list.
    if (sectionsRes.error || itemsRes.error) {
      if (sectionsRes.error) Sentry.captureException(sectionsRes.error, { tags: { source: 'read', action: 'load_quote_sections_snapshot' } });
      if (itemsRes.error) Sentry.captureException(itemsRes.error, { tags: { source: 'read', action: 'load_quote_items_snapshot' } });
      toast('error', 'Could not load the complete quote. Your current edits were kept; try Reload again or refresh the page.');
      setLoading(false);
      return false;
    }

    const { data: finalHeader, error: finalHeaderError } = await supabase
      .from('quotes')
      .select('*')
      .eq('id', quoteId)
      .maybeSingle();
    if (mustNotInstall()) return false;

    const finalRowVersion = readRowVersion((finalHeader as { row_version?: unknown } | null)?.row_version);
    const stableVersion = initialRowVersion === finalRowVersion
      && (initialRowVersion !== null || !requireStableRowVersion);
    if (finalHeaderError || !finalHeader || !stableVersion) {
      if (finalHeaderError) Sentry.captureException(finalHeaderError, { tags: { source: 'read', action: 'confirm_quote_snapshot_version' } });
      toast('error', 'Could not confirm a stable saved quote. Your current edits were kept; try Reload again or refresh the page.');
      setLoading(false);
      return false;
    }

    const q = quoteRes.data as Quote;
    const dbSections = (sectionsRes.data as QuoteSection[]) || [];
    const dbItems = (itemsRes.data as QuoteItem[]) || [];

    const localSections: LocalSection[] = dbSections.map((s) => ({
      _key: nextKey(),
      id: s.id,
      section_name: s.section_name,
      sort_order: s.sort_order,
      section_notes: s.section_notes,
      section_header_notes: s.section_header_notes,
      needed_by_date: s.needed_by_date || null,
      field_id: s.field_id || null,
      items: dbItems
        .filter((item) => item.section_id === s.id)
        .map((item) => {
          return {
            _key: nextKey(),
            id: item.id,
            product_id: item.product_id,
            sort_order: item.sort_order,
            notes: item.notes,
            price_per_unit: item.price_per_unit,
            price_override: item.price_override ?? null,
            current_cost: item.current_cost,
            suggested_rate: item.suggested_rate,
            actual_rate: item.actual_rate,
            rate_unit: item.rate_unit,
            oz_per_acre: item.oz_per_acre,
            price_per_acre: item.price_per_acre,
            acres: item.acres,
            total_units_needed: item.total_units_needed,
            unit_size: item.unit_size,
            profit: item.profit,
            total_price: item.total_price,
            net_margin: item.net_margin,
            product: item.product,
            calc_mode: (item.calc_mode as CalcMode) || 'rate_acres',
            price_unit: item.price_unit || null,
          };
        }),
    }));

    // The complete snapshot is now known-good. Install its related form state
    // together so React never observes an error-path partial reload.
    suppressDirtyUntilReloadSettlesRef.current = true;
    quoteRowVersionRef.current = finalRowVersion;
    quoteNumericVersionRequiredRef.current = finalRowVersion !== null;
    quoteVersionRecoveryRequiredRef.current = false;
    // This IS the authoritative reload that a rejected save key was waiting for:
    // the operator is looking at what the database actually holds for this quote,
    // so the receipt has served its purpose and the key may finally rotate. Same
    // condition `reloadAfterStaleSave` uses, reached through the ordinary reopen
    // instead of the recovery dialog — which the moved-session path cannot show.
    // Scoped to the quote the conflict belongs to: reloading a DIFFERENT quote
    // resolves nothing about this one.
    // Retired BY NAME rather than through the current render's scope.
    //
    // The demonstrated reason is identity, not correctness of the target: the scoped
    // `resetKey` changes whenever the scope changes, and #618 made it a dependency of
    // `fetchQuote`. Since the scope is derived from `quoteId` STATE, which lags the
    // route until `setQuoteId` below, that dependency re-created `fetchQuote` on
    // every navigation and re-ran the load effect — loading each quote twice, which
    // is what broke #618's own A -> B -> A load-ordering tests when the two changes
    // met. `resetKeyFor` is memoized on [operation, userId] alone and does not move.
    //
    // Naming the quote is also the honest form of the call: this line means "retire
    // the key belonging to the quote being reopened", and `resetKey()` only says that
    // while the rendered scope happens to already be `q.id`. It does today — a
    // mutation of this line back to `resetKey()` still passes the suite, so the
    // wrong-target failure is NOT a bug observed here and is not claimed as one.
    // `resetKeyFor(q.id)` removes the dependence on that coincidence.
    if (payloadConflictQuoteIdRef.current === q.id) {
      payloadConflictQuoteIdRef.current = null;
      resetSaveQuoteKeyFor(q.id);
    }
    setQuoteId(q.id);
    setQuoteNumber(q.quote_number);
    setCustomerId(q.customer_id);
    setTier(q.tier);
    setValidDays(q.valid_days);
    setHeaderNotes(q.header_notes || '');
    setFooterNotes(q.footer_notes || '');
    setStatus(q.status);
    setIsPlanned(q.is_planned || false);
    setWasPlanned(q.is_planned || false);
    setCommissionSplit(q.commission_split ?? { splits: [] });
    loadedCommissionSplitRef.current = q.commission_split ?? null;
    commissionSplitTouchedRef.current = false;
    setQuoteCreatedAt(q.created_at || null);
    setSections(localSections.length > 0 ? localSections : [makeEmptySection(1)]);

    // U13 (#111): which sections already have a job scheduled from them, so the
    // badge renders and the "Schedule Job" button hides on load (not just after
    // a fresh schedule this session).
    const { data: sectionJobsData, error: sectionJobsError } = await supabase
      .from('jobs')
      .select('id, job_number, status, quote_section_id')
      .eq('quote_id', quoteId)
      .is('deleted_at', null)
      .not('quote_section_id', 'is', null);
    if (mustNotInstall()) return false;

    if (sectionJobsError) {
      Sentry.captureException(sectionJobsError, { tags: { source: 'read', action: 'load_quote_section_jobs' } });
      toast('warning', 'Quote loaded, but scheduled-job badges could not be refreshed.');
    } else {
      const sectionJobMap: Record<string, { id: string; job_number: string; status: JobStatus }> = {};
      ((sectionJobsData || []) as { id: string; job_number: string; status: JobStatus; quote_section_id: string }[])
        .forEach((j) => { sectionJobMap[j.quote_section_id] = { id: j.id, job_number: j.job_number, status: j.status }; });
      setSectionJobs(sectionJobMap);
    }

    // Fetch version history for this quote
    const { data: versionsData, error: versionsError } = await supabase
      .from('quote_versions')
      .select('*')
      .eq('quote_id', quoteId)
      .order('version_number', { ascending: false });
    if (mustNotInstall()) return false;

    if (versionsError) {
      Sentry.captureException(versionsError, { tags: { source: 'read', action: 'load_quote_versions' } });
      toast('warning', 'Quote loaded, but version history could not be refreshed.');
    } else {
      setQuoteVersions((versionsData || []) as QuoteVersion[]);
    }

    setLoading(false);
    const loadGeneration = ++initialLoadGenerationRef.current;
    setInstalledLoadGeneration(loadGeneration);
    return true;
  }, [toast, navigate, resetSaveQuoteKeyFor]);

  const reloadAfterStaleSave = useCallback(async () => {
    if (!quoteId) return false;
    suppressDirtyUntilReloadSettlesRef.current = true;
    let installedSnapshot = false;
    try {
      // Commission-split conflicts already exist in production, before the
      // row-version migration. Allow the legacy tokenless double-read reload
      // during that rollout window, but stay strict once a numeric token has
      // been loaded for this quote.
      installedSnapshot = await fetchQuote(quoteId, quoteNumericVersionRequiredRef.current);
      if (installedSnapshot) {
        // The rejected key may represent a committed save whose response was
        // lost. Rotate it only after a complete authoritative reload succeeds —
        // and only when the reload that just succeeded is for the SAME quote that
        // produced the conflict. If the operator navigated away with the dialog
        // open, releasing here would retire the wrong scope's key and strand the
        // rejected one; leaving it retained is the safe direction, because a
        // retained key can still replay.
        //
        // An earlier revision retired it in that case, reasoning that a
        // payload-rejected key can only ever be rejected again. That is wrong, and it
        // was a duplicate-write hazard: the key rejects the CHANGED payload, but
        // replaying the ORIGINAL one returns the server's cached receipt. On a create
        // that receipt carries the id of a row that may already have committed, and it
        // is the only deterministic way to learn the create's outcome. Deleting it
        // lets a later retry mint a fresh key and insert the record a second time.
        //
        // So the cost of retaining is one unearned conflict dialog when the operator
        // returns to that quote, which then self-heals on its own reload. The cost of
        // retiring is a possible duplicate quote. Retaining is the safe direction.
        // Release ONLY for a reload of the same quote whose save_quote call produced
        // this dialog. A different quote's scope must keep its key, and so must
        // NON_SAVE_RECOVERY: ten of this page's eleven openers are lifecycle actions
        // with no rejected save key of their own, and releasing on their reload would
        // retire a save_quote receipt whose own reply was never validated.
        if (staleSaveConflictScopeRef.current === saveQuoteIntentScope) {
          resetSaveQuoteIdempotencyKey();
          staleSaveConflictScopeRef.current = null;
        }
        if (resetCreateVersionAfterReloadRef.current) {
          resetCreateVersionAttempt();
          resetCreateVersionAfterReloadRef.current = false;
        }
        if (resetRestoreVersionAfterReloadRef.current) {
          resetRestoreVersionAttempt();
          resetRestoreVersionAfterReloadRef.current = false;
        }
        if (resetConvertAfterReloadRef.current) {
          convertQuoteIdem.resetKey();
          resetConvertAfterReloadRef.current = false;
        }
        setIsDirty(false);
        setStaleSaveOpen(false);
      }
    } finally {
      let released = false;
      const releaseDirtySuppression = () => {
        if (released) return;
        released = true;
        suppressDirtyUntilReloadSettlesRef.current = false;
        if (installedSnapshot) setIsDirty(false);
      };
      const fallback = window.setTimeout(releaseDirtySuppression, 250);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        releaseDirtySuppression();
      }));
    }
    return installedSnapshot;
  }, [
    convertQuoteIdem,
    fetchQuote,
    quoteId,
    resetCreateVersionAttempt,
    resetRestoreVersionAttempt,
    resetSaveQuoteIdempotencyKey,
    // Required, not cosmetic: without it this callback compares the conflict's
    // recorded scope against a STALE one, which is the exact confusion the check
    // exists to prevent.
    saveQuoteIntentScope,
  ]);

  useEffect(() => {
    fetchReferenceData();
    // Fetch PDF templates (non-critical, inline to avoid TDZ issue with useCallback ordering)
    supabase.from('quote_pdf_templates').select('*').order('is_default', { ascending: false })
      .then(({ data }) => {
        if (data) {
          setPdfTemplates(data as QuotePdfTemplate[]);
          const defaultTemplate = (data as QuotePdfTemplate[]).find((t) => t.is_default);
          if (defaultTemplate) setSelectedTemplateId(defaultTemplate.id);
        }
      });
    // Fetch quote templates for new quotes
    if (!id) {
      supabase.from('quote_templates').select('*').eq('is_active', true).order('template_name')
        .then(({ data }) => { if (data) setQuoteTemplates(data as QuoteTemplate[]); });
    }
    if (isEditing && id) {
      // This effect also runs on a route change between two saved quotes, where
      // the previous quote's form is still mounted and filled in. Present the
      // skeleton until THIS id's snapshot installs, so the operator is never
      // shown quote A's numbers under quote B's address.
      setLoading(true);
      fetchQuote(id);
    } else {
      generateQuoteNumber().then(() => {
        // Allow a tick for state to settle before tracking changes
        setTimeout(() => { initialLoadDone.current = true; }, 0);
      }).catch(() => { /* non-critical: quote number defaults handled inside generateQuoteNumber */ });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fetchQuote, fetchReferenceData, isEditing]);

  // Auto-set customer from URL query param (e.g., /quotes/new?customer_id=xxx)
  useEffect(() => {
    if (!id && customers.length > 0) {
      const params = new URLSearchParams(location.search);
      const presetCustomerId = params.get('customer_id');
      if (presetCustomerId && !customerId) {
        const cust = customers.find((c) => c.id === presetCustomerId);
        if (cust) {
          setCustomerId(presetCustomerId);
          setTier(cust.assigned_tier);
          if (cust.default_commission_split) {
            setCommissionSplit(cust.default_commission_split);
            commissionSplitTouchedRef.current = true;
          }
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, customers.length, location.search]);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId]
  );

  const handleCustomerChange = (cId: string) => {
    setCustomerId(cId);
    const cust = customers.find((c) => c.id === cId);
    if (cust) {
      setTier(cust.assigned_tier);
      if (cust.default_commission_split) {
        setCommissionSplit(cust.default_commission_split);
        commissionSplitTouchedRef.current = true;
      }
      recalcAllForTier(cust.assigned_tier);
    }
  };

  const getConversionFactor = useCallback(
    (unit: string | null): number => {
      if (!unit) return 1;
      const conv = unitConversions.find(
        (c) => c.unit.toLowerCase() === unit.toLowerCase()
      );
      return conv ? conv.factor_oz : 1;
    },
    [unitConversions]
  );

  const getTierPrice = useCallback(
    (product: Product, tierNum: number): number => {
      // Always fall back to tier1_price (never $0) when a tier price is missing
      const t1 = product.tier1_price || 0;
      if (tierNum === 1) return t1;
      if (tierNum === 2) return product.tier2_price || t1;
      return product.tier3_price || t1;
    },
    []
  );

  const recalcItem = useCallback(
    (item: LocalItem, tierNum: number): LocalItem => {
      const product = item.product || products.find((p) => p.id === item.product_id);
      if (!product) return item;

      const tierPrice = getTierPrice(product, tierNum);
      // Use override price if set, otherwise fall back to tier price
      const pricePerUnit = item.price_override != null ? item.price_override : tierPrice;
      // Fall back to unit_size if inventory_unit is not set on the product
      const inventoryUnitFactorOz = getConversionFactor(product.inventory_unit || product.unit_size);

      if (item.calc_mode === 'units_direct') {
        // User entered total_units_needed directly — skip rate×acres computation
        const totalInventoryUnits = item.total_units_needed || 0;
        const totalPrice = pricePerUnit * totalInventoryUnits;
        const profit = (pricePerUnit - (product.current_cost || 0)) * totalInventoryUnits;
        const netMargin = totalPrice > 0 ? profit / totalPrice : 0;

        // Back-calculate oz/acre and $/acre if acres provided
        const acres = item.acres || 0;
        let ozPerAcre: number | null = item.oz_per_acre;
        let pricePerAcre: number | null = item.price_per_acre;
        if (acres > 0 && inventoryUnitFactorOz > 0) {
          const totalOz = totalInventoryUnits * inventoryUnitFactorOz;
          ozPerAcre = Math.round((totalOz / acres) * 100) / 100;
          pricePerAcre = Math.round((totalPrice / acres) * 100) / 100;
        }

        return {
          ...item,
          price_per_unit: pricePerUnit,
          current_cost: product.current_cost || 0,
          oz_per_acre: ozPerAcre,
          price_per_acre: pricePerAcre,
          total_units_needed: Math.round(totalInventoryUnits * 100) / 100,
          total_price: Math.round(totalPrice * 100) / 100,
          profit: Math.round(profit * 100) / 100,
          net_margin: Math.round(netMargin * 100 * 100) / 100,
        };
      }

      // Default: rate_acres mode
      const actualRate = item.actual_rate || 0;
      const acres = item.acres || 0;

      const rateUnitFactorOz = getConversionFactor(item.rate_unit);
      const rateInOz = actualRate * rateUnitFactorOz;
      const ozPerAcre = rateInOz;

      const totalInventoryUnits = inventoryUnitFactorOz > 0
        ? (acres * rateInOz) / inventoryUnitFactorOz
        : 0;

      const pricePerAcre = inventoryUnitFactorOz > 0
        ? pricePerUnit * (rateInOz / inventoryUnitFactorOz)
        : 0;
      const totalPrice = pricePerUnit * totalInventoryUnits;
      const profit = (pricePerUnit - (product.current_cost || 0)) * totalInventoryUnits;
      const netMargin = totalPrice > 0 ? profit / totalPrice : 0;

      return {
        ...item,
        price_per_unit: pricePerUnit,
        current_cost: product.current_cost || 0,
        oz_per_acre: Math.round(ozPerAcre * 100) / 100,
        price_per_acre: Math.round(pricePerAcre * 100) / 100,
        total_units_needed: Math.round(totalInventoryUnits * 100) / 100,
        total_price: Math.round(totalPrice * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        net_margin: Math.round(netMargin * 100 * 100) / 100,
      };
    },
    [products, getTierPrice, getConversionFactor]
  );

  const recalcAllForTier = (tierNum: number) => {
    setSections((prev) =>
      prev.map((sec) => ({
        ...sec,
        items: sec.items.map((item) => recalcItem({ ...item, price_override: null }, tierNum)),
      }))
    );
  };

  const updateItem = (
    sectionKey: string,
    itemKey: string,
    updates: Partial<LocalItem>
  ) => {
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        return {
          ...sec,
          items: sec.items.map((item) => {
            if (item._key !== itemKey) return item;
            const merged = { ...item, ...updates };
            return recalcItem(merged, tier);
          }),
        };
      })
    );
  };

  const closeProductPicker = () => {
    if (productSearchOpen) {
      const { sectionKey, itemKey } = productSearchOpen;
      setSections((prev) =>
        prev.map((section) => {
          if (section._key !== sectionKey) return section;
          const targetItem = section.items.find((item) => item._key === itemKey);
          if (!targetItem || targetItem.product_id || hasUserEnteredItemValues(targetItem)) return section;

          return {
            ...section,
            items: section.items
              .filter((item) => item._key !== itemKey)
              .map((item, index) => ({ ...item, sort_order: index + 1 })),
          };
        })
      );
    }
    setProductSearchOpen(null);
    setProductQuery('');
    setKeepProductPickerOpen(false);
  };

  const assignProduct = (sectionKey: string, itemKey: string, product: Product) => {
    const pricePerUnit = getTierPrice(product, tier);
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        return {
          ...sec,
          items: sec.items.map((item) => {
            if (item._key !== itemKey) return item;
            const updated: LocalItem = {
              ...item,
              product_id: product.id,
              product,
              notes: preferredQuoteNotes(product),
              price_per_unit: pricePerUnit,
              price_override: null,
              current_cost: product.current_cost || 0,
              suggested_rate: product.suggested_rate || null,
              actual_rate: product.rate_per_acre ?? item.actual_rate ?? null,
              rate_unit: product.rate_unit || null,
              unit_size: product.inventory_unit || product.unit_size || null,
              price_unit: product.inventory_unit || null,
            };
            return recalcItem(updated, tier);
          }),
        };
      })
    );
    if (keepProductPickerOpen) {
      const nextItemKey = addItem(sectionKey);
      setProductSearchOpen({ sectionKey, itemKey: nextItemKey });
      setProductQuery('');
      return;
    }
    closeProductPicker();
  };

  const addSection = () => {
    setSections((prev) => [...prev, makeEmptySection(prev.length + 1)]);
  };

  const removeSection = (key: string) => {
    setSections((prev) => {
      const filtered = prev.filter((s) => s._key !== key);
      return filtered.map((s, i) => ({ ...s, sort_order: i + 1 }));
    });
  };

  const updateSectionName = (key: string, name: string) => {
    setSections((prev) =>
      prev.map((s) => (s._key === key ? { ...s, section_name: name } : s))
    );
  };

  const updateSectionField = (key: string, field: keyof LocalSection, value: string | null) => {
    setSections((prev) =>
      prev.map((s) => (s._key === key ? { ...s, [field]: value } : s))
    );
  };

  const handleSectionFieldChange = (sectionKey: string, fieldId: string | null) => {
    updateSectionField(sectionKey, 'field_id', fieldId);
    const field = fields.find((candidate) => candidate.id === fieldId);
    // Documented field-acre precedence: override → measured → legacy total.
    const effectiveAcres = field?.override_acres ?? field?.measured_acres ?? field?.total_acres;
    if (effectiveAcres == null) return;

    setSections((prev) =>
      prev.map((section) => {
        if (section._key !== sectionKey) return section;
        return {
          ...section,
          items: section.items.map((item) => {
            if ((item.acres ?? 0) !== 0) return item;
            return recalcItem({
              ...item,
              acres: effectiveAcres,
              calc_mode: item.calc_mode === 'units_direct' ? 'units_direct' : 'rate_acres',
            }, tier);
          }),
        };
      })
    );
  };

  function addItem(sectionKey: string): string {
    const newItem = makeEmptyItem();
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        newItem.sort_order = sec.items.length + 1;
        return { ...sec, items: [...sec.items, newItem] };
      })
    );
    return newItem._key;
  }

  const removeItem = (sectionKey: string, itemKey: string) => {
    setSections((prev) =>
      prev.map((sec) => {
        if (sec._key !== sectionKey) return sec;
        const filtered = sec.items.filter((i) => i._key !== itemKey);
        return {
          ...sec,
          items: filtered.map((i, idx) => ({ ...i, sort_order: idx + 1 })),
        };
      })
    );
  };

  const toggleSectionCollapse = (key: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const totals = useMemo(() => {
    let totalPrice = 0;
    let totalCost = 0;
    let totalProfit = 0;
    sections.forEach((sec) => {
      sec.items.forEach((item) => {
        totalPrice += item.total_price;
        totalCost += item.current_cost * (item.total_units_needed || 0);
        totalProfit += item.profit;
      });
    });
    const totalMarginPct = totalPrice > 0 ? (totalProfit / totalPrice) * 100 : 0;
    return {
      totalPrice: Math.round(totalPrice * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      totalProfit: Math.round(totalProfit * 100) / 100,
      totalMarginPct: Math.round(totalMarginPct * 100) / 100,
    };
  }, [sections]);

  const saveQuote = async (newStatus?: QuoteStatus): Promise<string | null> => {
    // Fail closed when the loaded quote is not the quote the URL names. The
    // skeleton normally hides the form for the whole transition, but a load that
    // ERRORS clears `loading` while deliberately keeping the previous quote's
    // edits on screen — leaving a live Save button over the record the operator
    // navigated away from. `p_quote_id` below is this same `quoteId`, so
    // refusing before any RPC also means no idempotency key is ever minted
    // against the wrong quote.
    if (isEditing && quoteId !== id) {
      toast('error', 'This quote has not finished loading. Refresh the page before saving so your changes go to the right quote.');
      return null;
    }
    if (!customerId) {
      toast('error', 'Please select a customer');
      return null;
    }
    if (!profile) return null;

    // Validation: warn about empty sections
    const emptySections = sections.filter((sec) => sec.items.length === 0 || sec.items.every((i) => !i.product_id));
    if (emptySections.length > 0) {
      toast('error', `Section "${emptySections[0].section_name}" has no products. Add items or remove the section.`);
      return null;
    }

    // Validation: warn about items with zero quantity or price
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id) continue;
        // In units_direct mode, only total_units_needed is required
        if (item.calc_mode === 'units_direct') {
          if ((item.total_units_needed ?? 0) <= 0) {
            const prod = item.product || products.find((p) => p.id === item.product_id);
            toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has no units needed set.`);
            return null;
          }
          continue;
        }
        // rate_acres mode: both rate and acres are required
        if ((item.acres ?? 0) === 0 && (item.actual_rate ?? 0) === 0) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has no rate or acres set.`);
          return null;
        }
      }
    }

    // S2-1: Validate rate_unit is set for all items with a rate (rate_acres mode only)
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id || item.calc_mode === 'units_direct') continue;
        if ((item.actual_rate ?? 0) > 0 && !item.rate_unit) {
          toast('error', 'Please select a rate unit for all items with a rate');
          return null;
        }
      }
    }

    // S2-2: Validate rate and acres are both set when either is provided (rate_acres mode only)
    for (const sec of sections) {
      for (const item of sec.items) {
        if (!item.product_id || item.calc_mode === 'units_direct') continue;
        const hasRate = (item.actual_rate ?? 0) > 0;
        const hasAcres = (item.acres ?? 0) > 0;
        if (hasRate && !hasAcres) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has a rate but no acres. Both are required.`);
          return null;
        }
        if (hasAcres && !hasRate) {
          const prod = item.product || products.find((p) => p.id === item.product_id);
          toast('error', `"${prod?.product_name || 'An item'}" in "${sec.section_name}" has acres but no rate. Both are required.`);
          return null;
        }
      }
    }

    const commissionSplitError = validateCommissionSplits(commissionSplit.splits);
    if (commissionSplitError) {
      toast('error', commissionSplitError);
      return null;
    }

    // Minted before the payload so the frozen clock can be bound to it. `getKey`
    // returns the SAME key until it is retired, so this is a read, not a new attempt.
    const idemKey = getSaveQuoteIdempotencyKey();
    const previousAttempt = saveQuoteAttemptClockRef.current.get(saveQuoteIntentScope);
    let saveAttemptAtMs: number;
    if (previousAttempt && previousAttempt.key === idemKey) {
      saveAttemptAtMs = previousAttempt.atMs;
    } else {
      saveAttemptAtMs = Date.now();
      saveQuoteAttemptClockRef.current.set(saveQuoteIntentScope, { key: idemKey, atMs: saveAttemptAtMs });
    }

    const quotePayload = {
      quote_number: quoteNumber,
      customer_id: customerId,
      created_by: profile.id,
      tier,
      status: newStatus || status,
      ...buildCommissionSplitPatch({
        isUpdate: Boolean(quoteId && isEditing),
        touched: commissionSplitTouchedRef.current,
        key: 'commission_split',
        value: { splits: commissionSplit.splits },
        loaded: loadedCommissionSplitRef.current,
      }),
      ...buildRowVersionPatch(Boolean(quoteId && isEditing), quoteRowVersionRef.current),
      total_price: totals.totalPrice,
      total_cost: totals.totalCost,
      total_profit: totals.totalProfit,
      total_margin_pct: totals.totalMarginPct,
      valid_days: validDays,
      expires_at: new Date(
        saveAttemptAtMs + validDays * 24 * 60 * 60 * 1000
      ).toISOString(),
      header_notes: headerNotes || null,
      footer_notes: footerNotes || null,
      is_planned: isPlanned,
      ...(newStatus === 'sent' ? { sent_at: new Date(saveAttemptAtMs).toISOString() } : {}),
    };

    // Build sections JSON for the atomic RPC
    const sectionsPayload = sections.map((sec) => ({
      section_name: sec.section_name,
      sort_order: sec.sort_order,
      section_notes: sec.section_notes || null,
      section_header_notes: sec.section_header_notes || null,
      needed_by_date: sec.needed_by_date || null,
      field_id: sec.field_id || null,
      items: sec.items
        .filter((item) => item.product_id)
        .map((item) => ({
          product_id: item.product_id,
          sort_order: item.sort_order,
          notes: item.notes || null,
          price_per_unit: item.price_per_unit,
          price_override: item.price_override ?? null,
          current_cost: item.current_cost,
          suggested_rate: item.suggested_rate,
          actual_rate: item.actual_rate,
          rate_unit: item.rate_unit,
          oz_per_acre: item.oz_per_acre,
          price_per_acre: item.price_per_acre,
          acres: item.acres,
          total_units_needed: item.total_units_needed,
          unit_size: item.unit_size,
          profit: item.profit,
          total_price: item.total_price,
          net_margin: item.net_margin,
          calc_mode: item.calc_mode || 'rate_acres',
          price_unit: item.price_unit || null,
        })),
    }));

    try {
      // Which record, and which editing session of it, this request belongs to —
      // captured BEFORE it is sent. The entry check at the top of this function
      // cannot stand in for either: that ran before the request existed, and
      // everything installed below is written AFTER the reply lands.
      // `runWithBelowCostApproval` can also park this await on an operator
      // decision, which widens the window from a round trip to however long that
      // dialog stays open.
      //
      // Two operands, and each is load-bearing on its own.
      //
      // The route id is NOT unique over time. Leaving quote A for B and returning
      // to A restores it, so a route-only check would accept this reply into a
      // DIFFERENT editing session of the same quote: the callers would clear the
      // dirty flag over edits made after the return, which were never part of this
      // request, and report them saved. The load serial is what separates those
      // sessions, because returning to A re-runs `fetchQuote` and mints a new one.
      //
      // The serial alone is not enough either, for the reason documented at its
      // declaration: `fetchQuote` is also called from stale closures, and such a
      // call mints the NEWEST serial for a record the operator has already left.
      const routeAtSend = routeQuoteIdRef.current;
      const loadAtSend = quoteLoadSerialRef.current;
      const editingSessionChanged = () =>
        routeQuoteIdRef.current !== routeAtSend || quoteLoadSerialRef.current !== loadAtSend;
      const quoteNumberAtSend = quoteNumber;
      // The record this request actually targets — component state, not the route.
      // Null on a create, which has no record to reopen.
      const quoteIdAtSend = (quoteId && isEditing) ? quoteId : null;
      const { data, error } = await runWithBelowCostApproval((reason) => {
        // `reason` is non-null ONLY on the post-approval retry, so this never
        // touches the first send.
        //
        // The below-cost dialog parks that first send on an operator decision,
        // and it is a GLOBAL dialog that names the product and nothing else —
        // never which quote is being approved. If the operator moved to another
        // quote (or reloaded this one) while it was open, the approval they just
        // gave was given while looking at a different record, so it may not be
        // spent on this one. Refuse the retry rather than send it.
        //
        // Refusing HERE, before the request exists, is what makes this safe to
        // report plainly: the first attempt was rejected by PostgreSQL, which
        // rolls back, and the retry is never sent — so unlike the lost-reply
        // case below, the outcome is known and the message may say so.
        if (reason !== null && editingSessionChanged()) {
          toast('error', `Quote ${quoteNumberAtSend || 'you were editing'} was not saved. The below-cost approval finished after you left that quote, so it was not applied — reopen the quote and save again.`);
          throw new BelowCostApprovalHandledError();
        }
        return supabase.rpc('save_quote', withBelowCostReason('save_quote', {
          p_quote_id: quoteIdAtSend as string,
          p_quote_payload: quotePayload as Json,
          p_sections: sectionsPayload,
          p_performed_by: profile.id,
          p_idempotency_key: idemKey,
        }, reason));
      });

      // The editing session this save belonged to is gone. Quote A's failure is
      // not quote B's, so neither the stale-write recovery dialog nor a bare error
      // toast may land here. It is not swallowed either: the operator left
      // believing this saved. Name the quote, because what they are looking at is
      // a different one — or a freshly reloaded copy of the same one — and an
      // unqualified failure would read as belonging to it.
      //
      // Latching `quoteVersionRecoveryRequiredRef` here would be actively wrong on
      // the return-to-A path: it would strand a freshly loaded quote behind a
      // "reload before saving" gate it has already satisfied.
      //
      // Deliberately does NOT touch the idempotency key. The outcome here is
      // genuinely unknown, so the key must survive for the retry (F1) exactly as it
      // does on the in-route error paths below.
      //
      // And because it is unknown, the message must not claim a rollback. A reply
      // lost in transit AFTER PostgreSQL committed arrives through this same
      // `error` branch, so "your changes were not stored" would be a guess stated
      // as fact — and the operator is not even looking at this quote to check. Say
      // what is true (unconfirmed) and what to do about it. The retained key is
      // what makes the retry safe if it did commit.
      if (error && editingSessionChanged()) {
        // A payload conflict is not merely "unconfirmed" — the server has bound
        // this key to a DIFFERENT payload, so it can never accept the current one
        // again. The in-route branch below recovers through the reload dialog,
        // which rotates the key; that dialog cannot be shown here, because it
        // belongs to a quote the operator has left. Remember which quote is
        // waiting for that reload instead. Without this the key stays poisoned for
        // the life of the component and every later save — of any quote, since the
        // key is scoped by operation and user rather than by record — repeats the
        // same conflict.
        if (hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT) && quoteIdAtSend) {
          payloadConflictQuoteIdRef.current = quoteIdAtSend;
        }
        toast('error', `Quote ${quoteNumberAtSend || 'you were editing'} could not be confirmed as saved. Reopen it to check, and save again if your changes are missing.`);
        return null;
      }

      if (error) {
        if (hasRpcCode(error, RpcErrorCodes.QUOTE_STALE_WRITE)
          || hasRpcCode(error, RpcErrorCodes.COMMISSION_SPLIT_CONFLICT)
          || hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
          quoteVersionRecoveryRequiredRef.current = true;
          // The ONE opener that leaves a rejected save_quote key outstanding, so the
          // ONLY one allowed to record a scope. Bind the dialog to the quote that
          // produced it, so the recovery cannot release a different quote's key if
          // the route changes while it is open.
          staleSaveConflictScopeRef.current = saveQuoteIntentScope;
          setStaleSaveOpen(true);
          return null;
        }
        toast('error', error.message || 'Failed to save quote');
        return null;
      }

      const result = assertRpcResult<{ quote_id: string; commission_split?: CommissionSplit | null; row_version?: unknown }>(data, 'save_quote');
      // A save_quote that answers with an EMPTY payload and no error is ambiguous —
      // the row may already be committed — so retiring the key first would send the
      // user's retry under a fresh key the server cannot replay, writing the quote
      // twice. `assertRpcResult` does NOT catch that: it rejects only a MISSING
      // reply, and `{}` passes through it untouched. So the receipt has to be tested
      // here, before the key is retired. The old `|| quoteId` fallback made this
      // worse than a missed check — on an edit route it manufactured a plausible id
      // out of the URL, so an unverified save reported itself as a confirmed one.
      if (!hasReceiptId(result, 'quote_id')) {
        // The key is retained either way — this reply proves nothing about what
        // committed. Two things still have to be right about how we SAY that.
        //
        // Only speak to the operator if they are still in the session that sent this
        // save. Quote A's unqualified failure toast over quote B is the same
        // route-reply leak `editingSessionChanged()` exists to stop, and this early
        // return sits above it.
        //
        // And do not tell a CREATE to reload. The key lives in a `useRef` inside this
        // mounted component, so a reload discards the very receipt that was just
        // retained — the retry then mints a fresh key the server cannot replay and
        // inserts a second quote, which is the outcome this whole branch exists to
        // prevent. Retention only pays off if the operator stays on the form and
        // retries, replaying the original payload against the server's cached result.
        // An EXISTING quote is different: reloading it IS the authoritative
        // resolution, and the reload path releases the key deliberately.
        if (!editingSessionChanged()) {
          toast('error', saveQuoteIntentScope === 'new'
            ? 'The save came back without an ID, so it is unknown whether this quote was created. Press Save Draft again WITHOUT reloading — the retry replays the same request, so the server returns the original result instead of creating a second quote.'
            : 'The quote save came back without an ID, so its outcome is unknown. Reload the quote before making further changes.');
        }
        return null;
      }
      resetSaveQuoteIdempotencyKey();
      const savedQuoteId = result.quote_id;
      // The editing session that sent this save is gone, so nothing below belongs
      // to what is on screen now: the authoritative row-version token, the
      // commission baseline, `setQuoteId`, and — through the `null` return — the
      // callers' dirty-clear, success toast and navigation. Every caller gates
      // its post-save work on a non-null id, so returning `null` suppresses them.
      //
      // Placed AFTER the reply is verified and the key rotated, not before. This
      // save committed; retiring its key is correct and must happen wherever the
      // reply lands, or a later unrelated save would replay this committed
      // result. Rotating it in a second, earlier place would also re-introduce
      // the reset-before-verify ordering that `idempotency-reset-order.test.ts`
      // pins this file against.
      //
      // #618 wrote that "the reply is verified" against `assertRpcResult` alone,
      // which only rejects a MISSING reply. The receipt test above is what makes
      // the sentence true, and it is why the reset now sits below it rather than
      // above the assert as it did on main.
      if (editingSessionChanged()) return null;
      // The save committed, but conversion and other chained actions must not
      // continue unless this tab can install the exact authoritative token.
      if (!installAuthoritativeQuoteRowVersion(result.row_version, 'saved')) {
        return null;
      }
      // Advance the baseline snapshot ONLY when THIS tab saved its own split edit;
      // an untouched save keeps the old baseline (still shown in the editor) so a
      // later edit fail-closed-conflicts if another tab changed the split.
      loadedCommissionSplitRef.current = nextLoadedSplitSnapshot({
        touched: commissionSplitTouchedRef.current,
        prevLoaded: loadedCommissionSplitRef.current,
        echoed: result.commission_split,
        currentValue: { splits: commissionSplit.splits },
      });
      commissionSplitTouchedRef.current = false;
      if (!quoteId || !isEditing) {
        setQuoteId(savedQuoteId);
      }
      return savedQuoteId;
    } catch (err: unknown) {
      if (isBelowCostApprovalHandledError(err)) return null;
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_quote' } });
      toast('error', err instanceof Error ? err.message : 'Failed to save quote');
      return null;
    }
  };

  const handleSaveDraft = async () => {
    setSaving(true);
    const result = await saveQuote('draft');
    if (result) {
      setIsDirty(false);
      toast('success', 'Quote saved as draft');
      trackBusinessEvent(isEditing ? 'quote_updated' : 'quote_created', {
        message: `Quote ${quoteNumber} ${isEditing ? 'updated' : 'created'}`,
        data: { quoteId: result, quoteNumber, customer: selectedCustomer?.farm_name ?? '' },
      });
      // Quote activity is logged in-transaction by save_quote() (migration line 290-299).
      // A frontend logActivity() here would double-log every save.
      // Planned program hold management
      if (isPlanned && profile) {
        const holdIdemKey = plannedHoldsIdem.getKey();
        const { data: holdData, error: holdError } = await supabase.rpc('create_planned_holds', {
          p_quote_id: result,
          p_performed_by: profile.id,
          p_idempotency_key: holdIdemKey,
        });
        if (holdError) toast('error', 'Failed to create inventory holds');
        else {
          assertRpcResult(holdData, 'create_planned_holds');
          plannedHoldsIdem.resetKey();
          toast('success', 'Inventory holds created for planned program');
          await loadActivePlannedHolds(result);
        }
      } else if (!isPlanned && wasPlanned) {
        // save_quote synchronizes planned holds in the same database transaction;
        // no second client-side table mutation or not-yet-live RPC is needed.
        setWasPlanned(false);
        setActivePlannedHolds([]);
      }

      if (!isEditing) navigate(`/quotes/${result}`, { replace: true });
    }
    setSaving(false);
  };

  // Save as template handler
  const handleSaveTemplate = async () => {
    if (!quoteId || !profile) return;
    const tmplIdemKey = saveTemplateIdem.getKey();
    const { data, error } = await supabase.rpc('save_quote_template', {
      p_quote_id: quoteId,
      p_template_name: templateName.trim(),
      p_description: templateDescription.trim() || undefined,
      p_performed_by: profile.id,
      p_idempotency_key: tmplIdemKey,
    });
    if (error) { toast('error', 'Failed to save template'); return; }
    assertRpcResult(data, 'save_quote_template');
    saveTemplateIdem.resetKey();
    toast('success', `Template "${templateName}" saved`);
    setShowSaveTemplateModal(false);
    setTemplateName('');
    setTemplateDescription('');
  };

  // Create from template handler
  const handleSelectTemplate = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const templateId = e.target.value;
    if (!templateId || !customerId || !profile) return;
    const ftIdemKey = fromTemplateIdem.getKey();
    const { data, error } = await supabase.rpc('create_quote_from_template', {
      p_template_id: templateId,
      p_customer_id: customerId,
      p_performed_by: profile.id,
      p_idempotency_key: ftIdemKey,
    });
    if (error) { toast('error', 'Failed to create from template'); return; }
    fromTemplateIdem.resetKey();
    const result = assertRpcResult<{ quote_id: string; quote_number: string }>(data, 'create_quote_from_template');
    navigate(`/quotes/${result.quote_id}`);
  };

  // Seasonal rollover handler
  const handleRollover = async () => {
    if (!quoteId || !profile) return;
    const rollIdemKey = rolloverIdem.getKey();
    const { data, error } = await supabase.rpc('rollover_quote_to_season', {
      p_quote_id: quoteId,
      p_new_season: rolloverSeason,
      p_performed_by: profile.id,
      p_idempotency_key: rollIdemKey,
    });
    if (error) {
      if (hasRpcCode(error, RpcErrorCodes.BOOKING_FULLY_DRAWN)) {
        toast('error', 'This booking is fully drawn — all quantities are already on orders. Nothing left to roll over.');
      } else {
        toast('error', 'Failed to roll over quote');
      }
      return;
    }
    rolloverIdem.resetKey();
    const result = assertRpcResult<{ quote_id: string; quote_number: string; season: number; remainder_rollover: boolean }>(data, 'rollover_quote_to_season');
    toast('success', `Rolled over to season ${result.season} — ${result.quote_number}`);
    navigate(`/quotes/${result.quote_id}`);
  };

  // === GAP FIX #1: Download Quote as PDF ===
  const handleDownloadPdf = async () => {
    await runCriticalAction({
      action: async () => {
        await downloadQuotePdf({
          quote_number: quoteNumber,
          customer_name: selectedCustomer?.farm_name || 'Customer',
          customer_email: selectedCustomer?.email || undefined,
          customer_phone: selectedCustomer?.phone || undefined,
          customer_address: selectedCustomer?.billing_address || undefined,
          sales_rep_name: profile?.full_name || 'Sales Rep',
          created_at: new Date().toISOString(),
          expires_at: undefined,
          valid_days: validDays,
          tier,
          header_notes: headerNotes || undefined,
          footer_notes: footerNotes || undefined,
          sections: sections.map((sec) => ({
            section_name: sec.section_name,
            section_notes: sec.section_notes || undefined,
            section_header_notes: sec.section_header_notes || undefined,
            items: sec.items
              .filter((i) => i.product_id)
              .map((i) => ({
                product_name: i.product?.product_name || '',
                category: i.product?.category || '',
                notes: i.notes || undefined,
                suggested_rate: i.product?.suggested_rate || undefined,
                actual_rate: i.actual_rate || 0,
                rate_unit: i.rate_unit || '',
                acres: i.acres || 0,
                total_units_needed: i.total_units_needed || 0,
                inventory_unit: i.product?.inventory_unit || undefined,
                unit_size: i.product?.unit_size || undefined,
                price_per_unit: i.price_per_unit,
                price_unit: i.price_unit || undefined,
                price_per_acre: i.price_per_acre || undefined,
                total_price: i.total_price,
              })),
          })),
          totals: {
            totalPrice: totals.totalPrice,
            totalCost: totals.totalCost,
            totalProfit: totals.totalProfit,
            avgMargin: totals.totalMarginPct,
          },
        }, customColumns || getTemplateColumns(selectedTemplateId));
      },
      toast,
      successMessage: 'PDF downloaded',
      sentryTag: 'download_quote_pdf',
    });
  };

  const handleReviseQuote = async () => {
    if (!quoteId) return;
    setRevising(true);
    const savedId = await saveQuote('revised');
    if (savedId) {
      setStatus('revised');
      setIsDirty(false);
      toast('success', 'Quote is now in revised mode — you can edit and re-send.');
    }
    setRevising(false);
  };

  // Decline / Cancel a quote (roadmap #5). The status-transition + hold-release
  // triggers do the DB work; we only flip the status under RLS. Guardrail: never
  // abandon an open booking's holds from here — a partially-drawn booking must be
  // closed via its orders first (parity with the Quotes list bulk-delete skip).
  const setTerminalStatus = async (newStatus: 'declined' | 'cancelled') => {
    if (!id) return;
    const verb = newStatus === 'declined' ? 'decline' : 'cancel';
    setStatusActionLoading(true);
    try {
      const [orderDrawsRes, jobDrawsRes] = await Promise.all([
        supabase
          .from('quote_product_draws')
          .select('quantity_drawn')
          .eq('quote_id', id)
          .gt('quantity_drawn', 0)
          .limit(1),
        // Layer 2: a job reservation also blocks a terminal transition — the
        // _enforce_quote_terminal_not_drawn trigger now counts job draws too.
        supabaseUntyped
          .from('job_product_draws')
          .select('quantity_drawn')
          .eq('quote_id', id)
          .gt('quantity_drawn', 0)
          .limit(1),
      ]);
      if (orderDrawsRes.error) throw orderDrawsRes.error;
      if (jobDrawsRes.error) throw jobDrawsRes.error;
      if ((orderDrawsRes.data && orderDrawsRes.data.length > 0) || (jobDrawsRes.data && jobDrawsRes.data.length > 0)) {
        toast('warning', `This booking has partial draw-downs or job reservations — close it from its orders/jobs (draw or cancel the remaining balance) before you ${verb} the quote.`);
        return;
      }
      const previousRowVersion = quoteRowVersionRef.current;
      const result = await supabase
        .from('quotes')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*');
      checkMutationResult(result, `${verb === 'decline' ? 'Decline' : 'Cancel'} quote`);
      setStatus(newStatus);
      const trustedRowVersion = applyDirectQuoteMutationRowVersion(
        previousRowVersion,
        (result.data as Array<{ row_version?: unknown }>)[0]?.row_version,
        'updated',
      );
      if (trustedRowVersion) setIsDirty(false);
      await logActivity({
        event: newStatus === 'declined' ? 'quote_declined' : 'quote_cancelled',
        description: `Quote ${quoteNumber} ${newStatus}`,
        performedBy: profile?.id || '',
        entityType: 'quote',
        entityId: id,
      });
      toast('success', `Quote ${newStatus} — any inventory holds were released.`);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'mutation', action: `quote_${newStatus}` } });
      toast('error', sanitizeError(err));
    } finally {
      setStatusActionLoading(false);
      setConfirmDeclineOpen(false);
      setConfirmCancelOpen(false);
    }
  };

  // Close a booking we fulfilled by APPLYING product for the customer (job
  // applications), NOT by delivering it (convert/draw = chemical sale). Flips to
  // the distinct terminal status 'closed_by_application' via the actor-bound,
  // idempotent close_quote_as_applied RPC, which releases any un-applied leftover
  // back to free inventory and reports how much. Never double-bills — the
  // customer was already billed through each job's application invoice. (owner 2026-07-03)
  const handleCloseAsApplied = async () => {
    if (!id) return;
    setClosingApplied(true);
    try {
      const previousRowVersion = quoteRowVersionRef.current;
      const idemKey = closeAppliedIdem.getKey();
      // supabaseUntyped: close_quote_as_applied is a Layer 2 RPC not yet in the
      // generated types (matches get_dispatch_stock_status / job_product_draws usage).
      const { data, error } = await supabaseUntyped.rpc('close_quote_as_applied', {
        p_quote_id: id,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      closeAppliedIdem.resetKey();
      const result = assertRpcResult<{ status: string; released_units?: number; active_jobs_remaining?: number; warnings?: string[] }>(data, 'close_quote_as_applied');
      setStatus((result.status as QuoteStatus) || 'closed_by_application');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(id, previousRowVersion, previousRowVersion === null ? null : previousRowVersion + 1, 'closed as fulfilled by application');
      setIsDirty(false);
      const warnings = result.warnings || [];
      if (rowVersionConfirmed) {
        toast('success', warnings.length > 0
          ? `Booking closed — fulfilled by application. ${warnings.join('. ')}.`
          : 'Booking closed — fulfilled by application.');
      } else if (warnings.length > 0) {
        toast('warning', `Booking close warnings: ${warnings.join('. ')}.`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'mutation', action: 'close_quote_as_applied' } });
      if (hasRpcCode(err, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('warning', 'This booking is no longer open — refresh the page to see its current status.');
      } else {
        toast('error', sanitizeError(err));
      }
    } finally {
      setClosingApplied(false);
      setConfirmCloseAppliedOpen(false);
    }
  };

  // Close a booking the customer ABANDONED (walked away, or drew only part and
  // never took the rest). Flips to the terminal status 'closed_short' via the
  // actor-bound, idempotent close_quote_as_short RPC, which releases the
  // un-fulfilled remainder back to free inventory. Never bills — any drawn
  // portion was already billed via its order; the remainder was never billed.
  // Refuses if scheduled/in-progress jobs still exist (BOOKING_HAS_ACTIVE_JOBS). (#1)
  const handleCloseAsShort = async () => {
    if (!id) return;
    setClosingShort(true);
    try {
      const previousRowVersion = quoteRowVersionRef.current;
      const idemKey = closeShortIdem.getKey();
      // supabaseUntyped: close_quote_as_short is a new RPC not yet in the
      // generated types (matches close_quote_as_applied usage).
      const { data, error } = await supabaseUntyped.rpc('close_quote_as_short', {
        p_quote_id: id,
        p_performed_by: profile!.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      closeShortIdem.resetKey();
      const result = assertRpcResult<{ status: string; released_units?: number; warnings?: string[] }>(data, 'close_quote_as_short');
      setStatus((result.status as QuoteStatus) || 'closed_short');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(id, previousRowVersion, previousRowVersion === null ? null : previousRowVersion + 1, 'closed short');
      setIsDirty(false);
      const warnings = result.warnings || [];
      if (rowVersionConfirmed) {
        toast('success', warnings.length > 0
          ? `Booking closed short. ${warnings.join('. ')}.`
          : 'Booking closed short.');
      } else if (warnings.length > 0) {
        toast('warning', `Booking close warnings: ${warnings.join('. ')}.`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'mutation', action: 'close_quote_as_short' } });
      if (hasRpcCode(err, RpcErrorCodes.BOOKING_HAS_ACTIVE_JOBS)) {
        toast('warning', 'This booking still has scheduled or in-progress jobs. Cancel or complete them first, then close the booking as short.');
      } else if (hasRpcCode(err, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('warning', 'This booking is no longer open — refresh the page to see its current status.');
      } else {
        toast('error', sanitizeError(err));
      }
    } finally {
      setClosingShort(false);
      setConfirmCloseShortOpen(false);
    }
  };

  // Un-accept / Reopen a quote back to 'sent' (roadmap #5, fixes W4). Routes
  // through the admin-only hardened revert_quote_status RPC, which blocks
  // reverting an accepted quote that already has an order.
  const handleRevertStatus = async () => {
    if (!id) return;
    const normalizedReason = revertReason.trim();
    if (!normalizedReason) {
      toast('warning', 'Please enter a reason for reopening this quote.');
      return;
    }
    if (normalizedReason.length > MAX_REVERT_REASON_LENGTH) {
      toast('warning', `Reopen reason must be ${MAX_REVERT_REASON_LENGTH} characters or fewer.`);
      return;
    }
    setReverting(true);
    try {
      const previousRowVersion = quoteRowVersionRef.current;
      const idemKey = revertStatusIdem.getKey();
      const { data, error } = await supabase.rpc('revert_quote_status', {
        p_quote_id: id,
        p_reason: normalizedReason,
        p_performed_by: profile?.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ success: boolean; old_status: string; new_status: string }>(data, 'revert_quote_status');
      revertStatusIdem.resetKey();
      setStatus((result.new_status as QuoteStatus) || 'sent');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(id, previousRowVersion, previousRowVersion === null ? null : previousRowVersion + 1, 'reopened');
      // Codex round-9 P2: a PLANNED quote's holds are now rebuilt ATOMICALLY inside
      // revert_quote_status (20260613290000) — same transaction as the status flip, so
      // there is no sent-without-holds window. The previous client-side recreate-after-
      // revert was non-atomic and is removed.
      setShowRevertModal(false);
      setRevertReason('');
      if (rowVersionConfirmed) {
        toast('success', `Quote reopened to ${result.new_status}.`);
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'revert_quote_status' } });
      if (hasRpcCode(err, RpcErrorCodes.INSUFFICIENT_ROLE)) {
        toast('error', 'Only an admin can reopen a quote.');
      } else {
        // Server messages here are plain-English and actionable (e.g. "an order
        // has already been created from it") — surface them as-is.
        toast('error', sanitizeError(err));
      }
    } finally {
      setReverting(false);
    }
  };

  const handlePreviewQuote = async () => {
    await runCriticalAction({
      action: async () => {
        const pdfData = {
          quote_number: quoteNumber,
          customer_name: selectedCustomer?.farm_name || 'Customer',
          customer_email: selectedCustomer?.email || undefined,
          customer_phone: selectedCustomer?.phone || undefined,
          customer_address: selectedCustomer?.billing_address || undefined,
          sales_rep_name: profile?.full_name || 'Sales Rep',
          created_at: new Date().toISOString(),
          expires_at: undefined,
          valid_days: validDays,
          tier,
          header_notes: headerNotes || undefined,
          footer_notes: footerNotes || undefined,
          sections: sections.map((sec) => ({
            section_name: sec.section_name,
            section_notes: sec.section_notes || undefined,
            items: sec.items
              .filter((i) => i.product_id)
              .map((i) => ({
                product_name: i.product?.product_name || '',
                actual_rate: i.actual_rate || 0,
                rate_unit: i.rate_unit || '',
                acres: i.acres || 0,
                total_units_needed: i.total_units_needed || 0,
                price_per_unit: i.price_per_unit,
                price_unit: i.price_unit || undefined,
                total_price: i.total_price,
              })),
          })),
          totals: {
            totalPrice: totals.totalPrice,
            totalCost: totals.totalCost,
            totalProfit: totals.totalProfit,
            avgMargin: totals.totalMarginPct,
          },
        };
        const doc = await generateQuotePdf(pdfData);
        const blob = doc.output('blob');
        const url = URL.createObjectURL(blob);
        if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl);
        setPreviewPdfUrl(url);
        setShowPreviewModal(true);
      },
      toast,
      sentryTag: 'preview_quote_pdf',
    });
  };

  // #3 Stage A: email the quote PDF to the grower via the send-email Edge Function.
  // The Edge Function records the send in email_log and dedupes on the idempotency key.
  const handleEmailToGrower = async () => {
    if (!quoteId) { toast('warning', 'Save the quote before emailing it.'); return; }
    if (quoteVersionRecoveryRequiredRef.current) {
      staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
      setStaleSaveOpen(true);
      toast('error', 'The email was NOT sent. Reload the quote, then email it again.');
      return;
    }
    // Codex P1: an existing quote with unsaved edits still has quoteId, so the
    // emailed PDF would render local edits the DB + version history don't have —
    // the grower would get an unreproducible quote. Block until saved.
    if (isDirty) { toast('warning', 'You have unsaved changes — save the quote before emailing it.'); return; }
    if (!selectedCustomer?.email) { toast('error', 'This customer has no email address on file.'); return; }
    if (!profile) { toast('error', 'You must be signed in to send a quote.'); return; }
    setEmailingGrower(true);
    try {
      // #2 (Codex P1): FREEZE the current saved Quote before every email so the
      // grower's PDF always has a confirmed, reproducible version record. This
      // includes re-emailing an already-sent Quote after a tab remount; an
      // in-memory retry latch cannot protect that path. create_quote_version
      // snapshots the version and atomically sets status='sent'. Keep its
      // quote-scoped idempotency key until the whole send succeeds so a retry
      // after a downstream email failure replays the same snapshot.
      const previousRowVersion = quoteRowVersionRef.current;
      const freezeAttempt = getCreateVersionAttempt();
      const { data: freezeVer, error: freezeErr } = await createQuoteVersionWithRowVersion({
        p_quote_id: quoteId,
        p_performed_by: profile.id,
        p_method: 'emailed',
        p_idempotency_key: freezeAttempt.key,
        p_expected_row_version: freezeAttempt.expectedRowVersion,
      });
      if (freezeErr) throw freezeErr;
      const freezeResult = freezeVer;
      setStatus('sent');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(
        quoteId,
        previousRowVersion,
        previousRowVersion === null ? null : readRowVersion(freezeResult.row_version),
        'sent',
      );
      fetchVersions();
      // The snapshot/status change committed, but a missing or jumped token
      // means the local lines may no longer match that frozen snapshot. Never
      // send the locally rendered PDF until a reload proves what was frozen.
      if (!rowVersionConfirmed) {
        // A new key makes the next same-tab attempt create and confirm a fresh
        // snapshot of the reloaded authoritative Quote instead of replaying the
        // mismatched version. A remount naturally receives a new key too.
        resetCreateVersionAttempt();
        toast('error', 'The quote was frozen, but the email was NOT sent. Reload the quote, then email it again.');
        return;
      }
      // Same rich (download) PDF the customer would receive.
      const pdfData = {
        quote_number: quoteNumber,
        customer_name: selectedCustomer?.farm_name || 'Customer',
        customer_email: selectedCustomer?.email || undefined,
        customer_phone: selectedCustomer?.phone || undefined,
        customer_address: selectedCustomer?.billing_address || undefined,
        sales_rep_name: profile?.full_name || 'Sales Rep',
        // Codex round-8 P2: a frozen/sent quote re-emailed later must show its ORIGINAL
        // issue + expiry dates, not today's — otherwise the grower gets a document that
        // looks newly issued with a fresh validity window even though the DB quote is
        // frozen (and may already be expired). Use the persisted created_at + its
        // valid_days window; fall back to now only for an unsaved quote (which the
        // isDirty/quoteId guards above already prevent from emailing).
        created_at: quoteCreatedAt || new Date().toISOString(),
        expires_at: quoteCreatedAt
          ? new Date(new Date(quoteCreatedAt).getTime() + validDays * 24 * 60 * 60 * 1000).toISOString()
          : undefined,
        valid_days: validDays,
        tier,
        header_notes: headerNotes || undefined,
        footer_notes: footerNotes || undefined,
        sections: sections.map((sec) => ({
          section_name: sec.section_name,
          section_notes: sec.section_notes || undefined,
          section_header_notes: sec.section_header_notes || undefined,
          items: sec.items
            .filter((i) => i.product_id)
            .map((i) => ({
              product_name: i.product?.product_name || '',
              category: i.product?.category || '',
              notes: i.notes || undefined,
              suggested_rate: i.product?.suggested_rate || undefined,
              actual_rate: i.actual_rate || 0,
              rate_unit: i.rate_unit || '',
              acres: i.acres || 0,
              total_units_needed: i.total_units_needed || 0,
              inventory_unit: i.product?.inventory_unit || undefined,
              unit_size: i.product?.unit_size || undefined,
              price_per_unit: i.price_per_unit,
              price_unit: i.price_unit || undefined,
              price_per_acre: i.price_per_acre || undefined,
              total_price: i.total_price,
            })),
        })),
        totals: {
          totalPrice: totals.totalPrice,
          totalCost: totals.totalCost,
          totalProfit: totals.totalProfit,
          avgMargin: totals.totalMarginPct,
        },
      };
      const doc = await generateQuotePdf(pdfData, customColumns || getTemplateColumns(selectedTemplateId));
      const base64 = pdfToBase64(doc);
      const idemKey = emailQuoteIdem.getKey();
      const result = await sendEmail({
        to: selectedCustomer.email,
        subject: `Quote ${quoteNumber} from Crop Rx Solutions`,
        html: buildEmailHtml(
          `<p>Hi ${selectedCustomer.contact_name || selectedCustomer.farm_name || 'there'},</p>` +
          `<p>Please find your quote <strong>${quoteNumber}</strong> attached as a PDF. ` +
          `Let us know if you have any questions or would like to proceed.</p>` +
          `<p>Thank you,<br/>Crop Rx Solutions</p>`
        ),
        email_type: 'quote',
        customer_id: customerId,
        resource_type: 'quote',
        resource_id: quoteId,
        idempotency_key: idemKey,
        attachments: [{ filename: `Quote-${quoteNumber}.pdf`, content: base64 }],
      });
      emailQuoteIdem.resetKey();
      // Codex round-8 P2: reset the version idem key only now that the whole send
      // succeeded — a failure before this point keeps the key so a retry replays the
      // same create_quote_version (returns 'duplicate') instead of snapshotting again.
      resetCreateVersionAttempt();
      if (result.deduplicated) {
        toast('info', 'This quote was already emailed (duplicate send skipped).');
      } else {
        toast('success', `Quote emailed to ${selectedCustomer.email}`);
      }
      await loadQuoteEmailStatus(quoteNumber);
      await logActivity({
        event: 'quote_emailed',
        description: `Quote ${quoteNumber} emailed to ${selectedCustomer.email}`,
        performedBy: profile?.id || '',
        entityType: 'quote',
        entityId: quoteId,
        customerId,
      });
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'email_quote_to_grower' } });
      if (hasRpcCode(err, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(err, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        resetCreateVersionAfterReloadRef.current = true;
        quoteVersionRecoveryRequiredRef.current = true;
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('error', 'The quote changed and the email was NOT sent. Reload the quote, then review and send it again.');
      } else {
        toast('error', sanitizeError(err));
      }
    } finally {
      setEmailingGrower(false);
    }
  };

  const handleMarkPresented = async (): Promise<boolean> => {
    if (!quoteId) {
      toast('error', 'Save the quote first, then mark it presented');
      return false;
    }
    if (!profile) return false;
    // Save current state first
    const savedId = await saveQuote(status === 'draft' ? 'draft' : status);
    if (!savedId) return false;
    try {
      // Create version snapshot via RPC
      const previousRowVersion = quoteRowVersionRef.current;
      const presentAttempt = getCreateVersionAttempt();
      const { data: versionData, error } = await createQuoteVersionWithRowVersion({
        p_quote_id: savedId,
        p_performed_by: profile.id,
        p_method: 'presented',
        p_idempotency_key: presentAttempt.key,
        p_expected_row_version: presentAttempt.expectedRowVersion,
      });
      if (error) throw error;
      const ver = versionData;
      // Version creation can update the quote. Keep the committed sent status
      // even if the follow-up version read fails; that condition clears the
      // local token and tells the operator to refresh instead of faking failure.
      setStatus('sent');
      const rowVersionConfirmed = await refreshQuoteRowVersionAfterMutation(
        savedId,
        previousRowVersion,
        previousRowVersion === null ? null : readRowVersion(ver.row_version),
        'presented',
      );
      resetCreateVersionAttempt();
      setShowPreviewModal(false);
      if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl);
      setPreviewPdfUrl(null);
      setIsDirty(false);
      fetchVersions();
      try {
        await logActivity({ event: 'quote_presented', description: `Quote ${quoteNumber} V${ver.version_number} marked as presented to ${selectedCustomer?.farm_name || 'customer'}`, performedBy: profile.id, entityType: 'quote', entityId: savedId, customerId });
      } catch (logError) {
        // The version/status change already committed. Do not strand Book as Order
        // because the secondary activity-feed write failed.
        Sentry.captureException(logError instanceof Error ? logError : new Error(String(logError)), { tags: { source: 'activity_log', action: 'quote_presented' } });
      }
      if (rowVersionConfirmed) {
        toast('success', `Quote marked as presented (V${ver.version_number})`);
      }
      // Book-as-Order chains from this boolean. A committed sent transition
      // with an unconfirmed token must stop before customer/order conversion,
      // including during the supported pre-migration compatibility window.
      return rowVersionConfirmed;
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { source: 'critical_action', action: 'create_quote_version' } });
      if (hasRpcCode(err, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(err, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        resetCreateVersionAfterReloadRef.current = true;
        quoteVersionRecoveryRequiredRef.current = true;
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('error', 'The quote changed before it could be marked presented. Reload and review it before trying again.');
      } else {
        toast('error', 'Failed to mark as presented');
      }
      return false;
    }
  };

  const AVAILABLE_PDF_COLUMNS = [
    { key: 'product', label: 'Product' },
    { key: 'category', label: 'Category' },
    { key: 'notes', label: 'Notes' },
    { key: 'sug_rate', label: 'Sug. Rate' },
    { key: 'actual_rate', label: 'Actual Rate' },
    { key: 'rate_unit', label: 'Unit' },
    { key: 'acres', label: 'Acres' },
    { key: 'qty', label: 'Qty' },
    { key: 'unit_size', label: 'Container' },
    { key: 'price_unit', label: 'Price/Unit' },
    { key: 'price_per_acre', label: '$/Acre' },
    { key: 'total_price', label: 'Total' },
  ] as const;

  const getTemplateColumns = (templateId: string | null): string[] => {
    const t = pdfTemplates.find((p) => p.id === templateId);
    return t ? (t.columns as string[]) : ['product', 'actual_rate', 'acres', 'qty', 'price_unit', 'total_price'];
  };

  const fetchVersions = useCallback(async () => {
    if (!quoteId) return;
    const { data } = await supabase
      .from('quote_versions')
      .select('*')
      .eq('quote_id', quoteId)
      .order('version_number', { ascending: false });
    setQuoteVersions((data || []) as QuoteVersion[]);
  }, [quoteId]);

  const handleRestoreVersion = async (versionId: string) => {
    if (!quoteId || !profile) return;
    if (quoteVersionRecoveryRequiredRef.current) {
      staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
      setStaleSaveOpen(true);
      toast('error', 'Reload the quote before restoring a saved version.');
      return;
    }
    const restoreAttempt = getRestoreVersionAttempt(versionId);
    let restoreResponse;
    try {
      restoreResponse = await runWithBelowCostApproval((reason) => restoreQuoteVersionWithRowVersion(
        withBelowCostReason('restore_quote_version', {
          p_quote_id: quoteId,
          p_version_id: versionId,
          p_performed_by: profile.id,
          p_idempotency_key: restoreAttempt.key,
          p_expected_row_version: restoreAttempt.expectedRowVersion,
        }, reason),
      ));
    } catch (error: unknown) {
      if (isBelowCostApprovalHandledError(error)) return;
      throw error;
    }
    const { data, error } = restoreResponse;
    if (error) {
      // Restore-after-draw refusal (migration 20260816120000). A version
      // restore mints brand-new quote_items ids, so it cannot carry the
      // per-line billing provenance a draw stamps; dropping that provenance was
      // proven to overbill across a restore that changes the line partition, so
      // the server refuses instead. The message explains the alternative (edit
      // the quote directly), so surface it rather than the generic toast.
      if (hasRpcCode(error, RpcErrorCodes.QUOTE_RESTORE_BLOCKED_BY_DRAW)) {
        const errMsg = (error instanceof Error ? error.message : null)
          || (typeof error.message === 'string' ? error.message : null)
          || 'This booking has already been drawn down into an order, so an earlier version cannot be restored. Edit the quote directly instead.';
        toast('error', errMsg);
      // Drawn-version guard (Codex r2 MED): the server blocks restoring a
      // snapshot that would drop a drawn product or fall below its drawn
      // quantity. The server message names the product and quantities.
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_OVERDRAWN)) {
        const errMsg = (error instanceof Error ? error.message : null)
          || (typeof error.message === 'string' ? error.message : null)
          || 'This version books less than what has already been drawn down to orders.';
        toast('error', errMsg);
      } else if (hasRpcCode(error, RpcErrorCodes.QUOTE_VERSION_LEGACY_UNTRUSTED)) {
        toast('error', 'This older saved version cannot be restored because its cost snapshot was not created through the protected version workflow. Create a new version from the current quote instead.');
      } else if (hasRpcCode(error, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        resetRestoreVersionAfterReloadRef.current = true;
        quoteVersionRecoveryRequiredRef.current = true;
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('error', 'The quote changed before the version could be restored. Reload and review it before trying again.');
      } else {
        toast('error', 'Failed to restore version');
      }
      return;
    }
    if (!data) return;
    resetRestoreVersionAttempt();
    toast('success', `Restored from V${selectedVersion?.version_number || '?'}`);
    setConfirmRestore(null);
    setSelectedVersion(null);
    // Reload quote data
    window.location.reload();
  };
  const [schedulingJobSectionKey, setSchedulingJobSectionKey] = useState<string | null>(null);
  // U13 (#111): quote_section.id -> the job already scheduled from it (if any).
  // Populated by fetchQuote + updated locally right after a successful schedule
  // so the badge/hide-button logic never needs a full page reload.
  const [sectionJobs, setSectionJobs] = useState<Record<string, { id: string; job_number: string; status: JobStatus }>>({});

  const handleScheduleJob = async (sectionKey: string) => {
    const sec = sections.find((s) => s._key === sectionKey);
    if (!sec?.id || !quoteId || !profile) return;
    // U13 (#111): create_job_from_quote_section only inserts a job_fields row
    // `IF v_section.field_id IS NOT NULL` — a field-less section would silently
    // create a job with ZERO locations (no acres, nothing to apply chemicals on
    // or dispatch). Block here rather than let that job get created.
    if (!sec.field_id) {
      toast('error', 'Select a Field for this section before scheduling a job — a job needs a location to apply chemicals on and to dispatch.');
      return;
    }
    setSchedulingJobSectionKey(sectionKey);
    try {
      const idemKey = scheduleJobIdem.getKey();
      const { data, error } = await supabase.rpc('create_job_from_quote_section', {
        p_quote_id: quoteId,
        p_section_id: sec.id,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ job_id: string }>(data, 'create_job_from_quote_section');
      scheduleJobIdem.resetKey();
      // U13 (#111): record the badge immediately (no reload needed) + it also
      // hides the "Schedule Job" button for this section (the RPC would reject
      // a second job for the same section anyway — this makes that visible
      // BEFORE the user clicks, instead of via an error toast).
      setSectionJobs((prev) => ({ ...prev, [sec.id as string]: { id: result.job_id, job_number: '(new)', status: 'scheduled' } }));
      toast('success', `Job scheduled from "${sec.section_name}"`);
      navigate(`/jobs/${result.job_id}`);
      void (async () => {
        try {
          const { data: createdJob, error: createdJobError } = await supabase
            .from('jobs')
            .select('customer_id')
            .eq('id', result.job_id)
            .single();
          if (createdJobError) return;
          void warnIfOverCreditLimit(createdJob.customer_id, toast);
        } catch {
          // Non-blocking — the job is already committed and navigation has started.
        }
      })();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'schedule_job_from_quote' } });
      toast('error', sanitizeError(err));
    }
    setSchedulingJobSectionKey(null);
  };


  // Partial booking draw-down: open the modal with the per-product balance
  const openDrawDownModal = async () => {
    if (!id) return false;
    // Draw-down bills at this quote's locked prices, so a current-price stale guard
    // would be misleading and block the first click without protecting the customer.
    if (isDirty) {
      toast('warning', 'Save the quote before drawing down the booking');
      return false;
    }
    let loaded = false;
    setDrawLoading(true);
    setShowDrawModal(true);
    try {
      const [itemsRes, drawsRes, jobDrawsRes] = await Promise.all([
        supabase.from('quote_items').select('product_id, total_units_needed').eq('quote_id', id),
        supabase.from('quote_product_draws').select('product_id, quantity_drawn').eq('quote_id', id),
        // Layer 2 (§6.5): a job reservation also consumes the drawable booking, so the
        // modal's remaining MUST subtract job draws too — otherwise it shows too much
        // and lets the user submit an amount draw_down_quote now rejects as
        // BOOKING_OVERDRAWN. Fold job draws into `drawn` (order + job) so drawn +
        // remaining = booked, matching the server-side balance.
        supabaseUntyped.from('job_product_draws').select('product_id, quantity_drawn').eq('quote_id', id),
      ]);
      if (itemsRes.error) throw itemsRes.error;
      if (drawsRes.error) throw drawsRes.error;
      if (jobDrawsRes.error) throw jobDrawsRes.error;
      const drawnByProduct = new Map<string, number>();
      (drawsRes.data || []).forEach((d) => drawnByProduct.set(d.product_id, Number(d.quantity_drawn) || 0));
      (jobDrawsRes.data || []).forEach((d: { product_id: string; quantity_drawn: number | null }) =>
        drawnByProduct.set(d.product_id, (drawnByProduct.get(d.product_id) || 0) + (Number(d.quantity_drawn) || 0)));
      const bookedByProduct = new Map<string, number>();
      (itemsRes.data || []).forEach((it) => {
        if (!it.product_id) return;
        bookedByProduct.set(it.product_id, (bookedByProduct.get(it.product_id) || 0) + (Number(it.total_units_needed) || 0));
      });
      const rows = Array.from(bookedByProduct.entries())
        .filter(([, booked]) => booked > 0)
        .map(([productId, booked]) => {
          const drawn = drawnByProduct.get(productId) || 0;
          return {
            product_id: productId,
            product_name: products.find((p) => p.id === productId)?.product_name || 'Unknown product',
            unit: products.find((p) => p.id === productId)?.inventory_unit ?? null,
            booked,
            drawn,
            remaining: Math.max(booked - drawn, 0),
            qty: '',
          };
        })
        .sort((a, b) => a.product_name.localeCompare(b.product_name));
      setDrawRows(rows);
      loaded = true;
    } catch (error: unknown) {
      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'draw_down_quote_load' } });
      toast('error', 'Failed to load the booking balance');
      setShowDrawModal(false);
    }
    setDrawLoading(false);
    return loaded;
  };

  const handleDrawDown = async () => {
    if (!id) return;
    const draws = drawRows
      .map((r) => ({ ...r, quantity: parseFloat(r.qty) || 0 }))
      .filter((d) => d.quantity > 0);
    if (draws.length === 0) {
      toast('warning', 'Enter a quantity for at least one product');
      return;
    }
    const over = draws.find((d) => d.quantity > d.remaining);
    if (over) {
      toast('error', `${over.product_name}: only ${over.remaining} remaining on this booking`);
      return;
    }
    setDrawing(true);
    try {
      const { data, error } = await runWithBelowCostApproval((reason) => supabaseUntyped.rpc('draw_down_quote', withBelowCostReason('draw_down_quote', {
        p_quote_id: id,
        p_draws: draws.map((d) => ({ product_id: d.product_id, quantity: d.quantity })),
        p_performed_by: profile!.id,
        p_idempotency_key: drawDownIdem.getKey(),
      }, reason)));
      if (error) throw error;
      drawDownIdem.resetKey();
      const result = assertRpcResult<{ status: string; order_id?: string; order_number?: string; warnings?: string[]; fully_drawn?: boolean }>(data, 'draw_down_quote');
      toast('success', `Order ${result.order_number || ''} created${result.fully_drawn ? ' — booking fully drawn' : ' — booking stays open'}`);
      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach((w) => toast('warning', `Inventory: ${w}`));
      }
      trackBusinessEvent('quote_drawn_down', {
        message: `Booking draw → Order ${result.order_number || ''}`,
        data: { orderId: result.order_id ?? '', orderNumber: result.order_number ?? '', quoteId: id },
      });
      sendOrderConfirmedEmail(result.order_id!);
      setIsDirty(false);
      setShowDrawModal(false);
      navigate(`/orders/${result.order_id}`);
    } catch (error: unknown) {
      if (isBelowCostApprovalHandledError(error)) {
        setDrawing(false);
        return;
      }

      // A retained draw key is bound to one actor and one exact set of draw
      // quantities. A binding refusal performed no work for THIS request and
      // makes that key permanently unusable, so retire it before the operator
      // tries again. If the receipt identifies an earlier committed order,
      // open that order rather than suggesting a second draw.
      const bindingRejection = getIdempotencyBindingRejection(error);
      if (bindingRejection) {
        drawDownIdem.resetKey();
        const committedResult = bindingRejection === 'intent'
          ? getIdempotencyMismatchResult(error, 'draw_down_quote')
          : null;
        const committedOrderId = typeof committedResult?.order_id === 'string'
          && committedResult.order_id.length > 0
          ? committedResult.order_id
          : null;

        if (committedOrderId) {
          setShowDrawModal(false);
          toast('warning', 'An earlier attempt with this retry already created an order. No new draw was made — opening that order now.');
          navigate(`/orders/${committedOrderId}`);
          setDrawing(false);
          return;
        }

        if (bindingRejection !== 'intent') {
          Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
            tags: { source: 'critical_action', action: `draw_down_quote_${bindingRejection}_mismatch` },
          });
        }
        if (bindingRejection === 'intent') {
          setShowDrawModal(false);
          toast('warning', 'That retry key was already used, but its prior outcome could not be opened. Nothing new was drawn. Check Orders for this booking before drawing again.');
          setDrawing(false);
          return;
        }
        const balanceReloaded = await openDrawDownModal();
        const recoveryStep = balanceReloaded
          ? 'The booking balance was reloaded; try again.'
          : 'The booking balance could not be reloaded; refresh the page and check Orders before drawing again.';
        toast('warning', bindingRejection === 'actor'
          ? `That retry belongs to another signed-in user, so nothing new was drawn. ${recoveryStep}`
          : `The database could not confirm this retry outcome, so nothing was drawn now. ${recoveryStep}`);
        setDrawing(false);
        return;
      }

      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'draw_down_quote' } });
      const errObj = error as Record<string, unknown> | null;
      const errMsg = (error instanceof Error ? error.message : null)
        || (errObj && typeof errObj.message === 'string' ? errObj.message : null)
        || (errObj && typeof errObj.details === 'string' ? errObj.details : null)
        || 'Failed to create order from booking';
      // Friendly mapping for the booking guards — UX parity with the convert
      // path (2026-06-10 error-prevention review §3 LOW). BOOKING_PARTIALLY_DRAWN
      // can't fire here: draw_down_quote IS the partial path.
      const authError = rpcAuthErrorMessage(error);
      if (authError) {
        toast('error', authError);
      } else if (hasRpcCode(error, RpcErrorCodes.INSUFFICIENT_ROLE)) {
        toast('error', 'Only active administrators and sales representatives can draw down bookings.');
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_OVERDRAWN)) {
        // The server message already names the product and remaining balance
        // (e.g. another draw landed from a second tab) — surface it as-is.
        toast('error', errMsg);
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('error', 'This booking is closed — only sent or revised quotes can be drawn down.');
      } else if (hasRpcCode(error, RpcErrorCodes.EMPTY_DRAW)) {
        toast('warning', 'Enter a quantity for at least one product');
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_QUANTITY_INVALID)) {
        toast('error', errMsg);
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_PRODUCT_INVALID)) {
        toast('error', 'A draw line has an invalid product reference. Refresh the booking and try again.');
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKED_PRICE_REQUIRED)) {
        // Server message names the product and says what to fix — surface as-is.
        toast('error', errMsg);
      } else if (hasRpcCode(error, RpcErrorCodes.COST_BASIS_REQUIRED)) {
        // This one carries only a product id, which means nothing to an
        // operator — say what to do instead. Cost is NOT editable here: this
        // page only displays item.current_cost. The quote-time cost snapshot
        // is stamped from the product when a line is inserted and is immutable
        // after that, so the repair is to fix the product, then rebuild the
        // line (CodeRabbit PR #404 — a reload alone changes nothing).
        toast('error', 'A booked product on this quote has no cost recorded. Set the cost on the product under Products, then remove and re-add that line on this quote and save it, then draw down again.');
      } else if (hasRpcCode(error, RpcErrorCodes.DRAW_ALLOCATION_MISMATCH)) {
        // Safety net, not an operator mistake: the draw refused rather than
        // billing units it could not match to a booked price.
        toast('error', `${errMsg} — nothing was drawn. Check the quote's booked quantities, then try again.`);
      } else {
        toast('error', errMsg);
      }
    }
    setDrawing(false);
  };

  const handleConvertToOrder = async () => {
    if (quoteVersionRecoveryRequiredRef.current) {
      staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
      setStaleSaveOpen(true);
      toast('error', 'The order was not created. Reload the quote, then try Convert to Order again.');
      return;
    }
    // Guardrail: check for stale quote before converting
    if (quoteCreatedAt) {
      const fresh = checkStaleQuote(quoteCreatedAt);
      if (!fresh && !staleWarning?.dismissed) return;
    }

    // Duplicate order warning: check for recent orders for same customer
    if (customerId) {
      try {
        const sevenDaysAgo = localDatePlusDays(-7);
        const { data: recentOrders } = await supabase
          .from('orders')
          .select('order_number, order_date')
          .eq('customer_id', customerId)
          .is('deleted_at', null)
          .gte('order_date', sevenDaysAgo)
          .order('order_date', { ascending: false })
          .limit(1);
        if (recentOrders && recentOrders.length > 0) {
          const recent = recentOrders[0];
          const daysAgo = Math.ceil((Date.now() - new Date(recent.order_date + 'T00:00:00').getTime()) / 86400000);
          setDuplicateOrderMsg(`This customer already has order ${recent.order_number} from ${daysAgo} day(s) ago. Convert this quote to another order?`);
          setDuplicateOrderConfirmOpen(true);
          return;
        }
      } catch { /* ignore — don't block conversion if check fails */ }
    }

    await executeConvertToOrder();
  };

  const executeConvertToOrder = async () => {
    setDuplicateOrderConfirmOpen(false);
    setConverting(true);
    setConfirmConvertOpen(false);

    // A partially-drawn booking must never be whole-converted — and crucially
    // must not be saved as 'accepted' first: that status flip releases the
    // booking's remaining holds BEFORE the RPC gets a chance to refuse
    // (2026-06-10 BLOCKER). Check the draw ledger up front and route to the
    // Partial Order flow instead. Fail closed: if the ledger can't be read,
    // don't risk the destructive pre-accept.
    if (id) {
      try {
        const [orderDrawRes, jobDrawRes] = await Promise.all([
          supabase
            .from('quote_product_draws')
            .select('quantity_drawn')
            .eq('quote_id', id)
            .gt('quantity_drawn', 0)
            .limit(1),
          // Layer 2: a job reservation also makes the booking partially drawn —
          // whole conversion would re-order units a job already holds/bills (§6.5).
          // job_product_draws isn't in the generated types yet → untyped client.
          supabaseUntyped
            .from('job_product_draws')
            .select('quantity_drawn')
            .eq('quote_id', id)
            .gt('quantity_drawn', 0)
            .limit(1),
        ]);
        if (orderDrawRes.error) throw orderDrawRes.error;
        if (jobDrawRes.error) throw jobDrawRes.error;
        if ((orderDrawRes.data && orderDrawRes.data.length > 0) || (jobDrawRes.data && jobDrawRes.data.length > 0)) {
          toast('warning', 'This booking has partial draw-downs or job reservations — use "Partial Order" to draw the remaining balance instead of converting.');
          setConverting(false);
          return;
        }
      } catch (error: unknown) {
        Sentry.captureException(error, { tags: { source: 'critical_action', action: 'convert_quote_draw_check' } });
        toast('error', 'Could not verify the booking balance — please try again');
        setConverting(false);
        return;
      }
    }

    // A normally open Quote must first commit its accepted status. An already
    // accepted Quote is the recovery/idempotent-resume path: it is read-only in
    // this UI, and rewriting its sections could disturb an Order that another
    // attempt already created. Let the server RPC either create the missing
    // Order or return the existing one without another whole-Quote save.
    const savedId = status === 'accepted' && quoteId
      ? quoteId
      : await saveQuote('accepted');
    if (!savedId) {
      setConverting(false);
      return;
    }

    try {
      // Atomic RPC: order creation + items + inventory prebooking + commissions
      const idemKey = convertQuoteIdem.getKey();
      const expectedRowVersion = quoteRowVersionRef.current;
      const { data, error } = await runWithBelowCostApproval((reason) => convertQuoteToOrderWithRowVersion(
        withBelowCostReason('convert_quote_to_order', {
          p_quote_id: savedId,
          p_performed_by: profile!.id,
          p_idempotency_key: idemKey,
          p_expected_row_version: expectedRowVersion,
        }, reason),
      ));

      if (error) throw error;

      convertQuoteIdem.resetKey();
      const result = data;
      if (!result.order_id) {
        throw new Error('Order conversion completed without an order ID');
      }
      const alreadyConverted = result.status === 'already_converted';
      if (alreadyConverted) {
        toast('info', 'This booking was already converted — opening the existing order.');
      } else {
        toast('success', `Order ${result.order_number || ''} created`);
      }
      const shouldFireConversionSideEffects = !alreadyConverted
        && !firedConvertSideEffects.current.has(result.order_id);
      if (shouldFireConversionSideEffects) {
        firedConvertSideEffects.current.add(result.order_id);
      }

      // Show any inventory warnings returned by the server.
      if (result.warnings && result.warnings.length > 0) {
        result.warnings.forEach((w) => toast('warning', `Inventory: ${w}`));
      }
      // A server replay for an accepted Quote returns the existing Order. Do
      // not emit creation telemetry, alerts, or customer email a second time.
      if (shouldFireConversionSideEffects) {
        trackBusinessEvent('quote_converted_to_order', {
          message: `Quote converted → Order ${result.order_number || ''}`,
          data: { orderId: result.order_id, orderNumber: result.order_number ?? '', quoteId: savedId },
        });
        notifyLargeOrder(result.order_id, result.order_number || '', selectedCustomer?.farm_name || 'customer', totals.totalPrice);
        // Wave A.2 / P1-7: send the customer "Order Confirmed" email at the
        // creation site (orders are born at status='confirmed' — there is no
        // transition to gate on). Fire-and-forget; helper swallows its own errors.
        sendOrderConfirmedEmail(result.order_id);

        // Phase 3.3: Credit limit check — warn (not block) if exceeded
        if (customerId) {
          try {
            const { data: creditCheck } = await supabase.rpc('check_customer_credit_limit', {
              p_customer_id: customerId,
            });
            const cl = assertRpcResult<{ exceeded?: boolean; farm_name?: string; outstanding_ar?: number; credit_limit?: number } | null>(creditCheck, 'check_customer_credit_limit');
            if (cl && cl.exceeded) {
              const fmtCl = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
              toast('warning', `Credit limit warning: ${selectedCustomer?.farm_name || 'Customer'} outstanding AR ${fmtCl(cl.outstanding_ar ?? 0)} exceeds limit ${fmtCl(cl.credit_limit ?? 0)}`);
              notifyCreditLimitExceeded(selectedCustomer?.farm_name || 'Customer', cl.outstanding_ar ?? 0, cl.credit_limit ?? 0, customerId);
            }
          } catch {
            // Non-blocking — credit limit check should not prevent navigation
          }
        }
      }

      // Bug #31 fix: Clear dirty state before navigate to prevent unsaved changes dialog
      setIsDirty(false);
      navigate(`/orders/${result.order_id}`);
    } catch (error: unknown) {
      if (isBelowCostApprovalHandledError(error)) {
        setConverting(false);
        return;
      }
      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'convert_quote_to_order' } });

      if (hasRpcCode(error, RpcErrorCodes.QUOTE_STALE_WRITE)
        || hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_CONFLICT)) {
        resetConvertAfterReloadRef.current = true;
        quoteVersionRecoveryRequiredRef.current = true;
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('warning', 'The quote changed while conversion was starting. Its order outcome was left untouched; reload and review before retrying.');
        setConverting(false);
        return;
      }

      // Lost-response-after-commit must not resurrect the booking (push-gate P1).
      let liveQuoteStatus: string | null = null;
      try {
        const { data: liveQuote, error: liveQuoteError } = await supabase
          .from('quotes')
          .select('status')
          .eq('id', savedId)
          .maybeSingle();
        if (liveQuoteError) throw liveQuoteError;
        liveQuoteStatus = liveQuote?.status ?? null;
      } catch {
        // A failed verification leaves the conversion outcome unknown. Do not
        // write a recovery status without proving the quote is still open.
      }

      if (liveQuoteStatus === 'accepted') {
        let createdOrderId: string | null = null;
        try {
          const { data: createdOrders, error: createdOrderError } = await supabase
            .from('orders')
            .select('id')
            .eq('quote_id', savedId)
            .is('deleted_at', null)
            .order('created_at', { ascending: false })
            .limit(1);
          if (createdOrderError) throw createdOrderError;
          createdOrderId = createdOrders?.[0]?.id ?? null;
        } catch (orderLookupError) {
          Sentry.captureException(orderLookupError, { tags: { source: 'read', action: 'find_order_after_committed_quote_convert' } });
        }

        if (createdOrderId) {
          toast('success', 'The order was created — opening it');
          setIsDirty(false);
          navigate(`/orders/${createdOrderId}`);
        } else {
          toast('warning', 'The quote was accepted, but its order could not be found — check the Orders page');
          try {
            await fetchQuote(savedId);
          } catch (refetchError) {
            Sentry.captureException(refetchError, { tags: { source: 'read', action: 'refetch_quote_after_committed_convert' } });
          }
        }
        setConverting(false);
        return;
      }

      if (liveQuoteStatus === null) {
        // The conversion RPC is transactional, so a genuine failure leaves the
        // status unchanged. A recovery write is only safe after a successful
        // read proves the quote was not accepted.
        toast('warning', 'Could not verify the outcome — check the Orders page before retrying; the quote status was left unchanged.');
        setConverting(false);
        return;
      }

      // Friendly mapping for the booking guards (server-side backstop for the
      // pre-check above — e.g. a draw landed from another tab mid-convert).
      if (hasRpcCode(error, RpcErrorCodes.BOOKING_PARTIALLY_DRAWN)) {
        toast('warning', 'This booking has partial draw-downs — use "Partial Order" to draw the remaining balance instead of converting.');
      } else if (hasRpcCode(error, RpcErrorCodes.BOOKING_CLOSED)) {
        toast('error', 'This booking is closed — only sent or revised quotes can be converted.');
      } else {
      // Bug #30 fix: Extract error message from Supabase RPC error objects
      const errObj = error as Record<string, unknown> | null;
      const errMsg = (error instanceof Error ? error.message : null)
        || (errObj && typeof errObj.message === 'string' ? errObj.message : null)
        || (errObj && typeof errObj.details === 'string' ? errObj.details : null)
        || (errObj && typeof errObj.hint === 'string' ? errObj.hint : null)
        || 'Failed to create order';
      toast('error', errMsg);
      }
      // A successful status check proved the quote was not accepted. A draft can
      // only reach this path through Book as Order, whose mark-presented step
      // already committed it as sent; keep it sent so normal Convert remains.
      const revertTo = status === 'accepted' || status === 'draft' ? 'sent' : (status || 'sent');
      try {
        const previousRowVersion = quoteRowVersionRef.current;
        const revertResult = await supabase.from('quotes').update({ status: revertTo }).eq('id', savedId).select('*');
        checkMutationResult(revertResult, 'Revert quote status');
        setStatus(revertTo);
        applyDirectQuoteMutationRowVersion(
          previousRowVersion,
          (revertResult.data as Array<{ row_version?: unknown }>)[0]?.row_version,
          'reverted',
        );
      } catch (revertErr) {
        // The quote is now stuck 'accepted' with no order — surface it instead
        // of failing silently so someone fixes the status by hand.
        Sentry.captureException(revertErr, { tags: { source: 'mutation', action: 'revert_quote_status_after_failed_convert' } });
        toast('error', `Order creation failed AND the quote could not be reverted to "${revertTo}" — its status may need a manual fix`);
      }
    }
    setConverting(false);
  };

  // U16b: one-step booking for a clean, saved draft. Mark Presented uses the
  // existing create_quote_version path (snapshot + sent), then the existing
  // conversion handler applies all stale/duplicate/draw-down guards. If the
  // first step succeeds but conversion fails, executeConvertToOrder restores the
  // quote to sent, so staff can retry with the normal Convert button.
  const handleBookAsOrder = async () => {
    setBookingAsOrder(true);
    try {
      if (quoteVersionRecoveryRequiredRef.current) {
        staleSaveConflictScopeRef.current = NON_SAVE_RECOVERY;
        setStaleSaveOpen(true);
        toast('error', 'The order was not created. Reload the quote, then try Book as Order again.');
        return;
      }
      // A lost mark-sent response leaves the DB sent while the UI thinks draft —
      // resume the chain from the true state (push-gate P2).
      let alreadyMarkedSent = false;
      if (quoteId) {
        try {
          const { data: liveQuote, error: liveQuoteError } = await supabase
            .from('quotes')
            .select('status')
            .eq('id', quoteId)
            .maybeSingle();
          if (liveQuoteError) throw liveQuoteError;
          const liveStatus = liveQuote?.status;
          if (liveStatus === 'sent' || liveStatus === 'revised') {
            setStatus(liveStatus);
            alreadyMarkedSent = true;
          }
        } catch {
          // If the live-status check fails, continue with the existing flow.
        }
      }

      if (!alreadyMarkedSent) {
        const markedSent = await handleMarkPresented();
        if (!markedSent) {
          return;
        }
      }
      setConfirmBookAsOrderOpen(false);
      await handleConvertToOrder();
    } finally {
      setBookingAsOrder(false);
    }
  };

  const filteredProducts = useMemo(() => {
    if (!productQuery.trim()) return products;
    const q = productQuery.toLowerCase();
    return products.filter(
      (p) =>
        p.product_name.toLowerCase().includes(q) ||
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        (p.category && p.category.toLowerCase().includes(q)) ||
        (p.vendor && p.vendor.toLowerCase().includes(q))
    );
  }, [products, productQuery]);

  const fmt = formatUSD; // quote math is dollar-denominated (not cents)

  const pct = (n: number) => `${n.toFixed(1)}%`; // net_margin is already stored as percentage

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-10 bg-gray-200 rounded w-48" />
        <div className="h-64 bg-gray-200 rounded" />
        <div className="h-64 bg-gray-200 rounded" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[
        { label: 'Quotes', href: '/quotes' },
        { label: isEditing ? (quoteNumber || 'Quote') : 'New Quote' },
      ]} />
      {isEditing && threadOrders.length > 0 && (
        <TransactionThread
          quoteId={quoteId || undefined}
          quoteNumber={quoteNumber || undefined}
          orders={threadOrders.map(o => ({ id: o.id, number: o.order_number }))}
          deliveries={threadOrders.flatMap(o => o.deliveries.map(d => ({ id: d.id, number: d.delivery_number })))}
          invoices={threadOrders.flatMap(o => o.invoices.map(i => ({ id: i.id, number: i.invoice_number })))}
          currentEntity="quote"
          currentEntityId={quoteId || undefined}
        />
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold font-heading text-nav-dark">
            Quote <span className="split-heading-accent">Builder</span>
          </h1>
          {quoteNumber && (
            <span className="text-sm text-secondary font-mono">{quoteNumber}</span>
          )}
          {isEditing && (
            <Badge variant={statusToBadgeVariant[status] || 'default'}>
              {status === 'closed_by_application' ? 'Fulfilled (Applied)' : status === 'closed_short' ? 'Closed — Short' : status}
            </Badge>
          )}
          <label className="flex items-center gap-2 text-sm ml-4">
            <input
              type="checkbox"
              checked={isPlanned}
              onChange={(e) => setIsPlanned(e.target.checked)}
              className="rounded border-gray-300 text-crx-green focus:ring-crx-green"
              disabled={!canEdit && isEditing}
            />
            <span className="font-medium">Planned Program</span>
            <HelpTip text="Mark as Planned if the customer intends to buy but hasn't committed yet. This reserves inventory with a hold so it's not sold to someone else. Set the Needed By date so you can forecast when product will move." className="ml-1" />
          </label>
          {isPlanned && (
            <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full">
              Planned
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<Save className="w-4 h-4" />}
            showChevron={false}
            onClick={handleSaveDraft}
            loading={saving}
            disabled={!canEdit && isEditing}
          >
            Save Draft
          </Button>
          <Button
            variant="secondary"
            icon={<Download className="w-4 h-4" />}
            showChevron={false}
            onClick={handleDownloadPdf}
          >
            Download PDF
          </Button>
          <div
            className="relative"
            ref={moreActionsRef}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setMoreActionsOpen(false);
              }
            }}
          >
            <button
              type="button"
              onClick={() => setMoreActionsOpen((open) => !open)}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={moreActionsOpen}
              className="inline-flex items-center justify-center rounded-lg border border-gray-200 p-2 text-secondary transition-colors hover:border-crx-green hover:text-crx-green"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {moreActionsOpen && (
              <div role="menu" className="absolute right-0 z-30 mt-2 w-60 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCustomerView(!customerView);
                    setMoreActionsOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-nav-dark hover:bg-gray-50"
                >
                  {customerView ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  Customer View
                </button>
                {quoteId && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowSaveTemplateModal(true);
                        setMoreActionsOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-nav-dark hover:bg-gray-50"
                    >
                      <Copy className="w-4 h-4" />
                      Save as Template
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowRolloverModal(true);
                        setMoreActionsOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-nav-dark hover:bg-gray-50"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Roll Over to New Season
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {canSend && (
            <Button
              variant="primary"
              icon={<Eye className="w-4 h-4" />}
              onClick={handlePreviewQuote}
            >
              Preview Quote
            </Button>
          )}
          {isEditing && quoteId && currentStatus === 'draft' && !isDirty && (
            <Button
              variant="secondary"
              icon={<ShoppingCart className="w-4 h-4" />}
              showChevron={false}
              onClick={() => setConfirmBookAsOrderOpen(true)}
              loading={bookingAsOrder}
            >
              Book as Order
            </Button>
          )}
          {isEditing && (canConvert || canDraw) && (
            <div
              className="relative"
              ref={createOrderMenuRef}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setCreateOrderMenuOpen(false);
                }
              }}
            >
              <Button
                variant="primary"
                icon={<ShoppingCart className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setCreateOrderMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={createOrderMenuOpen}
              >
                Create Order ▾
              </Button>
              {createOrderMenuOpen && (
                <div role="menu" className="absolute right-0 z-30 mt-2 w-64 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!canConvert || converting}
                    title={canConvert ? undefined : 'Whole-booking conversion is available after the quote is sent or revised.'}
                    onClick={() => {
                      setConfirmConvertOpen(true);
                      setCreateOrderMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-nav-dark hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ShoppingCart className="w-4 h-4" />
                    Convert whole booking
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!canDraw || drawLoading}
                    title={canDraw ? undefined : 'Partial draw-down is available after the quote is sent or revised.'}
                    onClick={() => {
                      openDrawDownModal();
                      setCreateOrderMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-nav-dark hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <PackageOpen className="w-4 h-4" />
                    Draw part of booking…
                  </button>
                </div>
              )}
            </div>
          )}
          {isEditing && currentStatus === 'sent' && (
            <Button
              variant="secondary"
              icon={<Pencil className="w-4 h-4" />}
              showChevron={false}
              onClick={handleReviseQuote}
              loading={revising}
            >
              Revise Quote
            </Button>
          )}
          {canCloseApplied && (
            <>
              <Button
                variant="secondary"
                icon={<CheckCircle className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setConfirmCloseAppliedOpen(true)}
                loading={closingApplied}
              >
                Close — Applied
              </Button>
              <HelpTip text="Use this when WE applied this booking's product for the customer (job applications), instead of delivering it. It closes the booking as fulfilled by application and releases any un-applied product back to free inventory. The customer was already billed through each job's application invoice — this never bills again." className="ml-1" />
            </>
          )}
          {canCloseShort && (
            <>
              <Button
                variant="secondary"
                icon={<PackageOpen className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setConfirmCloseShortOpen(true)}
                loading={closingShort}
              >
                Close — Short
              </Button>
              <HelpTip text="Use this when the customer walked away from this booking (or took only part of it) and won't take the rest. It closes the booking and releases the un-fulfilled remainder back to free inventory. Any product already drawn was billed on its order — this never bills again. This is the way to close a booking that Decline/Cancel refuse because it was partially drawn." className="ml-1" />
            </>
          )}
          {canDecline && (
            <Button
              variant="secondary"
              icon={<XCircle className="w-4 h-4" />}
              showChevron={false}
              onClick={() => setConfirmDeclineOpen(true)}
              loading={statusActionLoading}
            >
              Decline
            </Button>
          )}
          {canCancel && (
            <Button
              variant="ghost"
              icon={<Ban className="w-4 h-4" />}
              showChevron={false}
              onClick={() => setConfirmCancelOpen(true)}
              loading={statusActionLoading}
            >
              Cancel Quote
            </Button>
          )}
          {canRevert && (
            <>
              <Button
                variant="secondary"
                icon={<Undo2 className="w-4 h-4" />}
                showChevron={false}
                onClick={() => { setRevertReason(''); setShowRevertModal(true); }}
                loading={reverting}
              >
                {revertLabel}
              </Button>
              <HelpTip text="Reopens this quote to “sent” so it can be edited, re-sent, or converted again. Admin only. Blocked if an order was already created from an accepted quote." className="ml-1" />
            </>
          )}
          {isEditing && quoteVersions.length > 0 && (
            <>
              <Button
                variant="ghost"
                icon={<History className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setShowVersionHistory(!showVersionHistory)}
              >
                Versions ({quoteVersions.length})
              </Button>
              <HelpTip text="Every time you send or revise, a snapshot is saved. You can compare versions side-by-side or restore an older version if needed." className="ml-1" />
            </>
          )}
        </div>
      </div>

      {/* Covers a stale warning left active when the convert-confirm modal closes; draw-down no longer raises it. */}
      {!confirmConvertOpen && (
        <GuardrailBanner warning={staleWarning} onDismiss={dismissStaleWarning} />
      )}

      {isEditing && !canEdit && currentStatus !== 'sent' && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-sm">
          This quote is in <strong>{currentStatus}</strong> status and cannot be edited.
        </div>
      )}

      {isEditing && currentStatus === 'sent' && !canEdit && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-800 text-sm flex items-center justify-between">
          <span>This quote has been sent. Click <strong>Revise Quote</strong> to make changes, then re-send.</span>
        </div>
      )}

      {customerView && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-50 border border-crx-green/20 rounded-lg text-sm text-crx-green font-medium">
          <EyeOff className="w-4 h-4" />
          Customer View — cost, profit, and margin columns hidden
        </div>
      )}

      {/* Booking settlement (roadmap #6c): open-booking position. Read-only. */}
      {isEditing && canDraw && bookingSettlement?.found && (
        <Card>
          <CardHeader title="Booking" accent="Settlement" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-secondary">Booked</div>
              <div className="font-semibold text-nav-dark">{formatCents(bookingSettlement.booked_cents ?? 0)}</div>
            </div>
            <div>
              <div className="text-secondary">Drawn</div>
              <div className="font-semibold text-nav-dark">{formatCents(bookingSettlement.drawn_cents ?? 0)}</div>
            </div>
            <div>
              <div className="text-secondary">Remaining to draw</div>
              <div className="font-semibold text-nav-dark">{formatCents(bookingSettlement.remaining_cents ?? 0)}</div>
            </div>
            {/* Prepaid cell hidden while there is no earmarked prepay — the booking-prepay
                earmark engine is shelved (docs/roadmap/shelved-earmark-engine/), so this
                reads 0 for now and lights up automatically when the engine returns. */}
            {((bookingSettlement.prepay_remaining_cents ?? 0) > 0 || (bookingSettlement.prepay_earmarked_cents ?? 0) > 0) && (
              <div>
                <div className="text-secondary">Prepaid (remaining)</div>
                <div className="font-semibold text-crx-green">{formatCents(bookingSettlement.prepay_remaining_cents ?? 0)}</div>
              </div>
            )}
          </div>
          {(bookingSettlement.prepay_earmarked_cents ?? 0) > 0 && (
            <div className="mt-2 text-xs text-secondary">
              Prepay earmarked {formatCents(bookingSettlement.prepay_earmarked_cents ?? 0)} · applied {formatCents(bookingSettlement.prepay_applied_cents ?? 0)}
            </div>
          )}
          {bookingSettlement.lines && bookingSettlement.lines.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-secondary">
                    <th className="px-2 py-1 text-left font-medium">Product</th>
                    <th className="px-2 py-1 text-right font-medium">Booked</th>
                    <th className="px-2 py-1 text-right font-medium">Drawn</th>
                    <th className="px-2 py-1 text-right font-medium">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {bookingSettlement.lines.map((ln) => (
                    (() => {
                      const unit = products.find((product) => product.id === ln.product_id)?.inventory_unit;
                      const suffix = unit ? ` ${unit}` : '';
                      return (
                        <tr key={ln.product_id} className="border-b border-gray-50">
                          <td className="px-2 py-1">{ln.product_name ?? '—'}</td>
                          <td className="px-2 py-1 text-right">{ln.booked_qty}{suffix}</td>
                          <td className="px-2 py-1 text-right">{ln.drawn_qty}{suffix}</td>
                          <td className="px-2 py-1 text-right">{ln.remaining_qty}{suffix}</td>
                        </tr>
                      );
                    })()
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {showVersionHistory && quoteVersions.length > 0 && (
        <Card>
          <CardHeader title="Version" accent="History" />
          {/* Version list */}
          <div className="divide-y divide-gray-100">
            {quoteVersions.map((v) => {
              const itemCount = v.snapshot_data?.sections?.reduce(
                (sum, s) => sum + (s.items?.length || 0), 0
              ) || 0;
              const totalPrice = v.snapshot_data?.quote?.total_price || 0;
              const isSelected = selectedVersion?.id === v.id;
              return (
                <div
                  key={v.id}
                  className={`py-3 px-3 flex items-center justify-between cursor-pointer transition-colors ${isSelected ? 'bg-crx-green/10 border-l-4 border-crx-green' : 'hover:bg-gray-50'}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setSelectedVersion(isSelected ? null : v);
                    setCompareMode(false);
                    setConfirmRestore(null);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedVersion(isSelected ? null : v); setCompareMode(false); setConfirmRestore(null); } }}
                >
                  <div>
                    <span className="font-medium text-nav-dark">v{v.version_number}</span>
                    <span className="text-secondary text-sm ml-3">
                      {new Date(v.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                  <div className="text-sm text-secondary">
                    {itemCount} item{itemCount !== 1 ? 's' : ''} &middot;{' '}
                    {fmt(totalPrice)}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected version details */}
          {selectedVersion && !compareMode && (
            <div className="border-t border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-nav-dark">V{selectedVersion.version_number} Snapshot</h4>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Eye className="w-3.5 h-3.5" />}
                    showChevron={false}
                    onClick={() => setCompareMode(true)}
                  >
                    Compare
                  </Button>
                  {canEdit && (
                    <>
                      {confirmRestore === selectedVersion.id ? (
                        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1">
                          <span className="text-sm text-amber-800">Restore V{selectedVersion.version_number}?</span>
                          <Button
                            size="sm"
                            icon={<CheckCircle className="w-3.5 h-3.5" />}
                            showChevron={false}
                            onClick={() => handleRestoreVersion(selectedVersion.id)}
                          >
                            Yes
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            showChevron={false}
                            onClick={() => setConfirmRestore(null)}
                          >
                            No
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<RotateCcw className="w-3.5 h-3.5" />}
                          showChevron={false}
                          onClick={() => setConfirmRestore(selectedVersion.id)}
                        >
                          Restore
                        </Button>
                      )}
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    showChevron={false}
                    onClick={() => { setSelectedVersion(null); setConfirmRestore(null); }}
                  >
                    Close
                  </Button>
                </div>
              </div>
              <div className="text-sm text-secondary mb-3">
                Total: {fmt(selectedVersion.snapshot_data?.quote?.total_price || 0)}
                {' '}&middot;{' '}
                Margin: {(selectedVersion.snapshot_data?.quote?.total_margin_pct || 0).toFixed(1)}%
              </div>
              {selectedVersion.snapshot_data?.sections?.map((sec, si) => (
                <div key={si} className="mb-3">
                  <div className="flex items-center gap-2">
                    <h5 className="text-sm font-medium text-nav-dark mb-1">{sec.section_name}</h5>
                    {sec.needed_by_date && <span className="text-xs text-amber-600 mb-1">Needed by: {sec.needed_by_date}</span>}
                  </div>
                  {sec.section_header_notes && <p className="text-xs text-secondary italic mb-1">{sec.section_header_notes}</p>}
                  {sec.section_notes && <p className="text-xs text-secondary mb-1">{sec.section_notes}</p>}
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-200 text-secondary">
                          <th className="text-left py-1 pr-2">Product</th>
                          <th className="text-right py-1 px-2">Rate</th>
                          <th className="text-right py-1 px-2">Acres</th>
                          <th className="text-right py-1 px-2">Units</th>
                          <th className="text-right py-1 px-2">Price/Unit</th>
                          <th className="text-right py-1 pl-2">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sec.items?.map((item, ii) => (
                          <tr key={ii} className="border-b border-gray-100">
                            <td className="py-1 pr-2 text-nav-dark">{item.product_name}</td>
                            <td className="py-1 px-2 text-right text-secondary">
                              {item.actual_rate ? `${item.actual_rate} ${item.rate_unit || ''}` : '-'}
                            </td>
                            <td className="py-1 px-2 text-right text-secondary">{item.acres ?? '-'}</td>
                            <td className="py-1 px-2 text-right text-secondary">{item.total_units_needed ?? '-'}</td>
                            <td className="py-1 px-2 text-right text-secondary">{fmt(item.price_per_unit)}</td>
                            <td className="py-1 pl-2 text-right font-medium text-nav-dark">{fmt(item.total_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Compare mode: show differences between selected version and current quote */}
          {selectedVersion && compareMode && (
            <div className="border-t border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-nav-dark">
                  Comparing V{selectedVersion.version_number} vs Current
                </h4>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<EyeOff className="w-3.5 h-3.5" />}
                    showChevron={false}
                    onClick={() => setCompareMode(false)}
                  >
                    Exit Compare
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    showChevron={false}
                    onClick={() => { setSelectedVersion(null); setCompareMode(false); setConfirmRestore(null); }}
                  >
                    Close
                  </Button>
                </div>
              </div>
              {/* Price comparison summary */}
              {(() => {
                const vTotal = selectedVersion.snapshot_data?.quote?.total_price || 0;
                const cTotal = totals.totalPrice;
                const diff = cTotal - vTotal;
                return (
                  <div className={`rounded-lg p-3 mb-3 text-sm ${diff > 0 ? 'bg-green-50 text-green-800' : diff < 0 ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-secondary'}`}>
                    V{selectedVersion.version_number} Total: {fmt(vTotal)} &rarr; Current: {fmt(cTotal)}
                    {diff !== 0 && (
                      <span className="ml-2 font-medium">
                        ({diff > 0 ? '+' : ''}{fmt(diff)})
                      </span>
                    )}
                  </div>
                );
              })()}
              {/* Item-level comparison */}
              {(() => {
                const versionItems = (selectedVersion.snapshot_data?.sections || []).flatMap(
                  s => (s.items || []).map(i => ({ ...i, section: s.section_name }))
                );
                const currentItems = sections.flatMap(
                  s => s.items.filter(i => i.product_id).map(i => ({
                    product_id: i.product_id,
                    product_name: i.product?.product_name || '',
                    price_per_unit: i.price_per_unit,
                    total_price: i.total_price,
                    total_units_needed: i.total_units_needed,
                    section: s.section_name,
                  }))
                );
                const vMap = new Map(versionItems.map(i => [i.product_id, i]));
                const cMap = new Map(currentItems.map(i => [i.product_id, i]));
                const allProductIds = new Set([...vMap.keys(), ...cMap.keys()]);

                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-200 text-secondary">
                          <th className="text-left py-1 pr-2">Product</th>
                          <th className="text-right py-1 px-2">V{selectedVersion.version_number} Price</th>
                          <th className="text-right py-1 px-2">Current Price</th>
                          <th className="text-right py-1 px-2">V{selectedVersion.version_number} Total</th>
                          <th className="text-right py-1 pl-2">Current Total</th>
                          <th className="text-right py-1 pl-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from(allProductIds).map((pid) => {
                          const vItem = vMap.get(pid);
                          const cItem = cMap.get(pid);
                          const isAdded = !vItem && cItem;
                          const isRemoved = vItem && !cItem;
                          const priceChanged = vItem && cItem && Math.abs(vItem.price_per_unit - cItem.price_per_unit) > 0.001;
                          const bgClass = isAdded ? 'bg-green-50' : isRemoved ? 'bg-red-50' : priceChanged ? 'bg-amber-50' : '';
                          return (
                            <tr key={pid} className={`border-b border-gray-100 ${bgClass}`}>
                              <td className="py-1 pr-2 text-nav-dark">{vItem?.product_name || cItem?.product_name || ''}</td>
                              <td className="py-1 px-2 text-right text-secondary">{vItem ? fmt(vItem.price_per_unit) : '-'}</td>
                              <td className="py-1 px-2 text-right text-secondary">{cItem ? fmt(cItem.price_per_unit) : '-'}</td>
                              <td className="py-1 px-2 text-right text-secondary">{vItem ? fmt(vItem.total_price) : '-'}</td>
                              <td className="py-1 pl-2 text-right text-secondary">{cItem ? fmt(cItem.total_price) : '-'}</td>
                              <td className="py-1 pl-2 text-right">
                                {isAdded && <Badge variant="success">Added</Badge>}
                                {isRemoved && <Badge variant="error">Removed</Badge>}
                                {priceChanged && <Badge variant="warning">Changed</Badge>}
                                {!isAdded && !isRemoved && !priceChanged && <span className="text-secondary">-</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          )}
        </Card>
      )}

      {!id && quoteTemplates.length > 0 && (
        <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg">
          <label className="text-sm font-medium">Start from Template:</label>
          <select
            onChange={handleSelectTemplate}
            defaultValue=""
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5"
          >
            <option value="">Blank Quote</option>
            {quoteTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.template_name}</option>
            ))}
          </select>
          {!customerId && (
            <span className="text-xs text-secondary">Select a customer first to use a template</span>
          )}
        </div>
      )}

      <Card>
        <CardHeader title="Quote" accent="Details" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">
              Customer
            </label>
            <SearchableSelect
              options={customers.map((c) => ({ value: c.id, label: c.farm_name }))}
              value={customerId}
              onChange={handleCustomerChange}
              placeholder="Select a customer..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1">
              Pricing Tier
            </label>
            <select
              value={tier}
              onChange={(e) => {
                const t = parseInt(e.target.value);
                setTier(t);
                recalcAllForTier(t);
              }}
              className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value={1}>Tier 1</option>
              <option value={2}>Tier 2</option>
              <option value={3}>Tier 3</option>
            </select>
          </div>
          <Input
            label="Valid Days"
            type="number"
            value={validDays}
            onChange={(e) => setValidDays(parseInt(e.target.value) || 15)}
            min={0}
          />
          <div className="sm:col-span-2 lg:col-span-4">
            <CommissionSplitEditor
              value={commissionSplit}
              onChange={(val) => {
                commissionSplitTouchedRef.current = true;
                setCommissionSplit(val);
              }}
            />
          </div>
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium text-secondary mb-1">
            Header Notes
          </label>
          <textarea
            value={headerNotes}
            onChange={(e) => setHeaderNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            placeholder="Notes visible at the top of the quote..."
          />
        </div>
      </Card>

      {rupWarnings.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-800">
              {rupWarnings.map((w, i) => <p key={i}>{w}</p>)}
            </div>
          </div>
        </div>
      )}

      {sections.map((sec) => {
        const isCollapsed = collapsedSections.has(sec._key);
        const sectionTotal = sec.items.reduce((s, i) => s + i.total_price, 0);

        return (
          <Card key={sec._key} padding={false}>
            <div className="p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1">
                  <button
                    onClick={() => toggleSectionCollapse(sec._key)}
                    className="p-1 rounded hover:bg-gray-100 text-secondary"
                    aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
                  >
                    {isCollapsed ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronUp className="w-4 h-4" />
                    )}
                  </button>
                  <span className="text-xs font-mono text-gray-400 w-6">
                    {sec.sort_order}
                  </span>
                  <input
                    value={sec.section_name}
                    onChange={(e) => updateSectionName(sec._key, e.target.value)}
                    className="text-sm font-semibold font-heading text-nav-dark bg-transparent border-none outline-none focus:ring-0 flex-1"
                    placeholder="Section name"
                  />
                  {/* U13 (#111): per-section job badge — a section that already has a
                      scheduled job links straight to it (and the Schedule Job button
                      below hides, since a 2nd job per section is rejected server-side). */}
                  {sec.id && sectionJobs[sec.id] && (
                    <button
                      type="button"
                      onClick={() => navigate(`/jobs/${sectionJobs[sec.id as string].id}`)}
                      className="flex-shrink-0"
                      title="Open the job scheduled from this section"
                    >
                      <Badge variant={statusToBadgeVariant[sectionJobs[sec.id as string].status] || 'info'}>
                        Job {sectionJobs[sec.id as string].job_number}
                      </Badge>
                    </button>
                  )}
                  <span className="text-sm font-mono text-secondary">
                    {fmt(sectionTotal)}
                  </span>
                  {isPlanned && (
                    <>
                      <div className="flex items-center gap-2 ml-2">
                        <label className="text-xs text-secondary whitespace-nowrap flex items-center">Needed By:<HelpTip text="This is when the customer needs the product — different from the quote expiration. Used for inventory forecasting and delivery scheduling." className="ml-1" /></label>
                        <input
                          type="date"
                          value={sec.needed_by_date || ''}
                          onChange={(e) => updateSectionField(sec._key, 'needed_by_date', e.target.value || null)}
                          className="text-sm border border-gray-200 rounded px-2 py-1"
                        />
                      </div>
                      {/* Holds have one row per quote item; this per-section view aggregates the quote's matching rows for each product. */}
                      {quoteId && activePlannedHolds.length > 0 && (
                        <div className="ml-2 flex flex-col items-start gap-0.5 text-xs text-secondary">
                          {Array.from(new Set(sec.items.map((item) => item.product_id).filter(Boolean))).map((productId) => {
                            const holds = activePlannedHolds.filter((candidate) => candidate.product_id === productId);
                            if (holds.length === 0) return null;
                            const heldQuantity = holds.reduce((sum, hold) => sum + hold.quantity, 0);
                            const earliestExpiry = holds.reduce<string | null>((earliest, hold) => {
                              if (hold.expires_at == null) return earliest;
                              return earliest == null || hold.expires_at < earliest ? hold.expires_at : earliest;
                            }, null);
                            const unit = products.find((product) => product.id === productId)?.inventory_unit;
                            const isLapsed = earliestExpiry != null && earliestExpiry.slice(0, 10) <= localToday();
                            return (
                              <span key={productId}>
                                Held: {heldQuantity}{unit ? ` ${unit}` : ''} &middot; {earliestExpiry ? (
                                  <>expires <span className={isLapsed ? 'text-red-600 font-medium' : undefined}>{parseLocalDate(earliestExpiry.slice(0, 10)).toLocaleDateString()}{isLapsed ? ' (lapsed)' : ''}</span></>
                                ) : 'no expiry (no needed-by date)'}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                  <div className="flex items-center gap-2 ml-2">
                    <label className="text-xs text-secondary whitespace-nowrap">Field:</label>
                    <select
                      value={sec.field_id || ''}
                      onChange={(e) => handleSectionFieldChange(sec._key, e.target.value || null)}
                      className="text-sm border border-gray-200 rounded px-2 py-1 max-w-[180px]"
                    >
                      <option value="">— None —</option>
                      {(customerId
                        ? fields.filter(f => f.customer_id === customerId)
                        : fields
                      ).map(f => (
                        <option key={f.id} value={f.id}>{f.field_name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Plus className="w-3 h-3" />}
                    showChevron={false}
                    onClick={() => addItem(sec._key)}
                  >
                    Add Item
                  </Button>
                  {canScheduleJobs && quoteId && sec.id && sec.items.length > 0 && !sectionJobs[sec.id] && (
                    <Button variant="ghost" size="sm" icon={<CalendarClock className="w-3 h-3" />} showChevron={false} onClick={() => currentStatus === 'draft' ? setConfirmDraftScheduleKey(sec._key) : handleScheduleJob(sec._key)} loading={schedulingJobSectionKey === sec._key}>
                      Schedule Job
                    </Button>
                  )}
                  {scheduleBlockedAccepted && quoteId && sec.id && sec.items.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-xs text-secondary">
                      <XCircle className="w-3 h-3 text-orange-500" />
                      Sold — make a standalone job
                      <HelpTip text="This booking was accepted and converted to a chemical sale (order). To do field work, create a standalone job from the Jobs page — scheduling from a sold booking would double-count the product." />
                    </span>
                  )}
                  {sections.length > 1 && (
                    <button
                      onClick={() => removeSection(sec._key)}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                      aria-label="Remove section"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {!isCollapsed && (
              <>
              {/* Section Header Notes — above items table */}
              <div className="px-5 pb-2">
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-xs text-secondary">Section Header Notes</span>
                  <HelpTip text="These notes print above the items in the PDF. Use for delivery instructions like 'Apply before 10am' or 'Requires cool storage'." className="ml-1" />
                </div>
                <textarea
                  value={sec.section_header_notes || ''}
                  onChange={(e) => updateSectionField(sec._key, 'section_header_notes', e.target.value || null)}
                  rows={2}
                  placeholder="Section notes for grower (shown above products on PDF)..."
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
                />
              </div>
              <div className="overflow-x-auto">
                {sec.items.length === 0 ? (
                  <div className="px-5 pb-5">
                    <p className="text-sm text-secondary">
                      No items in this section.{' '}
                      <button
                        onClick={() => addItem(sec._key)}
                        className="text-crx-green hover:underline font-medium"
                      >
                        Add one
                      </button>
                    </p>
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-t border-gray-100 text-left text-xs text-secondary uppercase tracking-wide">
                        <th className="px-5 py-3 font-medium w-8">#</th>
                        <th className="px-3 py-3 font-medium min-w-[200px]">Product</th>
                        <th className="px-3 py-3 font-medium">Price/Unit</th>
                        {!customerView && <th className="px-3 py-3 font-medium">Cost</th>}
                        <th className="px-3 py-3 font-medium">Sug. Rate</th>
                        <th className="px-3 py-3 font-medium">Actual Rate</th>
                        <th className="px-3 py-3 font-medium">Unit</th>
                        <th className="px-3 py-3 font-medium">Acres</th>
                        <th className="px-3 py-3 font-medium">Oz/Acre</th>
                        <th className="px-3 py-3 font-medium">$/Acre</th>
                        <th className="px-3 py-3 font-medium">Units Needed</th>
                        <th className="px-3 py-3 font-medium">Total</th>
                        <th className="px-3 py-3 font-medium min-w-[140px]">Notes</th>
                        {!customerView && <th className="px-3 py-3 font-medium">Profit</th>}
                        {!customerView && <th className="px-3 py-3 font-medium">Margin</th>}
                        <th className="px-3 py-3 font-medium w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {sec.items.map((item) => {
                        const prod =
                          item.product ||
                          products.find((p) => p.id === item.product_id);
                        return (
                          <tr
                            key={item._key}
                            className="border-t border-gray-50 hover:bg-crx-green-tint transition-colors"
                          >
                            <td className="px-5 py-2 font-mono text-gray-400 text-xs">
                              {item.sort_order}
                            </td>
                            <td className="px-3 py-2">
                              {prod ? (
                                <button
                                  onClick={() => {
                                    setProductSearchOpen({
                                      sectionKey: sec._key,
                                      itemKey: item._key,
                                    });
                                    setProductQuery('');
                                  }}
                                  className="text-left"
                                >
                                  <p className="font-medium text-nav-dark truncate max-w-[200px]">
                                    {prod.product_name}
                                  </p>
                                  <ProductOptionDetails product={prod} />
                                </button>
                              ) : (
                                <button
                                  onClick={() => {
                                    setProductSearchOpen({
                                      sectionKey: sec._key,
                                      itemKey: item._key,
                                    });
                                    setProductQuery('');
                                  }}
                                  className="text-crx-green hover:underline font-medium flex items-center gap-1"
                                >
                                  <Search className="w-3 h-3" />
                                  Select Product
                                </button>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  value={item.price_per_unit || ''}
                                  onChange={(e) => {
                                    const val = e.target.value ? parseFloat(e.target.value) : 0;
                                    const tierPrice = prod ? getTierPrice(prod, tier) : 0;
                                    const isOverride = Math.abs(val - tierPrice) > 0.001;
                                    updateItem(sec._key, item._key, {
                                      price_override: isOverride ? val : null,
                                      price_per_unit: val,
                                    });
                                  }}
                                  aria-label="Price per unit"
                                  className={`w-20 px-2 py-1 text-sm font-mono border rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green ${
                                    item.price_override != null
                                      ? 'border-amber-400 bg-amber-50'
                                      : 'border-gray-200'
                                  }`}
                                  step="any"
                                  min={0}
                                />
                                {item.price_override != null && (
                                  <button
                                    onClick={() =>
                                      updateItem(sec._key, item._key, {
                                        price_override: null,
                                      })
                                    }
                                    title={`Reset to tier ${tier} price: ${fmt(prod ? getTierPrice(prod, tier) : 0)}`}
                                    className="p-0.5 rounded text-amber-500 hover:text-amber-700 hover:bg-amber-100 transition-colors"
                                  >
                                    <RotateCcw className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                              <select
                                value={item.price_unit || ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    price_unit: e.target.value || null,
                                  })
                                }
                                aria-label="Price unit"
                                className="w-20 px-1 py-0.5 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green mt-0.5"
                              >
                                <option value="">--</option>
                                {unitConversions
                                  .filter((uc) => {
                                    const form = prod?.product_form;
                                    if (!form) return true;
                                    return uc.unit_type === form || uc.unit_type === 'both';
                                  })
                                  .map((uc) => (
                                    <option key={uc.id} value={uc.unit}>
                                      per {uc.unit}
                                    </option>
                                  ))}
                              </select>
                            </td>
                            {!customerView && (
                              <td className="px-3 py-2 font-mono text-secondary">
                                {fmt(item.current_cost)}
                              </td>
                            )}
                            <td className="px-3 py-2 text-secondary">
                              {item.suggested_rate || '-'}
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                value={item.actual_rate ?? ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    actual_rate: e.target.value
                                      ? parseFloat(e.target.value)
                                      : null,
                                    calc_mode: 'rate_acres',
                                  })
                                }
                                aria-label="Actual rate"
                                className="w-20 px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                                step="any"
                                min={0}
                              />
                            </td>
                            <td className="px-3 py-2">
                              <select
                                value={item.rate_unit || ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    rate_unit: e.target.value || null,
                                  })
                                }
                                aria-label="Rate unit"
                                className="w-20 px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                              >
                                <option value="">--</option>
                                {unitConversions
                                  .filter((uc) => {
                                    const form = prod?.product_form;
                                    if (!form) return true;
                                    return uc.unit_type === form || uc.unit_type === 'both';
                                  })
                                  .map((uc) => (
                                    <option key={uc.id} value={uc.unit}>
                                      {uc.unit}
                                    </option>
                                  ))}
                              </select>
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                value={item.acres ?? ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    acres: e.target.value
                                      ? parseFloat(e.target.value)
                                      : null,
                                    calc_mode: item.calc_mode === 'units_direct'
                                      ? 'units_direct' // keep units_direct if typing acres alongside units
                                      : 'rate_acres',
                                  })
                                }
                                aria-label="Acres"
                                className="w-20 px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green"
                                step="any"
                                min={0}
                              />
                            </td>
                            <td className="px-3 py-2 font-mono text-secondary">
                              {item.oz_per_acre != null
                                ? item.oz_per_acre.toFixed(2)
                                : '-'}
                            </td>
                            <td className="px-3 py-2 font-mono text-secondary">
                              {item.price_per_acre != null
                                ? fmt(item.price_per_acre)
                                : '-'}
                            </td>
                            <td className="px-3 py-2">
                              <input
                                type="number"
                                value={item.total_units_needed ?? ''}
                                onChange={(e) =>
                                  updateItem(sec._key, item._key, {
                                    total_units_needed: e.target.value
                                      ? parseFloat(e.target.value)
                                      : null,
                                    calc_mode: 'units_direct',
                                  })
                                }
                                aria-label="Units needed"
                                className={`w-20 px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30 focus:border-crx-green font-mono ${
                                  item.calc_mode === 'units_direct'
                                    ? 'border-crx-green bg-crx-green-tint'
                                    : 'border-gray-200'
                                }`}
                                step="any"
                                min={0}
                              />
                            </td>
                            <td className="px-3 py-2 font-mono font-medium text-nav-dark">
                              {fmt(item.total_price)}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-1">
                                <textarea
                                  value={item.notes || ''}
                                  onChange={(e) => updateItem(sec._key, item._key, { notes: e.target.value || null })}
                                  rows={1}
                                  placeholder="Product notes..."
                                  className="w-full text-xs border border-gray-200 rounded px-2 py-1 focus:ring-1 focus:ring-crx-green/20 resize-none"
                                />
                                {prod && preferredQuoteNotes(prod)
                                  && item.notes !== preferredQuoteNotes(prod) && (
                                  <button
                                    onClick={() => updateItem(sec._key, item._key, { notes: preferredQuoteNotes(prod) })}
                                    title="Reset to default"
                                    className="text-xs text-crx-green hover:underline whitespace-nowrap"
                                  >
                                    Reset
                                  </button>
                                )}
                              </div>
                            </td>
                            {!customerView && (
                              <td className="px-3 py-2 font-mono text-emerald-600">
                                {fmt(item.profit)}
                              </td>
                            )}
                            {!customerView && (
                              <td className="px-3 py-2 font-mono text-secondary">
                                {pct(item.net_margin)}
                              </td>
                            )}
                            <td className="px-3 py-2">
                              <button
                                onClick={() => removeItem(sec._key, item._key)}
                                className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                aria-label="Remove line item"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              </>
            )}
          </Card>
        );
      })}

      <div className="flex justify-center">
        <Button
          variant="secondary"
          icon={<Plus className="w-4 h-4" />}
          showChevron={false}
          onClick={addSection}
        >
          Add Section
        </Button>
      </div>

      <Card>
        <div>
          <label className="block text-sm font-medium text-secondary mb-1">
            Footer Notes
          </label>
          <textarea
            value={footerNotes}
            onChange={(e) => setFooterNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            placeholder="Notes visible at the bottom of the quote (terms, disclaimers, etc.)..."
          />
        </div>
      </Card>

      <Card>
        <CardHeader title="Quote" accent="Totals" />
        <div className={`grid grid-cols-2 ${customerView ? 'sm:grid-cols-1' : 'sm:grid-cols-4'} gap-4`}>
          <div>
            <p className="text-xs text-secondary uppercase tracking-wide mb-1">
              Total Price
            </p>
            <p className="text-xl font-semibold font-heading text-nav-dark font-mono">
              {fmt(totals.totalPrice)}
            </p>
          </div>
          {!customerView && (
            <div>
              <p className="text-xs text-secondary uppercase tracking-wide mb-1">
                Total Cost
              </p>
              <p className="text-xl font-semibold font-heading text-secondary font-mono">
                {fmt(totals.totalCost)}
              </p>
            </div>
          )}
          {!customerView && (
            <div>
              <p className="text-xs text-secondary uppercase tracking-wide mb-1">
                Total Profit
              </p>
              <p className="text-xl font-semibold font-heading text-emerald-600 font-mono">
                {fmt(totals.totalProfit)}
              </p>
            </div>
          )}
          {!customerView && (
            <div>
              <p className="text-xs text-secondary uppercase tracking-wide mb-1">
                Overall Margin
              </p>
              <p className="text-xl font-semibold font-heading text-crx-green font-mono">
                {totals.totalMarginPct.toFixed(1)}%
              </p>
            </div>
          )}
        </div>
      </Card>

      <Modal
        open={productSearchOpen !== null}
        onClose={closeProductPicker}
        title="Select"
        accent="Product"
        maxWidth="max-w-2xl"
      >
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="Search by name, SKU, category, or vendor..."
              // eslint-disable-next-line jsx-a11y/no-autofocus -- search input in just-opened picker; user expects to type immediately
              autoFocus
            />
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={keepProductPickerOpen}
              onChange={(e) => setKeepProductPickerOpen(e.target.checked)}
              className="rounded border-gray-300 text-crx-green focus:ring-crx-green"
            />
            Keep open &mdash; add several
          </label>
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {filteredProducts.length === 0 ? (
              <p className="text-sm text-secondary py-4 text-center">
                No products found
              </p>
            ) : (
              filteredProducts.map((p) => {
                // P2-5: catalog $/acre at this tier, computed correctly from the
                // product's own rate + units (NOT the broken tierN_price_per_acre
                // columns) — matches what the line will show once added.
                const perAcre = catalogPricePerAcre(p, tier, unitConversions);
                return (
                <ProductSearchResultRow
                  key={p.id}
                  product={p}
                  onClick={() => {
                    if (productSearchOpen) assignProduct(productSearchOpen.sectionKey, productSearchOpen.itemKey, p);
                  }}
                  trailing={<><p className="font-mono text-sm text-nav-dark">{fmt(getTierPrice(p, tier))}</p><p className="text-xs text-gray-400">T{tier} price</p>{perAcre != null && <p className="text-xs font-mono text-crx-green" title={`Approx. $/acre at tier ${tier}, applied at this product's standard rate`}>{fmt(perAcre)}/ac</p>}</>}
                />
                );
              })
            )}
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmConvertOpen}
        onClose={() => setConfirmConvertOpen(false)}
        title="Convert to"
        accent="Order"
      >
        <div className="space-y-4">
          <GuardrailBanner warning={staleWarning} onDismiss={dismissStaleWarning} />
          <p className="text-sm text-secondary">
            This will accept the quote and create a new order for{' '}
            {selectedCustomer?.farm_name || 'the customer'} with all line items. The
            quote status will be updated to accepted.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              showChevron={false}
              onClick={() => setConfirmConvertOpen(false)}
            >
              Cancel
            </Button>
            <Button
              icon={<ShoppingCart className="w-4 h-4" />}
              onClick={handleConvertToOrder}
              loading={converting}
            >
              Create Order
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showPreviewModal}
        onClose={() => { setShowPreviewModal(false); if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl); }}
        title="Quote"
        accent="Preview"
      >
        {/* PDF Column Template Picker */}
        <div className="flex items-center gap-3 mb-3">
          <select
            value={selectedTemplateId || ''}
            onChange={(e) => { setSelectedTemplateId(e.target.value); setCustomColumns(null); }}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5"
          >
            {pdfTemplates.map((t) => (
              <option key={t.id} value={t.id}>{t.template_name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowColumnPicker(!showColumnPicker)}
            className="text-sm text-crx-green hover:underline"
          >
            {showColumnPicker ? 'Hide Columns' : 'Customize Columns'}
          </button>
        </div>
        {showColumnPicker && (
          <div className="flex flex-wrap gap-2 mb-3 p-3 bg-gray-50 rounded-lg">
            {AVAILABLE_PDF_COLUMNS.map((col) => {
              const activeColumns = customColumns || getTemplateColumns(selectedTemplateId);
              const isActive = activeColumns.includes(col.key);
              return (
                <label key={col.key} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={() => {
                      const cols = [...activeColumns];
                      if (isActive) cols.splice(cols.indexOf(col.key), 1);
                      else cols.push(col.key);
                      setCustomColumns(cols);
                    }}
                  />
                  {col.label}
                </label>
              );
            })}
          </div>
        )}
        <div className="h-[60vh]">
          <iframe src={previewPdfUrl || ''} className="w-full h-full border rounded-lg" title="Quote PDF Preview" />
        </div>
        <div className="flex justify-end gap-3 mt-4 pt-4 border-t">
          <Button
            variant="secondary"
            icon={<Download className="w-4 h-4" />}
            showChevron={false}
            onClick={handleDownloadPdf}
          >
            Download PDF
          </Button>
          <Button
            variant="secondary"
            icon={<CheckCircle className="w-4 h-4" />}
            onClick={handleMarkPresented}
            disabled={status !== 'draft' && status !== 'revised'}
          >
            Mark as Presented
          </Button>
          <HelpTip text="Marks the quote as sent WITHOUT emailing &mdash; use when you presented it in person" className="ml-1" />
          <Button
            variant="primary"
            icon={<Send className="w-4 h-4" />}
            showChevron={false}
            onClick={handleEmailToGrower}
            loading={emailingGrower}
          >
            Email to Grower
          </Button>
          {lastQuoteEmailAt && (
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
              Emailed {new Date(lastQuoteEmailAt).toLocaleDateString()} ✓
            </span>
          )}
          <HelpTip text="Emails the quote PDF to the grower and logs it" className="ml-1" />
        </div>
      </Modal>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />

      {showSaveTemplateModal && (
        <Modal open={showSaveTemplateModal} onClose={() => setShowSaveTemplateModal(false)} title="Save as Template">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Template Name</label>
              <input
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="e.g., 2026 Soybean Program"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Description (optional)</label>
              <textarea
                value={templateDescription}
                onChange={(e) => setTemplateDescription(e.target.value)}
                placeholder="When to use this template..."
                rows={2}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowSaveTemplateModal(false)}
                className="px-4 py-2 text-sm border rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveTemplate}
                disabled={!templateName.trim()}
                className="px-4 py-2 text-sm bg-crx-green text-white rounded-lg disabled:opacity-50"
              >
                Save Template
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showDrawModal && (
        <Modal open={showDrawModal} onClose={() => setShowDrawModal(false)} title="Create Order from Booking">
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Enter how much of each booked product to send now. The quote keeps the
              remaining balance and stays open until it is fully drawn.
            </p>
            {drawLoading ? (
              <p className="text-sm text-secondary">Loading booking balance…</p>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-secondary border-b">
                      <th className="py-2 pr-2">Product</th>
                      <th className="py-2 pr-2 text-right">Booked</th>
                      <th className="py-2 pr-2 text-right">Drawn</th>
                      <th className="py-2 pr-2 text-right">Remaining</th>
                      <th className="py-2 text-right">Send now</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drawRows.map((row, idx) => (
                      <tr key={row.product_id} className="border-b last:border-0">
                        <td className="py-2 pr-2">{row.product_name}</td>
                        <td className="py-2 pr-2 text-right">{row.booked}{row.unit ? ` ${row.unit}` : ''}</td>
                        <td className="py-2 pr-2 text-right">{row.drawn}{row.unit ? ` ${row.unit}` : ''}</td>
                        <td className="py-2 pr-2 text-right font-medium">{row.remaining}{row.unit ? ` ${row.unit}` : ''}</td>
                        <td className="py-2 text-right">
                          <div className="inline-flex items-center gap-1">
                            <input
                              type="number"
                              min={0}
                              max={row.remaining}
                              step="any"
                              value={row.qty}
                              disabled={row.remaining <= 0}
                              onChange={(e) => {
                                const next = [...drawRows];
                                next[idx] = { ...row, qty: e.target.value };
                                setDrawRows(next);
                              }}
                              className="w-24 px-2 py-1 text-sm text-right border border-gray-200 rounded-lg disabled:bg-gray-50"
                            />
                            {row.unit && <span className="text-xs text-secondary">{row.unit}</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDrawModal(false)}
                className="px-4 py-2 text-sm border rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleDrawDown}
                disabled={drawing || drawLoading || !drawRows.some((r) => (parseFloat(r.qty) || 0) > 0)}
                className="px-4 py-2 text-sm bg-crx-green text-white rounded-lg disabled:opacity-50"
              >
                {drawing ? 'Creating…' : 'Create Order'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showRolloverModal && (
        <Modal open={showRolloverModal} onClose={() => setShowRolloverModal(false)} title="Roll Over to New Season">
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Creates a new draft quote with the same products and program structure,
              but with updated pricing from current product prices.
              Need dates will be reset.
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">Target Season</label>
              <input
                type="number"
                value={rolloverSeason}
                onChange={(e) => setRolloverSeason(parseInt(e.target.value))}
                className="w-32 px-3 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowRolloverModal(false)}
                className="px-4 py-2 text-sm border rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleRollover}
                className="px-4 py-2 text-sm bg-crx-green text-white rounded-lg"
              >
                Roll Over
              </button>
            </div>
          </div>
        </Modal>
      )}

      <RecordVersionConflictDialog
        open={staleSaveOpen}
        entityLabel="quote"
        onKeepEditing={() => {
          // The dialog is no longer offering to recover anything, so its recorded
          // origin must not outlive it. Keeping the record here is what let a
          // dismissed conflict on one quote block the next quote's release.
          staleSaveConflictScopeRef.current = null;
          setStaleSaveOpen(false);
        }}
        onReload={reloadAfterStaleSave}
      />

      <ConfirmModal
        open={confirmBookAsOrderOpen}
        onClose={() => setConfirmBookAsOrderOpen(false)}
        onConfirm={handleBookAsOrder}
        title="Book as Order"
        message="Mark this quote as sent and convert it to an order now?"
        confirmLabel="Book as Order"
        variant="info"
        icon={ShoppingCart}
        loading={bookingAsOrder || converting}
      />

      <ConfirmModal
        open={confirmDeclineOpen}
        onClose={() => setConfirmDeclineOpen(false)}
        onConfirm={() => setTerminalStatus('declined')}
        title="Decline Quote"
        message={`Mark quote ${quoteNumber} as declined? This releases any inventory holds and is terminal — an admin can reopen it later if needed.`}
        confirmLabel="Decline Quote"
        variant="danger"
        icon={XCircle}
        loading={statusActionLoading}
      />

      <ConfirmModal
        open={confirmCancelOpen}
        onClose={() => setConfirmCancelOpen(false)}
        onConfirm={() => setTerminalStatus('cancelled')}
        title="Cancel Quote"
        message={`Cancel quote ${quoteNumber}? This releases any inventory holds and is terminal — an admin can reopen it later if needed.`}
        confirmLabel="Cancel Quote"
        variant="danger"
        icon={Ban}
        loading={statusActionLoading}
      />

      <ConfirmModal
        open={confirmCloseAppliedOpen}
        onClose={() => setConfirmCloseAppliedOpen(false)}
        onConfirm={handleCloseAsApplied}
        title="Close — Fulfilled by Application"
        message={`Close booking ${quoteNumber} as fulfilled by application (WE applied the product for the customer)? Any product still un-applied is released back to free inventory. The customer was already billed through each job's application invoice, so this never bills again. This is terminal.`}
        confirmLabel="Close Booking"
        icon={CheckCircle}
        loading={closingApplied}
      />

      <ConfirmModal
        open={confirmCloseShortOpen}
        onClose={() => setConfirmCloseShortOpen(false)}
        onConfirm={handleCloseAsShort}
        title="Close — Short (customer walked away)"
        message={`Close booking ${quoteNumber} short? Use this when the customer won't take the rest of this booking. The un-fulfilled remainder is released back to free inventory. Any product already drawn was billed on its order, so this never bills again. This is terminal. (If jobs are still scheduled against this booking, cancel or complete them first.)`}
        confirmLabel="Close Booking"
        icon={PackageOpen}
        loading={closingShort}
      />

      <ConfirmModal
        open={!!confirmDraftScheduleKey}
        onClose={() => setConfirmDraftScheduleKey(null)}
        onConfirm={() => { const k = confirmDraftScheduleKey; setConfirmDraftScheduleKey(null); if (k) handleScheduleJob(k); }}
        title="Schedule job from a draft booking?"
        message="This booking is still a draft — it hasn't been sent to the customer yet. You can schedule a job now, but the booking and its pricing may still change before it's sent. Continue?"
        confirmLabel="Schedule Anyway"
        icon={CalendarClock}
      />

      {showRevertModal && (
        <Modal open={showRevertModal} onClose={() => { if (!reverting) { setShowRevertModal(false); setRevertReason(''); } }} title={`${revertLabel} Quote`}>
          <div className="space-y-4">
            <p className="text-sm text-secondary">
              Reopens quote {quoteNumber} back to <strong>sent</strong> so it can be edited,
              re-sent, or converted again.{' '}
              {currentStatus === 'accepted'
                ? 'Blocked if an order has already been created from this quote.'
                : 'The quote re-enters the active pipeline.'}
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">Reason <span className="text-red-600">*</span></label>
              <textarea
                value={revertReason}
                onChange={(e) => setRevertReason(e.target.value)}
                maxLength={MAX_REVERT_REASON_LENGTH}
                rows={3}
                placeholder="Why is this quote being reopened?"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <p className="mt-1 text-xs text-secondary text-right">
                {revertReason.length}/{MAX_REVERT_REASON_LENGTH}
              </p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setShowRevertModal(false); setRevertReason(''); }}
                disabled={reverting}
                className="px-4 py-2 text-sm border rounded-lg disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRevertStatus}
                disabled={reverting || !revertReason.trim()}
                className="px-4 py-2 text-sm bg-crx-green text-white rounded-lg disabled:opacity-50"
              >
                {reverting ? 'Reopening…' : revertLabel}
              </button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmModal
        open={duplicateOrderConfirmOpen}
        onClose={() => setDuplicateOrderConfirmOpen(false)}
        onConfirm={executeConvertToOrder}
        title="Duplicate Order Warning"
        message={duplicateOrderMsg}
        confirmLabel="Convert Anyway"
        variant="warning"
      />
    </div>
  );
}
