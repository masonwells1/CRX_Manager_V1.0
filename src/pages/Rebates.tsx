/**
 * Rebates.tsx — Manufacturer Rebate Program & Claims Management
 *
 * Track rebate programs from manufacturers, create claims against orders,
 * and reconcile payments received.
 */
import { useEffect, useRef, useState , useCallback } from 'react';
import { Plus, DollarSign, TrendingUp, FileText, Trash2, Pencil } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import ConfirmModal from '../components/ui/ConfirmModal';
import DataTable, { type Column } from '../components/ui/DataTable';
import PageHeader from '../components/ui/PageHeader';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { sanitizeError, supabase, checkMutationResult, assertRpcResult, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { generateIdempotencyKey } from '../lib/idempotency';
import { parseLocalDate } from '../lib/dateUtils';
import { formatCents as fmtCents, formatUSD as fmt } from '../lib/money';
import { MONEY_PRECISION_MESSAGE, parseDollarsToCents } from '../lib/parseCents';
import type { RebateProgram, RebateClaim, RebateClaimStatus } from '../types';
import { ProductOptionDetails, productOptionLabel, type ProductOptionPresentationModel } from '../components/products/ProductOptionPresentation';

type RebatePickerProduct = ProductOptionPresentationModel & {
  vendor: string | null;
  manufacturer: string | null;
};

type TabKey = 'programs' | 'claims';

interface ProgramRow extends RebateProgram {
  [k: string]: unknown;
  product_name?: string;
}

interface ClaimRow extends RebateClaim {
  [k: string]: unknown;
  program_name?: string;
  manufacturer?: string;
  farm_name?: string;
  product_name?: string;
  order_number?: string;
}

const REBATE_TYPE_LABELS: Record<string, string> = {
  per_unit: 'Per Unit',
  percentage: 'Percentage',
  volume_tier: 'Volume Tier',
  flat: 'Flat',
};

export default function Rebates() {
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const isAdmin = role === 'admin';
  // Per-claim idempotency keys: prevents double-submit on retry. New key per
  // distinct user intent (each claim creation, each transition).
  const createClaimKey = useIdempotencyKey('create_rebate_claim', profile?.id || 'anon');
  // Transition keys scoped per (claimId, newStatus) so two concurrent admin
  // clicks on different claims don't collide on a page-scoped key (codex P2,
  // 2026-05-12) — without scoping, the second RPC's idempotency check would
  // return the first claim's cached payload and silently no-op the second
  // transition. Same intent retries still get the same key (retry safety).
  const transitionKeysRef = useRef<Map<string, string>>(new Map());
  const [tab, setTab] = useState<TabKey>('programs');
  const [loading, setLoading] = useState(true);

  // Programs
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [programFilter, setProgramFilter] = useState<'all' | 'active' | 'expired' | 'closed'>('all');

  // Claims
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [claimFilter, setClaimFilter] = useState<'all' | 'pending' | 'submitted' | 'approved' | 'paid'>('all');

  // Shared lookups
  const [products, setProducts] = useState<RebatePickerProduct[]>([]);
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [orders, setOrders] = useState<{ id: string; order_number: string; customer_id: string }[]>([]);

  // Program modal
  const [pModalOpen, setPModalOpen] = useState(false);
  const [pEditId, setPEditId] = useState<string | null>(null);
  const [pForm, setPForm] = useState({
    program_name: '',
    manufacturer: '',
    season: new Date().getFullYear(),
    product_id: '',
    rebate_type: 'per_unit' as string,
    rebate_amount: '',
    rebate_pct: '',
    min_volume: '',
    max_volume: '',
    start_date: '',
    end_date: '',
    notes: '',
  });

  // Claim modal
  const [cModalOpen, setCModalOpen] = useState(false);
  const [cForm, setCForm] = useState({
    program_id: '',
    order_id: '',
    customer_id: '',
    product_id: '',
    quantity: '',
    claim_amount_cents: '',
    notes: '',
  });

  const [saving, setSaving] = useState(false);

  // Confirm modal states
  const [deleteProgramConfirmOpen, setDeleteProgramConfirmOpen] = useState(false);
  const [deleteProgramTarget, setDeleteProgramTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteClaimConfirmOpen, setDeleteClaimConfirmOpen] = useState(false);
  const [deleteClaimTarget, setDeleteClaimTarget] = useState<{ id: string; number: string } | null>(null);

  useEffect(() => {
    fetchLookups();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchLookups = async () => {
    const [prodRes, custRes, ordRes] = await Promise.all([
      supabase.from('products').select('id, product_name, sku, vendor, manufacturer, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, product_family:product_families(name)').eq('is_active', true).order('product_name'),
      supabase.from('customers').select('id, farm_name').order('farm_name'),
      supabase.from('orders').select('id, order_number, customer_id').is('deleted_at', null).order('order_date', { ascending: false }).limit(200),
    ]);
    if (prodRes.error) {
      toast('error', 'Failed to load Products. Retry before saving a rebate.');
      Sentry.captureException(prodRes.error, { tags: { source: 'fetch', action: 'load_rebate_products' } });
    }
    if (custRes.error) toast('error', 'Failed to load customers');
    if (ordRes.error) toast('error', 'Failed to load orders');
    setProducts((prodRes.data || []) as unknown as RebatePickerProduct[]);
    setCustomers(custRes.data || []);
    setOrders(ordRes.data || []);
  };

  const fetchPrograms = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('rebate_programs')
      .select('*, product:products(product_name)')
      .order('start_date', { ascending: false });

    if (error) {
      toast('error', 'Failed to load rebate programs');
      Sentry.captureException(error);
    }
    const mapped = ((data || []) as Array<Record<string, unknown> & { product?: { product_name?: string } }>).map((p) => ({
      ...p,
      product_name: p.product?.product_name || null,
    })) as unknown as ProgramRow[];
    setPrograms(mapped);
    setLoading(false);
  }, [toast]);

  const fetchClaims = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('rebate_claims')
      .select('*, program:rebate_programs(program_name, manufacturer), customer:customers(farm_name), product:products(product_name), order:orders(order_number)')
      .order('created_at', { ascending: false });

    if (error) {
      toast('error', 'Failed to load rebate claims');
      Sentry.captureException(error);
    }
    const mapped = ((data || []) as Array<Record<string, unknown> & { program?: { program_name?: string; manufacturer?: string }; customer?: { farm_name?: string }; product?: { product_name?: string }; order?: { order_number?: string } }>).map((c) => ({
      ...c,
      program_name: c.program?.program_name || '',
      manufacturer: c.program?.manufacturer || '',
      farm_name: c.customer?.farm_name || '',
      product_name: c.product?.product_name || '',
      order_number: c.order?.order_number || '',
    })) as unknown as ClaimRow[];
    setClaims(mapped);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (tab === 'programs') fetchPrograms();
    else fetchClaims();
  }, [tab, fetchPrograms, fetchClaims]);

  // ===== Program CRUD =====
  const openAddProgram = () => {
    setPEditId(null);
    setPForm({
      program_name: '',
      manufacturer: '',
      season: new Date().getFullYear(),
      product_id: '',
      rebate_type: 'per_unit',
      rebate_amount: '',
      rebate_pct: '',
      min_volume: '',
      max_volume: '',
      start_date: '',
      end_date: '',
      notes: '',
    });
    setPModalOpen(true);
  };

  const openEditProgram = (p: ProgramRow) => {
    setPEditId(p.id);
    setPForm({
      program_name: p.program_name,
      manufacturer: p.manufacturer,
      season: p.season,
      product_id: p.product_id || '',
      rebate_type: p.rebate_type,
      rebate_amount: String(p.rebate_amount),
      rebate_pct: p.rebate_pct != null ? String(p.rebate_pct) : '',
      min_volume: p.min_volume != null ? String(p.min_volume) : '',
      max_volume: p.max_volume != null ? String(p.max_volume) : '',
      start_date: p.start_date,
      end_date: p.end_date,
      notes: p.notes || '',
    });
    setPModalOpen(true);
  };

  const handleSaveProgram = async () => {
    if (!pForm.program_name || !pForm.manufacturer || !pForm.start_date || !pForm.end_date) {
      toast('error', 'Fill in required fields');
      return;
    }
    const payload = {
      program_name: pForm.program_name,
      manufacturer: pForm.manufacturer,
      season: pForm.season,
      product_id: pForm.product_id || null,
      rebate_type: pForm.rebate_type,
      rebate_amount: Number(pForm.rebate_amount) || 0,
      rebate_pct: pForm.rebate_pct ? Number(pForm.rebate_pct) : null,
      min_volume: pForm.min_volume ? Number(pForm.min_volume) : null,
      max_volume: pForm.max_volume ? Number(pForm.max_volume) : null,
      start_date: pForm.start_date,
      end_date: pForm.end_date,
      notes: pForm.notes || null,
    };

    await runCriticalAction({
      action: async () => {
        if (pEditId) {
          const result = await supabase.from('rebate_programs').update(payload).eq('id', pEditId).select();
          checkMutationResult(result, 'Update rebate program');
        } else {
          const result = await supabase.from('rebate_programs').insert(payload).select();
          checkMutationResult(result, 'Create rebate program');
          if (profile) logActivity({ event: 'rebate_program_created', description: `Rebate program "${pForm.program_name}" created`, performedBy: profile.id });
        }
      },
      toast,
      setLoading: setSaving,
      successMessage: pEditId ? 'Rebate program updated' : 'Rebate program created',
      sentryTag: pEditId ? 'update_rebate_program' : 'create_rebate_program',
      onSuccess: () => {
        setPModalOpen(false);
        fetchPrograms();
      },
    });
  };

  // ===== Claim CRUD =====
  const openAddClaim = () => {
    // Codex P2 fix (PR #59, 2026-05-16): reset the createClaimKey on every
    // modal open. Without this, if claim A succeeds but the response is
    // lost, then the admin reopens/edits the form and submits claim B,
    // both calls share the same page-scoped key and the server replays
    // A's cached result without inserting claim B.
    createClaimKey.resetKey();
    setCForm({
      program_id: '',
      order_id: '',
      customer_id: '',
      product_id: '',
      quantity: '',
      claim_amount_cents: '',
      notes: '',
    });
    setCModalOpen(true);
  };

  const handleSaveClaim = async () => {
    if (!cForm.program_id || !cForm.quantity || !cForm.claim_amount_cents) {
      toast('error', 'Fill in required fields');
      return;
    }
    const claimAmountCents = parseDollarsToCents(String(cForm.claim_amount_cents));
    if (claimAmountCents === null) { toast('error', `Claim amount: ${MONEY_PRECISION_MESSAGE}`); return; }

    await runCriticalAction<{ claim_id: string; claim_number: string }>({
      action: async () => {
        // Atomic create via RPC — generates claim_number under counter row-lock
        // (audit #33: replaces the racy `count(*) + 1` pattern that could produce
        // duplicate claim numbers under concurrent inserts).
        const { data, error } = await supabase.rpc('create_rebate_claim', {
          p_program_id: cForm.program_id,
          p_quantity: Number(cForm.quantity),
          p_claim_amount_cents: claimAmountCents,
          p_order_id: cForm.order_id || undefined,
          p_customer_id: cForm.customer_id || undefined,
          p_product_id: cForm.product_id || undefined,
          p_notes: cForm.notes || undefined,
          p_idempotency_key: createClaimKey.getKey(),
        });
        if (error) throw error;
        const result = assertRpcResult<{ claim_id: string; claim_number: string }>(data, 'create_rebate_claim');
        if (profile) logActivity({ event: 'rebate_claim_created', description: `Rebate claim ${result.claim_number} created`, performedBy: profile.id });
        return result;
      },
      toast,
      setLoading: setSaving,
      sentryTag: 'create_rebate_claim',
      onSuccess: (result) => {
        createClaimKey.resetKey();
        setCModalOpen(false);
        fetchClaims();
        toast('success', `Claim ${result?.claim_number ?? ''} created`);
      },
    });
  };

  const updateClaimStatus = async (claimId: string, newStatus: RebateClaimStatus) => {
    const scope = `${claimId}:${newStatus}`;
    let idempotencyKey = transitionKeysRef.current.get(scope);
    if (!idempotencyKey) {
      idempotencyKey = generateIdempotencyKey('transition_rebate_claim', profile?.id || 'anon');
      transitionKeysRef.current.set(scope, idempotencyKey);
    }
    await runCriticalAction({
      action: async () => {
        // Atomic state-machine transition via RPC — server validates the
        // transition under SELECT FOR UPDATE on the claim row (audit #33:
        // prevents lost-update from concurrent admin clicks).
        const { data, error } = await supabase.rpc('transition_rebate_claim', {
          p_claim_id: claimId,
          p_new_status: newStatus,
          p_idempotency_key: idempotencyKey,
        });
        if (error) {
          if (hasRpcCode(error, RpcErrorCodes.INVALID_TRANSITION)) {
            throw new Error('This claim is no longer in the expected state — refresh and try again.');
          }
          throw error;
        }
        assertRpcResult<{ old_status: string; new_status: string }>(data, 'transition_rebate_claim');
        if (profile) logActivity({ event: 'rebate_claim_updated', description: `Rebate claim status → ${newStatus}`, performedBy: profile.id });
      },
      toast,
      successMessage: `Claim marked as ${newStatus}`,
      sentryTag: 'update_rebate_claim_status',
      onSuccess: () => {
        transitionKeysRef.current.delete(scope);
        fetchClaims();
      },
    });
  };

  // ===== Delete Program =====
  const handleDeleteProgram = (programId: string, programName: string) => {
    setDeleteProgramTarget({ id: programId, name: programName });
    setDeleteProgramConfirmOpen(true);
  };

  const doDeleteProgram = async () => {
    if (!deleteProgramTarget) return;
    const { id: programId, name: programName } = deleteProgramTarget;
    setDeleteProgramConfirmOpen(false);
    setDeleteProgramTarget(null);
    try {
      // Delete claims first (FK constraint) — may be zero claims, so only check for error
      const claimsResult = await supabase.from('rebate_claims').delete().eq('program_id', programId).select();
      if (claimsResult.error) throw claimsResult.error;
      // Zero rows valid (program may have no claims) — only check for error, not empty result
      const result = await supabase.from('rebate_programs').delete().eq('id', programId).select();
      checkMutationResult(result, 'Delete rebate program');
      toast('success', `Rebate program "${programName}" deleted`);
      if (profile) logActivity({ event: 'rebate_program_deleted', description: `Rebate program "${programName}" deleted`, performedBy: profile.id });
      fetchPrograms();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'delete_rebate_program' } });
      toast('error', sanitizeError(err));
    }
  };

  // ===== Delete Claim =====
  const handleDeleteClaim = (claimId: string, claimNumber: string) => {
    setDeleteClaimTarget({ id: claimId, number: claimNumber });
    setDeleteClaimConfirmOpen(true);
  };

  const doDeleteClaim = async () => {
    if (!deleteClaimTarget) return;
    const { id: claimId, number: claimNumber } = deleteClaimTarget;
    setDeleteClaimConfirmOpen(false);
    setDeleteClaimTarget(null);
    try {
      const result = await supabase.from('rebate_claims').delete().eq('id', claimId).select();
      checkMutationResult(result, 'Delete rebate claim');
      toast('success', `Claim ${claimNumber} deleted`);
      if (profile) logActivity({ event: 'rebate_claim_deleted', description: `Rebate claim ${claimNumber} deleted`, performedBy: profile.id });
      fetchClaims();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'delete_rebate_claim' } });
      toast('error', sanitizeError(err));
    }
  };

  // Stats
  const pendingClaims = claims.filter((c) => c.status === 'pending' || c.status === 'submitted');
  const totalPending = pendingClaims.reduce((s, c) => s + c.claim_amount_cents, 0);
  const totalPaid = claims
    .filter((c) => c.status === 'paid')
    .reduce((s, c) => s + (c.paid_amount_cents || c.claim_amount_cents), 0);

  const filteredPrograms = programs.filter((p) => programFilter === 'all' || p.status === programFilter);
  const filteredClaims = claims.filter((c) => claimFilter === 'all' || c.status === claimFilter);

  const programColumns: Column<ProgramRow>[] = [
    {
      key: 'program_name',
      header: 'Program',
      sortable: true,
      render: (r) => (
        <button onClick={() => openEditProgram(r)} className="font-medium text-crx-green hover:underline text-left">
          {r.program_name}
        </button>
      ),
    },
    { key: 'manufacturer', header: 'Manufacturer', sortable: true },
    { key: 'product_name', header: 'Product', render: (r) => r.product_name || 'All products' },
    {
      key: 'rebate_type',
      header: 'Type',
      render: (r) => <Badge variant="default">{REBATE_TYPE_LABELS[r.rebate_type] || r.rebate_type}</Badge>,
    },
    {
      key: 'rebate_amount',
      header: 'Amount',
      render: (r) =>
        r.rebate_type === 'percentage'
          ? `${r.rebate_pct}%`
          : fmt(r.rebate_amount),
    },
    { key: 'season', header: 'Season', sortable: true },
    {
      key: 'start_date',
      header: 'Period',
      render: (r) =>
        `${parseLocalDate(r.start_date).toLocaleDateString()} – ${parseLocalDate(r.end_date).toLocaleDateString()}`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge variant={r.status === 'active' ? 'success' : r.status === 'expired' ? 'warning' : 'default'}>
          {r.status}
        </Badge>
      ),
    },
    ...(isAdmin
      ? [
          {
            key: 'id' as string,
            header: 'Actions',
            render: (r: ProgramRow) => (
              <div className="flex items-center gap-1">
                <button
                  onClick={(e) => { e.stopPropagation(); openEditProgram(r); }}
                  className="p-1.5 text-gray-400 hover:text-crx-green rounded-lg hover:bg-gray-100 transition-colors"
                  title="Edit program"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteProgram(r.id, r.program_name); }}
                  className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors"
                  title="Delete program"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ),
          },
        ]
      : []),
  ];

  const claimColumns: Column<ClaimRow>[] = [
    { key: 'claim_number', header: 'Claim #', sortable: true, render: (r) => <span className="font-medium">{r.claim_number}</span> },
    { key: 'program_name', header: 'Program', sortable: true },
    { key: 'manufacturer', header: 'Manufacturer' },
    { key: 'farm_name', header: 'Customer', render: (r) => r.farm_name || '-' },
    { key: 'order_number', header: 'Order', render: (r) => r.order_number || '-' },
    { key: 'quantity', header: 'Qty', render: (r) => r.quantity.toLocaleString() },
    { key: 'claim_amount_cents', header: 'Claim Amount', sortable: true, render: (r) => <span className="font-mono">{fmtCents(r.claim_amount_cents)}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <Badge
          variant={
            r.status === 'paid'
              ? 'success'
              : r.status === 'approved'
                ? 'info'
                : r.status === 'rejected'
                  ? 'error'
                  : 'warning'
          }
        >
          {r.status}
        </Badge>
      ),
    },
    {
      key: 'id',
      header: 'Actions',
      render: (r) => {
        if (!isAdmin) return null;
        return (
          <div className="flex items-center gap-1">
            {r.status === 'pending' && (
              <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); updateClaimStatus(r.id, 'submitted'); }}>
                Submit
              </Button>
            )}
            {r.status === 'submitted' && (
              <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); updateClaimStatus(r.id, 'approved'); }}>
                Approve
              </Button>
            )}
            {r.status === 'approved' && (
              <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); updateClaimStatus(r.id, 'paid'); }}>
                Mark Paid
              </Button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); handleDeleteClaim(r.id, r.claim_number); }}
              className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors"
              title="Delete claim"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Manufacturer"
        accent="Rebates"
        actions={(
          <div className="flex gap-2">
          {tab === 'programs' && isAdmin && (
            <Button icon={<Plus className="w-4 h-4" />} onClick={openAddProgram}>
              Add Program
            </Button>
          )}
          {tab === 'claims' && (
            <Button icon={<Plus className="w-4 h-4" />} onClick={openAddClaim}>
              New Claim
            </Button>
          )}
          </div>
        )}
      />

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <FileText className="w-5 h-5 text-blue-600" />
            </div>
            <span className="text-sm text-secondary">Active Programs</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-nav-dark">
            {programs.filter((p) => p.status === 'active').length}
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <DollarSign className="w-5 h-5 text-amber-600" />
            </div>
            <span className="text-sm text-secondary">Pending Claims</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-amber-600">{fmtCents(totalPending)}</p>
          <p className="text-xs text-secondary">{pendingClaims.length} claims</p>
        </Card>
        <Card>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-crx-green" />
            </div>
            <span className="text-sm text-secondary">Rebates Received</span>
          </div>
          <p className="text-2xl font-semibold font-heading text-crx-green">{fmtCents(totalPaid)}</p>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {([
          { key: 'programs' as TabKey, label: 'Programs' },
          { key: 'claims' as TabKey, label: 'Claims' },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              tab === t.key ? 'bg-white text-nav-dark shadow-sm' : 'text-secondary hover:text-nav-dark'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      {tab === 'programs' && (
        <div className="flex gap-2">
          {(['all', 'active', 'expired', 'closed'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setProgramFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                programFilter === f
                  ? 'bg-crx-green text-white border-crx-green'
                  : 'border-gray-200 text-secondary hover:border-crx-green hover:text-crx-green'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      )}

      {tab === 'claims' && (
        <div className="flex gap-2">
          {(['all', 'pending', 'submitted', 'approved', 'paid'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setClaimFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                claimFilter === f
                  ? 'bg-crx-green text-white border-crx-green'
                  : 'border-gray-200 text-secondary hover:border-crx-green hover:text-crx-green'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* Tables */}
      <Card padding={false}>
        <div className="p-5">
          {tab === 'programs' && (
            <DataTable<ProgramRow>
              columns={programColumns}
              data={filteredPrograms}
              loading={loading}
              searchable
              searchPlaceholder="Search programs..."
              searchKeys={['program_name', 'manufacturer']}
              emptyTitle="No rebate programs"
              emptyDescription="Create a rebate program to start tracking manufacturer rebates."
            />
          )}
          {tab === 'claims' && (
            <DataTable<ClaimRow>
              columns={claimColumns}
              data={filteredClaims}
              loading={loading}
              searchable
              searchPlaceholder="Search claims..."
              searchKeys={['claim_number', 'program_name', 'manufacturer', 'farm_name']}
              emptyTitle="No rebate claims"
              emptyDescription="Create a claim to submit for manufacturer rebate."
            />
          )}
        </div>
      </Card>

      {/* ========== PROGRAM MODAL ========== */}
      <Modal open={pModalOpen} onClose={() => setPModalOpen(false)} title={pEditId ? 'Edit Rebate Program' : 'New Rebate Program'} size="large">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Program Name *"
              value={pForm.program_name}
              onChange={(e) => setPForm({ ...pForm, program_name: e.target.value })}
            />
            <Input
              label="Manufacturer *"
              value={pForm.manufacturer}
              onChange={(e) => setPForm({ ...pForm, manufacturer: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-sm font-medium text-nav-dark">Product (optional)</label>
              <select
                value={pForm.product_id}
                onChange={(e) => setPForm({ ...pForm, product_id: e.target.value })}
                className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All products from manufacturer</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {productOptionLabel(p)}
                  </option>
                ))}
              </select>
              {products.find((product) => product.id === pForm.product_id) && (
                <ProductOptionDetails product={products.find((product) => product.id === pForm.product_id)!} />
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-nav-dark">Rebate Type</label>
              <select
                value={pForm.rebate_type}
                onChange={(e) => setPForm({ ...pForm, rebate_type: e.target.value })}
                className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="per_unit">Per Unit ($)</option>
                <option value="percentage">Percentage (%)</option>
                <option value="volume_tier">Volume Tier</option>
                <option value="flat">Flat Amount</option>
              </select>
            </div>
            <Input
              label="Season"
              type="number"
              value={String(pForm.season)}
              onChange={(e) => setPForm({ ...pForm, season: Number(e.target.value) })}
            />
          </div>

          <div className="grid grid-cols-4 gap-4">
            <Input
              label="Rebate Amount ($)"
              type="number"
              value={pForm.rebate_amount}
              onChange={(e) => setPForm({ ...pForm, rebate_amount: e.target.value })}
            />
            <Input
              label="Rebate %"
              type="number"
              value={pForm.rebate_pct}
              onChange={(e) => setPForm({ ...pForm, rebate_pct: e.target.value })}
            />
            <Input
              label="Min Volume"
              type="number"
              value={pForm.min_volume}
              onChange={(e) => setPForm({ ...pForm, min_volume: e.target.value })}
            />
            <Input
              label="Max Volume"
              type="number"
              value={pForm.max_volume}
              onChange={(e) => setPForm({ ...pForm, max_volume: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Start Date *"
              type="date"
              value={pForm.start_date}
              onChange={(e) => setPForm({ ...pForm, start_date: e.target.value })}
            />
            <Input
              label="End Date *"
              type="date"
              value={pForm.end_date}
              onChange={(e) => setPForm({ ...pForm, end_date: e.target.value })}
            />
          </div>

          <Input
            label="Notes"
            value={pForm.notes}
            onChange={(e) => setPForm({ ...pForm, notes: e.target.value })}
          />

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setPModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveProgram} loading={saving}>
              {pEditId ? 'Save Changes' : 'Create Program'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Confirm Modals */}
      <ConfirmModal
        open={deleteProgramConfirmOpen}
        onClose={() => { setDeleteProgramConfirmOpen(false); setDeleteProgramTarget(null); }}
        onConfirm={doDeleteProgram}
        title="Delete Rebate Program"
        message={`Delete rebate program "${deleteProgramTarget?.name}"? This will also delete all claims under this program.`}
        confirmLabel="Delete Program"
        variant="danger"
      />
      <ConfirmModal
        open={deleteClaimConfirmOpen}
        onClose={() => { setDeleteClaimConfirmOpen(false); setDeleteClaimTarget(null); }}
        onConfirm={doDeleteClaim}
        title="Delete Rebate Claim"
        message={`Delete rebate claim ${deleteClaimTarget?.number}?`}
        confirmLabel="Delete Claim"
        variant="danger"
      />

      {/* ========== CLAIM MODAL ========== */}
      <Modal open={cModalOpen} onClose={() => setCModalOpen(false)} title="New Rebate Claim">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-nav-dark">Rebate Program *</label>
            <select
              value={cForm.program_id}
              onChange={(e) => setCForm({ ...cForm, program_id: e.target.value })}
              className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Select program...</option>
              {programs
                .filter((p) => p.status === 'active')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.program_name} ({p.manufacturer})
                  </option>
                ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-nav-dark">Customer</label>
              <select
                value={cForm.customer_id}
                onChange={(e) => setCForm({ ...cForm, customer_id: e.target.value })}
                className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Optional...</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.farm_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-nav-dark">Order</label>
              <select
                value={cForm.order_id}
                onChange={(e) => setCForm({ ...cForm, order_id: e.target.value })}
                className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">Optional...</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.order_number}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-nav-dark">Product</label>
            <select
              value={cForm.product_id}
              onChange={(e) => setCForm({ ...cForm, product_id: e.target.value })}
              className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Optional...</option>
              {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {productOptionLabel(p)}
                  </option>
                ))}
              </select>
              {products.find((product) => product.id === cForm.product_id) && (
                <ProductOptionDetails product={products.find((product) => product.id === cForm.product_id)!} />
              )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Quantity *"
              type="number"
              value={cForm.quantity}
              onChange={(e) => setCForm({ ...cForm, quantity: e.target.value })}
            />
            <Input
              label="Claim Amount ($) *"
              type="number"
              value={cForm.claim_amount_cents}
              onChange={(e) => setCForm({ ...cForm, claim_amount_cents: e.target.value })}
            />
          </div>

          <Input
            label="Notes"
            value={cForm.notes}
            onChange={(e) => setCForm({ ...cForm, notes: e.target.value })}
          />

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setCModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveClaim} loading={saving}>
              Create Claim
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
