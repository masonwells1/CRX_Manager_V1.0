import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Phone, MapPin, CheckCircle2, Package, Download, WifiOff,
  Minus, Plus, Pencil, Ban, Camera, UserPlus, AlertTriangle, RefreshCw,
  PlayCircle, Lock, Zap, FileText, Mail,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import SignatureCanvas from '../components/ui/SignatureCanvas';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, sanitizeError, checkMutationResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { downloadDeliveryPdf } from '../lib/deliveryPdf';
import { logActivity } from '../lib/activityLogger';
import { sendEmail, buildEmailHtml } from '../lib/emailService';
import { notifyDeliveryRemainder } from '../lib/notificationTriggers';
import { checkRUPCompliance } from '../lib/rupCompliance';
import StartDeliveryModal from '../components/deliveries/StartDeliveryModal';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { queueAction } from '../lib/offlineQueue';
import { compressImage } from '../lib/imageCompression';
import type {
  Delivery, DeliveryItem, DeliveryPhoto, DeliveryRemainder,
  Customer, CustomerAddress, Profile, OrderItem, DeliveryIssueType,
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

const fmtCents = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export default function DeliveryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const editIdem = useIdempotencyKey('edit_delivery', profile?.id || '');
  const cancelIdem = useIdempotencyKey('cancel_delivery', profile?.id || '');
  const followupIdem = useIdempotencyKey('create_followup_delivery', profile?.id || '');
  const confirmIdem = useIdempotencyKey('confirm_delivery', profile?.id || '');
  const completeIdem = useIdempotencyKey('complete_delivery', profile?.id || '');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [address, setAddress] = useState<CustomerAddress | null>(null);
  const [driver, setDriver] = useState<Profile | null>(null);
  const [photos, setPhotos] = useState<DeliveryPhoto[]>([]);
  const [remainders, setRemainders] = useState<DeliveryRemainder[]>([]);
  const [loading, setLoading] = useState(true);
  const [rupWarnings, setRupWarnings] = useState<string[]>([]);

  // Signature signed URL (generated on demand for privacy)
  const [signedSignatureUrl, setSignedSignatureUrl] = useState<string | null>(null);

  // Driver completion state
  const [signedBy, setSignedBy] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [deliveryQtys, setDeliveryQtys] = useState<Record<string, number>>({});
  const [driverIssueType, setDriverIssueType] = useState<DeliveryIssueType>('none');
  const [driverIssueNotes, setDriverIssueNotes] = useState('');
  const [autoInvoiceId, setAutoInvoiceId] = useState<string | null>(null);
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
  const [editItems, setEditItems] = useState<Array<{
    order_item_id: string; product_id: string; product_name: string;
    quantity: number; max_quantity: number; unit_size: string;
  }>>([]);
  const [addresses, setAddresses] = useState<CustomerAddress[]>([]);
  const [drivers, setDrivers] = useState<Profile[]>([]);
  const [, setOrderItems] = useState<OrderItem[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);

  // Cancel modal state
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

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
    total_amount_cents: number;
  }>>([]);

  const isDriver = role === 'driver';
  const isAdminOrRep = role === 'admin' || role === 'sales_rep';
  const canEdit = isAdminOrRep && delivery?.status !== 'completed' && delivery?.status !== 'cancelled';
  const canCancel = isAdminOrRep && delivery?.status !== 'cancelled' && delivery?.status !== 'completed';
  const isAssignedDriver = isDriver && profile?.id === delivery?.assigned_driver;
  const canConfirm = (isAdminOrRep || isAssignedDriver) && delivery?.status === 'scheduled';

  const fetchDelivery = useCallback(async () => {
    const { data: delData, error: delError } = await supabase
      .from('deliveries')
      .select('*')
      .eq('id', id!)
      .maybeSingle();

    if (delError) {
      toast('error', sanitizeError(delError));
      setLoading(false);
      return;
    }

    if (delData) {
      const del = delData as Delivery;
      setDelivery(del);

      try {
        const [custRes, itemsRes, addrRes, driverRes, photosRes] = await Promise.all([
          supabase.from('customers').select('*').eq('id', del.customer_id).maybeSingle(),
          supabase.from('delivery_items').select('*, product:products(product_name)').eq('delivery_id', id!),
          del.delivery_address_id
            ? supabase.from('customer_addresses').select('*').eq('id', del.delivery_address_id).maybeSingle()
            : Promise.resolve({ data: null }),
          del.assigned_driver
            ? supabase.from('profiles').select('*').eq('id', del.assigned_driver).maybeSingle()
            : Promise.resolve({ data: null }),
          supabase.from('delivery_photos').select('*').eq('delivery_id', id!).order('sort_order'),
        ]);

        setCustomer(custRes.data as Customer | null);
        const loadedItems = (itemsRes.data || []) as DeliveryItem[];
        setItems(loadedItems);
        const initQtys: Record<string, number> = {};
        loadedItems.forEach((item) => { initQtys[item.id] = item.quantity; });
        setDeliveryQtys(initQtys);
        setAddress(addrRes.data as CustomerAddress | null);
        setDriver(driverRes.data as Profile | null);
        setPhotos((photosRes.data || []) as DeliveryPhoto[]);

        // Fetch order item context for items display
        if (del.order_id) {
          const [oiRes, orderRes, invRes] = await Promise.all([
            supabase
              .from('order_items')
              .select('id, total_units_needed, quantity_delivered, quantity_remaining')
              .eq('order_id', del.order_id),
            supabase
              .from('orders')
              .select('id, order_number')
              .eq('id', del.order_id)
              .maybeSingle(),
            supabase
              .from('invoices')
              .select('id, invoice_number, invoice_date, status, total_amount_cents')
              .eq('order_id', del.order_id)
              .order('invoice_date', { ascending: false }),
          ]);
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
            (invRes.data || []).map((inv: Record<string, unknown>) => ({
              id: inv.id as string,
              invoice_number: inv.invoice_number as string,
              invoice_date: inv.invoice_date as string,
              status: inv.status as string,
              total_amount_cents: Number(inv.total_amount_cents || 0),
            }))
          );
        }

        // Fetch remainders for completed deliveries
        if (del.status === 'completed') {
          const { data: remData, error: remError } = await supabase
            .from('delivery_remainders')
            .select('*, product:products(product_name)')
            .eq('original_delivery_id', id!);
          if (remError) {
            toast('error', sanitizeError(remError));
          } else {
            setRemainders((remData || []).map((r: DeliveryRemainder & { product?: { product_name: string } | null }) => ({
              ...r,
              product_name: r.product?.product_name || 'Unknown',
            })) as DeliveryRemainder[]);
          }

          // Generate signed URL for signature (privacy: no permanent public URLs)
          if (del.signature_url) {
            const { data: signedData } = await supabase.storage
              .from('delivery-signatures')
              .createSignedUrl(del.signature_url, 3600); // 1 hour expiry
            if (signedData?.signedUrl) {
              setSignedSignatureUrl(signedData.signedUrl);
            }
          }
        }
      } catch {
        toast('error', 'Failed to load delivery details. Please refresh.');
      }
    }
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

  const updateDeliveryQty = (itemId: string, qty: number, max: number) => {
    setDeliveryQtys((prev) => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, max)) }));
  };

  const isPartialDelivery = items.some((item) => (deliveryQtys[item.id] ?? item.quantity) < item.quantity);
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
      supabase.from('profiles').select('*').in('role', ['driver', 'admin']).eq('is_active', true).order('full_name'),
      supabase.from('order_items').select('*').eq('order_id', delivery.order_id).order('section_name'),
    ]);
    setAddresses((addrRes.data || []) as CustomerAddress[]);
    setDrivers((driverRes.data || []) as Profile[]);
    setOrderItems((oiRes.data || []) as OrderItem[]);

    // Map current items for editing
    setEditItems(items.map((item) => ({
      order_item_id: item.order_item_id,
      product_id: item.product_id,
      product_name: (item.product as unknown as { product_name: string })?.product_name || 'Unknown',
      quantity: item.quantity,
      max_quantity: item.quantity, // Will be calculated below
      unit_size: item.unit_size || '',
    })));

    setEditing(true);
  };

  const saveEdit = async () => {
    if (!delivery || !profile) return;
    setSavingEdit(true);

    // Items are locked to the order — only save logistics changes
    const idemKey = editIdem.getKey();
    const { error } = await supabase.rpc('edit_delivery', {
      p_delivery_id: id!,
      p_assigned_driver: editDriver || null,
      p_scheduled_date: editDate,
      p_scheduled_time: editTime || null,
      p_delivery_window_start: editWindowStart || null,
      p_delivery_window_end: editWindowEnd || null,
      p_delivery_address_id: editAddress || null,
      p_delivery_notes: editNotes || null,
      p_priority: editPriority,
      p_performed_by: profile.id,
      p_idempotency_key: idemKey,
    });

    if (error) {
      toast('error', sanitizeError(error));
    } else {
      editIdem.resetKey();
      toast('success', 'Delivery updated');
      setEditing(false);
      fetchDelivery();
    }
    setSavingEdit(false);
  };

  // ── Cancel Delivery ────────────────────────────────────────────────────

  const handleCancel = async () => {
    if (!profile) return;
    setCancelling(true);
    const idemKey = cancelIdem.getKey();
    const { data: cancelResult, error } = await supabase.rpc('cancel_delivery', {
      p_delivery_id: id!,
      p_cancel_reason: cancelReason.trim() || 'Cancelled',
      p_performed_by: profile.id,
      p_idempotency_key: idemKey,
    });
    if (error) {
      toast('error', sanitizeError(error));
    } else {
      cancelIdem.resetKey();
      // Show detailed summary toast with cascade info
      const parts: string[] = ['Delivery cancelled.'];
      if (cancelResult?.items_restored > 0) parts.push(`Inventory restored for ${cancelResult.items_restored} item(s).`);
      if (cancelResult?.draft_invoices_voided > 0) parts.push(`${cancelResult.draft_invoices_voided} draft invoice(s) voided.`);
      if (cancelResult?.posted_invoices_flagged > 0) parts.push(`Admin notified about ${cancelResult.posted_invoices_flagged} posted invoice(s) needing review.`);
      toast('success', parts.join(' '));
      setCancelOpen(false);
      setCancelReason('');
      fetchDelivery();
    }
    setCancelling(false);
  };

  // ── Reassign (Take This Delivery) ─────────────────────────────────────

  const handleReassign = async () => {
    if (!profile || !delivery) return;
    if (!confirm(`Take delivery ${delivery.delivery_number}? The current driver will be notified.`)) return;

    const { error } = await supabase.rpc('reassign_delivery', {
      p_delivery_id: id!,
      p_new_driver: profile.id,
      p_performed_by: profile.id,
    });

    if (error) {
      toast('error', sanitizeError(error));
    } else {
      toast('success', 'Delivery assigned to you');
      fetchDelivery();
    }
  };

  // ── Photo Upload ───────────────────────────────────────────────────────

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !profile || !delivery) return;

    if (photos.length + files.length > 10) {
      toast('error', 'Maximum 10 photos per delivery');
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
          .upload(storagePath, file, { contentType: file.type });

        if (uploadErr) {
          toast('error', `Upload failed: ${uploadErr.message}`);
          continue;
        }

        const { data: urlData } = supabase.storage
          .from('delivery-photos')
          .getPublicUrl(storagePath);

        const { error: insertErr } = await supabase.from('delivery_photos').insert({
          delivery_id: id!,
          storage_path: storagePath,
          image_url: urlData.publicUrl,
          uploaded_by: profile.id,
          file_size: file.size,
          sort_order: photos.length + uploadCount,
        });
        if (insertErr) {
          toast('error', `Photo saved to storage but DB record failed: ${insertErr.message}`);
          continue;
        }

        uploadCount++;
      } catch (err) {
        console.error('Photo upload error:', err);
        toast('error', 'Photo upload failed. Please try again.');
      }
    }

    if (uploadCount > 0) {
      toast('success', `${uploadCount} photo${uploadCount > 1 ? 's' : ''} uploaded`);
      fetchDelivery();
    }
    setUploadingPhoto(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Follow-up Delivery ─────────────────────────────────────────────────

  const handleCreateFollowup = async () => {
    if (!profile) return;
    setCreatingFollowup(true);

    const idemKey = followupIdem.getKey();
    const { data, error } = await supabase.rpc('create_followup_delivery', {
      p_original_delivery_id: id!,
      p_performed_by: profile.id,
      p_idempotency_key: idemKey,
    });

    if (error) {
      toast('error', sanitizeError(error));
    } else {
      followupIdem.resetKey();
      const result = assertRpcResult<{ delivery_id: string; delivery_number: string; item_count: number }>(data, 'create_followup_delivery');
      toast('success', `Follow-up delivery ${result.delivery_number} created with ${result.item_count} items`);
      navigate(`/deliveries/${result.delivery_id}`);
    }
    setCreatingFollowup(false);
  };

  // ── Start Delivery (Confirm) ──────────────────────────────────────────

  const handleStartDelivery = async () => {
    if (!delivery || !profile) return;
    setConfirming(true);
    try {
      const idemKey = confirmIdem.getKey();
      const { error } = await supabase.rpc('confirm_delivery', {
        p_delivery_id: id!,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
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

  const handleComplete = async () => {
    if (!signedBy.trim()) {
      toast('error', 'Please enter a signature name');
      return;
    }
    if (!delivery || !profile) return;
    if (!hasAnyQty) {
      toast('error', 'At least one item must have a quantity greater than 0');
      return;
    }
    const confirmMsg = isPartialDelivery
      ? 'Complete this delivery with partial quantities? This will update inventory and cannot be undone.'
      : 'Complete this delivery? This will update inventory and cannot be undone.';
    if (!confirm(confirmMsg)) return;
    setCompleting(true);

    const quantitiesJson = isPartialDelivery
      ? Object.fromEntries(items.map((item) => [item.id, deliveryQtys[item.id] ?? item.quantity]))
      : null;

    const idemKey = completeIdem.getKey();
    const rpcParams: Record<string, unknown> = {
      p_delivery_id: id!,
      p_signed_by: signedBy,
      p_performed_by: profile.id,
      p_idempotency_key: idemKey,
      ...(quantitiesJson ? { p_quantities: quantitiesJson } : {}),
      ...(driverIssueType !== 'none' ? { p_issue_type: driverIssueType } : {}),
      ...(driverIssueNotes.trim() ? { p_issue_notes: driverIssueNotes.trim() } : {}),
    };

    if (!isOnline) {
      try {
        await queueAction({
          operation: 'complete_delivery',
          params: rpcParams,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        });
        toast('success', 'Delivery saved offline — will sync when you reconnect');
      } catch {
        toast('error', 'Failed to save offline. Please try again.');
      }
      setCompleting(false);
      return;
    }

    try {
      const { data: completeResult, error } = await supabase.rpc('complete_delivery', rpcParams);
      if (error) throw error;
      completeIdem.resetKey();

      // Upload signature image if provided
      if (signatureDataUrl) {
        try {
          const base64Data = signatureDataUrl.split(',')[1];
          const byteCharacters = atob(base64Data);
          const byteArray = new Uint8Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) {
            byteArray[i] = byteCharacters.charCodeAt(i);
          }
          const blob = new Blob([byteArray], { type: 'image/png' });
          const filePath = `signatures/${id}.png`;
          const { error: uploadError } = await supabase.storage
            .from('delivery-signatures')
            .upload(filePath, blob, { upsert: true, contentType: 'image/png' });
          if (!uploadError) {
            // Store the storage path (not a public URL) — signed URLs are
            // generated on demand for privacy (signatures are PII)
            const sigResult = await supabase
              .from('deliveries')
              .update({ signature_url: filePath })
              .eq('id', id!)
              .select();
            checkMutationResult(sigResult, 'Update delivery signature');
          }
        } catch (sigErr) {
          console.warn('Signature upload failed:', sigErr);
          toast('error', 'Signature could not be saved. Please try completing the delivery again.');
          return;
        }
      }

      // Show auto-invoice info if created
      const autoInvoice = completeResult as { auto_invoice?: { invoice_id?: string; invoice_number?: string } } | null;
      const invoiceNum = autoInvoice?.auto_invoice?.invoice_number;
      const invoiceId = autoInvoice?.auto_invoice?.invoice_id;
      if (invoiceId) setAutoInvoiceId(invoiceId);

      if (invoiceNum) {
        toast('success', isPartialDelivery
          ? `Delivery completed (partial). Draft invoice ${invoiceNum} created.`
          : `Delivery completed. Draft invoice ${invoiceNum} created.`);
      } else {
        toast('success', isPartialDelivery ? 'Delivery completed (partial quantities)' : 'Delivery completed');
      }
      logActivity('delivery_completed', `Delivery ${delivery.delivery_number} completed${isPartialDelivery ? ' (partial)' : ''}${invoiceNum ? ` — draft invoice ${invoiceNum} auto-created` : ''}`, profile.id, 'delivery', delivery.id, delivery.customer_id);

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

      // === Email customer when delivery is completed ===
      if (customer?.email) {
        try {
          const deliveredItems = items.map((item) => {
            const qty = isPartialDelivery ? (deliveryQtys[item.id] ?? item.quantity) : item.quantity;
            return `<tr>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;">${item.product?.product_name || 'Product'}</td>
              <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${qty}</td>
            </tr>`;
          }).join('');

          const photoCount = photos.length;
          const photoImages = photos.slice(0, 6).map((p) =>
            `<img src="${p.image_url}" alt="${p.caption || 'Delivery photo'}" style="width:140px;height:105px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;" />`
          ).join('');
          const photoNote = photoCount > 0
            ? `<div style="margin-top:16px;"><p style="color:#1e293b;font-size:14px;font-weight:600;margin-bottom:8px;">📷 Delivery Photos (${photoCount})</p><div style="display:flex;flex-wrap:wrap;gap:8px;">${photoImages}</div>${photoCount > 6 ? `<p style="color:#64748b;font-size:12px;margin-top:6px;">+ ${photoCount - 6} more photo(s) on file</p>` : ''}</div>`
            : '';
          const signatureNote = signedBy
            ? `<p style="color:#475569;font-size:13px;">✍️ Signed by: <strong>${signedBy}</strong></p>`
            : '';
          const partialNote = isPartialDelivery
            ? '<p style="color:#d97706;font-size:13px;font-weight:600;margin-top:8px;">⚠️ This was a partial delivery. Remaining items will be delivered separately.</p>'
            : '';

          const html = buildEmailHtml(`
            <h2 style="color:#1e293b;margin:0 0 12px;">Delivery Completed</h2>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Hi${customer.contact_name ? ` ${customer.contact_name}` : ''},
            </p>
            <p style="color:#475569;font-size:14px;line-height:1.6;">
              Your delivery <strong>${delivery.delivery_number}</strong> has been completed.
            </p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr>
                <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;color:#166534;">Delivery #</td>
                <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;font-weight:600;color:#166534;">${delivery.delivery_number}</td>
              </tr>
              <tr>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Date</td>
                <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${new Date().toLocaleDateString()}</td>
              </tr>
            </table>
            <h3 style="color:#1e293b;font-size:14px;margin:16px 0 8px;">Delivered Items</h3>
            <table style="width:100%;border-collapse:collapse;">
              <tr style="background:#f8fafc;">
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#64748b;">Product</th>
                <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Qty Delivered</th>
              </tr>
              ${deliveredItems}
            </table>
            ${partialNote}
            ${signatureNote}
            ${photoNote}
            <p style="color:#475569;font-size:14px;line-height:1.6;margin-top:16px;">
              Thank you for your business!
            </p>
          `);

          await sendEmail({
            to: customer.email,
            subject: `Delivery ${delivery.delivery_number} Completed — Crop RX Solutions`,
            html,
            email_type: 'delivery_completed',
            customer_id: delivery.customer_id,
            idempotency_key: `delivery-completed-${delivery.id}-${Date.now()}`,
          });
        } catch (emailErr) {
          console.warn('Delivery completion email failed:', emailErr);
          // Delivery already succeeded — don't show error for email
        }
      }

      fetchDelivery();
    } catch (error: unknown) {
      console.error('Error completing delivery:', error);
      toast('error', sanitizeError(error));
    }
    setCompleting(false);
  };

  // ── Resend Delivery Confirmation Email ──────────────────────────────────
  const handleResendEmail = async () => {
    if (!delivery || !customer?.email) {
      toast('error', customer?.email ? 'Delivery not loaded' : 'No customer email on file');
      return;
    }
    setSendingEmail(true);
    try {
      const deliveredItems = items.map((item) =>
        `<tr>
          <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;">${item.product?.product_name || 'Product'}</td>
          <td style="padding:6px 12px;border:1px solid #e2e8f0;font-size:13px;text-align:right;">${item.quantity_delivered || item.quantity}</td>
        </tr>`
      ).join('');

      const photoImages = photos.slice(0, 6).map((p) =>
        `<img src="${p.image_url}" alt="${p.caption || 'Delivery photo'}" style="width:140px;height:105px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0;" />`
      ).join('');
      const photoNote = photos.length > 0
        ? `<div style="margin-top:16px;"><p style="color:#1e293b;font-size:14px;font-weight:600;margin-bottom:8px;">📷 Delivery Photos (${photos.length})</p><div style="display:flex;flex-wrap:wrap;gap:8px;">${photoImages}</div>${photos.length > 6 ? `<p style="color:#64748b;font-size:12px;margin-top:6px;">+ ${photos.length - 6} more photo(s) on file</p>` : ''}</div>`
        : '';
      const signatureNote = delivery.signed_by
        ? `<p style="color:#475569;font-size:13px;">✍️ Signed by: <strong>${delivery.signed_by}</strong></p>`
        : '';

      const html = buildEmailHtml(`
        <h2 style="color:#1e293b;margin:0 0 12px;">Delivery Confirmation</h2>
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Hi${customer.contact_name ? ` ${customer.contact_name}` : ''},
        </p>
        <p style="color:#475569;font-size:14px;line-height:1.6;">
          Here is your delivery confirmation for <strong>${delivery.delivery_number}</strong>.
        </p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr>
            <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;color:#166534;">Delivery #</td>
            <td style="padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;font-size:13px;font-weight:600;color:#166534;">${delivery.delivery_number}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#64748b;">Completed</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;">${delivery.completed_at ? new Date(delivery.completed_at).toLocaleDateString() : new Date().toLocaleDateString()}</td>
          </tr>
        </table>
        <h3 style="color:#1e293b;font-size:14px;margin:16px 0 8px;">Delivered Items</h3>
        <table style="width:100%;border-collapse:collapse;">
          <tr style="background:#f8fafc;">
            <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:left;color:#64748b;">Product</th>
            <th style="padding:6px 12px;border:1px solid #e2e8f0;font-size:12px;text-align:right;color:#64748b;">Qty Delivered</th>
          </tr>
          ${deliveredItems}
        </table>
        ${signatureNote}
        ${photoNote}
        <p style="color:#475569;font-size:14px;line-height:1.6;margin-top:16px;">
          Thank you for your business!
        </p>
      `);

      await sendEmail({
        to: customer.email,
        subject: `Delivery ${delivery.delivery_number} Confirmation — Crop RX Solutions`,
        html,
        email_type: 'delivery_completed',
        customer_id: delivery.customer_id,
        idempotency_key: `delivery-resend-${delivery.id}-${Date.now()}`,
      });
      toast('success', `Confirmation email sent to ${customer.email}`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setSendingEmail(false);
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
              <div className="flex items-center gap-2 flex-shrink-0">
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
              {new Date(delivery.scheduled_date).toLocaleDateString()}
              {delivery.scheduled_time && ` at ${delivery.scheduled_time}`}
              {delivery.delivery_window_start && delivery.delivery_window_end &&
                ` (${delivery.delivery_window_start} - ${delivery.delivery_window_end})`}
            </p>
          </div>

          {/* Take delivery button */}
          {canTakeDelivery && (
            <button
              onClick={handleReassign}
              className="flex items-center gap-4 w-full bg-gray-800 rounded-xl p-5 border border-crx-green active:bg-gray-700 transition-colors"
            >
              <div className="w-12 h-12 rounded-full bg-crx-green flex items-center justify-center shrink-0">
                <UserPlus className="w-6 h-6 text-white" />
              </div>
              <div className="text-left">
                <p className="text-white font-medium">Take This Delivery</p>
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
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-amber-800">
                  {rupWarnings.map((w, i) => <p key={i}>{w}</p>)}
                </div>
              </div>
            </div>
          )}

          {/* Products */}
          <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
            <h3 className="text-white font-semibold mb-4">Products</h3>
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
                          max={item.quantity}
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

          {/* Photo upload (driver) */}
          {canUploadPhoto && (
            <div className="bg-gray-800 rounded-xl p-5 border border-gray-700">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-semibold">Delivery Photos</h3>
                <span className="text-sm text-gray-400">{photos.length}/10</span>
              </div>
              {photos.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
                  {photos.map((photo) => (
                    <img
                      key={photo.id}
                      src={photo.image_url}
                      alt={photo.caption || 'Delivery photo'}
                      className="w-full h-36 sm:h-48 object-contain rounded-lg border border-gray-600 bg-gray-800"
                    />
                  ))}
                </div>
              )}
              {photos.length < 10 && (
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
              <h3 className="text-white font-semibold">Complete Delivery</h3>
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
              <div className="bg-gray-700 rounded-lg p-3">
                <SignatureCanvas
                  onSignatureChange={setSignatureDataUrl}
                  label="Customer Signature"
                  height={120}
                />
              </div>
              {!isOnline && (
                <div className="flex items-center gap-2 p-3 bg-yellow-900/30 border border-yellow-700 rounded-lg text-yellow-300 text-sm">
                  <WifiOff className="h-4 w-4 flex-shrink-0" />
                  <span>You are offline. Delivery will be saved locally and synced when you reconnect.</span>
                </div>
              )}
              <button
                onClick={handleComplete}
                disabled={completing}
                className="w-full py-4 bg-crx-green text-white text-lg font-semibold rounded-xl active:bg-crx-green-hover disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                {!isOnline && <WifiOff className="w-5 h-5" />}
                <CheckCircle2 className="w-6 h-6" />
                {completing ? 'Saving...' : isOnline ? 'Complete Delivery' : 'Save Offline'}
              </button>
            </div>
          )}
        </div>

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
                onClick={handleReassign}
              >
                Take Delivery
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-4 h-4" />}
              showChevron={false}
              onClick={() =>
                downloadDeliveryPdf({
                  delivery_number: delivery.delivery_number,
                  order_number: parentOrder?.order_number || '-',
                  customer_name: customer?.farm_name || 'Customer',
                  customer_address: address
                    ? [address.address_line, address.city, address.state, address.zip].filter(Boolean).join(', ')
                    : customer?.billing_address || undefined,
                  driver_name: driver?.full_name || 'Unassigned',
                  scheduled_date: delivery.scheduled_date,
                  completed_at: delivery.completed_at || undefined,
                  status: delivery.status,
                  signed_by: delivery.signed_by || undefined,
                  delivery_notes: delivery.delivery_notes || undefined,
                  items: items.map((i) => ({
                    product_name: i.product?.product_name || 'Unknown',
                    quantity: i.quantity,
                    quantity_delivered: delivery.status === 'completed' ? i.quantity_delivered : undefined,
                    unit_size: i.unit_size || '-',
                    tote_number: i.tote_number || undefined,
                  })),
                })
              }
            >
              Receipt PDF
            </Button>
            {delivery.status === 'completed' && customer?.email && (
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
                {new Date(delivery.scheduled_date).toLocaleDateString()}
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

            {/* Delivery items — locked to order */}
            <div>
              <h4 className="text-sm font-medium text-secondary mb-2">Delivery Items</h4>
              <div className="p-3 bg-blue-50 rounded-lg border border-blue-200 text-sm text-blue-700 mb-3 flex items-start gap-2">
                <Lock className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium">Delivery items are locked to the order</p>
                  <p className="text-xs mt-1">To change quantities, update the order or cancel this delivery and create a new one.</p>
                </div>
              </div>
              <div className="space-y-2">
                {editItems.map((item) => (
                  <div key={item.order_item_id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-nav-dark">{item.product_name}</p>
                      <p className="text-xs text-secondary">{item.unit_size || 'units'}</p>
                    </div>
                    <p className="text-sm font-mono font-medium text-nav-dark">{item.quantity}</p>
                  </div>
                ))}
              </div>
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
            <Ban className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
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
            <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
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

      {/* Signature display for completed deliveries */}
      {delivery.status === 'completed' && delivery.signature_url && signedSignatureUrl && (
        <Card>
          <h3 className="text-lg font-semibold font-heading text-nav-dark mb-3">Signature</h3>
          <div className="flex items-start gap-4">
            <img
              src={signedSignatureUrl}
              alt="Customer signature"
              className="border border-gray-200 rounded-lg max-w-xs"
            />
            <div className="text-sm text-secondary">
              <p>Signed by: <span className="font-medium text-nav-dark">{delivery.signed_by || '-'}</span></p>
              {delivery.completed_at && <p>Completed: {new Date(delivery.completed_at).toLocaleString()}</p>}
            </div>
          </div>
        </Card>
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
            <p className="text-sm text-secondary">Adjust quantities if partial delivery:</p>
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
                      max={item.quantity}
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
              value={signedBy}
              onChange={(e) => setSignedBy(e.target.value)}
              placeholder="Customer name"
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

          <div className="flex justify-end">
            <Button
              onClick={handleComplete}
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

      {/* Photos section */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold font-heading text-nav-dark">
            Delivery Photos {photos.length > 0 && `(${photos.length})`}
          </h3>
          {canUploadPhoto && photos.length < 10 && (
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
                <img
                  src={photo.image_url}
                  alt={photo.caption || 'Delivery photo'}
                  className="w-full h-48 object-contain rounded-lg border border-gray-200 bg-gray-50 cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); window.open(photo.image_url, '_blank'); }}
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

      {/* Cancel Modal */}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel Delivery">
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-lg">
            <Ban className="w-5 h-5 text-red-600 flex-shrink-0" />
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
    </div>
  );
}
