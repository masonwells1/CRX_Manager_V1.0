import { useEffect, useState } from 'react';
import { Plus, CheckCircle, XCircle } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { generateIdempotencyKey } from '../lib/idempotency';
import { logActivity } from '../lib/activityLogger';
import type { CycleCount, CycleCountItem } from '../types';

type CountRow = CycleCount & {
  initiator_name: string;
  completer_name: string | null;
  item_count: number;
  counted_count: number;
  variance_count: number;
};

type CountItemRow = CycleCountItem & {
  product_name: string;
};

interface CycleCountDbRow {
  id: string;
  initiator?: { full_name: string } | null;
  completer?: { full_name: string } | null;
  items?: Array<{ is_counted: boolean; variance: number | null }>;
  [key: string]: unknown;
}

interface InventoryDbRow {
  id: string;
  product_id: string;
  quantity_available: number;
  product?: { product_name: string } | null;
}

interface CountItemDbRow {
  product?: { product_name: string } | null;
  [key: string]: unknown;
}

export default function CycleCounts() {
  const { profile, role } = useAuth();
  const { toast } = useToast();
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  // New count modal
  const [showNew, setShowNew] = useState(false);
  const [newWarehouse, setNewWarehouse] = useState('Main Warehouse');
  const [newNotes, setNewNotes] = useState('');
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  // Count detail modal
  const [showDetail, setShowDetail] = useState(false);
  const [activeCount, setActiveCount] = useState<CountRow | null>(null);
  const [countItems, setCountItems] = useState<CountItemRow[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [completing, setCompleting] = useState(false);

  const isAdmin = role === 'admin';

  useEffect(() => {
    fetchCounts();
    fetchWarehouses();
  }, []);

  const fetchCounts = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('cycle_counts')
      .select(`
        *,
        initiator:profiles!cycle_counts_initiated_by_fkey(full_name),
        completer:profiles!cycle_counts_completed_by_fkey(full_name),
        items:cycle_count_items(id, is_counted, variance)
      `)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to load cycle counts:', error.message);
      toast('error', 'Failed to load cycle counts');
      setLoading(false);
      return;
    }

    const rows: CountRow[] = ((data || []) as CycleCountDbRow[]).map((c) => ({
      ...c,
      initiator_name: c.initiator?.full_name || 'Unknown',
      completer_name: c.completer?.full_name || null,
      item_count: c.items?.length || 0,
      counted_count: c.items?.filter((i) => i.is_counted).length || 0,
      variance_count: c.items?.filter((i) => i.variance && i.variance !== 0).length || 0,
    })) as CountRow[];
    setCounts(rows);
    setLoading(false);
  };

  const fetchWarehouses = async () => {
    // Pull unique locations from inventory + warehouses table
    const [invRes, whRes] = await Promise.all([
      supabase.from('inventory').select('location'),
      supabase.from('warehouses').select('name').eq('is_active', true),
    ]);
    const invLocs = [...new Set((invRes.data || []).map((r: { location: string | null }) => r.location).filter(Boolean) as string[])];
    const whLocs = (whRes.data || []).map((r: { name: string }) => r.name);
    const all = [...new Set([...invLocs, ...whLocs])].sort();
    setWarehouses(all);
  };

  const filtered = counts.filter((c) => {
    if (statusFilter && c.status !== statusFilter) return false;
    return true;
  });

  // Create new cycle count
  const handleCreate = async () => {
    if (!profile) return;
    setCreating(true);
    try {
      // Generate sequential count number via advisory-lock RPC
      const { data: countNumData, error: countNumError } = await supabase.rpc('next_cycle_count_number');
      if (countNumError) throw countNumError;
      const countNum = countNumData as string;

      // Fetch inventory items for the selected warehouse
      const { data: invData, error: invError } = await supabase
        .from('inventory')
        .select('id, product_id, quantity_available, product:products(product_name)')
        .eq('location', newWarehouse)
        .order('product_id');

      if (invError) throw invError;
      const invItems = (invData || []) as unknown as InventoryDbRow[];

      if (invItems.length === 0) {
        toast('error', 'No inventory found at this location');
        setCreating(false);
        return;
      }

      // Create the cycle count
      const { data: cc, error: ccError } = await supabase
        .from('cycle_counts')
        .insert({
          count_number: countNum,
          warehouse: newWarehouse,
          status: 'in_progress',
          notes: newNotes || null,
        })
        .select()
        .single();

      if (ccError) throw ccError;

      // Insert items
      const items = invItems.map((inv) => ({
        cycle_count_id: cc.id,
        product_id: inv.product_id,
        inventory_id: inv.id,
        expected_qty: inv.quantity_available || 0,
      }));

      const { error: itemsError } = await supabase
        .from('cycle_count_items')
        .insert(items);

      if (itemsError) throw itemsError;

      await logActivity(
        'cycle_count_started',
        `Cycle count ${countNum} started for ${newWarehouse} (${invItems.length} products)`,
        profile.id,
        'cycle_count',
        cc.id
      );

      toast('success', `Cycle count ${countNum} created with ${invItems.length} products`);
      setShowNew(false);
      setNewNotes('');
      fetchCounts();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to create cycle count');
    } finally {
      setCreating(false);
    }
  };

  // Open detail modal
  const openDetail = async (count: CountRow) => {
    setActiveCount(count);
    setShowDetail(true);
    setLoadingItems(true);

    const { data, error } = await supabase
      .from('cycle_count_items')
      .select('*, product:products(product_name)')
      .eq('cycle_count_id', count.id)
      .order('created_at');

    if (error) {
      console.error('Failed to load items:', error.message);
      toast('error', 'Failed to load count items');
    }

    const rows: CountItemRow[] = ((data || []) as CountItemDbRow[]).map((item) => ({
      ...item,
      product_name: item.product?.product_name || 'Unknown',
    })) as CountItemRow[];
    setCountItems(rows);
    setLoadingItems(false);
  };

  // Update a single item's counted quantity
  const updateCountedQty = async (itemId: string, countedQty: number | null) => {
    const item = countItems.find((i) => i.id === itemId);
    if (!item || !profile) return;

    const variance = countedQty !== null ? countedQty - item.expected_qty : null;
    const variancePct = countedQty !== null && item.expected_qty !== 0
      ? ((variance || 0) / item.expected_qty) * 100
      : null;

    const result = await supabase
      .from('cycle_count_items')
      .update({
        counted_qty: countedQty,
        variance: variance,
        variance_pct: variancePct !== null ? Math.round(variancePct * 100) / 100 : null,
        is_counted: countedQty !== null,
        counted_by: profile.id,
        counted_at: new Date().toISOString(),
      })
      .eq('id', itemId)
      .select();

    try {
      checkMutationResult(result, 'Update count item');
    } catch {
      toast('error', 'Failed to update count');
      return;
    }

    // Update local state
    setCountItems((prev) =>
      prev.map((i) =>
        i.id === itemId
          ? {
              ...i,
              counted_qty: countedQty,
              variance,
              variance_pct: variancePct !== null ? Math.round(variancePct * 100) / 100 : null,
              is_counted: countedQty !== null,
              counted_by: profile.id,
              counted_at: new Date().toISOString(),
            }
          : i
      )
    );
  };

  // Complete the cycle count
  const handleComplete = async () => {
    if (!activeCount || !profile) return;

    const uncounted = countItems.filter((i) => !i.is_counted);
    if (uncounted.length > 0) {
      if (!confirm(`${uncounted.length} products have not been counted yet. Complete anyway?`)) {
        return;
      }
    }

    setCompleting(true);
    try {
      const completeKey = generateIdempotencyKey('complete_cycle_count', profile.id);
      const { error } = await supabase.rpc('complete_cycle_count', {
        p_cycle_count_id: activeCount.id,
        p_completed_by: profile.id,
        p_idempotency_key: completeKey,
      });

      if (error) throw error;

      const varianceItems = countItems.filter((i) => i.variance && i.variance !== 0);

      await logActivity(
        'cycle_count_completed',
        `Cycle count ${activeCount.count_number} completed — ${varianceItems.length} variances found`,
        profile.id,
        'cycle_count',
        activeCount.id
      );

      toast('success', `Cycle count completed. ${varianceItems.length} adjustments made.`);
      setShowDetail(false);
      fetchCounts();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to complete cycle count');
    } finally {
      setCompleting(false);
    }
  };

  // Cancel cycle count
  const handleCancel = async () => {
    if (!activeCount || !profile) return;
    if (!confirm('Cancel this cycle count? No inventory adjustments will be made.')) return;

    try {
      const result = await supabase
        .from('cycle_counts')
        .update({ status: 'cancelled' })
        .eq('id', activeCount.id)
        .select();
      checkMutationResult(result, 'Cancel cycle count');

      toast('success', 'Cycle count cancelled');
      setShowDetail(false);
      fetchCounts();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to cancel');
    }
  };

  const statusBadge = (status: string) => {
    switch (status) {
      case 'in_progress':
        return <Badge variant="info">In Progress</Badge>;
      case 'completed':
        return <Badge variant="success">Completed</Badge>;
      case 'cancelled':
        return <Badge variant="default">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const columns: Column<CountRow>[] = [
    {
      key: 'count_number',
      header: 'Count #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.count_number}</span>,
    },
    {
      key: 'warehouse',
      header: 'Location',
      sortable: true,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => statusBadge(row.status),
    },
    {
      key: 'item_count',
      header: 'Products',
      render: (row) => (
        <span>
          {row.counted_count}/{row.item_count} counted
        </span>
      ),
    },
    {
      key: 'variance_count',
      header: 'Variances',
      render: (row) => (
        <span className={row.variance_count > 0 ? 'text-red-600 font-medium' : 'text-gray-500'}>
          {row.variance_count}
        </span>
      ),
    },
    {
      key: 'initiator_name',
      header: 'Started By',
      render: (row) => <span className="text-sm">{row.initiator_name}</span>,
    },
    {
      key: 'started_at',
      header: 'Started',
      sortable: true,
      render: (row) => (
        <span className="text-sm text-gray-500">
          {new Date(row.started_at).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-heading text-nav-dark">Cycle Counts</h1>
        {isAdmin && (
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowNew(true)}>
            New Cycle Count
          </Button>
        )}
      </div>

      <Card padding={false}>
        <div className="p-5">
          <DataTable<CountRow>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search counts..."
            searchKeys={['count_number', 'warehouse']}
            onRowClick={(row) => openDetail(row)}
            emptyTitle="No cycle counts yet"
            emptyDescription="Start a cycle count to verify inventory quantities"
            emptyAction={
              isAdmin ? (
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => setShowNew(true)}>
                  New Cycle Count
                </Button>
              ) : undefined
            }
            loading={loading}
            filters={
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                aria-label="Filter by status"
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="">All Statuses</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            }
          />
        </div>
      </Card>

      {/* New Cycle Count Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="Start New Cycle Count">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Warehouse / Location</label>
            <select
              value={newWarehouse}
              onChange={(e) => setNewWarehouse(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              {warehouses.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </div>
          <Input
            label="Notes (Optional)"
            value={newNotes}
            onChange={(e) => setNewNotes(e.target.value)}
            placeholder="e.g., Monthly count, end-of-season audit"
          />
          <p className="text-sm text-gray-500">
            All inventory products at this location will be included in the count.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button onClick={handleCreate} loading={creating}>
              Start Count
            </Button>
          </div>
        </div>
      </Modal>

      {/* Cycle Count Detail Modal */}
      <Modal
        open={showDetail}
        onClose={() => setShowDetail(false)}
        title={activeCount ? `Cycle Count: ${activeCount.count_number}` : 'Cycle Count'}
        size="large"
      >
        {activeCount && (
          <div className="space-y-4">
            {/* Summary bar */}
            <div className="flex items-center gap-4 text-sm">
              <div>
                <span className="text-gray-500">Location:</span>{' '}
                <span className="font-medium">{activeCount.warehouse}</span>
              </div>
              <div>
                <span className="text-gray-500">Status:</span> {statusBadge(activeCount.status)}
              </div>
              <div>
                <span className="text-gray-500">Started:</span>{' '}
                <span>{new Date(activeCount.started_at).toLocaleDateString()}</span>
              </div>
            </div>

            {/* Items table */}
            {loadingItems ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-2 border-crx-green border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto border border-gray-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium text-gray-600">Product</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-600">Expected</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-600 w-28">Counted</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-600">Variance</th>
                      <th className="text-center py-2 px-3 font-medium text-gray-600 w-16">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {countItems.map((item) => (
                      <tr key={item.id} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="py-2 px-3 font-medium text-nav-dark">{item.product_name}</td>
                        <td className="py-2 px-3 text-right text-gray-600">{item.expected_qty}</td>
                        <td className="py-2 px-3 text-right">
                          {activeCount.status === 'in_progress' ? (
                            <input
                              type="number"
                              step="0.01"
                              value={item.counted_qty ?? ''}
                              onChange={(e) => {
                                const val = e.target.value === '' ? null : parseFloat(e.target.value);
                                updateCountedQty(item.id, val);
                              }}
                              className="w-24 px-2 py-1 text-right text-sm border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green"
                              placeholder="Count..."
                            />
                          ) : (
                            <span>{item.counted_qty ?? '-'}</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          {item.variance !== null ? (
                            <span
                              className={`font-medium ${
                                item.variance > 0
                                  ? 'text-emerald-600'
                                  : item.variance < 0
                                  ? 'text-red-600'
                                  : 'text-gray-500'
                              }`}
                            >
                              {item.variance > 0 ? '+' : ''}
                              {item.variance}
                              {item.variance_pct !== null && (
                                <span className="text-xs ml-1">({item.variance_pct}%)</span>
                              )}
                            </span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          {item.is_counted ? (
                            <CheckCircle className="w-4 h-4 text-crx-green inline" />
                          ) : (
                            <span className="text-gray-300">○</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Summary */}
            <div className="flex items-center gap-6 text-sm bg-gray-50 rounded-lg p-3">
              <div>
                <span className="text-gray-500">Products:</span>{' '}
                <span className="font-medium">{countItems.length}</span>
              </div>
              <div>
                <span className="text-gray-500">Counted:</span>{' '}
                <span className="font-medium text-crx-green">
                  {countItems.filter((i) => i.is_counted).length}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Variances:</span>{' '}
                <span className="font-medium text-red-600">
                  {countItems.filter((i) => i.variance && i.variance !== 0).length}
                </span>
              </div>
            </div>

            {/* Actions */}
            {activeCount.status === 'in_progress' && isAdmin && (
              <div className="flex justify-between pt-2 border-t">
                <Button
                  variant="secondary"
                  onClick={handleCancel}
                  icon={<XCircle className="w-4 h-4" />}
                >
                  Cancel Count
                </Button>
                <Button
                  onClick={handleComplete}
                  loading={completing}
                  icon={<CheckCircle className="w-4 h-4" />}
                >
                  Complete &amp; Apply Adjustments
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
