/**
 * Compliance.tsx — Applicator License & RUP Product Tracking
 *
 * Manages applicator licenses for customers (expiry tracking, alerts)
 * and provides a view of Restricted Use Pesticide (RUP) products.
 */
import { useEffect, useState } from 'react';
import { Plus, AlertTriangle, Award, Package } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Input from '../components/ui/Input';
import Modal from '../components/ui/Modal';
import DataTable, { type Column } from '../components/ui/DataTable';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, checkMutationResult } from '../lib/db';
import { logActivity } from '../lib/activityLogger';
import type { ApplicatorLicense } from '../types';

type TabKey = 'licenses' | 'rup_products';

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

  useEffect(() => {
    fetchData();
  }, [tab]);

  const fetchData = async () => {
    setLoading(true);
    if (tab === 'licenses') {
      await Promise.all([fetchLicenses(), fetchCustomers()]);
    } else {
      await fetchRUPProducts();
    }
    setLoading(false);
  };

  const fetchLicenses = async () => {
    const { data, error } = await supabase
      .from('applicator_licenses')
      .select('*, customer:customers(farm_name)')
      .order('expiry_date', { ascending: true });

    if (error) {
      toast('error', 'Failed to load licenses');
      console.error(error.message);
      return;
    }

    const mapped = ((data || []) as Array<Record<string, unknown> & { customer?: { farm_name?: string } }>).map((l) => ({
      ...l,
      farm_name: l.customer?.farm_name || 'Unknown',
    })) as unknown as LicenseWithCustomer[];
    setLicenses(mapped);
  };

  const fetchCustomers = async () => {
    const { data } = await supabase.from('customers').select('id, farm_name').order('farm_name');
    setCustomers(data || []);
  };

  const fetchRUPProducts = async () => {
    const { data, error } = await supabase
      .from('products')
      .select('id, product_name, sku, vendor, manufacturer, epa_registration, signal_word, is_active')
      .eq('is_rup', true)
      .order('product_name');

    if (error) {
      toast('error', 'Failed to load RUP products');
      console.error(error.message);
      return;
    }
    setRUPProducts((data || []) as RUPProduct[]);
  };

  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysOut = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

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
    setSaving(true);

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

    try {
      if (editId) {
        const result = await supabase
          .from('applicator_licenses')
          .update(payload)
          .eq('id', editId)
          .select();
        checkMutationResult(result, 'Update license');
        toast('success', 'License updated');
      } else {
        const result = await supabase
          .from('applicator_licenses')
          .insert(payload)
          .select();
        checkMutationResult(result, 'Create license');
        toast('success', 'License added');
        if (profile) logActivity('license_created', `Applicator license added for ${form.holder_name}`, profile.id);
      }
      setModalOpen(false);
      fetchLicenses();
    } catch (err: unknown) {
      toast('error', err instanceof Error ? err.message : 'Failed to save license');
    }
    setSaving(false);
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
            {new Date(r.expiry_date).toLocaleDateString()}
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold font-heading text-nav-dark">Compliance</h1>
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
          <div className="flex gap-2">
            {(['all', 'active', 'expiring', 'expired'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setLicenseFilter(f)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                  licenseFilter === f
                    ? 'bg-crx-green text-white border-crx-green'
                    : 'border-gray-200 text-secondary hover:border-crx-green hover:text-crx-green'
                }`}
              >
                {f === 'all' ? 'All' : f === 'active' ? 'Valid' : f === 'expiring' ? 'Expiring Soon' : 'Expired'}
              </button>
            ))}
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
