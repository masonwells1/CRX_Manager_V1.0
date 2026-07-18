import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { localToday } from '../lib/dateUtils';
import { SPLIT_BILLING_SETTING_KEY, parseSplitBillingEnabled } from '../lib/splitBillingSetting';

/**
 * Per-line split-billing EDITOR (flag-gated, OFF by default).
 *
 * MONEY-SAFETY: the browser NEVER computes the authoritative per-customer cents.
 * The penny-exact split is produced by the SQL engine (save_field_app_split_invoice);
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
  overrideReason: string; // #L: optional "why" for a per-share price override
}

interface LineDraft {
  uid: string;
  line_kind: LineKindUI;
  product_id: string;
  application_service_id: string;
  description: string;
  quantity: string; // chemical: total applied quantity
  serviceAcres: string; // service: total applied acres (optional; server defaults to sum of fields)
  unitPriceDollars: string; // chemical: dollars/unit (only sent when overridePrice)
  overridePrice: boolean; // chemical: when false, the server resolves the price (quote → tier)
  flatDollars: string; // flat_fee: dollars (stored as cents)
  rateUnit: string;
  customized: boolean; // when true, send an explicit COMPLETE shares vector
  splitReason: string; // #L: optional "why" for a customized split
  shares: ShareDraft[];
}

interface FieldPick {
  field_id: string;
  field_name: string;
  applied_acres: string;
}

interface FieldOption {
  id: string;
  field_name: string;
}

interface ProductOption {
  id: string;
  product_name: string;
}

interface ServiceOption {
  id: string;
  name: string;
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
  send_disposition: 'normal' | 'suppressed_zero_total';
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

/** Percent strings → micro-percent ints summing EXACTLY to 100000000 (largest remainder,
 *  tie-break by index). Assumes the caller validated the percents sum to ~100. */
function pctsToMicro(pcts: number[]): number[] {
  const TOTAL = 100_000_000;
  const ideals = pcts.map((p) => (p / 100) * TOTAL);
  const floors = ideals.map((v) => Math.floor(v));
  const base = floors.reduce((a, b) => a + b, 0);
  let residual = TOTAL - base;
  const result = [...floors];
  const order = ideals
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  // Distribute the ENTIRE positive residual, CYCLING largest-fraction-first. A user percent set
  // that sums just under 100 (e.g. 33.3333×3 → 99999900 micro, residual 100 across 3 members)
  // must still reach exactly 100000000; a single pass (≤1 per member) left a 97-unit gap that the
  // server's exact-100% check then rejected (Codex r2 #K).
  for (let k = 0; residual > 0 && order.length > 0; k = (k + 1) % order.length) {
    result[order[k].i] += 1;
    residual -= 1;
  }
  // Remove the ENTIRE negative residual, CYCLING smallest-fraction-first — mirroring the positive
  // branch. Percentages that sum just OVER 100 within the 0.01 UI tolerance (e.g. 33.334×3 →
  // 100002000 micro, residual -2000) must still land on exactly 100000000; a single pass (≤1 per
  // member) left the vector above 100000000 so the server rejected a payload the UI approved (Codex
  // round-3 P2). `guard` breaks only if a full lap finds no member >0 (cannot happen while
  // residual<0, since the over-100 sum guarantees some member carries a subtractable unit).
  const revOrder = [...order].reverse();
  for (let k = 0, guard = 0; residual < 0 && guard < revOrder.length; k = (k + 1) % revOrder.length) {
    if (result[revOrder[k].i] > 0) {
      result[revOrder[k].i] -= 1;
      residual += 1;
      guard = 0;
    } else {
      guard += 1;
    }
  }
  return result;
}

function defaultSharesFromMembers(members: Member[]): ShareDraft[] {
  return members.map((m) => ({
    customer_id: m.customer_id,
    pct: (m.micro_pct / 1_000_000).toString(),
    override: false,
    overridePriceDollars: '',
    overrideReason: '',
  }));
}

