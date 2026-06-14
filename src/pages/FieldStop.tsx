/**
 * Field Mode — per-stop runner ("/my-route/:id").
 *
 * The guided, one-thing-per-screen flow for a single delivery stop. ADDITIVE:
 * reuses the existing delivery RPCs/components; never edits DeliveryDetail.tsx.
 *
 * This slice: status-driven entry (scheduled → Arrive; in_progress → Verify),
 * the Arrive step (confirm_delivery; online-only for scheduled stops — we never
 * queue confirm_delivery offline), and the Verify-items step (full/short with a
 * clamped stepper, building the same p_quantities the desktop screen does).
 *
 * The Signature → Photo → Review/Complete steps (the money/offline/email path)
 * arrive in the next slice with their own adversarial review. Until then the
 * runner hands off to the desktop /deliveries/:id screen to finish, per
 * docs/roadmap/field-mode-build-plan.md.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, MapPin, PlayCircle, WifiOff, Minus, Plus, AlertTriangle, ChevronRight, ExternalLink,
} from 'lucide-react';
import { supabase, assertRpcResult, sanitizeError } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { Sentry } from '../lib/sentry';

interface StopItem {
  id: string;
  quantity: number;
  product_id: string | null;
  product: { product_name: string | null } | null;
}

interface StopDelivery {
  id: string;
  delivery_number: string | null;
  status: string;
  customer_id: string;
  delivery_address_id: string | null;
  delivery_notes: string | null;
  assigned_driver: string | null;
  customer: { farm_name: string | null } | null;
}

type Step = 'arrive' | 'verify' | 'handoff';

export default function FieldStop() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const isOnline = useOnlineStatus();
  const confirmIdem = useIdempotencyKey('confirm_delivery', profile?.id || '');

  const [delivery, setDelivery] = useState<StopDelivery | null>(null);
  const [items, setItems] = useState<StopItem[]>([]);
  const [deliveryQtys, setDeliveryQtys] = useState<Record<string, number>>({});
  const [addressLine, setAddressLine] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [step, setStep] = useState<Step>('arrive');

  const fetchStop = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('deliveries')
      .select('id, delivery_number, status, customer_id, delivery_address_id, delivery_notes, assigned_driver, customer:customers(farm_name)')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) {
      if (error) Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-stop' } });
      toast('error', 'Could not load this stop');
      navigate('/my-route');
      return;
    }

    const del = data as unknown as StopDelivery;
    setDelivery(del);
    // Status-driven entry: a scheduled stop starts at Arrive; an in_progress
    // stop resumes at Verify. Terminal states bounce back to the list.
    if (del.status === 'scheduled') setStep('arrive');
    else if (del.status === 'in_progress') setStep('verify');
    else {
      toast('info', `This stop is ${del.status} — opening full detail`);
      navigate(`/deliveries/${del.id}`);
      return;
    }

    const { data: itemData } = await supabase
      .from('delivery_items')
      .select('id, quantity, product_id, product:products(product_name)')
      .eq('delivery_id', id);
    const loaded = ((itemData || []) as unknown as StopItem[]);
    setItems(loaded);
    const initQtys: Record<string, number> = {};
    loaded.forEach((it) => { initQtys[it.id] = it.quantity; });
    setDeliveryQtys(initQtys);

    if (del.delivery_address_id) {
      const { data: addr } = await supabase
        .from('customer_addresses')
        .select('*')
        .eq('id', del.delivery_address_id)
        .maybeSingle();
      if (addr) {
        const a = addr as { street?: string; city?: string; state?: string; zip?: string };
        setAddressLine([a.street, a.city, a.state, a.zip].filter(Boolean).join(', '));
      }
    }
    setLoading(false);
  }, [id, navigate, toast]);

  useEffect(() => { fetchStop(); }, [fetchStop]);

  // ── Arrive (confirm_delivery: scheduled → in_progress) ──────────────────
  const handleArrive = async () => {
    if (!delivery || !profile || !id) return;
    // We never queue confirm_delivery offline — complete_delivery requires an
    // in_progress stop, and a queued confirm has no caller. Block offline arrive.
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
      setDelivery({ ...delivery, status: 'in_progress' });
      setStep('verify');
      toast('success', 'Delivery started');
    } catch (err: unknown) {
      // If the stop is already in_progress (stale screen), just advance.
      const msg = sanitizeError(err);
      if (/in_progress|already/i.test(msg)) {
        setStep('verify');
      } else {
        toast('error', msg);
      }
    }
    setConfirming(false);
  };

  const updateQty = (itemId: string, qty: number, max: number) => {
    setDeliveryQtys((prev) => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, max)) }));
  };

  const isPartial = items.some((it) => (deliveryQtys[it.id] ?? it.quantity) < it.quantity);
  const hasAnyQty = items.some((it) => (deliveryQtys[it.id] ?? it.quantity) > 0);

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
      {delivery.delivery_number && (
        <p className="text-xs text-gray-500 mb-3">{delivery.delivery_number}</p>
      )}

      {/* Step progress */}
      <div className="flex gap-1 mb-4">
        {(['arrive', 'verify', 'handoff'] as Step[]).map((s, i) => {
          const order: Step[] = ['arrive', 'verify', 'handoff'];
          const active = order.indexOf(step) >= i;
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
            <div className="bg-amber-50 text-amber-900 text-sm rounded-lg px-3 py-2 mb-4">
              {delivery.delivery_notes}
            </div>
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
                      <button
                        type="button"
                        aria-label="Decrease quantity"
                        onClick={() => updateQty(it.id, delivered - 1, it.quantity)}
                        className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center active:scale-95"
                      >
                        <Minus className="w-4 h-4" />
                      </button>
                      <span className="w-8 text-center font-semibold tabular-nums">{delivered}</span>
                      <button
                        type="button"
                        aria-label="Increase quantity"
                        onClick={() => updateQty(it.id, delivered + 1, it.quantity)}
                        className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center active:scale-95"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
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
              <li className="text-sm text-gray-500 text-center py-6">No items on this delivery.</li>
            )}
          </ul>

          <button
            type="button"
            disabled={!hasAnyQty}
            onClick={() => setStep('handoff')}
            className="w-full mt-4 flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-4 text-lg active:scale-[0.99] disabled:opacity-50"
          >
            {isPartial ? 'Continue with Partial' : 'All Full — Continue'}
            <ChevronRight className="w-5 h-5" />
          </button>
          {!hasAnyQty && (
            <p className="text-xs text-amber-700 mt-2 text-center">At least one item needs a quantity above zero.</p>
          )}
        </div>
      )}

      {step === 'handoff' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 text-center">
          <p className="text-sm text-gray-700 mb-1">Signature, photo &amp; completion are coming in the next update.</p>
          <p className="text-xs text-gray-500 mb-4">Finish this delivery on the full screen for now.</p>
          <button
            type="button"
            onClick={() => navigate(`/deliveries/${delivery.id}`)}
            className="w-full flex items-center justify-center gap-2 border border-crx-green text-crx-green font-semibold rounded-xl py-3 active:scale-[0.99]"
          >
            <ExternalLink className="w-5 h-5" /> Finish on full screen
          </button>
        </div>
      )}
    </div>
  );
}
