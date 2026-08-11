import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, Download, FileText, ToggleLeft, AlertTriangle, UserPlus, UserX } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import Modal from '../components/ui/Modal';
import BulkCustomerImport from '../components/customers/BulkCustomerImport';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { assertRpcResult, checkMutationResult, hasRpcCode, RpcErrorCodes, supabase, supabaseUntyped } from '../lib/db';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { sanitizeError } from '../lib/errorSanitizer';
import { Sentry } from '../lib/sentry';
import { SkeletonTable } from '../components/ui/Skeleton';
import type { Customer } from '../types';

const CUSTOMER_FETCH_LIMIT = 1000;
/** Sentinel for the "no rep assigned" option — a real rep id is never this. */
const UNASSIGNED_REP = '__unassigned__';
type ProfileNeed = 'missing-rep' | 'missing-phone' | 'missing-email' | 'missing-crops';
type ProfileNeedFilter = '' | ProfileNeed | 'ready';

interface CustomerAssignmentResult {
  success: boolean;
  assigned_count: number;
  customer_ids: string[];
  sales_rep_id: string;
}

const NEED_LABELS: Record<ProfileNeed, string> = {
  'missing-rep': 'Missing rep',
  'missing-phone': 'Missing phone',
  'missing-email': 'Missing email',
  'missing-crops': 'Missing crops',
};

function customerNeeds(customer: Customer): ProfileNeed[] {
  const needs: ProfileNeed[] = [];
  if (!customer.assigned_sales_rep) needs.push('missing-rep');
  if (!customer.phone?.trim()) needs.push('missing-phone');
  if (!customer.email?.trim()) needs.push('missing-email');
  if (!Array.isArray(customer.crops) || customer.crops.length === 0) needs.push('missing-crops');
  return needs;
}

