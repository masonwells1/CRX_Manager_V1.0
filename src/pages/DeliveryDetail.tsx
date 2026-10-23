import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Phone, MapPin, CheckCircle2, Package, Download, WifiOff,
  Minus, Plus, Pencil, Ban, Camera, UserPlus, AlertTriangle, RefreshCw,
  PlayCircle, Lock, Zap, FileText, Mail, RotateCcw, MessageSquarePlus,
} from 'lucide-react';
import Card from '../components/ui/Card';
import { LoadFailedState } from '../components/ui/EmptyState';
import HelpTip from '../components/ui/HelpTip';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import SignatureCanvas from '../components/ui/SignatureCanvas';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, supabaseUntyped, assertRpcResult, sanitizeError, checkMutationResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useLatestRef } from '../hooks/useLatestRef';
import { digestIntentPayload, getIdempotencyBindingRejection } from '../lib/idempotency';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { downloadDeliveryPdf } from '../lib/deliveryPdf';
import { logActivity } from '../lib/activityLogger';
import { sumNeedByProduct } from '../lib/inventoryShortage';
import { sendEmail } from '../lib/emailService';
import { buildDeliveryReceiptHtml } from '../lib/deliveryReceiptEmail';
import { RECEIPT_NO_EMAIL_MESSAGE, RECEIPT_NO_EMAIL_ON_FILE_MESSAGE, RECEIPT_NOT_SENT_MESSAGE } from '../lib/deliveryCompletionEmail';
import { COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE, fetchReceiptRecipient, fetchReceiptRecipientWithin, INVALID_SIGNATURE_MESSAGE, isNetworkFailure, isSignatureDataUrl, isSignatureImageMissing, latestEvidencePhoto, reconcileFailedCompletion, signatureDigest, signatureImagePathFor, storedNoProofReason, uploadSignatureImage } from '../lib/deliveryEvidence';
import { notifyDeliveryRemainder, notifyDeliveryCompleted } from '../lib/notificationTriggers';
import { checkRUPCompliance } from '../lib/rupCompliance';
import StartDeliveryModal from '../components/deliveries/StartDeliveryModal';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { hasSignal, NO_SIGNAL_MESSAGE } from '../lib/connectivity';
import { countOrdinaryPhotos, countPaperTicketPhotos, hasPaperTicketPhoto, MAX_ORDINARY_DELIVERY_PHOTOS, MAX_PAPER_TICKET_PHOTOS, PAPER_TICKET_PHOTO_CAPTION, isValidPaperDeliveredOn, paperDeliveredAt, completedAtForKey, isValidNoProofReason, NO_PROOF_REASON_MAX_CHARS, NO_PROOF_REASON_MIN_CHARS, NO_PROOF_SIGNER, noProofReasonLength } from '../lib/paperTicket';
import type { Json } from '../types/supabase';
import { compressImage } from '../lib/imageCompression';
import { parseLocalDate, todayInBusinessTz } from '../lib/dateUtils';
import { formatCents as fmtCents } from '../lib/money';
import { Sentry } from '../lib/sentry';
import { fetchAllRows, fetchAllRowsForIds } from '../lib/pagedRead';
import { activeInvoiceCoversDelivery } from '../lib/deliveryInvoiceCoverage';
import { fetchSplitBillingOrderIds, SPLIT_BILLING_BLOCK_REASON } from '../lib/deliverySplitBilling';
import { ProductOptionDetails, productOptionLabel, type ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';
import { addDeliveryEditItem, removeDeliveryEditItem, type AvailableDeliveryEditItem, type DeliveryEditItem } from '../lib/deliveryEditItems';
import QuickTaskModal from '../components/team/QuickTaskModal';
import RelatedNotes from '../components/team/RelatedNotes';
import TransactionThread from '../components/ui/TransactionThread';
import PrivatePhoto, { PrivatePhotoButton } from '../components/ui/PrivatePhoto';
import { deliveryPhotoPath } from '../lib/privatePhotos';
import { ORDER_ITEM_COLUMNS } from '../lib/costFields';
import type {
  Delivery, DeliveryItem, DeliveryPhoto, DeliveryRemainder,
  Customer, CustomerAddress, Profile, OrderItem, DeliveryIssueType, DeliveryCompletionEvidence, ReceiptRecipient,
  LinkedEntityType,
} from '../types';

const ISSUE_TYPE_LABELS: Record<string, string> = {
  none: 'None',
  customer_not_home: 'Customer Not Home',
  gate_locked: 'Gate Locked',
  road_blocked: 'Road Blocked',
  wrong_address: 'Wrong Address',
  refused: 'Refused',
  weather: 'Weather',
  other: 'Other',
};

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
const PRIORITY_BADGE: Record<string, BadgeVariant> = {
  low: 'default',
  normal: 'info',
  high: 'warning',
  urgent: 'error',
};

interface CreateDeliveryInvoiceResult {
  success: boolean;
  delivery_id: string;
  invoice_id: string;
  invoice_number: string;
  total_cents: number;
}


export default function DeliveryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const editIdem = useIdempotencyKey('edit_delivery', profile?.id || '');
  const cancelIdem = useIdempotencyKey('cancel_delivery', profile?.id || '');
  // F1: create_followup_delivery is the ONLY retained key on this page, and it is
  // scoped by the route id. Its payload is exactly (p_original_delivery_id,
  // p_performed_by, p_idempotency_key) — nothing a retry can vary — so the route id
  // fully binds the request. The scope is required because this component does NOT
  // remount when the route id changes (App.tsx renders it without a key, effects are
  // keyed on [id]) and the success path below navigates straight to a DIFFERENT
  // delivery; unscoped, a retained key could replay delivery A's receipt against
  // delivery B.
  const followupIdem = useIdempotencyKey('create_followup_delivery', profile?.id || '', id ?? '');
  const confirmIdem = useIdempotencyKey('confirm_delivery', profile?.id || '');
  const completeIdem = useIdempotencyKey('complete_delivery', profile?.id || '');
  // Retry key -> the p_completed_at its first send carried (see completedAtForKey).
  const sentCompletedAt = useRef(new Map<string, string | undefined>());
  const voidIdem = useIdempotencyKey('void_delivery', profile?.id || '');
  const reassignIdem = useIdempotencyKey('reassign_delivery', profile?.id || '');
  const createInvoiceIdem = useIdempotencyKey('create_invoice_for_unbilled_delivery', profile?.id || '');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const paperTicketInputRef = useRef<HTMLInputElement>(null);

  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [address, setAddress] = useState<CustomerAddress | null>(null);
  const [driver, setDriver] = useState<Profile | null>(null);
  const [photos, setPhotos] = useState<DeliveryPhoto[]>([]);
  const [remainders, setRemainders] = useState<DeliveryRemainder[]>([]);
  const [loading, setLoading] = useState(true);
  // The delivery whose last load failed. The page then shows "could not be loaded"
  // in place of a delivery with no lines (whose Edit could save over the real ones)
  // or "Delivery not found" (To-Do 10.5).
  const [loadFailedId, setLoadFailedId] = useState<string | null>(null);
  const [rupWarnings, setRupWarnings] = useState<string[]>([]);
  const [inventoryWarnings, setInventoryWarnings] = useState<string[]>([]);

  // Signature signed URL (generated on demand for privacy)
  const [signedSignatureUrl, setSignedSignatureUrl] = useState<string | null>(null);
  // The signed URL could not be made: only then (or when the image fails to load) say it cannot be shown.
  const [signatureUrlFailed, setSignatureUrlFailed] = useState(false);
  const signatureRouteIdRef = useRef(id);
  // Every photo-list read and local add takes a number; only the newest read may replace the list,
  // so a slow older read can never drop a photo added (or keep one removed) after it started.
  const photoSeqRef = useRef(0);

  // This route reuses the same component instance. Retire the previous delivery's
  // private signature before paint, and make every async URL response prove it
  // still belongs to the active route before publishing it.
  useLayoutEffect(() => {
    signatureRouteIdRef.current = id;
    setSignedSignatureUrl(null);
    setSignatureUrlFailed(false);
  }, [id]);

  // Driver completion state
  const [signedBy, setSignedBy] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  // Goal 5 paper fallback: a photo of the signed paper ticket replaces the on-screen signature.
  const [usePaperTicket, setUsePaperTicket] = useState(false);
  const [paperDeliveredOn, setPaperDeliveredOn] = useState(todayInBusinessTz());
  // Admin-only "Record without proof" (office layout): a written reason replaces the customer's proof.
  const [useNoProof, setUseNoProof] = useState(false);
  const [noProofReason, setNoProofReason] = useState('');
  const [completing, setCompleting] = useState(false);
  // Claimed synchronously at the start of a completion, so a second tap never starts a second attempt.
  const completeClaimRef = useRef(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [quickTaskOpen, setQuickTaskOpen] = useState(false);
  const [deliveryQtys, setDeliveryQtys] = useState<Record<string, number>>({});
  const [driverIssueType, setDriverIssueType] = useState<DeliveryIssueType>('none');
  const [driverIssueNotes, setDriverIssueNotes] = useState('');
  const [autoInvoiceId, setAutoInvoiceId] = useState<string | null>(null);
  const [emailOnComplete, setEmailOnComplete] = useState(true);
  // The receipt address when the customer row is hidden from this user (an assigned driver; see fetchReceiptRecipient).
  const [receiptRecipient, setReceiptRecipient] = useState<ReceiptRecipient | null>(null);
  const isOnline = useOnlineStatus();

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [editDriver, setEditDriver] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');
  const [editWindowStart, setEditWindowStart] = useState('');
  const [editWindowEnd, setEditWindowEnd] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editPriority, setEditPriority] = useState('normal');
  const [editNotes, setEditNotes] = useState('');
  const [editItems, setEditItems] = useState<Array<DeliveryEditItem<ProductOptionPresentationModel>>>([]);
  // Order items available to add (not already on delivery)
  const [availableOrderItems, setAvailableOrderItems] = useState<Array<AvailableDeliveryEditItem<ProductOptionPresentationModel>>>([]);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);

  // Cancel modal state
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  // Void modal state (admin only, completed deliveries)
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  // Reassign state
  const [reassigning, setReassigning] = useState(false);
  const [reassignConfirmOpen, setReassignConfirmOpen] = useState(false);

  // Complete delivery confirm state
  const [completeConfirmOpen, setCompleteConfirmOpen] = useState(false);

  // A follow-up delivery reuses this page. Before paint, drop everything the previous
  // delivery's completion could use: its items and quantities, signer, signature, issue,
  // paper mode, photos and an open confirm box. Until the new delivery's items load,
  // completion has nothing to submit (fails closed).
  useLayoutEffect(() => {
    // Hide the previous delivery entirely (spinner) until this route's record loads, so no
    // action (complete, cancel, void...) can be taken while the old details are on screen.
    setDelivery(null);
    setLoading(true);
    setItems([]);
    setDeliveryQtys({});
    setSignedBy('');
    setSignatureDataUrl(null);
    setDriverIssueType('none');
    setDriverIssueNotes('');
    setCompleteConfirmOpen(false);
    setUsePaperTicket(false);
    setUseNoProof(false);
    setNoProofReason('');
    setPaperDeliveredOn(todayInBusinessTz());
    setPhotos([]);
  }, [id]);

  // Completion may only use a delivery and item set that belong to the route on screen.
  const completionStateMatchesRoute = () =>
    !!delivery && delivery.id === id && items.length > 0 && items.every((item) => item.delivery_id === id);

  // Office re-bill state for a completed delivery with no active covering invoice.
  const [createInvoiceConfirmOpen, setCreateInvoiceConfirmOpen] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);

  // Photo upload state
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  // Followup state
  const [creatingFollowup, setCreatingFollowup] = useState(false);

  // Start delivery state
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Order context for items display
  const [orderItemContext, setOrderItemContext] = useState<Record<string, { ordered: number; delivered: number; remaining: number }>>({});

  // Parent order for cross-link
  const [parentOrder, setParentOrder] = useState<{ id: string; order_number: string } | null>(null);

  // Related invoices (cross-link via shared order)
  const [relatedInvoices, setRelatedInvoices] = useState<Array<{
    id: string; invoice_number: string; invoice_date: string; status: string;
    total_amount_cents: number; order_id: string; delivery_id: string | null;
    invoice_type: string; deleted_at: string | null;
  }>>([]);

  // H5: true when the server's ORDER_NEEDS_SPLIT_BILLING guard would refuse a
  // single backfilled invoice for this delivery's order. Defaults to false and
  // stays false on a read failure — see the fail-open note in
  // fetchSplitBillingOrderIds.
  const [orderNeedsSplitBilling, setOrderNeedsSplitBilling] = useState(false);

  // The reason this delivery was billed outside CRX (delivery_external_billings,
  // admin/sales-rep readable), or null. The server refuses to invoice such a delivery; on a
  // read failure this stays null and that refusal still applies.
  const [billedOutsideCrxReason, setBilledOutsideCrxReason] = useState<string | null>(null);

  // Sibling deliveries + quote context for transaction thread
  const [siblingDeliveries, setSiblingDeliveries] = useState<{ id: string; delivery_number: string }[]>([]);
  const [parentQuote, setParentQuote] = useState<{ id: string; quote_number: string } | null>(null);
  // Load call order, so only the newest fetchDelivery for this route may publish.
  const fetchSeqRef = useRef(0);

  // The order context, invoices and remainders belong to the delivery they were read for:
  // drop them on a route change so none shows under the next delivery while it loads.
  useLayoutEffect(() => {
    setRemainders([]);
    setParentOrder(null);
    setRelatedInvoices([]);
    setSiblingDeliveries([]);
    setParentQuote(null);
  }, [id]);

  const isDriver = role === 'driver';
  const isAdmin = role === 'admin';
  const isAdminOrRep = role === 'admin' || role === 'sales_rep';
  const canEdit = isAdminOrRep && delivery?.status !== 'completed' && delivery?.status !== 'cancelled';
  const canCancel = isAdminOrRep && delivery?.status !== 'cancelled' && delivery?.status !== 'completed';
  const canVoid = isAdmin && delivery?.status === 'completed';
  const isAssignedDriver = isDriver && profile?.id === delivery?.assigned_driver;
  const canConfirm = (isAdminOrRep || isAssignedDriver) && delivery?.status === 'scheduled';
  const receiptEmail = customer?.email || receiptRecipient?.email || null;
  // What complete_delivery checks before it completes (migration 20261022075000).
  // no_proof is offered only to an admin on the office layout (the server refuses anyone else).
  const completionEvidence: DeliveryCompletionEvidence = isAdmin && useNoProof ? 'no_proof' : usePaperTicket ? 'paper_ticket' : 'signature';
  // A delivery recorded without proof is signed with the fixed office text, never a customer's name.
  const completionSignedBy = completionEvidence === 'no_proof' ? NO_PROOF_SIGNER : signedBy;
  // Mirrors the server's per-delivery coverage guard (U2 #34).
  const hasActiveRelatedInvoice = delivery != null && relatedInvoices.some((invoice) =>
    activeInvoiceCoversDelivery(invoice, delivery.id, delivery.order_id)
  );
  // RPC is admin-only (finding #78's backfill twin); sales_reps bill jobs, not stray deliveries.
  // H5: also mirror the server's ORDER_NEEDS_SPLIT_BILLING refusal via the shared
  // predicate, so this surface and IntegrityCleanupPanel cannot drift apart.
  const canCreateInvoice = isAdmin
    && delivery?.status === 'completed'
    && !hasActiveRelatedInvoice
    && !orderNeedsSplitBilling
    && billedOutsideCrxReason === null;
  // Only worth explaining where the button would otherwise have been offered.
  const splitBillingBlocksInvoice = isAdmin
    && delivery?.status === 'completed'
    && !hasActiveRelatedInvoice
    && orderNeedsSplitBilling
    && billedOutsideCrxReason === null;

  const fetchDelivery = useCallback(async () => {
    // Never carry the previous delivery's billed-outside-CRX badge onto this one.
    setBilledOutsideCrxReason(null);
    // This page is reused across deliveries: a slow load for the previous one must
    // never publish its items, quantities or photos onto the delivery now on screen.
    // Two loads of the SAME delivery can overlap (the first open and a refresh after an
    // action): only the newest may publish, so an older failure cannot hide a newer page.
    const seq = ++fetchSeqRef.current;
    const isStale = () => signatureRouteIdRef.current !== id || seq !== fetchSeqRef.current;
    const failLoad = (message: string) => {
      toast('error', message);
      setLoadFailedId(id ?? null);
      setLoading(false);
    };
    const { data: delData, error: delError } = await supabase
      .from('deliveries')
      .select('*')
      .eq('id', id!)
      .maybeSingle();
    if (isStale()) return;

    if (delError) {
      Sentry.captureException(delError, { extra: { context: 'load_delivery', deliveryId: id } });
      failLoad(sanitizeError(delError));
      return;
    }

    if (delData) {
      const del = delData as Delivery;
      setDelivery(del);

      const photoSeq = ++photoSeqRef.current;
      try {
        const [custRes, itemsRes, addrRes, driverRes, photosRes] = await Promise.all([
          supabase.from('customers').select('*').eq('id', del.customer_id).maybeSingle(),
          supabase.from('delivery_items').select('*, product:products(id, product_name, sku, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, product_family:product_families(name))').eq('delivery_id', id!),
          del.delivery_address_id
            ? supabase.from('customer_addresses').select('*').eq('id', del.delivery_address_id).maybeSingle()
            : Promise.resolve({ data: null }),
          // PR-07 follow-up: read driver name via profile_public_view (UI uses
          // only .full_name — see lines ~1534/1626/2395).
          del.assigned_driver
            ? supabase.from('profile_public_view').select('id, full_name, role, is_active').eq('id', del.assigned_driver).maybeSingle()
            : Promise.resolve({ data: null }),
          supabase.from('delivery_photos').select('*').eq('delivery_id', id!).order('sort_order'),
        ]);
        if (isStale()) return;

        // No list, or no customer row read, is a failed load too: with no lines on screen
        // Edit would offer every order line as new and save over the real ones.
        if (itemsRes.error || !itemsRes.data || custRes.error) {
          Sentry.captureException(itemsRes.error ?? custRes.error ?? new Error('delivery_items read returned no list'), { extra: { context: 'load_delivery_items', deliveryId: del.id } });
          failLoad('Failed to load delivery items');
          return;
        }

        setCustomer(custRes.data as Customer | null);
        setReceiptRecipient(null);
        // Only an open delivery sends a receipt on completion.
        if (!custRes.data && (del.status === 'scheduled' || del.status === 'in_progress')) {
          void fetchReceiptRecipient(del.id).then((recipient) => { if (!isStale()) setReceiptRecipient(recipient); });
        }
        const loadedItems = (itemsRes.data || []) as unknown as DeliveryItem[];
        setItems(loadedItems);
        const initQtys: Record<string, number> = {};
        loadedItems.forEach((item) => { initQtys[item.id] = item.quantity; });
        setDeliveryQtys(initQtys);
        setAddress(addrRes.data as CustomerAddress | null);
        setDriver(driverRes.data as Profile | null);
        if (photoSeq === photoSeqRef.current) setPhotos((photosRes.data || []) as DeliveryPhoto[]);

        // Fetch order item context for items display
        if (del.order_id) {
          // H5: does the server's split-billing guard cover this order? Read via
          // the shared predicate so this page and the integrity panel ask the
          // same question. `order_item_field_allocations` is admin/sales_rep
          // readable (RLS `oifa_select`); a driver never sees the button anyway.
          const orderIdForSplitCheck = del.order_id;
          const [oiRes, orderRes, invRes, splitRes, externalBillingRes] = await Promise.all([
            supabase
              .from('order_items')
              .select('id, total_units_needed, quantity_delivered, quantity_remaining')
              .eq('order_id', del.order_id),
            supabase
              .from('orders')
              .select('id, order_number, quote_id')
              .eq('id', del.order_id)
              .maybeSingle(),
            supabase
              .from('invoices')
              .select('id, invoice_number, invoice_date, status, total_amount_cents, order_id, delivery_id, invoice_type, deleted_at')
              .eq('order_id', del.order_id)
              .is('deleted_at', null)
              .order('invoice_date', { ascending: false }),
            fetchSplitBillingOrderIds([orderIdForSplitCheck]),
            // Not yet in the generated types; admin/sales-rep readable under RLS.
            supabaseUntyped
              .from('delivery_external_billings')
              .select('reason')
              .eq('delivery_id', del.id)
              .maybeSingle(),
          ]);
          if (isStale()) return;
          // A failed order read would show the delivery with no order, quote or thread.
          if (orderRes.error) {
            Sentry.captureException(orderRes.error, { extra: { context: 'load_delivery_order', deliveryId: del.id } });
            failLoad('Failed to load this delivery\'s order');
            return;
          }
          // Without its invoices the page would hide them and could offer
          // "Create invoice" for a delivery that is already billed.
          if (invRes.error || !invRes.data) {
            Sentry.captureException(invRes.error ?? new Error('invoices read returned no list'), { extra: { context: 'load_delivery_invoices', deliveryId: del.id } });
            failLoad('Failed to load this delivery\'s invoices');
            return;
          }
          if (externalBillingRes.error) {
            // Fail OPEN like the split-billing read above: keep the button; the server's
            // DELIVERY_BILLED_OUTSIDE_CRX guard still refuses, in plain English.
            Sentry.captureException(externalBillingRes.error, {
              extra: { context: 'load_delivery_external_billing', deliveryId: del.id },
            });
          } else if (signatureRouteIdRef.current === id) {
            // Publish only if this response still belongs to the delivery on screen.
            setBilledOutsideCrxReason((externalBillingRes.data as { reason: string } | null)?.reason ?? null);
          }
          if (splitRes.error) {
            // Fail OPEN: keep the button. The server still refuses, and this page
            // already surfaces that refusal verbatim via sanitizeError().
            Sentry.captureException(splitRes.error, {
              extra: { context: 'load_split_billing_eligibility', orderId: orderIdForSplitCheck },
            });
            setOrderNeedsSplitBilling(false);
          } else {
            setOrderNeedsSplitBilling(splitRes.data?.has(orderIdForSplitCheck) ?? false);
          }
          if (oiRes.error) {
            toast('error', sanitizeError(oiRes.error));
          } else if (oiRes.data) {
            const ctx: Record<string, { ordered: number; delivered: number; remaining: number }> = {};
            oiRes.data.forEach((oi: { id: string; total_units_needed: number; quantity_delivered: number; quantity_remaining: number }) => {
              ctx[oi.id] = {
                ordered: oi.total_units_needed,
                delivered: oi.quantity_delivered,
                remaining: oi.quantity_remaining,
              };
            });
            setOrderItemContext(ctx);
          }
          setParentOrder(orderRes.data as { id: string; order_number: string } | null);
          setRelatedInvoices(
            invRes.data.map((inv: Record<string, unknown>) => ({
              id: inv.id as string,
              invoice_number: inv.invoice_number as string,
              invoice_date: inv.invoice_date as string,
              status: inv.status as string,
              total_amount_cents: Number(inv.total_amount_cents || 0),
              order_id: inv.order_id as string,
              delivery_id: inv.delivery_id as string | null,
              invoice_type: inv.invoice_type as string,
              deleted_at: inv.deleted_at as string | null,
            }))
          );

          // Fetch sibling deliveries for transaction thread
          const { data: sibDels } = await supabase
            .from('deliveries').select('id, delivery_number')
            .eq('order_id', del.order_id).order('delivery_number');
          if (isStale()) return;
          setSiblingDeliveries((sibDels || []).map((d: Record<string, unknown>) => ({
            id: d.id as string, delivery_number: d.delivery_number as string,
          })));

          // Fetch quote context via parent order
          if (orderRes.data) {
            const parentOrderData = orderRes.data as { id: string; order_number: string; quote_id?: string | null };
            if (parentOrderData.quote_id) {
              const { data: qData } = await supabase
                .from('quotes').select('id, quote_number')
                .eq('id', parentOrderData.quote_id).maybeSingle();
              if (isStale()) return;
              setParentQuote(qData as { id: string; quote_number: string } | null);
            } else { setParentQuote(null); }
          } else {
            // The order read failed or found nothing: never keep another delivery's quote link.
            setParentQuote(null);
          }
        } else {
          // Orphan delivery: no order, so no split-billing state, order, invoices,
          // sibling deliveries or quote to carry over from a previously viewed delivery.
          setOrderNeedsSplitBilling(false);
          setBilledOutsideCrxReason(null);
          setParentOrder(null);
          setRelatedInvoices([]);
          setSiblingDeliveries([]);
          setParentQuote(null);
        }

        // Fetch remainders for completed deliveries
        if (del.status === 'completed') {
          const { data: remData, error: remError } = await supabase
            .from('delivery_remainders')
            .select('*, product:products(product_name)')
            .eq('original_delivery_id', id!);
          if (isStale()) return;
          // Without its remainders a completed delivery would show none (or another
          // delivery's) under "Remaining Items", so a failed read fails the page.
          if (remError || !remData) {
            Sentry.captureException(remError ?? new Error('delivery_remainders read returned no list'), { extra: { context: 'load_delivery_remainders', deliveryId: del.id } });
            failLoad('Failed to load this delivery\'s remaining items');
            return;
          } else {
            setRemainders((remData as Array<DeliveryRemainder & { product?: { product_name: string } | null }>).map((r) => ({
              ...r,
              product_name: r.product?.product_name || 'Unknown',
            })) as DeliveryRemainder[]);
          }

          // Generate signed URL for signature (privacy: no permanent public URLs)
          if (del.signature_url) {
            const { data: signedData, error: signedErr } = await supabase.storage
              .from('delivery-signatures')
              .createSignedUrl(del.signature_url, 3600); // 1 hour expiry
            if (signatureRouteIdRef.current === id) {
              if (signedData?.signedUrl) {
                setSignedSignatureUrl(signedData.signedUrl);
                setSignatureUrlFailed(false);
              } else {
                if (signedErr) Sentry.captureException(signedErr, { level: 'warning', extra: { context: 'Signed URL for delivery signature', deliveryId: del.id } });
                setSignatureUrlFailed(true);
              }
            }
          }
        }
      } catch {
        if (isStale()) return;
        failLoad('Failed to load delivery details. Please try again.');
        return;
      }
    }
    setLoadFailedId(null);
    setLoading(false);
  }, [id, toast]);

  useEffect(() => {
    if (id) fetchDelivery();
  }, [id, fetchDelivery]);

  // RUP compliance check
  useEffect(() => {
    if (!customer || !items.length) return;
    const productIds = items.map((i) => i.product_id).filter(Boolean);
    if (!productIds.length) return;
    let cancelled = false;
    checkRUPCompliance(customer.id, productIds).then((res) => {
      if (!cancelled) setRupWarnings(res.warnings);
    });
    return () => { cancelled = true; };
  }, [customer, items]);

  // Inventory availability check — warn (don't block) if stock is low
  useEffect(() => {
    if (!items.length || !delivery || (delivery.status !== 'scheduled' && delivery.status !== 'in_progress')) {
      setInventoryWarnings([]);
      return;
    }
    const productIds = [...new Set(items.map((i) => i.product_id).filter(Boolean))];
    if (!productIds.length) { setInventoryWarnings([]); return; }
    let cancelled = false;

    (async () => {
      const { data: invData, error: invErr } = await supabase
        .from('inventory')
        .select('product_id, quantity_available')
        .in('product_id', productIds)
        .eq('location', 'Main Warehouse');

      if (cancelled || invErr) return;

      const invMap: Record<string, number> = {};
      for (const row of (invData || []) as Array<{ product_id: string; quantity_available: number }>) {
        invMap[row.product_id] = (invMap[row.product_id] || 0) + Number(row.quantity_available);
      }

      // Sum the need per PRODUCT before comparing — a tier-split booking puts
      // the same product on several lines. See src/lib/inventoryShortage.ts.
      const warnings: string[] = [];
      for (const need of sumNeedByProduct(
        items.map((item) => ({
          productId: item.product_id,
          label: (item.product as unknown as { product_name: string })?.product_name || 'Unknown',
          quantity: item.quantity,
        }))
      )) {
        const available = invMap[need.productId] ?? 0;
        if (available < need.quantity) {
          warnings.push(`${need.label}: need ${need.quantity}, only ${available} on hand`);
        }
      }
      if (!cancelled) setInventoryWarnings(warnings);
    })();

    return () => { cancelled = true; };
  }, [items, delivery]);

  const updateDeliveryQty = (itemId: string, qty: number, max: number) => {
    setDeliveryQtys((prev) => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, max)) }));
  };

  const isPartialDelivery = items.some((item) => (deliveryQtys[item.id] ?? item.quantity) < item.quantity);
  // Everything the driver can still edit while the signal check runs. Compared after the check so
  // an edit made during it is never silently dropped in favour of the values captured at confirm.
  const completionInputs = JSON.stringify([signedBy, deliveryQtys, driverIssueType, driverIssueNotes, usePaperTicket, paperDeliveredOn, signatureDataUrl, emailOnComplete, completionEvidence, noProofReason]);
  const completionInputsRef = useLatestRef(completionInputs);
  const hasAnyQty = items.some((item) => (deliveryQtys[item.id] ?? item.quantity) > 0);

  // ── Edit Mode ──────────────────────────────────────────────────────────

  const startEditing = async () => {
    if (!delivery || !customer) return;
    setEditDriver(delivery.assigned_driver || '');
    setEditDate(delivery.scheduled_date);
    setEditTime(delivery.scheduled_time || '');
    setEditWindowStart(delivery.delivery_window_start || '');
    setEditWindowEnd(delivery.delivery_window_end || '');
    setEditAddress(delivery.delivery_address_id || '');
    setEditPriority(delivery.priority || 'normal');
    setEditNotes(delivery.delivery_notes || '');

    // Fetch addresses, drivers, order items for edit dropdowns
    const [addrRes, driverRes, oiRes] = await Promise.all([
      supabase.from('customer_addresses').select('*').eq('customer_id', customer.id).order('is_default', { ascending: false }),
      // PR-07 follow-up: driver picker only uses id/full_name/role; safe via view.
      supabase.from('profile_public_view').select('id, full_name, role, is_active').in('role', ['driver', 'admin', 'sales_rep']).eq('is_active', true).order('full_name'),
      supabase.from('order_items').select(`${ORDER_ITEM_COLUMNS}, product:products(id, product_name, sku, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, product_family:product_families(name))`).eq('order_id', delivery.order_id).order('section_name'),
    ]);
    if (oiRes.error) {
      Sentry.captureException(oiRes.error, { extra: { context: 'load_delivery_edit_order_items', deliveryId: delivery.id } });
      toast('error', 'Failed to load order items for delivery editing');
      return;
    }
    setAddresses((addrRes.data || []) as CustomerAddress[]);
    setDrivers((driverRes.data || []) as Profile[]);
    const allOrderItems = (oiRes.data || []) as unknown as Array<OrderItem & {
      product?: ProductOptionPresentationModel;
    }>;

    // For scheduled deliveries, calculate real max quantities
    // by checking what other active deliveries have scheduled for each order item
    const isScheduled = delivery.status === 'scheduled';
    const otherScheduledMap: Record<string, number> = {};

    if (isScheduled) {
      // Step 1: Find OTHER active delivery IDs for this order
      // Both reads go page by page: one request stopped at the server's row cap
      // and understated what other deliveries already claim (Goal 4, DeliveryDetail
      // scheduled quantities). A failed read stops editing rather than allowing
      // a quantity the order cannot cover.
      const { data: otherDeliveries, error: otherDeliveriesError } = await fetchAllRows((from, to) => supabase
        .from('deliveries')
        .select('id', { count: 'exact' })
        .eq('order_id', delivery.order_id)
        .in('status', ['scheduled', 'in_progress'])
        .neq('id', delivery.id)
        .order('id')
        .range(from, to));
      if (otherDeliveriesError) {
        Sentry.captureException(otherDeliveriesError, { extra: { context: 'load_delivery_edit_other_deliveries', deliveryId: delivery.id } });
        toast('error', 'Failed to load other deliveries for this order');
        return;
      }

      const otherDelIds = ((otherDeliveries || []) as Array<{ id: string }>).map((d) => d.id);

      // Step 2: Fetch delivery_items on those other deliveries
      if (otherDelIds.length > 0) {
        const { data: otherDelItems, error: otherDelItemsError } = await fetchAllRowsForIds(otherDelIds, (idChunk, from, to) => supabase
          .from('delivery_items')
          .select('id, order_item_id, quantity', { count: 'exact' })
          .in('delivery_id', idChunk)
          .order('id')
          .range(from, to));
        if (otherDelItemsError) {
          Sentry.captureException(otherDelItemsError, { extra: { context: 'load_delivery_edit_other_delivery_items', deliveryId: delivery.id } });
          toast('error', 'Failed to load other deliveries for this order');
          return;
        }

        for (const row of (otherDelItems || []) as Array<{ order_item_id: string; quantity: number }>) {
          otherScheduledMap[row.order_item_id] = (otherScheduledMap[row.order_item_id] || 0) + Number(row.quantity);
        }
      }
    }

    // Map current items for editing with correct max_quantity
    const currentItemIds = new Set(items.map((i) => i.order_item_id));
    setEditItems(items.map((item) => {
      const oi = allOrderItems.find((o) => o.id === item.order_item_id);
      const remaining = oi?.quantity_remaining ?? item.quantity;
      const otherScheduled = otherScheduledMap[item.order_item_id] || 0;
      // Max = what's remaining on the order minus what other deliveries claim
      const maxQty = isScheduled ? Math.max(remaining - otherScheduled, 0) : item.quantity;
      return {
        order_item_id: item.order_item_id,
        product_id: item.product_id,
        product_name: (item.product as unknown as { product_name: string })?.product_name || 'Unknown',
        quantity: item.quantity,
        max_quantity: maxQty,
        unit_size: item.unit_size || '',
        product: item.product as unknown as ProductOptionPresentationModel,
      };
    }));

    // Build list of order items NOT on this delivery that still have quantity remaining
    if (isScheduled) {
      const addable = allOrderItems
        .filter((oi) => !currentItemIds.has(oi.id) && oi.quantity_remaining > 0)
        .map((oi) => {
          const otherScheduled = otherScheduledMap[oi.id] || 0;
          const maxQty = Math.max(oi.quantity_remaining - otherScheduled, 0);
          return {
            order_item_id: oi.id,
            product_id: oi.product_id,
            product_name: oi.product_name,
            max_quantity: maxQty,
            unit_size: oi.unit_size || '',
            product: oi.product as unknown as ProductOptionPresentationModel,
          };
        })
        .filter((item) => item.max_quantity > 0);
      setAvailableOrderItems(addable);
    } else {
      setAvailableOrderItems([]);
    }

    setEditing(true);
  };

  const saveEdit = async () => {
    if (!delivery || !profile) return;

    // Validate: if scheduled and items changed, must have at least 1 item with qty > 0
    const isScheduled = delivery.status === 'scheduled';
    const activeEditItems = editItems.filter((i) => i.quantity > 0);
    if (isScheduled && activeEditItems.length === 0) {
      toast('error', 'Delivery must have at least one item. Cancel the delivery instead.');
      return;
    }

    setSavingEdit(true);

    // Build items payload only for scheduled deliveries
    const itemsPayload = isScheduled
      ? activeEditItems.map((i) => ({
          order_item_id: i.order_item_id,
          product_id: i.product_id,
          quantity: i.quantity,
          unit_size: i.unit_size || null,
        }))
      : null;

    const idemKey = editIdem.getKey();
    const { data, error } = await supabase.rpc('edit_delivery', {
      p_delivery_id: id!,
      p_assigned_driver: editDriver || undefined,
      p_scheduled_date: editDate,
      p_scheduled_time: editTime || undefined,
      p_delivery_window_start: editWindowStart || undefined,
      p_delivery_window_end: editWindowEnd || undefined,
      p_delivery_address_id: editAddress || undefined,
      p_delivery_notes: editNotes || undefined,
      p_priority: editPriority,
      p_items: itemsPayload,
      p_performed_by: profile.id,
      p_idempotency_key: idemKey,
    });

    if (error) {
      toast('error', sanitizeError(error));
    } else {
      assertRpcResult(data, 'edit_delivery');
      editIdem.resetKey();
      toast('success', isScheduled ? 'Delivery and items updated' : 'Delivery updated');
      setEditing(false);
      fetchDelivery();
    }
    setSavingEdit(false);
  };

  // ── Cancel Delivery ────────────────────────────────────────────────────

  const handleCancel = async () => {
    if (!profile) return;
    setCancelling(true);
    // One key per exact request (this delivery + this reason): an edited reason gets its own key, and
    // an exact retry reuses the first key, which the server (replay-binding batch 3b, 20261019235000)
    // replays only for the same person and the same delivery and reason.
    const reason = cancelReason.trim() || 'Cancelled';
    const cancelScope = JSON.stringify([id!, reason]);
    try {
      const idemKey = cancelIdem.getKeyFor(cancelScope);
      const { data: cancelResult, error } = await supabase.rpc('cancel_delivery', {
        p_delivery_id: id!,
        p_cancel_reason: reason,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      // Retire the key only after a confirmed result: an empty reply keeps it, so retrying the same
      // request replays the server's saved receipt. A binding refusal is retired in the catch.
      const cancelData = assertRpcResult<{
        items_restored?: number;
        draft_invoices_cancelled?: number;
        draft_invoices_voided?: number;
        posted_invoices_flagged?: number;
      }>(cancelResult, 'cancel_delivery');
      cancelIdem.resetKeyFor(cancelScope);
      // Show detailed summary toast with cascade info
      const parts: string[] = ['Delivery cancelled.'];
      if ((cancelData.items_restored ?? 0) > 0) parts.push(`Inventory restored for ${cancelData.items_restored} item(s).`);
      if (((cancelData.draft_invoices_cancelled ?? cancelData.draft_invoices_voided) ?? 0) > 0) parts.push(`${cancelData.draft_invoices_cancelled ?? cancelData.draft_invoices_voided} draft invoice(s) cancelled.`);
      if ((cancelData.posted_invoices_flagged ?? 0) > 0) parts.push(`Admin notified about ${cancelData.posted_invoices_flagged} posted invoice(s) needing review.`);
      toast('success', parts.join(' '));
      setCancelOpen(false);
      setCancelReason('');
      fetchDelivery();
    } catch (err) {
      // Any replay-binding refusal (another request's or person's key, or a receipt that can never be
      // used) retires the key; nothing ran for THIS request. A cancel cannot repeat: the next try runs
      // fresh and the body refuses a delivery already cancelled. Reload so a cancel an earlier attempt
      // already committed shows.
      if (getIdempotencyBindingRejection(err)) {
        cancelIdem.resetKeyFor(cancelScope);
        fetchDelivery();
      }
      toast('error', sanitizeError(err));
    } finally {
      setCancelling(false);
    }
  };

  // ── Void Delivery (admin only, completed) ─────────────────────────────

  const handleVoidDelivery = async () => {
    if (!profile || !delivery) return;
    setVoiding(true);
    // One key per exact request (this delivery + this reason), as for cancel above.
    const reason = voidReason.trim();
    const voidScope = JSON.stringify([id!, reason]);
    try {
      const idemKey = voidIdem.getKeyFor(voidScope);
      const { data: voidResult, error } = await supabase.rpc('void_delivery', {
        p_delivery_id: id!,
        p_reason: reason,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      // Retire the key only after a confirmed result (an empty reply keeps it for an exact retry).
      const voidData = assertRpcResult<{ posted_invoices_exist?: boolean }>(voidResult, 'void_delivery');
      voidIdem.resetKeyFor(voidScope);
      const parts: string[] = [`Delivery ${delivery.delivery_number} voided.`];
      if (voidData.posted_invoices_exist) {
        parts.push('Warning: posted invoices linked to this order require manual review.');
      }
      toast('success', parts.join(' '));
      await logActivity({ event: 'delivery_voided', description: `Delivery ${delivery.delivery_number} voided`, performedBy: profile.id, entityType: 'delivery', entityId: id!, customerId: delivery.customer_id });
      setVoidOpen(false);
      setVoidReason('');
      fetchDelivery();
    } catch (err) {
      // Any binding refusal retires the key (a void cannot repeat: the body refuses a delivery that
      // is no longer completed); reload so a void an earlier attempt committed shows.
      if (getIdempotencyBindingRejection(err)) {
        voidIdem.resetKeyFor(voidScope);
        fetchDelivery();
      }
      toast('error', sanitizeError(err));
    } finally {
      setVoiding(false);
    }
  };

  // ── Reassign (Take This Delivery) ─────────────────────────────────────

  const handleReassign = async () => {
    if (!profile || !delivery) return;

    setReassigning(true);
    setReassignConfirmOpen(false);
    try {
      const idemKey = reassignIdem.getKey();
      const { data, error } = await supabase.rpc('reassign_delivery', {
        p_delivery_id: id!,
        p_new_driver: profile.id,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });

      if (error) {
        toast('error', sanitizeError(error));
      } else {
        assertRpcResult(data, 'reassign_delivery');
        reassignIdem.resetKey();
        toast('success', 'Delivery assigned to you');
        fetchDelivery();
      }
    } finally {
      setReassigning(false);
    }
  };

  // ── Photo Upload ───────────────────────────────────────────────────────

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>, caption?: string) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !profile || !delivery) return;

    if (!caption && countOrdinaryPhotos(photos) + files.length > MAX_ORDINARY_DELIVERY_PHOTOS) {
      toast('error', 'Maximum 10 photos per delivery');
      return;
    }
    if (caption === PAPER_TICKET_PHOTO_CAPTION && countPaperTicketPhotos(photos) + files.length > MAX_PAPER_TICKET_PHOTOS) {
      toast('error', 'Maximum 2 ticket photos per delivery');
      return;
    }

    setUploadingPhoto(true);
    let uploadCount = 0;

    for (const rawFile of Array.from(files)) {
      try {
        const file = await compressImage(rawFile);
        const ext = file.name.split('.').pop() || 'jpg';
        const storagePath = `delivery-photos/${id}/${Date.now()}_${uploadCount}.${ext}`;

        const { error: uploadErr } = await supabase.storage
          .from('delivery-photos')
          .upload(storagePath, file, { contentType: file.type, cacheControl: '0' });

        if (uploadErr) {
          toast('error', `Upload failed: ${uploadErr.message}`);
          continue;
        }

        const { data: urlData } = supabase.storage
          .from('delivery-photos')
          .getPublicUrl(storagePath);

        const photoResult = await supabase.from('delivery_photos').insert({
          delivery_id: id!,
          storage_path: storagePath,
          image_url: urlData.publicUrl,
          uploaded_by: profile.id,
          file_size: file.size,
          sort_order: photos.length + uploadCount,
          ...(caption ? { caption } : {}),
        }).select();
        if (photoResult.error) {
          toast('error', `Photo saved to storage but DB record failed: ${photoResult.error.message}`);
          continue;
        }
        checkMutationResult(photoResult, 'Insert delivery photo');
        // Show the saved row now, so a required ticket photo does not depend on the
        // refresh read below succeeding.
        const inserted = (photoResult.data || []) as DeliveryPhoto[];
        if (signatureRouteIdRef.current === id) {
          photoSeqRef.current++; // an older in-flight read must not replace the list without this photo
          setPhotos((prev) => [...prev, ...inserted.filter((row) => !prev.some((p) => p.id === row.id))]);
        }

        uploadCount++;
      } catch (err) {
        Sentry.captureException(err, { tags: { source: 'critical_action', action: 'upload_delivery_photo' } });
        toast('error', 'Photo upload failed. Please try again.');
      }
    }

    if (uploadCount > 0) {
      toast('success', `${uploadCount} photo${uploadCount > 1 ? 's' : ''} uploaded`);
      // Refresh only the photos. A full fetchDelivery() resets the driver's edited
      // partial quantities to full, and the paper-ticket photo is taken right before
      // Complete, so a short delivery would be recorded as full.
      const uploadDeliveryId = id;
      const photoSeq = ++photoSeqRef.current;
      const { data: refreshedPhotos, error: photosErr } = await supabase
        .from('delivery_photos').select('*').eq('delivery_id', uploadDeliveryId!).order('sort_order');
      if (photosErr) {
        Sentry.captureException(photosErr, { extra: { context: 'Refresh delivery photos after upload' } });
        toast('error', 'Photo saved, but the photo list could not refresh. Reopen the delivery to see it.');
      } else if (signatureRouteIdRef.current === uploadDeliveryId && photoSeq === photoSeqRef.current) {
        setPhotos((refreshedPhotos || []) as DeliveryPhoto[]);
      }
    }
    setUploadingPhoto(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (paperTicketInputRef.current) paperTicketInputRef.current.value = '';
  };

  // ── Follow-up Delivery ─────────────────────────────────────────────────

  const handleCreateFollowup = async () => {
    if (!profile) return;
    setCreatingFollowup(true);

    // F1 (Codex round 5): retaining the key past the assert is only worth anything if the
    // user can still SPEND it. assertRpcResult throws on an ambiguous reply — the exact case
    // the retained key exists for — and without finally, setCreatingFollowup(false) never ran,
    // so the button stayed disabled and the only way out was to navigate away, which unmounts
    // this page and drops the key. The retry then travelled under a FRESH key the server
    // cannot replay, which is the duplicate F1 is meant to prevent. try/finally makes the
    // retained key reachable, matching handleStartDelivery below.
    try {
      const idemKey = followupIdem.getKey();
      const { data, error } = await supabase.rpc('create_followup_delivery', {
        p_original_delivery_id: id!,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ delivery_id: string; delivery_number: string; item_count: number }>(data, 'create_followup_delivery');
      followupIdem.resetKey();
      toast('success', `Follow-up delivery ${result.delivery_number} created with ${result.item_count} items`);
      navigate(`/deliveries/${result.delivery_id}`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    } finally {
      setCreatingFollowup(false);
    }
  };

  // ── Start Delivery (Confirm) ──────────────────────────────────────────

  const handleStartDelivery = async () => {
    if (!delivery || !profile) return;
    setConfirming(true);
    try {
      const idemKey = confirmIdem.getKey();
      const { data, error } = await supabase.rpc('confirm_delivery', {
        p_delivery_id: id!,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      assertRpcResult(data, 'confirm_delivery');
      confirmIdem.resetKey();
      toast('success', `Delivery ${delivery.delivery_number} started`);
      setStartModalOpen(false);
      fetchDelivery();
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setConfirming(false);
  };

  // ── Complete Delivery (Driver) ─────────────────────────────────────────

  const requestComplete = () => {
    if (!completionStateMatchesRoute()) {
      toast('error', 'This delivery is still loading. Please try again in a moment.');
      return;
    }
    if (completionEvidence !== 'no_proof' && !signedBy.trim()) {
      toast('error', 'Please enter a signature name');
      return;
    }
    if (!delivery || !profile) return;
    if (!hasAnyQty) {
      toast('error', 'At least one item must have a quantity greater than 0');
      return;
    }
    if (completionEvidence === 'no_proof') {
      if (!isValidNoProofReason(noProofReason)) {
        toast('error', `Write why there is no proof (${NO_PROOF_REASON_MIN_CHARS} to ${NO_PROOF_REASON_MAX_CHARS} characters)`);
        return;
      }
      if (!isValidPaperDeliveredOn(paperDeliveredOn)) {
        toast('error', 'Enter the delivery date (today or earlier)');
        return;
      }
      setCompleteConfirmOpen(true);
      return;
    }
    if (completionEvidence === 'signature' && !signatureDataUrl) {
      toast('error', 'Have the customer sign on screen, or tick the paper ticket box and photograph the signed ticket');
      return;
    }
    if (completionEvidence === 'signature' && !isSignatureDataUrl(signatureDataUrl)) {
      toast('error', INVALID_SIGNATURE_MESSAGE);
      return;
    }
    if (usePaperTicket && !hasPaperTicketPhoto(photos)) {
      toast('error', 'Take a photo of the signed paper ticket before completing');
      return;
    }
    if (usePaperTicket && !isValidPaperDeliveredOn(paperDeliveredOn)) {
      toast('error', 'Enter the delivery date from the paper ticket (today or earlier)');
      return;
    }
    setCompleteConfirmOpen(true);
  };

  const handleComplete = async () => {
    if (completeClaimRef.current) return;
    completeClaimRef.current = true;
    try {
      await runComplete();
    } catch (error: unknown) {
      // Only a follow-up after a confirmed completion can land here (the call itself is handled).
      Sentry.captureException(error, { level: 'warning', extra: { context: 'Delivery completion follow-up failed after the delivery completed' } });
    } finally {
      completeClaimRef.current = false;
      setCompleting(false);
    }
  };

  const runComplete = async () => {
    if (!delivery || !profile) return;
    setCompleteConfirmOpen(false);
    if (!completionStateMatchesRoute()) {
      toast('error', 'This delivery is still loading. Please try again in a moment.');
      return;
    }
    // The submitted mode decides every follow-up below (never a checkbox read later).
    const submittedEvidence = completionEvidence;
    const usePaperTicket = submittedEvidence === 'paper_ticket';
    // A paper ticket and a no-proof record both carry the day it was really delivered (back-datable).
    const usesDeliveredOn = usePaperTicket || submittedEvidence === 'no_proof';
    if (submittedEvidence === 'signature' && !isSignatureDataUrl(signatureDataUrl)) {
      toast('error', INVALID_SIGNATURE_MESSAGE);
      return;
    }
    if (submittedEvidence === 'no_proof' && !isValidNoProofReason(noProofReason)) {
      toast('error', `Write why there is no proof (${NO_PROOF_REASON_MIN_CHARS} to ${NO_PROOF_REASON_MAX_CHARS} characters)`);
      return;
    }
    setCompleting(true);
    const deliveryId = id!;

    const quantitiesJson = isPartialDelivery
      ? Object.fromEntries(items.map((item) => [item.id, deliveryQtys[item.id] ?? item.quantity]))
      : null;

    const ticketPhoto = usePaperTicket ? latestEvidencePhoto(photos, PAPER_TICKET_PHOTO_CAPTION) : undefined;
    const intentParams = {
      p_delivery_id: deliveryId,
      p_signed_by: completionSignedBy,
      p_performed_by: profile.id,
      ...(quantitiesJson ? { p_quantities: quantitiesJson } : {}),
      ...(driverIssueType !== 'none' ? { p_issue_type: driverIssueType } : {}),
      ...(driverIssueNotes.trim() ? { p_issue_notes: driverIssueNotes.trim() } : {}),
      ...(usesDeliveredOn && paperDeliveredAt(paperDeliveredOn) ? { p_completed_at: paperDeliveredAt(paperDeliveredOn) } : {}),
      p_evidence: submittedEvidence,
      // The exact ticket photo the screen shows as saved (the signature's reference comes from the key).
      ...(ticketPhoto ? { p_evidence_ref: ticketPhoto.id } : {}),
      // no_proof: the reason exactly as typed (the server collapses whitespace; an exact retry resends it).
      ...(submittedEvidence === 'no_proof' ? { p_evidence_ref: noProofReason } : {}),
    };
    // check_idempotency replays a saved result by key and operation only, so bind the
    // key to this exact payload: an edited retry (signer, quantities, issue, ticket date)
    // mints a fresh key and can never be answered with an earlier attempt's receipt.
    // A fresh key cannot complete twice: complete_delivery refuses a non-in_progress delivery.
    // Fingerprint the date the driver chose, not the completion time derived from it:
    // "today" sends no p_completed_at but becomes a past date after midnight, and an
    // exact retry across midnight must keep its key to replay the saved result.
    // complete_delivery replays on the key alone, so the scope uses the collision-resistant
    // SHA-256 digest (digestIntentPayload), never the 64-bit FNV fingerprint (see idempotency.ts).
    const completeScope = `complete:${await digestIntentPayload({
      ...intentParams,
      p_completed_at: undefined,
      delivered_on: usesDeliveredOn ? paperDeliveredOn : null,
      // A re-drawn signature is a new attempt: new key, new signature file.
      signature_digest: submittedEvidence === 'signature' && signatureDataUrl ? await signatureDigest(signatureDataUrl) : null,
    })}`;
    const idemKey = completeIdem.getKeyFor(completeScope);
    // The server accepts only the image at the path it derives from this key; a retry of the key reuses it.
    const signaturePath = submittedEvidence === 'signature' ? await signatureImagePathFor(deliveryId, idemKey) : undefined;
    const rpcParams: {
      p_delivery_id: string;
      p_signed_by: string;
      p_performed_by?: string;
      p_idempotency_key?: string;
      p_completed_at?: string;
      p_quantities?: Json;
      p_issue_type?: string;
      p_issue_notes?: string;
      p_evidence: DeliveryCompletionEvidence;
      p_evidence_ref?: string;
    } = { ...intentParams, ...(signaturePath ? { p_evidence_ref: signaturePath } : {}), p_idempotency_key: idemKey };

    // Goal 5: completing a delivery needs a signal. Nothing is queued to sync later;
    // without a reachable server the delivery stays exactly as it was.
    if (!(await hasSignal())) {
      toast('error', NO_SIGNAL_MESSAGE);
      return;
    }
    // The receipt address is read while the delivery is still open (a driver may not see the customer),
    // after the signal check and for at most a few seconds. A no-proof record sends no receipt.
    const recipient = submittedEvidence !== 'no_proof' && emailOnComplete && !customer?.email
      ? (receiptRecipient ?? await fetchReceiptRecipientWithin(deliveryId))
      : null;
    // The checks above can take a few seconds; never complete (or upload for) a delivery the user has left.
    // These checks gate only the DISPATCH: once the call is sent, its result is always reconciled.
    const stillSameAttempt = () => {
      if (signatureRouteIdRef.current !== id) {
        toast('error', 'This delivery changed before it was completed. It was not completed; please retry.');
        return false;
      }
      if (completionInputsRef.current !== completionInputs) {
        toast('error', 'Details changed while checking for signal. The delivery was not completed; check them and tap Complete Delivery again.');
        return false;
      }
      return true;
    };
    if (!stillSameAttempt()) return;
    // The server completes only once this attempt's signature image is saved, so it goes up first.
    // A failed upload does not stop the call: after a lost reply the earlier attempt may already have
    // completed the delivery (storage then refuses the re-upload). The same key replays that
    // completion, or the server refuses SIGNATURE_IMAGE_MISSING and nothing changes.
    let signatureUploadError: unknown = null;
    if (signaturePath && signatureDataUrl) {
      try {
        await uploadSignatureImage(signaturePath, signatureDataUrl);
      } catch (sigErr) {
        signatureUploadError = sigErr;
        Sentry.captureException(sigErr instanceof Error ? sigErr : new Error(String(sigErr)), { level: 'warning', extra: { context: 'Signature upload before delivery completion failed; sending the completion anyway' } });
      }
      if (!stillSameAttempt()) return;
    }

    // Sends this attempt exactly: the same inputs and key every time (a lost-reply replay included).
    // Retire the payload-bound key only after a confirmed result: an empty reply keeps it, so retrying
    // the same payload replays the server's saved receipt. A replay-binding refusal (another person's
    // key or an unusable receipt) or SIGNATURE_IMAGE_MISSING (this key's image is not saved and never
    // will be under it) retires it too, so the next tap is a fresh attempt.
    const sendCompletion = async (): Promise<unknown> => {
      // Work out the completion time on the first send, after the signal and route checks: if midnight
      // passed during them, a date of "today" is now a past date and must carry its own timestamp.
      const { data, error: rpcError } = await supabase.rpc('complete_delivery', {
        ...rpcParams,
        // A retry of this key resends the first send's value (completedAtForKey).
        p_completed_at: completedAtForKey(sentCompletedAt.current, idemKey, () => (
          usesDeliveredOn ? paperDeliveredAt(paperDeliveredOn) : undefined)),
      });
      try {
        if (rpcError) throw rpcError;
        assertRpcResult(data, 'complete_delivery');
      } catch (error: unknown) {
        if (getIdempotencyBindingRejection(error) || isSignatureImageMissing(error)) {
          completeIdem.resetKeyFor(completeScope);
        }
        throw error;
      }
      completeIdem.resetKeyFor(completeScope);
      return data;
    };
    // An error toast for a delivery the user has already left names it.
    const forThisDelivery = (message: string) => (signatureRouteIdRef.current === deliveryId ? message : `Delivery ${delivery.delivery_number}: ${message}`);

    // The success path: toasts, activity, notifications and the receipt. Also run after a lost reply
    // whose identical replay returned the saved result.
    const finishCompleted = async (completeResult: unknown) => {
      // The signature image went up before the call; the server recorded signature_url itself.

      // Show auto-invoice info if created
      const autoInvoice = completeResult as { auto_invoice?: { invoice_id?: string; invoice_number?: string } } | null;
      const invoiceNum = autoInvoice?.auto_invoice?.invoice_number;
      const invoiceId = autoInvoice?.auto_invoice?.invoice_id;
      if (invoiceId && signatureRouteIdRef.current === deliveryId) setAutoInvoiceId(invoiceId);

      // U9 (#37): complete_delivery now warns-not-blocks on short stock. It
      // proceeded, flagged the ledger row for review, and notified admins.
      const stockResult = completeResult as { stock_warning?: boolean; short_stock_count?: number } | null;
      if (stockResult?.stock_warning) {
        const shortN = stockResult.short_stock_count ?? 0;
        toast('warning', `Delivery completed, but ${shortN} product(s) were short — on-hand inventory went negative. Admins have been notified to review.`);
      }

      if (invoiceNum) {
        toast('success', isPartialDelivery
          ? `Delivery completed (partial). Draft invoice ${invoiceNum} created.`
          : `Delivery completed. Draft invoice ${invoiceNum} created.`);
      } else {
        toast('success', isPartialDelivery ? 'Delivery completed (partial quantities)' : 'Delivery completed');
      }
      const proofText = submittedEvidence === 'no_proof'
        ? ` (recorded without proof: ${await storedNoProofReason(deliveryId, noProofReason)})`
        : usePaperTicket ? ' (signed paper ticket photo)' : ' (on-screen signature)';
      logActivity({ event: 'delivery_completed', description: `Delivery ${delivery.delivery_number} completed${isPartialDelivery ? ' (partial)' : ''}${proofText}${invoiceNum ? ` — draft invoice ${invoiceNum} auto-created` : ''}`, performedBy: profile.id, entityType: 'delivery', entityId: delivery.id, customerId: delivery.customer_id });

      // F15: Notify about delivery remainders
      if (isPartialDelivery) {
        const remainderItems = items
          .map((item) => ({
            product: item.product?.product_name || 'Unknown',
            ordered: item.quantity,
            delivered: deliveryQtys[item.id] ?? item.quantity,
          }))
          .filter((r) => r.delivered < r.ordered);

        if (remainderItems.length > 0) {
          await notifyDeliveryRemainder(
            delivery.id,
            delivery.delivery_number,
            delivery.order_id || '',
            remainderItems,
            delivery.created_by
          );
        }
      }

      // === Notify driver, admins, and sales rep ===
      await notifyDeliveryCompleted(
        delivery.id,
        delivery.delivery_number,
        customer?.farm_name || recipient?.farmName || receiptRecipient?.farmName || 'Unknown',
        delivery.assigned_driver,
        delivery.order_id,
        isPartialDelivery
      );

      // === Email customer when delivery is completed (opt-out via checkbox) ===
      // Same opt-in as an on-screen signature. The customer keeps the signed paper ticket; a
      // guaranteed email needs a server-side receipt queue (open in the Goal 5 plan).
      const sendTo = customer?.email || recipient?.email || receiptRecipient?.email || null;
      const sendToName = customer?.contact_name ?? recipient?.contactName ?? receiptRecipient?.contactName ?? null;
      if (submittedEvidence === 'no_proof') {
        // No customer confirmed this delivery, so no automatic "your delivery was completed" receipt.
        toast('info', 'Recorded without proof. No receipt was emailed; the office can send one later with Email Confirmation.');
      } else if (emailOnComplete && sendTo) {
        try {
          const deliveredLines = items
            .map((item) => {
              const qty = isPartialDelivery ? (deliveryQtys[item.id] ?? item.quantity) : item.quantity;
              return { name: item.product?.product_name || 'Product', qty };
            })
            .filter((row) => row.qty > 0);

          // A paper-ticket receipt shows the day on the ticket, matching the backdated delivery.
          const receiptDate = usePaperTicket && isValidPaperDeliveredOn(paperDeliveredOn)
            ? parseLocalDate(paperDeliveredOn).toLocaleDateString()
            : new Date().toLocaleDateString();
          const html = buildDeliveryReceiptHtml({
            variant: 'completed',
            deliveryNumber: delivery.delivery_number,
            contactName: sendToName,
            dateText: receiptDate,
            lines: deliveredLines,
            signedBy: signedBy || null,
            isPartial: isPartialDelivery,
          });

          await sendEmail({
            to: sendTo,
            subject: `Delivery ${delivery.delivery_number} Completed — Crop RX Solutions`,
            html,
            email_type: 'delivery_completed',
            customer_id: delivery.customer_id,
            resource_type: 'delivery',
            resource_id: delivery.id,
            idempotency_key: `delivery-completed-${delivery.id}`,
          });
        } catch (emailErr) {
          Sentry.captureException(emailErr instanceof Error ? emailErr : new Error(String(emailErr)), { level: 'warning', extra: { context: 'Delivery completion email failed — delivery already succeeded' } });
          // The delivery already succeeded; say plainly that the receipt did not go out.
          toast('warning', RECEIPT_NOT_SENT_MESSAGE);
        }
      } else if (emailOnComplete) {
        // The receipt was wanted but no address could be read here. A visible customer with no email
        // has none on file; otherwise the customer is hidden from this user and the lookup failed or
        // timed out. Say so instead of skipping it silently.
        toast('warning', customer ? RECEIPT_NO_EMAIL_ON_FILE_MESSAGE : RECEIPT_NO_EMAIL_MESSAGE);
      }

      if (signatureRouteIdRef.current === deliveryId) fetchDelivery();
    };

    let completeResult: unknown;
    try {
      completeResult = await sendCompletion();
    } catch (error: unknown) {
      // A binding refusal or SIGNATURE_IMAGE_MISSING retired the key in sendCompletion; nothing ran for
      // THIS request. Otherwise the key is still held: the reply may have been lost after a commit.
      const keyHeld = !getIdempotencyBindingRejection(error) && !isSignatureImageMissing(error);
      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'complete_delivery' } });
      // Reconcile with the server for THIS delivery. Completed with the key still held: resend the
      // identical call, which replays the saved result, and run the normal success path.
      const outcome = await reconcileFailedCompletion({ deliveryId, keyHeld, resend: sendCompletion, context: 'Delivery detail' });
      if (outcome.kind === 'replayed') {
        await finishCompleted(outcome.result);
        return;
      }
      if (outcome.kind === 'completed_not_replayed') {
        toast('error', forThisDelivery(COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE));
      } else {
        toast('error', forThisDelivery(sanitizeError(error)));
        // The upload had already failed for a reason other than the signal: say what it was.
        if (isSignatureImageMissing(error) && signatureUploadError && !isNetworkFailure(signatureUploadError)) {
          toast('error', forThisDelivery(sanitizeError(signatureUploadError)));
        }
      }
      if (signatureRouteIdRef.current !== deliveryId) return;
      // A completion that already committed must show as completed, not as a stale form. Only the
      // status was read: a full reload would reset the edited partial quantities, which a retry would
      // then send as full. Still open: refresh only the photos (a refused photo may be gone).
      if (outcome.kind === 'completed_not_replayed' || outcome.kind === 'closed') {
        await fetchDelivery();
      } else if (outcome.kind === 'open') {
        const photoSeq = ++photoSeqRef.current;
        const { data: refreshedPhotos, error: photosErr } = await supabase
          .from('delivery_photos').select('*').eq('delivery_id', deliveryId).order('sort_order');
        if (photosErr) {
          Sentry.captureException(photosErr, { level: 'warning', extra: { context: 'Refresh delivery photos after a failed completion', deliveryId } });
        } else if (signatureRouteIdRef.current === deliveryId && photoSeq === photoSeqRef.current) {
          setPhotos((refreshedPhotos || []) as DeliveryPhoto[]);
        }
      }
      return;
    }
    await finishCompleted(completeResult);
  };

  // ── Resend Delivery Confirmation Email ──────────────────────────────────
  const handleResendEmail = async () => {
    if (!delivery || !customer?.email) {
      toast('error', customer?.email ? 'Delivery not loaded' : 'No customer email on file');
      return;
    }
    setSendingEmail(true);
    try {
      const deliveredLines = items
        .filter((item) => (item.quantity_delivered ?? item.quantity) > 0)
        .map((item) => ({ name: item.product?.product_name || 'Product', qty: item.quantity_delivered ?? item.quantity }));

      // A delivery recorded without proof has no customer signer to show (its signer is office text).
      const html = buildDeliveryReceiptHtml({
        variant: 'confirmation',
        deliveryNumber: delivery.delivery_number,
        contactName: customer.contact_name ?? null,
        dateText: delivery.completed_at ? new Date(delivery.completed_at).toLocaleDateString() : new Date().toLocaleDateString(),
        lines: deliveredLines,
        signedBy: delivery.signed_by && delivery.completion_evidence !== 'no_proof' ? delivery.signed_by : null,
        isPartial: false,
      });

      await sendEmail({
        to: customer.email,
        subject: `Delivery ${delivery.delivery_number} Confirmation — Crop RX Solutions`,
        html,
        email_type: 'delivery_completed',
        customer_id: delivery.customer_id,
        resource_type: 'delivery',
        resource_id: delivery.id,
        idempotency_key: `delivery-resend-${delivery.id}-${Date.now()}`,
      });
      toast('success', `Confirmation email sent to ${customer.email}`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSendingEmail(false);
  };

  // U16a: office-visible twin of IntegrityCleanup's admin-only backfill (finding #78).
  const handleCreateInvoice = async () => {
    if (!delivery || !profile) return;
    setCreatingInvoice(true);

    try {
      const { data, error } = await supabase.rpc('create_invoice_for_unbilled_delivery', {
        p_delivery_id: delivery.id,
        p_performed_by: profile.id,
        p_idempotency_key: createInvoiceIdem.getKey(),
      });
      if (error) throw error;

      const result = assertRpcResult<CreateDeliveryInvoiceResult>(
        data,
        'create_invoice_for_unbilled_delivery'
      );
      createInvoiceIdem.resetKey();
      setCreateInvoiceConfirmOpen(false);
      toast('success', `Invoice ${result.invoice_number} created`);
      await fetchDelivery();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        extra: { context: 'create_invoice_for_unbilled_delivery', deliveryId: delivery.id },
      });
      toast('error', sanitizeError(err));
    } finally {
      setCreatingInvoice(false);
    }
  };

  // ── Loading / Not Found ────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-32 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (loadFailedId === id) {
    return (
      <LoadFailedState
        title="This delivery could not be loaded"
        onRetry={() => { setLoading(true); fetchDelivery(); }}
      />
    );
  }

  if (!delivery) {
    return (
      <div className="text-center py-16">
        <p className="text-secondary">Delivery not found</p>
        <Button variant="ghost" className="mt-4" onClick={() => navigate('/deliveries')}>
          Back to Deliveries
        </Button>
      </div>
    );
  }

  const fullAddress = address
    ? [address.address_line, address.city, address.state, address.zip].filter(Boolean).join(', ')
    : customer?.billing_address || 'No address on file';

  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`;

  const canTakeDelivery =
    profile &&
    delivery.assigned_driver !== profile.id &&
    (delivery.status === 'scheduled' || delivery.status === 'in_progress') &&
    (isAdminOrRep || (isDriver && !delivery.assigned_driver));

  const canUploadPhoto =
    delivery.status !== 'cancelled' &&
    (isAdminOrRep || (isDriver && delivery.assigned_driver === profile?.id));

  const hasPendingRemainders = remainders.some((r) => r.status === 'pending');

  // ═══════════════════════════════════════════════════════════════════════
  // DRIVER VIEW (dark mobile UI)
  // ═══════════════════════════════════════════════════════════════════════

  // Shared by both layouts. The driver layout used to omit it, so a driver's
  // Complete Delivery tap opened nothing (found during the Goal 5 offline check).
  const completeConfirmModal = (
    <ConfirmModal
      open={completeConfirmOpen}
      onClose={() => setCompleteConfirmOpen(false)}
      onConfirm={handleComplete}
      title="Complete Delivery"
      message={`${completionEvidence === 'no_proof' ? 'Record this delivery as completed WITHOUT customer proof? Your name and reason are saved with it. ' : ''}${isPartialDelivery
        ? 'Complete this delivery with partial quantities? This will update inventory and cannot be undone.'
        : 'Complete this delivery? This will update inventory and cannot be undone.'}`}
      confirmLabel="Complete Delivery"
      variant="warning"
      loading={completing}
    />
  );

  if (isDriver) {
    return (
      <div className="dark min-h-screen bg-gray-900 -m-4 sm:-m-6 p-4 sm:p-6">
        <button
          onClick={() => navigate('/deliveries')}
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <div className="space-y-4">
          {/* Header card */}
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
              <h2 className="text-xl font-semibold text-white font-heading flex items-center gap-2">
                {delivery.delivery_number}
                {delivery.is_quick_delivery && (
                  <Badge variant="warning" size="sm">
                    <span className="flex items-center gap-1"><Zap className="w-3 h-3" />Quick</span>
                  </Badge>
                )}
              </h2>
              <div className="flex items-center gap-2 shrink-0">
                {delivery.priority && delivery.priority !== 'normal' && (
                  <Badge variant={PRIORITY_BADGE[delivery.priority] || 'default'} size="sm">
                    {PRIORITY_LABELS[delivery.priority]}
                  </Badge>
                )}
                <Badge variant={statusToBadgeVariant[delivery.status] || 'default'} size="md">
                  {delivery.status.replace('_', ' ')}
                </Badge>
              </div>
            </div>
            <p className="text-lg text-white font-medium">{customer?.farm_name}</p>
            <p className="text-sm text-gray-400 mt-1">
              {parseLocalDate(delivery.scheduled_date).toLocaleDateString()}
              {delivery.scheduled_time && ` at ${delivery.scheduled_time}`}
              {delivery.delivery_window_start && delivery.delivery_window_end &&
                ` (${delivery.delivery_window_start} - ${delivery.delivery_window_end})`}
            </p>
          </div>

          {/* Take delivery button */}
          {canTakeDelivery && (
            <button
              onClick={() => setReassignConfirmOpen(true)}
              disabled={reassigning}
              className="flex items-center gap-4 w-full bg-gray-800 rounded-xl p-5 border border-crx-green active:bg-gray-700 transition-colors disabled:opacity-50"
            >
              <div className="w-12 h-12 rounded-full bg-crx-green flex items-center justify-center shrink-0">
                <UserPlus className="w-6 h-6 text-white" />
              </div>
              <div className="text-left">
                <p className="text-white font-medium">{reassigning ? 'Reassigning...' : 'Take This Delivery'}</p>
                <p className="text-sm text-gray-400">Assign to yourself</p>
              </div>
            </button>
          )}

          {/* Call customer */}
          {customer?.phone && (
            <a
              href={`tel:${customer.phone}`}
              className="flex items-center gap-4 bg-gray-800 rounded-xl p-5 border border-gray-700 active:bg-gray-700 transition-colors"
            >
              <div className="w-12 h-12 rounded-full bg-crx-green flex items-center justify-center shrink-0">
                <Phone className="w-6 h-6 text-white" />
              </div>
              <div>
                <p className="text-white font-medium">Call Customer</p>
                <p className="text-sm text-gray-400">{customer.phone}</p>
              </div>
            </a>
          )}

          {/* Navigate */}
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-4 bg-gray-800 rounded-xl p-5 border border-gray-700 active:bg-gray-700 transition-colors"
          >
            <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
              <MapPin className="w-6 h-6 text-white" />
            </div>
            <div>
              <p className="text-white font-medium">Navigate to Address</p>
              <p className="text-sm text-gray-400">{fullAddress}</p>
            </div>
          </a>

          {/* RUP Compliance Warning */}
          {rupWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800">
                  {rupWarnings.map((w, i) => <p key={i}>{w}</p>)}
                </div>
              </div>
            </div>
          )}

          {/* Inventory Warning (driver view) */}
          {inventoryWarnings.length > 0 && (delivery.status === 'scheduled' || delivery.status === 'in_progress') && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">Low Inventory Warning</p>
                  <div className="text-sm text-amber-700 mt-1">
                    {inventoryWarnings.map((w, i) => <p key={i}>{w}</p>)}
                  </div>
                  <p className="text-xs text-amber-600 mt-1">Delivery can still proceed — verify physical stock.</p>
                </div>
              </div>
            </div>
          )}

          {/* Products */}
          <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
            <h3 className="text-white font-semibold mb-4">Products<HelpTip text="Adjust quantities down if you couldn't deliver everything. The remaining items automatically create a follow-up delivery." className="ml-1" /></h3>
            <div className="space-y-3">
              {items.map((item) => {
                const isActive = delivery.status !== 'completed' && delivery.status !== 'cancelled';
                const currentQty = deliveryQtys[item.id] ?? item.quantity;
                return (
                  <div key={item.id} className="flex items-center gap-3 bg-gray-700/50 rounded-lg p-4">
                    <Package className="w-5 h-5 text-gray-400 shrink-0" />
                    <div className="flex-1">
                      <p className="text-white font-medium">
                        {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                      </p>
                      {item.product && <ProductOptionDetails product={item.product as unknown as ProductOptionPresentationModel} textClassName="text-gray-300" />}
                      <p className="text-sm text-gray-400">
                        {delivery.status === 'completed'
                          ? `Delivered: ${item.quantity_delivered}/${item.quantity} ${item.unit_size || 'units'}`
                          : `Planned: ${item.quantity} ${item.unit_size || 'units'}`}
                      </p>
                    </div>
                    {isActive && (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => updateDeliveryQty(item.id, currentQty - 1, item.quantity)}
                          className="w-8 h-8 rounded-lg border border-gray-600 flex items-center justify-center text-gray-400 hover:text-white hover:border-gray-400 transition-colors"
                        >
                          <Minus className="w-3.5 h-3.5" />
                        </button>
                        <input
                          type="number"
                          value={currentQty}
                          onChange={(e) => updateDeliveryQty(item.id, parseFloat(e.target.value) || 0, item.quantity)}
                          className="w-16 text-center px-1 py-1.5 text-sm text-white bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green"
                          min="0"
                          step="any"
                          aria-label={`Quantity for ${(item.product as unknown as { product_name: string })?.product_name || 'item'}`}
                        />
                        <button
                          onClick={() => updateDeliveryQty(item.id, currentQty + 1, item.quantity)}
                          className="w-8 h-8 rounded-lg border border-gray-600 flex items-center justify-center text-gray-400 hover:text-white hover:border-gray-400 transition-colors"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* How the completion was confirmed: signature, photo proof, or recorded without proof */}
          <CompletionProofCards key={`${delivery.id}:${signedSignatureUrl ?? ''}`} delivery={delivery} signedSignatureUrl={signedSignatureUrl} signatureUrlFailed={signatureUrlFailed} dark />


          {/* Photo upload (driver) */}
          {canUploadPhoto && (
            <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-semibold">Delivery Photos<HelpTip text="Take up to 10 photos as proof of delivery — product condition, drop location, etc. They stay on the delivery record for staff; they are not sent to the customer." className="ml-1" /></h3>
                <span className="text-sm text-gray-400">{countOrdinaryPhotos(photos)}/{MAX_ORDINARY_DELIVERY_PHOTOS}</span>
              </div>
              {photos.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
                  {photos.map((photo) => (
                    <PrivatePhoto
                      key={photo.id}
                      bucket="delivery-photos"
                      path={deliveryPhotoPath(photo)}
                      alt={photo.caption || 'Delivery photo'}
                      className="w-full h-36 sm:h-48 object-contain rounded-lg border border-gray-600 bg-gray-800"
                      placeholderClassName="text-gray-500"
                    />
                  ))}
                </div>
              )}
              {countOrdinaryPhotos(photos) < MAX_ORDINARY_DELIVERY_PHOTOS && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handlePhotoUpload}
                    className="hidden"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingPhoto}
                    className="w-full py-3 flex items-center justify-center gap-2 text-white border border-gray-600 rounded-lg active:bg-gray-700 disabled:opacity-50 transition-colors"
                  >
                    <Camera className="w-5 h-5" />
                    {uploadingPhoto ? 'Uploading...' : 'Add Photo'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Start Delivery section — show when scheduled */}
          {delivery.status === 'scheduled' && (
            <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
              <div className="text-center py-6">
                <Package className="w-12 h-12 text-gray-500 mx-auto mb-3" />
                <h3 className="text-lg font-semibold text-white">Delivery Not Started</h3>
                <p className="text-sm text-gray-400 mt-1 mb-4">
                  Verify inventory on your truck, then start this delivery to begin.
                </p>
                {(isAssignedDriver || isAdminOrRep) && (
                  <button
                    onClick={() => setStartModalOpen(true)}
                    className="px-6 py-3 bg-crx-green text-white text-lg font-semibold rounded-xl active:bg-crx-green-hover transition-colors flex items-center justify-center gap-2 mx-auto"
                  >
                    <PlayCircle className="w-6 h-6" />
                    Start Delivery
                    <HelpTip text="Marks this delivery as in-progress. You can now adjust quantities, capture photos, and get the customer's signature." className="ml-1" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Issue reporting (driver, when in_progress) */}
          {delivery.status === 'in_progress' && (
            <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-3">
              <h3 className="text-white font-semibold">Report Issue (Optional)</h3>
              <select
                value={driverIssueType}
                onChange={(e) => setDriverIssueType(e.target.value as DeliveryIssueType)}
                className="w-full px-4 py-3 text-base text-white bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green"
              >
                {Object.entries(ISSUE_TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              {driverIssueType !== 'none' && (
                <textarea
                  value={driverIssueNotes}
                  onChange={(e) => setDriverIssueNotes(e.target.value)}
                  placeholder="Describe the issue..."
                  rows={2}
                  className="w-full px-4 py-3 text-base text-white bg-gray-700 border border-gray-600 rounded-lg placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-crx-green resize-none"
                />
              )}
            </div>
          )}

          {/* Complete delivery section — only when in_progress */}
          {delivery.status === 'in_progress' && (
            <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
              <h3 className="text-white font-semibold">Complete Delivery<HelpTip text="Finalizes the delivery. Inventory is deducted, the customer gets an email receipt, and a draft invoice is created automatically." className="ml-1" /></h3>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">Signed By</label>
                <input
                  type="text"
                  value={signedBy}
                  onChange={(e) => setSignedBy(e.target.value)}
                  placeholder="Customer name"
                  className="w-full px-4 py-3 text-base text-white bg-gray-700 border border-gray-600 rounded-lg placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-crx-green"
                />
              </div>
              <div className="flex items-center gap-1">
              <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={usePaperTicket}
                  onChange={(e) => {
                    setUsePaperTicket(e.target.checked);
                    if (e.target.checked) setSignatureDataUrl(null);
                  }}
                  className="w-4 h-4 rounded border-gray-600 text-crx-green focus:ring-crx-green bg-gray-700"
                />
                Customer signed a paper ticket (no signal at the site)
              </label>
              {/* Outside the label, so opening help never toggles paper mode. */}
              <HelpTip text="Use this when there was no signal at the customer and they signed a paper delivery ticket. Take a photo of the signed ticket instead of an on-screen signature." className="ml-1" />
              </div>
              {usePaperTicket ? (
                <div className="bg-gray-700 rounded-lg p-3 space-y-2">
                  <input
                    ref={paperTicketInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => handlePhotoUpload(e, PAPER_TICKET_PHOTO_CAPTION)}
                    className="hidden"
                  />
                  {hasPaperTicketPhoto(photos) ? (
                    <p className="flex items-center gap-2 text-sm text-green-300">
                      <CheckCircle2 className="w-4 h-4 shrink-0" /> Photo of the signed ticket saved
                    </p>
                  ) : (
                    <p className="text-sm text-yellow-300">A photo of the signed paper ticket is required.</p>
                  )}
                  <div>
                    <label htmlFor="paper-delivered-on" className="block text-sm font-medium text-gray-400 mb-1">Delivered on (date on the ticket)</label>
                    <input
                      id="paper-delivered-on"
                      type="date"
                      value={paperDeliveredOn}
                      max={todayInBusinessTz()}
                      onChange={(e) => setPaperDeliveredOn(e.target.value)}
                      className="w-full px-4 py-3 text-base text-white bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => paperTicketInputRef.current?.click()}
                    disabled={uploadingPhoto || !isOnline || countPaperTicketPhotos(photos) >= MAX_PAPER_TICKET_PHOTOS}
                    className="w-full py-3 flex items-center justify-center gap-2 text-white border border-gray-600 rounded-lg active:bg-gray-600 disabled:opacity-50 transition-colors"
                  >
                    <Camera className="w-5 h-5" />
                    {uploadingPhoto ? 'Uploading...' : 'Take Photo of Signed Ticket'}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1 mb-1">
                    <span className="text-sm font-medium text-gray-400">Customer Signature</span>
                    <HelpTip text="Have the customer sign with their finger or mouse. This saves as part of the delivery record for your files." className="ml-1" />
                  </div>
                  <div className="bg-gray-700 rounded-lg p-3">
                    <SignatureCanvas
                      onSignatureChange={setSignatureDataUrl}
                      label=""
                      height={120}
                    />
                  </div>
                </>
              )}
              {receiptEmail && (
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={emailOnComplete}
                    onChange={(e) => setEmailOnComplete(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-600 text-crx-green focus:ring-crx-green bg-gray-700"
                  />
                  Email delivery receipt to customer
                  <HelpTip text="If checked, the customer receives an email with the items delivered and who signed (no photos). Uncheck if this is an internal transfer." className="ml-1" />
                </label>
              )}
              {!isOnline && (
                <div className="flex items-center gap-2 p-3 bg-yellow-900/30 border border-yellow-700 rounded-lg text-yellow-300 text-sm">
                  <WifiOff className="h-4 w-4 shrink-0" />
                  <span>No signal. A delivery can only be completed with signal; nothing is saved offline. If the customer is signing now, use a paper ticket and complete it here once you have signal.</span>
                </div>
              )}
              <button
                onClick={requestComplete}
                disabled={completing}
                className="w-full py-4 bg-crx-green text-white text-lg font-semibold rounded-xl active:bg-crx-green-hover disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                <CheckCircle2 className="w-6 h-6" />
                {completing ? 'Completing...' : 'Complete Delivery'}
              </button>
            </div>
          )}
        </div>

        {completeConfirmModal}

        {/* Start Delivery Modal (driver view) */}
        <StartDeliveryModal
          open={startModalOpen}
          onClose={() => setStartModalOpen(false)}
          onConfirm={handleStartDelivery}
          delivery={delivery}
          items={items.map((i) => ({
            id: i.id,
            product_name: (i.product as unknown as { product_name: string })?.product_name,
            quantity: i.quantity,
            unit_size: i.unit_size ?? undefined,
          }))}
          loading={confirming}
        />
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN / SALES REP VIEW (light desktop UI)
  // ═══════════════════════════════════════════════════════════════════════

  return (
    <div className="space-y-4">
      <Breadcrumbs items={[
        { label: 'Deliveries', href: '/deliveries' },
        { label: delivery.delivery_number },
      ]} />

      <TransactionThread
        quoteId={parentQuote?.id}
        quoteNumber={parentQuote?.quote_number}
        orderId={parentOrder?.id}
        orderNumber={parentOrder?.order_number}
        deliveries={siblingDeliveries.map(d => ({ id: d.id, number: d.delivery_number }))}
        invoices={relatedInvoices.map(i => ({ id: i.id, number: i.invoice_number }))}
        currentEntity="delivery"
        currentEntityId={delivery.id}
      />

      {/* Header Card */}
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold font-heading text-nav-dark flex items-center gap-2">
              {delivery.delivery_number}
              {delivery.is_quick_delivery && (
                <Badge variant="warning" size="sm">
                  <span className="flex items-center gap-1"><Zap className="w-3 h-3" />Quick</span>
                </Badge>
              )}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-sm text-secondary">{customer?.farm_name}</span>
              {parentOrder && (
                <>
                  <span className="text-gray-300">·</span>
                  <button
                    onClick={() => navigate(`/orders/${parentOrder.id}`)}
                    className="text-sm text-crx-green hover:underline font-medium"
                  >
                    {parentOrder.order_number}
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canConfirm && !editing && (
              <Button
                size="sm"
                icon={<PlayCircle className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setStartModalOpen(true)}
              >
                Start Delivery
              </Button>
            )}
            {canEdit && !editing && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Pencil className="w-4 h-4" />}
                showChevron={false}
                onClick={startEditing}
              >
                Edit
              </Button>
            )}
            {canTakeDelivery && (
              <Button
                variant="secondary"
                size="sm"
                icon={<UserPlus className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setReassignConfirmOpen(true)}
                disabled={reassigning}
                loading={reassigning}
              >
                Take Delivery
              </Button>
            )}
            {canCreateInvoice && (
              <Button
                size="sm"
                icon={<FileText className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setCreateInvoiceConfirmOpen(true)}
                disabled={creatingInvoice}
              >
                Create Invoice
              </Button>
            )}
            {/* H5: the server would refuse this one. Show it disabled with the
                reason instead of a button that cannot succeed. */}
            {splitBillingBlocksInvoice && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  icon={<FileText className="w-4 h-4" />}
                  showChevron={false}
                  disabled
                >
                  Create Invoice
                </Button>
                <HelpTip text={SPLIT_BILLING_BLOCK_REASON} />
              </div>
            )}
            {isAdmin && delivery?.status === 'completed' && billedOutsideCrxReason !== null && (
              <div className="flex items-center gap-1 text-sm text-secondary">
                <FileText className="w-4 h-4" />
                <span>Billed outside CRX</span>
                <HelpTip text={billedOutsideCrxReason} />
              </div>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-4 h-4" />}
              showChevron={false}
              onClick={async () => {
                // Pre-fetch signature image as base64 data URL for jsPDF
                let sigDataUrl: string | undefined;
                if (signedSignatureUrl) {
                  try {
                    const resp = await fetch(signedSignatureUrl);
                    const blob = await resp.blob();
                    sigDataUrl = await new Promise<string>((resolve) => {
                      const reader = new FileReader();
                      reader.onloadend = () => resolve(reader.result as string);
                      reader.readAsDataURL(blob);
                    });
                  } catch {
                    // Fall back to no signature in PDF
                  }
                }
                downloadDeliveryPdf({
                  delivery_number: delivery.delivery_number,
                  order_number: parentOrder?.order_number || '-',
                  customer_name: customer?.farm_name || 'Customer',
                  customer_address: address
                    ? [address.address_line, address.city, address.state, address.zip].filter(Boolean).join(', ')
                    : customer?.shipping_address || customer?.billing_address || undefined,
                  contact_name: customer?.contact_name || undefined,
                  contact_phone: customer?.phone || undefined,
                  driver_name: driver?.full_name || 'Unassigned',
                  scheduled_date: delivery.scheduled_date,
                  completed_at: delivery.completed_at || undefined,
                  status: delivery.status,
                  signed_by: delivery.signed_by || undefined,
                  signature_image_data_url: sigDataUrl,
                  delivery_notes: delivery.delivery_notes || undefined,
                  items: items.map((i) => ({
                    product_name: i.product?.product_name || 'Unknown',
                    quantity: i.quantity,
                    quantity_delivered: delivery.status === 'completed' ? i.quantity_delivered : undefined,
                    unit_size: i.unit_size || '-',
                    tote_number: i.tote_number || undefined,
                  })),
                });
              }
              }
            >
              Receipt PDF
            </Button>
            {delivery.status === 'completed' && customer?.email && role && role !== 'applicator' && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Mail className="w-4 h-4" />}
                showChevron={false}
                onClick={handleResendEmail}
                loading={sendingEmail}
              >
                Email Confirmation
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<MessageSquarePlus className="w-4 h-4" />}
              showChevron={false}
              onClick={() => setQuickTaskOpen(true)}
            >
              Create Task
            </Button>
            {canCancel && (
              <Button
                variant="danger"
                size="sm"
                icon={<Ban className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setCancelOpen(true)}
              >
                Cancel
              </Button>
            )}
            {canVoid && (
              <Button
                variant="danger"
                size="sm"
                icon={<RotateCcw className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setVoidOpen(true)}
              >
                Void Delivery
              </Button>
            )}
            {delivery.priority && delivery.priority !== 'normal' && (
              <Badge variant={PRIORITY_BADGE[delivery.priority] || 'default'} size="md">
                {PRIORITY_LABELS[delivery.priority]}
              </Badge>
            )}
            <Badge variant={statusToBadgeVariant[delivery.status] || 'default'} size="md">
              {delivery.status.replace('_', ' ')}
            </Badge>
          </div>
        </div>

        {/* Delivery info — read mode */}
        {!editing && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
            <div>
              <p className="text-xs text-secondary">Scheduled</p>
              <p className="text-sm font-medium text-nav-dark">
                {parseLocalDate(delivery.scheduled_date).toLocaleDateString()}
                {delivery.scheduled_time && ` at ${delivery.scheduled_time}`}
              </p>
              {delivery.delivery_window_start && delivery.delivery_window_end && (
                <p className="text-xs text-secondary mt-0.5">
                  Window: {delivery.delivery_window_start} - {delivery.delivery_window_end}
                </p>
              )}
            </div>
            <div>
              <p className="text-xs text-secondary">Driver</p>
              <p className="text-sm font-medium text-nav-dark">
                {driver?.full_name || 'Unassigned'}
              </p>
            </div>
            <div>
              <p className="text-xs text-secondary">Address</p>
              <p className="text-sm font-medium text-nav-dark">{fullAddress}</p>
            </div>
            <div>
              <p className="text-xs text-secondary">Phone</p>
              <p className="text-sm font-medium text-nav-dark">{customer?.phone || '-'}</p>
            </div>
            {delivery.delivery_notes && (
              <div className="col-span-2 sm:col-span-4">
                <p className="text-xs text-secondary">Notes</p>
                <p className="text-sm text-nav-dark">{delivery.delivery_notes}</p>
              </div>
            )}
          </div>
        )}

        {/* Delivery info — edit mode */}
        {editing && (
          <div className="mt-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Assigned Driver</label>
                <select
                  value={editDriver}
                  onChange={(e) => setEditDriver(e.target.value)}
                  className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">Unassigned</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>{d.full_name} ({d.role})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Priority</label>
                <select
                  value={editPriority}
                  onChange={(e) => setEditPriority(e.target.value)}
                  className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  {Object.entries(PRIORITY_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Scheduled Date"
                type="date"
                value={editDate}
                onChange={(e) => setEditDate(e.target.value)}
              />
              <Input
                label="Scheduled Time"
                type="time"
                value={editTime}
                onChange={(e) => setEditTime(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Delivery Window Start"
                type="time"
                value={editWindowStart}
                onChange={(e) => setEditWindowStart(e.target.value)}
              />
              <Input
                label="Delivery Window End"
                type="time"
                value={editWindowEnd}
                onChange={(e) => setEditWindowEnd(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Delivery Address</label>
              <select
                value={editAddress}
                onChange={(e) => setEditAddress(e.target.value)}
                className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Use billing address</option>
                {addresses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} - {[a.address_line, a.city, a.state].filter(Boolean).join(', ')}
                  </option>
                ))}
              </select>
            </div>
            <Input
              label="Delivery Notes"
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              placeholder="Special instructions, gate codes, etc."
            />

            {/* Delivery items — editable when scheduled, locked when in_progress */}
            <div>
              <h4 className="text-sm font-medium text-secondary mb-2">Delivery Items</h4>
              {delivery.status !== 'scheduled' && (
                <div className="p-3 bg-blue-50 rounded-lg border border-blue-200 text-sm text-blue-700 mb-3 flex items-start gap-2">
                  <Lock className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Items are locked while delivery is in progress</p>
                    <p className="text-xs mt-1">Adjust quantities during completion if needed.</p>
                  </div>
                </div>
              )}
              {delivery.status === 'scheduled' && (
                <div className="p-3 bg-green-50 rounded-lg border border-green-200 text-sm text-green-700 mb-3 flex items-start gap-2">
                  <Pencil className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">You can add, remove, or adjust items</p>
                    <p className="text-xs mt-1">Removed items will stay on the order for a future delivery.</p>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                {editItems.map((item) => (
                  <div key={item.order_item_id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-nav-dark truncate">{item.product_name}</p>
                      {item.product && <ProductOptionDetails product={item.product} />}
                      <p className="text-xs text-secondary">
                        {item.unit_size || 'units'}
                        {delivery.status === 'scheduled' && (
                          <span className="ml-2 text-secondary">· max {item.max_quantity}</span>
                        )}
                      </p>
                    </div>
                    {delivery.status === 'scheduled' ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setEditItems((prev) =>
                            prev.map((i) =>
                              i.order_item_id === item.order_item_id
                                ? { ...i, quantity: Math.max(0, i.quantity - 1) }
                                : i
                            )
                          )}
                          className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors"
                        >
                          <Minus className="w-3.5 h-3.5 text-secondary" />
                        </button>
                        <input
                          type="number"
                          value={item.quantity}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            setEditItems((prev) =>
                              prev.map((i) =>
                                i.order_item_id === item.order_item_id
                                  ? { ...i, quantity: Math.max(0, Math.min(val, i.max_quantity)) }
                                  : i
                              )
                            );
                          }}
                          className="w-20 text-center px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                          min="0"
                          max={item.max_quantity}
                          step="any"
                        />
                        <button
                          onClick={() => setEditItems((prev) =>
                            prev.map((i) =>
                              i.order_item_id === item.order_item_id
                                ? { ...i, quantity: Math.min(i.quantity + 1, i.max_quantity) }
                                : i
                            )
                          )}
                          className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors"
                        >
                          <Plus className="w-3.5 h-3.5 text-secondary" />
                        </button>
                        <button
                          onClick={() => {
                            const next = removeDeliveryEditItem(editItems, availableOrderItems, item.order_item_id);
                            setEditItems(next.editItems);
                            setAvailableOrderItems(next.availableItems);
                          }}
                          className="w-8 h-8 rounded-lg border border-red-200 flex items-center justify-center hover:bg-red-50 transition-colors"
                          title="Remove from delivery"
                        >
                          <Ban className="w-3.5 h-3.5 text-red-500" />
                        </button>
                      </div>
                    ) : (
                      <p className="text-sm font-mono font-medium text-nav-dark">{item.quantity}</p>
                    )}
                  </div>
                ))}
              </div>

              {/* Add item from order — only for scheduled deliveries */}
              {delivery.status === 'scheduled' && availableOrderItems.length > 0 && (
                <div className="mt-3">
                  <label className="block text-xs font-medium text-secondary mb-1">Add item from order</label>
                  <select
                    value=""
                    onChange={(e) => {
                      const oiId = e.target.value;
                      if (!oiId) return;
                      const next = addDeliveryEditItem(editItems, availableOrderItems, oiId);
                      setEditItems(next.editItems);
                      setAvailableOrderItems(next.availableItems);
                    }}
                    className="w-full px-3 py-2 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">Select a product to add...</option>
                    {availableOrderItems.map((a) => (
                      <option key={a.order_item_id} value={a.order_item_id}>
                        {a.product ? productOptionLabel(a.product) : a.product_name} — up to {a.max_quantity} {a.unit_size || 'units'}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
              <Button onClick={saveEdit} loading={savingEdit}>Save Changes</Button>
            </div>
          </div>
        )}
      </Card>

      {/* Cancel info for cancelled deliveries */}
      {delivery.status === 'cancelled' && delivery.cancel_reason && (
        <Card>
          <div className="flex items-start gap-3">
            <Ban className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-red-700">Cancelled</h3>
              <p className="text-sm text-secondary mt-1">{delivery.cancel_reason}</p>
              {delivery.cancelled_at && (
                <p className="text-xs text-secondary mt-1">
                  {new Date(delivery.cancelled_at).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Auto-created invoice banner */}
      {delivery.status === 'completed' && autoInvoiceId && (
        <Card>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FileText className="w-5 h-5 text-crx-green" />
              <p className="text-sm font-medium text-nav-dark">
                A draft invoice was auto-created for this delivery.
              </p>
            </div>
            <Button
              size="sm"
              icon={<FileText className="w-4 h-4" />}
              onClick={() => navigate(`/invoices/${autoInvoiceId}`)}
            >
              View Invoice
            </Button>
          </div>
        </Card>
      )}

      {/* Issue info for completed deliveries with issues */}
      {delivery.status === 'completed' && delivery.issue_type && delivery.issue_type !== 'none' && (
        <Card>
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-semibold text-amber-700">
                Issue Reported: {ISSUE_TYPE_LABELS[delivery.issue_type] || delivery.issue_type}
              </h3>
              {delivery.issue_notes && (
                <p className="text-sm text-secondary mt-1">{delivery.issue_notes}</p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* How the completion was confirmed: signature, photo proof, or recorded without proof */}
      <CompletionProofCards key={`${delivery.id}:${signedSignatureUrl ?? ''}`} delivery={delivery} signedSignatureUrl={signedSignatureUrl} signatureUrlFailed={signatureUrlFailed} dark={false} />

      {/* Inventory Warning */}
      {inventoryWarnings.length > 0 && (delivery.status === 'scheduled' || delivery.status === 'in_progress') && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Low Inventory Warning</p>
              <div className="text-sm text-amber-700 mt-1">
                {inventoryWarnings.map((w, i) => <p key={i}>{w}</p>)}
              </div>
              <p className="text-xs text-amber-600 mt-1">Delivery can still proceed — verify physical stock.</p>
            </div>
          </div>
        </div>
      )}

      {/* Products table with order context */}
      {!editing && (
        <Card>
          <h3 className="text-lg font-semibold font-heading text-nav-dark mb-4">Products</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-3 text-left font-medium text-secondary">Product</th>
                  <th className="px-4 py-3 text-right font-medium text-secondary">Ordered</th>
                  <th className="px-4 py-3 text-right font-medium text-secondary">Prev. Delivered</th>
                  <th className="px-4 py-3 text-right font-medium text-secondary">This Delivery</th>
                  {delivery.status === 'completed' && (
                    <th className="px-4 py-3 text-right font-medium text-secondary">Actual</th>
                  )}
                  <th className="px-4 py-3 text-right font-medium text-secondary">Remaining After</th>
                  <th className="px-4 py-3 text-left font-medium text-secondary">Unit</th>
                  {items.some((i) => i.tote_number) && (
                    <th className="px-4 py-3 text-left font-medium text-secondary">Tote #</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const ctx = orderItemContext[item.order_item_id];
                  const ordered = ctx?.ordered ?? item.quantity;
                  const prevDelivered = ctx?.delivered ?? 0;
                  const thisDelivery = item.quantity;
                  const actualDelivered = delivery.status === 'completed' ? item.quantity_delivered : thisDelivery;
                  const remainingAfter = Math.max(0, ordered - prevDelivered - actualDelivered);
                  return (
                    <tr key={item.id} className="border-b border-gray-50">
                      <td className="px-4 py-3 font-medium text-nav-dark">
                        {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">{ordered}</td>
                      <td className="px-4 py-3 text-right font-mono text-secondary">{prevDelivered}</td>
                      <td className="px-4 py-3 text-right font-mono">{thisDelivery}</td>
                      {delivery.status === 'completed' && (
                        <td className="px-4 py-3 text-right font-mono">
                          <span className={item.quantity_delivered < item.quantity ? 'text-amber-600 font-medium' : ''}>
                            {item.quantity_delivered}
                          </span>
                          {item.quantity_delivered < item.quantity && (
                            <span className="text-xs text-amber-500 ml-1">(partial)</span>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3 text-right font-mono">
                        <span className={remainingAfter > 0 ? 'text-amber-600 font-medium' : 'text-green-600'}>
                          {remainingAfter}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-secondary">{item.unit_size || '-'}</td>
                      {items.some((i) => i.tote_number) && (
                        <td className="px-4 py-3 text-secondary">{item.tote_number || '-'}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Complete Delivery section — admin/sales_rep view when in_progress */}
      {delivery.status === 'in_progress' && isAdminOrRep && (
        <Card>
          <h3 className="text-lg font-semibold font-heading text-nav-dark mb-4">Complete Delivery</h3>

          {/* Quantity adjustments per item */}
          <div className="space-y-2 mb-4">
            <p className="text-sm text-secondary">Adjust quantities if partial delivery:<HelpTip text="Adjust quantities down if you couldn't deliver everything. The remaining items automatically create a follow-up delivery." className="ml-1" /></p>
            {items.map((item) => {
              const currentQty = deliveryQtys[item.id] ?? item.quantity;
              return (
                <div key={item.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-nav-dark truncate">
                      {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                    </p>
                    <p className="text-xs text-secondary">Planned: {item.quantity} {item.unit_size || 'units'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => updateDeliveryQty(item.id, currentQty - 1, item.quantity)}
                      className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors"
                    >
                      <Minus className="w-3.5 h-3.5 text-secondary" />
                    </button>
                    <input
                      type="number"
                      value={currentQty}
                      onChange={(e) => updateDeliveryQty(item.id, parseFloat(e.target.value) || 0, item.quantity)}
                      className="w-20 text-center px-2 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                      min="0"
                      step="any"
                    />
                    <button
                      onClick={() => updateDeliveryQty(item.id, currentQty + 1, item.quantity)}
                      className="w-8 h-8 rounded-lg border border-gray-200 flex items-center justify-center hover:bg-gray-100 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5 text-secondary" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Signed by */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <Input
              label="Signed By"
              value={completionSignedBy}
              onChange={(e) => setSignedBy(e.target.value)}
              placeholder="Customer name"
              disabled={completionEvidence === 'no_proof'}
              required
            />
            <div>
              <label className="block text-sm font-medium text-secondary mb-1">Issue (Optional)</label>
              <select
                value={driverIssueType}
                onChange={(e) => setDriverIssueType(e.target.value as DeliveryIssueType)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                {Object.entries(ISSUE_TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          {driverIssueType !== 'none' && (
            <div className="mb-4">
              <Input
                label="Issue Notes"
                value={driverIssueNotes}
                onChange={(e) => setDriverIssueNotes(e.target.value)}
                placeholder="Describe the issue..."
              />
            </div>
          )}

          {completionEvidence !== 'no_proof' && (
            <div className="flex items-center gap-1 mb-3">
              <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={usePaperTicket}
                  onChange={(e) => {
                    setUsePaperTicket(e.target.checked);
                    if (e.target.checked) setSignatureDataUrl(null);
                  }}
                  className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                />
                Customer signed a paper ticket
              </label>
              <HelpTip text="Use this when the customer signed a paper delivery ticket instead of the screen. A photo of the signed ticket is required in place of the on-screen signature." className="ml-1" />
            </div>
          )}

          {isAdmin && (
            <div className="flex items-center gap-1 mb-3">
              <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={useNoProof}
                  onChange={(e) => {
                    setUseNoProof(e.target.checked);
                    if (e.target.checked) { setUsePaperTicket(false); setSignatureDataUrl(null); }
                  }}
                  className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
                />
                Record without proof (admin only)
              </label>
              <HelpTip text="Only when there is no signature and no ticket photo, for example a delivery confirmed by phone. Your name, the time and your written reason are saved with the delivery. No receipt is emailed automatically." className="ml-1" />
            </div>
          )}

          {completionEvidence === 'no_proof' ? (
            <div className="mb-4 border border-amber-300 rounded-lg p-3 bg-amber-50 space-y-2">
              <label htmlFor="no-proof-reason" className="flex items-center gap-2 text-sm font-medium text-amber-900">
                <AlertTriangle className="w-4 h-4 shrink-0" /> Why is there no proof? (required)
              </label>
              <textarea
                id="no-proof-reason"
                value={noProofReason}
                onChange={(e) => setNoProofReason(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="For example: customer confirmed by phone on 10/21 that all items arrived"
                aria-describedby="no-proof-reason-count"
                className="w-full px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              />
              <p
                id="no-proof-reason-count"
                className={`text-xs ${isValidNoProofReason(noProofReason) ? 'text-secondary' : 'text-amber-800'}`}
              >
                {noProofReasonLength(noProofReason)} / {NO_PROOF_REASON_MAX_CHARS} characters (at least {NO_PROOF_REASON_MIN_CHARS})
              </p>
              <div>
                <label htmlFor="no-proof-delivered-on" className="block text-sm font-medium text-amber-900 mb-1">Delivered on</label>
                <input
                  id="no-proof-delivered-on"
                  type="date"
                  value={paperDeliveredOn}
                  max={todayInBusinessTz()}
                  onChange={(e) => setPaperDeliveredOn(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
            </div>
          ) : usePaperTicket ? (
            <div className="mb-4 border border-gray-200 rounded-lg p-3 bg-white space-y-3">
              <input
                ref={paperTicketInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => handlePhotoUpload(e, PAPER_TICKET_PHOTO_CAPTION)}
                className="hidden"
              />
              {hasPaperTicketPhoto(photos) ? (
                <p className="flex items-center gap-2 text-sm text-green-700">
                  <CheckCircle2 className="w-4 h-4 shrink-0" /> Photo of the signed ticket saved
                </p>
              ) : (
                <p className="text-sm text-amber-700">A photo of the signed paper ticket is required.</p>
              )}
              <div>
                <label htmlFor="paper-delivered-on-office" className="block text-sm font-medium text-secondary mb-1">Delivered on (date on the ticket)</label>
                <input
                  id="paper-delivered-on-office"
                  type="date"
                  value={paperDeliveredOn}
                  max={todayInBusinessTz()}
                  onChange={(e) => setPaperDeliveredOn(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <Button
                variant="secondary"
                icon={<Camera className="w-4 h-4" />}
                onClick={() => paperTicketInputRef.current?.click()}
                disabled={uploadingPhoto || !isOnline || countPaperTicketPhotos(photos) >= MAX_PAPER_TICKET_PHOTOS}
              >
                {uploadingPhoto ? 'Uploading...' : 'Add Photo of Signed Ticket'}
              </Button>
            </div>
          ) : (
            <div className="mb-4 border border-gray-200 rounded-lg p-3 bg-white">
              <SignatureCanvas
                onSignatureChange={setSignatureDataUrl}
                label="Customer Signature"
                height={120}
              />
            </div>
          )}

          {receiptEmail && completionEvidence !== 'no_proof' && (
            <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer mb-4">
              <input
                type="checkbox"
                checked={emailOnComplete}
                onChange={(e) => setEmailOnComplete(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
              />
              Email delivery receipt to customer
              <HelpTip text="If checked, the customer receives an email with the items delivered and who signed (no photos). Uncheck if this is an internal transfer." className="ml-1" />
            </label>
          )}

          {!isOnline && (
            <p role="alert" className="flex items-start gap-2 mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
              No signal. A delivery can only be completed with signal; nothing is saved offline.
            </p>
          )}

          <div className="flex justify-end">
            <Button
              onClick={requestComplete}
              loading={completing}
              icon={<CheckCircle2 className="w-4 h-4" />}
            >
              {isPartialDelivery ? 'Complete (Partial)' : 'Complete Delivery'}
            </Button>
          </div>
        </Card>
      )}

      {/* Remainders for completed partial deliveries */}
      {delivery.status === 'completed' && remainders.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold font-heading text-nav-dark">Remaining Items</h3>
            {hasPendingRemainders && isAdminOrRep && (
              <Button
                size="sm"
                icon={<RefreshCw className="w-4 h-4" />}
                onClick={handleCreateFollowup}
                loading={creatingFollowup}
              >
                Create Follow-up Delivery
              </Button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-3 text-left font-medium text-secondary">Product</th>
                  <th className="px-4 py-3 text-left font-medium text-secondary">Remaining</th>
                  <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                </tr>
              </thead>
              <tbody>
                {remainders.map((rem) => (
                  <tr key={rem.id} className="border-b border-gray-50">
                    <td className="px-4 py-3 font-medium text-nav-dark">
                      {rem.product_name || 'Unknown'}
                    </td>
                    <td className="px-4 py-3 text-amber-600 font-medium">
                      {rem.quantity_remaining} {rem.unit_size || 'units'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={rem.status === 'pending' ? 'warning' : rem.status === 'scheduled' ? 'info' : rem.status === 'fulfilled' ? 'success' : 'default'}
                        size="sm"
                      >
                        {rem.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Related Notes */}
      <RelatedNotes
        entityType={'delivery' as LinkedEntityType}
        entityId={id!}
        onCreateTask={() => setQuickTaskOpen(true)}
      />

      {/* Photos section */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold font-heading text-nav-dark">
            Delivery Photos {photos.length > 0 && `(${photos.length})`}
          </h3>
          {canUploadPhoto && countOrdinaryPhotos(photos) < MAX_ORDINARY_DELIVERY_PHOTOS && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handlePhotoUpload}
                className="hidden"
              />
              <Button
                variant="secondary"
                size="sm"
                icon={<Camera className="w-4 h-4" />}
                showChevron={false}
                onClick={() => fileInputRef.current?.click()}
                loading={uploadingPhoto}
              >
                Upload Photo
              </Button>
            </>
          )}
        </div>
        {photos.length === 0 ? (
          <p className="text-sm text-secondary text-center py-6">No photos uploaded</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {photos.map((photo) => (
              <div key={photo.id} className="relative group">
                <PrivatePhotoButton
                  bucket="delivery-photos"
                  path={deliveryPhotoPath(photo)}
                  alt={photo.caption || 'Delivery photo'}
                  viewerTitle={photo.caption || 'Delivery photo'}
                  className="w-full h-48 object-contain rounded-lg border border-gray-200 bg-gray-50 cursor-pointer"
                />
                {photo.caption && (
                  <p className="text-xs text-secondary mt-1 truncate">{photo.caption}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Related Invoices (cross-link via shared order) */}
      {relatedInvoices.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <FileText className="w-5 h-5 text-crx-green" />
            <h3 className="font-semibold text-nav-dark">Related Invoices</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-2 text-left font-medium text-secondary">Invoice #</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Date</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Status</th>
                  <th className="px-4 py-2 text-right font-medium text-secondary">Total</th>
                </tr>
              </thead>
              <tbody>
                {relatedInvoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => navigate(`/invoices/${inv.id}`)}
                        className="text-crx-green hover:underline font-medium"
                      >
                        {inv.invoice_number}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {new Date(inv.invoice_date + 'T00:00:00').toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={statusToBadgeVariant[inv.status] || 'default'} size="sm">
                        {inv.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-right font-medium">
                      {fmtCents(inv.total_amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Start Delivery Modal */}
      <StartDeliveryModal
        open={startModalOpen}
        onClose={() => setStartModalOpen(false)}
        onConfirm={handleStartDelivery}
        delivery={delivery}
        items={items.map((i) => ({
          id: i.id,
          product_name: (i.product as unknown as { product_name: string })?.product_name,
          quantity: i.quantity,
          unit_size: i.unit_size ?? undefined,
        }))}
        loading={confirming}
      />

      {/* Void Delivery Modal */}
      <Modal open={voidOpen} onClose={() => setVoidOpen(false)} title="Void Completed Delivery">
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-lg">
            <RotateCcw className="w-5 h-5 text-red-600 shrink-0" />
            <p className="text-sm text-red-800">
              You are about to void delivery <strong>{delivery?.delivery_number}</strong>. This will:
              <ul className="mt-1 list-disc list-inside space-y-0.5">
                <li>Restore all inventory to the warehouse</li>
                <li>Reverse order item delivery quantities</li>
                <li>Delete delivery remainders from this delivery</li>
                <li>Auto-void any linked draft invoices</li>
              </ul>
              <span className="block mt-2 font-semibold text-red-900">This action cannot be undone. Posted invoices must be manually reviewed.</span>
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Void Reason <span className="text-red-500">*</span></label>
            <textarea
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Enter reason for voiding this delivery..."
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setVoidOpen(false)}>Go Back</Button>
            <Button
              variant="danger"
              icon={<RotateCcw className="w-4 h-4" />}
              onClick={handleVoidDelivery}
              loading={voiding}
              disabled={!voidReason.trim()}
            >
              Void Delivery
            </Button>
          </div>
        </div>
      </Modal>

      {/* Cancel Modal */}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel Delivery">
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-lg">
            <Ban className="w-5 h-5 text-red-600 shrink-0" />
            <p className="text-sm text-red-800">
              You are about to cancel delivery <strong>{delivery.delivery_number}</strong>.
              The assigned driver will be notified.
              {delivery.status === 'completed' && (
                <span className="block mt-1 font-semibold">
                  This delivery was already completed. Cancelling will reverse all inventory changes and restore stock to the warehouse.
                </span>
              )}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Cancel Reason</label>
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Enter reason for cancellation..."
              rows={3}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>Go Back</Button>
            <Button
              variant="danger"
              icon={<Ban className="w-4 h-4" />}
              onClick={handleCancel}
              loading={cancelling}
            >
              Cancel Delivery
            </Button>
          </div>
        </div>
      </Modal>

      <QuickTaskModal
        open={quickTaskOpen}
        onClose={() => setQuickTaskOpen(false)}
        entityType={'delivery' as LinkedEntityType}
        entityId={id!}
        prefillTitle={`Follow up: ${delivery.delivery_number}`}
        prefillContent={`Customer: ${customer?.farm_name || 'Unknown'}\nDriver: ${driver?.full_name || 'Unassigned'}\nDate: ${delivery.scheduled_date}`}
        prefillAssignee={delivery.assigned_driver || ''}
      />

      <ConfirmModal
        open={createInvoiceConfirmOpen}
        onClose={() => {
          if (!creatingInvoice) setCreateInvoiceConfirmOpen(false);
        }}
        onConfirm={() => { void handleCreateInvoice(); }}
        title="Create Invoice"
        message={`Create a draft invoice for completed delivery ${delivery.delivery_number}?`}
        confirmLabel="Create Invoice"
        variant="info"
        loading={creatingInvoice}
      />

      {/* Reassign confirm modal */}
      <ConfirmModal
        open={reassignConfirmOpen}
        onClose={() => setReassignConfirmOpen(false)}
        onConfirm={handleReassign}
        title="Take This Delivery"
        message={`Take delivery ${delivery.delivery_number}? The current driver will be notified.`}
        confirmLabel="Take Delivery"
        variant="warning"
        loading={reassigning}
      />

      {completeConfirmModal}
    </div>
  );
}

const EVIDENCE_LABELS: Record<string, string> = {
  signature: 'On-screen signature',
  paper_ticket: 'Signed paper ticket (photo below)',
  left_at_site: 'No one present (drop-location photo below)',
};
// A value this screen does not know yet (a newer server) still gets a card, with a neutral label.
const UNKNOWN_EVIDENCE_LABEL = 'Recorded proof (type not shown here)';

/**
 * How a completed delivery was confirmed, shown on both layouts. Every evidence type gets a text
 * card, even when the signature image cannot be loaded. The signature image appears only for a
 * signature completion (or a legacy row from before completion_evidence existed).
 */
function CompletionProofCards({ delivery, signedSignatureUrl, signatureUrlFailed, dark }: {
  delivery: Delivery;
  signedSignatureUrl: string | null;
  signatureUrlFailed: boolean;
  dark: boolean;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const evidence = delivery.completion_evidence ?? null;
  // A voided delivery recorded without proof keeps its amber card, so that record stays visible.
  if (delivery.status !== 'completed' && !(delivery.status === 'voided' && evidence === 'no_proof')) return null;
  const strong = dark ? 'font-medium text-white' : 'font-medium text-nav-dark';
  const completedLine = delivery.completed_at
    ? <p>Completed: {new Date(delivery.completed_at).toLocaleString()}</p>
    : null;

  if (evidence === 'no_proof') {
    return (
      <div className={dark
        ? 'rounded-xl p-5 border border-amber-700 bg-amber-950 text-sm text-amber-200 space-y-0.5'
        : 'rounded-xl p-5 border border-amber-300 bg-amber-50 text-sm text-amber-900 space-y-0.5'}
      >
        <h3 className={`flex items-center gap-2 font-semibold mb-2 ${dark ? 'text-amber-100' : 'text-lg font-heading text-amber-900'}`}>
          <AlertTriangle className="w-5 h-5 shrink-0" /> Recorded without proof
        </h3>
        <p className="font-medium">Recorded by office: no customer signature or photo.</p>
        <p>Reason: <span className="font-medium whitespace-pre-wrap break-words">{delivery.completion_evidence_ref || '-'}</span></p>
        <p>Recorded by: <span className="font-medium">{delivery.completion_no_proof_by_name || '-'}</span></p>
        {delivery.completion_no_proof_at && <p>Recorded at: {new Date(delivery.completion_no_proof_at).toLocaleString()}</p>}
        {completedLine}
      </div>
    );
  }

  const box = dark
    ? 'bg-gray-800 rounded-xl p-5 border border-gray-700 text-sm text-gray-400'
    : 'bg-white rounded-xl p-5 border border-gray-200 shadow-card text-sm text-secondary';
  const title = dark ? 'text-white font-semibold mb-3' : 'text-lg font-semibold font-heading text-nav-dark mb-3';

  if (evidence && evidence !== 'signature') {
    return (
      <div className={`${box} space-y-0.5`}>
        <h3 className={title}>Proof of Delivery</h3>
        <p>Signed by: <span className={strong}>{delivery.signed_by || '-'}</span></p>
        <p>Confirmed by: <span className={strong}>{EVIDENCE_LABELS[evidence] ?? UNKNOWN_EVIDENCE_LABEL}</span></p>
        {completedLine}
      </div>
    );
  }

  // signature, or a legacy completion (NULL evidence) that has a signature on file.
  if (evidence !== 'signature' && !delivery.signature_url) return null;
  const showImage = !!signedSignatureUrl && !imageFailed;
  // Say it cannot be shown only once that is known: no file on record, the link failed, or the image failed.
  const imageUnavailable = imageFailed || signatureUrlFailed || !delivery.signature_url;
  return (
    <div className={box}>
      <h3 className={title}>Signature</h3>
      <div className="flex items-start gap-4 flex-wrap">
        {showImage ? (
          <img
            src={signedSignatureUrl}
            alt="Customer signature"
            onError={() => setImageFailed(true)}
            className={dark ? 'border border-gray-600 rounded-lg max-w-xs bg-white' : 'border border-gray-200 rounded-lg max-w-xs'}
          />
        ) : imageUnavailable ? (
          <p className={dark ? 'text-amber-300' : 'text-amber-700'}>The signature image could not be shown here.</p>
        ) : (
          <p role="status" className={dark ? 'text-gray-400' : 'text-secondary'}>Loading signature...</p>
        )}
        <div className="space-y-0.5">
          <p>Signed by: <span className={strong}>{delivery.signed_by || '-'}</span></p>
          {evidence && <p>Confirmed by: <span className={strong}>{EVIDENCE_LABELS[evidence]}</span></p>}
          {completedLine}
        </div>
      </div>
    </div>
  );
}
