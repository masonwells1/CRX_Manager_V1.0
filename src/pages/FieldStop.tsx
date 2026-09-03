/**
 * Field Mode — per-stop runner ("/my-route/:id").
 *
 * The guided, one-thing-per-screen flow for a single delivery stop. ADDITIVE:
 * reuses the existing delivery RPCs/components; never edits DeliveryDetail.tsx.
 *
 * Flow: status-driven entry (scheduled → Arrive; in_progress → Verify) →
 * Verify items (full/short) → Signature → Review & Complete (optional photo)
 * → Done. Completion mirrors DeliveryDetail.handleComplete exactly (same
 * rpcParams, signature upload, notifications, customer email, invoice surfacing)
 * and queues offline ONLY for already-in_progress stops. See
 * docs/roadmap/field-mode-build-plan.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, MapPin, PlayCircle, WifiOff, Minus, Plus, AlertTriangle, ChevronRight,
  Camera, PenLine, CheckCircle2, ClipboardCheck, FileText,
} from 'lucide-react';
import SignatureCanvas from '../components/ui/SignatureCanvas';
import { supabase, assertRpcResult, sanitizeError, checkMutationResult } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { getOfflineStorageErrorMessage, queueAction } from '../lib/offlineQueue';
import { compressImage } from '../lib/imageCompression';
import { logActivity } from '../lib/activityLogger';
import { notifyDeliveryCompleted, notifyDeliveryRemainder } from '../lib/notificationTriggers';
import { sendDeliveryCompletionEmail } from '../lib/deliveryCompletionEmail';
import { Sentry } from '../lib/sentry';

interface StopItem {
  id: string;
  quantity: number;
  product_id: string | null;
  product: { product_name: string | null } | null;
}

interface StopPhoto {
  id: string;
  image_url: string;
  caption: string | null;
}

interface StopDelivery {
  id: string;
  delivery_number: string | null;
  status: string;
  updated_at: string | null;
  customer_id: string;
  order_id: string | null;
  created_by: string | null;
  delivery_address_id: string | null;
  delivery_notes: string | null;
  assigned_driver: string | null;
  customer: { farm_name: string | null; email: string | null; contact_name: string | null } | null;
}

type Step = 'arrive' | 'verify' | 'sign' | 'review' | 'done';
const STEP_ORDER: Step[] = ['arrive', 'verify', 'sign', 'review', 'done'];

export default function FieldStop() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const isOnline = useOnlineStatus();
  const confirmIdem = useIdempotencyKey('confirm_delivery', profile?.id || '');
  const completeIdem = useIdempotencyKey('complete_delivery', profile?.id || '');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Latest stop id the route is showing — older in-flight fetches bail (H3 stale guard).
  const activeStopIdRef = useRef<string | undefined>(undefined);

  const [delivery, setDelivery] = useState<StopDelivery | null>(null);
  const [items, setItems] = useState<StopItem[]>([]);
  const [itemsError, setItemsError] = useState(false);
  const [photos, setPhotos] = useState<StopPhoto[]>([]);
  const [deliveryQtys, setDeliveryQtys] = useState<Record<string, number>>({});
  const [addressLine, setAddressLine] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [step, setStep] = useState<Step>('arrive');
  const [signedBy, setSignedBy] = useState('');
  const [noOnePresent, setNoOnePresent] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [emailOnComplete, setEmailOnComplete] = useState(true);
  const [autoInvoiceNumber, setAutoInvoiceNumber] = useState<string | null>(null);

  const fetchPhotos = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('delivery_photos')
      .select('id, image_url, caption')
      .eq('delivery_id', id)
      .order('sort_order');
    if (activeStopIdRef.current !== id) return; // stale guard (H3)
    setPhotos((data || []) as StopPhoto[]);
  }, [id]);

  const fetchStop = useCallback(async () => {
    if (!id) return;
    // Stale-route guard (H3): on rapid stop-to-stop navigation an older in-flight
    // fetch must not overwrite the current stop's delivery/items/address/photos —
    // handleComplete submits against the live route id plus this component state.
    const isStale = () => activeStopIdRef.current !== id;
    setLoading(true);
    const { data, error } = await supabase
      .from('deliveries')
      .select('id, delivery_number, status, updated_at, customer_id, order_id, created_by, delivery_address_id, delivery_notes, assigned_driver, customer:customers(farm_name, email, contact_name)')
      .eq('id', id)
      .maybeSingle();

    if (isStale()) return;
    if (error || !data) {
      if (error) Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-stop' } });
      toast('error', 'Could not load this stop');
      navigate('/my-route');
      return;
    }

    const del = data as unknown as StopDelivery;
    setDelivery(del);
    if (del.status === 'scheduled') setStep('arrive');
    else if (del.status === 'in_progress') setStep('verify');
    else {
      toast('info', `This stop is ${del.status} — opening full detail`);
      navigate(`/deliveries/${del.id}`);
      return;
    }

    const { data: itemData, error: itemErr } = await supabase
      .from('delivery_items')
      .select('id, quantity, product_id, product:products(product_name)')
      .eq('delivery_id', id);
    if (isStale()) return;
    // Don't let a failed items query masquerade as "No items on this delivery".
    setItemsError(!!itemErr);
    if (itemErr) {
      Sentry.captureException(itemErr, { tags: { source: 'fetch', page: 'field-stop-items' } });
      toast('error', 'Could not load delivery items — refresh before completing');
    }
    const loaded = ((itemData || []) as unknown as StopItem[]);
    setItems(loaded);
    const initQtys: Record<string, number> = {};
    loaded.forEach((it) => { initQtys[it.id] = it.quantity; });
    setDeliveryQtys(initQtys);

    if (del.delivery_address_id) {
      const { data: addr } = await supabase
        .from('customer_addresses')
        .select('address_line, city, state, zip')
        .eq('id', del.delivery_address_id)
        .maybeSingle();
      if (isStale()) return;
      if (addr) {
        const a = addr as { address_line?: string | null; city?: string | null; state?: string | null; zip?: string | null };
        setAddressLine([a.address_line, a.city, a.state, a.zip].filter(Boolean).join(', '));
      }
    }
    await fetchPhotos();
    setLoading(false);
  }, [id, navigate, toast, fetchPhotos]);

  useEffect(() => { activeStopIdRef.current = id; fetchStop(); }, [id, fetchStop]);

  // After a successful Arrive, re-read deliveries.updated_at so an offline
  // completion snapshots the POST-arrive value. confirm_delivery bumps
  // updated_at; without this refresh, offlineSync would flag the driver's OWN
  // Arrive as a conflicting external edit and silently drop the queued
  // completion on reconnect.
  const syncAfterArrive = async () => {
    const { data: refreshed, error } = await supabase
      .from('deliveries').select('updated_at').eq('id', id!).maybeSingle();
    const ua = (refreshed as { updated_at?: string | null } | null)?.updated_at ?? null;
    if (error || !ua) {
      // Couldn't confirm the post-Arrive updated_at. Don't leave a STALE
      // (pre-Arrive) timestamp on the row — an offline completion would then
      // snapshot it and self-conflict on replay. Reload fully instead.
      if (error) Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-stop-arrive-resync' } });
      await fetchStop();
      return;
    }
    setDelivery((prev) => (prev ? { ...prev, status: 'in_progress', updated_at: ua } : prev));
    setStep('verify');
  };

  // ── Arrive (confirm_delivery: scheduled → in_progress) ──────────────────
  const handleArrive = async () => {
    if (!delivery || !profile || !id) return;
    // Stale-route guard (H3): never act on a delivery from a different stop than
    // the route currently shows (rapid stop-to-stop switch mid-load).
    if (delivery.id !== id) { toast('error', 'This stop just changed — please retry'); return; }
    // confirm_delivery is never queued offline (complete_delivery needs an
    // in_progress stop and a queued confirm has no replay caller).
    if (!isOnline) {
      toast('error', 'Connect to the internet to start this stop');
      return;
    }
    setConfirming(true);
    try {
      const { data, error } = await supabase.rpc('confirm_delivery', {
        p_delivery_id: id,
        p_idempotency_key: confirmIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'confirm_delivery');
      confirmIdem.resetKey();
      toast('success', 'Delivery started');
      await syncAfterArrive();
    } catch (err: unknown) {
      const msg = sanitizeError(err);
      // Stale screen: stop was already started elsewhere — re-read + resume at Verify.
      if (/in_progress|already/i.test(msg)) await syncAfterArrive();
      else toast('error', msg);
    }
    setConfirming(false);
  };

  const updateQty = (itemId: string, qty: number, max: number) => {
    setDeliveryQtys((prev) => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, max)) }));
  };

  const isPartial = items.some((it) => (deliveryQtys[it.id] ?? it.quantity) < it.quantity);
  const hasAnyQty = items.some((it) => (deliveryQtys[it.id] ?? it.quantity) > 0);

  // ── Photo upload (copied/adapted from DeliveryDetail.handlePhotoUpload) ──
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !profile || !id) return;
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
        const { data: urlData } = supabase.storage.from('delivery-photos').getPublicUrl(storagePath);
        const photoResult = await supabase.from('delivery_photos').insert({
          delivery_id: id,
          storage_path: storagePath,
          image_url: urlData.publicUrl,
          uploaded_by: profile.id,
          file_size: file.size,
          sort_order: photos.length + uploadCount,
        }).select();
        if (photoResult.error) {
          toast('error', `Photo saved to storage but DB record failed: ${photoResult.error.message}`);
          continue;
        }
        checkMutationResult(photoResult, 'Insert delivery photo');
        uploadCount++;
      } catch (err) {
        Sentry.captureException(err, { tags: { source: 'critical_action', action: 'upload_delivery_photo' } });
        toast('error', 'Photo upload failed. Please try again.');
      }
    }
    if (uploadCount > 0) {
      toast('success', `${uploadCount} photo${uploadCount > 1 ? 's' : ''} uploaded`);
      await fetchPhotos();
    }
    setUploadingPhoto(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // ── Complete (mirrors DeliveryDetail.handleComplete) ────────────────────
  const requestComplete = () => {
    if (!signedBy.trim()) { toast('error', 'Enter who signed for the delivery'); return; }
    if (!hasAnyQty) { toast('error', 'At least one item must have a quantity above zero'); return; }
    void handleComplete();
  };

  const handleComplete = async () => {
    if (!delivery || !profile || !id) return;
    // Stale-route guard (H3): a fast stop-to-stop switch must never complete the
    // WRONG stop — the route id is fresh but component state could still lag.
    if (delivery.id !== id) { toast('error', 'This stop just changed — please retry'); return; }
    setCompleting(true);

    const quantitiesJson = isPartial
      ? Object.fromEntries(items.map((it) => [it.id, deliveryQtys[it.id] ?? it.quantity]))
      : null;
    const rpcParams = {
      p_delivery_id: id,
      p_signed_by: signedBy,
      p_performed_by: profile.id,
      p_idempotency_key: completeIdem.getKey(),
      ...(quantitiesJson ? { p_quantities: quantitiesJson } : {}),
    };

    // OFFLINE — only reachable for in_progress stops (Arrive is online-only).
    if (!isOnline) {
      try {
        const offlineRpcParams = { ...rpcParams, p_completed_at: new Date().toISOString() };
        await queueAction({
          operation: 'complete_delivery',
          params: offlineRpcParams,
          createdAt: new Date().toISOString(),
          retryCount: 0,
          ownerUserId: profile.id,
          status: 'pending',
          // The durable receipt compares this snapshot on the server. A changed
          // delivery becomes office review work without defeating lost-response
          // recovery for a receipt that already succeeded.
          entityTable: 'deliveries',
          entityId: id,
          snapshotAt: delivery.updated_at ?? undefined,
        });
        completeIdem.resetKey();
        toast('success', 'Delivery saved offline — it will retry when connected and remain saved if it needs attention');
        setStep('done');
      } catch (error) {
        toast('error', getOfflineStorageErrorMessage(error));
      }
      setCompleting(false);
      return;
    }

    try {
      const { data: result, error } = await supabase.rpc('complete_delivery', rpcParams);
      if (error) throw error;
      assertRpcResult(result, 'complete_delivery');
      completeIdem.resetKey();

      // Signature image upload (PII — stored as a path, signed URL on demand).
      if (signatureDataUrl) {
        try {
          const base64Data = signatureDataUrl.split(',')[1];
          const byteCharacters = atob(base64Data);
          const byteArray = new Uint8Array(byteCharacters.length);
          for (let i = 0; i < byteCharacters.length; i++) byteArray[i] = byteCharacters.charCodeAt(i);
          const blob = new Blob([byteArray], { type: 'image/png' });
          const filePath = `signatures/${id}.png`;
          const { error: uploadError } = await supabase.storage
            .from('delivery-signatures')
            .upload(filePath, blob, { upsert: true, contentType: 'image/png' });
          if (!uploadError) {
            const sigResult = await supabase.from('deliveries').update({ signature_url: filePath }).eq('id', id).select();
            checkMutationResult(sigResult, 'Update delivery signature');
          } else {
            // Supabase Storage reports failures via the RETURNED error (not a throw),
            // so surface it explicitly — otherwise the signature image is silently
            // lost after the delivery has already committed.
            Sentry.captureException(new Error(`Signature upload failed: ${uploadError.message}`), { extra: { context: 'Field Mode signature upload returned error' } });
            toast('error', 'Signature image could not be saved — the delivery is recorded; re-capture the signature if needed');
          }
        } catch (sigErr) {
          Sentry.captureException(sigErr instanceof Error ? sigErr : new Error(String(sigErr)), { extra: { context: 'Field Mode signature upload failed' } });
          // The delivery already committed; keep going (don't strand the receipt)
          // but surface the failed image capture so it isn't silently lost.
          toast('error', 'Signature image could not be saved — the delivery is recorded; re-capture the signature if needed');
        }
      }

      const autoInvoice = result as { auto_invoice?: { invoice_number?: string } } | null;
      const invoiceNum = autoInvoice?.auto_invoice?.invoice_number || null;
      if (invoiceNum) setAutoInvoiceNumber(invoiceNum);
      toast('success', invoiceNum
        ? `Delivery completed${isPartial ? ' (partial)' : ''}. Draft invoice ${invoiceNum} created.`
        : `Delivery completed${isPartial ? ' (partial)' : ''}`);

      logActivity({
        event: 'delivery_completed',
        description: `Delivery ${delivery.delivery_number} completed${isPartial ? ' (partial)' : ''}${invoiceNum ? ` — draft invoice ${invoiceNum}` : ''} via Field Mode`,
        performedBy: profile.id,
        entityType: 'delivery',
        entityId: delivery.id,
        customerId: delivery.customer_id,
      });

      if (isPartial) {
        const remainderItems = items
          .map((it) => ({ product: it.product?.product_name || 'Unknown', ordered: it.quantity, delivered: deliveryQtys[it.id] ?? it.quantity }))
          .filter((r) => r.delivered < r.ordered);
        if (remainderItems.length > 0) {
          await notifyDeliveryRemainder(delivery.id, delivery.delivery_number || '', delivery.order_id || '', remainderItems, delivery.created_by || '');
        }
      }

      await notifyDeliveryCompleted(delivery.id, delivery.delivery_number || '', delivery.customer?.farm_name || 'Unknown', delivery.assigned_driver, delivery.order_id, isPartial);

      if (emailOnComplete && delivery.customer?.email) {
        const emailItems = items
          .map((it) => ({ name: it.product?.product_name || 'Product', qty: isPartial ? (deliveryQtys[it.id] ?? it.quantity) : it.quantity }))
          .filter((r) => r.qty > 0);
        await sendDeliveryCompletionEmail({
          customerEmail: delivery.customer.email,
          contactName: delivery.customer.contact_name,
          deliveryNumber: delivery.delivery_number || '',
          deliveryId: delivery.id,
          customerId: delivery.customer_id,
          items: emailItems,
          isPartial,
          signedBy,
          photos: photos.map((p) => ({ image_url: p.image_url, caption: p.caption })),
        });
      }

      setStep('done');
    } catch (error: unknown) {
      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'complete_delivery' } });
      toast('error', sanitizeError(error));
    }
    setCompleting(false);
  };

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="h-8 w-32 bg-gray-100 rounded animate-pulse mb-4" />
        <div className="h-40 bg-gray-100 rounded-xl animate-pulse" />
      </div>
    );
  }
  if (!delivery) return null;

  const farmName = delivery.customer?.farm_name || 'Unknown customer';
  const shortCount = items.filter((it) => (deliveryQtys[it.id] ?? it.quantity) < it.quantity).length;

  return (
    <div className="max-w-2xl mx-auto px-4 py-4">
      <button
        type="button"
        onClick={() => navigate('/my-route')}
        className="flex items-center gap-1 text-sm text-gray-500 mb-3 hover:text-gray-700"
      >
        <ArrowLeft className="w-4 h-4" /> My Route
      </button>

      <h1 className="text-lg font-bold text-gray-900">{farmName}</h1>
      {delivery.delivery_number && <p className="text-xs text-gray-500 mb-3">{delivery.delivery_number}</p>}

      {/* Step progress */}
      <div className="flex gap-1 mb-4">
        {STEP_ORDER.map((s, i) => {
          const active = STEP_ORDER.indexOf(step) >= i;
          return <span key={s} className={`flex-1 h-1.5 rounded-full ${active ? 'bg-crx-green' : 'bg-gray-200'}`} />;
        })}
      </div>

      {step === 'arrive' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          {addressLine && (
            <p className="flex items-start gap-2 text-sm text-gray-700 mb-3">
              <MapPin className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" /> {addressLine}
            </p>
          )}
          {delivery.delivery_notes && (
            <div className="bg-amber-50 text-amber-900 text-sm rounded-lg px-3 py-2 mb-4">{delivery.delivery_notes}</div>
          )}
          {!isOnline && (
            <p className="flex items-center gap-2 text-sm text-amber-700 mb-3">
              <WifiOff className="w-4 h-4" /> You're offline — connect to start this stop.
            </p>
          )}
          <button
            type="button"
            onClick={handleArrive}
            disabled={confirming || !isOnline}
            className="w-full flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-4 text-lg active:scale-[0.99] disabled:opacity-50"
          >
            <PlayCircle className="w-6 h-6" />
            {confirming ? 'Starting…' : "I'm Here — Start Delivery"}
          </button>
        </div>
      )}

      {step === 'verify' && (
        <div>
          <p className="text-xs text-gray-500 mb-2">Confirm what's being delivered</p>
          <ul className="space-y-2">
            {items.map((it) => {
              const delivered = deliveryQtys[it.id] ?? it.quantity;
              const short = delivered < it.quantity;
              return (
                <li key={it.id} className="bg-white border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">{it.product?.product_name || 'Product'}</p>
                      <p className="text-xs text-gray-500">Ordered {it.quantity}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" aria-label="Decrease quantity" onClick={() => updateQty(it.id, delivered - 1, it.quantity)} className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center active:scale-95"><Minus className="w-4 h-4" /></button>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min={0}
                        max={it.quantity}
                        value={delivered}
                        onChange={(e) => updateQty(it.id, parseFloat(e.target.value) || 0, it.quantity)}
                        aria-label={`Delivered quantity for ${it.product?.product_name || 'item'}`}
                        className="w-16 text-center font-semibold tabular-nums border border-gray-300 rounded-lg py-1.5"
                      />
                      <button type="button" aria-label="Increase quantity" onClick={() => updateQty(it.id, delivered + 1, it.quantity)} className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center active:scale-95"><Plus className="w-4 h-4" /></button>
                    </div>
                  </div>
                  {short && (
                    <span className="inline-flex items-center gap-1 mt-2 text-xs bg-amber-50 text-amber-800 px-2 py-0.5 rounded-md">
                      <AlertTriangle className="w-3 h-3" /> {it.quantity - delivered} short → remainder
                    </span>
                  )}
                </li>
              );
            })}
            {items.length === 0 && (
              <li className="text-sm text-center py-6">
                {itemsError
                  ? <span className="text-amber-700">Could not load items — refresh before completing.</span>
                  : <span className="text-gray-500">No items on this delivery.</span>}
              </li>
            )}
          </ul>
          <button type="button" disabled={!hasAnyQty} onClick={() => setStep('sign')} className="w-full mt-4 flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-4 text-lg active:scale-[0.99] disabled:opacity-50">
            {isPartial ? 'Continue with Partial' : 'All Full — Continue'}
            <ChevronRight className="w-5 h-5" />
          </button>
          {!hasAnyQty && <p className="text-xs text-amber-700 mt-2 text-center">At least one item needs a quantity above zero.</p>}
        </div>
      )}

      {step === 'sign' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
            <input
              type="checkbox"
              checked={noOnePresent}
              onChange={(e) => {
                const checked = e.target.checked;
                setNoOnePresent(checked);
                setSignedBy(checked ? 'No one present — left at site' : '');
                if (checked) setSignatureDataUrl(null);
              }}
              className="w-4 h-4"
            />
            No one present — left at site
          </label>
          <label htmlFor="signed-by" className="block text-sm font-medium text-gray-700 mb-1">Signed by (name)</label>
          <input
            id="signed-by"
            type="text"
            value={signedBy}
            onChange={(e) => setSignedBy(e.target.value)}
            placeholder="Who received the delivery?"
            disabled={noOnePresent}
            className={`w-full border border-gray-300 rounded-lg px-3 py-2 mb-4 ${noOnePresent ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`}
            autoComplete="off"
          />
          <div className={noOnePresent ? 'pointer-events-none opacity-50' : ''} aria-disabled={noOnePresent}>
            <SignatureCanvas key={noOnePresent ? 'signature-skipped' : 'signature-capture'} onSignatureChange={setSignatureDataUrl} label="Customer signs with their finger" height={160} disabled={noOnePresent} />
          </div>
          {noOnePresent && <p className="text-xs text-gray-500 mt-2">Signature skipped because no one was present.</p>}
          <button type="button" disabled={!signedBy.trim()} onClick={() => setStep('review')} className="w-full mt-4 flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-4 text-lg active:scale-[0.99] disabled:opacity-50">
            <PenLine className="w-5 h-5" /> Continue to Review
          </button>
          {!signedBy.trim() && <p className="text-xs text-amber-700 mt-2 text-center">Enter who signed or choose no one present to continue.</p>}
        </div>
      )}

      {step === 'review' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <section className="mb-4">
            <h2 className="text-sm font-medium text-gray-700 mb-2">Add photo (optional)</h2>
            <input ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple onChange={handlePhotoUpload} className="hidden" />
            {photos.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {photos.map((p) => (
                  <img key={p.id} src={p.image_url} alt={p.caption || 'Delivery photo'} className="w-20 h-20 object-cover rounded-lg border border-gray-200" />
                ))}
              </div>
            )}
            {isOnline ? (
              <button type="button" disabled={uploadingPhoto || photos.length >= 10} onClick={() => fileInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 border border-gray-300 text-gray-700 font-medium rounded-xl py-3 active:scale-[0.99] disabled:opacity-50">
                <Camera className="w-5 h-5" /> {uploadingPhoto ? 'Uploading…' : 'Take Photo'}
              </button>
            ) : (
              <p className="flex items-center gap-2 text-sm text-amber-700"><WifiOff className="w-4 h-4" /> Photos can only be uploaded while online — reconnect to add photos.</p>
            )}
          </section>
          <dl className="text-sm space-y-1.5 mb-4">
            <div className="flex justify-between"><dt className="text-gray-500">Delivery</dt><dd className="font-medium">{isPartial ? `Partial — ${shortCount} short` : 'Full delivery'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Signed by</dt><dd className="font-medium">{signedBy || '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Photos</dt><dd className="font-medium">{photos.length}</dd></div>
          </dl>

          {delivery.customer?.email && (
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
              <input type="checkbox" checked={emailOnComplete} onChange={(e) => setEmailOnComplete(e.target.checked)} className="w-4 h-4" />
              Email a receipt to the customer
            </label>
          )}

          {!isOnline && (
            <div className="bg-amber-50 text-amber-800 text-xs rounded-lg px-3 py-2 mb-4">
              You're offline — the delivery saves now and the completion syncs when you reconnect. The signature image, photos, customer receipt, and notifications are <strong>not sent for an offline completion</strong>. Complete online if the customer needs a receipt.
            </div>
          )}

          <p className="text-sm text-gray-600 mb-3">Inventory will be deducted and a draft invoice created.</p>

          <button type="button" disabled={completing} onClick={requestComplete} className="w-full flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-4 text-lg active:scale-[0.99] disabled:opacity-50">
            <ClipboardCheck className="w-6 h-6" /> Complete Delivery
          </button>
        </div>
      )}

      {step === 'done' && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 text-center">
          <CheckCircle2 className="w-14 h-14 text-green-600 mx-auto mb-3" />
          <p className="text-lg font-semibold text-gray-900">{isOnline ? 'Delivery complete' : 'Saved offline — sync pending'}</p>
          <p className="text-sm text-gray-500 mt-1">Signed by {signedBy}</p>
          {autoInvoiceNumber && (
            <p className="inline-flex items-center gap-1 text-sm text-gray-700 mt-3">
              <FileText className="w-4 h-4 text-gray-400" /> Draft invoice {autoInvoiceNumber} created
            </p>
          )}
          <button type="button" onClick={() => navigate('/my-route')} className="w-full mt-5 flex items-center justify-center gap-2 border border-crx-green text-crx-green font-semibold rounded-xl py-3 active:scale-[0.99]">
            Next Stop <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      )}

    </div>
  );
}
