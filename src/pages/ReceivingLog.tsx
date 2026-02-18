import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PackageCheck,
  Calendar,
  AlertTriangle,
  Clock,
  Camera,
  TrendingUp,
} from 'lucide-react';
import Card from '../components/ui/Card';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/db';
import type { ReceivingRecord, ReceivingSummary, Profile } from '../types';

/* ─── Condition badge helpers ─── */
const conditionVariant = (c: string): 'success' | 'error' | 'warning' | 'default' => {
  if (c === 'good') return 'success';
  if (c === 'damaged' || c === 'wrong_product') return 'error';
  if (c === 'short' || c === 'mixed') return 'warning';
  return 'default';
};
const conditionLabel = (c: string) =>
  c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

export default function ReceivingLog() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [records, setRecords] = useState<ReceivingRecord[]>([]);
  const [summary, setSummary] = useState<ReceivingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  /* Filters */
  const [vendorFilter, setVendorFilter] = useState('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [receivedByFilter, setReceivedByFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  /* Lookup data */
  const [staffProfiles, setStaffProfiles] = useState<Profile[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);

  useEffect(() => {
    fetchData();
    fetchStaff();
  }, []);

  /* Re-fetch when filters change */
  useEffect(() => {
    fetchData();
  }, [vendorFilter, conditionFilter, receivedByFilter, dateFrom, dateTo]);

  const fetchStaff = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .in('role', ['admin', 'sales_rep'])
      .eq('is_active', true)
      .order('full_name');
    setStaffProfiles((data || []) as Profile[]);
  };

  const fetchData = async () => {
    // Fetch summary
    try {
      const { data: sumData, error: sumError } = await supabase.rpc('get_receiving_summary');
      if (!sumError && sumData) {
        setSummary(sumData as ReceivingSummary);
      }
    } catch {
      // non-critical
    }

    // Fetch receiving log via RPC
    try {
      const params: Record<string, any> = {
        p_limit: 500,
        p_offset: 0,
      };
      if (vendorFilter) params.p_vendor = vendorFilter;
      if (conditionFilter) params.p_condition = conditionFilter;
      if (receivedByFilter) params.p_received_by = receivedByFilter;
      if (dateFrom) params.p_date_from = dateFrom;
      if (dateTo) params.p_date_to = dateTo;

      const { data: logData, error: logError } = await supabase.rpc('get_receiving_log', params);

      if (logError) {
        console.error('Failed to load receiving log:', logError.message);
        toast('error', 'Failed to load receiving log');
        setLoading(false);
        return;
      }

      const rows = (logData || []) as ReceivingRecord[];
      setRecords(rows);

      // Extract unique vendors for filter dropdown
      const uniqueVendors = [...new Set(rows.map((r) => r.vendor).filter(Boolean))] as string[];
      if (uniqueVendors.length > 0) setVendors(uniqueVendors);
    } catch (err: any) {
      console.error('Failed to load receiving log:', err);
      toast('error', 'Failed to load receiving log');
    }

    setLoading(false);
  };

  /* ─── Columns ─── */
  const columns: Column<ReceivingRecord>[] = [
    {
      key: 'received_at',
      header: 'Date',
      sortable: true,
      render: (row) => {
        const d = new Date(row.received_at);
        return (
          <div>
            <p className="text-sm font-medium text-nav-dark">{d.toLocaleDateString()}</p>
            <p className="text-xs text-secondary">{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
          </div>
        );
      },
    },
    {
      key: 'po_number' as any,
      header: 'PO #',
      sortable: true,
      render: (row) => (
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/purchase-orders/${row.purchase_order_id}`);
          }}
          className="text-crx-green hover:underline font-medium text-sm"
        >
          {row.po_number || '-'}
        </button>
      ),
    },
    {
      key: 'vendor' as any,
      header: 'Vendor',
      sortable: true,
      render: (row) => <span className="text-sm">{row.vendor || '-'}</span>,
    },
    {
      key: 'product_name' as any,
      header: 'Product',
      sortable: true,
      render: (row) => <span className="text-sm font-medium text-nav-dark">{row.product_name || '-'}</span>,
    },
    {
      key: 'quantity_received',
      header: 'Qty',
      sortable: true,
      render: (row) => (
        <span className="font-mono text-sm">
          {row.quantity_received.toLocaleString()}
          {row.unit_size && <span className="text-xs text-secondary ml-1">({row.unit_size})</span>}
        </span>
      ),
    },
    {
      key: 'condition',
      header: 'Condition',
      sortable: true,
      render: (row) => (
        <Badge variant={conditionVariant(row.condition)}>
          {conditionLabel(row.condition)}
        </Badge>
      ),
    },
    {
      key: 'received_by_name' as any,
      header: 'Received By',
      sortable: true,
      render: (row) => <span className="text-sm">{row.received_by_name || '-'}</span>,
    },
    {
      key: 'lot_number',
      header: 'Lot #',
      render: (row) => <span className="text-xs text-secondary font-mono">{row.lot_number || '-'}</span>,
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (row) => (
        <span className="text-xs text-secondary max-w-[200px] truncate block">
          {row.notes || '-'}
        </span>
      ),
    },
    {
      key: 'photo_count' as any,
      header: '',
      className: 'w-10',
      render: (row) =>
        (row.photo_count ?? 0) > 0 ? (
          <div className="flex items-center gap-1 text-secondary">
            <Camera className="w-3.5 h-3.5" />
            <span className="text-xs">{row.photo_count}</span>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-heading text-nav-dark">Receiving Log</h1>
        <button
          onClick={() => navigate('/receiving/quick')}
          className="flex items-center gap-2 px-4 py-2 bg-crx-green text-white rounded-xl text-sm font-medium hover:bg-crx-green/90 transition-colors shadow-sm"
        >
          <PackageCheck className="w-4 h-4" />
          Quick Receive
        </button>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                <Calendar className="w-5 h-5 text-blue-600" />
              </div>
              <span className="text-sm text-secondary">Expected Today</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-blue-600">{summary.expected_today}</p>
          </Card>
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
                <Clock className="w-5 h-5 text-amber-600" />
              </div>
              <span className="text-sm text-secondary">Pending Receipt</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-amber-600">{summary.pending_receipt}</p>
          </Card>
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-crx-green-light flex items-center justify-center">
                <PackageCheck className="w-5 h-5 text-crx-green" />
              </div>
              <span className="text-sm text-secondary">Received This Week</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-crx-green">{summary.received_this_week}</p>
          </Card>
          <Card>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-purple-600" />
              </div>
              <span className="text-sm text-secondary">Items Received YTD</span>
            </div>
            <p className="text-2xl font-semibold font-heading text-purple-600">{Number(summary.items_received_ytd).toLocaleString()}</p>
          </Card>
        </div>
      )}

      {/* Damaged This Week alert */}
      {summary && summary.damaged_this_week > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>
            <strong>{summary.damaged_this_week}</strong> item{summary.damaged_this_week !== 1 ? 's' : ''} received
            with issues this week
          </span>
        </div>
      )}

      {/* Data Table */}
      <Card padding={false}>
        <div className="p-5">
          <DataTable<ReceivingRecord>
            data={records}
            columns={columns}
            searchable
            searchPlaceholder="Search by PO#, vendor, product, lot#..."
            searchKeys={['po_number', 'vendor', 'product_name', 'lot_number', 'notes'] as any[]}
            onRowClick={(row) => navigate(`/purchase-orders/${row.purchase_order_id}`)}
            emptyTitle="No receiving records"
            emptyDescription="Items received on purchase orders will appear here"
            loading={loading}
            filters={
              <div className="flex gap-2 items-center flex-wrap">
                <select
                  value={conditionFilter}
                  onChange={(e) => setConditionFilter(e.target.value)}
                  aria-label="Filter by condition"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Conditions</option>
                  <option value="good">Good</option>
                  <option value="damaged">Damaged</option>
                  <option value="short">Short</option>
                  <option value="wrong_product">Wrong Product</option>
                  <option value="mixed">Mixed</option>
                </select>
                <select
                  value={receivedByFilter}
                  onChange={(e) => setReceivedByFilter(e.target.value)}
                  aria-label="Filter by received by"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Staff</option>
                  {staffProfiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.full_name}</option>
                  ))}
                </select>
                {vendors.length > 0 && (
                  <select
                    value={vendorFilter}
                    onChange={(e) => setVendorFilter(e.target.value)}
                    aria-label="Filter by vendor"
                    className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">All Vendors</option>
                    {vendors.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                )}
                <div className="flex items-center gap-1">
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    placeholder="From"
                    aria-label="Date from"
                    className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                  <span className="text-xs text-secondary">to</span>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    placeholder="To"
                    aria-label="Date to"
                    className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                </div>
                {(conditionFilter || receivedByFilter || vendorFilter || dateFrom || dateTo) && (
                  <button
                    onClick={() => {
                      setConditionFilter('');
                      setReceivedByFilter('');
                      setVendorFilter('');
                      setDateFrom('');
                      setDateTo('');
                    }}
                    className="text-xs text-crx-green hover:underline ml-1"
                  >
                    Clear Filters
                  </button>
                )}
              </div>
            }
          />
        </div>
      </Card>
    </div>
  );
}
