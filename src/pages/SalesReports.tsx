import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, FileText, Eye, EyeOff, Users, X } from 'lucide-react';
import Card from '../components/ui/Card';
import DataTable, { type Column } from '../components/ui/DataTable';
import Button from '../components/ui/Button';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult } from '../lib/db';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import { downloadReportPdf, fmtCurrency } from '../lib/reportPdf';
import { computeSeason, seasonStartDate, seasonEndDate, getSeasonDates } from '../utils/season';
import { formatLocalDate } from '../lib/dateUtils';
import type { SalesDetailRow, SalesSummaryRow, FarmGroupMember } from '../types';

// ─── Types ──────────────────────────────────────────────────
type Tab = 'detail' | 'by_product' | 'by_customer' | 'by_month' | 'by_sales_rep';
const VALID_TABS: Tab[] = ['detail', 'by_product', 'by_customer', 'by_month', 'by_sales_rep'];

interface FilterOption { id: string; name: string }

// ─── Date preset logic (matches Reports.tsx / ReportShell) ──
function getPresetDates(preset: string): { start: string; end: string } {
  const now = new Date();
  switch (preset) {
    case 'this_season': return getSeasonDates(now);
    case 'last_season': {
      const s = computeSeason(now) - 1;
      return { start: seasonStartDate(s), end: seasonEndDate(s) };
    }
    case 'ytd': {
      const s = computeSeason(now);
      return { start: seasonStartDate(s), end: formatLocalDate(now) };
    }
    case 'last30': {
      const d = new Date(now.getTime() - 30 * 86400000);
      return { start: formatLocalDate(d), end: formatLocalDate(now) };
    }
    case 'last90': {
      const d = new Date(now.getTime() - 90 * 86400000);
      return { start: formatLocalDate(d), end: formatLocalDate(now) };
    }
    default: return { start: '', end: '' };
  }
}

// ─── Formatters ──────────────────────────────────────────────
const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const fmtDec = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);
const fmtQty = (n: number) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);

