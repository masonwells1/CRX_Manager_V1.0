import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Plus, Trash2 } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import Badge from '../components/ui/Badge';
import ConfirmModal from '../components/ui/ConfirmModal';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { logActivity } from '../lib/activityLogger';
import { supabase, checkMutationResult, assertRpcResult, sanitizeError, hasRpcCode, RpcErrorCodes } from '../lib/db';
import { parseDollarsToCents } from '../lib/parseCents';
import { Sentry } from '../lib/sentry';
import {
  formatApplicationServiceCostDollars,
  parseApplicationServiceCostCents,
} from '../lib/applicationServiceCosts';
import type { Vehicle, Customer, CustomerApplicationRate } from '../types';

// Every column of application_services EXCEPT cost_per_acre_cents. That column is
// our internal per-acre cost — margin, once subtracted from the customer rate —
// and migration 20260729015706 revoked it from `authenticated` at the column-grant
// level, because PostgreSQL has no column-level RLS and every app user shares the
// one `authenticated` DB role. A `select('*')` here would now fail outright with
// "permission denied for column"; admins reach the cost through the two
// admin-gated RPCs below instead.
const SERVICE_COLUMNS = 'id, name, vehicle_id, default_rate_per_acre_cents, is_active, sort_order';

// Money safety: all pricing stored as bigint cents, display divided by 100.
// parseDollarsToCents now comes from the hardened canonical lib/parseCents
// (positive-only, rejects scientific notation / multi-dot — no parseFloat).
function formatCentsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function currentSeason(): number {
  const now = new Date();
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
}

