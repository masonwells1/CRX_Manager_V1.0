import { useEffect, useState, useMemo , useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { parseLocalDate } from '../lib/dateUtils';
import { Plus, Upload, Copy, Download, FileText, Trash2 } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import BulkQuoteImport from '../components/quotes/BulkQuoteImport';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult, checkMutationResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import type { Quote } from '../types';

const DELETABLE = ['draft', 'sent', 'revised'];

export default function Quotes() {
  const navigate = useNavigate();
  const location = useLocation();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [plannedFilter, setPlannedFilter] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const { toast } = useToast();
  const { profile } = useAuth();
  const duplicateQuoteIdem = useIdempotencyKey('duplicate_quote', profile?.id || '');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  const canBulkAction = profile?.role === 'admin' || profile?.role === 'sales_rep';

  // === GAP FIX #7: Duplicate a quote ===
  const handleDuplicate = async (quoteId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const key = duplicateQuoteIdem.getKey();
      const { data: result, error } = await supabase.rpc('duplicate_quote', {
        p_source_quote_id: quoteId,
        p_performed_by: profile!.id,
        p_idempotency_key: key,
      });
      if (error) {
        toast('error', `Failed to duplicate quote: ${error.message}`);
        return;
      }
      duplicateQuoteIdem.resetKey();
      const dupResult = assertRpcResult<{ quote_id: string; quote_number: string }>(result, 'duplicate_quote');
      toast('success', `Quote duplicated as ${dupResult.quote_number}`);
      navigate(`/quotes/${dupResult.quote_id}`);
    } catch (err: unknown) {
      toast('error', `Failed to duplicate quote: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const fetchQuotes = useCallback(async () => {
    const { data, error } = await supabase
      .from('quotes')
      .select('*, customer:customers(farm_name)')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      console.error('Failed to load quotes:', error.message);
      toast('error', 'Failed to load quotes. Please try again.');
      setLoading(false);
      return;
    }
    setQuotes((data || []) as Quote[]);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchQuotes();
    // Support ?filter=planned from dashboard alert link
    const params = new URLSearchParams(location.search);
    if (params.get('filter') === 'planned') setPlannedFilter(true);
  }, [fetchQuotes, location.search]);

  const filtered = quotes.filter((q) => {
    if (plannedFilter && !q.is_planned) return false;
    if (statusFilter && q.status !== statusFilter) return false;
    return true;
  });

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filtered,
      getId: (q) => q.id,
      isSelectable: (q) => DELETABLE.includes(q.status),
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<Quote>(selected, toggleSelect, (q) => q.id, (q) => DELETABLE.includes(q.status)),
    [selected, toggleSelect]
  );

  // ─── Bulk action handlers ───────────────────────────────────
  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'quote_number', header: 'Quote #' },
      { key: 'customer_name', header: 'Customer', format: (v) => {
        const c = v as { farm_name?: string } | undefined;
        return c?.farm_name || '-';
      }},
      { key: 'status', header: 'Status' },
      { key: 'tier', header: 'Tier' },
      { key: 'total_price', header: 'Total', format: (v) => fmtCSV(v as number) },
      { key: 'created_at', header: 'Created', format: (v) => fmtDateCSV(v as string) },
      { key: 'expires_at', header: 'Expires', format: (v) => fmtDateCSV(v as string) },
    ], 'quotes');
    toast('success', `Exported ${selectedRows.length} quote(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfCols: ReportPdfColumn[] = [
        { header: 'Quote #', key: 'quote_number' },
        { header: 'Customer', key: 'customer_name', format: (v) => {
          const c = v as { farm_name?: string } | undefined;
          return c?.farm_name || '-';
        }},
        { header: 'Status', key: 'status' },
        { header: 'Tier', key: 'tier', format: (v) => `Tier ${v}` },
        { header: 'Total', key: 'total_price', align: 'right', format: (v) => fmt(Number(v)) },
        { header: 'Created', key: 'created_at', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
        { header: 'Expires', key: 'expires_at', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
      ];
      await downloadReportPdf({
        title: 'Quotes',
        subtitle: `${selectedRows.length} quote(s) selected`,
        columns: pdfCols,
        data: selectedRows as unknown as Record<string, unknown>[],
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} quote(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const ids = selectedRows.map((q) => q.id);
      const result = await supabase
        .from('quotes')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', ids)
        .select();
      checkMutationResult(result, 'Delete quotes');
      toast('success', `Deleted ${ids.length} quote(s)`);
      clearSelection();
      fetchQuotes();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setDeleting(false);
    setDeleteModalOpen(false);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'delete', label: 'Delete Quotes', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeleteModalOpen(true), variant: 'danger' as const },
  ];

  const dataColumns: Column<Quote>[] = [
    {
      key: 'quote_number',
      header: 'Quote #',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.quote_number}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => (row.customer as unknown as { farm_name: string })?.farm_name || '-',
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <>
          <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
            {row.status.replace('_', ' ')}
          </Badge>
          {row.is_planned && (
            <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800 rounded">
              Planned
            </span>
          )}
        </>
      ),
    },
    {
      key: 'tier',
      header: 'Tier',
      sortable: true,
      render: (row) => <span>Tier {row.tier}</span>,
    },
    {
      key: 'total_price',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.total_price)}</span>,
    },
    {
      key: 'created_at',
      header: 'Created',
      sortable: true,
      render: (row) => new Date(row.created_at).toLocaleDateString(),
    },
    {
      key: 'expires_at',
      header: 'Expires',
      sortable: true,
      render: (row) => (row.expires_at ? parseLocalDate(row.expires_at).toLocaleDateString() : '-'),
    },
    {
      key: 'id',
      header: '',
      render: (row) => (
        <button
          onClick={(e) => handleDuplicate(row.id, e)}
          className="p-1.5 rounded-lg text-gray-400 hover:text-crx-green hover:bg-crx-green-light transition-colors"
          title="Duplicate this quote"
        >
          <Copy className="w-4 h-4" />
        </button>
      ),
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex-1 flex items-center gap-3">
          <h2 className="text-xl font-semibold font-heading text-nav-dark">Quotes</h2>
          {canBulkAction && (
            <BulkActionBar
              selectedCount={selectedCount}
              actions={bulkActions}
              onDeselectAll={clearSelection}
            />
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon={<Upload className="w-4 h-4" />}
            onClick={() => setImportModalOpen(true)}
          >
            Bulk Import
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
            New Quote
          </Button>
        </div>
      </div>

      <BulkQuoteImport
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={fetchQuotes}
      />

      <Card padding={false}>
        <div className="p-5">
          <DataTable<Quote>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search by quote # or customer..."
            searchKeys={['quote_number', 'customer_name']}
            onRowClick={(row) => navigate(`/quotes/${row.id}`)}
            emptyTitle="No quotes yet"
            emptyDescription="Create your first quote to get started"
            emptyAction={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
                New Quote
              </Button>
            }
            loading={loading}
            filters={
              <div className="flex gap-2 items-center flex-wrap">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by quote status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="draft">Draft</option>
                  <option value="sent">Sent</option>
                  <option value="revised">Revised</option>
                  <option value="accepted">Accepted</option>
                  <option value="declined">Declined</option>
                  <option value="expired">Expired</option>
                </select>
                <button
                  onClick={() => setPlannedFilter(!plannedFilter)}
                  className={`px-3 py-2 text-sm rounded-lg transition-colors ${plannedFilter ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'border border-gray-200 text-secondary hover:bg-gray-50'}`}
                >
                  Planned Programs
                </button>
                {(statusFilter || plannedFilter) && (
                  <button
                    onClick={() => { setStatusFilter(''); setPlannedFilter(false); }}
                    className="text-xs text-crx-green hover:underline"
                  >
                    Clear
                  </button>
                )}
                {canBulkAction && filtered.length > 0 && (
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
        entityName="quote"
        onConfirm={handleDelete}
        loading={deleting}
      />
    </div>
  );
}