// ─── Component ───────────────────────────────────────────────
export default function SalesReports() {
  const { role: _role } = useAuth();
  const { toast } = useToast();

  // ── Tab state — URL-driven (?tab=) so the ⌘K palette can switch reports even when
  // SalesReports is already mounted (Codex P2). The tab buttons write the URL. ──
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: Tab = rawTab && (VALID_TABS as string[]).includes(rawTab) ? (rawTab as Tab) : 'detail';
  const setTab = (t: Tab) => setSearchParams({ tab: t }, { replace: true });
  const [customerView, setCustomerView] = useState(false);

  // ── Filter state ──
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [productId, setProductId] = useState('');
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<string[]>([]);
  const [salesRepId, setSalesRepId] = useState('');
  const [category, setCategory] = useState('');
  const [season, setSeason] = useState('');
  const [includeFarmGroup, setIncludeFarmGroup] = useState(false);

  // ── Filter dropdown options ──
  const [productOptions, setProductOptions] = useState<FilterOption[]>([]);
  const [customerOptions, setCustomerOptions] = useState<FilterOption[]>([]);
  const [salesRepOptions, setSalesRepOptions] = useState<FilterOption[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<string[]>([]);

  // ── Farm group ──
  const [farmGroupMembers, setFarmGroupMembers] = useState<FarmGroupMember[]>([]);
  const [farmGroupCustomerIds, setFarmGroupCustomerIds] = useState<string[]>([]);

  // ── Customer search ──
  const [customerSearch, setCustomerSearch] = useState('');
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);

  // ── Data state ──
  const [detailData, setDetailData] = useState<SalesDetailRow[]>([]);
  const [summaryData, setSummaryData] = useState<SalesSummaryRow[]>([]);
  const [loading, setLoading] = useState(false);

  // ── Season options (current + 4 prior) ──
  const seasonOptions = useMemo(() => {
    const cur = computeSeason(new Date());
    return Array.from({ length: 5 }, (_, i) => cur - i);
  }, []);

  // ── Effective customer IDs (manual selection + farm group) ──
  const effectiveCustomerIds = useMemo(() => {
    if (includeFarmGroup && farmGroupCustomerIds.length > 0) {
      return [...new Set([...selectedCustomerIds, ...farmGroupCustomerIds])];
    }
    return selectedCustomerIds;
  }, [selectedCustomerIds, includeFarmGroup, farmGroupCustomerIds]);

  // ── Load filter options on mount ──
  useEffect(() => {
    supabase.from('products').select('id, product_name').eq('is_active', true).order('product_name').limit(500)
      .then(({ data }) => setProductOptions((data || []).map(r => ({ id: r.id, name: r.product_name }))));
    supabase.from('customers').select('id, farm_name').eq('is_active', true).order('farm_name').limit(1000)
      .then(({ data }) => setCustomerOptions((data || []).map(r => ({ id: r.id, name: r.farm_name }))));
    // PR-07 follow-up: profile_public_view exposes only id/full_name/role/is_active.
    supabase.from('profile_public_view').select('id, full_name').in('role', ['admin', 'sales_rep']).order('full_name')
      .then(({ data }) => setSalesRepOptions((data || []).map(r => ({ id: r.id, name: r.full_name })) as FilterOption[]));
    supabase.from('products').select('category').eq('is_active', true).not('category', 'is', null)
      .then(({ data }) => {
        const unique = [...new Set((data || []).map(r => r.category as string))].filter(Boolean).sort();
        setCategoryOptions(unique);
      });
  }, []);

  // ── Farm group lookup when customer selection changes ──
  useEffect(() => {
    if (selectedCustomerIds.length !== 1) {
      setFarmGroupMembers([]);
      setFarmGroupCustomerIds([]);
      setIncludeFarmGroup(false);
      return;
    }
    const cid = selectedCustomerIds[0];
    (async () => {
      const { data, error } = await supabase.rpc('get_customer_farm_group', { p_customer_id: cid });
      if (error || !data) {
        setFarmGroupMembers([]);
        setFarmGroupCustomerIds([]);
        return;
      }
      const members = assertRpcResult<FarmGroupMember[]>(data, 'get_customer_farm_group');
      if (members.length <= 1) {
        setFarmGroupMembers([]);
        setFarmGroupCustomerIds([]);
        return;
      }
      setFarmGroupMembers(members);
      setFarmGroupCustomerIds(members.map(m => m.id));
    })();
  }, [selectedCustomerIds]);

  // ── Fetch data ──
  const fetchData = useCallback(async () => {
    setLoading(true);
    const params: Record<string, unknown> = {};
    if (startDate) params.p_start_date = startDate;
    if (endDate) params.p_end_date = endDate;
    if (productId) params.p_product_id = productId;
    if (effectiveCustomerIds.length > 0) params.p_customer_ids = effectiveCustomerIds;
    if (salesRepId) params.p_sales_rep_id = salesRepId;
    if (category) params.p_category = category;
    if (season) params.p_season = Number(season);

    if (tab === 'detail') {
      const { data, error } = await supabase.rpc('get_sales_detail_report', params);
      if (error) { toast('error', `Failed to load: ${error.message}`); setLoading(false); return; }
      setDetailData(assertRpcResult<SalesDetailRow[]>(data, 'get_sales_detail_report'));
    } else {
      const groupByMap: Record<Tab, string> = {
        by_product: 'product', by_customer: 'customer',
        by_month: 'month', by_sales_rep: 'sales_rep', detail: 'product',
      };
      const { data, error } = await supabase.rpc('get_sales_summary_report', {
        ...params, p_group_by: groupByMap[tab],
      });
      if (error) { toast('error', `Failed to load: ${error.message}`); setLoading(false); return; }
      setSummaryData(assertRpcResult<SalesSummaryRow[]>(data, 'get_sales_summary_report'));
    }
    setLoading(false);
  }, [tab, startDate, endDate, productId, effectiveCustomerIds, salesRepId, category, season, toast]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Summary totals ──
  const totals = useMemo(() => {
    if (tab === 'detail') {
      return {
        revenue: detailData.reduce((s, r) => s + (r.total_price || 0), 0),
        profit: detailData.reduce((s, r) => s + (r.profit || 0), 0),
        quantity: detailData.reduce((s, r) => s + (r.quantity || 0), 0),
        orders: new Set(detailData.map(r => r.order_number)).size,
      };
    }
    return {
      revenue: summaryData.reduce((s, r) => s + (r.total_revenue || 0), 0),
      profit: summaryData.reduce((s, r) => s + (r.total_profit || 0), 0),
      quantity: summaryData.reduce((s, r) => s + (r.total_quantity || 0), 0),
      orders: summaryData.reduce((s, r) => s + (r.order_count || 0), 0),
    };
  }, [tab, detailData, summaryData]);

  const marginPct = totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : 0;

  // ── Preset helper ──
  const applyPreset = (preset: string) => {
    if (preset === 'all') { setStartDate(''); setEndDate(''); }
    else { const { start, end } = getPresetDates(preset); setStartDate(start); setEndDate(end); }
  };

  // ── Clear all filters ──
  const clearFilters = () => {
    setStartDate(''); setEndDate(''); setProductId('');
    setSelectedCustomerIds([]); setSalesRepId('');
    setCategory(''); setSeason(''); setIncludeFarmGroup(false);
    setCustomerSearch('');
  };

  // ── Customer multi-select helpers ──
  const addCustomer = (id: string) => {
    if (!selectedCustomerIds.includes(id)) {
      setSelectedCustomerIds(prev => [...prev, id]);
    }
    setCustomerSearch('');
    setShowCustomerDropdown(false);
  };

  const removeCustomer = (id: string) => {
    setSelectedCustomerIds(prev => prev.filter(c => c !== id));
  };

  const filteredCustomerOptions = customerOptions.filter(
    c => !selectedCustomerIds.includes(c.id) &&
      c.name.toLowerCase().includes(customerSearch.toLowerCase())
  );

  const getCustomerName = (id: string) => customerOptions.find(c => c.id === id)?.name || 'Unknown';

  // ── CSV export ──
  const handleCSV = () => {
    if (tab === 'detail') {
      const cols = [
        { key: 'order_date', header: 'Date', format: fmtDateCSV },
        { key: 'order_number', header: 'Order #' },
        { key: 'customer_name', header: 'Customer' },
        { key: 'product_name', header: 'Product' },
        { key: 'sku', header: 'SKU' },
        { key: 'category', header: 'Category' },
        { key: 'quantity', header: 'Qty' },
        { key: 'unit', header: 'Unit' },
        { key: 'unit_price', header: 'Unit Price', format: (v: unknown) => fmtCSV(v) },
        { key: 'total_price', header: 'Total', format: (v: unknown) => fmtCSV(v) },
        ...(!customerView ? [
          { key: 'cost', header: 'Cost', format: (v: unknown) => fmtCSV(v) },
          { key: 'profit', header: 'Profit', format: (v: unknown) => fmtCSV(v) },
          { key: 'margin_pct', header: 'Margin %' },
          { key: 'sales_rep_name', header: 'Sales Rep' },
        ] : []),
        { key: 'invoice_number', header: 'Invoice #' },
      ];
      exportToCSV(detailData as unknown as Record<string, unknown>[], cols,
        customerView ? 'purchase_history' : 'sales_detail');
    } else {
      const cols = [
        { key: 'group_key', header: tab === 'by_product' ? 'Product' : tab === 'by_customer' ? 'Customer' : tab === 'by_month' ? 'Month' : tab === 'by_sales_rep' ? 'Sales Rep' : 'Group' },
        { key: 'total_quantity', header: 'Units Sold' },
        { key: 'total_revenue', header: 'Revenue', format: (v: unknown) => fmtCSV(v) },
        ...(!customerView ? [
          { key: 'total_cost', header: 'Cost', format: (v: unknown) => fmtCSV(v) },
          { key: 'total_profit', header: 'Profit', format: (v: unknown) => fmtCSV(v) },
          { key: 'margin_pct', header: 'Margin %' },
        ] : []),
        { key: 'order_count', header: 'Orders' },
        { key: 'line_count', header: 'Line Items' },
      ];
      exportToCSV(summaryData as unknown as Record<string, unknown>[], cols,
        customerView ? 'purchase_summary' : `sales_by_${tab.replace('by_', '')}`);
    }
    toast('success', 'CSV exported');
  };

  // ── PDF export ──
  const handlePDF = async () => {
    const pdfTitle = customerView ? 'Purchase History' : 'Sales Report';
    const subtitle = customerView && selectedCustomerIds.length === 1
      ? getCustomerName(selectedCustomerIds[0])
      : undefined;

    if (tab === 'detail') {
      const cols = [
        { key: 'order_date', header: 'Date', format: (v: unknown) => v ? new Date(v as string).toLocaleDateString() : '' },
        { key: 'customer_name', header: 'Customer' },
        { key: 'product_name', header: 'Product' },
        { key: 'quantity', header: 'Qty', align: 'right' as const, format: (v: unknown) => fmtQty(Number(v) || 0) },
        { key: 'unit', header: 'Unit' },
        { key: 'unit_price', header: 'Unit Price', align: 'right' as const, format: (v: unknown) => fmtCurrency(Number(v) || 0) },
        { key: 'total_price', header: 'Total', align: 'right' as const, format: (v: unknown) => fmtCurrency(Number(v) || 0) },
        ...(!customerView ? [
          { key: 'profit', header: 'Profit', align: 'right' as const, format: (v: unknown) => fmtCurrency(Number(v) || 0) },
          { key: 'margin_pct', header: 'Margin', align: 'right' as const, format: (v: unknown) => `${Number(v || 0).toFixed(1)}%` },
        ] : []),
      ];
      await downloadReportPdf({
        title: pdfTitle,
        subtitle,
        dateRange: startDate ? { start: startDate, end: endDate } : undefined,
        columns: cols,
        data: detailData as unknown as Record<string, unknown>[],
        footerNote: `${detailData.length} line items  •  ${fmt(totals.revenue)} total`,
      });
    } else {
      const cols = [
        { key: 'group_key', header: tab === 'by_product' ? 'Product' : tab === 'by_customer' ? 'Customer' : tab === 'by_month' ? 'Month' : 'Sales Rep' },
        { key: 'total_quantity', header: 'Units', align: 'right' as const, format: (v: unknown) => fmtQty(Number(v) || 0) },
        { key: 'total_revenue', header: 'Revenue', align: 'right' as const, format: (v: unknown) => fmtCurrency(Number(v) || 0) },
        ...(!customerView ? [
          { key: 'total_profit', header: 'Profit', align: 'right' as const, format: (v: unknown) => fmtCurrency(Number(v) || 0) },
          { key: 'margin_pct', header: 'Margin', align: 'right' as const, format: (v: unknown) => `${Number(v || 0).toFixed(1)}%` },
        ] : []),
        { key: 'order_count', header: 'Orders', align: 'right' as const },
      ];
      await downloadReportPdf({
        title: pdfTitle,
        subtitle,
        dateRange: startDate ? { start: startDate, end: endDate } : undefined,
        columns: cols,
        data: summaryData as unknown as Record<string, unknown>[],
        footerNote: `${summaryData.length} groups  •  ${fmt(totals.revenue)} total`,
      });
    }
    toast('success', 'PDF downloaded');
  };

  // ── Active filters indicator ──
  const activeFilterCount = [productId, salesRepId, category, season, startDate]
    .filter(Boolean).length + (selectedCustomerIds.length > 0 ? 1 : 0);

  // ── Tab definitions ──
  const tabs: { key: Tab; label: string; hidden?: boolean }[] = [
    { key: 'detail', label: 'Sales Detail' },
    { key: 'by_product', label: 'By Product' },
    { key: 'by_customer', label: 'By Customer' },
    { key: 'by_month', label: 'By Month' },
    { key: 'by_sales_rep', label: 'By Sales Rep', hidden: customerView },
  ];

  // ─── Detail columns ────────────────────────────────────────
  const detailColumns: Column<SalesDetailRow>[] = useMemo(() => [
    { key: 'order_date', header: 'Date', sortable: true, render: (r) => r.order_date ? new Date(r.order_date + 'T00:00:00').toLocaleDateString() : '' },
    { key: 'customer_name', header: 'Customer', sortable: true },
    { key: 'product_name', header: 'Product', sortable: true },
    { key: 'category', header: 'Category', sortable: true },
    { key: 'quantity', header: 'Qty', sortable: true, className: 'text-right', render: (r) => fmtQty(r.quantity) },
    { key: 'unit', header: 'Unit' },
    { key: 'unit_price', header: 'Unit Price', sortable: true, className: 'text-right', render: (r) => fmtCurrency(r.unit_price) },
    { key: 'total_price', header: 'Total', sortable: true, className: 'text-right font-medium', render: (r) => fmt(r.total_price) },
    ...(!customerView ? [
      { key: 'cost', header: 'Cost', sortable: true, className: 'text-right', render: (r: SalesDetailRow) => fmt(r.cost) },
      { key: 'profit', header: 'Profit', sortable: true, className: 'text-right', render: (r: SalesDetailRow) => fmt(r.profit) },
      { key: 'margin_pct', header: 'Margin', sortable: true, className: 'text-right', render: (r: SalesDetailRow) => <span className={r.margin_pct < 10 ? 'text-red-600' : 'text-crx-green'}>{fmtDec(r.margin_pct)}%</span> },
      { key: 'sales_rep_name', header: 'Rep', sortable: true },
    ] as Column<SalesDetailRow>[] : []),
    { key: 'invoice_number', header: 'Invoice #', render: (r) => r.invoice_number || '—' },
  ], [customerView]);

  // ─── Summary columns ────────────────────────────────────────
  const summaryColumns: Column<SalesSummaryRow>[] = useMemo(() => {
    const groupHeader = tab === 'by_product' ? 'Product' : tab === 'by_customer' ? 'Customer' : tab === 'by_month' ? 'Month' : tab === 'by_sales_rep' ? 'Sales Rep' : 'Group';
    return [
      { key: 'group_key', header: groupHeader, sortable: true },
      { key: 'total_quantity', header: 'Units Sold', sortable: true, className: 'text-right', render: (r) => fmtQty(r.total_quantity) },
      { key: 'total_revenue', header: 'Revenue', sortable: true, className: 'text-right font-medium', render: (r) => fmt(r.total_revenue) },
      ...(!customerView ? [
        { key: 'total_cost', header: 'Cost', sortable: true, className: 'text-right', render: (r: SalesSummaryRow) => fmt(r.total_cost) },
        { key: 'total_profit', header: 'Profit', sortable: true, className: 'text-right', render: (r: SalesSummaryRow) => fmt(r.total_profit) },
        { key: 'margin_pct', header: 'Margin', sortable: true, className: 'text-right', render: (r: SalesSummaryRow) => <span className={r.margin_pct < 10 ? 'text-red-600' : 'text-crx-green'}>{fmtDec(r.margin_pct)}%</span> },
      ] as Column<SalesSummaryRow>[] : []),
      { key: 'order_count', header: 'Orders', sortable: true, className: 'text-right' },
      { key: 'line_count', header: 'Lines', sortable: true, className: 'text-right' },
    ];
  }, [tab, customerView]);

  // ─────────────────────────── RENDER ───────────────────────────
  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <SplitHeading title="Sales &" accent="Chemical History">
        <button
          onClick={() => setCustomerView(!customerView)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
            customerView
              ? 'bg-crx-green text-white border-crx-green'
              : 'border-gray-200 text-secondary hover:border-crx-green hover:text-crx-green'
          }`}
        >
          {customerView ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          Customer View
        </button>
        <Button variant="secondary" size="sm" icon={<Download className="w-4 h-4" />} showChevron={false} onClick={handleCSV}>CSV</Button>
        <Button variant="secondary" size="sm" icon={<FileText className="w-4 h-4" />} showChevron={false} onClick={handlePDF}>PDF</Button>
      </SplitHeading>

      {/* ── Customer View banner ── */}
      {customerView && (
        <div className="flex items-center gap-2 px-4 py-2 bg-crx-green-tint border border-crx-green/20 rounded-lg text-sm text-crx-green font-medium">
          <EyeOff className="w-4 h-4" />
          Customer View — internal cost, profit, and margin data hidden from display and exports
        </div>
      )}

      {/* ── Filter Bar ── */}
      <Card>
        <div className="space-y-3">
          {/* Row 1: Date range + presets */}
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Start Date</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green" />
            </div>
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">End Date</label>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green" />
            </div>
            <div className="flex gap-1.5">
              {[
                { key: 'all', label: 'All Time' },
                { key: 'this_season', label: 'This Season' },
                { key: 'last_season', label: 'Last Season' },
                { key: 'ytd', label: 'YTD' },
                { key: 'last30', label: 'Last 30d' },
                { key: 'last90', label: 'Last 90d' },
              ].map(p => (
                <button key={p.key} onClick={() => applyPreset(p.key)}
                  className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 hover:bg-crx-green-tint hover:border-crx-green hover:text-crx-green transition-colors">
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Row 2: Dropdowns */}
          <div className="flex flex-wrap items-end gap-3">
            {/* Product */}
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Product</label>
              <select value={productId} onChange={e => setProductId(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[180px]">
                <option value="">All Products</option>
                {productOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            {/* Customer multi-select */}
            <div className="relative">
              <label className="block text-xs font-medium text-secondary mb-1">Customer</label>
              <input
                type="text"
                placeholder={selectedCustomerIds.length > 0 ? `${selectedCustomerIds.length} selected` : 'Search customers...'}
                value={customerSearch}
                onChange={e => { setCustomerSearch(e.target.value); setShowCustomerDropdown(true); }}
                onFocus={() => setShowCustomerDropdown(true)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[200px]"
              />
              {showCustomerDropdown && customerSearch && filteredCustomerOptions.length > 0 && (
                <div className="absolute z-20 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
                  {filteredCustomerOptions.slice(0, 20).map(c => (
                    <button key={c.id} onClick={() => addCustomer(c.id)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-crx-green-tint transition-colors">
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Sales Rep (hidden in customer view) */}
            {!customerView && (
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Sales Rep</label>
                <select value={salesRepId} onChange={e => setSalesRepId(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[160px]">
                  <option value="">All Reps</option>
                  {salesRepOptions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}

            {/* Category */}
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Category</label>
              <select value={category} onChange={e => setCategory(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[140px]">
                <option value="">All Categories</option>
                {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Season */}
            <div>
              <label className="block text-xs font-medium text-secondary mb-1">Season</label>
              <select value={season} onChange={e => setSeason(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[100px]">
                <option value="">All</option>
                {seasonOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* Clear */}
            {activeFilterCount > 0 && (
              <button onClick={clearFilters}
                className="flex items-center gap-1 px-3 py-2 text-xs font-medium text-red-600 rounded-lg border border-red-200 hover:bg-red-50 transition-colors">
                <X className="w-3 h-3" /> Clear ({activeFilterCount})
              </button>
            )}
          </div>

          {/* Customer chips + farm group toggle */}
          {selectedCustomerIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {selectedCustomerIds.map(id => (
                <span key={id} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-crx-green-tint text-crx-green rounded-full">
                  {getCustomerName(id)}
                  <button onClick={() => removeCustomer(id)} className="hover:text-red-600"><X className="w-3 h-3" /></button>
                </span>
              ))}
              {/* Farm group toggle (only when 1 customer selected and group exists) */}
              {selectedCustomerIds.length === 1 && farmGroupMembers.length > 1 && (
                <label className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border border-gray-200 rounded-full cursor-pointer hover:border-crx-green transition-colors">
                  <input type="checkbox" checked={includeFarmGroup} onChange={e => setIncludeFarmGroup(e.target.checked)}
                    className="w-3.5 h-3.5 rounded border-gray-300 text-crx-green focus:ring-crx-green" />
                  <Users className="w-3 h-3" />
                  Include {farmGroupMembers.length - 1} linked farm{farmGroupMembers.length - 1 > 1 ? 's' : ''}
                </label>
              )}
              {/* Show farm group members when included */}
              {includeFarmGroup && farmGroupMembers.length > 1 && (
                <>
                  {farmGroupMembers.filter(m => !selectedCustomerIds.includes(m.id)).map(m => (
                    <span key={m.id} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-blue-50 text-blue-700 rounded-full">
                      <Users className="w-3 h-3" /> {m.farm_name}
                    </span>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* ── Summary Cards ── */}
      <div className={`grid gap-4 ${customerView ? 'grid-cols-2' : 'grid-cols-4'}`}>
        <Card>
          <p className="text-xs font-medium text-secondary mb-1">Total Revenue</p>
          <p className="text-2xl font-bold text-nav-dark">{fmt(totals.revenue)}</p>
        </Card>
        {!customerView && (
          <Card>
            <p className="text-xs font-medium text-secondary mb-1">Total Profit</p>
            <p className="text-2xl font-bold text-nav-dark">{fmt(totals.profit)}</p>
            <p className="text-xs text-secondary mt-0.5">{fmtDec(marginPct)}% margin</p>
          </Card>
        )}
        <Card>
          <p className="text-xs font-medium text-secondary mb-1">Units Sold</p>
          <p className="text-2xl font-bold text-nav-dark">{fmtQty(totals.quantity)}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium text-secondary mb-1">Orders</p>
          <p className="text-2xl font-bold text-nav-dark">{totals.orders.toLocaleString()}</p>
        </Card>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 border-b border-gray-200">
        {tabs.filter(t => !t.hidden).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'border-crx-green text-crx-green'
                : 'border-transparent text-secondary hover:text-nav-dark hover:border-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Data Table ── */}
      {tab === 'detail' ? (
        <DataTable<SalesDetailRow>
          data={detailData}
          columns={detailColumns}
          searchable
          searchPlaceholder="Search sales..."
          searchKeys={['customer_name', 'product_name', 'order_number', 'sku', 'category', 'invoice_number']}
          loading={loading}
          emptyTitle="No sales found"
          emptyDescription="Adjust your filters or date range to see results."
        />
      ) : (
        <DataTable<SalesSummaryRow>
          data={summaryData}
          columns={summaryColumns}
          searchable
          searchPlaceholder="Search..."
          searchKeys={['group_key']}
          loading={loading}
          emptyTitle="No data found"
          emptyDescription="Adjust your filters or date range to see results."
        />
      )}
    </div>
  );
}
