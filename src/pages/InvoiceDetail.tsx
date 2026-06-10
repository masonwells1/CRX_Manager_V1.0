import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Save, Send, Ban, Plus, Trash2, Search, DollarSign, FileText, Printer, Truck, Mail, RotateCcw,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, assertRpcResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { parseDollarsToCents } from '../lib/parseCents';
import type { Invoice, InvoiceType, InvoiceStatus, Product, Customer, InvoiceShare, InvoicePrintOptions } from '../types';
import { downloadInvoicePdf, generateInvoicePdf, type InvoicePdfData, type InvoicePdfItem } from '../lib/invoicePdf';
import { formatCents as fmt } from '../lib/money';
import { sendEmail, pdfToBase64, buildEmailHtml } from '../lib/emailService';
import { logActivity } from '../lib/activityLogger';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import WriteOffModal from '../components/invoices/WriteOffModal';
import InvoicePrintDialog from '../components/invoices/InvoicePrintDialog';
import ConfirmModal from '../components/ui/ConfirmModal';
import TransactionThread from '../components/ui/TransactionThread';
import { useCreditLimitCheck } from '../hooks/useGuardrails';
import GuardrailBanner from '../components/ui/GuardrailBanner';

interface LineItem {
  id?: string;
  product_id: string | null;
  product_name: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  extended_cents: number;
  cost_cents: number;
  rate_per_acre: number | null;
  acres: number | null;
  unit_size: string | null;
  sort_order: number;
  notes: string | null;
  tote_number: string | null;
  price_source: 'quoted' | 'tier' | 'manual' | null;
  quoted_price_cents: number | null;
}

