import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Phone, MapPin, CheckCircle2, Package, Download, WifiOff, Minus, Plus } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import SignatureCanvas from '../components/ui/SignatureCanvas';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import { downloadDeliveryPdf } from '../lib/deliveryPdf';
import { logActivity } from '../lib/activityLogger';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { queueAction } from '../lib/offlineQueue';
import type { Delivery, DeliveryItem, Customer, CustomerAddress, Profile } from '../types';

export default function DeliveryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [address, setAddress] = useState<CustomerAddress | null>(null);
  const [driver, setDriver] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedBy, setSignedBy] = useState('');
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [deliveryQtys, setDeliveryQtys] = useState<Record<string, number>>({});
  const isOnline = useOnlineStatus();

  const isDriver = role === 'driver';

  useEffect(() => {
    if (id) fetchDelivery();
  }, [id]);

  const fetchDelivery = async () => {
    const { data: delData } = await supabase
      .from('deliveries')
      .select('*')
      .eq('id', id!)
      .maybeSingle();

    if (delData) {
      const del = delData as Delivery;
      setDelivery(del);

      const [custRes, itemsRes, addrRes, driverRes] = await Promise.all([
        supabase.from('customers').select('*').eq('id', del.customer_id).maybeSingle(),
        supabase.from('delivery_items').select('*, product:products(product_name)').eq('delivery_id', id!),
        del.delivery_address_id
          ? supabase.from('customer_addresses').select('*').eq('id', del.delivery_address_id).maybeSingle()
          : Promise.resolve({ data: null }),
        del.assigned_driver
          ? supabase.from('profiles').select('*').eq('id', del.assigned_driver).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      setCustomer(custRes.data as Customer | null);
      const loadedItems = (itemsRes.data || []) as DeliveryItem[];
      setItems(loadedItems);
      // Initialize delivery quantities to planned quantity for each item
      const initQtys: Record<string, number> = {};
      loadedItems.forEach((item) => { initQtys[item.id] = item.quantity; });
      setDeliveryQtys(initQtys);
      setAddress(addrRes.data as CustomerAddress | null);
      setDriver(driverRes.data as Profile | null);
    }
    setLoading(false);
  };

  const updateDeliveryQty = (itemId: string, qty: number, max: number) => {
    setDeliveryQtys((prev) => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, max)) }));
  };

  const isPartialDelivery = items.some((item) => (deliveryQtys[item.id] ?? item.quantity) < item.quantity);
  const hasAnyQty = items.some((item) => (deliveryQtys[item.id] ?? item.quantity) > 0);

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

    // Build quantities JSON — only include if any item is partial
    const quantitiesJson = isPartialDelivery
      ? Object.fromEntries(items.map((item) => [item.id, deliveryQtys[item.id] ?? item.quantity]))
      : null;

    const rpcParams: Record<string, unknown> = {
      p_delivery_id: id!,
      p_signed_by: signedBy,
      p_performed_by: profile.id,
      ...(quantitiesJson ? { p_quantities: quantitiesJson } : {}),
    };

    // If offline, queue the action for later sync
    if (!isOnline) {
      try {
        await queueAction({
          operation: 'complete_delivery',
          params: rpcParams,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        });
        toast('success', 'Delivery saved offline — will sync when you reconnect');
      } catch (err) {
        toast('error', 'Failed to save offline. Please try again.');
      }
      setCompleting(false);
      return;
    }

    try {
      // Atomic RPC: delivery status + order_items + inventory + audit trail in one transaction
      const { error } = await supabase.rpc('complete_delivery', rpcParams);

      if (error) throw error;

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
            const { data: urlData } = supabase.storage
              .from('delivery-signatures')
              .getPublicUrl(filePath);
            await supabase
              .from('deliveries')
              .update({ signature_url: urlData.publicUrl })
              .eq('id', id!);
          }
        } catch (sigErr) {
          // Non-blocking — delivery is already completed, just log
          console.warn('Signature upload failed:', sigErr);
        }
      }

      toast('success', isPartialDelivery ? 'Delivery completed (partial quantities)' : 'Delivery completed');
      logActivity('delivery_completed', `Delivery ${delivery.delivery_number} completed${isPartialDelivery ? ' (partial)' : ''}`, profile.id, 'delivery', delivery.id, delivery.customer_id);
      fetchDelivery();
    } catch (error: any) {
      console.error('Error completing delivery:', error);
      toast('error', error.message || 'Failed to complete delivery');
    }
    setCompleting(false);
  };

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
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-white font-heading">
                {delivery.delivery_number}
              </h2>
              <Badge variant={statusToBadgeVariant[delivery.status] || 'default'} size="md">
                {delivery.status.replace('_', ' ')}
              </Badge>
            </div>
            <p className="text-lg text-white font-medium">{customer?.farm_name}</p>
            <p className="text-sm text-gray-400 mt-1">
              {new Date(delivery.scheduled_date).toLocaleDateString()}
              {delivery.scheduled_time && ` at ${delivery.scheduled_time}`}
            </p>
          </div>

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
                          onChange={(e) => updateDeliveryQty(item.id, parseInt(e.target.value) || 0, item.quantity)}
                          className="w-16 text-center px-1 py-1.5 text-sm text-white bg-gray-700 border border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green"
                          min="0"
                          max={item.quantity}
                          aria-label={`Quantity to deliver for ${(item.product as unknown as { product_name: string })?.product_name || 'item'}`}
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

          {delivery.status !== 'completed' && delivery.status !== 'cancelled' && (
            <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 space-y-4">
              <h3 className="text-white font-semibold">Complete Delivery</h3>
              <div>
                <label className="block text-sm font-medium text-gray-400 mb-1">
                  Signed By
                </label>
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
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => navigate('/deliveries')}
        className="flex items-center gap-2 text-sm text-secondary hover:text-nav-dark transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Deliveries
      </button>

      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold font-heading text-nav-dark">
              {delivery.delivery_number}
            </h2>
            <p className="text-sm text-secondary mt-1">{customer?.farm_name}</p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-4 h-4" />}
              showChevron={false}
              onClick={async () =>
                downloadDeliveryPdf({
                  delivery_number: delivery.delivery_number,
                  order_number: (delivery as any).order_number || delivery.order_id || '-',
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
                    product_name: (i as any).product_name,
                    quantity: i.quantity,
                    unit_size: i.unit_size || '-',
                  })),
                })
              }
            >
              Receipt PDF
            </Button>
            <Badge variant={statusToBadgeVariant[delivery.status] || 'default'} size="md">
              {delivery.status.replace('_', ' ')}
            </Badge>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
          <div>
            <p className="text-xs text-secondary">Scheduled</p>
            <p className="text-sm font-medium text-nav-dark">
              {new Date(delivery.scheduled_date).toLocaleDateString()}
            </p>
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
        </div>
      </Card>

      {/* Signature display for completed deliveries */}
      {delivery.status === 'completed' && delivery.signature_url && (
        <Card>
          <h3 className="text-lg font-semibold font-heading text-nav-dark mb-3">Signature</h3>
          <div className="flex items-start gap-4">
            <img
              src={delivery.signature_url}
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

      <Card>
        <h3 className="text-lg font-semibold font-heading text-nav-dark mb-4">Products</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="px-4 py-3 text-left font-medium text-secondary">Product</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Planned Qty</th>
                {delivery.status === 'completed' && (
                  <th className="px-4 py-3 text-left font-medium text-secondary">Delivered</th>
                )}
                <th className="px-4 py-3 text-left font-medium text-secondary">Unit Size</th>
                <th className="px-4 py-3 text-left font-medium text-secondary">Notes</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-gray-50">
                  <td className="px-4 py-3 font-medium text-nav-dark">
                    {(item.product as unknown as { product_name: string })?.product_name || 'Unknown'}
                  </td>
                  <td className="px-4 py-3">{item.quantity}</td>
                  {delivery.status === 'completed' && (
                    <td className="px-4 py-3">
                      <span className={item.quantity_delivered < item.quantity ? 'text-amber-600 font-medium' : ''}>
                        {item.quantity_delivered}
                      </span>
                      {item.quantity_delivered < item.quantity && (
                        <span className="text-xs text-amber-500 ml-1">(partial)</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3">{item.unit_size || '-'}</td>
                  <td className="px-4 py-3 text-secondary">{item.notes || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
