import { useCallback, useEffect, useRef, useState } from 'react';
import { Phone, RefreshCw } from 'lucide-react';
import { assertRpcResult, supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { formatCents } from '../../lib/money';
import { parseLocalDate } from '../../lib/dateUtils';
import { factValueToText } from '../../lib/factValue';
import { useToast } from '../ui/Toast';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';

// One row per (product, unit) — a product invoiced in two units arrives as two
// rows so a total never mixes units; `unit` is null when the invoice lines
// carry none (rendered bare).
interface TopProductByQuantity { product_id: string; product_name: string; total_quantity: number; unit: string | null; }
// Revenue-ranked top products. get_customer_prep_card does not carry this itself — it lives on
// the sibling get_customer_purchase_summary RPC ('top_products': product_name, total_qty,
// total_revenue_cents; no product_id) — fetched separately below and merged onto `prep`.
interface TopProductByRevenue { product_name: string; total_qty: number; total_revenue_cents: number; }
interface PrepCard { farm_name: string | null; contacts: { id: string; name: string | null; role: string | null; phone_display: string | null; phone_e164: string | null; preferred_contact_method: string | null }[]; balance_credit: { credit_limit_cents: number; prepay_balance_cents: number; open_ar_cents: number }; last_invoice: { date: string; total_cents: number } | null; last_interaction: { occurred_at: string; type: string; outcome: string | null; summary: string | null; contact_name: string | null } | null; open_follow_ups_count: number; open_workflow_counts: { quotes: number; orders: number; deliveries: number }; top_verified_facts: { category: string; fact_key: string; value_text: string | null; value_json: unknown }[]; acres_tier: { total_acres: number | null; corn_acres: number | null; soybean_acres: number | null; other_acres: number | null; assigned_tier: number | null };
  // Older cached RPC payloads (before these fields existed) won't have these keys at all — always
  // treat them as possibly undefined, not just an empty array.
  top_products?: TopProductByRevenue[];
  top_products_by_quantity?: TopProductByQuantity[];
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Failed to load call prep';
export default function CustomerPrepCard({ customerId }: { customerId: string }) { const { toast } = useToast(); const [prep, setPrep] = useState<PrepCard | null>(null); const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(false);
  // Route reuse (customers/:id → customers/:otherId) must never show one customer's balances or
  // contacts under another — the sequence counter discards out-of-order responses and ID changes
  // clear stale data before reloading.
  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(false);
    try {
      const { data, error } = await supabase.rpc('get_customer_prep_card', { p_customer_id: customerId });
      if (seq !== requestSeq.current) return;
      if (error) throw error;
      const prepCard = assertRpcResult<PrepCard>(data, 'get_customer_prep_card');
      // Top-by-revenue lives on the sibling purchase-summary RPC, not the prep
      // card payload — fetch it separately and fail SOFT: a hiccup here must
      // not blank the rest of the (already-loaded) prep card, so it's caught
      // and reported without rethrowing.
      let topProducts: TopProductByRevenue[] | undefined;
      try {
        const { data: summaryData, error: summaryError } = await supabase.rpc('get_customer_purchase_summary', { p_customer_id: customerId });
        if (summaryError) throw summaryError;
        topProducts = assertRpcResult<{ top_products?: TopProductByRevenue[] }>(summaryData, 'get_customer_purchase_summary').top_products;
      } catch (summaryErr: unknown) {
        Sentry.captureException(summaryErr instanceof Error ? summaryErr : new Error(String(summaryErr)), { extra: { context: 'CustomerPrepCard.loadTopProductsByRevenue' } });
      }
      if (seq !== requestSeq.current) return;
      setPrep({ ...prepCard, top_products: topProducts });
    } catch (error: unknown) {
      if (seq !== requestSeq.current) return;
      setPrep(null);
      setLoadError(true);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'CustomerPrepCard.load' } });
      toast('error', errorMessage(error));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [customerId, toast]);
  useEffect(() => { setPrep(null); void load(); }, [load]);
  if (loading) return <Card><div className="h-32 animate-pulse rounded-lg bg-gray-100" /></Card>;
  if (!prep) return <Card><div className="flex items-center justify-between gap-3"><CardHeader title="Call" accent="Prep" /><Button variant="secondary" size="sm" className="min-h-11" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} onClick={() => void load()}>Try again</Button></div><p className="mt-2 text-sm text-secondary">{loadError ? "Couldn't load call prep." : 'No call prep available.'}</p></Card>;
  const primary = prep.contacts[0]; const counts = prep.open_workflow_counts || { quotes: 0, orders: 0, deliveries: 0 };
  return <Card><div className="flex items-start justify-between gap-3"><CardHeader title="Call" accent="Prep" /><Button variant="ghost" size="sm" className="min-h-11" icon={<RefreshCw className="h-4 w-4" />} showChevron={false} onClick={() => void load()}>Refresh</Button></div><div className="mt-3 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3"><div><p className="font-medium text-nav-dark">{prep.farm_name || 'Customer'}</p>{primary ? <><p className="mt-1 text-secondary">{primary.name || 'Primary contact'}{primary.role ? ` · ${primary.role}` : ''}</p>{primary.phone_display && <a className="mt-1 inline-flex min-h-11 items-center text-crx-green hover:underline" href={`tel:${primary.phone_e164 || primary.phone_display}`}><Phone className="mr-1 h-4 w-4" />{primary.phone_display}</a>}</> : <p className="mt-1 text-secondary">No primary contact</p>}</div><div className="flex flex-wrap content-start gap-2"><Badge variant={prep.balance_credit.open_ar_cents > 0 ? 'warning' : 'success'}>AR {formatCents(prep.balance_credit.open_ar_cents || 0)}</Badge><Badge variant="info">Credit {formatCents(prep.balance_credit.credit_limit_cents || 0)}</Badge><Badge variant="success">Prepay {formatCents(prep.balance_credit.prepay_balance_cents || 0)}</Badge><Badge variant="default">Tier {prep.acres_tier.assigned_tier ?? '—'}</Badge>{prep.acres_tier.total_acres !== null && <Badge variant="default">{prep.acres_tier.total_acres} acres</Badge>}</div><div><p className="text-secondary">Last invoice</p><p className="font-medium text-nav-dark">{prep.last_invoice ? `${parseLocalDate(prep.last_invoice.date).toLocaleDateString()} · ${formatCents(prep.last_invoice.total_cents)}` : 'No invoices yet'}</p><p className="mt-2 text-secondary">Last conversation</p><p className="font-medium text-nav-dark">{prep.last_interaction ? `${prep.last_interaction.type} · ${new Date(prep.last_interaction.occurred_at).toLocaleDateString()}` : 'No interactions yet'}</p></div></div><div className="mt-4 flex flex-wrap gap-2"><Badge variant="default">{counts.quotes} open quotes</Badge><Badge variant="default">{counts.orders} open orders</Badge><Badge variant="default">{counts.deliveries} open deliveries</Badge><Badge variant={prep.open_follow_ups_count ? 'warning' : 'default'}>{prep.open_follow_ups_count} follow-ups</Badge></div>{prep.top_verified_facts.length > 0 && <div className="mt-4 border-t border-gray-100 pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-secondary">Know before you call</p><ul className="mt-2 space-y-1 text-sm text-nav-dark">{prep.top_verified_facts.map((fact) => <li key={`${fact.category}-${fact.fact_key}`}><span className="font-medium">{fact.fact_key.replace(/_/g, ' ')}:</span> {factValueToText(fact.value_text, fact.value_json)}</li>)}</ul></div>}{((prep.top_products?.length || 0) > 0 || (prep.top_products_by_quantity?.length || 0) > 0) && <div className="mt-4 border-t border-gray-100 pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-secondary">Top products</p><div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">{(prep.top_products?.length || 0) > 0 && <div><p className="text-xs font-medium text-secondary">Top by revenue</p><ul className="mt-1 space-y-1 text-sm text-nav-dark">{prep.top_products!.map((product) => <li key={product.product_name}>{product.product_name} — {formatCents(product.total_revenue_cents)}</li>)}</ul></div>}{(prep.top_products_by_quantity?.length || 0) > 0 && <div><p className="text-xs font-medium text-secondary">Top by volume</p><ul className="mt-1 space-y-1 text-sm text-nav-dark">{prep.top_products_by_quantity!.map((product) => <li key={`${product.product_id}-${product.unit ?? ''}`}>{product.product_name} — {product.total_quantity.toLocaleString()}{product.unit ? ` ${product.unit}` : ''}</li>)}</ul></div>}</div></div>}</Card>; }
