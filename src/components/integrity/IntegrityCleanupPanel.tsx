import { useEffect, useState, useCallback, useRef } from 'react';
import { ShieldAlert, RefreshCw, AlertTriangle, FileText, Wrench, PackageCheck, Activity } from 'lucide-react';
import { supabase, supabaseUntyped, assertRpcResult, checkMutationResult, sanitizeError } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { Sentry } from '../../lib/sentry';
import { activeInvoiceCoversDelivery, fetchActiveInvoiceCoveragePages } from '../../lib/deliveryInvoiceCoverage';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { fetchSplitBillingOrderIds, SPLIT_BILLING_BLOCK_REASON } from '../../lib/deliverySplitBilling';

interface NegativeInvRow {
  id: string;
  product_id: string;
  product_name: string;
  location: string | null;
  quantity_available: number;
  quantity_prebooked: number;
  quantity_on_order: number;
}

interface OverReceivedRow {
  id: string;
  po_number: string;
  product_name: string;
  quantity_ordered: number;
  quantity_received: number;
  over_amount: number;
}

interface UnbilledDeliveryRow {
  id: string;
  delivery_number: string;
  order_id: string;
  customer_name: string;
  completed_at: string | null;
  item_count: number;
}

interface ManufacturedRow {
  id: string;
  product_id: string;
  product_name: string;
  location: string | null;
  quantity_available: number;
  updated_at: string;
}

type SentinelAlertType =
  | 'negative_inventory'
  | 'negative_invoice_balance'
  | 'stale_quote_hold'
  | 'booking_overdraw';

interface IntegrityAlertRow {
  id: string;
  alert_type: SentinelAlertType;
  entity_table: string;
  entity_id: string;
  details: Record<string, unknown> | null;
  detected_at: string;
}

function shortId(v: unknown): string {
  return String(v ?? '').slice(0, 8);
}

// Turn a raw sentinel alert (type + jsonb details) into a plain-English row for
// the admin. The sweep only records IDs + a small details blob, so we format
// per type; unknown values are coerced to strings (details is jsonb → unknown).
function describeAlert(a: IntegrityAlertRow): { title: string; detail: string } {
  const d = (a.details || {}) as Record<string, unknown>;
  const g = (k: string) => (d[k] === undefined || d[k] === null ? '?' : String(d[k]));
  switch (a.alert_type) {
    case 'negative_inventory':
      return {
        title: 'Negative inventory',
        detail: `Net on-hand: ${g('net_quantity_available')} (product ${shortId(a.entity_id)})`,
      };
    case 'negative_invoice_balance': {
      const cents = typeof d.balance_cents === 'number' ? d.balance_cents : null;
      const bal = cents != null ? `$${(cents / 100).toFixed(2)}` : g('balance_cents');
      return {
        title: 'Negative invoice balance',
        detail: `Invoice ${g('invoice_number')} — balance ${bal} (${g('status')})`,
      };
    }
    case 'stale_quote_hold':
      return {
        title: 'Stuck inventory hold',
        detail: `Quote ${shortId(d.quote_id)} is ${g('quote_status')} but a hold of ${g('quantity')} is still active`,
      };
    case 'booking_overdraw':
      return {
        title: 'Booking overdrawn',
        detail: `Drew ${g('quantity_drawn')} vs booked ${g('booking_cap')} (quote ${shortId(d.quote_id)})`,
      };
    default:
      return { title: String(a.alert_type), detail: '' };
  }
}

