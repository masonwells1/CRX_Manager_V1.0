import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Save, Send, Ban, Plus, Trash2, Search, DollarSign, FileText, Printer, Truck, Mail, RotateCcw, AlertTriangle,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useBelowCostApproval } from '../contexts/BelowCostApprovalContext';
import { supabase, sanitizeError, assertRpcResult, describePostInvoiceBlock } from '../lib/db';
import { assertInvoiceSendable } from '../lib/invoiceSendDisposition';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { generateIdempotencyKey, getIdempotencyMismatchResult, isDefinitiveRpcRejection, isMissingIntentBindingColumn, legacyIntentChanged } from '../lib/idempotency';
import { MONEY_PRECISION_MESSAGE, parseDollarsToCents } from '../lib/parseCents';
import type { Invoice, InvoiceType, InvoiceStatus, Product, Customer, InvoiceShare, InvoicePrintOptions } from '../types';
import { downloadInvoicePdf, generateInvoicePdf, deriveFieldAppAppliedAcres, groupReturnCreditDisplayItems, mapInvoicePdfItem, type InvoicePdfData } from '../lib/invoicePdf';
import { formatCents as fmt } from '../lib/money';
import { withBelowCostReason } from '../lib/belowCostApproval';
import { sendEmail, pdfToBase64, buildEmailHtml, isInvoiceEmailSuppressed } from '../lib/emailService';
import { logActivity } from '../lib/activityLogger';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { checkRUPCompliance, rupRegisterDisposition } from '../lib/rupCompliance';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import WriteOffModal from '../components/invoices/WriteOffModal';
import WatchdogFlagBanner from '../components/watchdog/WatchdogFlagBanner';
import InvoicePrintDialog from '../components/invoices/InvoicePrintDialog';
import ConfirmModal from '../components/ui/ConfirmModal';
import TransactionThread from '../components/ui/TransactionThread';
import { useCreditLimitCheck } from '../hooks/useGuardrails';
import GuardrailBanner from '../components/ui/GuardrailBanner';
import { ProductSearchResultRow } from '../components/products/ProductSearchResultRow';

interface LineItem {
  id?: string;
  order_item_id?: string | null;
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
  /** Per-line split billing: set when this line was produced by a split billing line.
   *  Undefined until the split-billing migration lands; when set, its quantity/price
   *  are server-allocated and must not be edited (would clobber the split amount). */
  billing_line_id?: string | null;
  return_credit_cogs_cents?: number | null;
  return_credit_source_item_id?: string | null;
  // Field-application detail — preserved through edits so the machine-fee flag,
  // applied amounts and EPA/form survive a "bill actual" edit (#3 edit-path).
  is_application_fee: boolean;
  rate_unit: string | null;
  total_applied: number | null;
  total_applied_unit: string | null;
  total_applied_gl_lb: number | null;
  gl_lb_unit: string | null;
  epa_registration: string | null;
  product_form: string | null;
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

export default function InvoiceDetail({ routeArea }: { routeArea?: 'field' | 'chemical' } = {}) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { profile } = useAuth();
  const { toast } = useToast();
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const isAdmin = profile?.role === 'admin';
  const isAdminOrRep = isAdmin || profile?.role === 'sales_rep';
  const saveIdem = useIdempotencyKey(
    'save_invoice',
    `${profile?.id || ''}:${routeArea || 'all'}:${id || 'unknown'}`,
  );
  const legacySaveIntentRef = useRef<{ key: string; intent: string } | null>(null);
  const postIdem = useIdempotencyKey('post_invoice', profile?.id || '');
  const voidIdem = useIdempotencyKey('void_invoice', profile?.id || '');
  // PR-08 (2026-05-10): switched from record_invoice_payment to allocate_payment
  // so payments recorded here flow into the same `allocation_sets` ledger that
  // Payment History reads. The operation key follows the new RPC name so
  // idempotency cache hits resolve correctly.
  const payIdem = useIdempotencyKey('allocate_payment', profile?.id || '');
  const reverseWoIdem = useIdempotencyKey('reverse_write_off', profile?.id || '');
  // #27: reverse "Transfer to Scheduling" — push a job-built field invoice back to
  // its source job. This is the editor a TRANSFERRED field invoice actually opens in
  // (a transferred invoice has a job_id but NO field_app_locations, so the #24
  // discriminator routes it here, not to the per-acre FieldApplicationInvoice).
  // F1: scoped by the route id — its post-RPC reset moved after assertRpcResult, and
  // this component does NOT remount when the route id changes (App.tsx renders it
  // without a key) while lines ~820/~838 navigate to a DIFFERENT invoice. saveIdem
  // above is already record-scoped via its second argument, so only this one needed it.
  const transferToSchedulingIdem = useIdempotencyKey('transfer_invoice_to_job', profile?.id || '', id ?? '');
  // #28/U16b: Unpost — reverse a posting on a posted field-application or chemical-sale
  // invoice (returns it to the editable Unposted list). The RPC is type-agnostic.
  // #28/FIX 4: per-invoice AND per-group key cache so a retry reuses the same key while a
  // different invoice/group always gets its own. A single invoice uses unpost_invoice
  // (keyed by id); a SPLIT GROUP routes through the atomic unpost_invoice_group (FIX 4 —
  // all-or-nothing) under a `grp:<groupId>` key. A ref map (not the useIdempotencyKey
  // hook) so it's render-stable AND inherently per-group — no cross-group replay.
  const unpostKeysRef = useRef<Record<string, string>>({});
  const { warning: creditWarning, check: checkCreditLimit, dismiss: dismissCreditWarning } = useCreditLimitCheck();
  const isNew = id === 'new';
  const isMiscChargeLocked = isNew && searchParams.get('type') === 'misc_charge';

  // Invoice header
  const [invoice, setInvoice] = useState<Partial<Invoice>>({
    invoice_type: isMiscChargeLocked ? 'misc_charge' : 'chemical_sale',
    status: 'draft',
    invoice_date: localToday(),
    customer_id: '',
    salesman_id: profile?.id || '',
    header_notes: '',
    footer_notes: '',
    purchase_order_ref: '',
  });
  const [paymentTerms, setPaymentTerms] = useState('Customer default');
  const [customDueDate, setCustomDueDate] = useState('');
  const [customTermsText, setCustomTermsText] = useState('');
  const isOrderlessMiscCharge = !isNew
    && invoice.invoice_type === 'misc_charge'
    && !invoice.order_id
    && !invoice.blend_ticket_id;
  const isInvoiceTypeLocked = isMiscChargeLocked || isOrderlessMiscCharge;
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
  const [productSearchLoading, setProductSearchLoading] = useState(false);
  const [showProductModal, setShowProductModal] = useState(false);

  // Print PDF
  const [printing, setPrinting] = useState(false);
  const printingRef = useRef(false);
  // Latest invoice id the route is showing — older in-flight fetches bail (stale guard).
  const activeInvoiceIdRef = useRef<string | undefined>(undefined);
  const productSearchRequestRef = useRef(0);

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
  // #28/U16b: Unpost confirm + in-flight (field-application and chemical-sale invoices).
  const [showUnpostModal, setShowUnpostModal] = useState(false);
  const [unposting, setUnposting] = useState(false);

  // #27: reverse "Transfer to Scheduling" — confirm + in-flight state.
  const [showTransferToSchedulingModal, setShowTransferToSchedulingModal] = useState(false);
  const [transferringToScheduling, setTransferringToScheduling] = useState(false);

