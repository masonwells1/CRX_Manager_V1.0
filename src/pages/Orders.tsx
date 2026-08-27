import { useEffect, useState, useMemo , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Upload, Download, FileText, Trash2, Users, Truck, Printer, ClipboardList, PanelRightOpen } from 'lucide-react';
import Card from '../components/ui/Card';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import BulkOrderImport from '../components/orders/BulkOrderImport';
import CustomerDrawer from '../components/customers/CustomerDrawer';
import { hasPageAccess } from '../lib/pagePermissions';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { formatUSD as fmt } from '../lib/money';
import { sumNeedByProduct } from '../lib/inventoryShortage';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';
import { downloadBatchOrderSummaryPdf } from '../lib/orderSummaryPdf';
import { downloadBatchPickListPdf } from '../lib/orderPickListPdf';
import type { OrderSummaryData } from '../lib/orderSummaryPdf';
import type { PickListData } from '../lib/orderPickListPdf';
import { SkeletonTable } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import PageHeader from '../components/ui/PageHeader';
import type { Order } from '../types';
import { getSeasonDates } from '../utils/season';
import { activeInvoiceCountsTowardBilling, type InvoiceBillingCoverage } from '../lib/deliveryInvoiceCoverage';

interface OrderWithFulfillment extends Order {
  fulfillment_pct: number;
  invoiced_pct: number;
  farm_group_name: string | null;
  customer_name: string;
  active_delivery_count: number;
  earliest_delivery_date: string | null;
  product_names: string;
}

