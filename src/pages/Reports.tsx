import { useEffect, useState , useCallback } from 'react';
import { Download, CheckCircle2, FileText } from 'lucide-react';
import Card from '../components/ui/Card';
import DataTable, { type Column } from '../components/ui/DataTable';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import Button from '../components/ui/Button';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, assertRpcResult } from '../lib/db';
import { logActivity } from '../lib/activityLogger';
import { exportToCSV, fmtCSV, fmtDateCSV } from '../lib/csvExport';
import LogbookReport from '../components/reports/LogbookReport';
import YearEndSummaryDialog from '../components/reports/YearEndSummaryDialog';
import { computeSeason, seasonStartDate, seasonEndDate, getSeasonDates } from '../utils/season';
import { downloadYearEndSummaryPdf, downloadBatchYearEndSummaries } from '../lib/yearEndSummaryPdf';
import type { YearEndSummaryOptions } from '../lib/yearEndSummaryPdf';
import { localToday, formatLocalDate, parseLocalDate } from '../lib/dateUtils';
import { Sentry } from '../lib/sentry';
import type {
  PnLRow, GrossSalesRow, CustomerBalanceRow,
  ChemicalHistoryRow, CommissionBalanceRow, InventoryCostRow,
  YearEndSummaryData,
} from '../types';

// ─── Category / Tab types ──────────────────────────────────────
type Category = 'profitability' | 'logbook' | 'financial' | 'operational' | 'year_end';
type ProfitTab = 'customer' | 'product' | 'commission' | 'revenue';
type FinancialTab = 'pnl' | 'gross_sales' | 'customer_balance' | 'commission_balance';
type OperationalTab = 'chemical_history' | 'inventory_cost' | 'posted_applications' | 'price_list';

// ─── Existing profitability interfaces (unchanged) ─────────────
interface CustomerProfit {
  [k: string]: unknown;
  farm_name: string;
  total_revenue: number;
  total_profit: number;
  margin_pct: number;
  order_count: number;
}

interface ProductProfit {
  [k: string]: unknown;
  product_name: string;
  total_revenue: number;
  total_profit: number;
  units_sold: number;
  margin_pct: number;
}

interface CommissionRow {
  [k: string]: unknown;
  id: string;
  recipient: string;
  order_id: string;
  commission_amount: number;
  split_percentage: number;
  order_profit: number;
  order_date: string;
  status: string;
  paid_date: string | null;
}

interface RevenueSummary {
  [k: string]: unknown;
  month: string;
  revenue: number;
  profit: number;
  orders: number;
}

// ─── Date preset logic ─────────────────────────────────────────
// Crop season = October 1 to September 30
function getPresetDates(preset: string): { start: string; end: string } {
  const now = new Date();
  switch (preset) {
    case 'this_season':
      return getSeasonDates(now);
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
    default:
      return { start: '', end: '' };
  }
}

