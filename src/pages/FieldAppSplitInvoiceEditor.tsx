import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useCreditLimitCheck } from '../hooks/useGuardrails';
import { checkRUPCompliance, rupRegisterDisposition } from '../lib/rupCompliance';
import { Sentry } from '../lib/sentry';
import { formatCents } from '../lib/money';
import { pctsToMicro } from '../lib/splitVectorMath';
import { MONEY_PRECISION_MESSAGE, parseDollarsToCents } from '../lib/parseCents';
import { localToday } from '../lib/dateUtils';
import { SPLIT_BILLING_SETTING_KEY, parseSplitBillingEnabled } from '../lib/splitBillingSetting';
import { ProductOptionDetails, productOptionLabel, type ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';
import UnitSelect from '../components/blendtickets/UnitSelect';
import { blockedUnitSaveMessage, isKnownUnit, type UnitLoadState } from '../lib/units';
import type { UnitConversion } from '../types';

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

interface ProductOption extends ProductOptionPresentationModel {
  product_name: string;
  /** liquid | dry — decides which unit_conversions rows the rate-unit picker offers. */
  product_form: string | null;
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
  // Client-only React list key for a line row (not a security token / idempotency key).
  // Use crypto.randomUUID() — the codebase convention — so CodeQL's js/insecure-randomness
  // rule doesn't flag Math.random() in this money-adjacent file.
  uidCounter += 1;
  return `line_${uidCounter}_${crypto.randomUUID()}`;
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
  // More than two decimals is refused by the parser (null). Surface it the same
  // way as "not entered": validateForSave() then names the line and blocks the
  // save, instead of a truncated price reaching the RPC.
  if (cents === null) return null;
  // parseDollarsToCents is positive-only (it strips the sign). Preserve a leading minus so
  // downstream validation (`<= 0` / `< 0`) REJECTS a credit/negative instead of silently
  // flipping e.g. "-50.00" into a +$50 CHARGE (Codex r2 #C). Flat-fee credits aren't a
  // supported split-editor flow yet.
  return /^\s*-/.test(raw) ? -cents : cents;
}

/** True when the operator TYPED an amount the parser refuses (more than two decimals).
 *  dollarsToCents() returns null for both "not entered" and "refused"; validateForSave()
 *  checks this first so the operator is told the real cause (CodeRabbit on PR #588). */
function hasExcessPrecision(raw: string): boolean {
  return raw != null && raw.trim() !== '' && parseDollarsToCents(raw) === null;
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
  const resetPostIdemKey = postIdem.resetKey; // stable useCallback identity — safe as an effect dep

  // Flag gate: null = still reading, false = OFF (render notice), true = ON (render editor).
  const [flagEnabled, setFlagEnabled] = useState<boolean | null>(null);

  // Picker data
  const [fieldOptions, setFieldOptions] = useState<FieldOption[]>([]);
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  // Rate unit is a PICKER, not free text, so an operator can no longer invent a unit the
  // pricing engine cannot resolve. unitLoad is tracked separately from the array because an
  // empty array means three different things (in flight / fetch failed / table really is
  // empty) and only this caller knows which — see blockedUnitSaveMessage.
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);
  const [unitLoad, setUnitLoad] = useState<UnitLoadState>('pending');
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
  // Fable-adversarial HIGH: "latest load wins". loadResults awaits several queries; without this a
  // slow load for set A could resolve AFTER a newer load for set B and overwrite B's result card with
  // A's amounts while the URL/billingSetId are B's — the operator would then review A but Post B. Each
  // loadResults stamps this ref; a stale in-flight load sees the ref changed and bails before setState.
  const activeLoadSetIdRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [showPostConfirm, setShowPostConfirm] = useState(false);
  // Codex round-8 P2: the credit-limit + RUP-license advisories the normal invoice post shows.
  const { check: checkCreditLimit } = useCreditLimitCheck();
  const [postWarning, setPostWarning] = useState<string | null>(null);
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
        const [flds, prods, svcs, jbs, units] = await Promise.all([
          supabase.from('fields').select('id, field_name').eq('is_active', true).order('field_name').limit(1000),
          supabase.from('products').select('id, product_name, sku, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, product_form, product_family:product_families(name)').eq('is_active', true).order('product_name').limit(1000),
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
          supabase.from('unit_conversions').select('*').order('unit'),
        ]);
        if (cancelled) return;
        const pickerErrors = [flds.error, prods.error, svcs.error, jbs.error, units.error].filter(Boolean);
        if (pickerErrors.length > 0) {
          pickerErrors.forEach((error) => {
            Sentry.captureException(error, { extra: { context: 'load_field_app_split_invoice_pickers' } });
          });
          toast('error', 'Some field application invoice pickers could not be loaded.');
        }
        if (!flds.error) {
          setFieldOptions(((flds.data as Array<{ id: string; field_name: string | null }> | null) ?? []).map((f) => ({ id: f.id, field_name: f.field_name || 'Unnamed field' })));
        }
        if (!prods.error) {
          setProductOptions(((prods.data as Array<ProductOption> | null) ?? []).map((p) => ({ ...p, product_name: p.product_name || 'Unnamed product' })));
        }
        if (!svcs.error) {
          setServiceOptions(((svcs.data as Array<{ id: string; name: string | null }> | null) ?? []).map((s) => ({ id: s.id, name: s.name || 'Unnamed service' })));
        }
        if (units.error) {
          setUnitLoad('failed');
        } else {
          setUnitConversions((units.data || []) as UnitConversion[]);
          setUnitLoad('loaded');
        }
        if (!jbs.error) {
          setJobOptions(
            ((jbs.data as Array<{ id: string; job_number: string | null; job_date: string | null; customer: { farm_name?: string | null } | null }> | null) ?? []).map((j) => ({
              id: j.id,
              label: `${j.job_number || 'Job'}${j.job_date ? ` — ${j.job_date}` : ''}${j.customer?.farm_name ? ` (${j.customer.farm_name})` : ''}`,
            })),
          );
        }
      } catch (err) {
        if (!cancelled) {
          // A thrown request never reached the `units.error` branch above, so without this the
          // picker stays 'pending' forever and a save would keep telling the operator to "try
          // again in a moment" for a request that is never coming back.
          setUnitLoad('failed');
          Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'load_field_app_split_invoice_pickers' } });
          toast('error', sanitizeError(err));
        }
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
    if (fields.length === 0) return 'Add at least one field with applied acres greater than zero.';
    // Codex round-6 P1: every SELECTED field must carry positive acres. The save path bills only
    // fields with acres > 0, so a selected field left blank/zero would be silently dropped from
    // allocation + application records (underbilling). Require acres on each, or Remove the field.
    for (const f of fields) {
      if (!(parseFloat(f.applied_acres) > 0)) {
        return `Field "${f.field_name}" has no applied acres. Enter acres greater than zero, or remove the field.`;
      }
    }
    // Checked before the per-line "needs a rate unit" rule below: when the unit list never
    // arrived the operator had no way to pick anything, so telling them to enter a rate unit
    // blames them for the request's failure. Name the real cause instead.
    const unitBlock = blockedUnitSaveMessage(
      unitLoad,
      unitConversions,
      lines.some((l) => l.line_kind === 'chemical' && !l.rateUnit.trim()),
    );
    if (unitBlock) return unitBlock;
    if (members.length === 0) return 'Resolve the default split before saving.';
    if (lines.length === 0) return 'Add at least one billing line.';
    // Codex round-7 P1 (RUP under-reporting): the same chemical product on two lines yields two
    // invoice_items with the same product_id; regulated-use reporting de-dups by product and would
    // report only one, under-stating the regulated quantity. Require one line per chemical product.
    const chemProductIds = lines.filter((l) => l.line_kind === 'chemical' && l.product_id).map((l) => l.product_id);
    if (new Set(chemProductIds).size !== chemProductIds.length) {
      return 'The same chemical product is on more than one line. Combine them into a single line.';
    }
    for (const l of lines) {
      if (l.line_kind === 'chemical') {
        if (!l.product_id) return 'A chemical line has no product selected.';
        if (!(parseFloat(l.quantity) > 0)) return 'A chemical line has no quantity.';
        if (!l.rateUnit.trim()) return 'A chemical line needs a rate unit (e.g. oz, gal) so the price can be resolved.';
        if (l.overridePrice) {
          if (hasExcessPrecision(l.unitPriceDollars)) return `A chemical line's override unit price: ${MONEY_PRECISION_MESSAGE}`;
          const c = dollarsToCents(l.unitPriceDollars);
          // Reject <= 0 (not just < 0): a malformed entry like "1e5" parses to 0 and must NOT
          // be accepted as a $0 override (would give product away) — Codex r2 #D.
          if (c == null || c <= 0) return 'A chemical line has Override price on but no valid positive unit price.';
        }
      } else if (l.line_kind === 'service') {
        if (!l.application_service_id) return 'A service line has no application service selected.';
        // Codex round-6 P1: service acres are the billable basis. If the user TYPED a value it must
        // be a positive number — otherwise buildLinesPayload silently omits source_acres and the RPC
        // bills the FULL field acreage (overbilling on a mistaken 0 / negative / "abc"). A blank is
        // still allowed and explicitly means "bill the full selected field acreage".
        if (l.serviceAcres.trim() !== '' && !(parseFloat(l.serviceAcres) > 0)) {
          return 'A service line has an invalid acres value. Enter a positive number, or clear it to bill the full field acreage.';
        }
      } else if (l.line_kind === 'flat_fee') {
        if (hasExcessPrecision(l.flatDollars)) return `A flat-fee line's amount: ${MONEY_PRECISION_MESSAGE}`;
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
        // Codex round-6 P2: a per-share price override only affects per-unit lines (chemical/service);
        // the calculator ignores override_unit_price_cents for flat-fee lines (allocated from
        // source_flat_cents), so don't validate/require it there — the UI also hides the control.
        if (l.line_kind !== 'flat_fee') {
          for (const s of l.shares) {
            if (s.override) {
              if (hasExcessPrecision(s.overridePriceDollars)) return `A per-person price override: ${MONEY_PRECISION_MESSAGE}`;
              const oc = dollarsToCents(s.overridePriceDollars);
              if (oc == null || oc <= 0) return 'A per-person price override is on but has no valid positive amount.';
            }
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
          // Codex round-6 P2: a per-share price override is meaningless for flat-fee lines (the
          // calculator allocates them from source_flat_cents and ignores override_unit_price_cents),
          // so never send it there — treat the share as a plain default split.
          const allowOverride = l.line_kind !== 'flat_fee' && s.override;
          const share: Record<string, unknown> = {
            customer_id: s.customer_id,
            micro_pct: micro[i],
            split_mode: 'custom',
            price_mode: allowOverride ? 'override' : 'default',
          };
          if (allowOverride) {
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

  // Returns true ONLY when the full readback completed for the requested set; false when the load
  // was abandoned as stale. Callers that enable Post must require `true` — a stale bail must never
  // look like a verified readback (Codex r5 P1 contract).
  const loadResults = useCallback(async (setId: string): Promise<boolean> => {
    // Fable-adversarial HIGH: mark this as the latest load; a slower earlier load bails at each
    // `stale()` checkpoint below instead of overwriting a newer set's result card.
    activeLoadSetIdRef.current = setId;
    const stale = () => activeLoadSetIdRef.current !== setId;
    // 1) Child invoices for this billing set (authoritative totals + send disposition).
    const { data: invRows, error: invErr } = await supabaseUntyped
      .from('invoices')
      .select('id, invoice_number, customer_id, total_amount_cents, send_disposition, status')
      .eq('field_app_billing_set_id', setId)
      // Codex round-6/7 P1/P2: the review card + totals must match EXACTLY what post_invoice_group will
      // act on (it operates on the active invoice_group). Exclude soft-deleted children AND children
      // detached from the group on re-save (voided/cancelled terminal rows keep field_app_billing_set_id
      // as history but have invoice_group_id = NULL) — otherwise the historical child and its active
      // replacement both show, and the operator reviews stale/duplicate totals before posting different
      // invoices. `invoice_group_id IS NOT NULL` == "still an active member of this set's group".
      .is('deleted_at', null)
      .not('invoice_group_id', 'is', null)
      .order('invoice_number');
    if (invErr) throw invErr;
    if (stale()) return false;
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
    if (invoiceIds.length === 0) { if (stale()) return false; setResultShares([]); return true; }

    // 2) Invoice items (invoice_id + description) for those invoices.
    const { data: itemRows, error: itemErr } = await supabaseUntyped
      .from('invoice_items')
      .select('id, invoice_id, description')
      .in('invoice_id', invoiceIds);
    if (itemErr) throw itemErr; // Codex r5 P1: a swallowed read error must not leave Post enabled on unseen data
    const itemMap = new Map<string, { invoice_id: string; description: string }>();
    ((itemRows as Array<Record<string, unknown>> | null) ?? []).forEach((it) => {
      itemMap.set(it.id as string, { invoice_id: it.invoice_id as string, description: (it.description as string) || '' });
    });

    if (stale()) return false;
    // 3) Per-line shares, joined to their item for invoice_id + description.
    const itemIds = Array.from(itemMap.keys());
    if (itemIds.length === 0) { setResultShares([]); return true; }
    const { data: shareRows, error: shareErr } = await supabaseUntyped
      .from('invoice_line_shares')
      .select('invoice_item_id, customer_id, unit_price_cents, amount_cents')
      .in('invoice_item_id', itemIds);
    if (shareErr) throw shareErr; // Codex r5 P1: surface, don't silently render an incomplete split
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
    if (stale()) return false;
    setResultShares(shares);
    return true;
  }, [customerNames]);

  const handleSave = async () => {
    const problem = validateForSave();
    if (problem) { toast('error', problem); return; }
    if (!profile?.id) return;
    setSaving(true);
    // Codex round-8 P1: a re-save may RE-PRICE (server-resolved quote/tier/service prices can move).
    // Revoke any prior posting authorization NOW so Post is disabled during the RPC + readback and
    // STAYS disabled if the readback fails — it is restored only after loadResults succeeds below.
    setInvoiceGroupId(null);
    setSavedSig(null);
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
      // billingSetId is safe to set now (enables re-save / retry). But do NOT enable Post yet —
      // Codex r5 P1: if the authoritative readback fails, invoiceGroupId/savedSig must stay unset so
      // Post can't act on stale/unseen amounts. loadResults throws on any read error (surfaced below).
      setBillingSetId(res.billing_set_id);
      // Codex round-6 P2: the mutation COMMITTED — rotate the idempotency key NOW, before the
      // readback. A readback failure must not strand the committed key (a Save retry would then resend
      // it with a new payload hash → IDEMPOTENCY_PAYLOAD_CONFLICT, unrecoverable without a reload).
      saveIdem.resetKey();
      let readbackComplete = false;
      try {
        readbackComplete = await loadResults(res.billing_set_id);
      } catch {
        // Save succeeded but the authoritative readback failed: keep Post DISABLED (invoiceGroupId
        // stays unset per r5) and tell the operator to reload before posting.
        toast('info', 'Saved. Reload to refresh the summary before posting.');
      }
      if (readbackComplete) {
        setInvoiceGroupId(res.invoice_group_id);
        setSavedSig(currentSig); // snapshot what was just persisted → Post is enabled until the next edit (#5)
      }
      toast('success', 'Draft split invoice saved.');
    } catch (err) {
      toast('error', splitBackendError(err));
    } finally {
      setSaving(false);
    }
  };

  // Codex round-8 P2: mirror the normal invoice post flow's guardrails BEFORE confirming the post.
  // post_invoice_group posts EVERY co-owner child, so the credit-limit + RUP-license advisories must
  // cover the WHOLE group. Advisory only — this NEVER blocks posting (parity with InvoiceDetail).
  const openPostConfirm = async () => {
    let warning: string | null = null;
    try {
      const { data: grp } = await supabaseUntyped
        .from('invoices')
        .select('id, invoice_number, customer_id, total_amount_cents, invoice_items(product_id)')
        .eq('invoice_group_id', invoiceGroupId)
        .is('deleted_at', null)
        .not('invoice_group_id', 'is', null);
      const rupParts: string[] = [];
      const creditParts: string[] = [];
      for (const inv of ((grp as Array<{ invoice_number: string; customer_id: string | null; total_amount_cents: number | null; invoice_items: { product_id: string | null }[] | null }>) || [])) {
        const pids = (inv.invoice_items || []).map((x) => x.product_id).filter((p): p is string => Boolean(p));
        if (inv.customer_id && pids.length > 0) {
          const res = await checkRUPCompliance(inv.customer_id, pids);
          if (res.hasRUPProducts && !res.hasValidLicense) {
            const disp = rupRegisterDisposition(res);
            rupParts.push(`${inv.invoice_number}: ${res.rupProductNames.join(', ')} — ${res.missingLicense ? 'NO applicator license' : 'EXPIRED license'} (${disp.label})`);
          }
        }
        if (inv.customer_id && Number(inv.total_amount_cents ?? 0) > 0) {
          const ok = await checkCreditLimit({ customerId: inv.customer_id, newAmountCents: Number(inv.total_amount_cents) });
          if (!ok) creditParts.push(inv.invoice_number);
        }
      }
      const bits: string[] = [];
      if (rupParts.length > 0) bits.push(`Restricted-use products without a valid license — ${rupParts.join('; ')}. These will be recorded in the RUP sales register.`);
      if (creditParts.length > 0) bits.push(`Over credit limit: invoice(s) ${creditParts.join(', ')}.`);
      if (bits.length > 0) warning = `Posting this group posts every invoice in it. ${bits.join(' ')}`;
    } catch (err) {
      // Advisory must never block posting — a check failure falls through to the plain confirm.
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'split_post_guardrails' } });
    }
    setPostWarning(warning);
    setShowPostConfirm(true);
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
      // Codex round-6 P2: the group IS posted now. Reflect it immediately and treat the readback as a
      // best-effort refresh — a failing readback must NOT leave the UI showing "unposted" (a retry
      // would then hit already-posted invoices with a fresh key and fail).
      setPosted(true);
      toast('success', 'Invoice group posted.');
      if (billingSetId) {
        try {
          await loadResults(billingSetId);
        } catch {
          toast('info', 'Posted. Reload to refresh the on-screen summary.');
        }
      }
    } catch (err) {
      toast('error', splitBackendError(err));
    } finally {
      setPosting(false);
    }
  };

  // Codex round-10 P1: this editor stays MOUNTED when navigating between saved split drafts
  // (/split-billing/:id → :id), so a stale post-idempotency key would make post_invoice_group return a
  // PRIOR group's cached success (it keys on operation+key, not p_invoice_group_id) while the current
  // group stays unposted. Scope the key to the group — reset it whenever invoiceGroupId changes.
  useEffect(() => { resetPostIdemKey(); }, [invoiceGroupId, resetPostIdemKey]);

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
        setSourceJobId(row.source_job_id ?? '');
        // Codex round-6 P1: expose the group id to the posting state ONLY after a COMPLETE readback.
        // If the set row loads but any invoice/item/share query fails, leaving invoiceGroupId set would
        // enable Post on empty/partial results (posted stays false, dirtyAfterSave false).
        const readbackComplete = await loadResults(row.id);
        if (readbackComplete) setInvoiceGroupId(row.invoice_group_id ?? null);
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
            disabled={!invoiceGroupId || posted || dirtyAfterSave || saving || posting}
            loading={posting}
            onClick={openPostConfirm}
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
                            onChange={(e) => {
                              const nextForm = productOptions.find((p) => p.id === e.target.value)?.product_form ?? null;
                              // Switching to a product of the other form would leave the old rate
                              // unit selected as a grandfathered option (a liquid unit on a dry
                              // product). Clear it so the operator must pick one that fits.
                              // Only when the list really loaded: during an outage isKnownUnit is
                              // false for everything, and clearing would wipe a stored unit.
                              const dropUnit = unitLoad === 'loaded' && unitConversions.length > 0
                                && !isKnownUnit(unitConversions, nextForm, l.rateUnit);
                              patchLine(l.uid, dropUnit
                                ? { product_id: e.target.value, rateUnit: '' }
                                : { product_id: e.target.value });
                            }}
                            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
                          >
                            <option value="">Select a product…</option>
                            {productOptions.map((p) => (<option key={p.id} value={p.id}>{productOptionLabel(p)}</option>))}
                          </select>
                          {productOptions.find((p) => p.id === l.product_id) && <ProductOptionDetails product={productOptions.find((p) => p.id === l.product_id)!} />}
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-secondary">Total quantity</span>
                          <input type="number" min="0" step="0.0001" value={l.quantity} onChange={(e) => patchLine(l.uid, { quantity: e.target.value })} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                        </label>
                        <div className="block">
                          <span className="block text-xs font-medium text-secondary mb-1">Rate unit</span>
                          <UnitSelect
                            unitConversions={unitConversions}
                            form={productOptions.find((p) => p.id === l.product_id)?.product_form ?? null}
                            value={l.rateUnit}
                            onChange={(value) => patchLine(l.uid, { rateUnit: value })}
                            disabled={saving}
                            ariaLabel={`Rate unit for ${productOptions.find((p) => p.id === l.product_id)?.product_name || 'chemical line'}`}
                          />
                        </div>
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
                            {/* Codex round-6 P2: a per-share price override is meaningless for flat-fee
                                lines (allocated from source_flat_cents; override ignored) — hide the
                                control there so the review UI can't collect an amount that has no effect. */}
                            {l.line_kind !== 'flat_fee' && (
                              <label className="flex items-center gap-1 text-xs text-secondary">
                                <input
                                  type="checkbox"
                                  checked={s.override}
                                  onChange={(e) => patchShare(l.uid, s.customer_id, { override: e.target.checked })}
                                />
                                price override
                              </label>
                            )}
                            {l.line_kind !== 'flat_fee' && s.override && (
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
                            {l.line_kind !== 'flat_fee' && s.override && (
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
        message={postWarning
          ? `${postWarning}\n\nPosting freezes the per-line split and each customer's invoice. This cannot be edited afterward without unposting. Post anyway?`
          : "Posting freezes the per-line split and each customer's invoice. This cannot be edited afterward without unposting."}
        confirmLabel="Post"
        variant={postWarning ? 'danger' : 'info'}
        icon={Send}
        loading={posting}
      />
    </div>
  );
}
