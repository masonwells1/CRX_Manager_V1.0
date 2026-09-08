import { useEffect, useState, useMemo , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  PackageCheck,
  Calendar,
  AlertTriangle,
  Clock,
  Camera,
  TrendingUp,
  Download,
  FileText,
  Trash2,
} from 'lucide-react';
import Card from '../ui/Card';
import DataTable, { type Column } from '../ui/DataTable';
import Badge from '../ui/Badge';
import BulkActionBar from '../ui/BulkActionBar';
import BulkDeleteConfirmModal from '../ui/BulkDeleteConfirmModal';
import { useRowSelection, createCheckboxColumn } from '../../hooks/useRowSelection';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { supabase, sanitizeError, assertRpcResult } from '../../lib/db';
import { getIdempotencyBindingRejection } from '../../lib/idempotency';
import { runCriticalAction } from '../../lib/criticalAction';
import { Sentry } from '../../lib/sentry';
import HelpTip from '../ui/HelpTip';
import { exportToCSV } from '../../lib/csvExport';
import { downloadReportPdf } from '../../lib/reportPdf';
import type { ReceivingRecord, ReceivingSummary, Profile } from '../../types';
import ReceivingLogMobileCards from './ReceivingLogMobileCards';

/* ─── Condition badge helpers ─── */
const conditionVariant = (c: string): 'success' | 'error' | 'warning' | 'default' => {
  if (c === 'good') return 'success';
  if (c === 'damaged' || c === 'wrong_product') return 'error';
  if (c === 'short' || c === 'mixed') return 'warning';
  return 'default';
};
const conditionLabel = (c: string) =>
  c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());