const statusBadge = (status: InvoiceStatus) => {
  const map: Record<InvoiceStatus, { variant: 'default' | 'warning' | 'success' | 'error' | 'info'; label: string }> = {
    draft: { variant: 'default', label: 'Draft' },
    unposted: { variant: 'warning', label: 'Unposted' },
    posted: { variant: 'success', label: 'Posted' },
    paid: { variant: 'info', label: 'Paid' },
    overdue: { variant: 'error', label: 'Overdue' },
    voided: { variant: 'error', label: 'Voided' },
    cancelled: { variant: 'default', label: 'Cancelled' },
  };
  const s = map[status] || { variant: 'default' as const, label: status };
  return <Badge variant={s.variant}>{s.label}</Badge>;
};

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const isAdmin = profile?.role === 'admin';
  const saveIdem = useIdempotencyKey('save_invoice', profile?.id || '');
  const postIdem = useIdempotencyKey('post_invoice', profile?.id || '');
  const voidIdem = useIdempotencyKey('void_invoice', profile?.id || '');
  // PR-08 (2026-05-10): switched from record_invoice_payment to allocate_payment
  // so payments recorded here flow into the same `allocation_sets` ledger that
  // Payment History reads. The operation key follows the new RPC name so
  // idempotency cache hits resolve correctly.
  const payIdem = useIdempotencyKey('allocate_payment', profile?.id || '');
  const reverseWoIdem = useIdempotencyKey('reverse_write_off', profile?.id || '');
  const { warning: creditWarning, check: checkCreditLimit, dismiss: dismissCreditWarning } = useCreditLimitCheck();
  const isNew = id === 'new';

  // Invoice header
  const [invoice, setInvoice] = useState<Partial<Invoice>>({
    invoice_type: 'chemical_sale',
    status: 'draft',
    invoice_date: localToday(),
    customer_id: '',
    salesman_id: profile?.id || '',
    header_notes: '',
    footer_notes: '',
    purchase_order_ref: '',
  });
  const [items, setItems] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);

  // Customer search
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDrop, setShowCustomerDrop] = useState(false);
  const [customerName, setCustomerName] = useState('');

  // Salesman list
  const [salespeople, setSalespeople] = useState<{ id: string; full_name: string }[]>([]);

  // Product search for adding items
  const [productSearch, setProductSearch] = useState('');
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [showProductModal, setShowProductModal] = useState(false);

  // Print PDF
  const [printing, setPrinting] = useState(false);
  const printingRef = useRef(false);
  // Latest invoice id the route is showing — older in-flight fetches bail (stale guard).
  const activeInvoiceIdRef = useRef<string | undefined>(undefined);

  // Email invoice
  const [emailing, setEmailing] = useState(false);

  // Write-off modal + write-off list
  const [showWriteOff, setShowWriteOff] = useState(false);
  const [writeOffs, setWriteOffs] = useState<Array<{ id: string; amount_cents: number; reason: string; created_at: string; reversed_at: string | null }>>([]);
  const [showReverseWoModal, setShowReverseWoModal] = useState(false);
  const [reverseWoTarget, setReverseWoTarget] = useState<{ id: string; amount_cents: number } | null>(null);
  const [reverseWoReason, setReverseWoReason] = useState('');
  const [reversingWo, setReversingWo] = useState(false);

  // Print dialog
  const [showPrintDialog, setShowPrintDialog] = useState(false);
  const [shares, setShares] = useState<InvoiceShare[]>([]);

  // Void modal
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voiding, setVoiding] = useState(false);

  // Payment modal
  const [showPayModal, setShowPayModal] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('check');
  const [payRef, setPayRef] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payingInvoice, setPayingInvoice] = useState(false);

  // Parent order context
  const [parentOrder, setParentOrder] = useState<{ id: string; order_number: string } | null>(null);

  // Related deliveries (cross-link via shared order)
  const [relatedDeliveries, setRelatedDeliveries] = useState<Array<{
    id: string; delivery_number: string; scheduled_date: string; status: string;
    driver_name: string | null;
  }>>([]);

  // Sibling invoices + quote context for transaction thread
  const [siblingInvoices, setSiblingInvoices] = useState<{ id: string; invoice_number: string }[]>([]);
  const [parentQuote, setParentQuote] = useState<{ id: string; quote_number: string } | null>(null);

  // Post loading
  const [posting, setPosting] = useState(false);
  const [showPostConfirm, setShowPostConfirm] = useState(false);

  // Fetch reference data
  useEffect(() => {
    const fetchRef = async () => {
      const [custRes, salesRes] = await Promise.all([
        supabase.from('customers').select('id, farm_name').eq('is_active', true).order('farm_name').limit(500),
        // PR-07 follow-up: profile_public_view exposes only id/full_name/role/is_active.
        supabase.from('profile_public_view').select('id, full_name').in('role', ['admin', 'sales_rep']).eq('is_active', true).order('full_name'),
      ]);
      if (custRes.data) setCustomers(custRes.data as Customer[]);
      if (salesRes.data) setSalespeople(salesRes.data);
    };
    fetchRef();
  }, []);

  const fetchInvoice = useCallback(async (invoiceId: string) => {
    // Stale-fetch guard: on rapid invoice-to-invoice navigation an older
    // in-flight fetch must not render the previous invoice's amounts.
    const isStale = () => activeInvoiceIdRef.current !== invoiceId;
    setLoading(true);
    // PR-07 follow-up: dropped salesman FK embed; resolve via profile_public_view.
    const { data, error } = await supabase
      .from('invoices')
      .select('*, customer:customers(farm_name)')
      .eq('id', invoiceId)
      .single();

    if (isStale()) return;
    if (error || !data) {
      toast('error', 'Invoice not found');
      navigate('/invoices');
      return;
    }

    let salesman: { full_name: string } | null = null;
    const salesmanId = (data as { salesman_id?: string | null }).salesman_id;
    if (salesmanId) {
      const { data: smData } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .eq('id', salesmanId)
        .maybeSingle();
      if (smData) salesman = { full_name: smData.full_name };
    }
    // Attach salesman in the same shape the JSX consumes (`invoice.salesman?.full_name`).
    (data as Record<string, unknown>).salesman = salesman;

    if (isStale()) return;
    setInvoice(data as Invoice);
    setCustomerName((data as unknown as { customer?: { farm_name: string } }).customer?.farm_name || '');

    // Fetch parent order for breadcrumb + related deliveries for cross-link
    if (data.order_id) {
      const [orderRes, delRes, invRes] = await Promise.all([
        supabase
          .from('orders')
          .select('id, order_number, quote_id')
          .eq('id', data.order_id)
          .maybeSingle(),
        // PR-07 follow-up: dropped driver FK embed; resolve via post-fetch below.
        supabase
          .from('deliveries')
          .select('id, delivery_number, scheduled_date, status, assigned_driver')
          .eq('order_id', data.order_id)
          .order('scheduled_date', { ascending: false }),
        supabase
          .from('invoices')
          .select('id, invoice_number')
          .eq('order_id', data.order_id)
          .not('status', 'in', '("voided","cancelled")')
          .order('invoice_number'),
      ]);
      if (isStale()) return;
      setParentOrder(orderRes.data as { id: string; order_number: string } | null);

      // PR-07 follow-up: resolve driver names via profile_public_view.
      const delDriverIds = [...new Set(
        ((delRes.data || []) as Array<{ assigned_driver?: string | null }>)
          .map((d) => d.assigned_driver)
          .filter(Boolean) as string[]
      )];
      const delDriverMap: Record<string, string> = {};
      if (delDriverIds.length > 0) {
        const { data: driverData } = await supabase
          .from('profile_public_view')
          .select('id, full_name')
          .in('id', delDriverIds);
        (driverData || []).forEach((p: { id: string; full_name: string }) => { delDriverMap[p.id] = p.full_name; });
      }
      setRelatedDeliveries(
        (delRes.data || []).map((d: Record<string, unknown>) => ({
          id: d.id as string,
          delivery_number: d.delivery_number as string,
          scheduled_date: d.scheduled_date as string,
          status: d.status as string,
          driver_name: d.assigned_driver ? delDriverMap[d.assigned_driver as string] || null : null,
        }))
      );
      setSiblingInvoices((invRes.data || []).map((i: Record<string, unknown>) => ({
        id: i.id as string, invoice_number: i.invoice_number as string,
      })));

      // Fetch quote context via parent order
      const orderWithQuote = orderRes.data as { id: string; order_number: string; quote_id?: string | null } | null;
      if (orderWithQuote?.quote_id) {
        const { data: qData } = await supabase
          .from('quotes').select('id, quote_number')
          .eq('id', orderWithQuote.quote_id).maybeSingle();
        setParentQuote(qData as { id: string; quote_number: string } | null);
      } else { setParentQuote(null); }
    } else {
      setParentOrder(null);
      setRelatedDeliveries([]);
      setSiblingInvoices([]);
      setParentQuote(null);
    }

    // Fetch items
    const { data: itemData } = await supabase
      .from('invoice_items')
      .select('*, product:products(product_name)')
      .eq('invoice_id', invoiceId)
      .order('sort_order');

    if (isStale()) return;
    if (itemData) {
      setItems(
        (itemData as Array<Record<string, unknown> & { id: string; product_id: string; product?: { product_name: string }; description: string; quantity: number; unit_price_cents: number; extended_cents: number; cost_cents: number; rate_per_acre?: number | null; acres?: number | null; unit_size?: string; rate_unit?: string; total_applied?: number; sort_order?: number }>).map((it) => ({
          id: it.id,
          product_id: it.product_id,
          product_name: it.product?.product_name || it.description || '',
          description: it.description,
          quantity: Number(it.quantity),
          unit_price_cents: it.unit_price_cents,
          extended_cents: it.extended_cents,
          cost_cents: it.cost_cents,
          rate_per_acre: it.rate_per_acre ? Number(it.rate_per_acre) : null,
          acres: it.acres ? Number(it.acres) : null,
          unit_size: it.unit_size ?? null,
          sort_order: it.sort_order,
          notes: it.notes as string | null,
          tote_number: (it.tote_number as string) ?? null,
          price_source: (it.price_source as LineItem['price_source']) ?? null,
          quoted_price_cents: it.quoted_price_cents != null ? Number(it.quoted_price_cents) : null,
        })) as LineItem[]
      );
    }

    // Fetch shares
    const { data: shareData } = await supabase
      .from('invoice_shares')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('sort_order');
    setShares((shareData || []) as InvoiceShare[]);

    // Fetch write-offs
    const { data: woData } = await supabase
      .from('write_offs')
      .select('id, amount_cents, reason, created_at, reversed_at')
      .eq('invoice_id', invoiceId)
      .order('created_at');
    if (isStale()) return;
    setWriteOffs((woData || []) as Array<{ id: string; amount_cents: number; reason: string; created_at: string; reversed_at: string | null }>);

    setLoading(false);
  }, [toast, navigate]);

  // Fetch existing invoice
  useEffect(() => {
    activeInvoiceIdRef.current = id;
    if (!isNew && id) fetchInvoice(id);
  }, [id, isNew, fetchInvoice]);

  // Product search
  const searchProducts = useCallback(async (q: string) => {
    if (q.length < 2) { setProductResults([]); return; }
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .or(`product_name.ilike.%${q}%,sku.ilike.%${q}%`)
      .order('product_name')
      .limit(20);
    setProductResults((data || []) as Product[]);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchProducts(productSearch), 200);
    return () => clearTimeout(t);
  }, [productSearch, searchProducts]);

  // Add product as line item
  const addProduct = (product: Product) => {
    const tierPrice = invoice.customer_id
      ? (() => {
          const cust = customers.find((c) => c.id === invoice.customer_id);
          const tier = cust?.assigned_tier || 1;
          if (tier === 1) return product.tier1_price;
          if (tier === 2) return product.tier2_price;
          return product.tier3_price;
        })()
      : product.tier1_price;

    const priceCents = Math.round((tierPrice || 0) * 100);
    const costCents = Math.round((product.current_cost || 0) * 100);

    setItems((prev) => [
      ...prev,
      {
        product_id: product.id,
        product_name: product.product_name,
        description: product.product_name,
        quantity: 1,
        unit_price_cents: priceCents,
        extended_cents: priceCents,
        cost_cents: costCents,
        rate_per_acre: product.rate_per_acre,
        acres: null,
        unit_size: product.unit_size,
        sort_order: prev.length,
        notes: null,
        tote_number: null,
        price_source: null,
        quoted_price_cents: null,
      },
    ]);
    setShowProductModal(false);
    setProductSearch('');
  };

  // Update line item
  const updateItem = (index: number, field: keyof LineItem, value: unknown) => {
    setItems((prev) => {
      const updated = [...prev];
      const item = { ...updated[index], [field]: value };
      // Recalculate extended
      if (field === 'quantity' || field === 'unit_price_cents') {
        item.extended_cents = Math.round(item.quantity * item.unit_price_cents);
      }
      updated[index] = item;
      return updated;
    });
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  // Save invoice
  const handleSave = async () => {
    // Codex P2 fix (PR #59, 2026-05-16): reset saveIdem at the top of every
    // save attempt. The invoice form is always-editable in-page (no separate
    // edit toggle), so any change between failed submits constitutes a new
    // intent. Reset-per-click means each save attempt gets a fresh key;
    // a true network retry (without user edits) is handled by the RPC's
    // own retry logic and not the React handler.
    saveIdem.resetKey();
    if (!invoice.customer_id) {
      toast('error', 'Please select a customer');
      return;
    }
    await runCriticalAction({
      action: async () => {
        const payload = {
          id: isNew ? undefined : id,
          customer_id: invoice.customer_id,
          invoice_type: invoice.invoice_type || 'chemical_sale',
          status: invoice.status || 'draft',
          season: invoice.season,
          salesman_id: invoice.salesman_id || null,
          invoice_date: invoice.invoice_date,
          due_date: invoice.due_date || null,
          purchase_order_ref: invoice.purchase_order_ref || null,
          header_notes: invoice.header_notes || null,
          footer_notes: invoice.footer_notes || null,
        };

        const itemsPayload = items.map((it, idx) => ({
          product_id: it.product_id,
          description: it.description || it.product_name,
          quantity: it.quantity,
          unit_price_cents: it.unit_price_cents,
          extended_cents: it.extended_cents,
          cost_cents: it.cost_cents,
          sort_order: idx,
          rate_per_acre: it.rate_per_acre,
          acres: it.acres,
          unit_size: it.unit_size,
          notes: it.notes,
        }));

        const idemKey = saveIdem.getKey();
        const { data, error } = await supabase.rpc('save_invoice', {
          p_invoice: payload,
          p_items: itemsPayload,
          p_idempotency_key: idemKey,
        });

        if (error) throw error;
        saveIdem.resetKey();

        if (isNew && data) {
          const savedId = assertRpcResult<string>(data, 'save_invoice');
          navigate(`/invoices/${savedId}`, { replace: true });
        } else {
          fetchInvoice(id!);
        }
      },
      toast,
      successMessage: isNew ? 'Invoice created' : 'Invoice saved',
      setLoading: setSaving,
      sentryTag: 'save_invoice',
    });
  };

  // Post invoice
  const handlePost = async () => {
    const totalCents = items.reduce((sum, i) => sum + (i.extended_cents || 0), 0);
    const creditOk = await checkCreditLimit({ customerId: invoice.customer_id!, newAmountCents: totalCents });
    if (!creditOk && !creditWarning?.dismissed) return;
    setPosting(true);
    try {
      const idemKey = postIdem.getKey();
      // Phase 1 (2026-04-29): when the invoice belongs to a split group, route
      // through post_invoice_group so all siblings post atomically. Posting just
      // one member of a group would leave the group in a half-posted state.
      if (invoice.invoice_group_id) {
        const { data, error } = await supabase.rpc('post_invoice_group', {
          p_invoice_group_id: invoice.invoice_group_id,
          p_performed_by: profile?.id ?? null,
          p_idempotency_key: idemKey,
        });
        if (error) throw error;
        assertRpcResult(data, 'post_invoice_group');
      } else {
        // post_invoice RETURNS void — use .throwOnError() (no `=` capture).
        await supabase.rpc('post_invoice', { p_invoice_id: id, p_idempotency_key: idemKey }).throwOnError();
      }
      postIdem.resetKey();
      toast('success', invoice.invoice_group_id ? 'Invoice group posted' : 'Invoice posted');
      fetchInvoice(id!);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        extra: { context: invoice.invoice_group_id ? 'post_invoice_group' : 'post_invoice' },
      });
      toast('error', sanitizeError(err));
    }
    setPosting(false);
  };

  // Void invoice
  const handleVoid = async () => {
    setVoiding(true);
    try {
      const idemKey = voidIdem.getKey();
      // void_invoice RETURNS void — use .throwOnError() (no `=` capture).
      await supabase.rpc('void_invoice', {
        p_invoice_id: id,
        p_void_reason: voidReason || 'Voided by admin',
        p_idempotency_key: idemKey,
      }).throwOnError();
      voidIdem.resetKey();
      toast('success', 'Invoice voided');
      setShowVoidModal(false);
      fetchInvoice(id!);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'void_invoice' } });
      toast('error', sanitizeError(err));
    }
    setVoiding(false);
  };

  // Record payment via allocate_payment (PR-08, 2026-05-10).
  //
  // Pre-PR-08 this called `record_invoice_payment` which wrote to the
  // `payments` table — a different ledger than `/payment-history` reads
  // (`allocation_sets` + `invoice_line_allocations`). The two ledgers
  // co-existed and any payment recorded from this modal was invisible to
  // Payment History. allocate_payment with a single-invoice allocation
  // collapses the two paths onto one ledger.
  //
  // Behavior preserved: posted/overdue-only constraint, period guard,
  // amount-positive check, balance ceiling. Behavior added (latent — the
  // amount validation prevents it from firing in this flow): excess
  // payment becomes a prepay credit instead of erroring.
  const handlePayment = async () => {
    const amountCents = parseDollarsToCents(payAmount);
    if (amountCents <= 0) {
      toast('error', 'Enter a valid payment amount');
      return;
    }
    if (!invoice?.customer_id) {
      toast('error', 'Cannot record payment — invoice has no customer linked');
      return;
    }
    setPayingInvoice(true);
    try {
      const idemKey = payIdem.getKey();
      const { data, error } = await supabase.rpc('allocate_payment', {
        p_customer_id: invoice.customer_id,
        p_total_cents: amountCents,
        p_payment_method: payMethod,
        p_reference_number: payRef || null,
        p_notes: payNotes || null,
        p_allocations: [{ invoice_id: id, amount_cents: amountCents }],
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      assertRpcResult<{
        success: boolean;
        allocation_set_id: string;
        total_allocated_cents: number;
        prepay_created_cents: number;
        invoices_paid: number;
      }>(data, 'allocate_payment');
      payIdem.resetKey();
      toast('success', `Payment of ${fmt(amountCents)} recorded`);
      setShowPayModal(false);
      setPayAmount('');
      setPayRef('');
      setPayNotes('');
      fetchInvoice(id!);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'allocate_payment' } });
      toast('error', sanitizeError(err));
    }
    setPayingInvoice(false);
  };

  const handleReverseWriteOff = async () => {
    if (!reverseWoTarget) return;
    if (!profile) {
      toast('error', 'Cannot reverse write-off — profile not loaded. Please refresh.');
      return;
    }
    setReversingWo(true);
    try {
      const key = reverseWoIdem.getKey();
      const { data, error } = await supabase.rpc('reverse_write_off', {
        p_write_off_id: reverseWoTarget.id,
        p_reason: reverseWoReason,
        p_performed_by: profile.id,
        p_idempotency_key: key,
      });
      if (error) throw error;
      assertRpcResult(data, 'reverse_write_off');
      reverseWoIdem.resetKey();
      await logActivity({ event: 'write_off_reversed', description: `Write-off of ${fmt(reverseWoTarget.amount_cents)} reversed`, performedBy: profile.id, entityType: 'invoice', entityId: id });
      toast('success', 'Write-off reversed and balance restored');
      setShowReverseWoModal(false);
      setReverseWoReason('');
      setReverseWoTarget(null);
      if (id) fetchInvoice(id);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setReversingWo(false);
  };

  // Build PDF data object (shared by print + email)
  const buildInvoicePdfData = async (options?: InvoicePrintOptions): Promise<InvoicePdfData> => {
    const { data: enrichedItems } = await supabase
      .from('invoice_items')
      .select('*, product:products(product_name, epa_registration, product_form)')
      .eq('invoice_id', id)
      .order('sort_order');

    const cust = customers.find(c => c.id === invoice.customer_id);

    return {
      invoice_number: invoice.invoice_number || 'DRAFT',
      invoice_date: invoice.invoice_date || localToday(),
      due_date: invoice.due_date || undefined,
      invoice_type: invoice.invoice_type || 'chemical_sale',
      status: invoice.status || 'draft',
      customer_name: customerName,
      customer_address: cust?.billing_address || undefined,
      customer_city: cust?.city || undefined,
      customer_state: cust?.state || undefined,
      customer_zip: cust?.zip || undefined,
      account_number: cust?.account_number || undefined,
      payment_terms: cust?.payment_terms || undefined,
      salesman_name: salespeople.find((s) => s.id === invoice.salesman_id)?.full_name,
      purchase_order_ref: invoice.purchase_order_ref || undefined,
      header_notes: invoice.header_notes || undefined,
      footer_notes: invoice.footer_notes || undefined,
      crop_type: invoice.crop_type || undefined,
      field_names: invoice.field_names || undefined,
      total_acres: invoice.total_acres || undefined,
      applicator_name: invoice.applicator_name || undefined,
      vehicle_name: invoice.vehicle_name || undefined,
      application_date: invoice.application_date || undefined,
      shares: shares.length > 0 ? shares.map(s => ({
        customer_name: s.customer_name,
        split_percentage: s.split_percentage,
        acres: s.acres,
        amount_cents: s.amount_cents,
      })) : undefined,
      items: (enrichedItems || []).map((it: Record<string, unknown> & { description?: string; product?: { product_name: string; epa_registration?: string | null; product_form?: string | null }; quantity?: number; unit_size?: string; unit_price_cents?: number; extended_cents?: number; cost_cents?: number; rate_per_acre?: number | null; rate_unit?: string | null; acres?: number | null; total_applied?: number | null }) => ({
        description: it.description,
        product_name: it.product?.product_name || it.description,
        quantity: Number(it.quantity),
        unit_size: it.unit_size || undefined,
        unit_price_cents: it.unit_price_cents,
        extended_cents: it.extended_cents,
        cost_cents: it.cost_cents,
        rate_per_acre: it.rate_per_acre ? Number(it.rate_per_acre) : null,
        rate_unit: it.rate_unit || null,
        acres: it.acres ? Number(it.acres) : null,
        total_applied: it.total_applied ? Number(it.total_applied) : null,
        total_applied_unit: it.total_applied_unit || null,
        total_applied_gl_lb: it.total_applied_gl_lb ? Number(it.total_applied_gl_lb) : null,
        gl_lb_unit: it.gl_lb_unit || null,
        epa_registration: it.epa_registration || it.product?.epa_registration || null,
        is_application_fee: it.is_application_fee || false,
        product_form: it.product_form || it.product?.product_form || null,
      })) as InvoicePdfItem[],
      total_amount_cents: invoice.total_amount_cents ?? items.reduce((s, i) => s + i.extended_cents, 0),
      total_cost_cents: invoice.total_cost_cents ?? items.reduce((s, i) => s + Math.round(i.cost_cents * i.quantity), 0),
      paid_amount_cents: invoice.paid_amount_cents ?? 0,
      prepay_applied_cents: invoice.prepay_applied_cents ?? 0,
      balance_cents: invoice.balance_cents ?? 0,
      options,
    };
  };

  // Print invoice PDF
  const handlePrint = async (options?: InvoicePrintOptions) => {
    // Ref-based guard prevents multiple concurrent executions (triple-fire from click propagation)
    if (printingRef.current) return;
    printingRef.current = true;
    await runCriticalAction({
      action: async () => {
        const pdfData = await buildInvoicePdfData(options);
        await downloadInvoicePdf(pdfData);
        setShowPrintDialog(false);
      },
      toast,
      successMessage: 'Invoice PDF downloaded',
      setLoading: (v) => { setPrinting(v); if (!v) printingRef.current = false; },
      sentryTag: 'print_invoice_pdf',
    });
    printingRef.current = false;
  };

  // Email invoice with PDF attachment
  const handleEmailInvoice = async () => {
    if (!profile) {
      toast('error', 'Cannot email invoice — profile not loaded. Please refresh.');
      return;
    }
    const cust = customers.find(c => c.id === invoice.customer_id);
    if (!cust?.email) {
      toast('error', 'Customer does not have an email address on file');
      return;
    }
    await runCriticalAction({
      action: async () => {
        const pdfData = await buildInvoicePdfData();
        const doc = await generateInvoicePdf(pdfData);
        const base64 = pdfToBase64(doc);

        const amountStr = ((invoice.balance_cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
        const html = buildEmailHtml(`
          <h2 style="margin:0 0 16px;color:#111827;font-size:18px;">Invoice ${invoice.invoice_number || ''}</h2>
          <p style="margin:0 0 8px;color:#374151;">Amount Due: <strong>${amountStr}</strong></p>
          <p style="margin:0 0 8px;color:#374151;">Invoice Date: ${invoice.invoice_date || 'N/A'}</p>
          ${invoice.due_date ? `<p style="margin:0 0 8px;color:#374151;">Due Date: ${invoice.due_date}</p>` : ''}
          <p style="margin:16px 0 0;color:#374151;">Please find your invoice attached to this email.</p>
          <p style="margin:8px 0 0;color:#6b7280;font-size:13px;">If you have questions about this invoice, please contact us.</p>
        `);

        const result = await sendEmail({
          to: cust.email!,
          subject: `Invoice ${invoice.invoice_number || ''} from Crop RX Solutions`,
          html,
          email_type: 'invoice',
          customer_id: invoice.customer_id!,
          resource_type: 'invoice',
          resource_id: id,
          idempotency_key: `invoice-email-${id}-${Date.now()}`,
          attachments: [{
            filename: `Invoice-${invoice.invoice_number || 'DRAFT'}.pdf`,
            content: base64,
          }],
        });

        if (result.success) {
          logActivity({ event: 'invoice_emailed', description: `Invoice ${invoice.invoice_number} emailed to ${cust.email}`, performedBy: profile.id, entityType: 'invoice', entityId: id, customerId: invoice.customer_id });
        } else {
          throw new Error(result.error || 'Failed to send email');
        }
      },
      toast,
      successMessage: `Invoice emailed to ${cust.email}`,
      setLoading: setEmailing,
      sentryTag: 'email_invoice',
    });
  };

  const totalCents = items.reduce((s, i) => s + i.extended_cents, 0);
  const totalCostCents = items.reduce((s, i) => s + (i.cost_cents * i.quantity), 0);
  const editable = isNew || ['draft', 'unposted'].includes(invoice.status || '');

  // Customer filtered list
  const filteredCustomers = customerSearch.length >= 1
    ? customers.filter((c) =>
        c.farm_name.toLowerCase().includes(customerSearch.toLowerCase())
      ).slice(0, 10)
    : [];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <Breadcrumbs items={[
        { label: 'Invoices', href: '/invoices' },
        ...(parentOrder ? [{ label: parentOrder.order_number, href: `/orders/${parentOrder.id}` }] : []),
        { label: isNew ? 'New Invoice' : invoice.invoice_number || 'Invoice' },
      ]} />
      {!isNew && (
        <TransactionThread
          quoteId={parentQuote?.id}
          quoteNumber={parentQuote?.quote_number}
          orderId={parentOrder?.id}
          orderNumber={parentOrder?.order_number}
          deliveries={relatedDeliveries.map(d => ({ id: d.id, number: d.delivery_number }))}
          invoices={siblingInvoices.map(i => ({ id: i.id, number: i.invoice_number }))}
          currentEntity="invoice"
          currentEntityId={id}
        />
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div>
            <h1 className="text-xl font-semibold font-heading text-nav-dark">
              {isNew ? 'New Invoice' : invoice.invoice_number}
            </h1>
            {!isNew && (
              <div className="flex items-center gap-2 mt-1">
                {statusBadge(invoice.status as InvoiceStatus)}
                {invoice.posted_at && (
                  <span className="text-xs text-secondary">
                    Posted {new Date(invoice.posted_at).toLocaleDateString()}
                  </span>
                )}
                {invoice.invoice_group_id && (
                  <span className="text-xs bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
                    Split Invoice Group
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {editable && (
            <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
              Save
            </Button>
          )}
          <GuardrailBanner warning={creditWarning} onDismiss={dismissCreditWarning} />
          {!isNew && editable && isAdmin && (
            <Button variant="secondary" icon={<Send className="w-4 h-4" />} onClick={() => { postIdem.resetKey(); setShowPostConfirm(true); }} loading={posting}>
              Post
            </Button>
          )}
          {!isNew && (
            <Button
              variant="secondary"
              icon={<Printer className="w-4 h-4" />}
              onClick={() => setShowPrintDialog(true)}
              showChevron={false}
            >
              Print
            </Button>
          )}
          {!isNew && invoice.status === 'posted' && isAdmin && (
            <Button
              variant="secondary"
              icon={<Mail className="w-4 h-4" />}
              onClick={handleEmailInvoice}
              loading={emailing}
              showChevron={false}
            >
              Email
            </Button>
          )}
          {!isNew && invoice.status === 'posted' && isAdmin && (
            <>
              <Button
                variant="secondary"
                icon={<DollarSign className="w-4 h-4" />}
                onClick={() => {
                  // Codex P2 fix: reset pay key per modal open (variable amount/allocation).
                  payIdem.resetKey();
                  setPayAmount(((invoice.balance_cents || 0) / 100).toFixed(2));
                  setShowPayModal(true);
                }}
              >
                Record Payment
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowWriteOff(true)}
                showChevron={false}
              >
                Write Off
              </Button>
            </>
          )}
          {!isNew && invoice.status === 'posted' && isAdmin && (
              <Button variant="ghost" icon={<Ban className="w-4 h-4" />} onClick={() => { voidIdem.resetKey(); setShowVoidModal(true); }}>
                Void
              </Button>
          )}
        </div>
      </div>

      {/* Invoice Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <h2 className="text-sm font-semibold text-nav-dark mb-4">Invoice Details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Customer */}
            <div className="col-span-2 relative">
              <label className="text-sm font-medium text-nav-dark">Customer *</label>
              {editable ? (
                <div className="relative mt-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search customers..."
                    value={customerSearch || customerName}
                    onChange={(e) => {
                      setCustomerSearch(e.target.value);
                      setCustomerName('');
                      setShowCustomerDrop(true);
                    }}
                    onFocus={() => setShowCustomerDrop(true)}
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                  {showCustomerDrop && filteredCustomers.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-auto">
                      {filteredCustomers.map((c) => (
                        <button
                          key={c.id}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                          onClick={() => {
                            setInvoice((prev) => ({ ...prev, customer_id: c.id }));
                            setCustomerName(c.farm_name);
                            setCustomerSearch('');
                            setShowCustomerDrop(false);
                          }}
                        >
                          {c.farm_name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-sm text-nav-dark">{customerName}</p>
              )}
            </div>

            {/* Type */}
            <div>
              <label className="text-sm font-medium text-nav-dark">Invoice Type</label>
              {editable ? (
                <select
                  value={invoice.invoice_type || 'chemical_sale'}
                  onChange={(e) => setInvoice((prev) => ({ ...prev, invoice_type: e.target.value as InvoiceType }))}
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="chemical_sale">Chemical Sale</option>
                  <option value="field_application">Field Application</option>
                  <option value="misc_charge">Misc Charge</option>
                </select>
              ) : (
                <p className="mt-1 text-sm capitalize">{(invoice.invoice_type || '').replace(/_/g, ' ')}</p>
              )}
            </div>

            {/* Date */}
            <div>
              <label className="text-sm font-medium text-nav-dark">Invoice Date</label>
              {editable ? (
                <input
                  type="date"
                  value={invoice.invoice_date?.split('T')[0] || ''}
                  onChange={(e) => setInvoice((prev) => ({ ...prev, invoice_date: e.target.value }))}
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              ) : (
                <p className="mt-1 text-sm">{invoice.invoice_date ? new Date(invoice.invoice_date + 'T00:00:00').toLocaleDateString() : '-'}</p>
              )}
            </div>

            {/* Salesman */}
            <div>
              <label className="text-sm font-medium text-nav-dark">Salesman</label>
              {editable ? (
                <select
                  value={invoice.salesman_id || ''}
                  onChange={(e) => setInvoice((prev) => ({ ...prev, salesman_id: e.target.value || null }))}
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">No Salesman</option>
                  {salespeople.map((s) => (
                    <option key={s.id} value={s.id}>{s.full_name}</option>
                  ))}
                </select>
              ) : (
                <p className="mt-1 text-sm">{(invoice as unknown as { salesman?: { full_name: string } }).salesman?.full_name || '-'}</p>
              )}
            </div>

            {/* PO Ref */}
            <div>
              <label className="text-sm font-medium text-nav-dark">PO Reference</label>
              {editable ? (
                <input
                  type="text"
                  value={invoice.purchase_order_ref || ''}
                  onChange={(e) => setInvoice((prev) => ({ ...prev, purchase_order_ref: e.target.value }))}
                  placeholder="Customer PO #"
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              ) : (
                <p className="mt-1 text-sm">{invoice.purchase_order_ref || '-'}</p>
              )}
            </div>

            {/* Notes */}
            <div className="col-span-2">
              <label className="text-sm font-medium text-nav-dark">Notes</label>
              {editable ? (
                <textarea
                  value={invoice.header_notes || ''}
                  onChange={(e) => setInvoice((prev) => ({ ...prev, header_notes: e.target.value }))}
                  rows={2}
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              ) : (
                <p className="mt-1 text-sm text-secondary">{invoice.header_notes || '-'}</p>
              )}
            </div>
          </div>
        </Card>

        {/* Financial Summary */}
        <Card>
          <h2 className="text-sm font-semibold text-nav-dark mb-4">Summary</h2>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-secondary">Subtotal</span>
              <span className="font-medium">{fmt(totalCents)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-secondary">Total Cost</span>
              <span className="text-secondary">{fmt(totalCostCents)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-secondary">Margin</span>
              <span className={totalCents - totalCostCents > 0 ? 'text-crx-green' : 'text-red-600'}>
                {fmt(totalCents - totalCostCents)}
              </span>
            </div>
            {!isNew && (
              <>
                <hr className="border-gray-100" />
                <div className="flex justify-between text-sm">
                  <span className="text-secondary">Paid</span>
                  <span className="text-crx-green">{fmt(invoice.paid_amount_cents || 0)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-secondary">Prepay Applied</span>
                  <span>{fmt(invoice.prepay_applied_cents || 0)}</span>
                </div>
                <hr className="border-gray-100" />
                <div className="flex justify-between text-sm font-semibold">
                  <span>Balance Due</span>
                  <span className={(invoice.balance_cents || 0) > 0 ? 'text-red-600' : 'text-crx-green'}>
                    {fmt(invoice.balance_cents || 0)}
                  </span>
                </div>
              </>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-secondary">Items</span>
              <span>{items.length}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Line Items */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-nav-dark">Line Items</h2>
          {editable && (
            <Button size="sm" icon={<Plus className="w-4 h-4" />} onClick={() => setShowProductModal(true)}>
              Add Product
            </Button>
          )}
        </div>

        {items.length === 0 ? (
          <div className="text-center py-8 text-secondary">
            <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No line items yet. Add products to this invoice.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-secondary border-b border-gray-100">
                  <th className="pb-2 pr-4">Product</th>
                  <th className="pb-2 pr-4 w-24">Qty</th>
                  <th className="pb-2 pr-4 w-28">Unit Price</th>
                  <th className="pb-2 pr-4 w-28">Extended</th>
                  {items.some((i) => i.tote_number) && (
                    <th className="pb-2 pr-4">Tote #</th>
                  )}
                  <th className="pb-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {items.map((item, idx) => (
                  <tr key={idx} className="group">
                    <td className="py-2 pr-4">
                      <div className="font-medium text-nav-dark">{item.product_name || item.description}</div>
                      {item.unit_size && (
                        <div className="text-xs text-secondary">{item.unit_size}</div>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {editable ? (
                        <input
                          type="number"
                          value={item.quantity}
                          onChange={(e) => updateItem(idx, 'quantity', Number(e.target.value) || 0)}
                          min={0}
                          step={0.01}
                          className="w-24 px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                        />
                      ) : (
                        item.quantity
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {editable ? (
                        <input
                          type="number"
                          value={(item.unit_price_cents / 100).toFixed(2)}
                          onChange={(e) =>
                            updateItem(idx, 'unit_price_cents', parseDollarsToCents(e.target.value))
                          }
                          min={0}
                          step={0.01}
                          className="w-28 px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                        />
                      ) : (
                        <span className="flex items-center gap-1">
                          {fmt(item.unit_price_cents)}
                          {item.price_source === 'quoted' && <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-green-100 text-green-700" title={item.quoted_price_cents != null ? `Program price: ${fmt(item.quoted_price_cents)}` : undefined}>Quoted</span>}
                          {item.price_source === 'tier' && <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-gray-100 text-gray-600" title="Using customer tier pricing">Tier</span>}
                          {item.price_source === 'manual' && <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-100 text-blue-700" title="Manually set price">Manual</span>}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4 font-medium">{fmt(item.extended_cents)}</td>
                    {items.some((i) => i.tote_number) && (
                      <td className="py-2 pr-4 text-secondary">{item.tote_number || '-'}</td>
                    )}
                    <td className="py-2">
                      {editable && (
                        <button
                          onClick={() => removeItem(idx)}
                          className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-200 font-semibold">
                  <td className="pt-3" colSpan={items.some((i) => i.tote_number) ? 4 : 3}>
                    Total
                  </td>
                  <td className="pt-3">{fmt(totalCents)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>

      {/* Write-Offs */}
      {writeOffs.length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold text-nav-dark mb-3">Write-Offs</h3>
          <div className="divide-y divide-gray-50">
            {writeOffs.map((wo) => (
              <div key={wo.id} className="py-2 flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-nav-dark">{fmt(wo.amount_cents)}</span>
                  <span className="text-xs text-secondary ml-2">{wo.reason}</span>
                  <span className="text-xs text-secondary ml-2">{new Date(wo.created_at).toLocaleDateString()}</span>
                </div>
                {wo.reversed_at ? (
                  <span className="text-xs text-amber-600 font-medium">Reversed {new Date(wo.reversed_at).toLocaleDateString()}</span>
                ) : (
                  isAdmin && (
                    <button
                      onClick={() => { reverseWoIdem.resetKey(); setReverseWoTarget(wo); setShowReverseWoModal(true); }}
                      className="flex items-center gap-1 text-xs text-amber-600 hover:text-amber-700 font-medium flex-shrink-0"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reverse
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Void reason */}
      {invoice.void_reason && (
        <Card>
          <div className="flex items-center gap-2 text-red-600">
            <Ban className="w-4 h-4" />
            <span className="text-sm font-medium">Void Reason:</span>
            <span className="text-sm">{invoice.void_reason}</span>
          </div>
        </Card>
      )}

      {/* Related Deliveries (cross-link via shared order) */}
      {relatedDeliveries.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-3">
            <Truck className="w-5 h-5 text-crx-green" />
            <h3 className="font-semibold text-nav-dark">Related Deliveries</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="px-4 py-2 text-left font-medium text-secondary">Delivery #</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Date</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Status</th>
                  <th className="px-4 py-2 text-left font-medium text-secondary">Driver</th>
                </tr>
              </thead>
              <tbody>
                {relatedDeliveries.map((del) => (
                  <tr key={del.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-4 py-2">
                      <button
                        onClick={() => navigate(`/deliveries/${del.id}`)}
                        className="text-crx-green hover:underline font-medium"
                      >
                        {del.delivery_number}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {parseLocalDate(del.scheduled_date).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={statusToBadgeVariant[del.status] || 'default'} size="sm">
                        {del.status.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-secondary">
                      {del.driver_name || 'Unassigned'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Product Search Modal */}
      <Modal open={showProductModal} onClose={() => setShowProductModal(false)} title="Add Product" size="large">
        <div className="space-y-4">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search products by name or SKU..."
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- search input in just-opened picker; user expects to type immediately
              autoFocus
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          {productResults.length > 0 ? (
            <div className="max-h-60 overflow-auto divide-y divide-gray-50">
              {productResults.map((p) => (
                <button
                  key={p.id}
                  onClick={() => addProduct(p)}
                  className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center justify-between"
                >
                  <div>
                    <div className="text-sm font-medium text-nav-dark">{p.product_name}</div>
                    <div className="text-xs text-secondary">{p.sku || 'No SKU'} • {p.vendor || 'No vendor'}</div>
                  </div>
                  <div className="text-right text-xs text-secondary">
                    <div>T1: ${(p.tier1_price || 0).toFixed(2)}</div>
                    <div>Cost: ${(p.current_cost || 0).toFixed(2)}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : productSearch.length >= 2 ? (
            <p className="text-sm text-secondary text-center py-4">No products found</p>
          ) : (
            <p className="text-sm text-secondary text-center py-4">Type at least 2 characters to search</p>
          )}
        </div>
      </Modal>

      {/* Void Modal */}
      <Modal open={showVoidModal} onClose={() => setShowVoidModal(false)} title="Void Invoice">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            This will void invoice <strong>{invoice.invoice_number}</strong> and reverse any balance impact.
            This action cannot be easily undone.
          </p>
          <Input
            label="Reason for voiding"
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            placeholder="e.g., Entered in error, duplicate invoice"
          />
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setShowVoidModal(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleVoid} loading={voiding}>
              Void Invoice
            </Button>
          </div>
        </div>
      </Modal>

      {/* Payment Modal */}
      <Modal open={showPayModal} onClose={() => setShowPayModal(false)} title="Record Payment">
        <div className="space-y-4">
          <Input
            label="Amount ($)"
            type="number"
            value={payAmount}
            onChange={(e) => setPayAmount(e.target.value)}
            min={0}
            step={0.01}
          />
          <div>
            <label className="text-sm font-medium text-nav-dark">Payment Method</label>
            <select
              value={payMethod}
              onChange={(e) => setPayMethod(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="check">Check</option>
              <option value="cash">Cash</option>
              <option value="wire">Wire Transfer</option>
              <option value="ach">ACH</option>
              <option value="credit_card">Credit Card</option>
            </select>
          </div>
          <Input label="Reference # (optional)" value={payRef} onChange={(e) => setPayRef(e.target.value)} />
          <Input label="Notes (optional)" value={payNotes} onChange={(e) => setPayNotes(e.target.value)} />
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setShowPayModal(false)}>Cancel</Button>
            <Button onClick={handlePayment} loading={payingInvoice}>Record Payment</Button>
          </div>
        </div>
      </Modal>

      {/* Reverse Write-Off Modal (admin only) */}
      <Modal open={showReverseWoModal} onClose={() => { setShowReverseWoModal(false); setReverseWoReason(''); }} title="Reverse Write-Off">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            This will reverse the write-off of <strong>{reverseWoTarget ? fmt(reverseWoTarget.amount_cents) : ''}</strong> and restore that amount to the invoice balance.
          </p>
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm text-amber-800">
              The customer will owe this amount again after reversal. This action is logged to the financial audit trail.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-nav-dark mb-1">Reason <span className="text-red-500">*</span></label>
            <textarea
              value={reverseWoReason}
              onChange={(e) => setReverseWoReason(e.target.value)}
              placeholder="Explain why this write-off is being reversed..."
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-crx-green"
            />
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => { setShowReverseWoModal(false); setReverseWoReason(''); }}>Cancel</Button>
            <Button variant="danger" onClick={handleReverseWriteOff} loading={reversingWo} disabled={!reverseWoReason.trim()}>
              Reverse Write-Off
            </Button>
          </div>
        </div>
      </Modal>

      {/* Write-Off Modal */}
      <WriteOffModal
        open={showWriteOff}
        onClose={() => setShowWriteOff(false)}
        invoiceId={id || ''}
        invoiceNumber={invoice.invoice_number || ''}
        balanceCents={invoice.balance_cents || 0}
        onSuccess={() => fetchInvoice(id!)}
      />

      {/* Print Dialog */}
      <InvoicePrintDialog
        open={showPrintDialog}
        onClose={() => setShowPrintDialog(false)}
        invoiceType={invoice.invoice_type || 'chemical_sale'}
        hasShares={shares.length > 1}
        onPrint={handlePrint}
        loading={printing}
      />

      {/* Post Invoice Confirm */}
      <ConfirmModal
        open={showPostConfirm}
        onClose={() => setShowPostConfirm(false)}
        onConfirm={() => { setShowPostConfirm(false); handlePost(); }}
        title="Post Invoice"
        message="Post this invoice? This will lock amounts and start AR aging."
        confirmLabel="Post Invoice"
        variant="warning"
        loading={posting}
      />
    </div>
  );
}