export default function Orders() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, deniedPages } = useAuth();
  // Customer 360 peek exposes AR balance + credit tier — gate it with the canonical
  // customers-page permission (blocks a rep who is denied /customers — Codex P2).
  const canPeekCustomer = hasPageAccess(role, deniedPages, 'customers');
  const [orders, setOrders] = useState<OrderWithFulfillment[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  // Ship-now/price-later (sell-side #2): filter unpriced rush orders.
  const [pricingFilter, setPricingFilter] = useState('');
  // U7 SAFE-SCOPE: filter orders complete_delivery queued for manual split billing.
  const [splitFilter, setSplitFilter] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [printingSummary, setPrintingSummary] = useState(false);
  const [printingPickList, setPrintingPickList] = useState(false);
  // Customer 360 peek drawer (F2) — view a customer's numbers without leaving the list.
  const [drawerCustomer, setDrawerCustomer] = useState<{ id: string; name: string } | null>(null);

  const canBulkAction = role === 'admin' || role === 'sales_rep';

  const fetchOrders = useCallback(async () => {
    const { start: seasonStart, end: seasonEnd } = getSeasonDates();
    const QUERY_LIMIT = 500;
    const { data: ordersData, error: ordersError } = await supabase
      .from('orders')
      .select('*, customer:customers(farm_name, parent_customer_id)')
      .gte('order_date', seasonStart)
      .lte('order_date', seasonEnd)
      .is('deleted_at', null)
      .order('order_date', { ascending: false })
      .limit(QUERY_LIMIT);

    if (ordersError) {
      Sentry.captureException(ordersError);
      toast('error', 'Failed to load orders. Please try again.');
      setLoading(false);
      return;
    }

    if (ordersData && ordersData.length === QUERY_LIMIT) {
      toast('error', `Showing first ${QUERY_LIMIT} orders — some orders may be hidden. Contact admin if you need the full list.`);
    }

    const orderIds = (ordersData || []).map((o: Record<string, unknown>) => (o as { id: string }).id);

    // Fetch parent customer names for farm group labels
    const parentIds = [...new Set(
      (ordersData || [])
        .map((o: Record<string, unknown>) => (o.customer as { parent_customer_id?: string })?.parent_customer_id)
        .filter(Boolean) as string[]
    )];

    // Run all four queries in parallel — they depend on ordersData but not on each other
    const [itemsResult, invoiceResult, parentsResult, deliveryResult] = await Promise.all([
      supabase
        .from('order_items')
        .select('order_id, total_units_needed, quantity_delivered, price_per_unit, product_name')
        .in('order_id', orderIds.length > 0 ? orderIds : ['__none__']),
      supabase
        .from('invoices')
        .select('order_id, total_amount_cents, invoice_type, status, deleted_at')
        .in('order_id', orderIds.length > 0 ? orderIds : ['__none__']),
      parentIds.length > 0
        ? supabase
            .from('customers')
            .select('id, farm_name')
            .in('id', parentIds)
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('deliveries')
        .select('order_id, scheduled_date, status')
        .in('order_id', orderIds.length > 0 ? orderIds : ['__none__'])
        .in('status', ['scheduled', 'in_progress']),
    ]);

    const { data: itemsData, error: itemsError } = itemsResult;
    if (itemsError) {
      Sentry.captureException(itemsError);
    }

    // H16: Use value-based fulfillment (weighted by price_per_unit) instead of item-count-based
    const itemsByOrder: Record<string, { neededValue: number; deliveredValue: number }> = {};
    // Collect product names per order so the list is searchable by product (F1).
    const productNamesByOrder: Record<string, Set<string>> = {};
    (itemsData || []).forEach((item) => {
      if (!itemsByOrder[item.order_id]) {
        itemsByOrder[item.order_id] = { neededValue: 0, deliveredValue: 0 };
      }
      const price = Number(item.price_per_unit) || 0;
      itemsByOrder[item.order_id].neededValue += (Number(item.total_units_needed) || 0) * price;
      itemsByOrder[item.order_id].deliveredValue += (Number(item.quantity_delivered) || 0) * price;
      const pname = item.product_name;
      if (pname) {
        (productNamesByOrder[item.order_id] ??= new Set()).add(pname);
      }
    });

    // Fetch invoice totals per order for invoiced %
    const { data: invoiceData } = invoiceResult;
    const invoicedByOrder: Record<string, number> = {};
    const visibleOrderIds = new Set(orderIds);
    (invoiceData || []).forEach((inv: InvoiceBillingCoverage & { total_amount_cents: number }) => {
      if (inv.order_id && visibleOrderIds.has(inv.order_id) && activeInvoiceCountsTowardBilling(inv)) {
        invoicedByOrder[inv.order_id] = (invoicedByOrder[inv.order_id] || 0) + (inv.total_amount_cents || 0);
      }
    });

    const parentNameMap: Record<string, string> = {};
    const { data: parents } = parentsResult;
    (parents || []).forEach((p: { id: string; farm_name: string }) => { parentNameMap[p.id] = p.farm_name; });

    // Build active delivery info per order (scheduled + in_progress only)
    const { data: deliveryData, error: deliveryError } = deliveryResult;
    if (deliveryError) {
      Sentry.captureException(deliveryError);
    }
    const deliveryByOrder: Record<string, { count: number; earliestDate: string | null }> = {};
    (deliveryData || []).forEach((del: { order_id: string; scheduled_date: string; status: string }) => {
      if (!deliveryByOrder[del.order_id]) {
        deliveryByOrder[del.order_id] = { count: 0, earliestDate: null };
      }
      deliveryByOrder[del.order_id].count += 1;
      if (!deliveryByOrder[del.order_id].earliestDate || del.scheduled_date < deliveryByOrder[del.order_id].earliestDate!) {
        deliveryByOrder[del.order_id].earliestDate = del.scheduled_date;
      }
    });

    const enriched = ((ordersData || []) as Array<Omit<Order, 'customer'> & {
      customer: { farm_name: string; parent_customer_id: string | null } | null;
    }>).map((o) => {
      const counts = itemsByOrder[o.id] || { neededValue: 0, deliveredValue: 0 };
      const pct = counts.neededValue > 0 ? Math.round((counts.deliveredValue / counts.neededValue) * 100) : 0;
      const orderCents = Math.round((o.total_price || 0) * 100);
      const invCents = invoicedByOrder[o.id] || 0;
      const invPct = orderCents > 0 ? Math.round((invCents / orderCents) * 100) : 0;
      const cust = o.customer;
      const farmGroupName = cust?.parent_customer_id ? parentNameMap[cust.parent_customer_id] || null : null;
      const customerName = cust?.farm_name || '';
      const delInfo = deliveryByOrder[o.id] || { count: 0, earliestDate: null };
      return {
        ...o,
        fulfillment_pct: pct,
        invoiced_pct: Math.min(invPct, 100),
        farm_group_name: farmGroupName,
        customer_name: customerName,
        active_delivery_count: delInfo.count,
        earliest_delivery_date: delInfo.earliestDate,
        product_names: Array.from(productNamesByOrder[o.id] || []).join(', '),
      } as OrderWithFulfillment;
    });

    setOrders(enriched);
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  const filtered = orders.filter((o) => {
    if (statusFilter && o.status !== statusFilter) return false;
    if (planFilter === 'planned' && !o.is_planned) return false;
    if (planFilter === 'committed' && o.is_planned) return false;
    if (pricingFilter && o.pricing_status !== pricingFilter) return false;
    if (splitFilter && !o.needs_split_billing) return false;
    return true;
  });

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({ data: filtered, getId: (o) => o.id });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<OrderWithFulfillment>(selected, toggleSelect, (o) => o.id),
    [selected, toggleSelect]
  );

  const handleExportCSV = () => {
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      { key: 'order_number', header: 'Order #' },
      { key: 'customer', header: 'Customer', format: (v) => (v as { farm_name: string })?.farm_name || '' },
      { key: 'status', header: 'Status' },
      { key: 'total_price', header: 'Total', format: (v) => fmtCSV(v) },
      { key: 'order_date', header: 'Order Date', format: (v) => fmtDateCSV(v) },
      { key: 'fulfillment_pct', header: 'Fulfillment %', format: (v) => `${v}%` },
      { key: 'invoiced_pct', header: 'Invoiced %', format: (v) => `${v}%` },
    ], 'orders');
    toast('success', `Exported ${selectedRows.length} order(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const pdfData = selectedRows.map((o) => ({
        ...o,
        customer_name: (o.customer as unknown as { farm_name: string })?.farm_name || '',
      }));
      await downloadReportPdf({
        title: 'Orders',
        subtitle: `${selectedRows.length} order(s) selected`,
        columns: [
          { header: 'Order #', key: 'order_number' },
          { header: 'Customer', key: 'customer_name' },
          { header: 'Status', key: 'status' },
          { header: 'Total', key: 'total_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
          { header: 'Date', key: 'order_date', format: (v) => v ? new Date(String(v)).toLocaleDateString() : '-' },
          { header: 'Fulfillment', key: 'fulfillment_pct', align: 'right', format: (v) => `${v}%` },
          { header: 'Invoiced', key: 'invoiced_pct', align: 'right', format: (v) => `${v}%` },
        ],
        data: pdfData as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} order(s)`);
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleBulkPrintSummaries = async () => {
    setPrintingSummary(true);
    try {
      const orderIds = selectedRows.map((o) => o.id);
      const customerIds = [...new Set(selectedRows.map((o) => o.customer_id))];

      const [itemsRes, customersRes] = await Promise.all([
        supabase.from('order_items').select('*').in('order_id', orderIds),
        supabase.from('customers').select('*').in('id', customerIds),
      ]);

      const customerMap: Record<string, { farm_name: string; contact_name: string | null; phone: string | null; billing_address: string | null }> = {};
      for (const c of customersRes.data || []) {
        customerMap[c.id] = { farm_name: c.farm_name, contact_name: c.contact_name, phone: c.phone, billing_address: c.billing_address };
      }

      const allItems = itemsRes.data || [];
      const itemsByOrder: Record<string, typeof allItems> = {};
      for (const item of allItems) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }

      const dataList: OrderSummaryData[] = selectedRows.map((o) => {
        const cust = customerMap[o.customer_id] || { farm_name: '', contact_name: null, phone: null, billing_address: null };
        const orderItems = itemsByOrder[o.id] || [];
        return {
          order_number: o.order_number,
          order_name: o.order_name,
          order_date: o.order_date,
          status: o.status,
          customer_po_number: o.customer_po_number,
          farm_name: cust.farm_name,
          contact_name: cust.contact_name,
          phone: cust.phone,
          billing_address: cust.billing_address,
          items: orderItems.map((it: Record<string, unknown>) => ({
            product_name: it.product_name as string,
            quantity: Number(it.total_units_needed),
            unit_size: (it.unit_size as string | null),
            price_per_unit: Number(it.price_per_unit),
            extended_price: Number(it.total_price),
          })),
          total_price: o.total_price,
          notes: o.notes,
        };
      });

      await downloadBatchOrderSummaryPdf(dataList);
      toast('success', `Downloaded ${dataList.length} order summary PDF(s)`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'bulk_print_summaries' } });
      toast('error', sanitizeError(err));
    }
    setPrintingSummary(false);
  };

  const handleBulkPrintPickLists = async () => {
    setPrintingPickList(true);
    try {
      const orderIds = selectedRows.map((o) => o.id);
      const customerIds = [...new Set(selectedRows.map((o) => o.customer_id))];

      const [itemsRes, customersRes, addrRes, invRes] = await Promise.all([
        supabase.from('order_items').select('*').in('order_id', orderIds),
        supabase.from('customers').select('*').in('id', customerIds),
        supabase.from('customer_addresses').select('*').in('customer_id', customerIds).order('is_default', { ascending: false }),
        supabase.from('inventory').select('product_id, quantity_available, quantity_prebooked'),
      ]);

      const customerMap: Record<string, { farm_name: string; contact_name: string | null; phone: string | null; billing_address: string | null }> = {};
      for (const c of customersRes.data || []) {
        customerMap[c.id] = { farm_name: c.farm_name, contact_name: c.contact_name, phone: c.phone, billing_address: c.billing_address };
      }

      // Group addresses by customer
      const addrByCustomer: Record<string, string[]> = {};
      for (const a of addrRes.data || []) {
        const cid = a.customer_id as string;
        if (!addrByCustomer[cid]) addrByCustomer[cid] = [];
        const parts = [a.label, a.address_line, a.city, a.state, a.zip].filter(Boolean);
        const formatted = parts.join(', ');
        if (formatted) addrByCustomer[cid].push(formatted);
      }

      // Build inventory map
      const invMap: Record<string, { available: number; prebooked: number }> = {};
      for (const row of invRes.data || []) {
        const pid = row.product_id as string;
        if (!invMap[pid]) invMap[pid] = { available: 0, prebooked: 0 };
        invMap[pid].available += Number(row.quantity_available);
        invMap[pid].prebooked += Number(row.quantity_prebooked);
      }

      const allItems = itemsRes.data || [];
      const itemsByOrder: Record<string, typeof allItems> = {};
      for (const item of allItems) {
        if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
        itemsByOrder[item.order_id].push(item);
      }

      const dataList: PickListData[] = selectedRows.map((o) => {
        const cust = customerMap[o.customer_id] || { farm_name: '', contact_name: null, phone: null, billing_address: null };
        const orderItems = itemsByOrder[o.id] || [];
        // Flag the shortage against the product's TOTAL remaining on this order.
        // A tier-split booking puts the same product on several lines, and
        // comparing each line alone against the full net-free stock lets two
        // half-sized tier lines both look covered when together they are not.
        // See src/lib/inventoryShortage.ts.
        const remainingByProduct: Record<string, number> = {};
        for (const need of sumNeedByProduct(
          (orderItems as Array<Record<string, unknown>>).map((it) => ({
            productId: it.product_id as string,
            label: (it.product_name as string) || '',
            quantity: Number(it.quantity_remaining),
          }))
        )) {
          remainingByProduct[need.productId] = need.quantity;
        }
        let addresses = addrByCustomer[o.customer_id] || [];
        if (addresses.length === 0 && cust.billing_address) {
          addresses = [cust.billing_address];
        }
        return {
          order_number: o.order_number,
          order_name: o.order_name,
          order_date: o.order_date,
          farm_name: cust.farm_name,
          contact_name: cust.contact_name,
          phone: cust.phone,
          delivery_addresses: addresses,
          items: orderItems.map((it: Record<string, unknown>) => {
            const pid = it.product_id as string;
            const inv = invMap[pid];
            const netFree = inv ? inv.available - inv.prebooked : null;
            const remaining = Number(it.quantity_remaining);
            return {
              product_name: it.product_name as string,
              unit_size: (it.unit_size as string | null),
              total_units_needed: Number(it.total_units_needed),
              quantity_delivered: Number(it.quantity_delivered),
              quantity_remaining: remaining,
              inventory_available: netFree,
              has_shortage: netFree !== null ? (remainingByProduct[pid] ?? remaining) > netFree : false,
            };
          }),
          notes: o.notes,
          program_notes: o.program_notes,
        };
      });

      await downloadBatchPickListPdf(dataList);
      toast('success', `Downloaded ${dataList.length} pick list PDF(s)`);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'bulk_print_pick_lists' } });
      toast('error', sanitizeError(err));
    }
    setPrintingPickList(false);
  };

  const handleBulkDelete = async () => {
    const activeOrders = selectedRows.filter(
      (order) => order.status !== 'cancelled' && order.status !== 'voided'
    );
    if (activeOrders.length > 0) {
      toast(
        'error',
        `${activeOrders.length} selected order(s) are still active. Cancel or void them first, then delete them.`
      );
      setDeleteModalOpen(false);
      return;
    }

    await runCriticalAction({
      action: async () => {
        const ids = selectedRows.map((o) => o.id);
        const result = await supabase.from('orders').update({ deleted_at: new Date().toISOString() }).in('id', ids).select();
        if (result.error?.message.includes('ORDER_MUST_BE_TERMINAL_BEFORE_DELETE')) {
          throw new Error(
            'An order became active before deletion. Refresh the list, then cancel or void it first.'
          );
        }
        checkMutationResult(result, 'Soft-delete orders');
      },
      toast,
      setLoading: setDeleting,
      successMessage: `Deleted ${selectedRows.length} order(s)`,
      sentryTag: 'bulk_delete_orders',
      onSuccess: () => {
        clearSelection();
        fetchOrders();
        setDeleteModalOpen(false);
      },
    });
  };

  const openBulkDelete = () => {
    const activeOrders = selectedRows.filter(
      (order) => order.status !== 'cancelled' && order.status !== 'voided'
    );
    if (activeOrders.length > 0) {
      toast(
        'error',
        `${activeOrders.length} selected order(s) are still active. Cancel or void them first, then delete them.`
      );
      return;
    }
    setDeleteModalOpen(true);
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'print-summary', label: 'Print Summaries', icon: <Printer className="w-4 h-4" />, onClick: handleBulkPrintSummaries, loading: printingSummary },
    { key: 'print-picklist', label: 'Print Pick Lists', icon: <ClipboardList className="w-4 h-4" />, onClick: handleBulkPrintPickLists, loading: printingPickList },
    { key: 'delete', label: 'Delete', icon: <Trash2 className="w-4 h-4" />, onClick: openBulkDelete, variant: 'danger' as const },
  ];

  const dataColumns: Column<OrderWithFulfillment>[] = [
    {
      key: 'order_number',
      header: 'Order #',
      sortable: true,
      render: (row) => (
        <div>
          <span className="font-medium text-nav-dark">{row.order_number}</span>
          {row.order_name && (
            <p className="text-xs text-secondary mt-0.5">{row.order_name}</p>
          )}
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => {
        const name = (row.customer as unknown as { farm_name: string })?.farm_name || '-';
        return (
          <div>
            <div className="flex items-center gap-1.5">
              <span>{name}</span>
              {row.customer_id && canPeekCustomer && (
                <button
                  onClick={(e) => { e.stopPropagation(); setDrawerCustomer({ id: row.customer_id, name }); }}
                  title="Peek customer"
                  aria-label={`Peek ${name}`}
                  className="p-0.5 rounded text-gray-300 hover:text-crx-green hover:bg-crx-green-light transition-colors"
                >
                  <PanelRightOpen className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            {row.farm_group_name && (
              <div className="flex items-center gap-1 mt-0.5">
                <Users className="w-3 h-3 text-blue-500 flex-shrink-0" />
                <span className="text-xs text-blue-600">{row.farm_group_name}</span>
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge variant={statusToBadgeVariant[row.status] || 'default'}>
            {row.status.replace(/_/g, ' ')}
          </Badge>
          {row.is_planned && (
            <Badge variant="warning">Planned</Badge>
          )}
          {row.needs_split_billing && (
            <span title="Delivered with field/acre allocations — auto-invoice was skipped; create split invoices from the order.">
              <Badge variant="warning">Needs Split Billing</Badge>
            </span>
          )}
          {row.active_delivery_count > 0 && row.earliest_delivery_date && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
              <Truck className="w-3 h-3" />
              {row.active_delivery_count > 1
                ? `${row.active_delivery_count} Deliveries`
                : new Date(row.earliest_delivery_date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'total_price',
      header: 'Total',
      sortable: true,
      render: (row) => <span className="font-mono text-sm">{fmt(row.total_price)}</span>,
    },
    {
      key: 'customer_po_number',
      header: 'Customer PO#',
      render: (row) => (row as Order & { customer_po_number?: string }).customer_po_number || '-',
    },
    {
      key: 'order_date',
      header: 'Order Date',
      sortable: true,
      render: (row) => new Date(row.order_date + 'T00:00:00').toLocaleDateString(),
    },
    {
      key: 'fulfillment_pct',
      header: (<span className="flex items-center">Fulfillment<HelpTip text="Fulfillment shows delivery progress. Invoiced shows billing progress. Both are weighted by dollar value." className="ml-1" /></span>),
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-crx-green rounded-full transition-all"
              style={{ width: `${row.fulfillment_pct}%` }}
            />
          </div>
          <span className="text-xs text-secondary">{row.fulfillment_pct}%</span>
        </div>
      ),
    },
    {
      key: 'invoiced_pct',
      header: 'Invoiced',
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all"
              style={{ width: `${row.invoiced_pct}%` }}
            />
          </div>
          <span className="text-xs text-secondary">{row.invoiced_pct}%</span>
        </div>
      ),
    },
  ];

  const columns = canBulkAction ? [checkboxCol, ...dataColumns] : dataColumns;

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Orders"
        actions={
          <>
            {canBulkAction && (
              <BulkActionBar selectedCount={selectedCount} actions={bulkActions} onDeselectAll={clearSelection} />
            )}
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setShowImportModal(true)}>
                <Upload className="w-4 h-4" />
                Import Orders
              </Button>
              <Button onClick={() => navigate('/orders/new')}>
                <Plus className="w-4 h-4" />
                New Order
              </Button>
            </div>
          </>
        }
      />

      <Card padding={false}>
        <div className="p-5">
          <DataTable<OrderWithFulfillment>
            data={filtered}
            columns={columns}
            searchable
            searchPlaceholder="Search orders or products…"
            searchKeys={['order_number', 'farm_group_name', 'customer_name', 'product_names']}
            onRowClick={(row) => navigate(`/orders/${row.id}`)}
            emptyTitle="No orders yet"
            emptyDescription="Start by creating a quote in Sales → Quotes, then convert it to an order. Or create a direct order below."
            emptyAction={
              <div className="flex gap-2">
                <Button variant="secondary" icon={<FileText className="w-4 h-4" />} onClick={() => navigate('/quotes/new')}>
                  New Quote
                </Button>
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/orders/new')}>
                  New Order
                </Button>
              </div>
            }
            loading={loading}
            filters={
              <>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  aria-label="Filter by order status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Statuses</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="partially_fulfilled">Partially Fulfilled</option>
                  <option value="fulfilled">Fulfilled</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="voided">Voided</option>
                </select>
                <select
                  value={planFilter}
                  onChange={(e) => setPlanFilter(e.target.value)}
                  aria-label="Filter by planned or committed"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Orders</option>
                  <option value="planned">Planned Only</option>
                  <option value="committed">Committed Only</option>
                </select>
                <select
                  value={pricingFilter}
                  onChange={(e) => setPricingFilter(e.target.value)}
                  aria-label="Filter by pricing status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Pricing</option>
                  <option value="needs_pricing">Needs Pricing</option>
                  <option value="priced">Priced</option>
                </select>
                <select
                  value={splitFilter}
                  onChange={(e) => setSplitFilter(e.target.value)}
                  aria-label="Filter by split billing status"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Orders</option>
                  <option value="needs_split">Needs Split Billing</option>
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

      <BulkOrderImport
        open={showImportModal}
        onClose={() => setShowImportModal(false)}
        onSuccess={() => {
          setShowImportModal(false);
          fetchOrders();
        }}
        onPartialSuccess={fetchOrders}
      />

      <BulkDeleteConfirmModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        count={selectedCount}
        entityName="order"
        onConfirm={handleBulkDelete}
        loading={deleting}
      />

      <CustomerDrawer
        open={canPeekCustomer && !!drawerCustomer}
        customerId={drawerCustomer?.id ?? ''}
        customerName={drawerCustomer?.name ?? ''}
        onClose={() => setDrawerCustomer(null)}
      />
    </div>
  );
}
