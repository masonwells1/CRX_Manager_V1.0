/**
 * Compliance.tsx — Applicator License, RUP Product & RUP Sales Tracking
 *
 * Manages applicator licenses for customers (expiry tracking, alerts),
 * provides a view of RUP products, and a RUP Sales Register for
 * state regulatory compliance (FIFRA).
 */
import { useEffect, useState, useCallback } from 'react';
import { Plus, AlertTriangle, Award, Package, FileText, Download } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge, { type BadgeVariant } from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import { exportToCSV, fmtCSV } from '../lib/csvExport';
import { localToday, localDatePlusDays, parseLocalDate } from '../lib/dateUtils';
import type { ApplicatorLicense, RUPSalesRecord } from '../types';

type TabKey = 'licenses' | 'rup_products' | 'rup_sales';

interface LicenseWithCustomer extends ApplicatorLicense {
  [k: string]: unknown;
  farm_name: string;
}

interface RUPProduct {
  [k: string]: unknown;
  id: string;
  product_name: string;
  sku: string | null;
  vendor: string | null;
  manufacturer: string | null;
  epa_registration: string | null;
  signal_word: string | null;
  is_active: boolean;
}

export default function Compliance() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const [tab, setTab] = useState<TabKey>('licenses');
  const [loading, setLoading] = useState(true);

  // Licenses
  const [licenses, setLicenses] = useState<LicenseWithCustomer[]>([]);
  const [licenseFilter, setLicenseFilter] = useState<'all' | 'active' | 'expiring' | 'expired'>('all');

  // RUP Products
  const [rupProducts, setRUPProducts] = useState<RUPProduct[]>([]);

  // RUP Sales Register
  const [rupSales, setRUPSales] = useState<RUPSalesRecord[]>([]);
  const [rupStartDate, setRUPStartDate] = useState(() => {
    // Default: current season start (Oct 1 of previous year or current year)
    const now = new Date();
    const seasonYear = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
    return `${seasonYear}-10-01`;
  });
  const [rupEndDate, setRUPEndDate] = useState(localToday());
  const [rupComplianceFilter, setRUPComplianceFilter] = useState('');

  // Customers for dropdowns
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);

  // Add/Edit license modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({
    customer_id: '',
    license_number: '',
    license_type: 'private' as 'private' | 'commercial' | 'public',
    holder_name: '',
    state: 'IL',
    issued_date: '',
    expiry_date: '',
    certification_categories: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);

  const fetchLicenses = useCallback(async () => {
    const { data, error } = await supabase
      .from('applicator_licenses')
      .select('*, customer:customers(farm_name)')
      .order('expiry_date', { ascending: true });

    if (error) {
      toast('error', 'Failed to load licenses');
      Sentry.captureException(error);
      return;
    }

    const mapped = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name?: string } }>).map((l) => ({
      ...l,
      farm_name: l.customer?.farm_name || 'Unknown',
    })) as unknown as LicenseWithCustomer[];
    setLicenses(mapped);
  }, [toast]);

  const fetchCustomers = useCallback(async () => {
    const { data, error } = await supabase.from('customers').select('id, farm_name').order('farm_name');
    if (error) toast('error', 'Failed to load customers');
    setCustomers(data || []);
  }, [toast]);

  const fetchRUPProducts = useCallback(async () => {
    const { data, error } = await supabase
      .from('products')
      .select('id, product_name, sku, vendor, manufacturer, epa_registration, signal_word, is_active')
      .eq('is_rup', true)
      .order('product_name');

    if (error) {
      toast('error', 'Failed to load RUP products');
      Sentry.captureException(error);
      return;
    }
    setRUPProducts((data || []) as RUPProduct[]);
  }, [toast]);

  const fetchRUPSales = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_rup_sales_register', {
      p_start_date: rupStartDate,
      p_end_date: rupEndDate,
      p_compliance_status: rupComplianceFilter || null,
    });

    if (error) {
      toast('error', 'Failed to load RUP sales register');
      Sentry.captureException(error);
      return;
    }
    setRUPSales((data || []) as RUPSalesRecord[]);
  }, [rupStartDate, rupEndDate, rupComplianceFilter, toast]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    if (tab === 'licenses') {
      await Promise.all([fetchLicenses(), fetchCustomers()]);
    } else if (tab === 'rup_products') {
      await fetchRUPProducts();
    } else if (tab === 'rup_sales') {
      await fetchRUPSales();
    }
    setLoading(false);
  }, [tab, fetchLicenses, fetchCustomers, fetchRUPProducts, fetchRUPSales]);

  useEffect(() => {
    fetchData();
  }, [tab, fetchData]);

  const today = localToday();
  const thirtyDaysOut = localDatePlusDays(30);

  const getExpiryStatus = (date: string) => {
    if (date < today) return 'expired';
    if (date <= thirtyDaysOut) return 'expiring';
    return 'valid';
  };

  const filteredLicenses = licenses.filter((l) => {
    if (licenseFilter === 'all') return true;
    if (licenseFilter === 'active') return l.is_active && getExpiryStatus(l.expiry_date) === 'valid';
    if (licenseFilter === 'expiring') return getExpiryStatus(l.expiry_date) === 'expiring';
    if (licenseFilter === 'expired') return getExpiryStatus(l.expiry_date) === 'expired';
    return true;
  });

  const expiredCount = licenses.filter((l) => getExpiryStatus(l.expiry_date) === 'expired').length;
  const expiringCount = licenses.filter((l) => getExpiryStatus(l.expiry_date) === 'expiring').length;

  const openAdd = () => {
    setEditId(null);
    setForm({
      customer_id: '',
      license_number: '',
      license_type: 'private',
      holder_name: '',
      state: 'IL',
      issued_date: '',
      expiry_date: '',
      certification_categories: '',
      notes: '',
    });
    setModalOpen(true);
  };

  const openEdit = (lic: LicenseWithCustomer) => {
    setEditId(lic.id);
    setForm({
      customer_id: lic.customer_id,
      license_number: lic.license_number,
      license_type: lic.license_type as 'private' | 'commercial' | 'public',
      holder_name: lic.holder_name,
      state: lic.state,
      issued_date: lic.issued_date || '',
      expiry_date: lic.expiry_date,
      certification_categories: (lic.certification_categories || []).join(', '),
      notes: lic.notes || '',
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!form.customer_id || !form.license_number || !form.holder_name || !form.expiry_date) {
      toast('error', 'Fill in all required fields');
      return;
    }

    const cats = form.certification_categories
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const payload = {
      customer_id: form.customer_id,
      license_number: form.license_number,
      license_type: form.license_type,
      holder_name: form.holder_name,
      state: form.state,
      issued_date: form.issued_date || null,
      expiry_date: form.expiry_date,
      certification_categories: cats.length > 0 ? cats : null,
      notes: form.notes || null,
    };

    await runCriticalAction({
      action: async () => {
        if (editId) {
          const result = await supabase
            .from('applicator_licenses')
            .update(payload)
            .eq('id', editId)
            .select();
          checkMutationResult(result, 'Update license');
        } else {
          const result = await supabase
            .from('applicator_licenses')
            .insert(payload)
            .select();
          checkMutationResult(result, 'Create license');
          if (profile) logActivity('license_created', `Applicator license added for ${form.holder_name}`, profile.id);
        }
      },
      toast,
      setLoading: setSaving,
      successMessage: editId ? 'License updated' : 'License added',
      sentryTag: editId ? 'update_license' : 'create_license',
      onSuccess: () => {
        setModalOpen(false);
        fetchLicenses();
      },
    });
  };

  const licenseColumns: Column<LicenseWithCustomer>[] = [
    {
      key: 'holder_name',
      header: 'Holder',
      sortable: true,
      render: (r) => (
        <button onClick={() => openEdit(r)} className="font-medium text-crx-green hover:underline text-left">
          {r.holder_name}
        </button>
      ),
    },
    { key: 'farm_name', header: 'Customer', sortable: true },
    { key: 'license_number', header: 'License #', sortable: true },
    {
      key: 'license_type',
      header: 'Type',
      render: (r) => <Badge variant="default">{r.license_type}</Badge>,
    },
    { key: 'state', header: 'State' },
    {
      key: 'expiry_date',
      header: 'Expires',
      sortable: true,
      render: (r) => {
        const status = getExpiryStatus(r.expiry_date);
        return (
          <span
            className={`font-medium ${
              status === 'expired'
                ? 'text-red-600'
                : status === 'expiring'
                  ? 'text-yellow-600'
                  : 'text-crx-green'
            }`}
          >
            {parseLocalDate(r.expiry_date).toLocaleDateString()}
            {status === 'expired' && ' ⚠ EXPIRED'}
            {status === 'expiring' && ' ⚠ Expiring Soon'}
          </span>
        );
      },
    },
    {
      key: 'certification_categories',
      header: 'Certifications',
      render: (r) =>
        r.certification_categories && r.certification_categories.length > 0
          ? r.certification_categories.join(', ')
          : '-',
    },
  ];

  const rupColumns: Column<RUPProduct>[] = [
    {
      key: 'product_name',
      header: 'Product',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark">{r.product_name}</span>,
    },
    { key: 'sku', header: 'SKU', render: (r) => r.sku || '-' },
    { key: 'manufacturer', header: 'Manufacturer', render: (r) => r.manufacturer || r.vendor || '-' },
    { key: 'epa_registration', header: 'EPA Reg #', render: (r) => r.epa_registration || '-' },
    {
      key: 'signal_word',
      header: 'Signal Word',
      render: (r) =>
        r.signal_word ? (
          <Badge
            variant={
              r.signal_word === 'Danger' ? 'error' : r.signal_word === 'Warning' ? 'warning' : 'default'
            }
          >
            {r.signal_word}
          </Badge>
        ) : (
          '-'
        ),
    },
    {
      key: 'is_active',
      header: 'Status',
      render: (r) => <Badge variant={r.is_active ? 'success' : 'default'}>{r.is_active ? 'Active' : 'Inactive'}</Badge>,
    },
  ];

  const complianceVariant: Record<string, BadgeVariant> = {
    compliant: 'success',
    warning: 'warning',
    non_compliant: 'error',
  };

  const fmtCurrency = (cents: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

  const rupSalesColumns: Column<RUPSalesRecord>[] = [
    {
      key: 'sale_date',
      header: 'Date',
      sortable: true,
      render: (r) => parseLocalDate(r.sale_date).toLocaleDateString(),
    },
    {
      key: 'buyer_name',
      header: 'Buyer',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark">{r.buyer_name}</span>,
    },
    {
      key: 'product_name',
      header: 'Product',
      sortable: true,
    },
    {
      key: 'epa_registration',
      header: 'EPA Reg #',
      render: (r) => r.epa_registration || '-',
    },
    {
      key: 'quantity',
      header: 'Qty',
      render: (r) => <span className="font-mono">{r.quantity} {r.unit}</span>,
    },
    {
      key: 'total_cents',
      header: 'Total',
      sortable: true,
      render: (r) => <span className="font-mono text-sm">{fmtCurrency(r.total_cents ?? 0)}</span>,
    },
    {
      key: 'buyer_certification_number',
      header: 'Cert #',
      render: (r) => r.buyer_certification_number || <span className="text-red-500 text-xs">Missing</span>,
    },
    {
      key: 'buyer_certification_expiry',
      header: 'Cert Expiry',
      render: (r) =>
        r.buyer_certification_expiry
          ? parseLocalDate(r.buyer_certification_expiry).toLocaleDateString()
          : '-',
    },
    {
      key: 'signal_word',
      header: 'Signal',
      render: (r) =>
        r.signal_word ? (
          <Badge variant={r.signal_word === 'Danger' ? 'error' : r.signal_word === 'Warning' ? 'warning' : 'default'}>
            {r.signal_word}
          </Badge>
        ) : '-',
    },
    {
      key: 'compliance_status',
      header: 'Compliance',
      sortable: true,
      render: (r) => (
        <Badge variant={complianceVariant[r.compliance_status] || 'default'}>
          {r.compliance_status.replace(/_/g, ' ')}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold font-heading text-nav-dark">Compliance</h2>
        {tab === 'licenses' && (
          <Button icon={<Plus className="w-4 h-4" />} onClick={openAdd}>
            Add License
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        <button
          onClick={() => setTab('licenses')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
            tab === 'licenses' ? 'bg-white text-nav-dark shadow-sm' : 'text-secondary hover:text-nav-dark'
          }`}
        >
          <Award className="w-4 h-4" /> Applicator Licenses
        </button>
        <button
          onClick={() => setTab('rup_products')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
            tab === 'rup_products' ? 'bg-white text-nav-dark shadow-sm' : 'text-secondary hover:text-nav-dark'
          }`}
        >
          <Package className="w-4 h-4" /> RUP Products
        </button>
        <button
          onClick={() => setTab('rup_sales')}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors flex items-center gap-2 ${
            tab === 'rup_sales' ? 'bg-white text-nav-dark shadow-sm' : 'text-secondary hover:text-nav-dark'
          }`}
        >
          <FileText className="w-4 h-4" /> RUP Sales Register
        </button>
      </div>

      {/* ========== LICENSES TAB ========== */}
      {tab === 'licenses' && (
        <>
          {/* Alert Cards */}
          {(expiredCount > 0 || expiringCount > 0) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {expiredCount > 0 && (
                <Card>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center">
                      <AlertTriangle className="w-5 h-5 text-red-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-red-600">
                        {expiredCount} Expired License{expiredCount !== 1 ? 's' : ''}
                      </p>
                      <p className="text-xs text-secondary">Immediate attention required</p>
                    </div>
                    <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setLicenseFilter('expired')}>
                      View
                    </Button>
                  </div>
                </Card>
              )}
              {expiringCount > 0 && (
                <Card>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-yellow-50 flex items-center justify-center">
                      <AlertTriangle className="w-5 h-5 text-yellow-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-yellow-600">
                        {expiringCount} License{expiringCount !== 1 ? 's' : ''} Expiring Within 30 Days
                      </p>
                      <p className="text-xs text-secondary">Renewal reminder needed</p>
                    </div>
                    <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setLicenseFilter('expiring')}>
                      View
                    </Button>
                  </div>
                </Card>
              )}
            </div>
          )}

          {/* Filter */}
          <div className="flex gap-2 flex-wrap">
            {(['all', 'active', 'expiring', 'expired'] as const).map((f) => {
              const label = f === 'all' ? 'All' : f === 'active' ? 'Valid' : f === 'expiring' ? 'Expiring Soon' : 'Overdue';
              const count = f === 'expired' ? expiredCount : f === 'expiring' ? expiringCount : undefined;
              return (
                <button
                  key={f}
                  onClick={() => setLicenseFilter(f)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors flex items-center gap-1.5 ${
                    licenseFilter === f
                      ? 'bg-crx-green text-white border-crx-green'
                      : f === 'expired' && expiredCount > 0
                        ? 'border-red-200 text-red-600 hover:border-red-400 bg-red-50'
                        : 'border-gray-200 text-secondary hover:border-crx-green hover:text-crx-green'
                  }`}
                >
                  {label}
                  {count !== undefined && count > 0 && (
                    <span className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-bold ${
                      licenseFilter === f ? 'bg-white/20 text-white' : f === 'expired' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <Card padding={false}>
            <div className="p-5">
              <DataTable<LicenseWithCustomer>
                columns={licenseColumns}
                data={filteredLicenses}
                loading={loading}
                searchable
                searchPlaceholder="Search licenses..."
                searchKeys={['holder_name', 'farm_name', 'license_number']}
                emptyTitle="No licenses found"
                emptyDescription={
                  licenseFilter !== 'all'
                    ? 'No licenses match this filter.'
                    : 'Add applicator licenses to track compliance.'
                }
              />
            </div>
          </Card>
        </>
      )}

      {/* ========== RUP PRODUCTS TAB ========== */}
      {tab === 'rup_products' && (
        <Card padding={false}>
          <div className="p-5">
            <DataTable<RUPProduct>
              columns={rupColumns}
              data={rupProducts}
              loading={loading}
              searchable
              searchPlaceholder="Search RUP products..."
              searchKeys={['product_name', 'sku', 'manufacturer', 'epa_registration']}
              emptyTitle="No RUP products"
              emptyDescription="Mark products as RUP in the product editor to track them here."
            />
          </div>
        </Card>
      )}

      {/* ========== RUP SALES REGISTER TAB ========== */}
      {tab === 'rup_sales' && (
        <>
          {/* Filters */}
          <Card>
            <div className="flex items-end gap-4 flex-wrap">
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Start Date</label>
                <input
                  type="date"
                  value={rupStartDate}
                  onChange={(e) => setRUPStartDate(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">End Date</label>
                <input
                  type="date"
                  value={rupEndDate}
                  onChange={(e) => setRUPEndDate(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-secondary mb-1">Compliance</label>
                <select
                  value={rupComplianceFilter}
                  onChange={(e) => setRUPComplianceFilter(e.target.value)}
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All</option>
                  <option value="compliant">Compliant</option>
                  <option value="warning">Warning</option>
                  <option value="non_compliant">Non-Compliant</option>
                </select>
              </div>
              <Button variant="secondary" size="sm" onClick={fetchRUPSales}>
                Refresh
              </Button>
              <div className="ml-auto">
                {rupSales.length > 0 && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Download className="w-4 h-4" />}
                    onClick={() =>
                      exportToCSV(
                        rupSales as unknown as Record<string, unknown>[],
                        [
                          { key: 'sale_date', header: 'Sale Date' },
                          { key: 'buyer_name', header: 'Buyer Name' },
                          { key: 'product_name', header: 'Product' },
                          { key: 'epa_registration', header: 'EPA Reg #' },
                          { key: 'quantity', header: 'Quantity' },
                          { key: 'unit', header: 'Unit' },
                          { key: 'total_cents', header: 'Total ($)', format: (v) => fmtCSV((v as number) / 100) },
                          { key: 'signal_word', header: 'Signal Word' },
                          { key: 'buyer_certification_number', header: 'Cert #' },
                          { key: 'buyer_certification_type', header: 'Cert Type' },
                          { key: 'buyer_certification_expiry', header: 'Cert Expiry' },
                          { key: 'compliance_status', header: 'Compliance' },
                          { key: 'compliance_notes', header: 'Notes' },
                        ],
                        'rup_sales_register'
                      )
                    }
                  >
                    Export CSV
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {/* Summary */}
          {rupSales.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Card>
                <p className="text-xs text-secondary mb-1">Total Records</p>
                <p className="text-2xl font-semibold font-heading text-nav-dark">{rupSales.length}</p>
              </Card>
              <Card>
                <p className="text-xs text-secondary mb-1">Compliant</p>
                <p className="text-2xl font-semibold font-heading text-crx-green">
                  {rupSales.filter((r) => r.compliance_status === 'compliant').length}
                </p>
              </Card>
              <Card>
                <p className="text-xs text-secondary mb-1">Warnings</p>
                <p className="text-2xl font-semibold font-heading text-yellow-600">
                  {rupSales.filter((r) => r.compliance_status === 'warning').length}
                </p>
              </Card>
              <Card>
                <p className="text-xs text-secondary mb-1">Non-Compliant</p>
                <p className="text-2xl font-semibold font-heading text-red-600">
                  {rupSales.filter((r) => r.compliance_status === 'non_compliant').length}
                </p>
              </Card>
            </div>
          )}

          {/* Data Table */}
          <Card padding={false}>
            <div className="p-5">
              <DataTable<RUPSalesRecord>
                columns={rupSalesColumns}
                data={rupSales}
                loading={loading}
                searchable
                searchPlaceholder="Search RUP sales..."
                searchKeys={['buyer_name', 'product_name', 'epa_registration', 'buyer_certification_number']}
                emptyTitle="No RUP sales records"
                emptyDescription="RUP sales records are auto-generated when invoices with RUP products are posted."
              />
            </div>
          </Card>
        </>
      )}

      {/* ========== ADD/EDIT LICENSE MODAL ========== */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editId ? 'Edit License' : 'Add Applicator License'}>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-nav-dark">Customer *</label>
            <select
              value={form.customer_id}
              onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
              className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">Select customer...</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.farm_name}
                </option>
              ))}
            </select>
          </div>

          <Input
            label="License Holder Name *"
            value={form.holder_name}
            onChange={(e) => setForm({ ...form, holder_name: e.target.value })}
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="License Number *"
              value={form.license_number}
              onChange={(e) => setForm({ ...form, license_number: e.target.value })}
            />
            <div>
              <label className="text-sm font-medium text-nav-dark">License Type</label>
              <select
                value={form.license_type}
                onChange={(e) => setForm({ ...form, license_type: e.target.value as 'private' | 'commercial' | 'public' })}
                className="mt-1 w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              >
                <option value="private">Private</option>
                <option value="commercial">Commercial</option>
                <option value="public">Public</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <Input
              label="State"
              value={form.state}
              onChange={(e) => setForm({ ...form, state: e.target.value })}
            />
            <Input
              label="Issued Date"
              type="date"
              value={form.issued_date}
              onChange={(e) => setForm({ ...form, issued_date: e.target.value })}
            />
            <Input
              label="Expiry Date *"
              type="date"
              value={form.expiry_date}
              onChange={(e) => setForm({ ...form, expiry_date: e.target.value })}
            />
          </div>

          <Input
            label="Certification Categories (comma-separated)"
            value={form.certification_categories}
            onChange={(e) => setForm({ ...form, certification_categories: e.target.value })}
            placeholder="e.g. General Standards, Field Crop, Fruit Crop"
          />

          <Input
            label="Notes"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} loading={saving}>
              {editId ? 'Save Changes' : 'Add License'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