export default function ApplicationServiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, profile } = useAuth();
  const isNew = id === 'new';
  const isAdmin = role === 'admin';

  const [form, setForm] = useState({
    name: '', vehicle_id: '', default_rate_per_acre: '', cost_per_acre: '', is_active: true, sort_order: '0',
  });

  const [vehicles, setVehicles] = useState<Pick<Vehicle, 'id' | 'vehicle_name'>[]>([]);
  const [overrides, setOverrides] = useState<(CustomerApplicationRate & { _dirty?: boolean })[]>([]);
  const [customers, setCustomers] = useState<Pick<Customer, 'id' | 'farm_name'>[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  // "We could not read the cost" is NOT the same fact as "the cost is $0.00", and
  // conflating them loses money: the form would show 0.00, and saving any other
  // field would then push that 0 back through saveCost and destroy the real cost.
  // A new service has nothing to read, so its cost is known by construction.
  const [costKnown, setCostKnown] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);
  const saveIdem = useIdempotencyKey('admin_save_application_service', profile?.id || '');
  const [newOverride, setNewOverride] = useState({ customer_id: '', rate: '', season: currentSeason().toString(), notes: '' });
  const [deleteOverrideId, setDeleteOverrideId] = useState<string | null>(null);

  useEffect(() => { if (!initialLoadDone.current) return; setIsDirty(true); }, [form]);

  useEffect(() => {
    supabase.from('vehicles').select('id, vehicle_name').eq('status', 'active').order('vehicle_name')
      .then(({ data }) => setVehicles((data || []) as Pick<Vehicle, 'id' | 'vehicle_name'>[]));
    supabase.from('customers').select('id, farm_name').eq('is_active', true).order('farm_name')
      .then(({ data }) => setCustomers((data || []) as Pick<Customer, 'id' | 'farm_name'>[]));
  }, []);

  const fetchService = useCallback(async () => {
    const { data, error } = await supabase.from('application_services').select(SERVICE_COLUMNS).eq('id', id!).single();
    if (error || !data) { toast('error', 'Service not found'); navigate('/application-services'); return; }
    // cost_per_acre_cents is admin-only at the column-grant level (migration
    // 20260729015706), so it never comes back on the table read — it is fetched
    // through the admin-gated RPC instead.
    //
    // ADMINS ONLY. The RPC raises 42501 for every other role, so calling it
    // unconditionally would fire a guaranteed-denied request on every non-admin
    // page load. A non-admin gets costKnown = false, which makes any save send
    // NULL ("leave the cost alone"), and the field is not rendered for them.
    //
    // A cost failure is reported but not fatal, and deliberately: returning here
    // would leave the form stuck on its loading state over one admin-only field.
    // The rest of the service still loads. The cost field is left BLANK and
    // flagged unknown — never defaulted to 0.00 — so nothing can be saved back
    // over the real value. The read is wrapped because assertRpcResult THROWS on
    // a null payload; uncaught, that throw would escape fetchService, skip the
    // setLoading(false) below and leave the form spinning its skeleton forever.
    let costCents: bigint | null = null;
    if (isAdmin) {
      const { data: costRows, error: costError } = await supabase
        .rpc('admin_get_application_service_costs', { p_service_id: id! });
      try {
        if (costError) throw costError;
        const rawCost = assertRpcResult<{ service_id: string; cost_per_acre_cents: unknown }[]>(
          costRows, 'admin_get_application_service_costs',
        )[0]?.cost_per_acre_cents;
        if (rawCost === undefined) throw new Error('Application service cost RPC returned no row.');
        costCents = parseApplicationServiceCostCents(rawCost);
      } catch (costErr: unknown) {
        costCents = null;
        Sentry.captureException(costErr, { extra: { context: 'fetch_application_service_cost' } });
        toast('error', 'Failed to load service cost — the cost field is locked until it loads');
      }
    }
    setCostKnown(costCents !== null);
    setForm({ name: data.name, vehicle_id: data.vehicle_id || '', default_rate_per_acre: formatCentsToDollars(data.default_rate_per_acre_cents), cost_per_acre: costCents === null ? '' : formatApplicationServiceCostDollars(costCents), is_active: data.is_active, sort_order: String(data.sort_order) });
    setLoading(false);
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  }, [id, toast, navigate, isAdmin]);

  const fetchOverrides = useCallback(async () => {
    if (isNew || !id) return;
    const { data } = await supabase.from('customer_application_rates').select('*, customer:customers(farm_name)').eq('application_service_id', id).order('season', { ascending: false });
    setOverrides((data || []) as (CustomerApplicationRate & { _dirty?: boolean })[]);
  }, [id, isNew]);

  useEffect(() => {
    if (!isNew && id) { fetchService(); fetchOverrides(); }
    else { setTimeout(() => { initialLoadDone.current = true; }, 0); }
  }, [id, isNew, fetchService, fetchOverrides]);

  // ONE call writes the whole service, cost_per_acre_cents included, inside a
  // single database transaction. This used to be a PostgREST insert/update
  // followed by a separate cost RPC, because `authenticated` holds no write grant
  // on that column — but two calls are two transactions with no rollback between
  // them: if the second failed, a brand-new service stayed committed at cost 0
  // (zero cost reads as infinite margin), and the admin's natural retry created a
  // DUPLICATE service, since idx_application_services_active_name is not unique.
  // Migration 20260729035923 collapsed both writes into
  // admin_save_application_service so they land together or not at all.
  const saveService = async (args: {
    p_name: string;
    p_default_rate_per_acre_cents: number;
    p_is_active: boolean;
    p_sort_order: number;
    p_vehicle_id: string | null;
    p_cost_per_acre_cents: number | null;
    p_service_id: string | null;
  }) => {
    const attempt = async () => {
      const { data, error } = await supabase.rpc('admin_save_application_service', {
        ...args,
        // The Supabase type generator never emits `| null` for an RPC argument,
        // but these three take SQL NULL by design: p_service_id NULL means
        // "create", p_cost_per_acre_cents NULL means "leave the cost alone", and
        // p_vehicle_id NULL means "no vehicle". Same cast the other
        // null-accepting RPC callers use (BlendRecipes.tsx, JobDetail.tsx).
        p_service_id: args.p_service_id as unknown as string,
        p_vehicle_id: args.p_vehicle_id as unknown as string,
        p_cost_per_acre_cents: args.p_cost_per_acre_cents as unknown as number,
        p_idempotency_key: saveIdem.getKey(),
      });
      if (error) throw error;
      return assertRpcResult<{ success: boolean; service_id: string; created: boolean }>(
        data, 'admin_save_application_service',
      );
    };
    let result: { success: boolean; service_id: string; created: boolean };
    try {
      result = await attempt();
    } catch (err: unknown) {
      if (!hasRpcCode(err, RpcErrorCodes.IDEMPOTENCY_CROSS_OP_KEY_REUSE)) throw err;
      // ROTATE ONLY ON THE EDIT PATH. This asymmetry mirrors the RPC's, which
      // scopes the two paths differently on purpose — see the long comment in
      // migration 20260729035923. The two halves are a pair; changing one alone
      // reintroduces a bug.
      //
      // EDIT — the RPC hashes the whole payload, so a *corrected* form retried
      // under the same key is a different operation and is rejected. That loud
      // rejection is deliberate (it beats silently discarding a corrected money
      // figure), but useIdempotencyKey only clears its key on success, so without
      // a rotation here the admin would hit the same rejection on every further
      // attempt and stay wedged until a page reload. Rotating once is safe: the
      // service already exists, the write is an absolute SET rather than a delta,
      // and the end state we want is simply the form just submitted.
      //
      // CREATE — rotating is the exact step that manufactures a duplicate service,
      // so we must not. The RPC's create scope is a constant, which makes one key
      // create at most one service; a fresh key defeats that and nothing in the
      // schema would stop the second row (idx_application_services_active_name is
      // not unique). Reaching this branch on a create would mean the key had
      // already been spent on some other operation, which cannot happen for a
      // freshly mounted new-service form — so surface it rather than paper over it.
      if (args.p_service_id === null) throw err;
      saveIdem.resetKey();
      result = await attempt();
    }
    saveIdem.resetKey();
    return result;
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast('error', 'Service name is required'); return; }
    if (!isAdmin) { toast('error', 'Only admins can manage application services'); return; }
    setSaving(true);
    try {
      const saved = await saveService({
        p_name: form.name.trim(),
        p_default_rate_per_acre_cents: parseDollarsToCents(form.default_rate_per_acre),
        p_is_active: form.is_active,
        p_sort_order: parseInt(form.sort_order) || 0,
        p_vehicle_id: form.vehicle_id || null,
        // NULL means "leave the cost alone" — it is NOT a synonym for zero. If the
        // cost RPC failed on load, form.cost_per_acre is blank and would parse to
        // 0, which would silently replace the real cost. Sending NULL carries the
        // costKnown write-lock into the database instead of relying on the client
        // to skip a second call.
        p_cost_per_acre_cents: costKnown ? parseDollarsToCents(form.cost_per_acre) : null,
        p_service_id: isNew ? null : id!,
      });
      if (isNew) {
        if (profile) logActivity({ event: 'app_service_created', description: `Application service "${form.name}" created`, performedBy: profile.id, entityType: 'application_service', entityId: saved.service_id });
        toast('success', 'Application service created'); setIsDirty(false); navigate(`/application-services/${saved.service_id}`);
      } else {
        if (profile) logActivity({ event: 'app_service_updated', description: `Application service "${form.name}" updated`, performedBy: profile.id, entityType: 'application_service', entityId: id! });
        toast('success', costKnown ? 'Service saved' : 'Service saved — cost/acre left unchanged (it could not be loaded)'); setIsDirty(false);
      }
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'save_application_service' } });
      toast('error', sanitizeError(err));
    }
    setSaving(false);
  };

  const handleAddOverride = async () => {
    if (!newOverride.customer_id || !newOverride.rate) { toast('error', 'Customer and rate are required'); return; }
    const dup = overrides.find((o) => o.customer_id === newOverride.customer_id && o.season === (parseInt(newOverride.season) || currentSeason()));
    if (dup) { toast('error', 'This customer already has a rate for this season. Remove the existing one first.'); return; }
    try {
      const result = await supabase.from('customer_application_rates').insert({ customer_id: newOverride.customer_id, application_service_id: id!, rate_per_acre_cents: parseDollarsToCents(newOverride.rate), season: parseInt(newOverride.season) || currentSeason(), notes: newOverride.notes || null, created_by: profile?.id }).select('*, customer:customers(farm_name)').single();
      checkMutationResult(result, 'Add customer rate override');
      setOverrides((prev) => [result.data as CustomerApplicationRate, ...prev]);
      setNewOverride({ customer_id: '', rate: '', season: currentSeason().toString(), notes: '' });
      if (profile) logActivity({ event: 'app_rate_override_added', description: `Rate override added`, performedBy: profile.id, entityType: 'customer_application_rate', entityId: result.data!.id });
      toast('success', 'Override added');
    } catch (err: unknown) { toast('error', sanitizeError(err)); }
  };

  const confirmDeleteOverride = async () => {
    if (!deleteOverrideId) return;
    try {
      const result = await supabase.from('customer_application_rates').delete().eq('id', deleteOverrideId).select();
      checkMutationResult(result, 'Delete override');
      setOverrides((prev) => prev.filter((o) => o.id !== deleteOverrideId));
      if (profile) logActivity({ event: 'app_rate_override_removed', description: `Rate override removed`, performedBy: profile.id, entityType: 'customer_application_rate', entityId: deleteOverrideId });
      toast('success', 'Override removed');
    } catch (err: unknown) { toast('error', sanitizeError(err)); }
    setDeleteOverrideId(null);
  };

  const updateField = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  if (loading) return (<div className="space-y-6"><div className="h-8 bg-gray-100 rounded w-48 animate-pulse" /><div className="h-64 bg-gray-100 rounded animate-pulse" /></div>);

  return (
    <div className="space-y-6">
      <UnsavedChangesModal open={blocker.state === 'blocked'} onStay={() => blocker.reset?.()} onLeave={() => blocker.proceed?.()} />
      <ConfirmModal open={!!deleteOverrideId} title="Remove Rate Override" message="Remove this customer rate override? The default service rate will apply instead." confirmLabel="Remove" variant="danger" onConfirm={confirmDeleteOverride} onClose={() => setDeleteOverrideId(null)} />

      <div className="flex items-center gap-4">
        <button onClick={() => navigate('/application-services')} className="p-2 hover:bg-gray-100 rounded-lg transition-colors" aria-label="Back to application services"><ArrowLeft className="w-5 h-5" /></button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-nav-dark">{isNew ? 'New Application Service' : form.name}</h1>
          {!isNew && <p className="text-sm text-secondary mt-0.5">{form.is_active ? 'Active' : 'Inactive'} &middot; {form.default_rate_per_acre ? `$${form.default_rate_per_acre}/ac` : 'No rate set'}</p>}
        </div>
        {isAdmin && <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>{isNew ? 'Create Service' : 'Save Changes'}</Button>}
      </div>

      <Card><div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Input label="Service Name" value={form.name} onChange={(e) => updateField('name', e.target.value)} required placeholder="e.g. Hagie Y-Drop Nitrogen" />
        <div><label className="block text-sm font-medium text-nav-dark mb-1">Vehicle (optional)</label><select value={form.vehicle_id} onChange={(e) => updateField('vehicle_id', e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"><option value="">No vehicle linked</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.vehicle_name}</option>)}</select></div>
        <Input label="Default Rate / Acre ($)" type="number" step="0.01" min={0} value={form.default_rate_per_acre} onChange={(e) => updateField('default_rate_per_acre', e.target.value)} placeholder="e.g. 12.00" />
        {/* Admin-only: non-admins never load a cost, so the field would render
            permanently blank with a "could not load" error that is not true for
            them — the column is simply not theirs to see. */}
        {isAdmin && <Input label="Cost / Acre ($)" type="number" step="0.01" min={0} value={form.cost_per_acre} onChange={(e) => updateField('cost_per_acre', e.target.value)} placeholder={costKnown ? 'e.g. 6.50' : 'Unavailable'} disabled={!costKnown} error={costKnown ? undefined : 'Could not load the current cost — editing is locked so it cannot be overwritten. Reload to try again.'} />}
        <Input label="Sort Order" type="number" value={form.sort_order} onChange={(e) => updateField('sort_order', e.target.value)} placeholder="0" />
        <div><label className="block text-sm font-medium text-nav-dark mb-1">Status</label><select value={form.is_active ? 'active' : 'inactive'} onChange={(e) => updateField('is_active', e.target.value === 'active')} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
      </div></Card>

      {!isNew && <Card>
        <h3 className="text-lg font-semibold text-nav-dark mb-4">Customer Rate Overrides</h3>
        <p className="text-sm text-secondary mb-4">Special per-acre rates for specific customers. These override the default rate above.</p>
        <div className="flex items-end gap-3 mb-4 pb-4 border-b border-gray-100">
          <div className="flex-1"><label className="block text-xs font-medium text-secondary mb-1">Customer</label><select value={newOverride.customer_id} onChange={(e) => setNewOverride((p) => ({ ...p, customer_id: e.target.value }))} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"><option value="">Select customer...</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.farm_name}</option>)}</select></div>
          <div className="w-28"><label className="block text-xs font-medium text-secondary mb-1">$/Acre</label><input type="number" step="0.01" min={0} value={newOverride.rate} onChange={(e) => setNewOverride((p) => ({ ...p, rate: e.target.value }))} placeholder="8.00" className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green" /></div>
          <div className="w-24"><label className="block text-xs font-medium text-secondary mb-1">Season</label><input type="number" value={newOverride.season} onChange={(e) => setNewOverride((p) => ({ ...p, season: e.target.value }))} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green" /></div>
          <div className="flex-1"><label className="block text-xs font-medium text-secondary mb-1">Notes</label><input type="text" value={newOverride.notes} onChange={(e) => setNewOverride((p) => ({ ...p, notes: e.target.value }))} placeholder="Optional note" className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green" /></div>
          <Button size="sm" icon={<Plus className="w-3 h-3" />} onClick={handleAddOverride}>Add</Button>
        </div>
        {overrides.length === 0 ? <p className="text-sm text-secondary italic">No customer overrides. All customers use the default rate.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-gray-100 text-left text-secondary"><th className="pb-2 font-medium">Customer</th><th className="pb-2 font-medium text-right">Rate/Acre</th><th className="pb-2 font-medium text-center">Season</th><th className="pb-2 font-medium">Notes</th><th className="pb-2 w-10" /></tr></thead><tbody>
            {overrides.map((o) => <tr key={o.id} className="border-b border-gray-50"><td className="py-2 font-medium text-nav-dark">{o.customer?.farm_name || 'Unknown'}</td><td className="py-2 text-right font-mono"><Badge variant="warning">${formatCentsToDollars(o.rate_per_acre_cents)}/ac</Badge></td><td className="py-2 text-center">{o.season}</td><td className="py-2 text-secondary">{o.notes || '-'}</td><td className="py-2"><button onClick={() => setDeleteOverrideId(o.id)} className="p-1 text-gray-400 hover:text-red-500 transition-colors" title="Remove override"><Trash2 className="w-3.5 h-3.5" /></button></td></tr>)}
          </tbody></table></div>
        )}
      </Card>}
    </div>
  );
}
