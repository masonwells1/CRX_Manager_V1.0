import { useState, useEffect, useRef , useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, Check, X, Plus, Trash2, Image as ImageIcon, AlertCircle, Link2, Unlink, ShoppingCart, ClipboardCheck, RefreshCw, MapPin, FileText } from 'lucide-react';
import { supabase, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { blockedUnitSaveMessage, type UnitLoadState } from '../lib/units';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import { useAuth } from '../contexts/AuthContext';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Input from '../components/ui/Input';
import SearchableSelect from '../components/ui/SearchableSelect';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import Skeleton from '../components/ui/Skeleton';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import HelpTip from '../components/ui/HelpTip';
import ConfirmModal from '../components/ui/ConfirmModal';
import { usePageMeta } from '../hooks/usePageMeta';
import { useToast } from '../components/ui/Toast';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { validateBlendMath, type BlendMathWarning } from '../lib/blendMathValidator';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { localToday } from '../lib/dateUtils';
import { useOCRThresholds } from '../hooks/useOCRThresholds';
import type { BlendTicket, BlendTicketProduct, BlendTicketImage, BlendTicketToOrderItem, Customer, Product, Order, OrderItem, Field, Job, UnitConversion } from '../types';
import { ProductOptionDetails, productOptionLabel, type ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';
import UnitSelect from '../components/blendtickets/UnitSelect';

type PickerProduct = Product & ProductOptionPresentationModel;

export function BlendTicketDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  usePageMeta();
  const { toast } = useToast();
  const ocrThresholds = useOCRThresholds();
  const saveIdem = useIdempotencyKey('save_blend_ticket', profile?.id || '');
  const linkIdem = useIdempotencyKey('link_blend_ticket_to_order', profile?.id || '');
  const unlinkIdem = useIdempotencyKey('unlink_blend_ticket_from_order', profile?.id || '');
  const createOrderIdem = useIdempotencyKey('create_order_from_blend_ticket', profile?.id || '');
  const appRecordIdem = useIdempotencyKey('create_application_record_from_blend_ticket', profile?.id || '');
  const fieldsIdem = useIdempotencyKey('save_blend_ticket_fields', profile?.id || '');
  const approveIdem = useIdempotencyKey('batch_approve_blend_tickets', profile?.id || '');
  const rejectIdem = useIdempotencyKey('batch_reject_blend_tickets', profile?.id || '');

  const [ticket, setTicket] = useState<BlendTicket | null>(null);
  const [images, setImages] = useState<BlendTicketImage[]>([]);
  const [products, setProducts] = useState<BlendTicketProduct[]>([]);
  const [allProducts, setAllProducts] = useState<PickerProduct[]>([]);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);
  const [unitLoad, setUnitLoad] = useState<UnitLoadState>('pending');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [warnings, setWarnings] = useState<BlendMathWarning[]>([]);
  const [showRawOcr, setShowRawOcr] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  const [saveHydrationRequired, setSaveHydrationRequired] = useState(false);
  const [hasApplicationRecord, setHasApplicationRecord] = useState(false);
  const [hasActiveInvoice, setHasActiveInvoice] = useState(false);
  const initialLoadDone = useRef(false);
  const hasUnsavedChanges = isDirty || fieldsDirty || saveHydrationRequired;
  const blocker = useUnsavedChanges(hasUnsavedChanges);

  // Jobs for job linking (B6)
  const [availableJobs, setAvailableJobs] = useState<Pick<Job, 'id' | 'job_number' | 'job_date' | 'status'>[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const [appServices, setAppServices] = useState<{id: string; name: string; vehicle_id: string | null}[]>([]);

  // Phase 3: Order linkage state
  const [availableFields, setAvailableFields] = useState<Field[]>([]);
  const [ticketFields, setTicketFields] = useState<{ field_id: string; customer_id: string | null; planned_acres: string; field_name?: string; customer_name?: string }[]>([]);
  const [savingFields, setSavingFields] = useState(false);
  const [linkedOrders, setLinkedOrders] = useState<BlendTicketToOrderItem[]>([]);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showCreateOrderModal, setShowCreateOrderModal] = useState(false);
  const [availableOrders, setAvailableOrders] = useState<(Order & { items?: OrderItem[] })[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [linking, setLinking] = useState(false);
  const [newOrderNumber, setNewOrderNumber] = useState('');
  const [newOrderDate, setNewOrderDate] = useState(localToday());
  const [newOrderNotes, setNewOrderNotes] = useState('');

  // Confirm modal states
  const [approveConfirmOpen, setApproveConfirmOpen] = useState(false);
  const [rejectConfirmOpen, setRejectConfirmOpen] = useState(false);
  const [removeProductConfirmOpen, setRemoveProductConfirmOpen] = useState(false);
  const [removeProductIndex, setRemoveProductIndex] = useState<number | null>(null);
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);
  const [reprocessConfirmOpen, setReprocessConfirmOpen] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<{ message: string; dupeId: string; dupeNumber: string } | null>(null);
  const [suggestedOrder, setSuggestedOrder] = useState<{ id: string; order_number: string; matchCount: number } | null>(null);
  const [createInvoiceConfirmOpen, setCreateInvoiceConfirmOpen] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const invoiceIdem = useIdempotencyKey('create_invoice_from_blend_ticket', profile?.id || '');

  const [formData, setFormData] = useState({
    customer_id: '',
    ticket_date: '',
    ticket_time: '',
    job_number: '',
    invoice_number: '',
    driver_name: '',
    applicator_name: '',
    mixer_name: '',
    tank_number: '',
    vehicle_info: '',
    application_service_id: '',
    field_names: '',
    total_acres: '',
    application_rate: '',
    total_volume: '',
    total_volume_unit: '',
    notes: '',
  });

  const contentLocked = Boolean(ticket && (
    ticket.order_link_status === 'linked'
    || ticket.payment_status !== 'unbilled'
    || hasActiveInvoice
    || hasApplicationRecord
  ));
  // The blend_ticket_fields trigger deliberately does not lock on order linkage.
  // It rejects only when an active direct invoice or application-record
  // provenance exists, so keep this predicate narrower than contentLocked.
  // payment_status is maintained by the billing lifecycle and is also the
  // fail-closed proxy when invoice SELECT RLS hides another user's invoice.
  const fieldsLocked = Boolean(ticket && (
    ticket.payment_status !== 'unbilled'
    || hasActiveInvoice
    || hasApplicationRecord
  ));
  const fieldControlsDisabled = fieldsLocked || saveHydrationRequired;

  const orderActionBlockReason = !ticket
    ? 'Blend ticket is still loading.'
    : hasUnsavedChanges
      ? 'Save your ticket changes before creating, linking, or billing downstream records.'
      : hasActiveInvoice
        ? 'This blend ticket has an active invoice. Void or cancel that invoice before creating or linking an order.'
        : ticket.status !== 'completed'
          ? 'Complete OCR processing before creating or linking an order.'
          : ticket.review_status !== 'approved'
            ? 'Approve this blend ticket before creating or linking an order.'
            : ticket.payment_status !== 'unbilled'
              ? 'Only an unbilled blend ticket can create or link an order.'
              : ticket.order_link_status !== 'unlinked'
                ? 'This blend ticket is already linked to an order.'
                : products.length === 0
                  ? 'Add at least one product before creating or linking an order.'
                  : products.some((product) => !product.product_id || product.quantity <= 0 || product.product?.is_active !== true)
                    ? 'Match every product to the active catalog and enter a positive quantity first.'
                    : null;

  const invoiceActionBlockReason = !ticket
    ? 'Blend ticket is still loading.'
    : hasUnsavedChanges
      ? 'Save your ticket changes before creating an invoice.'
      : hasActiveInvoice
        ? 'This blend ticket already has an active invoice. Void or cancel it before creating another invoice.'
        : ticket.order_link_status === 'linked'
          ? 'This blend ticket is linked to a sales order. Bill through the order path instead of creating a direct invoice.'
          : !ticket.customer_id
            ? 'Assign a customer before creating an invoice.'
            : products.length === 0
              ? 'Add at least one product before creating an invoice.'
              : null;

  const canReprocessOcr = ticket?.source === 'ocr'
    && ticket.review_status === 'unreviewed'
    && ticket.order_link_status === 'unlinked'
    && ticket.payment_status === 'unbilled'
    && !hasUnsavedChanges;

  const loadTicketData = useCallback(async () => {
    const wasTrackingDirty = initialLoadDone.current;
    // Every call is a server hydration (initial load or an explicit refetch),
    // not a user edit. Suppress the form/products effects until all hydrated
    // state has rendered, then re-arm dirty tracking in the animation frame.
    initialLoadDone.current = false;
    try {
      const [ticketResult, imagesResult, productsResult, allProductsResult, customersResult, fieldsResult, linkedResult, jobsResult, applicationRecordResult, activeInvoiceResult] = await Promise.all([
        // PR-07 follow-up: dropped uploader/reviewer/salesman FK embeds;
        // resolved via profile_public_view post-fetch (see below).
        supabase
          .from('blend_tickets')
          .select(`
            *,
            customer:customers(id, farm_name),
            field:fields(id, field_name)
          `)
          .eq('id', id!)
          .single(),
        supabase
          .from('blend_ticket_images')
          .select('*')
          .eq('blend_ticket_id', id!)
          .order('upload_order'),
        supabase
          .from('blend_ticket_products')
          .select('*, product:products(*)')
          .eq('blend_ticket_id', id!)
          .order('sequence_order'),
        supabase
          .from('products')
          .select('*, product_family:product_families(name)')
          .eq('is_active', true)
          .order('product_name'),
        supabase
          .from('customers')
          .select('*')
          .eq('is_active', true)
          .order('farm_name'),
        supabase
          .from('fields')
          .select('id, field_name, customer_id')
          .order('field_name'),
        supabase
          .from('blend_ticket_to_order_items')
          .select('*, order:orders(id, order_number, status, customer_id, total_price)')
          .eq('blend_ticket_id', id!),
        supabase
          .from('jobs')
          .select('id, job_number, job_date, status')
          .is('deleted_at', null)
          .order('job_date', { ascending: false })
          .limit(200),
        supabase
          .from('application_records')
          .select('id')
          .eq('source_type', 'blend_ticket')
          .eq('source_id', id!)
          .limit(1),
        supabase
          .from('invoices')
          .select('id')
          .eq('blend_ticket_id', id!)
          .is('deleted_at', null)
          .or('status.is.null,status.not.in.(voided,cancelled)')
          .limit(1)
      ]);

      if (ticketResult.error) throw ticketResult.error;
      if (imagesResult.error) throw imagesResult.error;
      if (productsResult.error) throw productsResult.error;
      if (applicationRecordResult.error) throw applicationRecordResult.error;
      if (activeInvoiceResult.error) throw activeInvoiceResult.error;

      // PR-07 follow-up: resolve uploader/reviewer/salesman names via
      // profile_public_view (safe columns only). UI uses .full_name.
      const tdata = ticketResult.data as { uploaded_by?: string | null; reviewed_by?: string | null; salesman_id?: string | null };
      const profIds = [tdata?.uploaded_by, tdata?.reviewed_by, tdata?.salesman_id].filter(Boolean) as string[];
      const profMap: Record<string, { id: string; full_name: string }> = {};
      if (profIds.length > 0) {
        const { data: profRows } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', profIds);
        ((profRows || []) as { id: string; full_name: string }[]).forEach((p: { id: string; full_name: string }) => {
          profMap[p.id] = p;
        });
      }
      const enrichedTicket = {
        ...ticketResult.data,
        uploader: tdata?.uploaded_by ? profMap[tdata.uploaded_by] || null : null,
        reviewer: tdata?.reviewed_by ? profMap[tdata.reviewed_by] || null : null,
        salesman: tdata?.salesman_id ? profMap[tdata.salesman_id] || null : null,
      };
      setTicket(enrichedTicket as BlendTicket);

      const fetchedImages = imagesResult.data || [];
      let unavailableImageCount = 0;
      const imagesWithSignedUrls = await Promise.all(
        fetchedImages.map(async (img: BlendTicketImage) => {
          if (img.storage_path) {
            const { data, error: signedUrlError } = await supabase.storage
              .from('blend-ticket-images')
              .createSignedUrl(img.storage_path, 3600);
            if (signedUrlError || !data?.signedUrl) {
              unavailableImageCount += 1;
              const signingFailure = signedUrlError
                || new Error(`Failed to sign blend ticket image ${img.id}`);
              Sentry.captureException(
                signingFailure,
                { level: 'warning', extra: { context: 'blend_ticket_image_sign', imageId: img.id } },
              );
              return { ...img, image_url: '' };
            }
            return { ...img, image_url: data.signedUrl };
          }
          return img;
        })
      );
      if (unavailableImageCount > 0) {
        toast(
          'warning',
          `${unavailableImageCount} ticket image${unavailableImageCount === 1 ? '' : 's'} could not be loaded. The rest of the ticket is still available.`,
        );
      }
      setImages(imagesWithSignedUrls);
      setProducts((productsResult.data || []) as BlendTicketProduct[]);
      if (allProductsResult.error) {
        Sentry.captureException(allProductsResult.error, {
          level: 'warning',
          extra: { context: 'blend_ticket_product_catalog' },
        });
        toast('warning', 'The Product catalog could not be loaded. Existing ticket details are still available.');
      }
      setAllProducts((allProductsResult.data || []) as unknown as PickerProduct[]);
      setCustomers((customersResult.data || []) as Customer[]);
      const allFields = (fieldsResult.data || []) as Field[];
      setAvailableFields(allFields);
      setLinkedOrders((linkedResult.data || []) as BlendTicketToOrderItem[]);
      setAvailableJobs((jobsResult.data || []) as Pick<Job, 'id' | 'job_number' | 'job_date' | 'status'>[]);
      setHasApplicationRecord((applicationRecordResult.data || []).length > 0);
      setHasActiveInvoice((activeInvoiceResult.data || []).length > 0);
      setSelectedJobId(ticketResult.data.job_id || '');
      // Fetch application services for dropdown
      const { data: svcData } = await supabase.from('application_services').select('id, name, vehicle_id').eq('is_active', true).order('sort_order');
      setAppServices(svcData || []);

      // Load existing blend_ticket_fields
      const { data: btfData, error: btfError } = await supabase
        .from('blend_ticket_fields')
        .select('field_id, customer_id, planned_acres, sort_order')
        .eq('blend_ticket_id', id!)
        .order('sort_order');
      if (btfError) throw btfError;
      setTicketFields((btfData || []).map((btf: { field_id: string; customer_id: string | null; planned_acres: number | null }) => {
          const f = allFields.find(af => af.id === btf.field_id);
          return { field_id: btf.field_id, customer_id: btf.customer_id, planned_acres: btf.planned_acres?.toString() || '', field_name: f?.field_name || '' };
        }));
      setFieldsDirty(false);

      setFormData({
        customer_id: ticketResult.data.customer_id || '',
        ticket_date: ticketResult.data.ticket_date || '',
        ticket_time: ticketResult.data.ticket_time || '',
        job_number: ticketResult.data.job_number || '',
        invoice_number: ticketResult.data.invoice_number || '',
        driver_name: ticketResult.data.driver_name || '',
        applicator_name: ticketResult.data.applicator_name || '',
        mixer_name: ticketResult.data.mixer_name || '',
        tank_number: ticketResult.data.tank_number || '',
        vehicle_info: ticketResult.data.vehicle_info || '',
        application_service_id: ticketResult.data.application_service_id || '',
        field_names: ticketResult.data.field_names || '',
        total_acres: ticketResult.data.total_acres?.toString() || '',
        application_rate: ticketResult.data.application_rate || '',
        total_volume: ticketResult.data.total_volume?.toString() || '',
        total_volume_unit: ticketResult.data.total_volume_unit || '',
        notes: ticketResult.data.notes || '',
      });
      setSaveHydrationRequired(false);
      // Mark initial load complete so future changes trigger isDirty
      requestAnimationFrame(() => { initialLoadDone.current = true; });
      // Duplicate detection (informational only)
      if (ticketResult.data.ticket_number && ticketResult.data.ticket_date) {
        const { data: dupeData, error: dupeError } = await supabase.rpc('check_duplicate_blend_ticket', {
          p_ticket_number: ticketResult.data.ticket_number,
          p_ticket_date: ticketResult.data.ticket_date,
        });
        if (dupeError) throw dupeError;
        assertRpcResult(dupeData, 'check_duplicate_blend_ticket');
        const otherDupes = (dupeData || []).filter((d: { id: string }) => d.id !== ticketResult.data.id);
        if (otherDupes.length > 0) {
          const dupe = otherDupes[0] as { id: string; ticket_number: string };
          setDuplicateWarning({
            message: `A ticket with this number and date already exists (${dupe.ticket_number}). This may be a duplicate.`,
            dupeId: dupe.id,
            dupeNumber: dupe.ticket_number,
          });
        }
      }

      // Suggest matching orders (read-only hint, no auto-link)
      // Wrapped in its own try/catch so suggestion failures don't block page load
      try {
        const custId = ticketResult.data.customer_id;
        const prods = (productsResult.data || []) as BlendTicketProduct[];
        const pids = prods
          .map((p: BlendTicketProduct) => p.product_id)
          .filter((pid): pid is string => Boolean(pid));
        if (ticketResult.data.order_link_status === 'unlinked' && custId && pids.length) {
          const { data: co } = await supabase.from('orders').select('id, order_number').eq('customer_id', custId).eq('status', 'confirmed');
          if (co?.length) {
            const { data: mi } = await supabase.from('order_items').select('order_id, product_id').in('order_id', co.map(o => o.id)).in('product_id', pids);
            if (mi?.length) {
              const ct: Record<string, number> = {};
              mi.forEach(m => { ct[m.order_id] = (ct[m.order_id] || 0) + 1; });
              const best = Object.entries(ct).sort((a, b) => b[1] - a[1])[0];
              const bo = co.find(o => o.id === best[0]);
              if (bo) setSuggestedOrder({ id: bo.id, order_number: bo.order_number, matchCount: best[1] });
            }
          }
        }
      } catch {
        // Non-critical: suggestion just won't appear
      }
    } catch (error) {
      // A failed refetch did not replace local state, so preserve the prior
      // tracking mode and keep subsequent user edits protected.
      initialLoadDone.current = wasTrackingDirty;
      Sentry.captureException(error, { tags: { source: 'fetch', page: 'blend_ticket_detail' } });
      toast('error', 'Failed to load blend ticket. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    if (id) {
      loadTicketData();
    }
  }, [id, loadTicketData]);

  useEffect(() => {
    supabase.from('unit_conversions').select('*').order('unit').then(({ data, error }) => {
      if (error) {
        // The unit fields are pickers, not free text, so an empty list leaves the
        // operator no way to enter a unit at all. Say so instead of failing quietly.
        Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_unit_conversions' } });
        setUnitLoad('failed');
        toast('error', 'The Unit list could not be loaded. Refresh before changing any unit on this ticket.');
        return;
      }
      setUnitConversions((data || []) as UnitConversion[]);
      setUnitLoad('loaded');
    });
  }, [toast]);

  useEffect(() => {
    const ticketData = {
      total_acres: formData.total_acres ? parseFloat(formData.total_acres) : null,
      total_volume: formData.total_volume ? parseFloat(formData.total_volume) : null,
      total_volume_unit: formData.total_volume_unit || null,
      application_rate: formData.application_rate || null,
    };
    // The rate check guards a billing path: create_invoice_from_blend_ticket prices
    // each line from rate_per_acre and its unit, falling back to the product's own
    // rate_unit when the line leaves it blank. Hand the catalog row's units over so
    // the warning and the invoice agree about the line.
    //
    // Resolve that row from `allProducts` by the line's CURRENT product_id, never from
    // the `p.product` joined at load time. The picker writes `product_id` and
    // `product_name` only (see the SearchableSelect below), so `p.product` still
    // describes the PREVIOUS product after a switch — and is `undefined` outright on a
    // newly added line, which silently disabled billing's own rate-unit fallback.
    // `ManualTicketCreate` already resolves it this way; this matches it.
    const productData = products.map(p => {
      // `allProducts` is filtered to is_active, so a line pointing at a retired
      // product keeps the row joined at load time rather than losing its units.
      const catalog = allProducts.find((candidate) => candidate.id === p.product_id);
      return {
        product_name: p.product_name,
        quantity: p.quantity,
        unit: p.unit,
        rate_per_acre: p.rate_per_acre,
        rate_per_acre_unit: p.rate_per_acre_unit,
        product_form: catalog ? (catalog.product_form ?? null) : (p.product?.product_form ?? null),
        product_rate_unit: catalog ? (catalog.rate_unit ?? null) : (p.product?.rate_unit ?? null),
        product_inventory_unit: catalog
          ? (catalog.inventory_unit || catalog.unit_size || null)
          : (p.product?.inventory_unit || p.product?.unit_size || null),
      };
    });
    setWarnings(validateBlendMath(ticketData, productData));
  }, [products, allProducts, formData.total_acres, formData.total_volume, formData.total_volume_unit, formData.application_rate]);

  // Track dirty state from form changes
  useEffect(() => {
    if (initialLoadDone.current) setIsDirty(true);
  }, [formData, products]);

  async function handleSave() {
    if (!ticket) return;
    // A successful save can be followed by a failed hydration request. In
    // that state the local ticket still carries the pre-save concurrency
    // token, so a no-change retry must be a no-op instead of submitting a
    // guaranteed stale snapshot.
    if (saveHydrationRequired) {
      toast('error', 'The changes were saved, but the refreshed ticket could not be loaded. Reopen this ticket before saving again.');
      return;
    }
    if (fieldsDirty) {
      toast('error', 'Save the Application Fields section before saving ticket details.');
      return;
    }
    if (reprocessing || ticket.status === 'processing') {
      toast('error', 'Wait for OCR processing to finish before saving ticket details.');
      return;
    }
    if (contentLocked) {
      toast('error', 'Ticket details are locked after billing or order linkage.');
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
      toast('error', unitBlock);
      return;
    }

    await runCriticalAction({
      action: async () => {
        const ticketPayload = {
          _expected_updated_at: ticket.updated_at,
          customer_id: formData.customer_id || null,
          ticket_date: formData.ticket_date || null,
          ticket_time: formData.ticket_time || null,
          job_number: formData.job_number || null,
          job_id: selectedJobId || null,
          invoice_number: formData.invoice_number || null,
          driver_name: formData.driver_name || null,
          applicator_name: formData.applicator_name || null,
          mixer_name: formData.mixer_name || null,
          tank_number: formData.tank_number || null,
          vehicle_info: formData.vehicle_info || null,
          application_service_id: formData.application_service_id || null,
          field_names: formData.field_names || null,
          total_acres: formData.total_acres ? parseFloat(formData.total_acres) : null,
          application_rate: formData.application_rate || null,
          total_volume: formData.total_volume ? parseFloat(formData.total_volume) : null,
          total_volume_unit: formData.total_volume_unit || null,
          notes: formData.notes || null,
        };

        const productsPayload = products.map(p => ({
          id: p.id,
          product_id: p.product_id,
          product_name: p.product_name,
          quantity: p.quantity,
          unit: p.unit,
          lot_number: p.lot_number,
          rate_per_acre: p.rate_per_acre,
          rate_per_acre_unit: p.rate_per_acre_unit,
          sequence_order: p.sequence_order,
        }));

        const saveKey = saveIdem.getKey();
        const { data: saveData, error } = await supabase.rpc('save_blend_ticket', {
          p_ticket_id: ticket.id,
          p_ticket_payload: ticketPayload,
          p_products: productsPayload,
          p_performed_by: profile!.id,
          p_idempotency_key: saveKey,
        });
        if (error) throw error;
        assertRpcResult(saveData, 'save_blend_ticket');
        saveIdem.resetKey();

        // Remain fail-closed until loadTicketData replaces the pre-save
        // updated_at token. A failed hydration leaves this guard armed.
        setSaveHydrationRequired(true);
        setIsDirty(false);
        await loadTicketData();
      },
      toast,
      setLoading: setSaving,
      sentryTag: 'save_blend_ticket',
    });
  }

  async function handleApprove() {
    if (!ticket || !profile) return;
    setApproveConfirmOpen(false);
    if (hasUnsavedChanges) {
      toast('error', 'Save your ticket changes before approving it.');
      return;
    }

    await runCriticalAction({
      action: async () => {
        // Route through the RPC (not a raw .update) for DB-level role/actor
        // enforcement, the status='completed' & review_status='unreviewed' guard,
        // and idempotency. A single ticket is a one-element batch.
        const approveKey = approveIdem.getKey();
        const { data, error } = await supabase.rpc('batch_approve_blend_tickets', {
          p_ticket_ids: [ticket.id],
          p_approved_by: profile.id,
          p_idempotency_key: approveKey,
        });
        if (error) throw error;
        approveIdem.resetKey();
        const result = assertRpcResult<{ approved_count: number }>(data, 'batch_approve_blend_tickets');
        if (result.approved_count < 1) {
          throw new Error('Blend ticket could not be approved — it may already be reviewed or not yet completed.');
        }
        logActivity({ event: 'blend_ticket_approved', description: `Blend ticket ${ticket.ticket_number} approved`, performedBy: profile.id, entityType: 'blend_ticket', entityId: ticket.id, customerId: ticket.customer_id || undefined });
      },
      toast,
      sentryTag: 'approve_blend_ticket',
      onSuccess: () => navigate('/blend-tickets'),
    });
  }

  async function handleReject() {
    if (!ticket || !profile) return;
    setRejectConfirmOpen(false);
    if (hasUnsavedChanges) {
      toast('error', 'Save or discard your ticket changes before rejecting it.');
      return;
    }

    await runCriticalAction({
      action: async () => {
        // Route through the RPC (not a raw .update) for DB-level role/actor
        // enforcement, the status='completed' & review_status='unreviewed' guard,
        // and idempotency. A single ticket is a one-element batch.
        const rejectKey = rejectIdem.getKey();
        const { data, error } = await supabase.rpc('batch_reject_blend_tickets', {
          p_ticket_ids: [ticket.id],
          p_rejected_by: profile.id,
          p_idempotency_key: rejectKey,
        });
        if (error) throw error;
        rejectIdem.resetKey();
        const result = assertRpcResult<{ rejected_count: number }>(data, 'batch_reject_blend_tickets');
        if (result.rejected_count < 1) {
          throw new Error('Blend ticket could not be rejected — it may already be reviewed or not yet completed.');
        }
        logActivity({ event: 'blend_ticket_rejected', description: `Blend ticket ${ticket.ticket_number} rejected`, performedBy: profile.id, entityType: 'blend_ticket', entityId: ticket.id, customerId: ticket.customer_id || undefined });
      },
      toast,
      sentryTag: 'reject_blend_ticket',
      onSuccess: () => navigate('/blend-tickets'),
    });
  }

  async function handleSaveFields() {
    if (!ticket || !profile || !fieldsDirty) return;
    if (fieldsLocked) {
      toast('error', 'Application fields are locked after invoicing or application record creation.');
      return;
    }
    if (saveHydrationRequired) {
      toast('error', 'The refreshed ticket could not be loaded. Reopen this ticket before changing its lifecycle state.');
      return;
    }
    setSavingFields(true);
    try {
      const payload = ticketFields.map(tf => ({
        field_id: tf.field_id,
        customer_id: tf.customer_id,
        planned_acres: tf.planned_acres ? Number(tf.planned_acres) : null,
      }));
      const { data, error } = await supabase.rpc('save_blend_ticket_fields', {
        p_blend_ticket_id: ticket.id,
        p_fields: payload,
        p_performed_by: profile.id,
        p_idempotency_key: fieldsIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'save_blend_ticket_fields');
      fieldsIdem.resetKey();
      setFieldsDirty(false);
      await logActivity({ event: 'blend_ticket_fields_saved', description: `Saved ${payload.length} field assignments for ${ticket.ticket_number}`, performedBy: profile.id, entityType: 'blend_ticket', entityId: ticket.id });
      toast('success', `Saved ${payload.length} field assignment${payload.length !== 1 ? 's' : ''}`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_fields' } });
      toast('error', err instanceof Error ? err.message : 'Failed to save fields');
    }
    setSavingFields(false);
  }

  function addTicketField() {
    if (!ticket) return;
    if (fieldsLocked) {
      toast('error', 'Application fields are locked after invoicing or application record creation.');
      return;
    }
    if (saveHydrationRequired) {
      toast('error', 'The refreshed ticket could not be loaded. Reopen this ticket before editing application fields.');
      return;
    }
    setTicketFields(previous => [
      ...previous,
      { field_id: '', customer_id: ticket.customer_id, planned_acres: '', field_name: '' },
    ]);
    setFieldsDirty(true);
  }

  function updateTicketField(index: number, updates: Partial<(typeof ticketFields)[number]>) {
    if (fieldsLocked) {
      toast('error', 'Application fields are locked after invoicing or application record creation.');
      return;
    }
    if (saveHydrationRequired) {
      toast('error', 'The refreshed ticket could not be loaded. Reopen this ticket before editing application fields.');
      return;
    }
    setTicketFields(previous => previous.map((field, fieldIndex) => (
      fieldIndex === index ? { ...field, ...updates } : field
    )));
    setFieldsDirty(true);
  }

  function removeTicketField(index: number) {
    if (fieldsLocked) {
      toast('error', 'Application fields are locked after invoicing or application record creation.');
      return;
    }
    if (saveHydrationRequired) {
      toast('error', 'The refreshed ticket could not be loaded. Reopen this ticket before editing application fields.');
      return;
    }
    setTicketFields(previous => previous.filter((_, fieldIndex) => fieldIndex !== index));
    setFieldsDirty(true);
  }

  async function handleReprocessOCR() {
    if (!ticket || !profile) return;
    setReprocessConfirmOpen(false);
    if (!canReprocessOcr) {
      toast('error', 'OCR can only be reprocessed while the ticket is unreviewed, unlinked, and unbilled.');
      return;
    }
    setReprocessing(true);
    try {
      const { data: imgs, error: imageLookupError } = await supabase.from('blend_ticket_images').select('id').eq('blend_ticket_id', ticket.id).order('upload_order').limit(1);
      if (imageLookupError) throw imageLookupError;
      if (!imgs?.length) { toast('error', 'No image found'); setReprocessing(false); return; }
      const resp = await supabase.functions.invoke('process-blend-ticket', { body: { blend_ticket_id: ticket.id, reprocess: true } });
      if (resp.error) throw resp.error;
      const edgeResult = resp.data as { success?: boolean; status?: string; error?: string } | null;
      if (edgeResult?.status === 'already_processing') {
        toast('info', 'OCR is already processing this ticket.');
        await loadTicketData();
        setReprocessing(false);
        return;
      }
      if (!edgeResult?.success) {
        throw new Error(edgeResult?.error || 'OCR re-processing did not complete');
      }
      toast('success', 'OCR re-processing complete');
      await logActivity({ event: 'blend_ticket_reprocessed', description: `Re-processed OCR for ${ticket.ticket_number}`, performedBy: profile.id, entityType: 'blend_ticket', entityId: ticket.id });
      initialLoadDone.current = false;
      await loadTicketData();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'reprocess_ocr' } });
      toast('error', err instanceof Error ? err.message : 'Re-process failed');
    }
    setReprocessing(false);
  }

  function updateProduct(index: number, field: keyof BlendTicketProduct, value: BlendTicketProduct[keyof BlendTicketProduct]) {
    if (contentLocked) {
      toast('error', 'Ticket details are locked after billing, order linkage, or application record creation.');
      return;
    }
    // Functional updater: the product-select onChange fires updateProduct twice back-to-back
    // (product_id then product_name). Reading `products` from the closure made the second call
    // overwrite the first (product_id was lost -> $0 pricing / FK crash on create-order). Using
    // the previous-state form composes both updates correctly.
    setProducts(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }

  function addProduct() {
    if (!ticket) return;
    if (contentLocked) {
      toast('error', 'Ticket details are locked after billing, order linkage, or application record creation.');
      return;
    }

    const newProduct: BlendTicketProduct = {
      id: crypto.randomUUID(),
      blend_ticket_id: ticket.id,
      product_id: null,
      product_name: '',
      quantity: 0,
      unit: null,
      lot_number: null,
      rate_per_acre: null,
      rate_per_acre_unit: null,
      sequence_order: products.length + 1,
      confidence_score: 0,
      manually_corrected: true,
      unit_cost_cents: null,
      unit_price_cents: null,
      created_at: new Date().toISOString(),
    };
    // Add/remove are part of the version-checked save snapshot. Persisting a
    // blank row here would advance the parent version and make this page's own
    // next Save stale; keeping it local also avoids abandoned blank DB rows.
    setProducts(previous => [...previous, newProduct]);
  }

  function removeProduct(index: number) {
    if (contentLocked) {
      toast('error', 'Ticket details are locked after billing, order linkage, or application record creation.');
      return;
    }
    setRemoveProductConfirmOpen(false);
    setRemoveProductIndex(null);
    setProducts(previous => previous
      .filter((_, productIndex) => productIndex !== index)
      .map((product, productIndex) => ({ ...product, sequence_order: productIndex + 1 })));
  }

  // Phase 3: Order linkage handlers
  async function openLinkModal() {
    if (orderActionBlockReason) {
      toast('error', orderActionBlockReason);
      return;
    }
    if (!ticket?.customer_id) {
      toast('error', 'Please assign a customer before linking to an order');
      return;
    }
    // Load orders for the same customer
    const { data, error } = await supabase
      .from('orders')
      .select('*, items:order_items(*)')
      .eq('customer_id', ticket.customer_id)
      .is('deleted_at', null)
      .in('status', ['confirmed', 'partially_fulfilled'])
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      toast('error', 'Failed to load orders');
      return;
    }
    setAvailableOrders((data || []) as (Order & { items?: OrderItem[] })[]);
    setSelectedOrderId('');
    setShowLinkModal(true);
  }

  async function handleLinkToOrder() {
    if (!ticket || !selectedOrderId || !profile) return;
    if (orderActionBlockReason) {
      toast('error', orderActionBlockReason);
      return;
    }
    setLinking(true);
    try {
      const linkKey = linkIdem.getKey();
      const { data, error } = await supabase.rpc('link_blend_ticket_to_order', {
        p_blend_ticket_id: ticket.id,
        p_order_id: selectedOrderId,
        p_performed_by: profile.id,
        p_idempotency_key: linkKey,
      });
      if (error) throw error;
      linkIdem.resetKey();
      const result = assertRpcResult<{ success: boolean; error?: string; order_number?: string; items_linked?: number }>(data, 'link_blend_ticket_to_order');
      if (!result.success) throw new Error(result.error);
      toast('success', `Linked to order ${result.order_number} (${result.items_linked} items matched)`);
      setShowLinkModal(false);
      await loadTicketData();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'link_blend_ticket_to_order' } });
      toast('error', err instanceof Error ? err.message : 'Failed to link');
    } finally {
      setLinking(false);
    }
  }

  async function handleUnlink() {
    if (!ticket || !profile) return;
    setUnlinkConfirmOpen(false);
    if (saveHydrationRequired) {
      toast('error', 'The refreshed ticket could not be loaded. Reopen this ticket before changing its lifecycle state.');
      return;
    }
    if (hasActiveInvoice) {
      toast('error', 'This blend ticket has an active invoice and cannot be unlinked. Void or cancel the invoice first.');
      return;
    }
    if (hasApplicationRecord) {
      toast('error', 'This blend ticket has an application record and cannot be unlinked. Reverse or remove that application record first.');
      return;
    }
    if (ticket.payment_status !== 'unbilled') {
      toast('error', 'A billed blend ticket cannot be unlinked from its order.');
      return;
    }
    try {
      const unlinkKey = unlinkIdem.getKey();
      const { data, error } = await supabase.rpc('unlink_blend_ticket_from_order', {
        p_blend_ticket_id: ticket.id,
        p_performed_by: profile.id,
        p_idempotency_key: unlinkKey,
      });
      if (error) throw error;
      unlinkIdem.resetKey();
      const result = assertRpcResult<{ success: boolean; error?: string }>(data, 'unlink_blend_ticket_from_order');
      if (!result.success) throw new Error(result.error);
      toast('success', 'Blend ticket unlinked from order');
      await loadTicketData();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'unlink_blend_ticket_from_order' } });
      toast('error', err instanceof Error ? err.message : 'Failed to unlink');
    }
  }

  async function handleCreateInvoice() {
    if (!ticket || !profile) return;
    setCreateInvoiceConfirmOpen(false);
    if (invoiceActionBlockReason) {
      toast('error', invoiceActionBlockReason);
      return;
    }

    await runCriticalAction({
      action: async () => {
        const key = invoiceIdem.getKey();
        const { data, error } = await supabase.rpc('create_invoice_from_blend_ticket', {
          p_blend_ticket_id: ticket.id,
          p_created_by: profile.id,
          p_idempotency_key: key,
        });
        if (error) {
          // U6 #91a: the ticket's job already has a live invoice — billing the ticket
          // too would double-charge. Give a plain-English reason instead of the raw token.
          if (hasRpcCode(error, RpcErrorCodes.JOB_ALREADY_INVOICED)) {
            throw new Error('This blend ticket is tied to a job that has already been invoiced. Billing the ticket too would double-charge the customer — void that job invoice first if you meant to re-bill here.');
          }
          throw error;
        }
        // Phase 1 (2026-04-29): RPC return shape changed from uuid to
        // { invoice_ids: string[], invoice_group_id: string | null }.
        // Multi-customer fields produce grouped split invoices; single-customer
        // fields produce a single invoice (array length 1).
        const result = assertRpcResult<{ invoice_ids: string[]; invoice_group_id: string | null }>(
          data, 'create_invoice_from_blend_ticket'
        );
        const firstInvoiceId = result.invoice_ids?.[0];
        if (!firstInvoiceId) throw new Error('No invoice id returned from RPC');
        if (profile) logActivity({
          event: 'invoice_created_from_blend_ticket',
          description: `Invoice${result.invoice_ids.length > 1 ? `s (${result.invoice_ids.length})` : ''} created from blend ticket ${ticket.ticket_number}${result.invoice_group_id ? ` (group)` : ''}`,
          performedBy: profile.id,
          entityType: 'invoice',
          entityId: firstInvoiceId,
        });
        navigate(`/invoices/${firstInvoiceId}`);
      },
      toast,
      setLoading: setCreatingInvoice,
      successMessage: 'Invoice created from blend ticket',
      sentryTag: 'create_invoice_from_blend_ticket',
    });
  }

  async function openCreateOrderModal() {
    if (orderActionBlockReason) {
      toast('error', orderActionBlockReason);
      return;
    }
    if (!ticket?.customer_id) {
      toast('error', 'Please assign a customer first');
      return;
    }

    setNewOrderNumber('');
    setNewOrderDate(localToday());
    setNewOrderNotes('');
    setShowCreateOrderModal(true);

    try {
      const { data, error } = await supabase.rpc('generate_order_number');
      if (error) throw error;
      const generatedOrderNumber = assertRpcResult<string>(data, 'generate_order_number');
      // Preserve anything the user typed while the asynchronous prefill was loading.
      setNewOrderNumber((current) => current.trim() ? current : generatedOrderNumber);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'generate_order_number' } });
      toast('warning', 'Could not prefill an order number. Enter one to continue.');
    }
  }

  async function handleCreateOrder() {
    if (!ticket || !profile || !newOrderNumber.trim()) return;
    if (orderActionBlockReason) {
      toast('error', orderActionBlockReason);
      return;
    }
    setLinking(true);
    try {
      const createOrderKey = createOrderIdem.getKey();
      const { data, error } = await supabase.rpc('create_order_from_blend_ticket', {
        p_blend_ticket_id: ticket.id,
        p_order_number: newOrderNumber.trim(),
        p_order_date: newOrderDate,
        p_notes: newOrderNotes || undefined,
        p_performed_by: profile.id,
        p_idempotency_key: createOrderKey,
      });
      if (error) throw error;
      createOrderIdem.resetKey();
      const result = assertRpcResult<{ success: boolean; error?: string; order_number?: string; order_id?: string; items_created?: number }>(data, 'create_order_from_blend_ticket');
      if (!result.success) throw new Error(result.error);
      toast('success', `Order ${result.order_number} created with ${result.items_created} items`);
      setShowCreateOrderModal(false);
      navigate(`/orders/${result.order_id}`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'create_order_from_blend_ticket' } });
      toast('error', err instanceof Error ? err.message : 'Failed to create order');
    } finally {
      setLinking(false);
    }
  }

  const [creatingAppRecord, setCreatingAppRecord] = useState(false);
  const [appRecordConfirmOpen, setAppRecordConfirmOpen] = useState(false);

  function handleCreateApplicationRecord() {
    if (!ticket || !profile) return;
    if (hasUnsavedChanges) {
      toast('error', 'Save your ticket changes before creating an application record.');
      return;
    }
    setAppRecordConfirmOpen(true);
  }

  async function executeCreateApplicationRecord() {
    if (!ticket || !profile) return;
    setAppRecordConfirmOpen(false);
    if (hasUnsavedChanges) {
      toast('error', 'Save your ticket changes before creating an application record.');
      return;
    }
    setCreatingAppRecord(true);
    try {
      const appRecKey = appRecordIdem.getKey();
      const { data: appRecData, error } = await supabase.rpc('create_application_record_from_blend_ticket', {
        p_blend_ticket_id: ticket.id,
        p_performed_by: profile.id,
        p_idempotency_key: appRecKey,
      });
      if (error) throw error;
      assertRpcResult(appRecData, 'create_application_record_from_blend_ticket');
      appRecordIdem.resetKey();
      // The record exists before this page is refreshed, so arm the same
      // downstream lock immediately and do not allow a newly dirty field draft
      // that the database trigger would reject.
      setHasApplicationRecord(true);
      logActivity({ event: 'application_record_created', description: `Application record created from blend ticket ${ticket.ticket_number}`, performedBy: profile.id, entityType: 'blend_ticket', entityId: ticket.id, customerId: ticket.customer_id || undefined });
      toast('success', 'Application record created successfully');
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'create_application_record_from_blend_ticket' } });
      toast('error', err instanceof Error ? err.message : 'Failed to create application record');
    } finally {
      setCreatingAppRecord(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Ticket not found</p>
        <Button className="mt-4" onClick={() => navigate('/blend-tickets')}>
          Back to Tickets
        </Button>
      </div>
    );
  }

  return (
    <fieldset
      disabled={saving || savingFields}
      className="m-0 min-w-0 space-y-6 border-0 p-0"
      aria-busy={saving || savingFields}
    >
      <Breadcrumbs items={[
        { label: 'Blend Tickets', href: '/blend-tickets' },
        { label: ticket.ticket_number },
      ]} />

      {duplicateWarning && (
        <div className="flex items-center justify-between gap-2 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {duplicateWarning.message}
          </div>
          <button
            onClick={() => navigate(`/blend-tickets/${duplicateWarning.dupeId}`)}
            className="text-yellow-700 hover:text-yellow-900 underline font-medium flex-shrink-0 text-xs"
          >
            View {duplicateWarning.dupeNumber}
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{ticket.ticket_number}</h1>
            <p className="text-gray-600 mt-1">
              Uploaded {new Date(ticket.created_at).toLocaleString()}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Badge variant={ticket.status === 'completed' ? 'success' : 'warning'}>
            {ticket.status}
          </Badge>
          <Badge variant={ticket.review_status === 'approved' ? 'success' : 'default'}>
            {ticket.review_status}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <ImageIcon className="h-5 w-5" />
            Ticket Images
          </h2>

          {images.length > 0 ? (
            <div className="space-y-4">
              <div className="aspect-[4/3] bg-gray-100 rounded-lg overflow-hidden border border-gray-200">
                {images[selectedImageIndex]?.image_url ? (
                  <img
                    src={images[selectedImageIndex].image_url}
                    alt="Ticket"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500">
                    Image temporarily unavailable. Reload to try again.
                  </div>
                )}
              </div>

              {images.length > 1 && (
                <div className="grid grid-cols-4 gap-2">
                  {images.map((image, index) => (
                    <button
                      key={image.id}
                      onClick={() => setSelectedImageIndex(index)}
                      className={`aspect-square rounded-lg overflow-hidden border-2 transition-colors ${
                        selectedImageIndex === index
                          ? 'border-blue-500'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {image.image_url ? (
                        <img
                          src={image.image_url}
                          alt={`Ticket ${index + 1}`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full items-center justify-center px-1 text-center text-xs text-gray-500">
                          Unavailable
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              <div className="bg-gray-50 p-3 rounded-lg">
                <div className="text-sm text-gray-600">
                  <p>
                    <span className="font-medium">OCR Confidence:</span>{' '}
                    <span
                      className={`font-semibold ${
                        ticket.ocr_confidence_score >= ocrThresholds.auto_approve
                          ? 'text-green-600'
                          : ticket.ocr_confidence_score >= ocrThresholds.needs_review
                          ? 'text-yellow-600'
                          : 'text-red-600'
                      }`}
                    >
                      {ticket.ocr_confidence_score}%
                    </span>
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 text-center py-8">No images available</p>
          )}
        </Card>

        <fieldset
          disabled={contentLocked}
          className="m-0 min-w-0 border-0 p-0"
          aria-label="Ticket details editor"
        >
        <Card className="p-6">
          <h2 className="text-lg font-semibold mb-4">Ticket Information</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Customer
              </label>
              <SearchableSelect
                options={customers.map((customer) => ({ value: customer.id, label: customer.farm_name }))}
                value={formData.customer_id}
                onChange={(value) => setFormData({ ...formData, customer_id: value })}
                placeholder="Select Customer"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Ticket Date
              </label>
              <Input
                type="date"
                value={formData.ticket_date}
                onChange={(e) => setFormData({ ...formData, ticket_date: e.target.value })}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Ticket Time
              </label>
              <Input
                type="text"
                value={formData.ticket_time}
                onChange={(e) => setFormData({ ...formData, ticket_time: e.target.value })}
                placeholder="e.g. 2:30 PM"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Job # <span className="text-xs text-secondary font-normal">(OCR text)</span>
              </label>
              <Input
                type="text"
                value={formData.job_number}
                onChange={(e) => setFormData({ ...formData, job_number: e.target.value })}
                placeholder="Job / work order number"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700 mb-1 flex items-center">
                Link to Job
                <HelpTip className="ml-1" text="Linking connects this ticket to a scheduled application job — the 'we apply it' path. It does not bill anything on its own: the customer is billed later, either from the job (Transfer to Invoice) or directly here with Create Invoice. Do one or the other for a given application, never both, or you double-charge." />
              </label>
              <select
                value={selectedJobId}
                onChange={(e) => { setSelectedJobId(e.target.value); setIsDirty(true); }}
                className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">— No linked job —</option>
                {availableJobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.job_number} ({j.job_date}) — {j.status}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Invoice #
              </label>
              <Input
                type="text"
                value={formData.invoice_number}
                onChange={(e) => setFormData({ ...formData, invoice_number: e.target.value })}
                placeholder="Invoice reference"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Driver Name
              </label>
              <Input
                type="text"
                value={formData.driver_name}
                onChange={(e) => setFormData({ ...formData, driver_name: e.target.value })}
                placeholder="Enter driver name"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Applicator Name
              </label>
              <Input
                type="text"
                value={formData.applicator_name}
                onChange={(e) => setFormData({ ...formData, applicator_name: e.target.value })}
                placeholder="Enter applicator name"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Mixer Name
              </label>
              <Input
                type="text"
                value={formData.mixer_name}
                onChange={(e) => setFormData({ ...formData, mixer_name: e.target.value })}
                placeholder="Person who mixed the blend"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tank #
              </label>
              <Input
                type="text"
                value={formData.tank_number}
                onChange={(e) => setFormData({ ...formData, tank_number: e.target.value })}
                placeholder="Enter tank number"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Vehicle
              </label>
              <Input
                type="text"
                value={formData.vehicle_info}
                onChange={(e) => setFormData({ ...formData, vehicle_info: e.target.value })}
                placeholder="Vehicle / rig description"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Application Service</label>
              <select value={formData.application_service_id} onChange={(e) => setFormData({ ...formData, application_service_id: e.target.value })} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green">
                <option value="">None (no application fee)</option>
                {appServices.map((svc) => (<option key={svc.id} value={svc.id}>{svc.name}</option>))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Field Names / Locations
              </label>
              <Input
                type="text"
                value={formData.field_names}
                onChange={(e) => setFormData({ ...formData, field_names: e.target.value })}
                placeholder="Comma-separated field names"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Total Acres
              </label>
              <Input
                type="number"
                step="0.01"
                value={formData.total_acres}
                onChange={(e) => setFormData({ ...formData, total_acres: e.target.value })}
                placeholder="0"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Application Rate
              </label>
              <Input
                type="text"
                value={formData.application_rate}
                onChange={(e) => setFormData({ ...formData, application_rate: e.target.value })}
                placeholder="e.g. 10 gal/acre"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Total Volume
              </label>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes
              </label>
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
        </fieldset>
      </div>

      <fieldset
        disabled={contentLocked}
        className="m-0 min-w-0 border-0 p-0"
        aria-label="Ticket products editor"
      >
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Products</h2>
          <Button size="sm" onClick={addProduct}>
            <Plus className="h-4 w-4" />
            Add Product
          </Button>
        </div>

        <div className="space-y-4">
          {products.map((product, index) => {
            const catalog = allProducts.find((candidate) => candidate.id === product.product_id);
            const productForm = catalog
              ? (catalog.product_form ?? null)
              : (product.product?.product_form ?? null);
            return (
            <div key={product.id} className={`grid grid-cols-12 gap-3 items-start p-4 rounded-lg ${
              !product.manually_corrected && product.confidence_score > 0 && product.confidence_score < 70
                ? 'bg-yellow-50 border border-yellow-200'
                : 'bg-gray-50'
            }`}>
              <div className="col-span-12 md:col-span-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Product
                </label>
                <SearchableSelect
                  options={allProducts.map((p) => ({ value: p.id, label: productOptionLabel(p) }))}
                  value={product.product_id || ''}
                  onChange={(value) => {
                    updateProduct(index, 'product_id', value || null);
                    const selectedProduct = allProducts.find(p => p.id === value);
                    if (selectedProduct) {
                      updateProduct(index, 'product_name', selectedProduct.product_name);
                    }
                  }}
                  placeholder="Select Product"
                />
                {allProducts.find((candidate) => candidate.id === product.product_id) && (
                  <ProductOptionDetails product={allProducts.find((candidate) => candidate.id === product.product_id)!} />
                )}
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Qty
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={product.quantity}
                  onChange={(e) => updateProduct(index, 'quantity', parseFloat(e.target.value) || 0)}
                />
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Unit
                </label>
                <UnitSelect
                  unitConversions={unitConversions}
                  form={productForm}
                  value={product.unit || ''}
                  onChange={(value) => updateProduct(index, 'unit', value)}
                  disabled={contentLocked}
                  ariaLabel={`Quantity unit for ${product.product_name || 'product'}`}
                />
              </div>

              <div className="col-span-4 md:col-span-2">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Rate/Acre
                </label>
                <Input
                  type="number"
                  step="0.01"
                  value={product.rate_per_acre ?? ''}
                  onChange={(e) => updateProduct(index, 'rate_per_acre', e.target.value ? parseFloat(e.target.value) : null)}
                />
              </div>

              <div className="col-span-4 md:col-span-1">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Rate unit (per acre)
                </label>
                <UnitSelect
                  unitConversions={unitConversions}
                  form={productForm}
                  value={product.rate_per_acre_unit || ''}
                  onChange={(value) => updateProduct(index, 'rate_per_acre_unit', value)}
                  disabled={contentLocked}
                  ariaLabel={`Rate unit per acre for ${product.product_name || 'product'}`}
                />
              </div>

              <div className="col-span-6 md:col-span-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Lot Number
                </label>
                <Input
                  type="text"
                  value={product.lot_number || ''}
                  onChange={(e) => updateProduct(index, 'lot_number', e.target.value)}
                  placeholder="Lot #"
                />
              </div>

              <div className="col-span-2 md:col-span-1 flex items-end">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Remove product"
                  onClick={() => { setRemoveProductIndex(index); setRemoveProductConfirmOpen(true); }}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              {(product.confidence_score > 0 || product.manually_corrected) && (
                <div className="col-span-12 flex items-center gap-2 text-xs">
                  {product.manually_corrected ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                      <Check className="w-3 h-3" /> Verified
                    </span>
                  ) : product.confidence_score < 70 ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                      <AlertCircle className="w-3 h-3" /> Low confidence — verify
                    </span>
                  ) : product.confidence_score < ocrThresholds.auto_approve ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-medium">
                      <AlertCircle className="w-3 h-3" /> {product.confidence_score}% — review
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-600">
                      {product.confidence_score}%
                    </span>
                  )}
                  {!product.manually_corrected && product.confidence_score > 0 && (
                    <div className="flex-1 max-w-[120px] h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          product.confidence_score >= ocrThresholds.auto_approve ? 'bg-green-500'
                          : product.confidence_score >= 70 ? 'bg-yellow-500'
                          : 'bg-red-500'
                        }`}
                        style={{ width: `${product.confidence_score}%` }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
            );
          })}

          {products.length === 0 && (
            <p className="text-center text-gray-500 py-8">
              No products found. Add products manually or wait for OCR processing.
            </p>
          )}
        </div>
      </Card>
      </fieldset>

      {/* Application Fields Section */}
      <fieldset disabled={fieldControlsDisabled} aria-disabled={fieldControlsDisabled} className="contents">
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Application Fields
          </h2>
          {ticket.review_status === 'unreviewed' && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={addTicketField}
                disabled={fieldControlsDisabled}
              >
                <Plus className="h-4 w-4" /> Add Field
              </Button>
              {fieldsDirty && (
                <Button size="sm" onClick={handleSaveFields} loading={savingFields} disabled={fieldControlsDisabled}>
                  <Save className="h-4 w-4" /> Save Fields
                </Button>
              )}
            </div>
          )}
        </div>

        {ticketFields.length > 0 ? (
          <div className="space-y-3">
            {ticketFields.map((tf, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-3 items-end">
                <div className="col-span-5">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Field</label>
                  <SearchableSelect
                    options={availableFields
                      .filter(f => !ticket.customer_id || f.customer_id === ticket.customer_id || f.customer_id === tf.customer_id)
                      .map((f) => ({ value: f.id, label: f.field_name }))}
                    value={tf.field_id}
                    onChange={(value) => {
                      const selectedField = availableFields.find(f => f.id === value);
                      updateTicketField(idx, {
                        field_id: value,
                        field_name: selectedField?.field_name || '',
                        customer_id: selectedField?.customer_id || tf.customer_id,
                      });
                    }}
                    placeholder="Select field..."
                    disabled={fieldControlsDisabled}
                  />
                </div>
                <div className="col-span-4">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Planned Acres</label>
                  <input
                    type="number"
                    value={tf.planned_acres}
                    onChange={(e) => updateTicketField(idx, { planned_acres: e.target.value })}
                    placeholder="0"
                    disabled={fieldControlsDisabled}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                </div>
                <div className="col-span-3 flex justify-end">
                  {ticket.review_status === 'unreviewed' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label="Remove application field"
                      onClick={() => removeTicketField(idx)}
                      disabled={fieldControlsDisabled}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {(() => {
              const totalPlanned = ticketFields.reduce((sum, tf) => sum + (Number(tf.planned_acres) || 0), 0);
              const ticketAcres = ticket.total_acres || 0;
              const diff = ticketAcres > 0 ? Math.abs(totalPlanned - ticketAcres) / ticketAcres * 100 : 0;
              return (
                <div className={`text-sm mt-2 ${diff > 5 ? 'text-yellow-600' : 'text-gray-500'}`}>
                  Total planned: {totalPlanned} acres
                  {ticketAcres > 0 && <> | Ticket total: {ticketAcres} acres</>}
                  {diff > 5 && <span className="ml-2 font-medium">({diff.toFixed(0)}% difference)</span>}
                </div>
              );
            })()}
          </div>
        ) : (
          <p className="text-gray-500 text-center py-4 text-sm">
            No fields assigned. {ticket.review_status === 'unreviewed' ? 'Click "Add Field" to assign application fields.' : ''}
          </p>
        )}
      </Card>
      </fieldset>

      {/* Phase 3: Order Linkage Section */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Order Linkage
          </h2>
          <div className="flex items-center gap-2">
            <Badge variant={ticket.order_link_status === 'linked' ? 'success' : 'default'}>
              {ticket.order_link_status === 'linked' ? 'Linked' : 'Unlinked'}
            </Badge>
            <Badge variant={
              ticket.payment_status === 'billed' ? 'success' :
              ticket.payment_status === 'prepaid' ? 'info' :
              ticket.payment_status === 'no_charge' ? 'warning' : 'default'
            }>
              {ticket.payment_status.replace('_', ' ')}
            </Badge>
          </div>
        </div>

        {suggestedOrder && !orderActionBlockReason && (
          <div className="flex items-center justify-between gap-3 bg-blue-50 border border-blue-200 text-blue-800 rounded-lg px-4 py-3 text-sm mb-4">
            <div className="flex items-center gap-2">
              <ShoppingCart className="h-4 w-4 flex-shrink-0" />
              <span>May match <strong>Order {suggestedOrder.order_number}</strong> ({suggestedOrder.matchCount} matching product{suggestedOrder.matchCount !== 1 ? 's' : ''})</span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  if (!ticket || !profile || linking) return;
                  setLinking(true);
                  try {
                    const linkKey = linkIdem.getKey();
                    const { data, error } = await supabase.rpc('link_blend_ticket_to_order', {
                      p_blend_ticket_id: ticket.id,
                      p_order_id: suggestedOrder.id,
                      p_performed_by: profile.id,
                      p_idempotency_key: linkKey,
                    });
                    if (error) throw error;
                    linkIdem.resetKey();
                    const result = assertRpcResult<{ success: boolean; error?: string; order_number?: string; items_linked?: number }>(data, 'link_blend_ticket_to_order');
                    if (!result.success) throw new Error(result.error);
                    toast('success', `Linked to order ${result.order_number} (${result.items_linked} items matched)`);
                    await loadTicketData();
                  } catch (err: unknown) {
                    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'quick_link_blend_ticket' } });
                    toast('error', err instanceof Error ? err.message : 'Failed to link');
                  } finally {
                    setLinking(false);
                  }
                }}
                loading={linking}
              >
                <Link2 className="h-3.5 w-3.5" />
                Link
              </Button>
              <button onClick={() => setSuggestedOrder(null)} className="text-blue-400 hover:text-blue-600 text-xs">
                Dismiss
              </button>
            </div>
          </div>
        )}

        {ticket.order_link_status === 'linked' && linkedOrders.length > 0 ? (
          <div className="space-y-3">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-sm text-green-800 font-medium mb-2">Linked Order</p>
              {(() => {
                const order = linkedOrders[0]?.order;
                return order ? (
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => navigate(`/orders/${order.id}`)}
                      className="text-crx-green hover:underline font-medium"
                    >
                      {order.order_number}
                    </button>
                    <span className="text-sm text-gray-600">
                      {linkedOrders.length} item(s) mapped
                    </span>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">Order details unavailable</p>
                );
              })()}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setUnlinkConfirmOpen(true)}
              className="text-red-600"
              disabled={saveHydrationRequired || hasActiveInvoice || hasApplicationRecord || ticket.payment_status !== 'unbilled'}
              title={hasActiveInvoice
                ? 'Active invoices must be voided or cancelled before unlinking'
                : hasApplicationRecord
                  ? 'Application records must be reversed or removed before unlinking'
                : ticket.payment_status !== 'unbilled'
                  ? 'Billed tickets must remain linked to their order'
                  : undefined}
            >
              <Unlink className="h-4 w-4" />
              Unlink from Order
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-500">
              This blend ticket is not linked to any order. Link it to an existing order or create a new one.
            </p>
            {orderActionBlockReason && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                {orderActionBlockReason}
              </p>
            )}
            <div className="flex gap-2 items-center">
              <Button variant="secondary" size="sm" onClick={openLinkModal} disabled={Boolean(orderActionBlockReason)}>
                <Link2 className="h-4 w-4" />
                Link to Existing Order
              </Button>
              <HelpTip text="Link to Order attaches this ticket to an EXISTING sales order — the 'chemical sale' path where we deliver the product and the order draws it from inventory. Use this when the customer is buying the chemical, not us applying it." />
              <Button size="sm" onClick={openCreateOrderModal} disabled={Boolean(orderActionBlockReason)}>
                <ShoppingCart className="h-4 w-4" />
                Create Order from Ticket
              </Button>
              <HelpTip text="Create Order builds a NEW sales order from this ticket's products at tier pricing — also the 'chemical sale' path (we deliver, inventory is drawn). Use this when there is no existing order to link to." />
            </div>
          </div>
        )}
      </Card>

      {/* Create Invoice directly from Blend Ticket (Pillar 1) */}
      {/* codex-driven hunt cycle 4: gate on payment_status === 'unbilled' to match the
          RPC's actual guard (create_invoice_from_blend_ticket rejects anything not
          'unbilled'). The old `!== 'billed'` test also showed the card for prepaid /
          no_charge tickets, giving a Create Invoice button that always errored.
          Re-bill-after-void still works — the sync trigger resets billed -> unbilled. */}
      {ticket.review_status === 'approved' && ticket.payment_status === 'unbilled' && (
        <Card className="p-6 border-crx-green/30 bg-crx-green-light/20">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-nav-dark flex items-center gap-2">
                <FileText className="h-4 w-4 text-crx-green" />
                Direct Invoice
                <HelpTip text="Create Invoice bills the customer NOW straight from this ticket — the 'we applied it' path (a field-application invoice; no order or delivery needed). Choose this OR the job's Transfer to Invoice for a given application, never both, or the customer is billed twice." />
              </h3>
              <p className="text-xs text-secondary mt-1">
                Create an invoice directly from this blend ticket — no order required.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => setCreateInvoiceConfirmOpen(true)}
              loading={creatingInvoice}
          disabled={Boolean(invoiceActionBlockReason)}
            >
              <FileText className="h-4 w-4" />
              Create Invoice
            </Button>
          </div>
          {invoiceActionBlockReason && (
            <p className="text-xs text-yellow-600 mt-2">{invoiceActionBlockReason}</p>
          )}
        </Card>
      )}

      <ConfirmModal
        open={createInvoiceConfirmOpen}
        onClose={() => setCreateInvoiceConfirmOpen(false)}
        onConfirm={handleCreateInvoice}
        title="Create Invoice from Blend Ticket"
        message={`This will create a draft invoice for ${ticket.customer?.farm_name || 'this customer'} with ${products.length} product(s). The blend ticket will be marked as "billed".`}
        confirmLabel="Create Invoice"
        variant="info"
      />

      {/* Link to Order Modal */}
      <Modal open={showLinkModal} onClose={() => setShowLinkModal(false)} title="Link to Existing Order" size="large">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Select an order for customer <strong>{ticket.customer?.farm_name}</strong> to link this blend ticket to.
            Products will be auto-matched by product ID.
          </p>
          {availableOrders.length === 0 ? (
            <p className="text-sm text-gray-500 py-4 text-center">
              No open orders found for this customer. Create an order first or use "Create Order from Ticket".
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto space-y-2">
              {availableOrders.map((order) => (
                <label
                  key={order.id}
                  className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-gray-50 transition-colors ${
                    selectedOrderId === order.id ? 'border-crx-green bg-crx-green-light' : 'border-gray-200'
                  }`}
                >
                  <input
                    type="radio"
                    name="order"
                    value={order.id}
                    checked={selectedOrderId === order.id}
                    onChange={() => setSelectedOrderId(order.id)}
                    className="text-crx-green focus:ring-crx-green"
                  />
                  <div className="flex-1">
                    <p className="font-medium text-nav-dark">{order.order_number}</p>
                    <p className="text-xs text-gray-500">
                      {new Date(order.order_date + 'T00:00:00').toLocaleDateString()} · {order.status} · ${order.total_price.toFixed(2)}
                      {order.items && ` · ${order.items.length} items`}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowLinkModal(false)}>Cancel</Button>
            <Button onClick={handleLinkToOrder} disabled={!selectedOrderId || linking || Boolean(orderActionBlockReason)} loading={linking}>
              <Link2 className="h-4 w-4" />
              Link to Order
            </Button>
          </div>
        </div>
      </Modal>

      {/* Create Order from Blend Ticket Modal */}
      <Modal open={showCreateOrderModal} onClose={() => setShowCreateOrderModal(false)} title="Create Order from Blend Ticket">
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            A new order will be created for <strong>{ticket.customer?.farm_name}</strong> using
            the {products.length} product(s) from this blend ticket. Tier pricing will be applied automatically.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Order Number *</label>
            <Input
              type="text"
              value={newOrderNumber}
              onChange={(e) => setNewOrderNumber(e.target.value)}
              placeholder="e.g., ORD-2026-001"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Order Date</label>
            <Input
              type="date"
              value={newOrderDate}
              onChange={(e) => setNewOrderDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
            <textarea
              value={newOrderNotes}
              onChange={(e) => setNewOrderNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="Order notes..."
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setShowCreateOrderModal(false)}>Cancel</Button>
            <Button onClick={handleCreateOrder} disabled={!newOrderNumber.trim() || linking || Boolean(orderActionBlockReason)} loading={linking}>
              <ShoppingCart className="h-4 w-4" />
              Create Order
            </Button>
          </div>
        </div>
      </Modal>

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

      {/* E2: Raw OCR Text Viewer */}
      {ticket.raw_ocr_text && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setShowRawOcr(!showRawOcr)}
            className="w-full flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors text-sm font-medium text-gray-700"
          >
            <span className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Raw OCR Text
            </span>
            <span className="text-xs text-gray-400">{showRawOcr ? 'Hide' : 'Show'}</span>
          </button>
          {showRawOcr && (
            <pre className="p-4 text-xs text-gray-600 bg-white overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto font-mono border-t border-gray-200">
              {ticket.raw_ocr_text}
            </pre>
          )}
        </div>
      )}

      <div className="flex justify-end gap-3">
        {ticket.source === 'ocr' && (
          <Button
            variant="secondary"
            onClick={() => setReprocessConfirmOpen(true)}
            loading={reprocessing}
            disabled={!canReprocessOcr}
          >
            <RefreshCw className="h-4 w-4" />
            Re-process OCR
          </Button>
        )}
        <Button variant="secondary" onClick={() => navigate('/blend-tickets')}>
          Cancel
        </Button>
        {ticket.status === 'completed' && ticket.review_status === 'unreviewed' && (
          <>
            <Button variant="secondary" onClick={() => setRejectConfirmOpen(true)} disabled={hasUnsavedChanges} className="text-red-600 hover:text-red-700">
              <X className="h-4 w-4" />
              Reject
            </Button>
            <Button variant="secondary" onClick={() => setApproveConfirmOpen(true)} disabled={hasUnsavedChanges} className="text-green-600 hover:text-green-700">
              <Check className="h-4 w-4" />
              Approve
            </Button>
          </>
        )}
        {ticket.review_status === 'approved' && (
          <span className="inline-flex items-center gap-1">
            <Button variant="secondary" onClick={handleCreateApplicationRecord} loading={creatingAppRecord} disabled={hasUnsavedChanges}>
              <ClipboardCheck className="h-4 w-4" />
              Create App Record
            </Button>
            <HelpTip text="Create Application Record files the legal as-applied record (product, field, date, rate) for compliance. It does NOT bill anyone — it's the regulatory paperwork, separate from Create Invoice (billing) and from linking to an order or job." />
          </span>
        )}
        <Button
          onClick={handleSave}
          disabled={saveHydrationRequired || saving || fieldsDirty || reprocessing || ticket.status === 'processing' || contentLocked}
        >
          <Save className="h-4 w-4" />
          {saving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />

      <ConfirmModal
        open={appRecordConfirmOpen}
        onClose={() => setAppRecordConfirmOpen(false)}
        onConfirm={executeCreateApplicationRecord}
        title="Create Application Record"
        message="Create an application record from this approved blend ticket? This action cannot be undone."
        confirmLabel="Create Record"
        variant="info"
        icon={ClipboardCheck}
        loading={creatingAppRecord}
      />

      <ConfirmModal
        open={approveConfirmOpen}
        onClose={() => setApproveConfirmOpen(false)}
        onConfirm={handleApprove}
        title="Approve Blend Ticket"
        message="Approve this blend ticket?"
        confirmLabel="Approve"
        variant="info"
      />

      <ConfirmModal
        open={rejectConfirmOpen}
        onClose={() => setRejectConfirmOpen(false)}
        onConfirm={handleReject}
        title="Reject Blend Ticket"
        message="Reject this blend ticket?"
        confirmLabel="Reject"
        variant="danger"
      />

      <ConfirmModal
        open={removeProductConfirmOpen}
        onClose={() => { setRemoveProductConfirmOpen(false); setRemoveProductIndex(null); }}
        onConfirm={() => { if (removeProductIndex !== null) removeProduct(removeProductIndex); }}
        title="Remove Product"
        message="Remove this product from the ticket?"
        confirmLabel="Remove"
        variant="danger"
      />

      <ConfirmModal
        open={unlinkConfirmOpen}
        onClose={() => setUnlinkConfirmOpen(false)}
        onConfirm={handleUnlink}
        title="Unlink Blend Ticket"
        message="Unlink this blend ticket from its order? The order itself will not be deleted."
        confirmLabel="Unlink"
        variant="warning"
      />

      <ConfirmModal
        open={reprocessConfirmOpen}
        onClose={() => setReprocessConfirmOpen(false)}
        onConfirm={handleReprocessOCR}
        title="Re-process OCR"
        message="This will re-run OCR on the stored images, preserve existing manual values, and refresh unmatched OCR products. Continue?"
        confirmLabel="Re-process"
        variant="warning"
      />
    </fieldset>
  );
}