export default function ReceivingLogPanel() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const reverseRecIdem = useIdempotencyKey('reverse_receiving_record', profile?.id || '');
  const canBulkAction = role === 'admin' || role === 'sales_rep';

  const [records, setRecords] = useState<ReceivingRecord[]>([]);
  const [summary, setSummary] = useState<ReceivingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  /* Filters */
  const [vendorFilter, setVendorFilter] = useState('');
  const [conditionFilter, setConditionFilter] = useState('');
  const [receivedByFilter, setReceivedByFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [mobileSearch, setMobileSearch] = useState('');

  /* Lookup data */
  const [staffProfiles, setStaffProfiles] = useState<Profile[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);

  const fetchStaff = useCallback(async () => {
    // PR-07 follow-up: staff picker only uses p.id + p.full_name; safe via view.
    const { data } = await supabase
      .from('profile_public_view')
      .select('id, full_name, role, is_active')
      .in('role', ['admin', 'sales_rep'])
      .eq('is_active', true)
      .order('full_name');
    setStaffProfiles((data || []) as Profile[]);
  }, []);

  const fetchData = useCallback(async () => {
    // Fetch summary
    try {
      const { data: sumData, error: sumError } = await supabase.rpc('get_receiving_summary');
      if (!sumError && sumData) {
        setSummary(assertRpcResult<ReceivingSummary>(sumData, 'get_receiving_summary'));
      }
    } catch (err) {
      Sentry.captureException(err);
    }

    // Fetch receiving log via RPC
    try {
      const params: Record<string, string | number> = {
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
        Sentry.captureException(logError);
        toast('error', 'Failed to load receiving log');
        setLoading(false);
        return;
      }

      const rows = assertRpcResult<ReceivingRecord[]>(logData, 'get_receiving_log');
      setRecords(rows);

      // Extract unique vendors for filter dropdown
      const uniqueVendors = [...new Set(rows.map((r) => r.vendor).filter(Boolean))] as string[];
      if (uniqueVendors.length > 0) setVendors(uniqueVendors);
    } catch (err: unknown) {
      Sentry.captureException(err);
      toast('error', 'Failed to load receiving log');
    }

    setLoading(false);
  }, [vendorFilter, conditionFilter, receivedByFilter, dateFrom, dateTo, toast]);

  /* Load staff list once (fetchStaff has stable [] deps) */
  useEffect(() => {
    fetchStaff();
  }, [fetchStaff]);

  /* Fetch data on mount and whenever filters change.
   * fetchData's identity changes with each filter dep, so this single effect
   * covers both cases — a second filter-watching effect would double-fetch. */
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* ─── Bulk selection ─── */
  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({ data: records, getId: (r) => r.id });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<ReceivingRecord>(selected, toggleSelect, (r) => r.id),
    [selected, toggleSelect]
  );

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'received_at', header: 'Date' },
      { key: 'po_number', header: 'PO #' },
      { key: 'vendor', header: 'Vendor' },
      { key: 'product_name', header: 'Product' },
      { key: 'quantity_received', header: 'Qty Received' },
      { key: 'condition', header: 'Condition' },
      { key: 'received_by_name', header: 'Received By' },
      { key: 'lot_number', header: 'Lot #' },
    ], 'receiving_log');
    toast('success', `Exported ${selectedRows.length} record(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      await downloadReportPdf({
        title: 'Receiving Log',
        subtitle: `${selectedRows.length} record(s) selected`,
        columns: [
          { header: 'Date', key: 'received_at', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
          { header: 'PO #', key: 'po_number' },
          { header: 'Vendor', key: 'vendor' },
          { header: 'Product', key: 'product_name' },
          { header: 'Qty', key: 'quantity_received', align: 'right' },
          { header: 'Condition', key: 'condition' },
        ],
        data: selectedRows as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} record(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleBulkDelete = async () => {
    await runCriticalAction({
      action: async () => {
        const ids = selectedRows.map((r) => r.id);
        const completedScopes: string[] = [];
        // C5 fix: must call reverse_receiving_record() per item to undo inventory changes.
        // Direct .delete() bypasses the inventory rollback and leaves phantom stock.
        try {
          for (const id of ids) {
            const reason = 'Bulk deleted from receiving log';
            const intentScope = JSON.stringify({ recordId: id, reason });
            const idemKey = reverseRecIdem.getKeyFor(intentScope);
            const { data, error } = await supabase.rpc('reverse_receiving_record', {
              p_record_id: id,
              p_reason: reason,
              p_idempotency_key: idemKey,
            });
            if (error) {
              if (getIdempotencyBindingRejection(error)) {
                reverseRecIdem.resetKeyFor(intentScope);
              }
              throw new Error(
                `Reversed ${completedScopes.length} of ${ids.length} record(s), then failed on record ${id}: ${error.message}`
              );
            }
            assertRpcResult(data, 'reverse_receiving_record');
            completedScopes.push(intentScope);
          }
        } catch (bulkErr) {
          // Each row commits its own inventory reversal independently, so a
          // refusal partway through (closed accounting period, active vendor
          // bill) leaves the EARLIER rows already reversed. The refresh only
          // ran from onSuccess, so those rows stayed on screen as if they still
          // existed. Refresh here too, so the log reflects what actually
          // committed. Selection and the completed keys are left intact on
          // purpose: an unchanged retry replays the committed rows from their
          // stored receipts and continues at the row that failed.
          // Awaited in its own non-throwing block: an un-awaited refresh let
          // runCriticalAction finish and re-enable the controls while the reversed
          // rows were still on screen, and a refresh rejection became an unhandled
          // one that replaced the real reversal error.
          if (completedScopes.length > 0) {
            try {
              await fetchData();
            } catch (refreshErr) {
              Sentry.captureException(refreshErr);
            }
          }
          throw bulkErr;
        }
        // Retire only after the whole selection succeeds. If a later row
        // fails, completed rows must retain their keys so the retry replays
        // their stored result and can continue to the failed row.
        for (const intentScope of completedScopes) {
          reverseRecIdem.resetKeyFor(intentScope);
        }
      },
      toast,
      setLoading: setDeleting,
      successMessage: `Deleted ${selectedRows.length} record(s)`,
      sentryTag: 'bulk_delete_receiving_records',
      onSuccess: () => {
        clearSelection();
        fetchData();
        setDeleteModalOpen(false);
      },
    });
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  /* ─── Columns ─── */
  const dataColumns: Column<ReceivingRecord>[] = [
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
      key: 'po_number',
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
      key: 'vendor',
      header: 'Vendor',
      sortable: true,
      render: (row) => <span className="text-sm">{row.vendor || '-'}</span>,
    },
    {
      key: 'product_name',
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
        <div className="flex items-center gap-1.5">
          <Badge variant={conditionVariant(row.condition)}>
            {conditionLabel(row.condition)}
          </Badge>
          {row.is_non_returnable && (
            <Badge variant="warning">Non-Returnable</Badge>
          )}
        </div>
      ),
    },
    {
      key: 'received_by_name',
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
      key: 'photo_count',
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

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;
  const mobileRecords = useMemo(() => {
    const query = mobileSearch.trim().toLowerCase();
    if (!query) return records;
    return records.filter((record) =>
      [record.po_number, record.vendor, record.product_name, record.lot_number, record.notes]
        .some((value) => String(value ?? '').toLowerCase().includes(query))
    );
  }, [mobileSearch, records]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col items-start gap-3 md:flex-row md:items-center">
          <h2 className="text-xl font-semibold font-heading text-nav-dark md:whitespace-nowrap">
            Receiving Log
            <HelpTip text="Full audit trail of everything received. Filter by vendor, condition, or date range. Reverse a receiving record if there was an error — inventory and PO quantities will be adjusted automatically." className="ml-1" />
          </h2>
          {canBulkAction && <BulkActionBar selectedCount={selectedCount} actions={bulkActions} onDeselectAll={clearSelection} />}
        </div>
        <button
          onClick={() => navigate('/receiving?tab=quick')}
          className="flex items-center gap-2 px-4 py-2 bg-crx-green text-white rounded-xl text-sm font-medium hover:bg-crx-green/90 transition-colors shadow-sm self-start sm:self-auto"
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
        <div className="space-y-3 p-3 md:hidden">
          <label htmlFor="receiving-log-mobile-search" className="sr-only">Search receiving log</label>
          <input
            id="receiving-log-mobile-search"
            type="search"
            value={mobileSearch}
            onChange={(e) => setMobileSearch(e.target.value)}
            placeholder="Search PO, vendor, product, lot..."
            className="min-h-11 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-base focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={conditionFilter}
              onChange={(e) => setConditionFilter(e.target.value)}
              aria-label="Filter mobile log by condition"
              className="min-h-11 min-w-0 rounded-lg border border-gray-200 px-2 text-sm"
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
              aria-label="Filter mobile log by staff"
              className="min-h-11 min-w-0 rounded-lg border border-gray-200 px-2 text-sm"
            >
              <option value="">All Staff</option>
              {staffProfiles.map((staff) => <option key={staff.id} value={staff.id}>{staff.full_name}</option>)}
            </select>
          </div>
          {vendors.length > 0 && (
            <select
              value={vendorFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              aria-label="Filter mobile log by vendor"
              className="min-h-11 w-full rounded-lg border border-gray-200 px-2 text-sm"
            >
              <option value="">All Vendors</option>
              {vendors.map((vendorName) => <option key={vendorName} value={vendorName}>{vendorName}</option>)}
            </select>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="Mobile date from"
              className="min-h-11 min-w-0 rounded-lg border border-gray-200 px-2 text-sm"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="Mobile date to"
              className="min-h-11 min-w-0 rounded-lg border border-gray-200 px-2 text-sm"
            />
          </div>
          {canBulkAction && records.length > 0 && (
            <button type="button" onClick={toggleAll} className="min-h-11 w-full rounded-lg border border-gray-200 text-sm font-medium text-secondary">
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
          )}
          <ReceivingLogMobileCards
            records={mobileRecords}
            canSelect={canBulkAction}
            selected={selected}
            onToggleSelect={toggleSelect}
            onOpen={(record) => navigate(`/purchase-orders/${record.purchase_order_id}`)}
          />
        </div>

        <div className="hidden p-5 md:block" data-testid="receiving-log-desktop-table">
          <DataTable<ReceivingRecord>
            data={records}
            columns={columns}
            searchable
            searchPlaceholder="Search by PO#, vendor, product, lot#..."
            searchKeys={['po_number', 'vendor', 'product_name', 'lot_number', 'notes'] as string[]}
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
                {canBulkAction && records.length > 0 && (
                  <button
                    onClick={toggleAll}
                    className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </div>
            }
          />
        </div>
      </Card>

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="receiving record"
        onConfirm={handleBulkDelete}
        loading={deleting}
      />
    </div>
  );
}