  // Payment modal
  const [showPayModal, setShowPayModal] = useState(false);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('check');
  const [payRef, setPayRef] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payingInvoice, setPayingInvoice] = useState(false);
  // Apply Credit Memo (credit-memo apply, 2026-07-10): apply an available same-customer
  // credit memo against this open invoice via apply_credit_memo_to_invoice (net-zero).
  const [showApplyCreditModal, setShowApplyCreditModal] = useState(false);
  const [availableCredits, setAvailableCredits] = useState<Array<{ id: string; invoice_number: string; balance_cents: number }>>([]);
  const [selectedCreditId, setSelectedCreditId] = useState('');
  const [applyCreditAmount, setApplyCreditAmount] = useState('');
  const [applyingCredit, setApplyingCredit] = useState(false);
  const [unresolvedApplyCreditIntent, setUnresolvedApplyCreditIntent] = useState<{
    creditMemoId: string;
    creditMemoNumber: string;
    targetInvoiceId: string;
    amountCents: number;
  } | null>(null);
  const applyCreditAmountCents = parseDollarsToCents(applyCreditAmount);
  const applyCreditIntentScope = JSON.stringify([
    selectedCreditId,
    id || '',
    Number.isInteger(applyCreditAmountCents) ? applyCreditAmountCents : null,
  ]);
  const applyCreditIdem = useIdempotencyKey(
    'apply_credit_memo_to_invoice',
    profile?.id || '',
    applyCreditIntentScope,
  );

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
  // B1 (deep-dive H1): RUP warning surfaced in the post-confirm when the buyer
  // has no valid applicator license — posting is the legal point of sale.
  const [rupPostWarning, setRupPostWarning] = useState<string | null>(null);

  const openPostConfirm = async () => {
    postIdem.resetKey();
    let warning: string | null = null;
    // The RUP check must NEVER block posting — any failure falls through to the
    // plain confirm (warn+confirm by design, not a gate).
    try {
      if (invoice?.invoice_group_id) {
        // Posting a grouped invoice posts EVERY sibling atomically via
        // post_invoice_group (see handlePost), so the RUP advisory must cover the
        // WHOLE group, not just the displayed invoice — a non-RUP sibling could
        // otherwise post a RUP sibling with no warning. Check each sibling's own
        // (customer, products) and aggregate. Still advisory, never a gate.
        const { data: grp } = await supabase
          .from('invoices')
          .select('id, invoice_number, customer_id, invoice_items(product_id)')
          .eq('invoice_group_id', invoice.invoice_group_id);
        const parts: string[] = [];
        for (const inv of (grp || []) as Array<{ invoice_number: string; customer_id: string | null; invoice_items: { product_id: string | null }[] | null }>) {
          const pids = (inv.invoice_items || []).map((x) => x.product_id).filter((p): p is string => Boolean(p));
          if (!inv.customer_id || pids.length === 0) continue;
          const res = await checkRUPCompliance(inv.customer_id, pids);
          if (res.hasRUPProducts && !res.hasValidLicense) {
            const disp = rupRegisterDisposition(res);
            parts.push(`${inv.invoice_number}: ${res.rupProductNames.join(', ')} — ${res.missingLicense ? 'NO applicator license' : 'EXPIRED license'} (${disp.label})`);
          }
        }
        if (parts.length > 0) {
          warning = `Posting this invoice group posts every invoice in it. Restricted-use products without a valid license — ${parts.join('; ')}. These will be recorded in the RUP sales register.`;
        }
      } else {
        const productIds = items.map((it) => it.product_id).filter((p): p is string => Boolean(p));
        if (invoice?.customer_id && productIds.length > 0) {
          const res = await checkRUPCompliance(invoice.customer_id, productIds);
          if (res.hasRUPProducts && !res.hasValidLicense) {
            // #6: align the warning's stated disposition with what the DB actually
            // records — missing license = NON-COMPLIANT, expired = WARNING (flagged).
            const disp = rupRegisterDisposition(res);
            warning = `This invoice includes restricted-use products (${res.rupProductNames.join(', ')}) and the customer has ${res.missingLicense ? 'NO applicator license' : 'only EXPIRED applicator licenses'} on file — it will be recorded as ${disp.label} in the RUP sales register.`;
          }
        }
      }
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'rup_post_check' } });
    }
    setRupPostWarning(warning);
    setShowPostConfirm(true);
  };

  // Fetch reference data
  useEffect(() => {
    const fetchRef = async () => {
      const [custRes, salesRes] = await Promise.all([
        supabase.from('customers').select('id, farm_name, payment_terms').eq('is_active', true).order('farm_name').limit(500),
        // PR-07 follow-up: profile_public_view exposes only id/full_name/role/is_active.
        supabase.from('profile_public_view').select('id, full_name').in('role', ['admin', 'sales_rep']).eq('is_active', true).order('full_name'),
      ]);
      if (custRes.data) setCustomers(custRes.data as Customer[]);
      if (salesRes.data) setSalespeople(salesRes.data as { id: string; full_name: string }[]);
    };
    fetchRef();
  }, []);

  const fetchInvoice = useCallback(async (invoiceId: string) => {
    // Stale-fetch guard: on rapid invoice-to-invoice navigation an older
    // in-flight fetch must not render the previous invoice's amounts.
    const isStale = () => activeInvoiceIdRef.current !== invoiceId;
    setLoading(true);

    // #3 segregation PREFLIGHT (Codex r11): resolve the route-area redirect from a
    // MINIMAL row (invoice_type/job_id/status) BEFORE the full select('*') below, so
    // a cross-permission URL never leaks the forbidden full invoice row in the
    // network response. field invoices live under the field-invoices permission,
    // chemical sales under invoices; a field-invoices-only user opening a chemical
    // invoice id via /field-invoices/:id (or the inverse) must be bounced BEFORE the
    // row is fetched. Mirrors FieldApplicationInvoice's minimal preflight. (Codex R5/R11)
    const pre = await supabase
      .from('invoices')
      .select('invoice_type, job_id, blend_ticket_id, status')
      .eq('id', invoiceId)
      .maybeSingle();
    if (isStale()) return;
    if (pre.error || !pre.data) {
      toast('error', 'Invoice not found');
      navigate('/invoices');
      return;
    }
    {
      const invType = (pre.data as { invoice_type?: string }).invoice_type;
      if (routeArea === 'field' && invType !== 'field_application') {
        toast('error', 'Not a field invoice');
        navigate('/field-invoices', { replace: true });
        return;
      }
      if (routeArea === 'chemical' && invType === 'field_application') {
        navigate(`/field-invoices/${invoiceId}`, { replace: true });
        return;
      }
      // A field invoice with NEITHER job_id NOR blend_ticket_id is ENGINE-built
      // (per-acre, has field_app_locations) — keep an editable one in the per-acre
      // editor, not this quantity-based one, even if reached by a direct URL /
      // bookmark. A blend-ticket field invoice (blend_ticket_id set, job_id NULL)
      // is quantity-based with no locations, so it STAYS in this editor. (Codex r13)
      const fieldJobId = (pre.data as { job_id?: string | null }).job_id;
      const fieldBlendId = (pre.data as { blend_ticket_id?: string | null }).blend_ticket_id;
      const fieldStatus = (pre.data as { status?: string }).status;
      // #A (Codex round-2): this preflight must NOT reference field_app_billing_set_id — an
      // explicit select of a column that only exists after the split migration would 400 every
      // invoice-detail load if the frontend deploys before the migration. A split-child DRAFT is
      // still routed to the per-acre editor here, which (via its own select('*') load, tolerant of
      // the column's absence) redirects it onward to the read-only Split Billing view. A POSTED
      // split child (status not draft/unposted) stays on THIS page and renders read-only from the
      // full select('*') load below (isSplitInvoice), which is deploy-order-safe.
      if (routeArea === 'field' && invType === 'field_application' && !fieldJobId && !fieldBlendId
          && (fieldStatus === 'draft' || fieldStatus === 'unposted')) {
        navigate(`/invoices/field-app/${invoiceId}`, { replace: true });
        return;
      }
    }

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

    // Codex r4 P1: route a DRAFT/UNPOSTED split child to the Split Billing reopen editor so it
    // can be reviewed + Posted, REGARDLESS of job_id. Round-3 P2-1 stamped job_id onto every
    // child, which defeated the no-job preflight redirect above and stranded job-backed split
    // drafts on this generic page with no Post path (save-now/post-later broken). Detected here
    // from the tolerant select('*') load — NOT the preflight, which must stay off the parked
    // field_app_billing_set_id column for deploy-order safety. A POSTED split child still renders
    // read-only on this page (isSplitInvoice), unchanged.
    {
      const splitSetId = (data as { field_app_billing_set_id?: string | null }).field_app_billing_set_id;
      const splitStatus = (data as { status?: string }).status;
      if (splitSetId && (splitStatus === 'draft' || splitStatus === 'unposted')) {
        navigate(`/split-billing/${splitSetId}`, { replace: true });
        return;
      }
    }

    let salesman: { full_name: string } | null = null;
    const salesmanId = (data as { salesman_id?: string | null }).salesman_id;
    if (salesmanId) {
      const { data: smData } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .eq('id', salesmanId)
        .maybeSingle();
      if (smData) salesman = { full_name: smData.full_name ?? '' };
    }
    // Attach salesman in the same shape the JSX consumes (`invoice.salesman?.full_name`).
    (data as Record<string, unknown>).salesman = salesman;

    if (isStale()) return;
    const loadedInvoice = data as Invoice;
    const loadedPaymentTerms = loadedInvoice.payment_terms || '';
    const loadedDueDate = loadedInvoice.due_date || '';
    let customerPaymentTerms = '';
    if (!loadedPaymentTerms.trim() && loadedInvoice.customer_id) {
      const { data: customerTerms } = await supabase
        .from('customers')
        .select('payment_terms')
        .eq('id', loadedInvoice.customer_id)
        .maybeSingle();
      customerPaymentTerms = (customerTerms as { payment_terms?: string | null } | null)?.payment_terms?.trim() || '';
      if (isStale()) return;
    }
    setInvoice(data as object as Invoice);
    const effectivePaymentTerms = loadedPaymentTerms.trim() || customerPaymentTerms;
    const normalizedTerms = effectivePaymentTerms.toLowerCase();
    const isReceiptAlias = ['due on receipt', 'due upon receipt', 'receipt', 'immediately'].includes(normalizedTerms);
    const isPreset = ['Net 30', 'Net 15', 'Net 60', 'Due on receipt'].includes(effectivePaymentTerms);
    const termDays = isReceiptAlias
      ? 0
      : (() => {
          const match = /(\d+)/.exec(effectivePaymentTerms);
          const parsed = match ? Number(match[1]) : NaN;
          return Number.isFinite(parsed) && parsed >= 1 && parsed <= 365 ? parsed : 30;
        })();
    let stampedDate = '';
    if (loadedInvoice.invoice_date) {
      const stamped = new Date(`${loadedInvoice.invoice_date}T00:00:00Z`);
      stamped.setUTCDate(stamped.getUTCDate() + termDays);
      stampedDate = stamped.toISOString().slice(0, 10);
    }
    const isPostingStamp = loadedDueDate !== '' && loadedDueDate === stampedDate;
    const isEditableStatus = ['draft', 'unposted'].includes(loadedInvoice.status || '');
    if (loadedDueDate && !isPostingStamp && isEditableStatus) {
      setPaymentTerms('Custom date…');
      setCustomTermsText(loadedPaymentTerms);
      setCustomDueDate(loadedDueDate);
    } else if (isPreset) {
      setPaymentTerms(loadedPaymentTerms ? effectivePaymentTerms : 'Customer default');
      setCustomTermsText('');
      setCustomDueDate(isPostingStamp && isEditableStatus ? '' : loadedDueDate);
    } else if (isReceiptAlias) {
      setPaymentTerms('Due on receipt');
      setCustomTermsText('');
      setCustomDueDate(isPostingStamp && isEditableStatus ? '' : loadedDueDate);
    } else {
      setPaymentTerms(loadedPaymentTerms || 'Customer default');
      setCustomTermsText('');
      setCustomDueDate(isPostingStamp && isEditableStatus ? '' : loadedDueDate);
    }
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
        ((driverData || []) as { id: string; full_name: string }[]).forEach((p: { id: string; full_name: string }) => { delDriverMap[p.id] = p.full_name; });
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
          order_item_id: (it.order_item_id as string) ?? null,
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
          return_credit_cogs_cents: it.return_credit_cogs_cents != null ? Number(it.return_credit_cogs_cents) : null,
          return_credit_source_item_id: (it.return_credit_source_item_id as string) ?? null,
          is_application_fee: Boolean((it as Record<string, unknown>).is_application_fee),
          rate_unit: ((it as Record<string, unknown>).rate_unit as string) ?? null,
          total_applied: (it as Record<string, unknown>).total_applied != null ? Number((it as Record<string, unknown>).total_applied) : null,
          total_applied_unit: ((it as Record<string, unknown>).total_applied_unit as string) ?? null,
          total_applied_gl_lb: (it as Record<string, unknown>).total_applied_gl_lb != null ? Number((it as Record<string, unknown>).total_applied_gl_lb) : null,
          gl_lb_unit: ((it as Record<string, unknown>).gl_lb_unit as string) ?? null,
          epa_registration: ((it as Record<string, unknown>).epa_registration as string) ?? null,
          product_form: ((it as Record<string, unknown>).product_form as string) ?? null,
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
  }, [toast, navigate, routeArea]);

  // Fetch existing invoice
  useEffect(() => {
    activeInvoiceIdRef.current = id;
    if (!isNew && id) fetchInvoice(id);
  }, [id, isNew, fetchInvoice]);

  // Product search
  const searchProducts = useCallback(async (q: string) => {
    const requestId = ++productSearchRequestRef.current;
    if (q.length < 2) {
      setProductResults([]);
      setProductSearchLoading(false);
      return;
    }
    setProductSearchLoading(true);
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*, product_family:product_families(name)')
        .eq('is_active', true)
        .or(`product_name.ilike.%${q}%,sku.ilike.%${q}%`)
        .order('product_name')
        .limit(20);
      if (requestId !== productSearchRequestRef.current) return;
      if (error) {
        Sentry.captureException(error, { extra: { context: 'search_invoice_products' } });
        toast('error', 'Failed to search Products');
        setProductResults([]);
      } else {
        setProductResults((data || []) as Product[]);
      }
    } catch (error) {
      if (requestId !== productSearchRequestRef.current) return;
      Sentry.captureException(error, { extra: { context: 'search_invoice_products' } });
      toast('error', 'Failed to search Products');
      setProductResults([]);
    } finally {
      if (requestId === productSearchRequestRef.current) setProductSearchLoading(false);
    }
  }, [toast]);

  const clearProductSearch = useCallback(() => {
    productSearchRequestRef.current += 1;
    setProductSearch('');
    setProductResults([]);
    setProductSearchLoading(false);
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
        is_application_fee: false,
        rate_unit: null,
        total_applied: null,
        total_applied_unit: null,
        total_applied_gl_lb: null,
        gl_lb_unit: null,
        epa_registration: null,
        product_form: null,
      },
    ]);
    setShowProductModal(false);
    clearProductSearch();
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
    if (paymentTerms === 'Custom date…' && !customDueDate) {
      toast('error', 'Choose a custom due date before saving.');
      return;
    }
    // Per-line split billing (Codex P1 #6, 2026-07-18): a split child's line detail lives in
    // invoice_line_shares, keyed to invoice_items by billing_line_id. The generic save_invoice
    // deletes + recreates invoice_items, which would CASCADE those shares away and silently
    // destroy the split. Split invoices are only editable from the dedicated Split Billing
    // editor — hard-refuse a save here (defense-in-depth with the read-only UI below).
    if ((invoice as { field_app_billing_set_id?: string | null }).field_app_billing_set_id) {
      toast('error', 'This is a split-billing invoice — open it from the Split Billing editor to make changes.');
      return;
    }
    if (!invoice.customer_id) {
      toast('error', 'Please select a customer');
      return;
    }
    const outcome = await runCriticalAction<'saved' | 'reconciled' | 'blocked'>({
      action: async () => {
        const payload = {
          id: isNew ? undefined : id,
          customer_id: invoice.customer_id,
          // #3 segregation: on the field-invoices route the type is LOCKED to
          // field_application — never let an edit reclassify a field invoice into
          // Chemical Sales (which would move it out of a field-invoices-only
          // user's reach), regardless of the selector (Codex P2).
          invoice_type: routeArea === 'field' ? 'field_application' : (invoice.invoice_type || 'chemical_sale'),
          status: invoice.status || 'draft',
          season: invoice.season,
          salesman_id: invoice.salesman_id || null,
          invoice_date: invoice.invoice_date,
          payment_terms:
            paymentTerms === 'Customer default'
              ? null
              : paymentTerms === 'Custom date…'
                ? customTermsText || 'Custom'
                : paymentTerms,
          due_date: paymentTerms === 'Custom date…' ? customDueDate || null : null,
          purchase_order_ref: invoice.purchase_order_ref || null,
          header_notes: invoice.header_notes || null,
          footer_notes: invoice.footer_notes || null,
        };

        const itemsPayload = items.map((it, idx) => ({
          // Existing generated lines carry their server identity back to the
          // writer so it can preserve immutable order-line and historical-cost
          // lineage while rebuilding a draft invoice. New manual lines omit id.
          id: it.id,
          order_item_id: it.order_item_id,
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
          // Field-application detail preserved through the edit (#3 edit-path) —
          // null/false on chemical-sale lines, so save_invoice stays a no-op for them.
          is_application_fee: it.is_application_fee,
          rate_unit: it.rate_unit,
          total_applied: it.total_applied,
          total_applied_unit: it.total_applied_unit,
          total_applied_gl_lb: it.total_applied_gl_lb,
          gl_lb_unit: it.gl_lb_unit,
          epa_registration: it.epa_registration,
          product_form: it.product_form,
          price_source: it.price_source,
          quoted_price_cents: it.quoted_price_cents,
        }));

        const idemKey = saveIdem.getKey();
        const intent = JSON.stringify({ invoice: payload, items: itemsPayload });
        const capability = await supabase
          .from('idempotency_keys')
          .select('request_fingerprint')
          .limit(1);
        if (capability.error) {
          if (!isMissingIntentBindingColumn(capability.error)) throw capability.error;
          // Frontend-first deployment compatibility: reuse an ambiguous key only
          // for byte-identical input. The old RPC cannot reconcile edited intent.
          if (legacyIntentChanged(legacySaveIntentRef.current, { key: idemKey, intent })) {
            toast('warning', 'The previous save may already have completed. Reload this invoice before submitting different changes.');
            return 'blocked';
          }
          legacySaveIntentRef.current = { key: idemKey, intent };
        }
        const { data, error } = await runWithBelowCostApproval((reason) => supabase.rpc('save_invoice', withBelowCostReason('save_invoice', {
          p_invoice: payload,
          p_items: itemsPayload,
          p_idempotency_key: idemKey,
        }, reason)));

        if (error) {
          const receipt = getIdempotencyMismatchResult(error, 'save_invoice');
          const committedInvoiceId = receipt?.invoice_id;
          if (typeof committedInvoiceId === 'string') {
            saveIdem.resetKey();
            legacySaveIntentRef.current = null;
            await fetchInvoice(committedInvoiceId);
            toast('warning', 'The earlier save already completed. The saved invoice has been reopened so you can review it before making another change.');
            if (id !== committedInvoiceId) {
              navigate(`/invoices/${committedInvoiceId}`, { replace: true });
            }
            return 'reconciled';
          }
          throw error;
        }
        // The key must outlive the result check: assertRpcResult rejects a null reply
        // the server may already have committed, and the retry has to travel under the
        // SAME key so save_invoice can replay it.
        //
        // save_invoice RETURNS the invoice id for edits as well as creates, so the
        // reply is validated unconditionally. Validating only the isNew arm left every
        // EDIT retiring its key on a null reply and reporting "saved" — the original F1
        // failure mode, preserved (Codex HIGH, 2026-09-03).
        const savedId = assertRpcResult<string>(data, 'save_invoice');
        saveIdem.resetKey();
        legacySaveIntentRef.current = null;
        if (isNew) {
          navigate(`/invoices/${savedId}`, { replace: true });
        } else {
          await fetchInvoice(id!);
        }
        return 'saved';
      },
      toast,
      setLoading: setSaving,
      sentryTag: 'save_invoice',
    });
    if (outcome === 'saved') {
      toast('success', isNew ? 'Invoice created' : 'Invoice saved');
    }
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
          p_performed_by: (profile?.id ?? null) as string,
          p_idempotency_key: idemKey,
        });
        if (error) throw error;
        assertRpcResult(data, 'post_invoice_group');
      } else {
        // post_invoice RETURNS void — use .throwOnError() (no `=` capture).
        await supabase.rpc('post_invoice', { p_invoice_id: id!, p_idempotency_key: idemKey }).throwOnError();
      }
      postIdem.resetKey();
      toast('success', invoice.invoice_group_id ? 'Invoice group posted' : 'Invoice posted');
      fetchInvoice(id!);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        extra: { context: invoice.invoice_group_id ? 'post_invoice_group' : 'post_invoice' },
      });
      // This is the single-invoice posting flow, so it must speak the same
      // language as the batch screens: a deliberate billing gate explains what
      // to do next, anything else falls through to sanitizeError.
      const blocked = describePostInvoiceBlock(err);
      toast('error', blocked ?? sanitizeError(err));
    }
    setPosting(false);
  };

  // Void invoice
  const handleVoid = async () => {
    setVoiding(true);
    let voidedGroup = false;
    try {
      const idemKey = voidIdem.getKey();
      // invoice_group_id is shared by governed order splits and field-application
      // customer groups. Try the ordinary lifecycle first; the database tells us
      // when this exact invoice has private split provenance and therefore must be
      // voided atomically with every governed sibling.
      const { data: invoiceVoidData, error: invoiceVoidError } = await supabase.rpc('void_invoice', {
        p_invoice_id: id!,
        p_void_reason: voidReason || 'Voided by admin',
        p_idempotency_key: idemKey,
      });
      // The canonical RPC currently RETURNS void (null). Keep the ordinary error
      // check above, while still validating any future non-null return contract.
      if (!invoiceVoidError && invoiceVoidData !== null) {
        assertRpcResult(invoiceVoidData, 'void_invoice');
      }
      const requiresGovernedGroupVoid = Boolean(
        invoiceVoidError
        && invoice.invoice_group_id
        && [invoiceVoidError.message, invoiceVoidError.details, invoiceVoidError.hint, invoiceVoidError.code]
          .filter(Boolean)
          .join(' ')
          .includes('SPLIT_INVOICE_GROUP_VOID_REQUIRED'),
      );

      if (requiresGovernedGroupVoid) {
        const { data, error } = await supabase.rpc('void_invoice_group', {
          p_invoice_group_id: invoice.invoice_group_id!,
          p_void_reason: voidReason || 'Voided by admin',
          p_idempotency_key: idemKey,
        });
        if (error) throw error;
        const memberCount = assertRpcResult<number>(data, 'void_invoice_group');
        if (memberCount < 1) throw new Error('void_invoice_group voided no invoices');
        voidedGroup = true;
      } else if (invoiceVoidError) {
        throw invoiceVoidError;
      }
      voidIdem.resetKey();
      toast('success', voidedGroup ? 'Invoice group voided' : 'Invoice voided');
      setShowVoidModal(false);
      fetchInvoice(id!);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        extra: { context: voidedGroup ? 'void_invoice_group' : 'void_invoice' },
      });
      toast('error', sanitizeError(err));
    }
    setVoiding(false);
  };

  // #28/U16b: Unpost invoice — reverse a posting (posted/overdue -> unposted) on a
  // field-application or chemical-sale invoice, returning it to the editable Unposted
  // list. The RPC refuses a paid/voided invoice, one with payments/prepay applied, or
  // one in a closed accounting period — surfaced here as a toast.
  // FIX 4 (Wave 2a): a SPLIT GROUP routes through unpost_invoice_group, which unposts
  // ALL members in ONE transaction (all-or-nothing) — a single in-JS member loop could
  // leave a half-unposted group. A single invoice still uses unpost_invoice.
  const handleUnpost = async () => {
    if (!id || !profile) return;
    setUnposting(true);
    try {
      if (invoice.invoice_group_id) {
        // Per-GROUP key (keyed by invoice_group_id) so a retry reuses the same key while a
        // different group always gets its own — no cross-group replay (the server also
        // rejects a mismatched-group replay as a backstop). Cleared on success.
        const groupKeyId = `grp:${invoice.invoice_group_id}`;
        if (!unpostKeysRef.current[groupKeyId]) {
          unpostKeysRef.current[groupKeyId] = generateIdempotencyKey('unpost_invoice_group', `${profile.id}:${invoice.invoice_group_id}`);
        }
        const { data, error } = await supabase.rpc('unpost_invoice_group', {
          p_invoice_group_id: invoice.invoice_group_id,
          p_performed_by: profile.id,
          p_idempotency_key: unpostKeysRef.current[groupKeyId],
        });
        if (error) throw error;
        assertRpcResult(data, 'unpost_invoice_group');
        delete unpostKeysRef.current[groupKeyId];
        toast('success', 'Invoice group unposted');
      } else {
        if (!unpostKeysRef.current[id]) {
          unpostKeysRef.current[id] = generateIdempotencyKey('unpost_invoice', `${profile.id}:${id}`);
        }
        const { data, error } = await supabase.rpc('unpost_invoice', {
          p_invoice_id: id,
          p_performed_by: profile.id,
          p_idempotency_key: unpostKeysRef.current[id],
        });
        if (error) throw error;
        assertRpcResult(data, 'unpost_invoice');
        delete unpostKeysRef.current[id];
        toast('success', 'Invoice unposted');
      }
      setShowUnpostModal(false);
      fetchInvoice(id);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        extra: { context: invoice.invoice_group_id ? 'unpost_invoice_group' : 'unpost_invoice' },
      });
      toast('error', sanitizeError(err));
    } finally {
      setUnposting(false);
    }
  };

  // #27: Transfer back to Scheduling — the reverse of transfer_job_to_invoice.
  // Cancels this draft/unposted job-built field invoice (deletes its items + shares,
  // detaches the as-applied records) and returns the source job to 'completed' so it
  // can be re-worked / re-transferred. Idempotent (a double click / retry returns the
  // saved result, never double-reverses). The RPC also refuses a posted/paid invoice
  // with a plain-English message (the button is only shown for an editable one).
  const handleTransferToScheduling = async () => {
    if (!id || !profile || !invoice.job_id) return;
    setTransferringToScheduling(true);
    try {
      const idemKey = transferToSchedulingIdem.getKey();
      const { data, error } = await supabase.rpc('transfer_invoice_to_job', {
        p_invoice_id: id,
        p_performed_by: profile.id,
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const result = assertRpcResult<{ job_id: string; job_number: string }>(data, 'transfer_invoice_to_job');
      transferToSchedulingIdem.resetKey();
      setShowTransferToSchedulingModal(false);
      toast('success', `Invoice returned to scheduling — job ${result.job_number} reopened`);
      navigate(`/jobs/${result.job_id}`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'transfer_invoice_to_job' } });
      toast('error', sanitizeError(err));
    }
    setTransferringToScheduling(false);
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
    if (amountCents === null) {
      toast('error', MONEY_PRECISION_MESSAGE);
      return;
    }
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
      // Overpay -> prepay credit (parity with the Payments/allocation screen): cap this
      // invoice's allocation at its own balance and let allocate_payment bank any excess as
      // a prepay credit, instead of rejecting the whole payment for exceeding the balance.
      const allocCents = Math.min(amountCents, invoice.balance_cents || 0);
      const { data, error } = await supabase.rpc('allocate_payment', {
        p_customer_id: invoice.customer_id,
        p_total_cents: amountCents,
        p_payment_method: payMethod,
        p_reference_number: payRef || undefined,
        p_notes: payNotes || undefined,
        p_allocations: allocCents > 0 ? [{ invoice_id: id, amount_cents: allocCents }] : [],
        p_idempotency_key: idemKey,
      });
      if (error) throw error;
      const allocResult = assertRpcResult<{
        success: boolean;
        allocation_set_id: string;
        total_allocated_cents: number;
        prepay_created_cents: number;
        invoices_paid: number;
      }>(data, 'allocate_payment');
      payIdem.resetKey();
      const payMsgParts = [`Payment of ${fmt(amountCents)} recorded`];
      if (allocResult.prepay_created_cents > 0) {
        payMsgParts.push(`${fmt(allocResult.prepay_created_cents)} added as prepay credit`);
      }
      toast('success', payMsgParts.join('. '));
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

  // Apply a credit memo to THIS open invoice. Loads the customer's available (posted, negative-
  // balance) credit memos, then calls apply_credit_memo_to_invoice — net-zero: it lowers this
  // invoice's balance and consumes the credit, flipping the invoice to paid when it hits 0.
  const openApplyCredit = async () => {
    if (!invoice?.customer_id) { toast('error', 'This invoice has no customer linked'); return; }
    const { data, error } = await supabase
      .from('invoices')
      .select('id, invoice_number, balance_cents')
      .eq('customer_id', invoice.customer_id)
      .eq('invoice_type', 'credit_memo')
      .eq('status', 'posted')
      .lt('balance_cents', 0)
      .is('deleted_at', null)
      .order('invoice_date', { ascending: true });
    if (error) { toast('error', sanitizeError(error)); return; }
    let credits = (data || []) as Array<{ id: string; invoice_number: string; balance_cents: number }>;
    const unresolved = unresolvedApplyCreditIntent?.targetInvoiceId === id
      ? unresolvedApplyCreditIntent
      : null;
    if (unresolved) {
      const currentMemo = credits.find((credit) => credit.id === unresolved.creditMemoId);
      if (!currentMemo) {
        credits = [{
          id: unresolved.creditMemoId,
          invoice_number: unresolved.creditMemoNumber,
          balance_cents: -unresolved.amountCents,
        }, ...credits];
      }
      setAvailableCredits(credits);
      setSelectedCreditId(unresolved.creditMemoId);
      setApplyCreditAmount((unresolved.amountCents / 100).toFixed(2));
      setShowApplyCreditModal(true);
      return;
    }
    if (credits.length === 0) { toast('info', 'This customer has no available credit memos to apply'); return; }
    const first = credits[0];
    setAvailableCredits(credits);
    setSelectedCreditId(first.id);
    // default the amount to the smaller of the credit's available balance and what this invoice owes
    setApplyCreditAmount((Math.min(-first.balance_cents, invoice.balance_cents || 0) / 100).toFixed(2));
    setShowApplyCreditModal(true);
  };

  const handleApplyCredit = async () => {
    const amountCents = parseDollarsToCents(applyCreditAmount);
    if (amountCents === null) { toast('error', MONEY_PRECISION_MESSAGE); return; }
    if (amountCents <= 0) { toast('error', 'Enter a valid amount to apply'); return; }
    if (!selectedCreditId) { toast('error', 'Select a credit memo to apply'); return; }
    if (!profile) { toast('error', 'Cannot apply credit — profile not loaded. Please refresh.'); return; }
    const creditMemoNumber = availableCredits.find((credit) => credit.id === selectedCreditId)?.invoice_number
      || selectedCreditId;
    setUnresolvedApplyCreditIntent({
      creditMemoId: selectedCreditId,
      creditMemoNumber,
      targetInvoiceId: id!,
      amountCents,
    });
    setApplyingCredit(true);
    try {
      const key = applyCreditIdem.getKey();
      const { data, error } = await supabase.rpc('apply_credit_memo_to_invoice', {
        p_credit_memo_id: selectedCreditId,
        p_target_invoice_id: id!,
        p_amount_cents: amountCents,
        p_performed_by: profile.id,
        p_idempotency_key: key,
      });
      if (error) throw error;
      assertRpcResult(data, 'apply_credit_memo_to_invoice');
      applyCreditIdem.resetKey();
      setUnresolvedApplyCreditIntent(null);
      toast('success', `Applied ${fmt(amountCents)} credit to this invoice`);
      setShowApplyCreditModal(false);
      setSelectedCreditId('');
      setApplyCreditAmount('');
      if (id) fetchInvoice(id);
    } catch (err: unknown) {
      if (isDefinitiveRpcRejection(err)) {
        applyCreditIdem.resetKey();
        setUnresolvedApplyCreditIntent(null);
      }
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'apply_credit_memo_to_invoice' } });
      toast('error', sanitizeError(err));
    }
    setApplyingCredit(false);
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
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'reverse_write_off' } });
      toast('error', sanitizeError(err));
    }
    setReversingWo(false);
  };

  // Build PDF data object (shared by print + email)
  const buildInvoicePdfData = async (options?: InvoicePrintOptions): Promise<InvoicePdfData> => {
    const { data: enrichedItems } = await supabase
      .from('invoice_items')
      .select('*, product:products(product_name, epa_registration, product_form)')
      .eq('invoice_id', id!)
      .order('sort_order');

    const cust = customers.find(c => c.id === invoice.customer_id);

    // ChemMan Gap-Closeout #2: wire the persisted diluent / carrier-water RATE
    // (gal/acre) into the PDF for a POSTED field-application invoice opened here
    // (/field-invoices/:id), so Print/Email from this detail page shows the same
    // "Diluent / Carrier Water" line the editor and list/email paths already print.
    // Only populate for field_application — the renderer omits the line when
    // diluent_gpa is absent, so a chemical-sale invoice (diluent_rate_gpa null/
    // absent) correctly never shows it. The renderer derives the TOTAL from
    // total_acres; invoice.total_acres is not reliably written on save, so when it
    // is null we fall back to the SHARED group-aware field_app_locations derivation
    // (same helper buildInvoicePdfDataFromRow uses) so the total matches every path.
    const isFieldApp = invoice.invoice_type === 'field_application';
    const diluentRate = isFieldApp ? (invoice.diluent_rate_gpa ?? undefined) : undefined;
    let diluentAcres = invoice.total_acres || undefined;
    if (diluentRate != null && (diluentAcres == null || diluentAcres <= 0)) {
      const derived = await deriveFieldAppAppliedAcres(id!, invoice.invoice_group_id ?? null);
      if (derived != null) diluentAcres = derived;
    }

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
      payment_terms: invoice.payment_terms || cust?.payment_terms || undefined,
      salesman_name: salespeople.find((s) => s.id === invoice.salesman_id)?.full_name,
      purchase_order_ref: invoice.purchase_order_ref || undefined,
      header_notes: invoice.header_notes || undefined,
      footer_notes: invoice.footer_notes || undefined,
      crop_type: invoice.crop_type || undefined,
      field_names: invoice.field_names || undefined,
      total_acres: diluentAcres,
      applicator_name: invoice.applicator_name || undefined,
      vehicle_name: invoice.vehicle_name || undefined,
      application_date: invoice.application_date || undefined,
      // #2: diluent / carrier-water rate (gal/acre); renderer derives the total
      // from total_acres above. Absent for non-field invoices → line omitted.
      diluent_gpa: diluentRate,
      shares: shares.length > 0 ? shares.map(s => ({
        customer_name: s.customer_name,
        split_percentage: s.split_percentage,
        acres: s.acres,
        amount_cents: s.amount_cents,
      })) : undefined,
      items: groupReturnCreditDisplayItems(invoice.invoice_type, (enrichedItems || []).map(mapInvoicePdfItem)),
      total_amount_cents: invoice.total_amount_cents ?? items.reduce((s, i) => s + i.extended_cents, 0),
      total_cost_cents: invoice.total_cost_cents ?? items.reduce((s, i) => s + (i.is_application_fee ? i.cost_cents : Math.round(i.cost_cents * i.quantity)), 0),
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
    if (isInvoiceEmailSuppressed(invoice)) {
      toast('info', 'This $0 invoice is recorded and shown in the account summary, but is not emailed.');
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

        await assertInvoiceSendable(id!);
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
  // Split-billing invoices are managed only from the Split Billing editor; keep this
  // generic page strictly read-only for them so a save can't cascade away their line
  // shares (Codex P1 #6). Paired with the hard guard in handleSave.
  const isSplitInvoice = !!(invoice as { field_app_billing_set_id?: string | null }).field_app_billing_set_id;
  const canEdit = isAdminOrRep;
  const editable = canEdit && !isSplitInvoice && (isNew || ['draft', 'unposted'].includes(invoice.status || ''));
  const storedTotalCostCents = (invoice as { total_cost_cents?: number | null }).total_cost_cents;
  // Total Cost / Margin:
  // - Split invoice (Codex r5 P2): chemical items store PER-UNIT cost, but the header
  //   total_cost_cents holds the penny-exact largest-remainder-allocated COGS — recomputing
  //   cost_cents*quantity here would mis-display it (1¢ cost split 50/50 shows 1¢+1¢ vs the
  //   authoritative 1¢+0¢). Use the header total.
  // - Protected return credits also use the stored header because their grouped fractional lines
  //   telescope to the original penny-exact COGS. Recomputing each line can differ by one cent.
  // - Otherwise mirror save_invoice DELTA-E: a machine-fee line stores its EXACT extended cost
  //   (its quantity is acres, not a multiplier), so add it as-is; product lines store a per-unit
  //   cost -> x quantity. Using x quantity for the fee line would inflate Total Cost by acres.
  const isProtectedReturnCredit = invoice.invoice_type === 'credit_memo'
    && !editable
    && items.some((item) => item.return_credit_source_item_id != null || item.return_credit_cogs_cents != null);
  const totalCostCents = isSplitInvoice
    ? Number(storedTotalCostCents ?? 0)
    : isProtectedReturnCredit && storedTotalCostCents != null
      ? Number(storedTotalCostCents)
      : items.reduce((s, i) => s + (i.is_application_fee ? i.cost_cents : i.cost_cents * i.quantity), 0);
  const displayItems = editable
    ? items
    : groupReturnCreditDisplayItems(invoice.invoice_type, items);

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
          {isSplitInvoice && (
            <span className="inline-flex items-center text-xs bg-amber-50 text-amber-700 px-2.5 py-1 rounded-md">
              Read-only — this per-line split invoice is managed from the Split Billing editor.
            </span>
          )}
          <GuardrailBanner warning={creditWarning} onDismiss={dismissCreditWarning} />
          {!isNew && editable && isAdminOrRep && (
            <Button variant="secondary" icon={<Send className="w-4 h-4" />} onClick={openPostConfirm} loading={posting}>
              Post
            </Button>
          )}
          {/* #27: reverse Transfer to Scheduling — only for an editable (draft/unposted)
              field invoice that came from a job. Pushes the invoice back to the job. */}
          {!isNew && editable && invoice.invoice_type === 'field_application' && invoice.job_id && (
            <Button
              variant="secondary"
              icon={<RotateCcw className="w-4 h-4" />}
              onClick={() => setShowTransferToSchedulingModal(true)}
              loading={transferringToScheduling}
              disabled={transferringToScheduling}
              showChevron={false}
            >
              Transfer to Scheduling
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
          {/* Email gate:
                • Chemical-sale invoices keep the existing policy — posted + admin only.
                • #31 field-application parity: a transferred field invoice opens HERE
                  (it has job_id but no field_app_locations), and ChemMan emails the bill
                  from the field-app screens for unposted invoices and by sales reps too.
                  So for invoice_type='field_application' surface Email on any saved,
                  non-terminal invoice (draft/unposted/posted/overdue/paid) for admin +
                  sales rep — matching the field-app editor/list Email actions. */}
          {!isNew && (
            invoice.invoice_type === 'field_application'
              ? !['voided', 'cancelled'].includes(invoice.status || '')
              : (invoice.status === 'posted' && isAdmin)
          ) && (
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
          {/* U1 (#41): posted OR overdue — an overdue invoice is the one a check most
              often arrives for; allocate_payment and apply_write_off both accept it. */}
          {!isNew && (invoice.status === 'posted' || invoice.status === 'overdue') && isAdmin && (
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
          {/* Apply Credit (credit-memo apply, 2026-07-10): admin+sales_rep, on a posted/overdue
              non-credit invoice that still owes — put an available same-customer credit memo
              against it. */}
          {!isNew && invoice.invoice_type !== 'credit_memo'
            && (invoice.status === 'posted' || invoice.status === 'overdue')
            && (invoice.balance_cents || 0) > 0 && isAdminOrRep && (
              <Button
                variant="secondary"
                icon={<RotateCcw className="w-4 h-4" />}
                onClick={openApplyCredit}
                showChevron={false}
              >
                Apply Credit
              </Button>
          )}
          {/* #28/U16b: Unpost — reverse a posting on a field-application or chemical-sale
              invoice back to the Unposted list. Posted/overdue only; the RPC refuses one
              with payments/prepay or in a closed period.
              U16b: explicitly gated to admin/sales_rep, matching the RPC. (Void stays
              admin-only below.) */}
          {!isNew && (invoice.invoice_type === 'field_application' || invoice.invoice_type === 'chemical_sale')
            && (invoice.status === 'posted' || invoice.status === 'overdue') && isAdminOrRep && (
              <Button
                variant="secondary"
                icon={<RotateCcw className="w-4 h-4" />}
                onClick={() => setShowUnpostModal(true)}
                loading={unposting}
                disabled={unposting}
                showChevron={false}
              >
                Unpost
              </Button>
          )}
          {!isNew && invoice.status === 'posted' && isAdmin && (
              <Button variant="ghost" icon={<Ban className="w-4 h-4" />} onClick={() => { voidIdem.resetKey(); setShowVoidModal(true); }}>
                Void
              </Button>
          )}
        </div>
      </div>

      {/* §2 Watchdog — inline advisory flags for this invoice (double-bill) and its
          source job (acre/rate/REI). Auto-refreshes the source job's flags on open. */}
      {!isNew && id && (
        <WatchdogFlagBanner
          invoiceId={id}
          jobId={invoice.job_id ?? undefined}
          autoRefresh
        />
      )}

      {/* Invoice Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <h2 className="text-sm font-semibold text-nav-dark mb-4">Invoice Details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Customer — read-only on the segregated field route (Codex): a field
                 invoice's customer is job-derived and mirrored in the share ledger;
                 it can't be changed here (save_invoice also locks it server-side). */}
            <div className="col-span-2 relative">
              <label className="text-sm font-medium text-nav-dark">Customer *</label>
              {editable && routeArea !== 'field' ? (
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

            {/* Type — locked to a read-only label on the segregated field route
                 (Codex P2): a field invoice must not be reclassified to Chemical
                 Sales from the field-invoices area. A new misc-charge entry is
                 locked in the selector below. */}
            <div>
              <label className="text-sm font-medium text-nav-dark">Invoice Type</label>
              {editable && routeArea !== 'field' ? (
                <select
                  value={invoice.invoice_type || 'chemical_sale'}
                  onChange={(e) => setInvoice((prev) => ({ ...prev, invoice_type: e.target.value as InvoiceType }))}
                  disabled={isInvoiceTypeLocked}
                  className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="chemical_sale">Chemical Sale</option>
                  {/* field_application is NOT selectable here — this editable
                      selector only renders on the chemical route (the field route
                      is read-only), and a chemical invoice must not be reclassified
                      into the segregated field area (Codex). Field invoices are
                      created from jobs / the field-app editor, never here. */}
                  <option value="misc_charge">Misc Charge</option>
                </select>
              ) : (
                <p className="mt-1 text-sm capitalize">{(invoice.invoice_type || '').replace(/_/g, ' ')}</p>
              )}
              {isInvoiceTypeLocked && (
                <p className="mt-1 text-sm text-gray-500">Locked — orderless Misc Charges cannot be reclassified</p>
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

            {/* Payment terms — follows the field-application invoice picker. */}
            <div>
              <label htmlFor="payment-terms" className="text-sm font-medium text-nav-dark">Payment Terms</label>
              {editable ? (
                <>
                  <select
                    id="payment-terms"
                    value={paymentTerms}
                    onChange={(e) => {
                      setPaymentTerms(e.target.value);
                      if (e.target.value !== 'Custom date…') setCustomDueDate('');
                    }}
                    className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="Customer default">Customer default</option>
                    <option value="Net 30">Net 30</option>
                    <option value="Net 15">Net 15</option>
                    <option value="Net 60">Net 60</option>
                    <option value="Due on receipt">Due on receipt</option>
                    {!['Customer default', 'Net 30', 'Net 15', 'Net 60', 'Due on receipt', 'Custom date…'].includes(paymentTerms) && (
                      <option value={paymentTerms}>{paymentTerms} (legacy)</option>
                    )}
                    <option value="Custom date…">Custom date…</option>
                  </select>
                  {paymentTerms === 'Custom date…' && (
                    <input
                      id="custom-due-date"
                      type="date"
                      value={customDueDate}
                      onChange={(e) => setCustomDueDate(e.target.value)}
                      required
                      className="mt-2 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                    />
                  )}
                </>
              ) : (
                <p className="mt-1 text-sm">
                  {invoice.payment_terms || 'Customer default'}
                  {invoice.due_date ? ` · Due ${new Date(invoice.due_date + 'T00:00:00').toLocaleDateString()}` : ''}
                </p>
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

        {displayItems.length === 0 ? (
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
                  {displayItems.some((i) => i.tote_number) && (
                    <th className="pb-2 pr-4">Tote #</th>
                  )}
                  <th className="pb-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {displayItems.map((item, idx) => (
                  <tr key={idx} className="group">
                    <td className="py-2 pr-4">
                      <div className="font-medium text-nav-dark">{item.product_name || item.description}</div>
                      {item.unit_size && (
                        <div className="text-xs text-secondary">{item.unit_size}</div>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {editable && !item.billing_line_id ? (
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
                      {editable && !item.billing_line_id ? (
                        <input
                          type="number"
                          value={(item.unit_price_cents / 100).toFixed(2)}
                          onChange={(e) => {
                            const cents = parseDollarsToCents(e.target.value);
                            // null = a third decimal digit. Refuse the keystroke; never store
                            // a $0 unit price that only the below-cost prompt would question.
                            if (cents === null) { toast('error', MONEY_PRECISION_MESSAGE); return; }
                            updateItem(idx, 'unit_price_cents', cents);
                          }}
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
                    {displayItems.some((i) => i.tote_number) && (
                      <td className="py-2 pr-4 text-secondary">{item.tote_number || '-'}</td>
                    )}
                    <td className="py-2">
                      {editable && !item.billing_line_id && (
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
                  <td className="pt-3" colSpan={displayItems.some((i) => i.tote_number) ? 4 : 3}>
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
      <Modal open={showProductModal} onClose={() => { setShowProductModal(false); clearProductSearch(); }} title="Add Product" size="large">
        <div className="space-y-4">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search products by name or SKU..."
              value={productSearch}
              onChange={(e) => {
                const nextQuery = e.target.value;
                productSearchRequestRef.current += 1;
                setProductSearch(nextQuery);
                setProductResults([]);
                setProductSearchLoading(nextQuery.length >= 2);
              }}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- search input in just-opened picker; user expects to type immediately
              autoFocus
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          {productSearchLoading ? (
            <p className="text-sm text-secondary text-center py-4">Searching Products...</p>
          ) : productResults.length > 0 ? (
            <div className="max-h-60 overflow-auto divide-y divide-gray-50">
              {productResults.map((p) => (
                <ProductSearchResultRow key={p.id} product={p} onClick={() => addProduct(p)} trailing={<><div>T1: ${(p.tier1_price || 0).toFixed(2)}</div><div>Cost: ${(p.current_cost || 0).toFixed(2)}</div></>} />
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

      {/* Apply Credit Memo Modal (credit-memo apply, 2026-07-10) */}
      <Modal
        open={showApplyCreditModal}
        onClose={() => { if (!applyingCredit) setShowApplyCreditModal(false); }}
        title="Apply Credit Memo"
        closeDisabled={applyingCredit}
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-nav-dark">Credit Memo</label>
            <select
              aria-label="Credit Memo"
              value={selectedCreditId}
              disabled={applyingCredit || Boolean(unresolvedApplyCreditIntent)}
              onChange={(e) => {
                const c = availableCredits.find((x) => x.id === e.target.value);
                setSelectedCreditId(e.target.value);
                if (c) setApplyCreditAmount((Math.min(-c.balance_cents, invoice?.balance_cents || 0) / 100).toFixed(2));
              }}
              className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              {availableCredits.map((c) => (
                <option key={c.id} value={c.id}>{c.invoice_number} — {fmt(-c.balance_cents)} available</option>
              ))}
            </select>
          </div>
          <Input
            label="Amount to apply ($)"
            type="number"
            value={applyCreditAmount}
            onChange={(e) => setApplyCreditAmount(e.target.value)}
            min={0}
            step={0.01}
            disabled={applyingCredit || Boolean(unresolvedApplyCreditIntent)}
          />
          {unresolvedApplyCreditIntent && (
            <p className="text-xs text-amber-700">
              The previous response was not confirmed. Retry this exact memo and amount so the server can replay the original result safely.
            </p>
          )}
          <p className="text-xs text-gray-500">
            This invoice owes {fmt(invoice?.balance_cents || 0)}. Applying a credit lowers the balance — it doesn&apos;t move money.
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setShowApplyCreditModal(false)} disabled={applyingCredit}>Cancel</Button>
            <Button onClick={handleApplyCredit} loading={applyingCredit} disabled={!selectedCreditId}>Apply Credit</Button>
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
        message={rupPostWarning
          ? `${rupPostWarning} Post this invoice anyway? This will lock amounts and start AR aging.`
          : 'Post this invoice? This will lock amounts and start AR aging.'}
        confirmLabel="Post Invoice"
        variant={rupPostWarning ? 'danger' : 'warning'}
        icon={AlertTriangle}
        loading={posting}
      />

      {/* #27: reverse Transfer to Scheduling confirm */}
      <ConfirmModal
        open={showTransferToSchedulingModal}
        onClose={() => setShowTransferToSchedulingModal(false)}
        onConfirm={handleTransferToScheduling}
        title="Transfer to Scheduling"
        message="Return this invoice to its source job? This cancels the invoice (its line items and customer shares are removed) and returns the job to Completed so it can be re-invoiced or cancelled. Only works on an unposted invoice."
        confirmLabel="Transfer to Scheduling"
        variant="info"
        icon={RotateCcw}
        loading={transferringToScheduling}
      />

      {/* #28/U16b: Unpost confirm — reverse a posting back to the Unposted list. */}
      <ConfirmModal
        open={showUnpostModal}
        onClose={() => setShowUnpostModal(false)}
        onConfirm={handleUnpost}
        title={invoice.invoice_group_id ? 'Unpost Invoice Group' : 'Unpost Invoice'}
        message={
          (invoice.invoice_group_id
            ? 'Return every posted invoice in this split group to the Unposted list? '
            : 'Return this invoice to the Unposted list? ') +
          'This reverses the posting so it becomes editable again and updates the affected month-end batch totals. An invoice with payments or prepay applied, or one in a closed accounting period, cannot be unposted.'
        }
        confirmLabel={invoice.invoice_group_id ? 'Unpost Group' : 'Unpost Invoice'}
        variant="warning"
        icon={RotateCcw}
        loading={unposting}
      />
    </div>
  );
}
