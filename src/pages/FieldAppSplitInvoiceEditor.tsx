import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Plus, Trash2, Save, Send, SlidersHorizontal, Calculator, Info, Ban,
} from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import ConfirmModal from '../components/ui/ConfirmModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, supabaseUntyped, assertRpcResult, sanitizeError } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { formatCents } from '../lib/money';
import { parseDollarsToCents } from '../lib/parseCents';
import { SPLIT_BILLING_SETTING_KEY, parseSplitBillingEnabled } from '../lib/splitBillingSetting';
import { percentStringsToMicro } from '../lib/perLineSplitBillingUi';

/**
 * Per-line split-billing EDITOR (flag-gated, OFF by default).
 *
 * MONEY-SAFETY: the browser NEVER computes the authoritative per-customer cents.
 * The penny-exact split is produced by the SQL engine (save_field_app_invoice_per_line);
 * pre-save we only ever show the SOURCE line total (qty*price or flat) clearly labelled
 * as an estimate. After a save we RELOAD and display the server-written amounts.
 *
 * Behaviour-neutral when the flag is OFF: this page renders a "not enabled" notice and
 * the nav link is hidden (Sidebar reads the same flag), so a hand-typed URL is safe.
 */

// UI line kinds this editor can create (fuel_surcharge exists server-side but is not
// creatable here per the build spec).
type LineKindUI = 'chemical' | 'service' | 'flat_fee';

interface Member {
  customer_id: string;
  micro_pct: number; // default vector, integer micro-percent (100000000 = 100%)
}

interface ShareDraft {
  customer_id: string;
  pct: string; // editable percent string
  override: boolean;
  overridePriceDollars: string;
}

interface LineDraft {
  uid: string;
  line_kind: LineKindUI;
  product_id: string;
  job_chemical_id?: string;
  application_service_id: string;
  description: string;
  quantity: string; // chemical: total applied quantity
  unitPriceDollars: string; // chemical: dollars/unit (stored as cents)
  flatDollars: string; // flat_fee: dollars (stored as cents)
  rateUnit: string;
  customized: boolean; // when true, send an explicit COMPLETE shares vector
  shares: ShareDraft[];
}

interface FieldPick {
  field_id: string;
  field_name: string;
  applied_acres: string;
  total_acres: number;
}

interface FieldOption {
  id: string;
  field_name: string;
  total_acres: number;
}

interface ProductOption {
  id: string;
  product_name: string;
}

interface ServiceOption {
  id: string;
  name: string;
  default_rate_per_acre_cents: number;
}

interface JobOption {
  id: string;
  label: string;
}

interface ResultInvoice {
  id: string;
  invoice_number: string | null;
  customer_id: string;
  total_amount_cents: number;
  send_disposition: 'sendable' | 'suppressed_zero_total';
  status: string;
}

interface ResultShare {
  invoice_id: string;
  customer_id: string;
  description: string;
  unit_price_cents: number;
  amount_cents: number;
}