export default function Reports() {
  const { role, profile } = useAuth();
  const { toast } = useToast();
  const isAdmin = role === 'admin';

  // ─── Category / sub-tab state ───────────────────────────────
  const [category, setCategory] = useState<Category>('profitability');
  const [profitTab, setProfitTab] = useState<ProfitTab>('customer');
  const [financialTab, setFinancialTab] = useState<FinancialTab>('pnl');
  const [operationalTab, setOperationalTab] = useState<OperationalTab>('inventory_cost');

  // ─── Date range ─────────────────────────────────────────────
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);

  // ─── PROFITABILITY data (original) ──────────────────────────
  const [customerData, setCustomerData] = useState<CustomerProfit[]>([]);
  const [productData, setProductData] = useState<ProductProfit[]>([]);
  const [commissionData, setCommissionData] = useState<CommissionRow[]>([]);
  const [revenueData, setRevenueData] = useState<RevenueSummary[]>([]);
  const [selectedCommissions, setSelectedCommissions] = useState<Set<string>>(new Set());
  const [markingPaid, setMarkingPaid] = useState(false);

  // ─── FINANCIAL data ─────────────────────────────────────────
  const [pnlData, setPnlData] = useState<PnLRow[]>([]);
  const [grossSalesData, setGrossSalesData] = useState<GrossSalesRow[]>([]);
  const [grossSalesGroupBy, setGrossSalesGroupBy] = useState<'product' | 'customer' | 'salesman'>('product');
  const [custBalanceData, setCustBalanceData] = useState<CustomerBalanceRow[]>([]);
  const [commBalanceData, setCommBalanceData] = useState<CommissionBalanceRow[]>([]);

  // ─── OPERATIONAL data ───────────────────────────────────────
  const [chemHistoryData, setChemHistoryData] = useState<ChemicalHistoryRow[]>([]);
  const [chemProductId, setChemProductId] = useState('');
  const [productOptions, setProductOptions] = useState<{ id: string; name: string }[]>([]);
  const [inventoryCostData, setInventoryCostData] = useState<InventoryCostRow[]>([]);
  const [priceListData, setPriceListData] = useState<Record<string, unknown>[]>([]);
  const [postedAppsData, setPostedAppsData] = useState<Record<string, unknown>[]>([]);

  // ─── YEAR-END data ────────────────────────────────────────
  const [yeCustomerOptions, setYeCustomerOptions] = useState<{ id: string; name: string }[]>([]);
  const [yeSelectedCustomer, setYeSelectedCustomer] = useState('');
  const [showYeDialog, setShowYeDialog] = useState(false);
  const [yeLoading, setYeLoading] = useState(false);
  const [yeBatchMode, setYeBatchMode] = useState(false);

  // Load product options on mount (for chemical history filter)
  useEffect(() => {
    supabase.from('products').select('id, product_name').eq('is_active', true).order('product_name').limit(500)
      .then(({ data: rows }) => {
        setProductOptions((rows || []).map((r) => ({ id: r.id, name: r.product_name })));
      })
      ; // non-critical: product filter dropdown stays empty on error
  }, []);

  // ─── PROFITABILITY sub-fetchers ────────────────────────────
  const fetchCustomerProfitability = useCallback(async () => {
    let query = supabase
      .from('orders')
      .select('total_price, total_profit, total_margin_pct, customer:customers(farm_name)')
      .is('deleted_at', null)
      .in('status', ['confirmed', 'partially_fulfilled', 'fulfilled']);
    if (startDate) query = query.gte('order_date', startDate);
    if (endDate) query = query.lte('order_date', endDate);
    const { data, error } = await query;
    if (error) { toast('error', 'Failed to load customer profitability.'); return; }

    const grouped: Record<string, CustomerProfit> = {};
    ((data || []) as Array<{ total_price: number; total_profit: number; total_margin_pct: number; customer: { farm_name: string }[] | null }>).forEach((o) => {
      const name = o.customer?.[0]?.farm_name || 'Unknown';
      if (!grouped[name]) grouped[name] = { farm_name: name, total_revenue: 0, total_profit: 0, margin_pct: 0, order_count: 0 };
      grouped[name].total_revenue += o.total_price || 0;
      grouped[name].total_profit += o.total_profit || 0;
      grouped[name].order_count += 1;
    });
    const result = Object.values(grouped).map((g) => ({
      ...g,
      margin_pct: g.total_revenue > 0 ? (g.total_profit / g.total_revenue) * 100 : 0,
    }));
    result.sort((a, b) => b.total_revenue - a.total_revenue);
    setCustomerData(result);
  }, [startDate, endDate, toast]);

  const fetchProductProfitability = useCallback(async () => {
    let query = supabase
      .from('order_items')
      .select('product_name, total_price, profit, total_units_needed, order:orders!inner(order_date)');
    if (startDate) query = query.gte('order.order_date', startDate);
    if (endDate) query = query.lte('order.order_date', endDate);
    const { data, error } = await query;
    if (error) { toast('error', 'Failed to load product profitability.'); return; }

    const grouped: Record<string, ProductProfit> = {};
    ((data || []) as Array<{ product_name: string; total_price: number; profit: number; total_units_needed: number }>).forEach((i) => {
      const name = i.product_name;
      if (!grouped[name]) grouped[name] = { product_name: name, total_revenue: 0, total_profit: 0, units_sold: 0, margin_pct: 0 };
      grouped[name].total_revenue += i.total_price || 0;
      grouped[name].total_profit += i.profit || 0;
      grouped[name].units_sold += i.total_units_needed || 0;
    });
    const result = Object.values(grouped).map((g) => ({
      ...g,
      margin_pct: g.total_revenue > 0 ? (g.total_profit / g.total_revenue) * 100 : 0,
    }));
    result.sort((a, b) => b.total_revenue - a.total_revenue);
    setProductData(result);
  }, [startDate, endDate, toast]);

  const fetchCommissions = useCallback(async () => {
    let query = supabase.from('commissions').select('*').order('order_date', { ascending: false });
    if (!isAdmin && profile) query = query.eq('recipient_user_id', profile.id);
    if (startDate) query = query.gte('order_date', startDate);
    if (endDate) query = query.lte('order_date', endDate);
    const { data, error } = await query;
    if (error) { toast('error', 'Failed to load commissions.'); return; }
    setCommissionData((data || []) as CommissionRow[]);
    setSelectedCommissions(new Set());
  }, [isAdmin, profile, startDate, endDate, toast]);

  const fetchRevenue = useCallback(async () => {
    let query = supabase.from('orders').select('order_date, total_price, total_profit')
      .is('deleted_at', null)
      .in('status', ['confirmed', 'partially_fulfilled', 'fulfilled'])
      .order('order_date');
    if (startDate) query = query.gte('order_date', startDate);
    if (endDate) query = query.lte('order_date', endDate);
    const { data, error } = await query;
    if (error) { toast('error', 'Failed to load revenue data.'); return; }

    const grouped: Record<string, RevenueSummary> = {};
    ((data || []) as Array<{ order_date: string; total_price: number; total_profit: number }>).forEach((o) => {
      const month = o.order_date.substring(0, 7);
      if (!grouped[month]) grouped[month] = { month, revenue: 0, profit: 0, orders: 0 };
      grouped[month].revenue += o.total_price || 0;
      grouped[month].profit += o.total_profit || 0;
      grouped[month].orders += 1;
    });
    setRevenueData(Object.values(grouped).sort((a, b) => b.month.localeCompare(a.month)));
  }, [startDate, endDate, toast]);

  // ─── PROFITABILITY parent fetcher ────────────────────────────
  const fetchProfitability = useCallback(async () => {
    setLoading(true);
    if (profitTab === 'customer') await fetchCustomerProfitability();
    if (profitTab === 'product') await fetchProductProfitability();
    if (profitTab === 'commission') await fetchCommissions();
    if (profitTab === 'revenue') await fetchRevenue();
    setLoading(false);
  }, [profitTab, fetchCustomerProfitability, fetchProductProfitability, fetchCommissions, fetchRevenue]);

  // ─── FINANCIAL sub-fetchers ─────────────────────────────────
  const fetchPnL = useCallback(async () => {
    if (!startDate || !endDate) { setPnlData([]); return; }
    const { data, error } = await supabase.rpc('get_bottom_line_pnl', { p_start_date: startDate, p_end_date: endDate });
    if (error) { toast('error', `P&L failed: ${error.message}`); return; }
    setPnlData(assertRpcResult<PnLRow[]>(data, 'get_bottom_line_pnl'));
  }, [startDate, endDate, toast]);

  const fetchGrossSales = useCallback(async () => {
    if (!startDate || !endDate) { setGrossSalesData([]); return; }
    const { data, error } = await supabase.rpc('get_gross_sales_report', {
      p_start_date: startDate,
      p_end_date: endDate,
      p_group_by: grossSalesGroupBy,
    });
    if (error) { toast('error', `Gross sales failed: ${error.message}`); return; }
    setGrossSalesData(assertRpcResult<GrossSalesRow[]>(data, 'get_gross_sales_report'));
  }, [startDate, endDate, grossSalesGroupBy, toast]);

  const fetchCustomerBalance = useCallback(async () => {
    const asOf = endDate || localToday();
    const { data, error } = await supabase.rpc('get_customer_balance_listing', { p_as_of_date: asOf });
    if (error) { toast('error', `Customer balance failed: ${error.message}`); return; }
    setCustBalanceData(assertRpcResult<CustomerBalanceRow[]>(data, 'get_customer_balance_listing'));
  }, [endDate, toast]);

  const fetchCommissionBalance = useCallback(async () => {
    const asOf = endDate || localToday();
    const { data, error } = await supabase.rpc('get_commission_balance_report', { p_as_of_date: asOf });
    if (error) { toast('error', `Commission balance failed: ${error.message}`); return; }
    setCommBalanceData(assertRpcResult<CommissionBalanceRow[]>(data, 'get_commission_balance_report'));
  }, [endDate, toast]);

  // ─── FINANCIAL parent fetcher ─────────────────────────────────
  const fetchFinancial = useCallback(async () => {
    setLoading(true);
    if (financialTab === 'pnl') await fetchPnL();
    if (financialTab === 'gross_sales') await fetchGrossSales();
    if (financialTab === 'customer_balance') await fetchCustomerBalance();
    if (financialTab === 'commission_balance') await fetchCommissionBalance();
    setLoading(false);
  }, [financialTab, fetchPnL, fetchGrossSales, fetchCustomerBalance, fetchCommissionBalance]);

  // ─── OPERATIONAL sub-fetchers ───────────────────────────────
  const fetchChemHistory = useCallback(async () => {
    if (!chemProductId || !startDate || !endDate) { setChemHistoryData([]); return; }
    const { data, error } = await supabase.rpc('get_chemical_history', {
      p_product_id: chemProductId,
      p_start_date: startDate,
      p_end_date: endDate,
    });
    if (error) { toast('error', `Chemical history failed: ${error.message}`); return; }
    setChemHistoryData(assertRpcResult<ChemicalHistoryRow[]>(data, 'get_chemical_history'));
  }, [chemProductId, startDate, endDate, toast]);

  const fetchInventoryCost = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_inventory_cost_report');
    if (error) { toast('error', `Inventory cost failed: ${error.message}`); return; }
    setInventoryCostData(assertRpcResult<InventoryCostRow[]>(data, 'get_inventory_cost_report'));
  }, [toast]);

  const fetchPriceList = useCallback(async () => {
    const { data, error } = await supabase
      .from('products')
      .select('product_name, sku, category, vendor, tier1_price, tier2_price, tier3_price, current_cost, product_form, container_type, container_size, unit_size')
      .eq('is_active', true)
      .order('product_name')
      .limit(500);
    if (error) { toast('error', 'Failed to load price list.'); return; }
    setPriceListData((data || []) as Record<string, unknown>[]);
  }, [toast]);

  const fetchPostedApplications = useCallback(async () => {
    // PR-07 follow-up: dropped `applicator:profiles(full_name)` embed; applicator
    // names resolved via profile_public_view post-fetch (sales_rep loses
    // profiles SELECT once 20260510999999_profiles_select_tighten lands).
    let query = supabase
      .from('application_records')
      .select('record_number, application_date, customer:customers(farm_name), field:fields(field_name), applicator_id, total_acres, invoice_id, season')
      .not('invoice_id', 'is', null)
      .order('application_date', { ascending: false })
      .limit(500);
    if (startDate) query = query.gte('application_date', startDate);
    if (endDate) query = query.lte('application_date', endDate);
    const { data, error } = await query;
    if (error) { toast('error', 'Failed to load posted applications.'); return; }

    const rows = (data || []) as Array<Record<string, unknown> & {
      customer?: { farm_name?: string };
      field?: { field_name?: string };
      applicator_id?: string | null;
    }>;

    const applicatorIds = [...new Set(
      rows.map((r) => r.applicator_id).filter(Boolean) as string[]
    )];

    let applicatorNameMap: Record<string, string> = {};
    if (applicatorIds.length > 0) {
      const { data: applicators } = await supabase
        .from('profile_public_view')
        .select('id, full_name')
        .in('id', applicatorIds);
      applicatorNameMap = Object.fromEntries(
        (applicators || []).map((a: { id: string; full_name: string }) => [a.id, a.full_name])
      );
    }

    setPostedAppsData(rows.map((r) => ({
      ...r,
      customer_name: r.customer?.farm_name || 'Unknown',
      field_name: r.field?.field_name || '-',
      applicator_name: r.applicator_id ? (applicatorNameMap[r.applicator_id] || 'Unknown') : '-',
    })));
  }, [startDate, endDate, toast]);

  // ─── OPERATIONAL parent fetcher ───────────────────────────────
  const fetchOperational = useCallback(async () => {
    setLoading(true);
    if (operationalTab === 'chemical_history') await fetchChemHistory();
    if (operationalTab === 'inventory_cost') await fetchInventoryCost();
    if (operationalTab === 'price_list') await fetchPriceList();
    if (operationalTab === 'posted_applications') await fetchPostedApplications();
    setLoading(false);
  }, [operationalTab, fetchChemHistory, fetchInventoryCost, fetchPriceList, fetchPostedApplications]);

  // ─── Fetch on tab/date change ───────────────────────────────
  useEffect(() => {
    if (category === 'profitability') fetchProfitability();
    if (category === 'financial') fetchFinancial();
    if (category === 'operational') fetchOperational();
  }, [category, profitTab, financialTab, operationalTab, startDate, endDate, grossSalesGroupBy, chemProductId, fetchProfitability, fetchFinancial, fetchOperational]);

  // ─── YEAR-END fetchers / handlers ──────────────────────
  useEffect(() => {
    if (category === 'year_end' && yeCustomerOptions.length === 0) {
      supabase.from('customers').select('id, farm_name').eq('is_active', true).order('farm_name').limit(1000)
        .then(({ data }) => setYeCustomerOptions((data || []).map((r) => ({ id: r.id, name: r.farm_name }))))
        ; // non-critical: customer dropdown stays empty on error
    }
  }, [category, yeCustomerOptions.length]);

  const handleYeGenerate = async (season: number, options: YearEndSummaryOptions) => {
    setYeLoading(true);
    try {
      if (yeBatchMode) {
        // Batch: get all customers with invoices for this season
        const { data: custIds, error: custErr } = await supabase
          .from('invoices')
          .select('customer_id')
          .eq('season', season)
          .in('status', ['posted', 'voided'])
          .is('deleted_at', null);
        if (custErr) throw custErr;

        const uniqueIds = [...new Set((custIds || []).map((r) => r.customer_id))];
        if (uniqueIds.length === 0) {
          toast('info', `No customers have invoices for season ${season}`);
          setYeLoading(false);
          return;
        }

        toast('info', `Generating ${uniqueIds.length} summary PDF(s)...`);
        // Batch RPC: single call replaces N individual calls
        const { data: batchResult, error: batchError } = await supabase.rpc('get_batch_year_end_summaries', {
          p_customer_ids: uniqueIds,
          p_season: season,
        });
        if (batchError) {
          toast('error', 'Failed to generate summaries: ' + batchError.message);
          setYeLoading(false);
          return;
        }
        const summaries = assertRpcResult<YearEndSummaryData[]>(batchResult, 'get_batch_year_end_summaries');
        await downloadBatchYearEndSummaries(summaries, options);
        toast('success', `Generated ${summaries.length} season summary PDF(s)`);
      } else {
        // Single customer
        if (!yeSelectedCustomer) { toast('error', 'Select a customer'); setYeLoading(false); return; }
        const { data, error } = await supabase.rpc('get_customer_year_end_summary', {
          p_customer_id: yeSelectedCustomer,
          p_season: season,
        });
        if (error) throw error;
        await downloadYearEndSummaryPdf(assertRpcResult<YearEndSummaryData>(data, 'get_customer_year_end_summary'), options);
        toast('success', `Season ${season} summary generated`);
      }
      setShowYeDialog(false);
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'generate_year_end_summary' } });
      toast('error', err instanceof Error ? err.message : 'Failed to generate summary');
    }
    setYeLoading(false);
  };

  // ─── Commission mark-paid (original) ────────────────────────
  const handleMarkPaid = async () => {
    if (selectedCommissions.size === 0) { toast('error', 'Select at least one commission'); return; }
    // Only pending commissions can be marked paid
    const selected = commissionData.filter((c) => selectedCommissions.has(c.id));
    const nonPending = selected.filter((c) => c.status !== 'pending');
    if (nonPending.length > 0) {
      toast('error', `${nonPending.length} selected commission(s) are not in 'pending' status — only pending commissions can be marked paid`);
      return;
    }
    setMarkingPaid(true);
    const today = localToday();
    try {
      // Group by recipient — RPC requires all commissions per call belong to same recipient
      const byRecipient = new Map<string, string[]>();
      for (const c of selected) {
        const rid = (c as Record<string, unknown>).recipient_user_id as string;
        if (!byRecipient.has(rid)) byRecipient.set(rid, []);
        byRecipient.get(rid)!.push(c.id);
      }

      let totalPaid = 0;
      for (const [, ids] of byRecipient) {
        const { data, error } = await supabase.rpc('create_commission_payment', {
          p_commission_ids: ids,
          p_payment_method: 'other',
          p_reference: null,
          p_payment_date: today,
          p_notes: 'Quick pay from Reports page',
          p_performed_by: profile!.id,
          // Deterministic key (no Date.now()) so a retried batch dedupes instead of
          // creating duplicate commission payments. These commission ids transition
          // to 'paid' on success, so the key can't collide with a future payment.
          p_idempotency_key: `reports-commission-pay-${ids.join('-')}`,
        });
        if (error) throw new Error(error.message);
        assertRpcResult<string>(data, 'create_commission_payment');
        totalPaid += ids.length;
      }

      toast('success', `${totalPaid} commission(s) marked as paid (${byRecipient.size} payment${byRecipient.size > 1 ? 's' : ''} created)`);
      if (profile) logActivity({ event: 'commissions_paid', description: `${totalPaid} commission(s) marked as paid via Reports`, performedBy: profile.id });
      fetchCommissions();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'mark_commissions_paid' } });
      toast('error', err instanceof Error ? err.message : 'Failed to update commissions');
    }
    setMarkingPaid(false);
  };

  const toggleCommissionSelect = (id: string) => {
    setSelectedCommissions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  const toggleSelectAll = () => {
    const pendingIds = commissionData.filter((c) => c.status === 'pending').map((c) => c.id);
    setSelectedCommissions(selectedCommissions.size === pendingIds.length && pendingIds.length > 0 ? new Set() : new Set(pendingIds));
  };

  // ─── Date preset helper ─────────────────────────────────────
  const applyPreset = (preset: string) => {
    if (preset === 'all') { setStartDate(''); setEndDate(''); }
    else { const { start, end } = getPresetDates(preset); setStartDate(start); setEndDate(end); }
  };

  // ─── Formatting ─────────────────────────────────────────────
  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

  // ─── CSV export (profitability) ─────────────────────────────
  const handleProfitCSV = () => {
    if (profitTab === 'customer') {
      exportToCSV(customerData, [
        { key: 'farm_name', header: 'Customer' },
        { key: 'total_revenue', header: 'Revenue', format: fmtCSV },
        { key: 'total_profit', header: 'Profit', format: fmtCSV },
        { key: 'margin_pct', header: 'Margin %', format: (v) => `${Number(v).toFixed(1)}%` },
        { key: 'order_count', header: 'Orders' },
      ], 'customer_profitability');
    } else if (profitTab === 'product') {
      exportToCSV(productData, [
        { key: 'product_name', header: 'Product' },
        { key: 'total_revenue', header: 'Revenue', format: fmtCSV },
        { key: 'total_profit', header: 'Profit', format: fmtCSV },
        { key: 'units_sold', header: 'Units Sold' },
        { key: 'margin_pct', header: 'Margin %', format: (v) => `${Number(v).toFixed(1)}%` },
      ], 'product_profitability');
    } else if (profitTab === 'commission') {
      exportToCSV(commissionData, [
        { key: 'order_date', header: 'Date', format: fmtDateCSV },
        { key: 'recipient', header: 'Recipient' },
        { key: 'commission_amount', header: 'Commission', format: fmtCSV },
        { key: 'split_percentage', header: 'Split %', format: (v) => `${v}%` },
        { key: 'order_profit', header: 'Order Profit', format: fmtCSV },
        { key: 'status', header: 'Status' },
        { key: 'paid_date', header: 'Paid Date', format: fmtDateCSV },
      ], 'commissions');
    } else if (profitTab === 'revenue') {
      exportToCSV(revenueData, [
        { key: 'month', header: 'Month' },
        { key: 'revenue', header: 'Revenue', format: fmtCSV },
        { key: 'profit', header: 'Profit', format: fmtCSV },
        { key: 'orders', header: 'Orders' },
      ], 'revenue_summary');
    }
    toast('success', 'Report exported');
  };

  // ─── Generic CSV/PDF export for financial/operational ───────
  const handleFinancialCSV = () => {
    if (financialTab === 'pnl') {
      exportToCSV(pnlData as unknown as Record<string, unknown>[], [
        { key: 'line_item', header: 'Line Item' },
        { key: 'amount', header: 'Amount', format: fmtCSV },
        { key: 'pct_of_revenue', header: '% of Revenue', format: (v) => `${Number(v).toFixed(1)}%` },
      ], 'bottom_line_pnl');
    } else if (financialTab === 'gross_sales') {
      exportToCSV(grossSalesData as unknown as Record<string, unknown>[], [
        { key: 'group_name', header: grossSalesGroupBy.charAt(0).toUpperCase() + grossSalesGroupBy.slice(1) },
        { key: 'total_revenue', header: 'Revenue', format: fmtCSV },
        { key: 'total_cost', header: 'COGS', format: fmtCSV },
        { key: 'gross_profit', header: 'Gross Profit', format: fmtCSV },
        { key: 'margin_pct', header: 'Margin %', format: (v) => `${Number(v).toFixed(1)}%` },
        { key: 'order_count', header: 'Orders' },
      ], `gross_sales_by_${grossSalesGroupBy}`);
    } else if (financialTab === 'customer_balance') {
      exportToCSV(custBalanceData as unknown as Record<string, unknown>[], [
        { key: 'farm_name', header: 'Customer' },
        { key: 'total_invoiced', header: 'Invoiced', format: fmtCSV },
        { key: 'total_paid', header: 'Paid', format: fmtCSV },
        { key: 'outstanding_balance', header: 'Balance', format: fmtCSV },
        { key: 'invoice_count', header: 'Invoices' },
        { key: 'oldest_unpaid_date', header: 'Oldest Unpaid', format: fmtDateCSV },
      ], 'customer_balance_listing');
    } else if (financialTab === 'commission_balance') {
      exportToCSV(commBalanceData as unknown as Record<string, unknown>[], [
        { key: 'recipient_name', header: 'Salesperson' },
        { key: 'total_earned', header: 'Earned', format: fmtCSV },
        { key: 'total_paid', header: 'Paid', format: fmtCSV },
        { key: 'outstanding_balance', header: 'Outstanding', format: fmtCSV },
        { key: 'pending_count', header: 'Pending' },
        { key: 'paid_count', header: 'Paid Count' },
      ], 'commission_balance');
    }
    toast('success', 'Report exported');
  };

  const handleOperationalCSV = () => {
    if (operationalTab === 'chemical_history') {
      exportToCSV(chemHistoryData as unknown as Record<string, unknown>[], [
        { key: 'transaction_date', header: 'Date', format: fmtDateCSV },
        { key: 'transaction_type', header: 'Type' },
        { key: 'reference_number', header: 'Reference' },
        { key: 'customer_name', header: 'Customer/Vendor' },
        { key: 'quantity', header: 'Qty' },
        { key: 'unit', header: 'Unit' },
        { key: 'unit_price', header: 'Price', format: fmtCSV },
        { key: 'total_amount', header: 'Total', format: fmtCSV },
      ], 'chemical_history');
    } else if (operationalTab === 'inventory_cost') {
      exportToCSV(inventoryCostData as unknown as Record<string, unknown>[], [
        { key: 'product_name', header: 'Product' },
        { key: 'sku', header: 'SKU' },
        { key: 'category', header: 'Category' },
        { key: 'quantity_available', header: 'Qty Available' },
        { key: 'unit_cost', header: 'Unit Cost', format: fmtCSV },
        { key: 'total_cost_value', header: 'Total Value', format: fmtCSV },
        { key: 'below_reorder', header: 'Below Reorder', format: (v) => v ? 'Yes' : 'No' },
      ], 'inventory_cost');
    } else if (operationalTab === 'price_list') {
      exportToCSV(priceListData, [
        { key: 'product_name', header: 'Product' },
        { key: 'sku', header: 'SKU' },
        { key: 'category', header: 'Category' },
        { key: 'vendor', header: 'Vendor' },
        { key: 'current_cost', header: 'Cost', format: fmtCSV },
        { key: 'tier1_price', header: 'Tier 1', format: fmtCSV },
        { key: 'tier2_price', header: 'Tier 2', format: fmtCSV },
        { key: 'tier3_price', header: 'Tier 3', format: fmtCSV },
      ], 'price_list');
    }
    toast('success', 'Report exported');
  };

  // ─── Column definitions ─────────────────────────────────────
  const customerCols: Column<CustomerProfit>[] = [
    { key: 'farm_name', header: 'Customer', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.farm_name}</span> },
    { key: 'total_revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_revenue)}</span> },
    { key: 'total_profit', header: 'Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.total_profit)}</span> },
    { key: 'margin_pct', header: 'Margin', sortable: true, render: (r) => `${r.margin_pct.toFixed(1)}%` },
    { key: 'order_count', header: 'Orders', sortable: true },
  ];

  const productCols: Column<ProductProfit>[] = [
    { key: 'product_name', header: 'Product', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.product_name}</span> },
    { key: 'total_revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_revenue)}</span> },
    { key: 'total_profit', header: 'Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.total_profit)}</span> },
    { key: 'units_sold', header: 'Units Sold', sortable: true },
    { key: 'margin_pct', header: 'Margin', sortable: true, render: (r) => `${r.margin_pct.toFixed(1)}%` },
  ];

  const commissionCols: Column<CommissionRow>[] = [
    ...(isAdmin ? [{
      key: '_select' as keyof CommissionRow,
      header: (
        <input type="checkbox" checked={selectedCommissions.size > 0 && selectedCommissions.size === commissionData.filter((c) => c.status === 'pending').length} onChange={toggleSelectAll} aria-label="Select all pending commissions" className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green" />
      ) as unknown as string,
      render: (r: CommissionRow) => r.status === 'pending' ? (
        <input type="checkbox" checked={selectedCommissions.has(r.id)} onChange={() => toggleCommissionSelect(r.id)} aria-label={`Select commission for ${r.recipient}`} className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green" />
      ) : null,
    } as Column<CommissionRow>] : []),
    { key: 'order_date', header: 'Date', sortable: true, render: (r) => parseLocalDate(r.order_date).toLocaleDateString() },
    { key: 'recipient', header: 'Recipient', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.recipient}</span> },
    { key: 'commission_amount', header: 'Commission', sortable: true, render: (r) => <span className="font-mono font-medium">{fmt(r.commission_amount)}</span> },
    { key: 'split_percentage', header: 'Split %', sortable: true, render: (r) => `${r.split_percentage}%` },
    { key: 'order_profit', header: 'Order Profit', sortable: true, render: (r) => <span className="font-mono">{fmt(r.order_profit)}</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge variant={statusToBadgeVariant[r.status] || 'default'}>{r.status}</Badge> },
    { key: 'paid_date', header: 'Paid', sortable: true, render: (r) => r.paid_date ? parseLocalDate(r.paid_date).toLocaleDateString() : '-' },
  ];

  const revenueCols: Column<RevenueSummary>[] = [
    { key: 'month', header: 'Month', sortable: true },
    { key: 'revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.revenue)}</span> },
    { key: 'profit', header: 'Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.profit)}</span> },
    { key: 'orders', header: 'Orders', sortable: true },
  ];

  const pnlCols: Column<PnLRow>[] = [
    { key: 'line_item', header: 'Line Item', render: (r) => <span className={r.line_item === 'Net Profit' || r.line_item === 'Revenue' ? 'font-bold text-nav-dark' : ''}>{r.line_item}</span> },
    { key: 'amount', header: 'Amount', render: (r) => <span className={`font-mono ${r.line_item === 'Net Profit' ? 'text-crx-green font-bold text-lg' : ''}`}>{fmt(r.amount)}</span> },
    { key: 'pct_of_revenue', header: '% of Revenue', render: (r) => `${r.pct_of_revenue.toFixed(1)}%` },
  ];

  const grossSalesCols: Column<GrossSalesRow>[] = [
    { key: 'group_name', header: grossSalesGroupBy.charAt(0).toUpperCase() + grossSalesGroupBy.slice(1), sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.group_name}</span> },
    { key: 'total_revenue', header: 'Revenue', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_revenue)}</span> },
    { key: 'total_cost', header: 'COGS', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_cost)}</span> },
    { key: 'gross_profit', header: 'Gross Profit', sortable: true, render: (r) => <span className="font-mono text-crx-green">{fmt(r.gross_profit)}</span> },
    { key: 'margin_pct', header: 'Margin', sortable: true, render: (r) => `${r.margin_pct.toFixed(1)}%` },
    { key: 'order_count', header: 'Orders', sortable: true },
  ];

  const custBalanceCols: Column<CustomerBalanceRow>[] = [
    { key: 'farm_name', header: 'Customer', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.farm_name}</span> },
    { key: 'total_invoiced', header: 'Invoiced', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_invoiced)}</span> },
    { key: 'total_paid', header: 'Paid', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_paid)}</span> },
    { key: 'outstanding_balance', header: 'Balance', sortable: true, render: (r) => <span className={`font-mono font-bold ${r.outstanding_balance > 0 ? 'text-red-600' : 'text-crx-green'}`}>{fmt(r.outstanding_balance)}</span> },
    { key: 'invoice_count', header: 'Invoices', sortable: true },
    { key: 'oldest_unpaid_date', header: 'Oldest Unpaid', sortable: true, render: (r) => r.oldest_unpaid_date ? new Date(r.oldest_unpaid_date + 'T00:00:00').toLocaleDateString() : '-' },
  ];

  const commBalanceCols: Column<CommissionBalanceRow>[] = [
    { key: 'recipient_name', header: 'Salesperson', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.recipient_name}</span> },
    { key: 'total_earned', header: 'Total Earned', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_earned)}</span> },
    { key: 'total_paid', header: 'Total Paid', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_paid)}</span> },
    { key: 'outstanding_balance', header: 'Outstanding', sortable: true, render: (r) => <span className={`font-mono font-bold ${r.outstanding_balance > 0 ? 'text-amber-600' : 'text-crx-green'}`}>{fmt(r.outstanding_balance)}</span> },
    { key: 'pending_count', header: 'Pending', sortable: true },
    { key: 'paid_count', header: 'Paid', sortable: true },
  ];

  const chemHistoryCols: Column<ChemicalHistoryRow>[] = [
    { key: 'transaction_date', header: 'Date', sortable: true, render: (r) => new Date(r.transaction_date + 'T00:00:00').toLocaleDateString() },
    { key: 'transaction_type', header: 'Type', render: (r) => <Badge variant={r.transaction_type === 'Sale' ? 'success' : 'info'}>{r.transaction_type}</Badge> },
    { key: 'reference_number', header: 'Reference', render: (r) => <span className="font-medium text-nav-dark">{r.reference_number}</span> },
    { key: 'customer_name', header: 'Customer/Vendor', sortable: true },
    { key: 'quantity', header: 'Qty', sortable: true, render: (r) => `${r.quantity} ${r.unit || ''}` },
    { key: 'unit_price', header: 'Unit Price', render: (r) => <span className="font-mono">{fmt(r.unit_price)}</span> },
    { key: 'total_amount', header: 'Total', sortable: true, render: (r) => <span className="font-mono">{fmt(r.total_amount)}</span> },
  ];

  const inventoryCostCols: Column<InventoryCostRow>[] = [
    { key: 'product_name', header: 'Product', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.product_name}</span> },
    { key: 'sku', header: 'SKU' },
    { key: 'category', header: 'Category', sortable: true },
    { key: 'quantity_available', header: 'Qty', sortable: true },
    { key: 'net_available', header: 'Net Available', sortable: true, render: (r) => <span className="font-mono">{r.net_available}</span> },
    { key: 'unit_cost', header: 'Unit Cost', render: (r) => <span className="font-mono">{fmt(r.unit_cost)}</span> },
    { key: 'total_cost_value', header: 'Total Value', sortable: true, render: (r) => <span className="font-mono font-medium">{fmt(r.total_cost_value)}</span> },
    { key: 'below_reorder', header: 'Status', render: (r) => r.below_reorder ? <Badge variant="error">Low Stock</Badge> : <Badge variant="success">OK</Badge> },
  ];

  const priceListCols: Column<Record<string, unknown>>[] = [
    { key: 'product_name', header: 'Product', sortable: true, render: (r) => <span className="font-medium text-nav-dark">{r.product_name as string}</span> },
    { key: 'sku', header: 'SKU' },
    { key: 'category', header: 'Category', sortable: true },
    { key: 'vendor', header: 'Vendor', sortable: true },
    { key: 'current_cost', header: 'Cost', render: (r) => <span className="font-mono">{r.current_cost != null ? fmt(r.current_cost as number) : '-'}</span> },
    { key: 'tier1_price', header: 'Tier 1', render: (r) => <span className="font-mono">{r.tier1_price != null ? fmt(r.tier1_price as number) : '-'}</span> },
    { key: 'tier2_price', header: 'Tier 2', render: (r) => <span className="font-mono">{r.tier2_price != null ? fmt(r.tier2_price as number) : '-'}</span> },
    { key: 'tier3_price', header: 'Tier 3', render: (r) => <span className="font-mono">{r.tier3_price != null ? fmt(r.tier3_price as number) : '-'}</span> },
  ];

  const postedAppsCols: Column<Record<string, unknown>>[] = [
    { key: 'application_date', header: 'Date', sortable: true, render: (r) => new Date((r.application_date as string) + 'T00:00:00').toLocaleDateString() },
    { key: 'record_number', header: 'Record #', render: (r) => <span className="font-medium text-nav-dark">{r.record_number as string}</span> },
    { key: 'customer_name', header: 'Customer', sortable: true },
    { key: 'field_name', header: 'Field' },
    { key: 'applicator_name', header: 'Applicator' },
    { key: 'total_acres', header: 'Acres', sortable: true },
    { key: 'season', header: 'Season' },
  ];

  // Unpaid commission total
  const unpaidTotal = commissionData.filter((c) => c.status === 'pending').reduce((sum, c) => sum + c.commission_amount, 0);

  const categories: { key: Category; label: string }[] = [
    { key: 'profitability', label: 'Profitability' },
    { key: 'logbook', label: 'Application Logbook' },
    { key: 'financial', label: 'Financial' },
    { key: 'operational', label: 'Operational' },
    { key: 'year_end', label: 'Year-End Summaries' },
  ];

  const profitTabs: { key: ProfitTab; label: string }[] = [
    { key: 'customer', label: 'By Customer' },
    { key: 'product', label: 'By Product' },
    { key: 'commission', label: 'Commissions' },
    { key: 'revenue', label: 'Revenue Summary' },
  ];

  const financialTabs: { key: FinancialTab; label: string }[] = [
    { key: 'pnl', label: 'P&L' },
    { key: 'gross_sales', label: 'Gross Sales' },
    { key: 'customer_balance', label: 'Customer Balance' },
    { key: 'commission_balance', label: 'Commission Balance' },
  ];

  const operationalTabs: { key: OperationalTab; label: string }[] = [
    { key: 'inventory_cost', label: 'Inventory Cost' },
    { key: 'chemical_history', label: 'Chemical History' },
    { key: 'posted_applications', label: 'Posted Applications' },
    { key: 'price_list', label: 'Price List' },
  ];

  // ─── Date filter bar (shared across profitability/financial/operational)
  const dateFilterBar = (onCSV: () => void) => (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-secondary mb-1">Start Date</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green" />
        </div>
        <div>
          <label className="block text-xs font-medium text-secondary mb-1">End Date</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green" />
        </div>
        <div className="flex gap-1.5">
          {[
            { key: 'all', label: 'All Time' },
            { key: 'this_season', label: 'This Season' },
            { key: 'last_season', label: 'Last Season' },
            { key: 'ytd', label: 'YTD' },
            { key: 'last30', label: 'Last 30d' },
            { key: 'last90', label: 'Last 90d' },
          ].map((p) => (
            <button key={p.key} onClick={() => applyPreset(p.key)} className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 hover:bg-crx-green-tint hover:border-crx-green hover:text-crx-green transition-colors">
              {p.label}
            </button>
          ))}
        </div>

        {/* Gross sales group-by selector */}
        {category === 'financial' && financialTab === 'gross_sales' && (
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Group By</label>
            <select value={grossSalesGroupBy} onChange={(e) => setGrossSalesGroupBy(e.target.value as 'product' | 'customer' | 'salesman')} aria-label="Group by" className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green">
              <option value="product">Product</option>
              <option value="customer">Customer</option>
              <option value="salesman">Salesman</option>
            </select>
          </div>
        )}

        {/* Chemical history product selector */}
        {category === 'operational' && operationalTab === 'chemical_history' && (
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Product</label>
            <select value={chemProductId} onChange={(e) => setChemProductId(e.target.value)} aria-label="Select product" className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green min-w-[200px]">
              <option value="">— Select Product —</option>
              {productOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="ml-auto">
          <Button variant="secondary" size="sm" icon={<Download className="w-4 h-4" />} showChevron={false} onClick={onCSV}>
            Export CSV
          </Button>
        </div>
      </div>
    </Card>
  );

  return (
    <div className="space-y-6">
      <SplitHeading title="Reports" accent="& Analytics" />

      {/* Category selector */}
      <div className="flex gap-2 flex-wrap">
        {categories.map((c) => (
          <button
            key={c.key}
            onClick={() => setCategory(c.key)}
            className={`px-5 py-2.5 text-sm font-semibold rounded-lg transition-colors border ${
              category === c.key
                ? 'bg-crx-green text-white border-crx-green'
                : 'bg-white text-secondary border-gray-200 hover:border-crx-green hover:text-crx-green'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* ═══ PROFITABILITY ═══ */}
      {category === 'profitability' && (
        <>
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
            {profitTabs.map((t) => (
              <button key={t.key} onClick={() => setProfitTab(t.key)} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${profitTab === t.key ? 'bg-white text-nav-dark shadow-sm' : 'text-secondary hover:text-nav-dark'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {dateFilterBar(handleProfitCSV)}

          {profitTab === 'commission' && (
            <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <div className="flex items-center gap-4">
                <span className="text-sm text-amber-800"><span className="font-semibold">Unpaid commissions:</span> {fmt(unpaidTotal)}</span>
                {selectedCommissions.size > 0 && <span className="text-sm text-secondary">{selectedCommissions.size} selected</span>}
              </div>
              {isAdmin && selectedCommissions.size > 0 && (
                <Button size="sm" icon={<CheckCircle2 className="w-4 h-4" />} onClick={handleMarkPaid} loading={markingPaid}>Mark as Paid</Button>
              )}
            </div>
          )}

          <Card padding={false}>
            <div className="p-5">
              {profitTab === 'customer' && <DataTable data={customerData as unknown as Record<string, unknown>[]} columns={customerCols as unknown as Column<Record<string, unknown>>[]} searchable searchPlaceholder="Search customers..." searchKeys={['farm_name']} emptyTitle="No customer data" loading={loading} />}
              {profitTab === 'product' && <DataTable data={productData as unknown as Record<string, unknown>[]} columns={productCols as unknown as Column<Record<string, unknown>>[]} searchable searchPlaceholder="Search products..." searchKeys={['product_name']} emptyTitle="No product data" loading={loading} />}
              {profitTab === 'commission' && <DataTable data={commissionData as unknown as Record<string, unknown>[]} columns={commissionCols as unknown as Column<Record<string, unknown>>[]} emptyTitle="No commissions" loading={loading} />}
              {profitTab === 'revenue' && <DataTable data={revenueData as unknown as Record<string, unknown>[]} columns={revenueCols as unknown as Column<Record<string, unknown>>[]} emptyTitle="No revenue data" loading={loading} />}
            </div>
          </Card>
        </>
      )}

      {/* ═══ LOGBOOK ═══ */}
      {category === 'logbook' && <LogbookReport />}

      {/* ═══ FINANCIAL ═══ */}
      {category === 'financial' && (
        <>
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
            {financialTabs.map((t) => (
              <button key={t.key} onClick={() => setFinancialTab(t.key)} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${financialTab === t.key ? 'bg-white text-nav-dark shadow-sm' : 'text-secondary hover:text-nav-dark'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {dateFilterBar(handleFinancialCSV)}

          {/* P&L summary cards */}
          {financialTab === 'pnl' && pnlData.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              {pnlData.map((row) => (
                <Card key={row.line_item}>
                  <div className="text-center">
                    <p className="text-xs text-secondary mb-1">{row.line_item}</p>
                    <p className={`text-lg font-bold font-mono ${row.line_item === 'Net Profit' ? 'text-crx-green' : 'text-nav-dark'}`}>{fmt(row.amount)}</p>
                    <p className="text-xs text-secondary">{row.pct_of_revenue.toFixed(1)}% of revenue</p>
                  </div>
                </Card>
              ))}
            </div>
          )}

          <Card padding={false}>
            <div className="p-5">
              {financialTab === 'pnl' && <DataTable data={pnlData as unknown as Record<string, unknown>[]} columns={pnlCols as unknown as Column<Record<string, unknown>>[]} emptyTitle="No P&L data" emptyDescription="Select a date range to generate P&L" loading={loading} />}
              {financialTab === 'gross_sales' && <DataTable data={grossSalesData as unknown as Record<string, unknown>[]} columns={grossSalesCols as unknown as Column<Record<string, unknown>>[]} searchable searchKeys={['group_name']} emptyTitle="No gross sales data" emptyDescription="Select a date range" loading={loading} />}
              {financialTab === 'customer_balance' && <DataTable data={custBalanceData as unknown as Record<string, unknown>[]} columns={custBalanceCols as unknown as Column<Record<string, unknown>>[]} searchable searchKeys={['farm_name']} emptyTitle="No outstanding balances" loading={loading} />}
              {financialTab === 'commission_balance' && <DataTable data={commBalanceData as unknown as Record<string, unknown>[]} columns={commBalanceCols as unknown as Column<Record<string, unknown>>[]} searchable searchKeys={['recipient_name']} emptyTitle="No commission data" loading={loading} />}
            </div>
          </Card>
        </>
      )}

      {/* ═══ OPERATIONAL ═══ */}
      {category === 'operational' && (
        <>
          <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
            {operationalTabs.map((t) => (
              <button key={t.key} onClick={() => setOperationalTab(t.key)} className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${operationalTab === t.key ? 'bg-white text-nav-dark shadow-sm' : 'text-secondary hover:text-nav-dark'}`}>
                {t.label}
              </button>
            ))}
          </div>

          {dateFilterBar(handleOperationalCSV)}

          {/* Inventory cost total */}
          {operationalTab === 'inventory_cost' && inventoryCostData.length > 0 && (
            <div className="flex items-center gap-6 bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
              <span className="text-sm text-blue-800">
                <span className="font-semibold">Total Inventory Value:</span>{' '}
                {fmt(inventoryCostData.reduce((sum, r) => sum + r.total_cost_value, 0))}
              </span>
              <span className="text-sm text-blue-800">
                <span className="font-semibold">Products:</span> {inventoryCostData.length}
              </span>
              <span className="text-sm text-red-600">
                <span className="font-semibold">Below Reorder:</span> {inventoryCostData.filter((r) => r.below_reorder).length}
              </span>
            </div>
          )}

          <Card padding={false}>
            <div className="p-5">
              {operationalTab === 'inventory_cost' && <DataTable data={inventoryCostData as unknown as Record<string, unknown>[]} columns={inventoryCostCols as unknown as Column<Record<string, unknown>>[]} searchable searchPlaceholder="Search products..." searchKeys={['product_name', 'sku', 'category']} emptyTitle="No inventory data" loading={loading} />}
              {operationalTab === 'chemical_history' && <DataTable data={chemHistoryData as unknown as Record<string, unknown>[]} columns={chemHistoryCols as unknown as Column<Record<string, unknown>>[]} emptyTitle="No chemical history" emptyDescription="Select a product and date range" loading={loading} />}
              {operationalTab === 'posted_applications' && <DataTable data={postedAppsData} columns={postedAppsCols} searchable searchKeys={['customer_name', 'record_number']} emptyTitle="No posted applications" loading={loading} />}
              {operationalTab === 'price_list' && <DataTable data={priceListData} columns={priceListCols} searchable searchPlaceholder="Search products..." searchKeys={['product_name', 'sku', 'vendor']} emptyTitle="No products" loading={loading} />}
            </div>
          </Card>
        </>
      )}

      {/* ═══ YEAR-END SUMMARIES ═══ */}
      {category === 'year_end' && (
        <>
          <Card>
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-nav-dark mb-1">Year-End Customer Summaries</h3>
                <p className="text-xs text-secondary">
                  Generate comprehensive season summary PDFs with financials, product usage, acreage, invoice history, and year-over-year comparisons.
                </p>
              </div>

              <div className="flex flex-wrap items-end gap-4">
                <div className="flex-1 min-w-[250px]">
                  <label className="block text-xs font-medium text-secondary mb-1">Customer</label>
                  <select
                    value={yeSelectedCustomer}
                    onChange={(e) => setYeSelectedCustomer(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  >
                    <option value="">— Select Customer —</option>
                    {yeCustomerOptions.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>

                <Button
                  size="sm"
                  icon={<FileText className="w-4 h-4" />}
                  onClick={() => { setYeBatchMode(false); setShowYeDialog(true); }}
                  disabled={!yeSelectedCustomer}
                >
                  Generate Summary
                </Button>

                {isAdmin && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<FileText className="w-4 h-4" />}
                    onClick={() => { setYeBatchMode(true); setShowYeDialog(true); }}
                  >
                    Generate All
                  </Button>
                )}
              </div>
            </div>
          </Card>
        </>
      )}

      {/* Year-End Summary Dialog */}
      <YearEndSummaryDialog
        open={showYeDialog}
        onClose={() => setShowYeDialog(false)}
        onGenerate={handleYeGenerate}
        loading={yeLoading}
        customerName={yeBatchMode ? undefined : yeCustomerOptions.find((c) => c.id === yeSelectedCustomer)?.name}
        batchMode={yeBatchMode}
      />
    </div>
  );
}