function dollarsToCents(raw: string): number | null {
  // "Not entered" stays null (drives the "no unit price" validation); otherwise parse
  // via the canonical string-based parser — NOT parseFloat — so scientific notation
  // ("1e5" -> $100k), multi-dot, and negatives can't leak a wrong authoritative money
  // value into the save RPC. parseDollarsToCents is positive-only and returns cents.
  if (raw == null || raw.trim() === '') return null;
  const cents = parseDollarsToCents(raw);
  // parseDollarsToCents is positive-only (it strips the sign). Preserve a leading minus so
  // downstream validation (`<= 0` / `< 0`) REJECTS a credit/negative instead of silently
  // flipping e.g. "-50.00" into a +$50 CHARGE (Codex r2 #C). Flat-fee credits aren't a
  // supported split-editor flow yet.
  return /^\s*-/.test(raw) ? -cents : cents;
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
  // #H (Codex round-2): a set id in the URL reopens a previously-SAVED draft (save-now / post-later).
  // v1 reopen is READ-ONLY — it loads the saved server-computed split for review and Post; it does
  // NOT re-hydrate the editable money inputs (rate units / dollar round-trips), which a re-save
  // would re-price and could subtly change. Editing a reopened draft stays a future enhancement.
  const { id: routeSetId } = useParams<{ id: string }>();
  const isReopen = !!routeSetId;
  const { profile } = useAuth();
  const { toast } = useToast();

  const saveIdem = useIdempotencyKey('save_field_app_split_invoice', profile?.id || '');
  const postIdem = useIdempotencyKey('post_invoice_group', profile?.id || '');

  // Flag gate: null = still reading, false = OFF (render notice), true = ON (render editor).
  const [flagEnabled, setFlagEnabled] = useState<boolean | null>(null);

  // Picker data
  const [fieldOptions, setFieldOptions] = useState<FieldOption[]>([]);
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [serviceOptions, setServiceOptions] = useState<ServiceOption[]>([]);
  const [jobOptions, setJobOptions] = useState<JobOption[]>([]);

  // Header + selection
  // Local date (not toISOString, which rolls to tomorrow after ~6–7 PM Central) — Codex r2 #J.
  const [invoiceDate, setInvoiceDate] = useState(() => localToday());
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

  // Save / post state + results
  const [billingSetId, setBillingSetId] = useState<string | null>(null);
  const [invoiceGroupId, setInvoiceGroupId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [showPostConfirm, setShowPostConfirm] = useState(false);
  const [resultInvoices, setResultInvoices] = useState<ResultInvoice[]>([]);
  const [resultShares, setResultShares] = useState<ResultShare[]>([]);
  const [posted, setPosted] = useState(false);
  // #H: while a reopened set loads, and to lock the read-only reopen view.
  const [reopenLoading, setReopenLoading] = useState(false);
  // Dirty guard (Codex P1 #5): Post commits the last SAVED draft from the DB. After a Save,
  // editing any field/line/percentage/price/header must disable Post until a re-save — else the
  // operator posts stale amounts. Track the saved input signature vs the current one.
  const [savedSig, setSavedSig] = useState<string | null>(null);
  const currentSig = useMemo(
    () => JSON.stringify({ d: invoiceDate, n: headerNotes, j: sourceJobId, f: fields, l: lines }),
    [invoiceDate, headerNotes, sourceJobId, fields, lines],
  );
  // Unsaved edits exist once a draft is saved and the inputs no longer match what was saved.
  // Never "dirty" in reopen mode — the editable inputs aren't rendered, so there's nothing to edit.
  const dirtyAfterSave = !isReopen && billingSetId !== null && savedSig !== currentSig;

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
          supabase.from('fields').select('id, field_name').eq('is_active', true).order('field_name').limit(1000),
          supabase.from('products').select('id, product_name').eq('is_active', true).order('product_name').limit(1000),
          supabase.from('application_services').select('id, name').eq('is_active', true).order('sort_order'),
          supabase
            .from('jobs')
            // #E (Codex round-2): only COMPLETED, not-yet-invoiced jobs can be billed. An
            // 'invoiced' job is already billed (via split or the normal flow); showing it would
            // invite a double-bill that the save RPC now hard-refuses anyway.
            .select('id, job_number, job_date, customer:customers(farm_name)')
            .eq('status', 'completed')
            .order('job_date', { ascending: false })
            .limit(200),
        ]);
        if (cancelled) return;
        setFieldOptions(((flds.data as Array<{ id: string; field_name: string | null }> | null) ?? []).map((f) => ({ id: f.id, field_name: f.field_name || 'Unnamed field' })));
        setProductOptions(((prods.data as Array<{ id: string; product_name: string | null }> | null) ?? []).map((p) => ({ id: p.id, product_name: p.product_name || 'Unnamed product' })));
        setServiceOptions(((svcs.data as Array<{ id: string; name: string | null }> | null) ?? []).map((s) => ({ id: s.id, name: s.name || 'Unnamed service' })));
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
    setFields((prev) => [...prev, { field_id: opt.id, field_name: opt.field_name, applied_acres: '' }]);
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
      const acresMap: Record<string, number> = {};
      validFields.forEach((f) => { acresMap[f.field_id] = parseFloat(f.applied_acres); });
      const { data, error } = await supabaseUntyped.rpc('resolve_line_split_vector', {
        p_field_ids: validFields.map((f) => f.field_id),
        p_source_job_id: sourceJobId || null,
        p_applied_acres_map: acresMap,
      });
      if (error) throw error;
      const vector = assertRpcResult<Array<{ customer_id: string; micro_pct: number }>>(data, 'resolve_line_split_vector');
      const nextMembers = vector.map((v) => ({ customer_id: v.customer_id, micro_pct: Number(v.micro_pct) }));
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
        serviceAcres: '',
        unitPriceDollars: '',
        overridePrice: false,
        flatDollars: '',
        rateUnit: '',
        customized: false,
        splitReason: '',
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

  // Pre-save SOURCE estimate for a line (flat only). NOT authoritative.
  // Chemical prices are resolved server-side (quote → tier) with a rate→sold-unit
  // conversion, so there is no reliable client estimate; service rate also defaults
  // server-side. Both show their real per-grower amounts after Save Draft.
  const lineEstimateCents = (l: LineDraft): number | null => {
    if (l.line_kind === 'flat_fee') return dollarsToCents(l.flatDollars);
    return null;
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
        if (!l.product_id) return 'A chemical line has no product selected.';
        if (!(parseFloat(l.quantity) > 0)) return 'A chemical line has no quantity.';
        if (!l.rateUnit.trim()) return 'A chemical line needs a rate unit (e.g. oz, gal) so the price can be resolved.';
        if (l.overridePrice) {
          const c = dollarsToCents(l.unitPriceDollars);
          // Reject <= 0 (not just < 0): a malformed entry like "1e5" parses to 0 and must NOT
          // be accepted as a $0 override (would give product away) — Codex r2 #D.
          if (c == null || c <= 0) return 'A chemical line has Override price on but no valid positive unit price.';
        }
      } else if (l.line_kind === 'service') {
        if (!l.application_service_id) return 'A service line has no application service selected.';
      } else if (l.line_kind === 'flat_fee') {
        const c = dollarsToCents(l.flatDollars);
        if (c == null || c <= 0) return 'A flat-fee line needs a positive amount (credits aren’t supported here yet).';
        if (!l.description.trim()) return 'A flat-fee line needs a description.';
      }
      if (l.customized) {
        const sum = shareSumPct(l);
        if (Math.abs(sum - 100) > 0.01) return `A customized line's percentages sum to ${sum.toFixed(2)}% — they must total 100%.`;
        // Codex r4 P1: a per-PERSON price override must be a valid positive amount. dollarsToCents
        // returns 0 for sci-notation ("1e5") and null for blank — both would otherwise post a $0
        // override and give product away. The round-2 #D fix only covered the LINE-level override;
        // this covers the per-share path.
        for (const s of l.shares) {
          if (s.override) {
            const oc = dollarsToCents(s.overridePriceDollars);
            if (oc == null || oc <= 0) return 'A per-person price override is on but has no valid positive amount.';
          }
        }
      }
    }
    return null;
  }

  function buildLinesPayload(): Record<string, unknown>[] {
    return lines.map((l) => {
      const base: Record<string, unknown> = { line_kind: l.line_kind };
      if (l.description.trim()) base.description = l.description.trim();
      if (l.rateUnit.trim()) base.rate_unit = l.rateUnit.trim();

      if (l.line_kind === 'chemical') {
        base.product_id = l.product_id;
        base.source_quantity = parseFloat(l.quantity);
        // Price is resolved server-side (quote → tier). Only send a price as an
        // explicit manual override; base_price_source is server-determined.
        if (l.overridePrice) {
          base.manual_override = true;
          base.source_unit_price_cents = dollarsToCents(l.unitPriceDollars);
        }
      } else if (l.line_kind === 'service') {
        base.application_service_id = l.application_service_id;
        const acres = parseFloat(l.serviceAcres);
        if (Number.isFinite(acres) && acres > 0) base.source_acres = acres;
        // Price omitted → server resolves each co-owner's per-acre rate from
        // customer_application_rates (season) → the app-service default (Option B for service).
      } else {
        base.source_flat_cents = dollarsToCents(l.flatDollars);
      }

      if (l.customized) {
        const micro = pctsToMicro(l.shares.map((s) => parseFloat(s.pct) || 0));
        base.shares = l.shares.map((s, i) => {
          const share: Record<string, unknown> = {
            customer_id: s.customer_id,
            micro_pct: micro[i],
            split_mode: 'custom',
            price_mode: s.override ? 'override' : 'default',
          };
          if (s.override) {
            const oc = dollarsToCents(s.overridePriceDollars);
            if (oc != null) share.override_unit_price_cents = oc;
            // #L: capture the operator's reason for a price override, when given.
            if (s.overrideReason.trim()) share.price_override_reason = s.overrideReason.trim();
          }
          // #L: a customized split carries the line-level reason on every share of the line.
          if (l.splitReason.trim()) share.split_override_reason = l.splitReason.trim();
          return share;
        });
      }
      return base;
    });
  }

  const loadResults = useCallback(async (setId: string) => {
    // 1) Child invoices for this billing set (authoritative totals + send disposition).
    const { data: invRows, error: invErr } = await supabaseUntyped
      .from('invoices')
      .select('id, invoice_number, customer_id, total_amount_cents, send_disposition, status')
      .eq('field_app_billing_set_id', setId)
      .order('invoice_number');
    if (invErr) throw invErr;
    const invoices = ((invRows as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
      id: r.id as string,
      invoice_number: (r.invoice_number as string | null) ?? null,
      customer_id: r.customer_id as string,
      total_amount_cents: Number(r.total_amount_cents ?? 0),
      send_disposition: ((r.send_disposition as string) === 'suppressed_zero_total' ? 'suppressed_zero_total' : 'normal') as ResultInvoice['send_disposition'],
      status: (r.status as string) || 'draft',
    }));
    setResultInvoices(invoices);
    // "Posted" means every child is in a COMMITTED status — NOT merely "not draft" (Codex round-3
    // P2). An unposted group has children in status 'unposted'; treating that as posted would label
    // a reopened, re-postable group "Posted" and disable Post, breaking the unpost/repost lifecycle.
    setPosted(invoices.length > 0
      && invoices.every((i) => i.status !== 'draft' && i.status !== 'unposted'));

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
  }, [customerNames]);

  const handleSave = async () => {
    const problem = validateForSave();
    if (problem) { toast('error', problem); return; }
    if (!profile?.id) return;
    setSaving(true);
    try {
      const validFields = fields.filter((f) => (parseFloat(f.applied_acres) || 0) > 0);
      const { data, error } = await supabaseUntyped.rpc('save_field_app_split_invoice', {
        p_billing_set_id: billingSetId,
        p_source_job_id: sourceJobId || null,
        p_invoice: {
          invoice_date: invoiceDate,
          ...(headerNotes.trim() ? { header_notes: headerNotes.trim() } : {}),
          ...(profile.id ? { salesman_id: profile.id } : {}),
        },
        p_fields: validFields.map((f) => ({ field_id: f.field_id, applied_acres: parseFloat(f.applied_acres) })),
        p_lines: buildLinesPayload(),
        p_performed_by: profile.id,
        p_application_service_id: null,
        p_idempotency_key: saveIdem.getKey(),
      });
      if (error) throw error;
      const res = assertRpcResult<{ billing_set_id: string; invoice_group_id: string; invoice_ids: string[]; line_vector_hashes: string[] }>(
        data, 'save_field_app_split_invoice',
      );
      setBillingSetId(res.billing_set_id);
      setInvoiceGroupId(res.invoice_group_id);
      setSavedSig(currentSig); // snapshot what was just persisted → Post is enabled until the next edit (#5)
      saveIdem.resetKey(); // next save is a distinct action → fresh key
      await loadResults(res.billing_set_id);
      toast('success', 'Draft split invoice saved.');
    } catch (err) {
      toast('error', splitBackendError(err));
    } finally {
      setSaving(false);
    }
  };

  const handlePost = async () => {
    if (!invoiceGroupId || !profile?.id) return;
    setPosting(true);
    setShowPostConfirm(false);
    try {
      const { data, error } = await supabaseUntyped.rpc('post_invoice_group', {
        p_invoice_group_id: invoiceGroupId,
        p_performed_by: profile.id,
        p_idempotency_key: postIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'post_invoice_group');
      postIdem.resetKey();
      if (billingSetId) await loadResults(billingSetId);
      toast('success', 'Invoice group posted.');
    } catch (err) {
      toast('error', splitBackendError(err));
    } finally {
      setPosting(false);
    }
  };

  // ── #H reopen: hydrate a previously-saved set (read-only) for review + Post ──
  useEffect(() => {
    if (flagEnabled !== true || !routeSetId) return;
    let cancelled = false;
    (async () => {
      setReopenLoading(true);
      try {
        const { data: setRow, error } = await supabaseUntyped
          .from('field_app_billing_sets')
          .select('id, invoice_group_id, source_job_id')
          .eq('id', routeSetId)
          .maybeSingle();
        if (error) throw error;
        if (cancelled) return;
        if (!setRow) {
          toast('error', 'That split billing draft was not found.');
          navigate('/field-invoices');
          return;
        }
        const row = setRow as { id: string; invoice_group_id: string | null; source_job_id: string | null };
        setBillingSetId(row.id);
        setInvoiceGroupId(row.invoice_group_id ?? null);
        setSourceJobId(row.source_job_id ?? '');
        await loadResults(row.id);
      } catch (err) {
        if (!cancelled) toast('error', sanitizeError(err));
      } finally {
        if (!cancelled) setReopenLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [flagEnabled, routeSetId, loadResults, navigate, toast]);

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
            <h1 className="text-xl font-semibold font-heading text-nav-dark">
              {isReopen ? (posted ? 'Split Billing — Posted' : 'Split Billing — Saved Draft') : 'Split Billing — New'}
            </h1>
            <p className="text-xs text-secondary">Per-line split of a field application across multiple customers.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isReopen && (
            <Button variant="secondary" icon={<Save className="w-4 h-4" />} showChevron={false} loading={saving} onClick={handleSave}>
              {billingSetId ? 'Re-save Draft' : 'Save Draft'}
            </Button>
          )}
          <Button
            variant="primary"
            icon={<Send className="w-4 h-4" />}
            showChevron={false}
            disabled={!invoiceGroupId || posted || dirtyAfterSave}
            loading={posting}
            onClick={() => setShowPostConfirm(true)}
            title={dirtyAfterSave ? 'You have unsaved changes — re-save the draft before posting.' : undefined}
          >
            {posted ? 'Posted' : 'Post'}
          </Button>
        </div>
      </div>

      {dirtyAfterSave && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          You have unsaved changes. Re-save the draft before posting so the posted amounts match what&rsquo;s on screen.
        </div>
      )}

      {isReopen && reopenLoading && (
        <div className="flex items-center justify-center py-10">
          <div className="w-6 h-6 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {isReopen && !reopenLoading && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-sm text-blue-800">
          {posted
            ? 'This split invoice group is posted and read-only.'
            : 'Reopened a saved draft. Review the server-computed split below, then Post when you’re ready. To change the split, start a new one.'}
        </div>
      )}

      {/* Invoice header + source job */}
      {!isReopen && (<>
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
            <span className="text-xs font-medium text-secondary">Source job (optional — for job-share precedence)</span>
            <select
              value={sourceJobId}
              onChange={(e) => setSourceJobId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="">No source job</option>
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
              <Button variant="ghost" size="sm" icon={<Plus className="w-4 h-4" />} showChevron={false} onClick={() => addLine('chemical')}>Chemical</Button>
              <Button variant="ghost" size="sm" icon={<Plus className="w-4 h-4" />} showChevron={false} onClick={() => addLine('service')}>Service</Button>
              <Button variant="ghost" size="sm" icon={<Plus className="w-4 h-4" />} showChevron={false} onClick={() => addLine('flat_fee')}>Flat fee</Button>
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
              const sumOk = Math.abs(sum - 100) <= 0.01;
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
                            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
                          >
                            <option value="">Select a product…</option>
                            {productOptions.map((p) => (<option key={p.id} value={p.id}>{p.product_name}</option>))}
                          </select>
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Total quantity</span>
                          <input type="number" min="0" step="0.0001" value={l.quantity} onChange={(e) => patchLine(l.uid, { quantity: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Rate unit</span>
                          <input type="text" value={l.rateUnit} onChange={(e) => patchLine(l.uid, { rateUnit: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="oz, gal…" />
                        </label>
                        <div className="block sm:col-span-2">
                          <label className="inline-flex items-center gap-2 text-xs font-medium text-secondary">
                            <input
                              type="checkbox"
                              checked={l.overridePrice}
                              onChange={(e) => patchLine(l.uid, { overridePrice: e.target.checked })}
                              className="rounded border-gray-300"
                            />
                            Override price
                          </label>
                          {l.overridePrice ? (
                            <label className="block mt-2">
                              <span className="text-xs font-medium text-secondary">Unit price ($ / sold unit)</span>
                              <input type="number" min="0" step="0.01" value={l.unitPriceDollars} onChange={(e) => patchLine(l.uid, { unitPriceDollars: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                            </label>
                          ) : (
                            <p className="mt-1 text-xs text-secondary">Price is resolved on save from the customer's quote, then the product's tier price.</p>
                          )}
                        </div>
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
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Total acres (optional)</span>
                          <input type="number" min="0" step="0.01" value={l.serviceAcres} onChange={(e) => patchLine(l.uid, { serviceAcres: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder={`defaults to ${totalAppliedAcres.toFixed(2)}`} />
                        </label>
                        <p className="text-xs text-secondary sm:col-span-2">The service rate defaults to the application service's configured rate on save.</p>
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
                  {members.length > 0 && (
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
                            {s.override && (
                              <input
                                type="text"
                                value={s.overrideReason}
                                onChange={(e) => patchShare(l.uid, s.customer_id, { overrideReason: e.target.value })}
                                className="flex-1 min-w-[10rem] rounded-lg border border-gray-300 px-2 py-1 text-sm"
                                placeholder="Reason for override (optional)"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                      {l.customized && (
                        <>
                          <p className={`mt-2 text-xs ${sumOk ? 'text-secondary' : 'text-red-600'}`}>
                            Percent total: {sum.toFixed(2)}% {sumOk ? '' : '— must equal 100%'}
                          </p>
                          <input
                            type="text"
                            value={l.splitReason}
                            onChange={(e) => patchLine(l.uid, { splitReason: e.target.value })}
                            className="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
                            placeholder="Reason for custom split (optional)"
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      </>)}

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
        title="Post this split invoice group?"
        message="Posting freezes the per-line split and each customer's invoice. This cannot be edited afterward without unposting."
        confirmLabel="Post"
        variant="info"
        icon={Send}
        loading={posting}
      />
    </div>
  );
}