export default function Customers() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState('');
  // Deactivated customers stay in the table forever; default the list to the
  // active book so it stays a worklist rather than an ever-growing archive.
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [repFilter, setRepFilter] = useState('');
  const [needsFilter, setNeedsFilter] = useState<ProfileNeedFilter>('');
  const [repNames, setRepNames] = useState<Record<string, string>>({});
  const [assignableReps, setAssignableReps] = useState<Array<{ id: string; name: string }>>([]);
  const [truncated, setTruncated] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [deactivateModalOpen, setDeactivateModalOpen] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [assignmentRepId, setAssignmentRepId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [exporting, setExporting] = useState(false);

  const fetchCustomers = useCallback(async (options: { reportError?: boolean } = {}): Promise<boolean> => {
    const { data, error, count } = await supabase
      .from('customers')
      .select('*', { count: 'exact' })
      .order('farm_name')
      .limit(CUSTOMER_FETCH_LIMIT);
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_customers' } });
      if (options.reportError !== false) toast('error', 'Failed to load customers. Please try again.');
      setLoading(false);
      return false;
    }
    const rows = (data || []) as Customer[];
    // A silent cap reads as "this is everyone" — say so instead of hiding it. The
    // total count is what decides that: a full page means only that the page is
    // full, which is equally true of a book sitting exactly on the limit and
    // showing every customer. Fall back to the page-length test when the count is
    // unavailable — over-warning is the safe direction, silently dropping
    // customers is not.
    setTruncated(
      count === null || count === undefined
        ? rows.length >= CUSTOMER_FETCH_LIMIT
        : count > CUSTOMER_FETCH_LIMIT,
    );
    setCustomers(rows);
    setLoading(false);
    return true;
  }, [toast]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  // Assigned-rep names for the column + filter. A failure here only costs the
  // rep label (the id-based filter still works), so it never blocks the list.
  //
  // Deliberately NOT filtered to active profiles. A customer keeps its
  // assigned_sales_rep when that rep is deactivated, so filtering here resolved
  // every former rep to the same "Unknown rep" label — in the column and in the
  // filter dropdown alike — which is exactly the population an admin needs to
  // pick apart to reassign the accounts (Codex, 2026-08-05). Inactive reps are
  // labelled rather than hidden; this map is display-only, so it never widens
  // who can be *assigned* work.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('profile_public_view')
        .select('id, full_name, role, is_active')
        .order('full_name');
      if (cancelled || error || !data) return;
      setRepNames(Object.fromEntries(
        data.flatMap((p: { id: string | null; full_name: string | null; is_active: boolean | null }) => {
          if (!p.id) return [];
          const name = p.full_name || 'Unnamed user';
          return [[p.id, p.is_active === false ? `${name} (inactive)` : name]];
        }),
      ));
      setAssignableReps(data.flatMap((p: { id: string | null; full_name: string | null; role: string | null; is_active: boolean | null }) => (
        p.id && p.role === 'sales_rep' && p.is_active === true
          ? [{ id: p.id, name: p.full_name || 'Unnamed rep' }]
          : []
      )));
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = customers.filter((c) => {
    if (tierFilter && c.assigned_tier !== parseInt(tierFilter)) return false;
    if (statusFilter === 'active' && !c.is_active) return false;
    if (statusFilter === 'inactive' && c.is_active) return false;
    if (repFilter === UNASSIGNED_REP && c.assigned_sales_rep) return false;
    if (repFilter && repFilter !== UNASSIGNED_REP && c.assigned_sales_rep !== repFilter) return false;
    const needs = customerNeeds(c);
    if (needsFilter === 'ready' && needs.length > 0) return false;
    if (needsFilter && needsFilter !== 'ready' && !needs.includes(needsFilter)) return false;
    return true;
  });

  // Only reps that actually hold accounts in the loaded book — an empty option
  // that always filters to zero rows is worse than no option.
  const repOptions = Array.from(new Set(customers.map((c) => c.assigned_sales_rep).filter(Boolean) as string[]))
    .map((repId) => ({ id: repId, name: repNames[repId] || 'Unknown rep' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const unassignedCount = customers.filter((c) => c.is_active && !c.assigned_sales_rep).length;

  const canBulkAction = profile?.role === 'admin' || profile?.role === 'sales_rep';

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filtered,
      getId: (c) => c.id,
      isSelectable: (c) => c.is_active,
    });
  const assignmentIntentScope = `${assignmentRepId}|${selectedRows.map((customer) => customer.id).sort().join(',')}`;
  const assignmentIdem = useIdempotencyKey(
    'assign_customers_sales_rep',
    profile?.id || '',
    assignmentIntentScope,
  );

  const checkboxCol = useMemo(
    () => createCheckboxColumn<Customer>(selected, toggleSelect, (c) => c.id, (c) => c.is_active),
    [selected, toggleSelect]
  );

  const dataColumns: Column<Customer>[] = [
    {
      key: 'farm_name',
      header: 'Farm Name',
      sortable: true,
      render: (row) => <span className="font-medium text-nav-dark">{row.farm_name}</span>,
    },
    { key: 'contact_name', header: 'Contact', sortable: true },
    { key: 'phone', header: 'Phone' },
    {
      key: 'email',
      header: 'Email',
      render: (row) => row.email || <span className="text-xs text-gray-400">—</span>,
    },
    {
      key: 'assigned_sales_rep',
      header: 'Sales Rep',
      sortable: true,
      render: (row) => (row.assigned_sales_rep
        ? <span>{repNames[row.assigned_sales_rep] || 'Unknown rep'}</span>
        : <span className="text-xs text-amber-600">Unassigned</span>),
    },
    {
      key: '_needs',
      header: 'Needs',
      render: (row) => {
        const needs = customerNeeds(row);
        if (needs.length === 0) return <span className="text-xs font-medium text-emerald-700">Core profile ready</span>;
        return (
          <div className="flex max-w-52 flex-wrap gap-1">
            {needs.map((need) => (
              <span key={need} className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200">
                {NEED_LABELS[need]}
              </span>
            ))}
          </div>
        );
      },
    },
    {
      key: 'assigned_tier',
      header: 'Tier',
      sortable: true,
      render: (row) => (
        <Badge variant={row.assigned_tier === 1 ? 'success' : row.assigned_tier === 2 ? 'info' : 'warning'}>
          Tier {row.assigned_tier}
        </Badge>
      ),
    },
    {
      key: 'total_acres',
      header: 'Total Acres',
      sortable: true,
      render: (row) => row.total_acres?.toLocaleString() || '-',
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (row) => (
        <Badge variant={row.is_active ? 'success' : 'default'}>
          {row.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  // ─── Bulk action handlers ───────────────────────────────────
  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'farm_name', header: 'Farm Name' },
      { key: 'contact_name', header: 'Contact Name' },
      { key: 'phone', header: 'Phone' },
      { key: 'email', header: 'Email' },
      { key: 'assigned_tier', header: 'Tier' },
      { key: 'total_acres', header: 'Total Acres' },
      { key: 'is_active', header: 'Active', format: (v) => (v ? 'Yes' : 'No') },
      { key: 'created_at', header: 'Created', format: (v) => fmtDateCSV(v as string) },
    ], 'customers');
    toast('success', `Exported ${selectedRows.length} customer(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfCols: ReportPdfColumn[] = [
        { header: 'Farm Name', key: 'farm_name' },
        { header: 'Contact', key: 'contact_name' },
        { header: 'Phone', key: 'phone' },
        { header: 'Tier', key: 'assigned_tier' },
        { header: 'Total Acres', key: 'total_acres', align: 'right', format: (v) => v != null ? Number(v).toLocaleString() : '-' },
        { header: 'Status', key: 'is_active', format: (v) => (v ? 'Active' : 'Inactive') },
      ];
      await downloadReportPdf({
        title: 'Customer List',
        subtitle: `${selectedRows.length} customer(s) selected`,
        columns: pdfCols,
        data: selectedRows as unknown as Record<string, unknown>[],
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} customer(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleDeactivate = async () => {
    setDeactivating(true);
    try {
      const ids = selectedRows.map((c) => c.id);

      // H21: Block deactivation if any selected customer has open (posted) invoices
      const { data: openInvoices } = await supabase
        .from('invoices')
        .select('id, customer_id')
        .in('customer_id', ids)
        .in('status', ['posted', 'overdue'])
        .is('deleted_at', null)
        .limit(1);
      if (openInvoices && openInvoices.length > 0) {
        toast('error', 'Cannot deactivate: one or more selected customers have open invoices. Resolve all invoices first.');
        setDeactivating(false);
        setDeactivateModalOpen(false);
        return;
      }

      const result = await supabase
        .from('customers')
        .update({ is_active: false })
        .in('id', ids)
        .select();
      checkMutationResult(result, 'Deactivate customers');
      toast('success', `Deactivated ${ids.length} customer(s)`);
      clearSelection();
      fetchCustomers();
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setDeactivating(false);
    setDeactivateModalOpen(false);
  };

  const handleAssignSalesRep = async () => {
    const targetRep = assignableReps.find((rep) => rep.id === assignmentRepId);
    if (profile?.role !== 'admin' || !targetRep || selectedRows.length === 0) {
      toast('error', 'Choose an active sales representative and at least one active customer.');
      return;
    }

    setAssigning(true);
    try {
      const ids = selectedRows.map((customer) => customer.id);
      const { data, error } = await supabaseUntyped.rpc('assign_customers_sales_rep', {
        p_customer_ids: ids,
        p_sales_rep_id: targetRep.id,
        p_idempotency_key: assignmentIdem.getKey(),
      });
      if (error) throw error;
      const result = assertRpcResult<CustomerAssignmentResult>(data, 'assign_customers_sales_rep');
      if (
        result.success !== true
        || result.assigned_count !== ids.length
        || result.sales_rep_id !== targetRep.id
      ) {
        throw new Error('The assignment response could not be verified. Reload the customer list before continuing.');
      }

      const refreshed = await fetchCustomers({ reportError: false });
      if (!refreshed) {
        // The mutation is confirmed, so keep the visible ownership truthful
        // even when the follow-up read is temporarily unavailable. Do not emit
        // a success toast because the required fresh read did not complete.
        setCustomers((current) => current.map((customer) => (
          ids.includes(customer.id) ? { ...customer, assigned_sales_rep: targetRep.id } : customer
        )));
        clearSelection();
        setAssignModalOpen(false);
        setAssignmentRepId('');
        assignmentIdem.resetKey();
        toast('error', 'Assignment was saved, but the customer list could not refresh. Reload before continuing.');
        return;
      }
      clearSelection();
      setAssignModalOpen(false);
      setAssignmentRepId('');
      assignmentIdem.resetKey();
      toast('success', `Assigned ${ids.length} customer${ids.length === 1 ? '' : 's'} to ${targetRep.name}`);
    } catch (err) {
      if (hasRpcCode(err, RpcErrorCodes.ASSIGNMENT_SALES_REP_INACTIVE)) {
        toast('error', 'The selected sales representative is no longer active. Choose another rep.');
      } else if (hasRpcCode(err, RpcErrorCodes.ASSIGNMENT_CUSTOMER_SET_CHANGED)) {
        const refreshed = await fetchCustomers({ reportError: false });
        toast(
          'error',
          refreshed
            ? 'The selected customer list changed before assignment. Nothing was assigned; review the refreshed selection and retry.'
            : 'The selected customer list changed before assignment and the list could not refresh. Nothing was assigned; reload before retrying.',
        );
      } else if (hasRpcCode(err, RpcErrorCodes.ASSIGNMENT_REPLAY_PAYLOAD_MISMATCH)) {
        // The server proved this key belongs to a different assignment intent,
        // so reusing it can never succeed. The mutation did not run; rotate the
        // key while preserving the visible selection for an immediate retry.
        assignmentIdem.resetKey();
        toast('error', 'The assignment selection changed after an earlier attempt. Review the selected customers and retry.');
      } else {
        toast('error', sanitizeError(err));
      }
    } finally {
      setAssigning(false);
    }
  };

  const bulkActions = [
    ...(profile?.role === 'admin' ? [{
      key: 'assign-rep',
      label: 'Assign sales rep',
      icon: <UserPlus className="w-4 h-4" />,
      onClick: () => {
        setAssignmentRepId('');
        setAssignModalOpen(true);
      },
    }] : []),
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'deactivate', label: 'Deactivate', icon: <ToggleLeft className="w-4 h-4" />, onClick: () => setDeactivateModalOpen(true), variant: 'danger' as const },
  ];

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex-1">
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
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/customers/new')}>
            Add Customer
          </Button>
        </div>
      </div>

      <BulkCustomerImport
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={fetchCustomers}
      />

      {truncated && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Showing the first {CUSTOMER_FETCH_LIMIT.toLocaleString()} customers by farm name — this list is truncated.
            Search and filters below only apply to the customers already loaded.
          </span>
        </div>
      )}

      {unassignedCount > 0 && repFilter !== UNASSIGNED_REP && (
        <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-secondary">
          <UserX className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <span>
            {unassignedCount} active customer{unassignedCount === 1 ? ' has' : 's have'} no assigned sales rep.{' '}
            <button
              type="button"
              onClick={() => { setRepFilter(UNASSIGNED_REP); setStatusFilter('active'); }}
              className="font-medium text-crx-green hover:underline"
            >
              Show them
            </button>
          </span>
        </div>
      )}

      <BulkDeleteConfirmModal
        open={deactivateModalOpen}
        onClose={() => setDeactivateModalOpen(false)}
        count={selectedCount}
        entityName="customer"
        actionWord="deactivate"
        onConfirm={handleDeactivate}
        loading={deactivating}
      />

      <Modal
        open={assignModalOpen}
        onClose={() => {
          if (assigning) return;
          setAssignModalOpen(false);
          setAssignmentRepId('');
        }}
        closeDisabled={assigning}
        title="Assign sales representative"
        footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              disabled={assigning}
              className="min-h-11 w-full sm:w-auto"
              onClick={() => {
                setAssignModalOpen(false);
                setAssignmentRepId('');
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              icon={<UserPlus className="h-4 w-4" />}
              loading={assigning}
              disabled={!assignmentRepId || selectedCount === 0}
              className="min-h-11 w-full sm:w-auto"
              onClick={() => void handleAssignSalesRep()}
            >
              Assign customers
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <label className="block text-sm font-medium text-secondary">
            Sales representative
            <select
              aria-label="Sales representative"
              value={assignmentRepId}
              onChange={(event) => setAssignmentRepId(event.target.value)}
              className="mt-1 block min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-nav-dark focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
            >
              <option value="">Choose an active sales rep</option>
              {assignableReps.map((rep) => <option key={rep.id} value={rep.id}>{rep.name}</option>)}
            </select>
          </label>
          {assignmentRepId ? (
            <p className="rounded-lg bg-blue-50 px-3 py-3 text-sm text-blue-800">
              Assign {selectedCount} selected customer{selectedCount === 1 ? '' : 's'} to {assignableReps.find((rep) => rep.id === assignmentRepId)?.name || 'the selected rep'}?
            </p>
          ) : (
            <p className="text-sm text-secondary">Select the active sales representative who should own these {selectedCount} customer{selectedCount === 1 ? '' : 's'}.</p>
          )}
        </div>
      </Modal>

      <Card padding={false}>
        <div className="p-5">
          <DataTable<Customer>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search customers..."
            searchKeys={['farm_name', 'contact_name', 'phone', 'email']}
            onRowClick={(row) => navigate(`/customers/${row.id}`)}
            emptyTitle="No customers yet"
            emptyDescription="Add your first customer to start quoting"
            emptyAction={
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/customers/new')}>
                Add Customer
              </Button>
            }
            loading={loading}
            filters={
              <>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as 'active' | 'inactive' | 'all')}
                  aria-label="Filter by status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="active">Active only</option>
                  <option value="inactive">Inactive only</option>
                  <option value="all">All statuses</option>
                </select>
                <select
                  value={repFilter}
                  onChange={(e) => setRepFilter(e.target.value)}
                  aria-label="Filter by sales rep"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All reps</option>
                  <option value={UNASSIGNED_REP}>Unassigned</option>
                  {repOptions.map((rep) => (
                    <option key={rep.id} value={rep.id}>{rep.name}</option>
                  ))}
                </select>
                <select
                  value={tierFilter}
                  onChange={(e) => setTierFilter(e.target.value)}
                  aria-label="Filter by tier"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Tiers</option>
                  <option value="1">Tier 1</option>
                  <option value="2">Tier 2</option>
                  <option value="3">Tier 3</option>
                </select>
                <select
                  value={needsFilter}
                  onChange={(e) => setNeedsFilter(e.target.value as ProfileNeedFilter)}
                  aria-label="Filter by profile needs"
                  className="min-h-11 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All profile needs</option>
                  <option value="missing-rep">Missing rep</option>
                  <option value="missing-phone">Missing phone</option>
                  <option value="missing-email">Missing email</option>
                  <option value="missing-crops">Missing crops</option>
                  <option value="ready">Core profile ready</option>
                </select>
                {canBulkAction && filtered.length > 0 && (
                  <button
                    onClick={toggleAll}
                    className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </>
            }
          />
        </div>
      </Card>
    </div>
  );
}
