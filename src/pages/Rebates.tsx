/**
 * Rebates.tsx — Manufacturer Rebate Program & Claims Management
 *
 * Track rebate programs from manufacturers, create claims against orders,
 * and reconcile payments received.
 */
import { useEffect, useState , useCallback } from 'react';
import { Plus, DollarSign, TrendingUp, FileText } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { logActivity } from '../lib/activityLogger';
import { localToday, parseLocalDate } from '../lib/dateUtils';
import type { RebateProgram, RebateClaim } from '../types';

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
  const [tab, setTab] = useState<TabKey>('programs');
  const [loading, setLoading] = useState(true);

  // Programs
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [programFilter, setProgramFilter] = useState<'all' | 'active' | 'expired' | 'closed'>('all');

  // Claims
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [claimFilter, setClaimFilter] = useState<'all' | 'pending' | 'submitted' | 'approved' | 'paid'>('all');

  // Shared lookups
  const [products, setProducts] = useState<{ id: string; product_name: string; vendor: string | null; manufacturer: string | null }[]>([]);
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

  useEffect(() => {
    fetchLookups();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchLookups = async () => {
    const [prodRes, custRes, ordRes] = await Promise.all([
      supabase.from('products').select('id, product_name, vendor, manufacturer').eq('is_active', true).order('product_name'),
      supabase.from('customers').select('id, farm_name').order('farm_name'),
      supabase.from('orders').select('id, order_number, customer_id').order('order_date', { ascending: false }).limit(200),
    ]);
    if (prodRes.error) toast('error', 'Failed to load products');
    if (custRes.error) toast('error', 'Failed to load customers');
    if (ordRes.error) toast('error', 'Failed to load orders');
    setProducts(prodRes.data || []);
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
      console.error(error.message);
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
      console.error(error.message);
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

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const fmtCents = (cents: number) => fmt(cents / 100);

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
    setSaving(true);
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

    try {
      if (pEditId) {
        const result = await supabase.from('rebate_programs').update(payload).eq('id', pEditId).select();
        checkMutationResult(result, 'Update rebate program');
        toast('success', 'Rebate program updated');
      } else {
        const result = await supabase.from('rebate_programs').insert(payload).select();
        checkMutationResult(result, 'Create rebate program');
        toast('success', 'Rebate program created');
        if (profile) logActivity('rebate_program_created', `Rebate program "${pForm.program_name}" created`, profile.id);
      }
      setPModalOpen(false);
      fetchPrograms();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to save program');
    }
    setSaving(false);
  };

  // ===== Claim CRUD =====
  const openAddClaim = () => {
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
    setSaving(true);

    // Generate claim number
    const { count, error: countError } = await supabase.from('rebate_claims').select('id', { count: 'exact', head: true });
    if (countError) {
      toast('error', 'Failed to generate claim number');
      setSaving(false);
      return;
    }
    const claimNum = `RC-${new Date().getFullYear()}-${String((count || 0) + 1).padStart(4, '0')}`;

    const payload = {
      program_id: cForm.program_id,
      order_id: cForm.order_id || null,
      customer_id: cForm.customer_id || null,
      product_id: cForm.product_id || null,
      claim_number: claimNum,
      quantity: Number(cForm.quantity),
      claim_amount_cents: Math.round(Number(cForm.claim_amount_cents) * 100),
      notes: cForm.notes || null,
    };

    try {
      const result = await supabase.from('rebate_claims').insert(payload).select();
      checkMutationResult(result, 'Create rebate claim');
      toast('success', `Claim ${claimNum} created`);
      if (profile) logActivity('rebate_claim_created', `Rebate claim ${claimNum} created`, profile.id);
      setCModalOpen(false);
      fetchClaims();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to create claim');
    }
    setSaving(false);
  };

  const updateClaimStatus = async (claimId: string, newStatus: string) => {
    const updatePayload: Record<string, unknown> = { status: newStatus };
    if (newStatus === 'submitted') updatePayload.submitted_date = localToday();
    if (newStatus === 'approved') updatePayload.approved_date = localToday();
    if (newStatus === 'paid') updatePayload.paid_date = localToday();

    try {
      const result = await supabase.from('rebate_claims').update(updatePayload).eq('id', claimId).select();
      checkMutationResult(result, `Update claim to ${newStatus}`);
      toast('success', `Claim marked as ${newStatus}`);
      if (profile) logActivity('rebate_claim_updated', `Rebate claim status → ${newStatus}`, profile.id);
      fetchClaims();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to update claim status');
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
        if (r.status === 'pending')
          return (
            <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); updateClaimStatus(r.id, 'submitted'); }}>
              Submit
            </Button>
          );
        if (r.status === 'submitted')
          return (
            <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); updateClaimStatus(r.id, 'approved'); }}>
              Approve
            </Button>
          );
        if (r.status === 'approved')
          return (
            <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); updateClaimStatus(r.id, 'paid'); }}>
              Mark Paid
            </Button>
          );
        return null;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">Manufacturer Rebates</h2>
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
      </div>

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
                    {p.product_name}
                  </option>
                ))}
              </select>
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
                  {p.product_name}
                </option>
              ))}
            </select>
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