export default function IntegrityCleanupPanel() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const reconcileIdem = useIdempotencyKey('reconcile_negative_inventory', profile?.id || '');

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [negatives, setNegatives] = useState<NegativeInvRow[]>([]);
  const [overReceived, setOverReceived] = useState<OverReceivedRow[]>([]);
  const [unbilled, setUnbilled] = useState<UnbilledDeliveryRow[]>([]);
  // H5: order ids the server's ORDER_NEEDS_SPLIT_BILLING guard would refuse.
  // Empty means "none known to be blocked" — see the fail-open note in
  // fetchSplitBillingOrderIds.
  const [splitBillingOrderIds, setSplitBillingOrderIds] = useState<Set<string>>(new Set());
  const [invoiceCoverageFailed, setInvoiceCoverageFailed] = useState(false);
  const [manufactured, setManufactured] = useState<ManufacturedRow[]>([]);
  const [alerts, setAlerts] = useState<IntegrityAlertRow[]>([]);
  const [resolveBusy, setResolveBusy] = useState<Record<string, boolean>>({});

  // Per-row reconcile inputs
  const [reconcileInputs, setReconcileInputs] = useState<Record<string, { qty: string; reason: string; busy: boolean }>>({});
  const [backfillBusy, setBackfillBusy] = useState<Record<string, boolean>>({});
  const [verifyBusy, setVerifyBusy] = useState<Record<string, boolean>>({});
  const [verifyConfirmId, setVerifyConfirmId] = useState<string | null>(null);
  const reconcileInFlightRef = useRef(new Set<string>());

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    setInvoiceCoverageFailed(false);
    try {
      // F3 fix: Promise.allSettled instead of Promise.all so a single query
      // failure (e.g. the manufactured_at_delivery query erroring during the
      // window between code deploy and migration apply) doesn't drop the
      // three other sections' data.
      const [negSettled, overSettled, unbilledSettled, manufacturedSettled, alertsSettled] = await Promise.allSettled([
        supabase
          .from('inventory')
          .select('id, product_id, location, quantity_available, quantity_prebooked, quantity_on_order, product:products(product_name)')
          .or('quantity_available.lt.0,quantity_prebooked.lt.0,quantity_on_order.lt.0'),
        supabase
          .from('purchase_order_items')
          .select('id, product_name, quantity_ordered, quantity_received, purchase_order:purchase_orders(po_number)')
          .gt('quantity_received', 'quantity_ordered'),
        supabase
          .from('deliveries')
          .select('id, delivery_number, order_id, completed_at, customer:customers(farm_name), items:delivery_items(id)')
          .eq('status', 'completed')
          .not('order_id', 'is', null)
          .order('completed_at', { ascending: false }),
        supabase
          .from('inventory')
          .select('id, product_id, location, quantity_available, updated_at, product:products(product_name)')
          .eq('manufactured_at_delivery', true)
          .order('updated_at', { ascending: false }),
        // integrity_alerts is admin-only (RLS) and not yet in the generated types —
        // query via the untyped client; open alerts have resolved_at IS NULL.
        supabaseUntyped
          .from('integrity_alerts')
          .select('id, alert_type, entity_table, entity_id, details, detected_at')
          .is('resolved_at', null)
          .order('detected_at', { ascending: false }),
      ]);

      const negRes = negSettled.status === 'fulfilled' ? negSettled.value : { data: null, error: negSettled.reason };
      const overRes = overSettled.status === 'fulfilled' ? overSettled.value : { data: null, error: overSettled.reason };
      const unbilledRes = unbilledSettled.status === 'fulfilled' ? unbilledSettled.value : { data: null, error: unbilledSettled.reason };
      const manufacturedRes = manufacturedSettled.status === 'fulfilled' ? manufacturedSettled.value : { data: null, error: manufacturedSettled.reason };
      const alertsRes = alertsSettled.status === 'fulfilled' ? alertsSettled.value : { data: null, error: alertsSettled.reason };

      // Report any individual-section failures to Sentry so we can detect
      // deploy-ordering issues, but don't block the other sections from rendering.
      [
        ['negative inventory', negSettled],
        ['over-received POs', overSettled],
        ['unbilled deliveries', unbilledSettled],
        ['manufactured-at-delivery rows', manufacturedSettled],
        ['integrity alerts', alertsSettled],
      ].forEach(([label, settled]) => {
        if ((settled as PromiseSettledResult<unknown>).status === 'rejected') {
          const reason = (settled as PromiseRejectedResult).reason;
          Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)), {
            tags: { source: 'integrity_cleanup_query', section: label as string },
          });
        }
      });

      if (negRes.data) {
        const rows = negRes.data as unknown as Array<{
          id: string;
          product_id: string;
          location: string | null;
          quantity_available: number;
          quantity_prebooked: number;
          quantity_on_order: number;
          product?: { product_name: string } | { product_name: string }[] | null;
        }>;
        setNegatives(
          rows.map((r) => {
            const p = Array.isArray(r.product) ? r.product[0] : r.product;
            return {
              id: r.id,
              product_id: r.product_id,
              location: r.location,
              quantity_available: r.quantity_available,
              quantity_prebooked: r.quantity_prebooked,
              quantity_on_order: r.quantity_on_order,
              product_name: p?.product_name || 'Unknown',
            };
          }),
        );
      } else {
        // A normal Supabase failure arrives FULFILLED as { data: null, error },
        // so the rejected-only Sentry loop above skips it and `negRes.data` is
        // falsy — leaving the previously loaded negatives rendered as if they
        // were current. These rows are clickable and each click writes an
        // ABSOLUTE inventory quantity, so a stale one is not merely cosmetic.
        // Clear them, the same way the unbilled section already handles its own
        // fulfilled-with-error case below.
        if (negRes.error) Sentry.captureException(negRes.error);
        setNegatives([]);
      }

      if (overRes.data) {
        const rows = overRes.data as unknown as Array<{
          id: string;
          product_name: string;
          quantity_ordered: number;
          quantity_received: number;
          purchase_order?: { po_number: string } | { po_number: string }[] | null;
        }>;
        setOverReceived(
          rows.map((r) => {
            const po = Array.isArray(r.purchase_order) ? r.purchase_order[0] : r.purchase_order;
            return {
              id: r.id,
              po_number: po?.po_number || 'Unknown',
              product_name: r.product_name,
              quantity_ordered: r.quantity_ordered,
              quantity_received: r.quantity_received,
              over_amount: r.quantity_received - r.quantity_ordered,
            };
          }),
        );
      }

      if (manufacturedRes.data) {
        const rows = manufacturedRes.data as unknown as Array<{
          id: string;
          product_id: string;
          location: string | null;
          quantity_available: number;
          updated_at: string;
          product?: { product_name: string } | { product_name: string }[] | null;
        }>;
        setManufactured(
          rows.map((r) => {
            const p = Array.isArray(r.product) ? r.product[0] : r.product;
            return {
              id: r.id,
              product_id: r.product_id,
              location: r.location,
              quantity_available: r.quantity_available,
              updated_at: r.updated_at,
              product_name: p?.product_name || 'Unknown',
            };
          }),
        );
      }

      if (alertsRes.data) {
        setAlerts(alertsRes.data as unknown as IntegrityAlertRow[]);
      }

      // Filter unbilled deliveries client-side (the .not.exists pattern is awkward in PostgREST)
      if (unbilledRes.data) {
        const allCompleted = unbilledRes.data as unknown as Array<{
          id: string;
          delivery_number: string;
          order_id: string;
          completed_at: string | null;
          customer?: { farm_name: string } | { farm_name: string }[] | null;
          items?: Array<{ id: string }>;
        }>;
        const orderIds = allCompleted.map((d) => d.order_id);
        if (orderIds.length > 0) {
          // U2 #34: bill-tracking is per-DELIVERY, not per-order. A delivery is "billed"
          // only if an active non-credit invoice is tied to THIS delivery, or an order-level invoice
          // (delivery_id IS NULL) covers the whole order. An invoice tied to a DIFFERENT
          // delivery on the same order must NOT hide this delivery — mirrors the
          // complete_delivery auto-invoice guard.
          const { data: invoiceRows, error: invoiceCoverageError } = await fetchActiveInvoiceCoveragePages(orderIds);
          if (invoiceCoverageError) {
            Sentry.captureException(invoiceCoverageError);
            toast('error', 'Failed to verify invoice coverage. Unbilled delivery results are hidden; refresh to try again.');
            setInvoiceCoverageFailed(true);
            setUnbilled([]);
            setSplitBillingOrderIds(new Set());
          } else {
            const invRows = invoiceRows || [];
            const filtered = allCompleted.filter((d) => !invRows.some((invoice) =>
              activeInvoiceCoversDelivery(invoice, d.id, d.order_id)
            ));
            setUnbilled(
              filtered.map((d) => {
                const c = Array.isArray(d.customer) ? d.customer[0] : d.customer;
                return {
                  id: d.id,
                  delivery_number: d.delivery_number,
                  order_id: d.order_id,
                  customer_name: c?.farm_name || 'Unknown',
                  completed_at: d.completed_at,
                  item_count: d.items?.length || 0,
                };
              }),
            );

            // H5: which of the still-unbilled rows the server would refuse to
            // single-invoice. Only the surviving rows are queried — a row that
            // already has an invoice never renders a button.
            const { data: splitIds, error: splitError } = await fetchSplitBillingOrderIds(
              filtered.map((d) => d.order_id),
            );
            if (splitError) {
              // Fail OPEN: keep the buttons. The server still refuses, and the
              // refusal now reaches the operator intact (see handleBackfillInvoice).
              Sentry.captureException(splitError, {
                tags: { source: 'integrity_cleanup_query', section: 'split billing eligibility' },
              });
              setSplitBillingOrderIds(new Set());
            } else {
              setSplitBillingOrderIds(splitIds || new Set());
            }
          }
        } else {
          setUnbilled([]);
          setSplitBillingOrderIds(new Set());
        }
      } else {
        if (unbilledRes.error) Sentry.captureException(unbilledRes.error);
        setInvoiceCoverageFailed(true);
        setUnbilled([]);
        setSplitBillingOrderIds(new Set());
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      toast('error', 'Failed to load cleanup data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleReconcile = async (row: NegativeInvRow) => {
    if (!profile) return;
    const input = reconcileInputs[row.id];
    const newQuantity = parseFloat(input?.qty ?? '');
    // Number.isFinite, not isNaN: exponent notation such as 1e309 parses to
    // Infinity, which is neither NaN nor < 0, so an isNaN/negative pair alone
    // lets a non-finite quantity through to an inventory-reconciling RPC.
    if (!input?.qty || !Number.isFinite(newQuantity) || newQuantity < 0) {
      toast('error', 'Enter a non-negative quantity');
      return;
    }
    if (!input?.reason?.trim()) {
      toast('error', 'Reason is required');
      return;
    }
    // Bind retries to this row and its exact operator-entered correction. A
    // changed quantity or reason is new intent; a lost response is the same
    // intent and must replay safely.
    //
    // Scope on the PARSED quantity, not the raw input text: this RPC writes an
    // absolute inventory level, and "1.0", "1" and "1e0" all send the identical
    // p_new_quantity. Keying on the typed string would mint a fresh key for a
    // reformatted retry, bypass the saved receipt, and re-run the correction —
    // overwriting any legitimate stock movement that happened in between.
    const scope = `reconcile:${row.id}:${newQuantity}:${input.reason.trim()}`;
    if (reconcileInFlightRef.current.has(scope)) return;
    reconcileInFlightRef.current.add(scope);
    setReconcileInputs((prev) => ({ ...prev, [row.id]: { ...prev[row.id], busy: true } }));
    try {
      const { data, error } = await supabase.rpc('reconcile_negative_inventory', {
        p_inventory_id: row.id,
        p_new_quantity: newQuantity,
        p_reason: input.reason.trim(),
        p_performed_by: profile.id,
        p_idempotency_key: reconcileIdem.getKeyFor(scope),
      });
      if (error) throw error;
      assertRpcResult(data, 'reconcile_negative_inventory');
      reconcileIdem.resetKeyFor(scope);
      // Drop the reconciled row LOCALLY, before the refresh and independently of
      // whether it succeeds. The receipt was just retired one line above, so
      // until this row leaves the screen a second click mints a FRESH key and
      // re-applies an absolute `quantity_available`, overwriting any stock
      // movement since the first commit. Relying on `fetchAll()` to remove it
      // was the gap: a normal Supabase `{ error }` on the negatives query is a
      // FULFILLED promise, so `fetchAll` neither throws nor re-renders that
      // section, and the stale row stayed clickable with no signal at all.
      setNegatives((prev) => prev.filter((r) => r.id !== row.id));
      toast('success', `${row.product_name} reconciled to ${input.qty}`);
      // The mutation-success boundary ENDS here: the RPC is proven and its retry
      // receipt is already retired. The refresh below used to sit inside this
      // try, so a refresh rejection was reported as a FAILED reconciliation —
      // and a retry then minted a fresh key and re-applied an ABSOLUTE inventory
      // quantity, overwriting any legitimate stock movement in between. Refresh
      // failures now say only that the refresh failed.
      try {
        await fetchAll();
      } catch (refreshErr) {
        Sentry.captureException(refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr)));
        toast('error', 'Reconciled, but the list could not be refreshed. Reload to see current values.');
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      // Same non-throwing-Supabase shape as handleBackfillInvoice above.
      toast('error', sanitizeError(err));
    } finally {
      reconcileInFlightRef.current.delete(scope);
      setReconcileInputs((prev) => ({ ...prev, [row.id]: { ...prev[row.id], busy: false } }));
    }
  };

  const handleVerifyManufactured = async (rowId: string) => {
    if (!profile) return;
    setVerifyBusy((prev) => ({ ...prev, [rowId]: true }));
    try {
      // F2 fix: per-click UUID, not a hook-cached key (which would collide across rows)
      const idemKey = crypto.randomUUID();
      const { data, error } = await supabase.rpc('mark_inventory_row_verified', {
        p_inventory_id: rowId,
        p_performed_by: profile.id,
        // eslint-disable-next-line local-rules/idempotency-key-from-hook -- deliberate per-row key; see F2 comment above
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      // F4 fix: the RPC returns { cleared: false, reason: 'already_verified' }
      // when another admin already cleared the flag. The previous handler ignored
      // `data` and showed a green success toast unconditionally, misleading the
      // user into thinking their click had effect.
      const result = assertRpcResult<{ cleared: boolean; reason: string }>(
        data,
        'mark_inventory_row_verified',
      );
      if (result.cleared) {
        toast('success', 'Inventory row verified — flag cleared');
      } else {
        toast('info', `Already cleared (${result.reason})`);
      }
      await fetchAll();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      // Same non-throwing-Supabase shape as handleBackfillInvoice above.
      toast('error', sanitizeError(err));
    } finally {
      setVerifyBusy((prev) => ({ ...prev, [rowId]: false }));
      setVerifyConfirmId(null);
    }
  };

  const handleBackfillInvoice = async (row: UnbilledDeliveryRow) => {
    if (!profile) return;
    setBackfillBusy((prev) => ({ ...prev, [row.id]: true }));
    try {
      // F2 fix: per-click UUID, not a hook-cached key (which would collide across rows)
      const idemKey = crypto.randomUUID();
      const { data, error } = await supabase.rpc('create_invoice_for_unbilled_delivery', {
        p_delivery_id: row.id,
        p_performed_by: profile.id,
        // eslint-disable-next-line local-rules/idempotency-key-from-hook -- deliberate per-row key; see F2 comment above
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      assertRpcResult(data, 'create_invoice_for_unbilled_delivery');
      toast('success', `Draft invoice created for ${row.delivery_number}`);
      await fetchAll();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      // H5: a non-throwing `supabase.rpc()` resolves its error as a PLAIN OBJECT,
      // not an Error subclass (postgrest-js only constructs PostgrestError under
      // `.throwOnError()`). `err instanceof Error` was therefore false and every
      // server explanation — including the ORDER_NEEDS_SPLIT_BILLING sentence that
      // tells the admin to use the split-billing flow — was replaced by the literal
      // 'Backfill failed'. sanitizeError() handles object-shaped Postgrest errors
      // and is what DeliveryDetail already uses on this same RPC.
      toast('error', sanitizeError(err));
    } finally {
      setBackfillBusy((prev) => ({ ...prev, [row.id]: false }));
    }
  };

  const handleResolveAlert = async (alertId: string) => {
    setResolveBusy((prev) => ({ ...prev, [alertId]: true }));
    try {
      // Admin-only UPDATE gated by RLS (integrity_alerts_update_admin). Setting
      // resolved_at also re-arms the daily sweep for that entity — a NEW break of
      // the same kind will alarm again.
      const result = await supabaseUntyped
        .from('integrity_alerts')
        .update({ resolved_at: new Date().toISOString() })
        .eq('id', alertId)
        .select();
      checkMutationResult(result, 'Resolve integrity alert');
      toast('success', 'Alert marked resolved');
      await fetchAll();
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
      // checkMutationResult re-throws `result.error`, which is the same plain
      // PostgREST object shape as the non-throwing rpc() calls above.
      toast('error', sanitizeError(err));
    } finally {
      setResolveBusy((prev) => ({ ...prev, [alertId]: false }));
    }
  };

  if (loading) {
    return <div className="p-6 text-gray-600">Loading cleanup data…</div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Wrench className="w-7 h-7 text-amber-600" />
            <h1 className="text-2xl font-semibold text-gray-900">Integrity Cleanup</h1>
          </div>
          <p className="text-sm text-gray-600 mt-2 max-w-3xl">
            Surfaces production data in a state that shouldn't exist (negative inventory,
            over-received POs, completed deliveries without invoices) and provides per-row
            actions to resolve. Backed by audit-tracked RPCs — every action writes to the
            ledger / activity feed.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchAll}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Section 0: Data-integrity sentinel alerts (daily 06:45 UTC sweep) */}
      <section className="space-y-3">
        <header className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-crx-green" />
          <h2 className="text-lg font-semibold text-gray-900">Data-integrity alerts</h2>
          <span className="text-sm text-gray-500">({alerts.length} open)</span>
        </header>
        <p className="text-xs text-gray-500 ml-7 max-w-3xl">
          Found automatically by the daily sweep (runs 06:45 UTC): new negative inventory,
          negative invoice balances, inventory holds stuck on closed quotes, and over-drawn
          bookings. This is warn-only — nothing was changed automatically. Investigate the
          record, fix it if needed, then mark the alert resolved (a brand-new problem of the
          same kind will alert again).
        </p>
        {alerts.length === 0 ? (
          <p className="text-sm text-gray-500 ml-7">No open alerts. The daily sweep found nothing new.</p>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-amber-100 text-left text-amber-900">
                <tr>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Detail</th>
                  <th className="px-3 py-2 font-medium">Detected</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => {
                  const info = describeAlert(a);
                  return (
                    <tr key={a.id} className="border-t border-amber-200">
                      <td className="px-3 py-2 font-medium text-gray-900">{info.title}</td>
                      <td className="px-3 py-2 text-gray-700">{info.detail}</td>
                      <td className="px-3 py-2 text-gray-700">{new Date(a.detected_at).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <Button
                          variant="secondary"
                          onClick={() => handleResolveAlert(a.id)}
                          loading={resolveBusy[a.id]}
                        >
                          Mark resolved
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 1: Negative inventory */}
      <section className="space-y-3">
        <header className="flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-red-600" />
          <h2 className="text-lg font-semibold text-gray-900">Negative inventory</h2>
          <span className="text-sm text-gray-500">({negatives.length} rows)</span>
        </header>
        {negatives.length === 0 ? (
          <p className="text-sm text-gray-500 ml-7">No rows. Inventory bucket values are non-negative.</p>
        ) : (
          <div className="rounded-lg border border-red-200 bg-red-50 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-red-100 text-left text-red-900">
                <tr>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">Location</th>
                  <th className="px-3 py-2 font-medium text-right">On hand</th>
                  <th className="px-3 py-2 font-medium text-right">Prebooked</th>
                  <th className="px-3 py-2 font-medium">New on-hand</th>
                  <th className="px-3 py-2 font-medium">Reason</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {negatives.map((row) => {
                  const input = reconcileInputs[row.id] || { qty: '0', reason: '', busy: false };
                  return (
                    <tr key={row.id} className="border-t border-red-200">
                      <td className="px-3 py-2">{row.product_name}</td>
                      <td className="px-3 py-2 text-gray-700">{row.location || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono text-red-700">{row.quantity_available}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-700">{row.quantity_prebooked}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={input.qty}
                          onChange={(e) =>
                            setReconcileInputs((prev) => ({
                              ...prev,
                              [row.id]: { ...input, qty: e.target.value },
                            }))
                          }
                          className="w-24 rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          placeholder="e.g. counted on 2026-05-01, set to 0"
                          value={input.reason}
                          onChange={(e) =>
                            setReconcileInputs((prev) => ({
                              ...prev,
                              [row.id]: { ...input, reason: e.target.value },
                            }))
                          }
                          className="w-64 rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Button onClick={() => handleReconcile(row)} loading={input.busy}>
                          Reconcile
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 2: Over-received POs (informational only) */}
      <section className="space-y-3">
        <header className="flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 text-amber-600" />
          <h2 className="text-lg font-semibold text-gray-900">Over-received PO items</h2>
          <span className="text-sm text-gray-500">({overReceived.length} rows)</span>
        </header>
        <p className="text-xs text-gray-500 ml-7 max-w-3xl">
          These rows have <code>quantity_received &gt; quantity_ordered</code>. New
          over-receives are now blocked by default (Phase 21 — admin override required).
          The rows below are historical and informational. Review each to confirm whether
          the over-shipment was kept or returned to the vendor; no automated action is
          provided since the inventory side has already been recorded.
        </p>
        {overReceived.length === 0 ? (
          <p className="text-sm text-gray-500 ml-7">No rows. PO receiving totals match orders.</p>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-amber-100 text-left text-amber-900">
                <tr>
                  <th className="px-3 py-2 font-medium">PO #</th>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium text-right">Ordered</th>
                  <th className="px-3 py-2 font-medium text-right">Received</th>
                  <th className="px-3 py-2 font-medium text-right">Over by</th>
                </tr>
              </thead>
              <tbody>
                {overReceived.map((row) => (
                  <tr key={row.id} className="border-t border-amber-200">
                    <td className="px-3 py-2 font-mono text-xs">{row.po_number}</td>
                    <td className="px-3 py-2">{row.product_name}</td>
                    <td className="px-3 py-2 text-right font-mono">{row.quantity_ordered}</td>
                    <td className="px-3 py-2 text-right font-mono">{row.quantity_received}</td>
                    <td className="px-3 py-2 text-right font-mono text-amber-700 font-medium">+{row.over_amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 3: Unbilled deliveries */}
      <section className="space-y-3">
        <header className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-blue-600" />
          <h2 className="text-lg font-semibold text-gray-900">Completed deliveries without invoices</h2>
          <span className="text-sm text-gray-500">({unbilled.length} rows)</span>
        </header>
        <p className="text-xs text-gray-500 ml-7 max-w-3xl">
          Historical completions that pre-date Phase 15's auto-invoice restoration. Each
          row's button creates a draft invoice from the delivered quantities — same logic
          new completions use today.
        </p>
        {invoiceCoverageFailed ? (
          <p className="text-sm text-amber-700 ml-7">Could not verify invoice coverage — refresh to try again.</p>
        ) : unbilled.length === 0 ? (
          <p className="text-sm text-gray-500 ml-7">No unbilled completed deliveries.</p>
        ) : (
          <div className="rounded-lg border border-blue-200 bg-blue-50 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-blue-100 text-left text-blue-900">
                <tr>
                  <th className="px-3 py-2 font-medium">Delivery #</th>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Completed</th>
                  <th className="px-3 py-2 font-medium text-right">Items</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {unbilled.map((row) => (
                  <tr key={row.id} className="border-t border-blue-200">
                    <td className="px-3 py-2 font-mono text-xs">{row.delivery_number}</td>
                    <td className="px-3 py-2">{row.customer_name}</td>
                    <td className="px-3 py-2 text-gray-700">
                      {row.completed_at ? new Date(row.completed_at).toLocaleDateString() : '-'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{row.item_count}</td>
                    <td className="px-3 py-2">
                      {/* H5: the server's ORDER_NEEDS_SPLIT_BILLING guard would refuse
                          this row, so don't offer an action that cannot succeed. Shown
                          disabled rather than hidden so the operator can see WHY the
                          row is listed but not actionable here. */}
                      {splitBillingOrderIds.has(row.order_id) ? (
                        <div className="flex flex-col gap-1">
                          <Button disabled>Create draft invoice</Button>
                          <span className="text-xs text-amber-700 max-w-xs">
                            {SPLIT_BILLING_BLOCK_REASON}
                          </span>
                        </div>
                      ) : (
                        <Button
                          onClick={() => handleBackfillInvoice(row)}
                          loading={backfillBusy[row.id]}
                        >
                          Create draft invoice
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Section 4: Phantom inventory rows (manufactured at delivery) */}
      <section className="space-y-3">
        <header className="flex items-center gap-2">
          <PackageCheck className="w-5 h-5 text-purple-600" />
          <h2 className="text-lg font-semibold text-gray-900">Phantom inventory rows</h2>
          <span className="text-sm text-gray-500">({manufactured.length} rows)</span>
        </header>
        <p className="text-xs text-gray-500 ml-7 max-w-3xl">
          Rows where <code>manufactured_at_delivery = true</code> — created when a
          delivery completed for a product that had no prior inventory record (P4-7).
          Each one needs an admin to confirm physical stock exists, then click
          "Mark Verified" to clear the flag. The current Phase&nbsp;15 <code>complete_delivery</code>
          body raises rather than auto-creates, so this list should normally stay empty;
          rows here usually mean a regression or an older code path manufactured them.
        </p>
        {manufactured.length === 0 ? (
          <p className="text-sm text-gray-500 ml-7">No phantom rows. Inventory rows have a verified origin.</p>
        ) : (
          <div className="rounded-lg border border-purple-200 bg-purple-50 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-purple-100 text-left text-purple-900">
                <tr>
                  <th className="px-3 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 font-medium">Location</th>
                  <th className="px-3 py-2 font-medium text-right">On hand</th>
                  <th className="px-3 py-2 font-medium">Last updated</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {manufactured.map((row) => (
                  <tr key={row.id} className="border-t border-purple-200">
                    <td className="px-3 py-2">{row.product_name}</td>
                    <td className="px-3 py-2 text-gray-700">{row.location || '-'}</td>
                    <td className={`px-3 py-2 text-right font-mono ${row.quantity_available < 0 ? 'text-red-700' : 'text-gray-700'}`}>
                      {row.quantity_available}
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {new Date(row.updated_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        onClick={() => setVerifyConfirmId(row.id)}
                        loading={verifyBusy[row.id]}
                      >
                        Mark Verified
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmModal
        open={verifyConfirmId !== null}
        onClose={() => setVerifyConfirmId(null)}
        onConfirm={() => verifyConfirmId && handleVerifyManufactured(verifyConfirmId)}
        title="Mark inventory row verified"
        message="Confirm that you have physically verified stock for this product. The manufactured-at-delivery flag will be cleared and an entry will be written to the activity feed."
        confirmLabel="Mark Verified"
        variant="info"
      />
    </div>
  );
}