let uidCounter = 0;
function nextUid(): string {
  uidCounter += 1;
  return `line_${uidCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultSharesFromMembers(members: Member[]): ShareDraft[] {
  return members.map((m) => ({
    customer_id: m.customer_id,
    pct: (m.micro_pct / 1_000_000).toString(),
    override: false,
    overridePriceDollars: '',
  }));
}

function dollarsToCents(raw: string): number | null {
  // "Not entered" stays null (drives the "no unit price" validation); otherwise parse
  // via the canonical string-based parser — NOT parseFloat — so scientific notation
  // ("1e5" -> $100k), multi-dot, and negatives can't leak a wrong authoritative money
  // value into the save RPC. parseDollarsToCents is positive-only and returns cents.
  if (raw == null || raw.trim() === '') return null;
  return parseDollarsToCents(raw);
}

/** A missing-function / schema-cache error means the split-billing migrations are not
 *  applied yet — surface a plain, non-alarming message instead of a raw Postgres error. */
function splitBackendError(err: unknown): string {
  let msg = '';
  if (err instanceof Error) msg = err.message;
  else if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    msg = (err as { message: string }).message;
  } else msg = String(err ?? '');
  if (/does not exist|schema cache|could not find|PGRST202|42883|find the function/i.test(msg)) {
    return 'Split billing backend not enabled yet.';
  }
  return sanitizeError(err);
}

export default function FieldAppSplitInvoiceEditor() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();

  const saveIdem = useIdempotencyKey('save_field_app_invoice_per_line', profile?.id || '');
  const postIdem = useIdempotencyKey('post_invoice_group', profile?.id || '');
  const postSingleIdem = useIdempotencyKey('post_invoice', profile?.id || '');

  // Flag gate: null = still reading, false = OFF (render notice), true = ON (render editor).
  const [flagEnabled, setFlagEnabled] = useState<boolean | null>(null);

  // Picker data
  const [fieldOptions, setFieldOptions] = useState<FieldOption[]>([]);
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [serviceOptions, setServiceOptions] = useState<ServiceOption[]>([]);
  const [jobOptions, setJobOptions] = useState<JobOption[]>([]);

  // Header + selection
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [headerNotes, setHeaderNotes] = useState('');
  const [sourceJobId, setSourceJobId] = useState('');
  const [fields, setFields] = useState<FieldPick[]>([]);
  const [addFieldId, setAddFieldId] = useState('');

  // Resolved default split + customer names
  const [members, setMembers] = useState<Member[]>([]);
  const [customerNames, setCustomerNames] = useState<Record<string, string>>({});
  const [resolving, setResolving] = useState(false);

  // Lines
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Save / post state + results
  const [billingSetId, setBillingSetId] = useState<string | null>(null);
  const [invoiceGroupId, setInvoiceGroupId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [showPostConfirm, setShowPostConfirm] = useState(false);
  const [resultInvoices, setResultInvoices] = useState<ResultInvoice[]>([]);
  const [resultShares, setResultShares] = useState<ResultShare[]>([]);
  const [posted, setPosted] = useState(false);
  const [savedDraftFingerprint, setSavedDraftFingerprint] = useState<string | null>(null);
  const currentDraftFingerprint = useMemo(() => JSON.stringify({
    invoiceDate, headerNotes, sourceJobId, fields, lines,
  }), [fields, headerNotes, invoiceDate, lines, sourceJobId]);
  const hasUnsavedBillingChanges = savedDraftFingerprint !== currentDraftFingerprint;

  // ── Flag read on mount (behaviour-neutral gate) ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('app_settings')
          .select('setting_value')
          .eq('setting_key', SPLIT_BILLING_SETTING_KEY)
          .maybeSingle();
        if (!cancelled) {
          setFlagEnabled(parseSplitBillingEnabled((data as { setting_value?: string } | null)?.setting_value ?? null));
        }
      } catch {
        if (!cancelled) setFlagEnabled(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Load pickers once the feature is enabled ─────────────────────────────
  useEffect(() => {
    if (flagEnabled !== true) return;
    let cancelled = false;
    (async () => {
      try {
        const [flds, prods, svcs, jbs] = await Promise.all([
          supabase.from('fields').select('id, field_name, total_acres').eq('is_active', true).order('field_name').limit(1000),
          supabase.from('products').select('id, product_name').eq('is_active', true).order('product_name').limit(1000),
          supabase.from('application_services').select('id, name, default_rate_per_acre_cents').eq('is_active', true).order('sort_order'),
          supabase
            .from('jobs')
            .select('id, job_number, job_date, customer:customers(farm_name)')
            .order('job_date', { ascending: false })
            .limit(200),
        ]);
        if (cancelled) return;
        setFieldOptions(((flds.data as Array<{ id: string; field_name: string | null; total_acres: number | null }> | null) ?? []).map((f) => ({
          id: f.id, field_name: f.field_name || 'Unnamed field', total_acres: Number(f.total_acres ?? 0),
        })));
        setProductOptions(((prods.data as Array<{ id: string; product_name: string | null }> | null) ?? []).map((p) => ({ id: p.id, product_name: p.product_name || 'Unnamed product' })));
        setServiceOptions(((svcs.data as Array<{ id: string; name: string | null; default_rate_per_acre_cents: number }> | null) ?? []).map((s) => ({
          id: s.id,
          name: s.name || 'Unnamed service',
          default_rate_per_acre_cents: Number(s.default_rate_per_acre_cents) || 0,
        })));
        setJobOptions(
          ((jbs.data as Array<{ id: string; job_number: string | null; job_date: string | null; customer: { farm_name?: string | null } | null }> | null) ?? []).map((j) => ({
            id: j.id,
            label: `${j.job_number || 'Job'}${j.job_date ? ` — ${j.job_date}` : ''}${j.customer?.farm_name ? ` (${j.customer.farm_name})` : ''}`,
          })),
        );
      } catch (err) {
        if (!cancelled) toast('error', sanitizeError(err));
      }
    })();
    return () => { cancelled = true; };
  }, [flagEnabled, toast]);

  // A saved job is the authoritative source for fields, chemicals, service, and frozen prices.
  // The browser never invents or rewrites job money.
  useEffect(() => {
    if (!sourceJobId || flagEnabled !== true) return;
    let cancelled = false;
    (async () => {
      try {
        const [jobResult, fieldResult, chemicalResult] = await Promise.all([
          supabaseUntyped.from('jobs').select('application_service_id').eq('id', sourceJobId).single(),
          supabaseUntyped
            .from('job_fields')
            .select('field_id, acres_to_treat, sort_order, field:fields(field_name, total_acres)')
            .eq('job_id', sourceJobId)
            .order('sort_order'),
          supabaseUntyped
            .from('job_chemicals')
            .select('id, product_id, quantity, unit, price_per_unit_cents, sort_order, product:products(product_name)')
            .eq('job_id', sourceJobId)
            .order('sort_order'),
        ]);
        if (jobResult.error) throw jobResult.error;
        if (fieldResult.error) throw fieldResult.error;
        if (chemicalResult.error) throw chemicalResult.error;
        if (cancelled) return;
        setFields(((fieldResult.data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
          field_id: row.field_id as string,
          field_name: ((row.field as { field_name?: string } | null)?.field_name) || 'Field',
          applied_acres: String(row.acres_to_treat ?? ''),
          total_acres: Number((row.field as { total_acres?: number } | null)?.total_acres ?? row.acres_to_treat ?? 0),
        })));
        const chemicalLines: LineDraft[] = ((chemicalResult.data as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
          uid: nextUid(),
          line_kind: 'chemical',
          product_id: row.product_id as string,
          job_chemical_id: row.id as string,
          application_service_id: '',
          description: ((row.product as { product_name?: string } | null)?.product_name) || 'Chemical',
          quantity: String(row.quantity ?? ''),
          unitPriceDollars: row.price_per_unit_cents == null ? '' : (Number(row.price_per_unit_cents) / 100).toFixed(2),
          flatDollars: '',
          rateUnit: String(row.unit ?? ''),
          customized: false,
          shares: [],
        }));
        const serviceId = (jobResult.data as { application_service_id?: string | null } | null)?.application_service_id;
        if (serviceId) {
          const service = serviceOptions.find((option) => option.id === serviceId);
          chemicalLines.push({
            uid: nextUid(), line_kind: 'service', product_id: '', application_service_id: serviceId,
            description: service?.name || 'Application service', quantity: '',
            unitPriceDollars: ((service?.default_rate_per_acre_cents ?? 0) / 100).toFixed(2),
            flatDollars: '', rateUnit: 'acre', customized: false, shares: [],
          });
        }
        setLines(chemicalLines);
        setMembers([]);
        setResultInvoices([]);
        setResultShares([]);
      } catch (err) {
        if (!cancelled) toast('error', sanitizeError(err));
      }
    })();
    return () => { cancelled = true; };
  }, [flagEnabled, serviceOptions, sourceJobId, toast]);

  const customerName = useCallback(
    (id: string) => customerNames[id] || `Customer ${id.slice(0, 8)}`,
    [customerNames],
  );

  // Keep non-customized lines' shares in sync with the resolved default vector.
  useEffect(() => {
    if (members.length === 0) return;
    setLines((prev) => prev.map((l) => (l.customized ? l : { ...l, shares: defaultSharesFromMembers(members) })));
  }, [members]);

  // ── Field selection ──────────────────────────────────────────────────────
  const addField = () => {
    if (!addFieldId) return;
    if (fields.some((f) => f.field_id === addFieldId)) {
      toast('info', 'That field is already added.');
      return;
    }
    const opt = fieldOptions.find((f) => f.id === addFieldId);
    if (!opt) return;
    setFields((prev) => [...prev, {
      field_id: opt.id, field_name: opt.field_name, applied_acres: '', total_acres: opt.total_acres,
    }]);
    setAddFieldId('');
  };

  const removeField = (fieldId: string) => setFields((prev) => prev.filter((f) => f.field_id !== fieldId));
  const setFieldAcres = (fieldId: string, acres: string) =>
    setFields((prev) => prev.map((f) => (f.field_id === fieldId ? { ...f, applied_acres: acres } : f)));

  const totalAppliedAcres = useMemo(
    () => fields.reduce((sum, f) => sum + (parseFloat(f.applied_acres) || 0), 0),
    [fields],
  );

  // ── Resolve the default split vector from the SQL engine ──────────────────
  const resolveVector = async () => {
    if (!profile?.id) {
      toast('error', 'Your sign-in could not be verified. Refresh and try again.');
      return;
    }
    const validFields = fields.filter((f) => (parseFloat(f.applied_acres) || 0) > 0);
    if (validFields.length === 0) {
      toast('error', 'Add at least one field and enter its applied acres first.');
      return;
    }
    setResolving(true);
    try {
      if (!sourceJobId) throw new Error('Choose a saved job first.');
      await assertNoModeA(validFields.map((f) => f.field_id));
      const { data, error } = await supabaseUntyped.rpc('preview_field_app_invoice_split', {
        p_locations: buildLocationsPayload(validFields),
        p_chemicals: buildChemicalsPayload(),
        p_application_service_id: selectedServiceId(),
        p_invoice_id: resultInvoices[0]?.id ?? null,
        p_job_id: sourceJobId,
        p_line_overrides: buildOptionsPayload(),
      });
      if (error) throw error;
      const plan = assertRpcResult(data, 'preview_field_app_invoice_split') as {
        billing_lines?: Array<{ shares?: Array<{ customer_id: string; split_micro_pct: number }> }>;
      };
      // Use the calculator's exact integer micro-percent vector. Deriving it from a
      // rounded display percentage would break exact three-way vectors by 100 micros.
      const vector = plan.billing_lines?.[0]?.shares ?? [];
      const nextMembers = vector.map((v) => ({ customer_id: v.customer_id, micro_pct: Number(v.split_micro_pct) }));
      if (nextMembers.length === 0) throw new Error('The server preview returned no billing members.');
      setMembers(nextMembers);

      // Fetch farm names for the resolved members.
      const ids = nextMembers.map((m) => m.customer_id);
      if (ids.length > 0) {
        const { data: custs } = await supabase.from('customers').select('id, farm_name').in('id', ids);
        const map: Record<string, string> = {};
        ((custs as Array<{ id: string; farm_name: string | null }> | null) ?? []).forEach((c) => { map[c.id] = c.farm_name || ''; });
        setCustomerNames((prev) => ({ ...prev, ...map }));
      }
      toast('success', `Default split resolved for ${nextMembers.length} customer${nextMembers.length === 1 ? '' : 's'}.`);
    } catch (err) {
      toast('error', splitBackendError(err));
    } finally {
      setResolving(false);
    }
  };

  // ── Line editing ──────────────────────────────────────────────────────────
  const addLine = (kind: LineKindUI) => {
    setLines((prev) => [
      ...prev,
      {
        uid: nextUid(),
        line_kind: kind,
        product_id: '',
        application_service_id: '',
        description: '',
        quantity: '',
        unitPriceDollars: '',
        flatDollars: '',
        rateUnit: '',
        customized: false,
        shares: defaultSharesFromMembers(members),
      },
    ]);
  };

  const removeLine = (uid: string) => setLines((prev) => prev.filter((l) => l.uid !== uid));

  const patchLine = (uid: string, patch: Partial<LineDraft>) =>
    setLines((prev) => prev.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));

  const patchShare = (uid: string, customerId: string, patch: Partial<ShareDraft>) =>
    setLines((prev) =>
      prev.map((l) => {
        if (l.uid !== uid) return l;
        const shares = l.shares.length > 0 ? l.shares : defaultSharesFromMembers(members);
        return {
          ...l,
          customized: true,
          shares: shares.map((s) => (s.customer_id === customerId ? { ...s, ...patch } : s)),
        };
      }),
    );

  const resetLineToDefault = (uid: string) =>
    patchLine(uid, { customized: false, shares: defaultSharesFromMembers(members) });

  // Pre-save SOURCE estimate for a line (qty*price or flat). NOT authoritative.
  const lineEstimateCents = (l: LineDraft): number | null => {
    if (l.line_kind === 'flat_fee') return dollarsToCents(l.flatDollars);
    if (l.line_kind === 'chemical') {
      const qty = parseFloat(l.quantity);
      const price = dollarsToCents(l.unitPriceDollars);
      if (!Number.isFinite(qty) || price == null) return null;
      return Math.round(qty * price);
    }
    return null; // service rate defaults server-side; no client estimate
  };

  const shareSumPct = (l: LineDraft): number =>
    l.shares.reduce((sum, s) => sum + (parseFloat(s.pct) || 0), 0);

  // ── Save ───────────────────────────────────────────────────────────────────
  function validateForSave(): string | null {
    if (!profile?.id) return 'Your sign-in could not be verified. Refresh and try again.';
    if (!invoiceDate) return 'Choose an invoice date.';
    const validFields = fields.filter((f) => (parseFloat(f.applied_acres) || 0) > 0);
    if (validFields.length === 0) return 'Add at least one field with applied acres greater than zero.';
    if (members.length === 0) return 'Resolve the default split before saving.';
    if (lines.length === 0) return 'Add at least one billing line.';
    for (const l of lines) {
      if (l.line_kind === 'chemical') {
        if (!l.job_chemical_id) return 'Chemical lines must come from the selected saved job.';
        if (!l.product_id) return 'A chemical line has no product selected.';
        if (!(parseFloat(l.quantity) > 0)) return 'A chemical line has no quantity.';
      } else if (l.line_kind === 'service') {
        if (!l.application_service_id) return 'A service line has no application service selected.';
      } else if (l.line_kind === 'flat_fee') {
        const c = dollarsToCents(l.flatDollars);
        if (c == null || c <= 0) return 'A flat-fee line has no amount.';
        if (!l.description.trim()) return 'A flat-fee line needs a description.';
      }
      if (l.customized) {
        try {
          percentStringsToMicro(l.shares.map((share) => share.pct));
        } catch (error) {
          return error instanceof Error ? error.message : 'Customized percentages must total exactly 100%.';
        }
        for (const share of l.shares) {
          if (share.override && dollarsToCents(share.overridePriceDollars) == null) {
            return 'Every selected price override needs a valid dollar amount.';
          }
        }
      }
    }
    return null;
  }

  const selectedServiceId = () => lines.find((line) => line.line_kind === 'service')?.application_service_id || null;

  const buildLocationsPayload = (validFields = fields.filter((f) => (parseFloat(f.applied_acres) || 0) > 0)) =>
    validFields.map((field, index) => ({
      field_id: field.field_id,
      applied_acres: parseFloat(field.applied_acres),
      total_acres: field.total_acres,
      map_number: index + 1,
      sort_order: index,
    }));

  const buildChemicalsPayload = () => lines
    .filter((line) => line.line_kind === 'chemical' && line.job_chemical_id)
    .map((line) => ({ job_chemical_id: line.job_chemical_id, line_key: `chemical:${line.job_chemical_id}` }));

  function buildOptionsPayload(): Record<string, unknown> {
    const flatFees = lines.filter((line) => line.line_kind === 'flat_fee').map((line, index) => ({
      line_key: `flat_fee:${index}`,
      description: line.description.trim(),
      source_amount_cents: dollarsToCents(line.flatDollars),
      sort_order: 2_000_000 + index,
    }));
    const overrides = lines.filter((line) => line.customized).map((line, index) => {
      const lineKey = line.line_kind === 'chemical'
        ? `chemical:${line.job_chemical_id}`
        : line.line_kind === 'service'
          ? `service:${line.application_service_id}`
          : `flat_fee:${lines.filter((candidate) => candidate.line_kind === 'flat_fee').indexOf(line)}`;
      const micro = percentStringsToMicro(line.shares.map((share) => share.pct));
      return {
        line_key: lineKey,
        split_mode: 'custom',
        split_override_reason: 'Per-line editor override',
        vector: line.shares.map((share, shareIndex) => ({
          customer_id: share.customer_id,
          split_micro_pct: micro[shareIndex],
        })),
        price_overrides: line.shares.flatMap((share) => {
          const cents = share.override ? dollarsToCents(share.overridePriceDollars) : null;
          return cents == null ? [] : [{ customer_id: share.customer_id, unit_price_cents: cents, reason: 'Per-line editor price override' }];
        }),
        sort_order: index,
      };
    });
    return { flat_fees: flatFees, lines: overrides };
  }

  async function assertNoModeA(fieldIds: string[]): Promise<void> {
    const { data, error } = await supabaseUntyped
      .from('field_billing_defaults')
      .select('field_id')
      .in('field_id', fieldIds)
      .not('price_override_cents', 'is', null)
      .limit(1);
    if (error) throw error;
    if ((data ?? []).length > 0) {
      throw new Error('Per-line split billing cannot be used while a selected field has a grower-share price override.');
    }
  }

  const loadResults = useCallback(async (
    _setId: string,
    groupId = invoiceGroupId,
    invoiceIdsOverride: string[] = [],
  ) => {
    // 1) Child invoices for this billing set (authoritative totals + send disposition).
    let invoiceQuery = supabaseUntyped
      .from('invoices')
      .select('id, invoice_number, customer_id, total_amount_cents, send_disposition, status');
    if (groupId) invoiceQuery = invoiceQuery.eq('invoice_group_id', groupId);
    else if (invoiceIdsOverride.length > 0) invoiceQuery = invoiceQuery.in('id', invoiceIdsOverride);
    else { setResultInvoices([]); setResultShares([]); return; }
    const { data: invRows, error: invErr } = await invoiceQuery.order('invoice_number');
    if (invErr) throw invErr;
    const invoices = ((invRows as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
      id: r.id as string,
      invoice_number: (r.invoice_number as string | null) ?? null,
      customer_id: r.customer_id as string,
      total_amount_cents: Number(r.total_amount_cents ?? 0),
      send_disposition: ((r.send_disposition as string) === 'suppressed_zero_total' ? 'suppressed_zero_total' : 'sendable') as ResultInvoice['send_disposition'],
      status: (r.status as string) || 'draft',
    }));
    setResultInvoices(invoices);
    setPosted(invoices.length > 0 && invoices.every((i) => i.status !== 'draft'));

    // Names for any customers we do not yet have.
    const missing = invoices.map((i) => i.customer_id).filter((id) => !customerNames[id]);
    if (missing.length > 0) {
      const { data: custs } = await supabase.from('customers').select('id, farm_name').in('id', missing);
      const map: Record<string, string> = {};
      ((custs as Array<{ id: string; farm_name: string | null }> | null) ?? []).forEach((c) => { map[c.id] = c.farm_name || ''; });
      setCustomerNames((prev) => ({ ...prev, ...map }));
    }

    const invoiceIds = invoices.map((i) => i.id);
    if (invoiceIds.length === 0) { setResultShares([]); return; }

    // 2) Invoice items (invoice_id + description) for those invoices.
    const { data: itemRows } = await supabaseUntyped
      .from('invoice_items')
      .select('id, invoice_id, description')
      .in('invoice_id', invoiceIds);
    const itemMap = new Map<string, { invoice_id: string; description: string }>();
    ((itemRows as Array<Record<string, unknown>> | null) ?? []).forEach((it) => {
      itemMap.set(it.id as string, { invoice_id: it.invoice_id as string, description: (it.description as string) || '' });
    });

    // 3) Per-line shares, joined to their item for invoice_id + description.
    const itemIds = Array.from(itemMap.keys());
    if (itemIds.length === 0) { setResultShares([]); return; }
    const { data: shareRows } = await supabaseUntyped
      .from('invoice_line_shares')
      .select('invoice_item_id, customer_id, unit_price_cents, amount_cents')
      .in('invoice_item_id', itemIds);
    const shares: ResultShare[] = ((shareRows as Array<Record<string, unknown>> | null) ?? []).map((s) => {
      const item = itemMap.get(s.invoice_item_id as string);
      return {
        invoice_id: item?.invoice_id ?? '',
        customer_id: s.customer_id as string,
        description: item?.description ?? '',
        unit_price_cents: Number(s.unit_price_cents ?? 0),
        amount_cents: Number(s.amount_cents ?? 0),
      };
    });
    setResultShares(shares);
  }, [customerNames, invoiceGroupId]);

  const handleSave = async () => {
    const problem = validateForSave();
    if (problem) { toast('error', problem); return; }
    if (!profile?.id) return;
    setSaving(true);
    try {
      const validFields = fields.filter((f) => (parseFloat(f.applied_acres) || 0) > 0);
      if (!sourceJobId) throw new Error('Choose a saved job first.');
      await assertNoModeA(validFields.map((field) => field.field_id));
      const { data, error } = await supabaseUntyped.rpc('save_field_app_invoice_per_line', {
        p_invoice_id: resultInvoices[0]?.id ?? null,
        p_invoice: {
          invoice_date: invoiceDate,
          ...(headerNotes.trim() ? { header_notes: headerNotes.trim() } : {}),
          ...(profile.id ? { salesman_id: profile.id } : {}),
        },
        p_locations: buildLocationsPayload(validFields),
        p_chemicals: buildChemicalsPayload(),
        p_performed_by: profile.id,
        p_application_service_id: selectedServiceId(),
        p_job_id: sourceJobId,
        p_options: buildOptionsPayload(),
        p_idempotency_key: saveIdem.getKey(),
      });
      if (error) throw error;
      const res = assertRpcResult<{ billing_set_id: string; invoice_group_id: string; invoice_ids: string[]; calculation_hash: string }>(
        data, 'save_field_app_invoice_per_line',
      );
      setBillingSetId(res.billing_set_id);
      setInvoiceGroupId(res.invoice_group_id);
      saveIdem.resetKey(); // next save is a distinct action → fresh key
      // Read by the server-returned ids when a single-customer save has no group id.
      await loadResults(res.billing_set_id, res.invoice_group_id, res.invoice_ids);
      setSavedDraftFingerprint(currentDraftFingerprint);
      toast('success', 'Draft split invoice saved.');
    } catch (err) {
      toast('error', splitBackendError(err));
    } finally {
      setSaving(false);
    }
  };

  const handlePost = async () => {
    const singleInvoiceId = resultInvoices.length === 1 ? resultInvoices[0].id : null;
    if ((!invoiceGroupId && !singleInvoiceId) || !profile?.id || hasUnsavedBillingChanges) return;
    setPosting(true);
    setShowPostConfirm(false);
    try {
      if (invoiceGroupId) {
        const { data, error } = await supabaseUntyped.rpc('post_invoice_group', {
          p_invoice_group_id: invoiceGroupId,
          p_performed_by: profile.id,
          p_idempotency_key: postIdem.getKey(),
        });
        if (error) throw error;
        assertRpcResult<unknown>(data, 'post_invoice_group');
        postIdem.resetKey();
      } else {
        const { data, error } = await supabaseUntyped.rpc('post_invoice', {
          p_invoice_id: singleInvoiceId,
          p_performed_by: profile.id,
          p_idempotency_key: postSingleIdem.getKey(),
        });
        if (error) throw error;
        assertRpcResult<unknown>(data, 'post_invoice');
        postSingleIdem.resetKey();
      }
      if (billingSetId) await loadResults(billingSetId, invoiceGroupId, resultInvoices.map((invoice) => invoice.id));
      toast('success', 'Invoice group posted.');
    } catch (err) {
      toast('error', splitBackendError(err));
    } finally {
      setPosting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  if (flagEnabled === null) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (flagEnabled === false) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <Card>
          <div className="flex items-start gap-3">
            <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <h2 className="text-lg font-semibold font-heading text-nav-dark">Per-line split billing is not enabled</h2>
              <p className="text-sm text-secondary mt-1">
                This feature is turned off. An administrator can enable it in Settings once the billing engine has been
                switched on. Nothing here affects your current invoicing.
              </p>
              <div className="mt-4">
                <Button variant="secondary" icon={<ArrowLeft className="w-4 h-4" />} showChevron={false} onClick={() => navigate('/field-invoices')}>
                  Back to Field Invoices
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const resultsByCustomer = resultInvoices.map((inv) => ({
    invoice: inv,
    lines: resultShares.filter((s) => s.invoice_id === inv.id),
  }));

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/field-invoices')} aria-label="Back" className="text-secondary hover:text-nav-dark">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-semibold font-heading text-nav-dark">Split Billing — New</h1>
            <p className="text-xs text-secondary">Per-line split of a field application across multiple customers.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" icon={<Save className="w-4 h-4" />} showChevron={false} loading={saving} onClick={handleSave}>
            {billingSetId ? 'Re-save Draft' : 'Save Draft'}
          </Button>
          <Button
            variant="primary"
            icon={<Send className="w-4 h-4" />}
            showChevron={false}
            disabled={(!invoiceGroupId && resultInvoices.length !== 1) || posted || hasUnsavedBillingChanges}
            loading={posting}
            onClick={() => setShowPostConfirm(true)}
          >
            {posted ? 'Posted' : 'Post'}
          </Button>
        </div>
      </div>

      {/* Invoice header + source job */}
      <Card>
        <CardHeader title="Application" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <label className="block">
            <span className="text-xs font-medium text-secondary">Invoice date</span>
            <input
              type="date"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium text-secondary">Saved source job (required)</span>
            <select
              value={sourceJobId}
              onChange={(e) => setSourceJobId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="">Select a saved job</option>
              {jobOptions.map((j) => (<option key={j.id} value={j.id}>{j.label}</option>))}
            </select>
          </label>
          <label className="block sm:col-span-3">
            <span className="text-xs font-medium text-secondary">Header notes (optional)</span>
            <input
              type="text"
              value={headerNotes}
              onChange={(e) => setHeaderNotes(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="Printed on the invoice"
            />
          </label>
        </div>
      </Card>

      {/* Fields + applied acres */}
      <Card>
        <CardHeader title="Fields & Applied Acres" />
        <div className="flex items-end gap-2 mb-4">
          <label className="flex-1">
            <span className="text-xs font-medium text-secondary">Add a field</span>
            <select
              value={addFieldId}
              onChange={(e) => setAddFieldId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="">Select a field…</option>
              {fieldOptions.filter((o) => !fields.some((f) => f.field_id === o.id)).map((o) => (
                <option key={o.id} value={o.id}>{o.field_name}</option>
              ))}
            </select>
          </label>
          <Button variant="secondary" icon={<Plus className="w-4 h-4" />} showChevron={false} onClick={addField}>Add</Button>
        </div>

        {fields.length === 0 ? (
          <p className="text-sm text-secondary">No fields added yet.</p>
        ) : (
          <div className="space-y-2">
            {fields.map((f) => (
              <div key={f.field_id} className="flex items-center gap-3">
                <span className="flex-1 text-sm text-nav-dark">{f.field_name}</span>
                <label className="flex items-center gap-2">
                  <span className="text-xs text-secondary">Applied acres</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={f.applied_acres}
                    onChange={(e) => setFieldAcres(f.field_id, e.target.value)}
                    className="w-28 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  />
                </label>
                <button onClick={() => removeField(f.field_id)} aria-label="Remove field" className="text-red-600 hover:text-red-700">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
            <div className="pt-2 text-xs text-secondary">Total applied acres: {totalAppliedAcres.toFixed(2)}</div>
          </div>
        )}

        <div className="mt-4">
          <Button variant="secondary" icon={<Calculator className="w-4 h-4" />} showChevron={false} loading={resolving} onClick={resolveVector}>
            Resolve default split
          </Button>
        </div>
      </Card>

      {/* Resolved members */}
      {members.length > 0 && (
        <Card>
          <CardHeader title="Billing Members (default split)" />
          <div className="space-y-1">
            {members.map((m) => (
              <div key={m.customer_id} className="flex items-center justify-between text-sm">
                <span className="text-nav-dark">{customerName(m.customer_id)}</span>
                <span className="text-secondary tabular-nums">{(m.micro_pct / 1_000_000).toFixed(4)}%</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Lines */}
      <Card>
        <CardHeader
          title="Billing Lines"
          action={
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" icon={<Plus className="w-4 h-4" />} showChevron={false} onClick={() => addLine('flat_fee')}>Flat fee</Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<SlidersHorizontal className="w-4 h-4" />}
                showChevron={false}
                onClick={() => setShowAdvanced((visible) => !visible)}
              >
                {showAdvanced ? 'Hide advanced' : 'Advanced splits'}
              </Button>
            </div>
          }
        />
        {members.length === 0 && (
          <p className="text-sm text-amber-700 mb-3">Resolve the default split first so each line has members to split across.</p>
        )}
        {lines.length === 0 ? (
          <p className="text-sm text-secondary">No lines yet. Add a chemical, service, or flat-fee line.</p>
        ) : (
          <div className="space-y-4">
            {lines.map((l) => {
              const estimate = lineEstimateCents(l);
              const sum = shareSumPct(l);
              let sumOk = false;
              try {
                percentStringsToMicro(l.shares.map((share) => share.pct));
                sumOk = true;
              } catch {
                sumOk = false;
              }
              return (
                <div key={l.uid} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold uppercase tracking-wide text-secondary">
                      {l.line_kind === 'flat_fee' ? 'Flat fee' : l.line_kind}
                    </span>
                    <button onClick={() => removeLine(l.uid)} aria-label="Remove line" className="text-red-600 hover:text-red-700">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Line inputs */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {l.line_kind === 'chemical' && (
                      <>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Product</span>
                          <select
                            value={l.product_id}
                            onChange={(e) => patchLine(l.uid, { product_id: e.target.value })}
                            disabled={Boolean(l.job_chemical_id)}
                            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
                          >
                            <option value="">Select a product…</option>
                            {productOptions.map((p) => (<option key={p.id} value={p.id}>{p.product_name}</option>))}
                          </select>
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Total quantity</span>
                          <input type="number" min="0" step="0.0001" value={l.quantity} onChange={(e) => patchLine(l.uid, { quantity: e.target.value })} disabled={Boolean(l.job_chemical_id)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50" />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Unit price ($ / unit)</span>
                          <input type="number" min="0" step="0.01" value={l.unitPriceDollars} onChange={(e) => patchLine(l.uid, { unitPriceDollars: e.target.value })} disabled={Boolean(l.job_chemical_id)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50" />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Rate unit (optional)</span>
                          <input type="text" value={l.rateUnit} onChange={(e) => patchLine(l.uid, { rateUnit: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="oz, gal…" />
                        </label>
                      </>
                    )}
                    {l.line_kind === 'service' && (
                      <>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Application service</span>
                          <select
                            value={l.application_service_id}
                            onChange={(e) => patchLine(l.uid, { application_service_id: e.target.value })}
                            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
                          >
                            <option value="">Select a service…</option>
                            {serviceOptions.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                          </select>
                        </label>
                        <p className="text-xs text-secondary sm:col-span-2">
                          Charged on {totalAppliedAcres.toFixed(2)} applied acres. Configured base rate: {formatCents(dollarsToCents(l.unitPriceDollars) ?? 0)} / acre. Customer-specific prices appear in the server-computed result.
                        </p>
                      </>
                    )}
                    {l.line_kind === 'flat_fee' && (
                      <>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Description</span>
                          <input type="text" value={l.description} onChange={(e) => patchLine(l.uid, { description: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Amount ($)</span>
                          <input type="number" min="0" step="0.01" value={l.flatDollars} onChange={(e) => patchLine(l.uid, { flatDollars: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                        </label>
                      </>
                    )}
                    {l.line_kind !== 'flat_fee' && (
                      <label className="block sm:col-span-2">
                        <span className="text-xs font-medium text-secondary">Description (optional)</span>
                        <input type="text" value={l.description} onChange={(e) => patchLine(l.uid, { description: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                      </label>
                    )}
                  </div>

                  {/* Estimate (clearly non-authoritative) */}
                  {estimate != null && (
                    <p className="mt-3 text-xs text-secondary">
                      Source line total: <span className="font-medium text-nav-dark">{formatCents(estimate)}</span>
                      {' '}— estimated; final split computed on save.
                    </p>
                  )}

                  {/* Per-line split editor */}
                  {showAdvanced && members.length > 0 && (
                    <div className="mt-4 border-t border-gray-100 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-secondary flex items-center gap-1">
                          <SlidersHorizontal className="w-3.5 h-3.5" /> Per-line split
                          {l.customized && <span className="ml-1 text-[10px] font-normal text-crx-green">(customized)</span>}
                        </span>
                        {l.customized && (
                          <button onClick={() => resetLineToDefault(l.uid)} className="text-xs text-secondary hover:text-nav-dark underline">
                            Reset to default
                          </button>
                        )}
                      </div>
                      <div className="space-y-2">
                        {l.shares.map((s) => (
                          <div key={s.customer_id} className="flex flex-wrap items-center gap-2">
                            <span className="flex-1 min-w-[8rem] text-sm text-nav-dark">{customerName(s.customer_id)}</span>
                            <label className="flex items-center gap-1">
                              <input
                                type="number"
                                min="0"
                                max="100"
                                step="0.0001"
                                value={s.pct}
                                onChange={(e) => patchShare(l.uid, s.customer_id, { pct: e.target.value })}
                                className="w-24 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                              />
                              <span className="text-xs text-secondary">%</span>
                            </label>
                            <label className="flex items-center gap-1 text-xs text-secondary">
                              <input
                                type="checkbox"
                                checked={s.override}
                                onChange={(e) => patchShare(l.uid, s.customer_id, { override: e.target.checked })}
                              />
                              price override
                            </label>
                            {s.override && (
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={s.overridePriceDollars}
                                onChange={(e) => patchShare(l.uid, s.customer_id, { overridePriceDollars: e.target.value })}
                                className="w-28 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                                placeholder="$ / unit"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                      {l.customized && (
                        <p className={`mt-2 text-xs ${sumOk ? 'text-secondary' : 'text-red-600'}`}>
                          Percent total: {sum.toFixed(2)}% {sumOk ? '' : '— must equal 100%'}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Authoritative results after save */}
      {resultInvoices.length > 0 && (
        <Card>
          <CardHeader title="Split Result (server-computed)" accent={posted ? 'Posted' : 'Draft'} />
          <div className="space-y-4">
            {resultsByCustomer.map(({ invoice, lines: shareLines }) => (
              <div key={invoice.id} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-sm font-semibold text-nav-dark">{customerName(invoice.customer_id)}</div>
                    <div className="text-xs text-secondary">{invoice.invoice_number || 'Draft (no number yet)'}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold text-nav-dark tabular-nums">{formatCents(invoice.total_amount_cents)}</div>
                    {invoice.send_disposition === 'suppressed_zero_total' && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 mt-1">
                        <Ban className="w-3 h-3" /> $0 — recorded, not emailed
                      </span>
                    )}
                  </div>
                </div>
                {shareLines.length > 0 && (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-secondary text-left">
                        <th className="font-medium py-1">Line</th>
                        <th className="font-medium py-1 text-right">Unit price</th>
                        <th className="font-medium py-1 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shareLines.map((s, i) => (
                        <tr key={`${invoice.id}_${i}`} className="border-t border-gray-100">
                          <td className="py-1 text-nav-dark">{s.description || '—'}</td>
                          <td className="py-1 text-right tabular-nums text-secondary">{formatCents(s.unit_price_cents)}</td>
                          <td className="py-1 text-right tabular-nums text-nav-dark">{formatCents(s.amount_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <ConfirmModal
        open={showPostConfirm}
        onClose={() => setShowPostConfirm(false)}
        onConfirm={handlePost}
        title={invoiceGroupId ? 'Post this split invoice group?' : 'Post this split invoice?'}
        message="Posting freezes the per-line split and each customer's invoice. This cannot be edited afterward without unposting."
        confirmLabel="Post"
        variant="info"
        icon={Send}
        loading={posting}
      />
    </div>
  );
}
