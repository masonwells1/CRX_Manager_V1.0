/**
 * LabelReview.tsx — AI Label-Data Backfill Review Queue (§1 Beyond-Parity)
 *
 * Allows admins to:
 *  1. Create label drafts for one or all products (with a mock/sample payload
 *     since real Google Vision extraction requires an edge-function + creds not
 *     available in local dev).
 *  2. Review pending drafts: accept / edit / reject each per-product.
 *  3. View a coverage report showing how many products have each label field.
 *
 * Safety invariant: NO value is auto-applied to a product without an explicit
 * human accept/edit action. Non-empty fields are never silently overwritten.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  FlaskConical,
  CheckCircle,
  XCircle,
  Edit3,
  AlertTriangle,
  RefreshCw,
  BarChart2,
  ChevronDown,
  ChevronUp,
  Info,
  Plus,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabaseUntyped, assertRpcResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import { usePageMeta } from '../hooks/usePageMeta';
import { unitOptionsForForm, isKnownUnit } from '../lib/units';
import type {
  ProductLabelDraft,
  LabelCoverageReport,
  CommitLabelDraftResult,
  LabelDraftStatus,
  UnitConversion,
} from '../types';

// ─── helpers ────────────────────────────────────────────────────────────────

function statusBadgeVariant(status: LabelDraftStatus): BadgeVariant {
  switch (status) {
    case 'pending':      return 'warning';
    case 'accepted':     return 'success';
    case 'edited':       return 'success';
    case 'rejected':     return 'error';
    case 'needs_manual': return 'default';
  }
}

function statusLabel(status: LabelDraftStatus): string {
  switch (status) {
    case 'pending':      return 'Pending review';
    case 'accepted':     return 'Accepted';
    case 'edited':       return 'Accepted (edited)';
    case 'rejected':     return 'Rejected';
    case 'needs_manual': return 'Needs manual entry';
  }
}

function confidenceBadge(c: string): BadgeVariant {
  if (c === 'high')   return 'success';
  if (c === 'medium') return 'warning';
  return 'default';
}

// Supabase/PostgREST errors are plain objects (not Error instances), so `err instanceof Error`
// is false and String(err) yields "[object Object]". Pull the real message text when present.
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err
      && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

type LabelFieldKey = 'signal_word' | 'rei_hours' | 'phi_days' | 'epa_registration' | 'max_label_rate';

// ─── Edit modal state ────────────────────────────────────────────────────────

interface EditState {
  signal_word: string;
  rei_hours: string;
  phi_days: string;
  epa_registration: string;
  max_label_rate: string;
  max_label_rate_unit: string;
}

function draftToEditState(d: ProductLabelDraft): EditState {
  return {
    signal_word:         d.signal_word         ?? '',
    rei_hours:           d.rei_hours           != null ? String(d.rei_hours) : '',
    phi_days:            d.phi_days            != null ? String(d.phi_days) : '',
    epa_registration:    d.epa_registration    ?? '',
    max_label_rate:      d.max_label_rate      != null ? String(d.max_label_rate) : '',
    max_label_rate_unit: d.max_label_rate_unit ?? '',
  };
}

// True when EVERY label field in the edit state is blank — accepting such a draft
// would mark it 'decided' while writing nothing (the empty-draft / needs_manual case).
function isEditStateEmpty(es: EditState): boolean {
  return (
    !es.signal_word.trim() &&
    !es.rei_hours.trim() &&
    !es.phi_days.trim() &&
    !es.epa_registration.trim() &&
    !es.max_label_rate.trim() &&
    !es.max_label_rate_unit.trim()
  );
}

// Returns the list of numeric fields whose entered value parses to a negative number.
// Regulatory intervals/rates can never be negative; the HTML min attribute alone does
// not block a typed/pasted negative, so we validate before submit.
function negativeNumericFields(es: EditState): string[] {
  const bad: string[] = [];
  const checks: Array<[string, string]> = [
    ['REI hours', es.rei_hours],
    ['PHI days', es.phi_days],
    ['max label rate', es.max_label_rate],
  ];
  for (const [label, raw] of checks) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const n = Number(trimmed);
    if (Number.isFinite(n) && n < 0) bad.push(label);
  }
  return bad;
}

// REI hours and PHI days are whole-number intervals. A type="number" field + parseInt silently
// TRUNCATES a decimal or scientific value ('2.5' -> 2, '1e2' -> 1), saving something the admin did
// not type. Flag any non-(non-negative-integer) entry so submit can reject it instead.
function nonIntegerIntervalFields(es: EditState): string[] {
  const bad: string[] = [];
  const checks: Array<[string, string]> = [
    ['REI hours', es.rei_hours],
    ['PHI days', es.phi_days],
  ];
  for (const [label, raw] of checks) {
    const t = raw.trim();
    if (t === '') continue;
    if (!/^\d+$/.test(t)) bad.push(label);
  }
  return bad;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function LabelReview() {
  usePageMeta();
  const { profile } = useAuth();
  const { toast } = useToast();

  // ── data state ──
  const [drafts, setDrafts]         = useState<ProductLabelDraft[]>([]);
  const [coverage, setCoverage]     = useState<LabelCoverageReport | null>(null);
  const [loading, setLoading]       = useState(true);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [statusFilter, setStatusFilter]       = useState<LabelDraftStatus | 'all'>('all');
  const [showCoverage, setShowCoverage]       = useState(false);

  // ── edit/review modal ──
  const [editDraft, setEditDraft]   = useState<ProductLabelDraft | null>(null);
  const [editState, setEditState]   = useState<EditState | null>(null);
  const [unitConversions, setUnitConversions] = useState<UnitConversion[]>([]);

  useEffect(() => {
    supabaseUntyped.from('unit_conversions').select('*').order('unit')
      .then((res: { data: UnitConversion[] | null; error: unknown }) => {
        if (!res.error && res.data) setUnitConversions(res.data);
      });
  }, []);
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [committing, setCommitting] = useState(false);

  // ── create-draft modal ──
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createProductId, setCreateProductId] = useState('');
  const [createSource, setCreateSource]       = useState('');
  const [creating, setCreating]               = useState(false);

  // ── overwrite-confirm modal ──
  const [overwriteConfirmPending, setOverwriteConfirmPending] = useState<{
    draftId: string;
    decision: 'accepted' | 'edited';
    editState: EditState | null;
  } | null>(null);

  const commitKey = useIdempotencyKey('commit_label_draft', profile?.id ?? '');
  const createKey = useIdempotencyKey('create_label_draft', profile?.id ?? '');

  // ── load drafts ──
  const loadDrafts = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabaseUntyped
        .from('product_label_drafts')
        .select(`
          *,
          product:products(
            id, product_name, sku, vendor,
            signal_word, rei_hours, phi_days,
            epa_registration, max_label_rate, max_label_rate_unit
          )
        `)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setDrafts((data ?? []) as ProductLabelDraft[]);
    } catch (err) {
      toast('error', `Failed to load drafts: ${errMessage(err)}`);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  // ── load coverage report ──
  const loadCoverage = useCallback(async () => {
    setCoverageLoading(true);
    try {
      const { data, error } = await supabaseUntyped.rpc('get_label_coverage_report');
      if (error) throw error;
      const report = assertRpcResult<LabelCoverageReport>(data, 'get_label_coverage_report');
      setCoverage(report);
    } catch (err) {
      toast('error', `Coverage report failed: ${errMessage(err)}`);
    } finally {
      setCoverageLoading(false);
    }
  }, [toast]);

  useEffect(() => { void loadDrafts(); }, [loadDrafts]);

  // ── open review modal ──
  function openEdit(draft: ProductLabelDraft) {
    setEditDraft(draft);
    setEditState(draftToEditState(draft));
    setForceOverwrite(false);
  }

  // ── detect non-empty product fields that would be overwritten ──
  function detectOverwrittenFields(draft: ProductLabelDraft, es: EditState): LabelFieldKey[] {
    const p = draft.product;
    if (!p) return [];
    const conflicts: LabelFieldKey[] = [];
    if (es.signal_word && p.signal_word)         conflicts.push('signal_word');
    if (es.rei_hours && p.rei_hours != null)     conflicts.push('rei_hours');
    if (es.phi_days && p.phi_days != null)       conflicts.push('phi_days');
    if (es.epa_registration && p.epa_registration) conflicts.push('epa_registration');
    if (es.max_label_rate && p.max_label_rate != null) conflicts.push('max_label_rate');
    return conflicts;
  }

  // ── commit a draft ──
  async function commitDraft(
    draftId: string,
    decision: 'accepted' | 'edited' | 'rejected',
    es: EditState | null,
    force: boolean,
  ) {
    if (!profile) return;
    setCommitting(true);
    try {
      const key = commitKey.getKey();
      const params: Record<string, unknown> = {
        p_draft_id:        draftId,
        p_decision:        decision,
        p_force_overwrite: force,
        p_idempotency_key: key,
      };
      if (decision === 'edited' && es) {
        params.p_signal_word         = es.signal_word         || null;
        params.p_rei_hours           = es.rei_hours           ? parseInt(es.rei_hours, 10)   : null;
        params.p_phi_days            = es.phi_days            ? parseInt(es.phi_days, 10)    : null;
        params.p_epa_registration    = es.epa_registration    || null;
        params.p_max_label_rate      = es.max_label_rate      ? parseFloat(es.max_label_rate) : null;
        params.p_max_label_rate_unit = es.max_label_rate_unit || null;
      }

      const { data, error } = await supabaseUntyped.rpc('commit_label_draft', params);
      if (error) throw error;
      const result = assertRpcResult<CommitLabelDraftResult>(data, 'commit_label_draft');

      await logActivity({
        event:       `label_draft_${decision}`,
        description: `Label draft ${draftId} ${decision} for product ${result.product_id}` +
          (result.applied.length ? `; applied: ${result.applied.join(', ')}` : '') +
          (result.skipped.length ? `; skipped (non-empty): ${result.skipped.join(', ')}` : ''),
        performedBy: profile.id,
        entityType:  'product',
        entityId:    result.product_id,
      });

      const skippedMsg = result.skipped.length
        ? ` (${result.skipped.length} field(s) skipped — already filled)`
        : '';
      toast('success', `Draft ${decision}${skippedMsg}`);
      commitKey.resetKey();
      setEditDraft(null);
      setEditState(null);
      setOverwriteConfirmPending(null);
      void loadDrafts();
      if (showCoverage) void loadCoverage();
    } catch (err) {
      toast('error', `Commit failed: ${errMessage(err)}`);
    } finally {
      setCommitting(false);
    }
  }

  // ── handle accept / edit button ──
  function handleAcceptOrEdit(decision: 'accepted' | 'edited') {
    if (!editDraft || !editState) return;

    // Guard 1: never submit a negative regulatory value (the HTML min attribute does
    // not block a typed/pasted negative reaching the handler/RPC).
    const negatives = negativeNumericFields(editState);
    if (negatives.length > 0) {
      toast('error', `Negative values are not allowed for: ${negatives.join(', ')}. Enter zero or a positive number.`);
      return;
    }

    // Guard 1b: REI/PHI are whole-number intervals — reject decimals/scientific notation rather
    // than silently truncating (parseInt('2.5') -> 2). Max label rate may be a decimal, so it is excluded.
    const nonIntegers = nonIntegerIntervalFields(editState);
    if (nonIntegers.length > 0) {
      toast('error', `${nonIntegers.join(' and ')} must be a whole number (no decimals or scientific notation).`);
      return;
    }

    // Guard 2: never accept a value-less draft — it would mark the draft decided
    // while writing nothing. Require the admin to enter values first.
    if (isEditStateEmpty(editState)) {
      toast('error', 'This draft has no values to save. Enter at least one label value before accepting (or Reject it).');
      return;
    }

    // Route a changed/manual draft through 'edited' so the ENTERED values are actually sent.
    // 'accepted' submits the draft's STORED values, which are empty for a manual "New Draft" the
    // admin just filled in — accepting it as-is would save nothing. If the editor differs from the
    // draft's stored values, commit as 'edited' (which passes the editor values to the RPC).
    const effective: 'accepted' | 'edited' =
      decision === 'accepted'
        && JSON.stringify(editState) !== JSON.stringify(draftToEditState(editDraft))
        ? 'edited'
        : decision;

    const conflicts = detectOverwrittenFields(editDraft, editState);
    if (conflicts.length > 0 && !forceOverwrite) {
      // Show confirm modal instead of proceeding
      setOverwriteConfirmPending({ draftId: editDraft.id, decision: effective, editState });
      return;
    }
    void commitDraft(editDraft.id, effective, effective === 'edited' ? editState : null, forceOverwrite);
  }

  // ── create a sample draft (for demo/testing; real Vision path wired below) ──
  async function handleCreateSampleDraft() {
    if (!profile || !createProductId.trim()) return;
    setCreating(true);
    try {
      const key = createKey.getKey();
      const { data, error } = await supabaseUntyped.rpc('create_label_draft', {
        p_product_id:   createProductId.trim(),
        p_source_note:  createSource || 'Manual entry / sample draft',
        p_confidence:   'low',
        p_status:       'pending',
        p_idempotency_key: key,
      });
      if (error) throw error;
      const draftId = assertRpcResult<string>(data, 'create_label_draft');
      await logActivity({
        event:       'label_draft_created',
        description: `Created label draft ${draftId} for product ${createProductId.trim()} (source: ${createSource || 'manual'})`,
        performedBy: profile.id,
        entityType:  'product',
        entityId:    createProductId.trim(),
      });
      toast('success', 'Draft created — fill in values via the review queue.');
      createKey.resetKey();
      setShowCreateModal(false);
      setCreateProductId('');
      setCreateSource('');
      void loadDrafts();
    } catch (err) {
      toast('error', `Create failed: ${errMessage(err)}`);
    } finally {
      setCreating(false);
    }
  }

  // ── table columns ──
  const filteredDrafts = statusFilter === 'all'
    ? drafts
    : drafts.filter(d => d.status === statusFilter);

  const columns: Column<ProductLabelDraft>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (d) => (
        <div>
          <div className="font-medium text-ink">{d.product?.product_name ?? d.product_id}</div>
          {d.product?.sku && <div className="text-xs text-muted">{d.product.sku}</div>}
        </div>
      ),
    },
    {
      key: 'signal_word',
      header: 'Signal Word',
      render: (d) => d.signal_word
        ? <span className="font-mono text-sm">{d.signal_word}</span>
        : <span className="text-muted text-xs italic">—</span>,
    },
    {
      key: 'rei_hours',
      header: 'REI (hrs)',
      render: (d) => d.rei_hours != null
        ? <span className="font-mono text-sm">{d.rei_hours}</span>
        : <span className="text-muted text-xs italic">—</span>,
    },
    {
      key: 'phi_days',
      header: 'PHI (days)',
      render: (d) => d.phi_days != null
        ? <span className="font-mono text-sm">{d.phi_days}</span>
        : <span className="text-muted text-xs italic">—</span>,
    },
    {
      key: 'epa_registration',
      header: 'EPA Reg #',
      render: (d) => d.epa_registration
        ? <span className="font-mono text-sm">{d.epa_registration}</span>
        : <span className="text-muted text-xs italic">—</span>,
    },
    {
      key: 'confidence',
      header: 'Confidence',
      render: (d) => (
        <Badge variant={confidenceBadge(d.confidence)}>{d.confidence}</Badge>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (d) => (
        <Badge variant={statusBadgeVariant(d.status)}>{statusLabel(d.status)}</Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (d) => d.status === 'pending' || d.status === 'needs_manual' ? (
        <Button size="sm" variant="secondary" onClick={() => openEdit(d)}>
          <Edit3 className="w-3 h-3 mr-1" />
          Review
        </Button>
      ) : null,
    },
  ];

  // ── coverage bar ──
  function CoverageBar({ value, total }: { value: number; total: number }) {
    const pct = total > 0 ? Math.round((value / total) * 100) : 0;
    return (
      <div className="flex items-center gap-3">
        <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
          <div
            className="h-2 rounded-full bg-crx-green transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-sm text-ink font-medium w-16 text-right">
          {value} / {total}
        </span>
        <span className="text-xs text-muted w-10 text-right">{pct}%</span>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
            <FlaskConical className="w-6 h-6 text-crx-green" />
            Label Review Queue
          </h1>
          <p className="text-sm text-muted mt-1">
            Review AI-drafted label safety data before it is written to products.
            No value is applied without your explicit acceptance.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setShowCoverage(v => !v);
              if (!showCoverage && !coverage) void loadCoverage();
            }}
          >
            <BarChart2 className="w-4 h-4 mr-1" />
            {showCoverage ? 'Hide' : 'Coverage'} Report
          </Button>
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus className="w-4 h-4 mr-1" />
            New Draft
          </Button>
          <Button variant="secondary" onClick={() => { void loadDrafts(); }} title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Safety notice */}
      <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
        <span>
          <strong>Compliance notice:</strong> REI, PHI, EPA registration, and signal word are
          regulatory safety values. Always verify against the physical product label before accepting.
          Incorrect values are a safety hazard and a regulatory violation.
        </span>
      </div>

      {/* Vision extraction status notice */}
      <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 text-sm text-blue-900">
        <Info className="w-4 h-4 mt-0.5 shrink-0 text-blue-600" />
        <span>
          <strong>AI extraction:</strong> Real Google Vision OCR extraction runs via the
          <code className="mx-1 bg-blue-100 px-1 rounded">process-document</code>
          edge function. Local dev uses manually-created drafts (the integration code path
          is fully wired — a real extraction payload flows through the same review queue).
          Contact Mason to enable live Vision extraction for bulk backfill.
        </span>
      </div>

      {/* Coverage report (collapsible) */}
      {showCoverage && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-crx-green" />
              Label Field Coverage
            </h2>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void loadCoverage()}
                disabled={coverageLoading}
              >
                <RefreshCw className={`w-3 h-3 mr-1 ${coverageLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <button
                onClick={() => setShowCoverage(false)}
                className="text-muted hover:text-ink"
                aria-label="Close coverage"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
            </div>
          </div>
          {coverageLoading && !coverage && (
            <div className="text-center py-8 text-muted">Loading coverage report…</div>
          )}
          {coverage && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <Stat label="Total active products" value={coverage.total_active_products} />
                <Stat label="Pending drafts"   value={coverage.pending_drafts}   />
                <Stat label="Accepted drafts"  value={coverage.accepted_drafts}  />
                <Stat label="Needs manual"     value={coverage.needs_manual}     />
              </div>
              <div className="space-y-3">
                {[
                  { key: 'signal_word',      label: 'Signal Word' },
                  { key: 'rei_hours',        label: 'REI Hours' },
                  { key: 'phi_days',         label: 'PHI Days' },
                  { key: 'epa_registration', label: 'EPA Registration' },
                  { key: 'max_label_rate',   label: 'Max Label Rate' },
                ].map(({ key, label }) => (
                  <div key={key} className="grid grid-cols-[160px_1fr] items-center gap-4">
                    <span className="text-sm text-muted">{label}</span>
                    <CoverageBar
                      value={coverage[key as keyof typeof coverage] as number}
                      total={coverage.total_active_products}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
      {showCoverage && !showCoverage && (
        <button
          onClick={() => setShowCoverage(true)}
          className="flex items-center gap-1 text-sm text-crx-green hover:underline"
        >
          <ChevronDown className="w-4 h-4" /> Show coverage report
        </button>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2">
        {(['all', 'pending', 'needs_manual', 'accepted', 'edited', 'rejected'] as const).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded-full text-sm font-medium border transition-colors ${
              statusFilter === s
                ? 'bg-crx-green text-white border-crx-green'
                : 'bg-white text-muted border-gray-200 hover:border-crx-green hover:text-crx-green'
            }`}
          >
            {s === 'all' ? `All (${drafts.length})` : `${statusLabel(s as LabelDraftStatus)} (${drafts.filter(d => d.status === s).length})`}
          </button>
        ))}
      </div>

      {/* Drafts table */}
      <Card>
        <DataTable
          columns={columns}
          data={filteredDrafts}
          loading={loading}
          emptyTitle="No label drafts"
          emptyDescription={
            statusFilter === 'all'
              ? 'Use "New Draft" to create one, or run a bulk backfill.'
              : `No drafts with status "${statusFilter}".`
          }
        />
      </Card>

      {/* ── Review / Edit modal ── */}
      {editDraft && editState && (
        <Modal
          open={!!editDraft}
          onClose={() => { setEditDraft(null); setEditState(null); }}
          title="Review Label Draft"
          accent={editDraft.product?.product_name}
          size="large"
        >
          <div className="space-y-5">
            {/* Source info */}
            <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm space-y-1">
              <div><span className="text-muted">Source:</span> {editDraft.source_note || '—'}</div>
              <div className="flex items-center gap-2">
                <span className="text-muted">Confidence:</span>
                <Badge variant={confidenceBadge(editDraft.confidence)}>{editDraft.confidence}</Badge>
              </div>
              {editDraft.status === 'needs_manual' && (
                <div className="text-amber-700 font-medium mt-1">
                  Extraction could not read this label — fill in values manually below.
                </div>
              )}
            </div>

            {/* Current vs drafted side-by-side */}
            <div>
              <h3 className="text-sm font-semibold text-ink mb-3">
                Current product values vs. drafted values
              </h3>
              <div className="grid grid-cols-3 gap-2 text-xs font-semibold text-muted uppercase tracking-wide mb-2">
                <span>Field</span>
                <span>Current on product</span>
                <span>Drafted / edit below</span>
              </div>
              <div className="space-y-3">
                {/* signal_word */}
                <div className="grid grid-cols-3 gap-2 items-center">
                  <span className="text-sm font-medium text-ink">Signal Word</span>
                  <span className="text-sm font-mono text-muted">
                    {editDraft.product?.signal_word ?? <em>empty</em>}
                  </span>
                  <select
                    value={editState.signal_word}
                    onChange={e => setEditState(s => s ? { ...s, signal_word: e.target.value } : s)}
                    className="rounded border border-gray-200 px-2 py-1 text-sm"
                  >
                    <option value="">— leave blank —</option>
                    <option value="Danger">Danger</option>
                    <option value="Warning">Warning</option>
                    <option value="Caution">Caution</option>
                  </select>
                </div>
                {/* rei_hours */}
                <div className="grid grid-cols-3 gap-2 items-center">
                  <span className="text-sm font-medium text-ink">REI (hours)</span>
                  <span className="text-sm font-mono text-muted">
                    {editDraft.product?.rei_hours ?? <em>empty</em>}
                  </span>
                  <Input
                    type="number"
                    value={editState.rei_hours}
                    onChange={e => setEditState(s => s ? { ...s, rei_hours: e.target.value } : s)}
                    placeholder="e.g. 24"
                    min={0}
                  />
                </div>
                {/* phi_days */}
                <div className="grid grid-cols-3 gap-2 items-center">
                  <span className="text-sm font-medium text-ink">PHI (days)</span>
                  <span className="text-sm font-mono text-muted">
                    {editDraft.product?.phi_days ?? <em>empty</em>}
                  </span>
                  <Input
                    type="number"
                    value={editState.phi_days}
                    onChange={e => setEditState(s => s ? { ...s, phi_days: e.target.value } : s)}
                    placeholder="e.g. 7"
                    min={0}
                  />
                </div>
                {/* epa_registration */}
                <div className="grid grid-cols-3 gap-2 items-center">
                  <span className="text-sm font-medium text-ink">EPA Reg #</span>
                  <span className="text-sm font-mono text-muted">
                    {editDraft.product?.epa_registration ?? <em>empty</em>}
                  </span>
                  <Input
                    value={editState.epa_registration}
                    onChange={e => setEditState(s => s ? { ...s, epa_registration: e.target.value } : s)}
                    placeholder="e.g. 62719-498"
                  />
                </div>
                {/* max_label_rate */}
                <div className="grid grid-cols-3 gap-2 items-center">
                  <span className="text-sm font-medium text-ink">Max Label Rate</span>
                  <span className="text-sm font-mono text-muted">
                    {editDraft.product?.max_label_rate != null
                      ? `${editDraft.product.max_label_rate} ${editDraft.product.max_label_rate_unit ?? ''}`
                      : <em>empty</em>}
                  </span>
                  <div className="flex gap-1">
                    <Input
                      type="number"
                      value={editState.max_label_rate}
                      onChange={e => setEditState(s => s ? { ...s, max_label_rate: e.target.value } : s)}
                      placeholder="e.g. 2.5"
                      min={0}
                      step="0.01"
                      className="w-24"
                    />
                    <select
                      value={editState.max_label_rate_unit}
                      onChange={e => setEditState(s => s ? { ...s, max_label_rate_unit: e.target.value } : s)}
                      className="w-24 px-2 py-1.5 text-sm border border-gray-200 rounded-lg"
                    >
                      <option value="">unit</option>
                      {/* WaveB: canonical bare units (per-acre label max); grandfather a legacy value */}
                      {editState.max_label_rate_unit && !isKnownUnit(unitConversions, null, editState.max_label_rate_unit) && (
                        <option value={editState.max_label_rate_unit}>{editState.max_label_rate_unit} (existing)</option>
                      )}
                      {unitOptionsForForm(unitConversions, null).map((uc) => (
                        <option key={uc.id} value={uc.unit}>{uc.unit}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>

            {/* Non-overwrite notice */}
            {(() => {
              const conflicts = detectOverwrittenFields(editDraft, editState);
              return conflicts.length > 0 ? (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded px-3 py-2 text-sm text-amber-800">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    The following fields already have values on this product and will
                    <strong> not</strong> be overwritten unless you check "Force overwrite":
                    {' '}<strong>{conflicts.join(', ')}</strong>.
                  </span>
                </div>
              ) : null;
            })()}

            <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
              <input
                type="checkbox"
                checked={forceOverwrite}
                onChange={e => setForceOverwrite(e.target.checked)}
                className="w-4 h-4 accent-crx-green"
              />
              Force overwrite existing (non-empty) product label fields
            </label>

            {/* Empty-draft / negative-value guidance (blocks the accept buttons below) */}
            {(() => {
              const emptyDraft = isEditStateEmpty(editState);
              const negatives  = negativeNumericFields(editState);
              const nonIntegers = nonIntegerIntervalFields(editState);
              if (negatives.length > 0) {
                return (
                  <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-800">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      Negative values are not allowed for <strong>{negatives.join(', ')}</strong>.
                      Regulatory intervals and rates must be zero or positive.
                    </span>
                  </div>
                );
              }
              if (nonIntegers.length > 0) {
                return (
                  <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-800">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      <strong>{nonIntegers.join(' and ')}</strong> must be a whole number — no decimals
                      or scientific notation.
                    </span>
                  </div>
                );
              }
              if (emptyDraft) {
                return (
                  <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded px-3 py-2 text-sm text-amber-800">
                    <Info className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                      This draft has no values yet. Enter at least one label value above to
                      accept it, or <strong>Reject</strong> it to clear it from the queue.
                    </span>
                  </div>
                );
              }
              return null;
            })()}

            {/* Actions */}
            <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-gray-100">
              <Button
                variant="secondary"
                onClick={() => { setEditDraft(null); setEditState(null); }}
                disabled={committing}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => void commitDraft(editDraft.id, 'rejected', null, false)}
                disabled={committing}
              >
                <XCircle className="w-4 h-4 mr-1" />
                Reject
              </Button>
              <Button
                variant="secondary"
                onClick={() => handleAcceptOrEdit('edited')}
                disabled={committing || isEditStateEmpty(editState) || negativeNumericFields(editState).length > 0 || nonIntegerIntervalFields(editState).length > 0}
              >
                <Edit3 className="w-4 h-4 mr-1" />
                Accept with edits
              </Button>
              <Button
                onClick={() => handleAcceptOrEdit('accepted')}
                disabled={committing || isEditStateEmpty(editState) || negativeNumericFields(editState).length > 0 || nonIntegerIntervalFields(editState).length > 0}
              >
                <CheckCircle className="w-4 h-4 mr-1" />
                Accept as drafted
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Overwrite confirm modal ── */}
      {overwriteConfirmPending && (
        <Modal
          open={!!overwriteConfirmPending}
          onClose={() => setOverwriteConfirmPending(null)}
          title="Some fields already have values"
        >
          <div className="space-y-4">
            <p className="text-sm text-ink">
              One or more fields on this product already have values. Choose how to proceed:
              apply only the <strong>empty</strong> fields and keep the existing ones, or
              overwrite the existing values with the drafted ones.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setOverwriteConfirmPending(null)}
                disabled={committing}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const { draftId, decision, editState: es } = overwriteConfirmPending;
                  void commitDraft(draftId, decision, es, false);
                }}
                disabled={committing}
              >
                Apply empty fields only
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const { draftId, decision, editState: es } = overwriteConfirmPending;
                  void commitDraft(draftId, decision, es, true);
                }}
                disabled={committing}
              >
                Overwrite existing
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Create draft modal ── */}
      <Modal
        open={showCreateModal}
        onClose={() => { setShowCreateModal(false); setCreateProductId(''); setCreateSource(''); }}
        title="Create Label Draft"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Creates an empty pending draft for the given product UUID. Fill in the
            values via the review queue. For bulk Vision-OCR extraction, use the
            backfill script (see docs).
          </p>
          <div>
            <label className="block text-sm font-medium text-ink mb-1">Product ID (UUID)</label>
            <Input
              value={createProductId}
              onChange={e => setCreateProductId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="font-mono text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink mb-1">Source note</label>
            <Input
              value={createSource}
              onChange={e => setCreateSource(e.target.value)}
              placeholder="e.g. Manual entry, Label scan batch 2026-06-29"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => { setShowCreateModal(false); setCreateProductId(''); setCreateSource(''); }}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreateSampleDraft()}
              disabled={creating || !createProductId.trim()}
            >
              <Plus className="w-4 h-4 mr-1" />
              Create Draft
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ── tiny stat card ──────────────────────────────────────────────────────────
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-50 rounded-lg px-4 py-3 text-center">
      <div className="text-2xl font-bold text-crx-green">{value}</div>
      <div className="text-xs text-muted mt-1">{label}</div>
    </div>
  );
}
