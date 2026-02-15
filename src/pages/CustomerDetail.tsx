import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Plus, Trash2, Search, MapPin, FileText } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import CommissionSplitEditor from '../components/ui/CommissionSplitEditor';
import UnsavedChangesModal from '../components/ui/UnsavedChangesModal';
import Badge, { statusToBadgeVariant } from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { supabase } from '../lib/db';
import type { Customer, CustomerAddress, CommissionSplit, Quote, Order, Delivery, Field } from '../types';
import MapContainer from '../components/map/MapContainer';
import FieldMarkers from '../components/map/FieldMarkers';
import YearEndSummaryDialog from '../components/reports/YearEndSummaryDialog';
import { downloadYearEndSummaryPdf } from '../lib/yearEndSummaryPdf';
import type { YearEndSummaryOptions } from '../lib/yearEndSummaryPdf';
import type { YearEndSummaryData } from '../types';

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { profile } = useAuth();
  const isNew = id === 'new';

  const [customer, setCustomer] = useState<Partial<Customer>>({
    farm_name: '',
    contact_name: '',
    phone: '',
    email: '',
    billing_address: '',
    assigned_tier: 1,
    assigned_sales_rep: profile?.id,
    total_acres: undefined,
    corn_acres: undefined,
    soybean_acres: undefined,
    other_acres: undefined,
    payment_terms: '',
    notes: '',
    is_active: true,
    default_commission_split: { splits: [{ recipient: '', percentage: 100 }] },
  });
  const [addresses, setAddresses] = useState<Partial<CustomerAddress>[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'info' | 'fields' | 'quotes' | 'orders' | 'deliveries' | 'history'>('info');

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [orders, setOrders] = useState<(Order & { fulfillment_pct: number })[]>([]);
  const [deliveries, setDeliveries] = useState<(Delivery & { driver_name: string })[]>([]);
  const [fields, setFields] = useState<(Field & { customer_name: string })[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [tabLoading, setTabLoading] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [showSummaryDialog, setShowSummaryDialog] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Parent customer search
  const [allCustomers, setAllCustomers] = useState<{ id: string; farm_name: string }[]>([]);
  const [parentSearch, setParentSearch] = useState('');
  const [showParentDropdown, setShowParentDropdown] = useState(false);
  const [parentName, setParentName] = useState('');

  // Track dirty state for unsaved changes warning
  const [isDirty, setIsDirty] = useState(false);
  const initialLoadDone = useRef(false);
  const blocker = useUnsavedChanges(isDirty);

  useEffect(() => {
    if (!initialLoadDone.current) return;
    setIsDirty(true);
  }, [customer, addresses]);

  useEffect(() => {
    // Fetch all customers for parent selector
    supabase.from('customers').select('id, farm_name').eq('is_active', true).order('farm_name').limit(500)
      .then(({ data }) => setAllCustomers((data || []) as { id: string; farm_name: string }[]));

    if (!isNew && id) {
      fetchCustomer();
      fetchAddresses();
    } else {
      // New customer — mark ready immediately
      setTimeout(() => { initialLoadDone.current = true; }, 0);
    }
  }, [id]);

  useEffect(() => {
    if (!isNew && id && tab !== 'info') {
      fetchTabData(tab);
    }
  }, [tab, id]);

  const fetchCustomer = async () => {
    const { data } = await supabase.from('customers').select('*').eq('id', id).maybeSingle();
    if (data) {
      setCustomer(data);
      // Fetch parent customer name if set
      if (data.parent_customer_id) {
        const { data: parent } = await supabase
          .from('customers')
          .select('farm_name')
          .eq('id', data.parent_customer_id)
          .maybeSingle();
        if (parent) setParentName(parent.farm_name);
      }
    }
    setLoading(false);
    setTimeout(() => { initialLoadDone.current = true; }, 0);
  };

  const fetchAddresses = async () => {
    const { data } = await supabase.from('customer_addresses').select('*').eq('customer_id', id).order('created_at');
    setAddresses(data || []);
  };

  const fetchTabData = async (selectedTab: string) => {
    setTabLoading(true);
    if (selectedTab === 'fields') {
      const { data } = await supabase.rpc('get_fields_with_geojson', { p_customer_id: id });
      const rows = ((data || []) as any[]).map((f: any) => ({
        ...f,
        customer_name: f.customer_name || '',
      }));
      setFields(rows);
    } else if (selectedTab === 'quotes') {
      const { data } = await supabase
        .from('quotes')
        .select('*')
        .eq('customer_id', id)
        .order('created_at', { ascending: false });
      setQuotes((data || []) as Quote[]);
    } else if (selectedTab === 'orders') {
      const { data } = await supabase
        .from('orders')
        .select('*')
        .eq('customer_id', id)
        .order('order_date', { ascending: false });
      const rows = ((data || []) as Order[]).map((o) => {
        const { data: items } = { data: null as null };
        void items;
        return { ...o, fulfillment_pct: 0 };
      });
      setOrders(rows);

      const orderIds = rows.map((o) => o.id);
      if (orderIds.length > 0) {
        const { data: itemsData } = await supabase
          .from('order_items')
          .select('order_id, total_units_needed, quantity_delivered')
          .in('order_id', orderIds);
        const byOrder: Record<string, { needed: number; delivered: number }> = {};
        (itemsData || []).forEach((item) => {
          if (!byOrder[item.order_id]) byOrder[item.order_id] = { needed: 0, delivered: 0 };
          byOrder[item.order_id].needed += item.total_units_needed || 0;
          byOrder[item.order_id].delivered += item.quantity_delivered || 0;
        });
        setOrders((prev) =>
          prev.map((o) => {
            const stats = byOrder[o.id];
            return {
              ...o,
              fulfillment_pct: stats && stats.needed > 0 ? Math.round((stats.delivered / stats.needed) * 100) : 0,
            };
          })
        );
      }
    } else if (selectedTab === 'deliveries') {
      const { data } = await supabase
        .from('deliveries')
        .select('*, driver:profiles!deliveries_assigned_driver_fkey(full_name)')
        .eq('customer_id', id)
        .order('scheduled_date', { ascending: false });
      const rows = ((data || []) as Array<Delivery & { driver: { full_name: string } | null }>).map((d) => ({
        ...d,
        driver_name: d.driver?.full_name || 'Unassigned',
      }));
      setDeliveries(rows);
    } else if (selectedTab === 'history') {
      // GAP FIX #15: Fetch purchase history — all products this customer has ordered
      const { data: orderIds } = await supabase
        .from('orders')
        .select('id')
        .eq('customer_id', id);
      if (orderIds && orderIds.length > 0) {
        const { data: allItems } = await supabase
          .from('order_items')
          .select('product_name, price_per_unit, total_units_needed, total_price, quantity_delivered, section_name, order_id')
          .in('order_id', orderIds.map((o: any) => o.id));
        // Aggregate by product
        const productMap: Record<string, { product_name: string; total_units: number; total_spent: number; total_delivered: number; order_count: number }> = {};
        (allItems || []).forEach((item: any) => {
          const key = item.product_name;
          if (!productMap[key]) {
            productMap[key] = { product_name: key, total_units: 0, total_spent: 0, total_delivered: 0, order_count: 0 };
          }
          productMap[key].total_units += Number(item.total_units_needed) || 0;
          productMap[key].total_spent += Number(item.total_price) || 0;
          productMap[key].total_delivered += Number(item.quantity_delivered) || 0;
          productMap[key].order_count += 1;
        });
        setHistory(Object.values(productMap).sort((a, b) => b.total_spent - a.total_spent));
      } else {
        setHistory([]);
      }
    }
    setTabLoading(false);
  };

  const handleSave = async () => {
    if (!customer.farm_name) {
      toast('error', 'Farm name is required');
      return;
    }

    // Email format validation
    if (customer.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(customer.email)) {
        setEmailError('Invalid email format');
        toast('error', 'Please enter a valid email address');
        return;
      }
    }
    setEmailError('');

    // Phone format validation (digits, dashes, spaces, parens, plus)
    if (customer.phone) {
      const phoneRegex = /^[+\d\s()-]{7,20}$/;
      if (!phoneRegex.test(customer.phone)) {
        setPhoneError('Invalid phone format');
        toast('error', 'Please enter a valid phone number');
        return;
      }
    }
    setPhoneError('');

    // Acreage must be non-negative
    const acreFields: Array<keyof Customer> = ['total_acres', 'corn_acres', 'soybean_acres', 'other_acres'];
    for (const field of acreFields) {
      const val = customer[field];
      if (val != null && typeof val === 'number' && val < 0) {
        toast('error', `${field.replace(/_/g, ' ')} cannot be negative`);
        return;
      }
    }

    setSaving(true);
    try {
      const customerPayload = {
        farm_name: customer.farm_name,
        contact_name: customer.contact_name,
        phone: customer.phone,
        email: customer.email,
        billing_address: customer.billing_address,
        assigned_tier: customer.assigned_tier,
        assigned_sales_rep: customer.assigned_sales_rep,
        parent_customer_id: customer.parent_customer_id || null,
        total_acres: customer.total_acres,
        corn_acres: customer.corn_acres,
        soybean_acres: customer.soybean_acres,
        other_acres: customer.other_acres,
        payment_terms: customer.payment_terms,
        default_commission_split: customer.default_commission_split,
        credit_limit_cents: customer.credit_limit_cents || 0,
        finance_charge_rate: customer.finance_charge_rate || 0,
        finance_charge_enabled: customer.finance_charge_enabled ?? true,
        finance_charge_grace_days: customer.finance_charge_grace_days ?? 0,
        notes: customer.notes,
        is_active: customer.is_active,
      };

      const addressesPayload = addresses.map((addr) => ({
        label: addr.label,
        address_line: addr.address_line,
        city: addr.city,
        state: addr.state,
        zip: addr.zip,
        delivery_notes: addr.delivery_notes,
        is_default: addr.is_default,
      }));

      const { data, error } = await supabase.rpc('save_customer', {
        p_customer_id: isNew ? null : id,
        p_customer_payload: customerPayload,
        p_addresses: addressesPayload,
        p_performed_by: profile!.id,
      });

      if (error) {
        toast('error', error.message);
      } else {
        setIsDirty(false);
        if (isNew) {
          toast('success', 'Customer created');
          navigate(`/customers/${data}`, { replace: true });
        } else {
          toast('success', 'Customer updated');
          fetchAddresses();
        }
      }
    } catch (err: any) {
      toast('error', err.message || 'Failed to save customer');
    }
    setSaving(false);
  };

  const update = (field: string, value: unknown) => setCustomer((c) => ({ ...c, [field]: value }));

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  if (loading) {
    return <div className="animate-pulse"><div className="h-64 bg-gray-200 rounded" /></div>;
  }

  const tabs = ['info', 'fields', 'quotes', 'orders', 'deliveries', 'history'] as const;

  const handleGenerateSummary = async (season: number, options: YearEndSummaryOptions) => {
    if (!id || isNew) return;
    setSummaryLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_customer_year_end_summary', {
        p_customer_id: id,
        p_season: season,
      });
      if (error) throw error;
      await downloadYearEndSummaryPdf(data as unknown as YearEndSummaryData, options);
      toast('success', `Season ${season} summary generated`);
      setShowSummaryDialog(false);
    } catch (err: any) {
      toast('error', err.message || 'Failed to generate summary');
    }
    setSummaryLoading(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/customers')} className="p-2 rounded-lg hover:bg-white hover:shadow-sm transition-all text-secondary">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="text-lg font-semibold font-heading text-nav-dark">
            {isNew ? 'New Customer' : customer.farm_name}
          </h2>
        </div>
        {!isNew && (profile?.role === 'admin' || profile?.role === 'sales_rep') && (
          <Button
            variant="secondary"
            size="sm"
            icon={<FileText className="w-4 h-4" />}
            onClick={() => setShowSummaryDialog(true)}
          >
            Season Summary
          </Button>
        )}
      </div>

      {!isNew && (
        <div className="flex gap-1 border-b border-gray-200">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium capitalize transition-colors ${
                tab === t
                  ? 'text-crx-green border-b-2 border-crx-green'
                  : 'text-secondary hover:text-nav-dark'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {(tab === 'info' || isNew) && (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Contact" accent="Information" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Farm Name" required value={customer.farm_name || ''} onChange={(e) => update('farm_name', e.target.value)} />
              <Input label="Contact Name" value={customer.contact_name || ''} onChange={(e) => update('contact_name', e.target.value)} />
              <Input label="Phone" value={customer.phone || ''} onChange={(e) => { update('phone', e.target.value); setPhoneError(''); }} error={phoneError} />
              <Input label="Email" type="email" value={customer.email || ''} onChange={(e) => { update('email', e.target.value); setEmailError(''); }} error={emailError} />
              <Input label="Billing Address" value={customer.billing_address || ''} onChange={(e) => update('billing_address', e.target.value)} />
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Pricing Tier</label>
                <select
                  value={customer.assigned_tier}
                  onChange={(e) => update('assigned_tier', parseInt(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value={1}>Tier 1</option>
                  <option value={2}>Tier 2</option>
                  <option value={3}>Tier 3</option>
                </select>
              </div>
              <Input label="Payment Terms" value={customer.payment_terms || ''} onChange={(e) => update('payment_terms', e.target.value)} />
              <Input
                label="Credit Limit ($)"
                type="number"
                min={0}
                step={100}
                value={customer.credit_limit_cents != null ? (customer.credit_limit_cents as number) / 100 : ''}
                onChange={(e) => update('credit_limit_cents', e.target.value ? Math.round(parseFloat(e.target.value) * 100) : 0)}
              />
              <Input
                label="Finance Charge Rate (%)"
                type="number"
                min={0}
                step={0.5}
                value={customer.finance_charge_rate ?? ''}
                onChange={(e) => update('finance_charge_rate', e.target.value ? parseFloat(e.target.value) : 0)}
              />
              <div>
                <label className="block text-sm font-medium text-secondary mb-1">Finance Charges</label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => update('finance_charge_enabled', !(customer.finance_charge_enabled ?? true))}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      (customer.finance_charge_enabled ?? true) ? 'bg-crx-green' : 'bg-gray-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        (customer.finance_charge_enabled ?? true) ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                  <span className="text-sm text-secondary">
                    {(customer.finance_charge_enabled ?? true) ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
              </div>
              <Input
                label="Grace Period (days)"
                type="number"
                min={0}
                step={1}
                value={customer.finance_charge_grace_days ?? 0}
                onChange={(e) => update('finance_charge_grace_days', e.target.value ? parseInt(e.target.value) : 0)}
              />

              {/* Parent Customer (Farm Group) selector */}
              <div className="relative">
                <label className="block text-sm font-medium text-secondary mb-1">Parent Customer</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={showParentDropdown ? parentSearch : parentName}
                    onChange={(e) => {
                      setParentSearch(e.target.value);
                      setShowParentDropdown(true);
                    }}
                    onFocus={() => {
                      setParentSearch('');
                      setShowParentDropdown(true);
                    }}
                    onBlur={() => setTimeout(() => setShowParentDropdown(false), 200)}
                    placeholder="Search parent customer..."
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                  />
                </div>
                {customer.parent_customer_id && (
                  <button
                    type="button"
                    onClick={() => { update('parent_customer_id', null); setParentName(''); }}
                    className="absolute right-2 top-8 text-xs text-gray-400 hover:text-red-500"
                  >
                    Clear
                  </button>
                )}
                {showParentDropdown && (
                  <div className="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
                    {allCustomers
                      .filter((c) => c.id !== id && c.farm_name.toLowerCase().includes(parentSearch.toLowerCase()))
                      .slice(0, 20)
                      .map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            update('parent_customer_id', c.id);
                            setParentName(c.farm_name);
                            setShowParentDropdown(false);
                          }}
                          className="w-full text-left px-4 py-2 text-sm hover:bg-crx-green-tint transition-colors"
                        >
                          {c.farm_name}
                        </button>
                      ))}
                  </div>
                )}
                <p className="text-xs text-secondary mt-1">Link this customer to a parent farm group</p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Farm" accent="Acreage" />
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <Input label="Total Acres" type="number" value={customer.total_acres ?? ''} onChange={(e) => update('total_acres', e.target.value ? parseFloat(e.target.value) : null)} />
              <Input label="Corn Acres" type="number" value={customer.corn_acres ?? ''} onChange={(e) => update('corn_acres', e.target.value ? parseFloat(e.target.value) : null)} />
              <Input label="Soybean Acres" type="number" value={customer.soybean_acres ?? ''} onChange={(e) => update('soybean_acres', e.target.value ? parseFloat(e.target.value) : null)} />
              <Input label="Other Acres" type="number" value={customer.other_acres ?? ''} onChange={(e) => update('other_acres', e.target.value ? parseFloat(e.target.value) : null)} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Delivery"
              accent="Addresses"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Plus className="w-3 h-3" />}
                  showChevron={false}
                  onClick={() => setAddresses((a) => [...a, { label: '', address_line: '', city: '', state: '', zip: '', delivery_notes: '', is_default: false }])}
                >
                  Add Address
                </Button>
              }
            />
            {addresses.length === 0 ? (
              <p className="text-sm text-secondary">No delivery addresses added</p>
            ) : (
              <div className="space-y-4">
                {addresses.map((addr, idx) => (
                  <div key={addr.id || idx} className="p-4 border border-gray-100 rounded-lg space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-secondary">Address {idx + 1}</span>
                      <button onClick={() => setAddresses((a) => a.filter((_, i) => i !== idx))} className="text-gray-400 hover:text-red-500">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input label="Label" value={addr.label || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], label: e.target.value }; setAddresses(a); }} placeholder="e.g. East Farm" />
                      <Input label="Address" value={addr.address_line || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], address_line: e.target.value }; setAddresses(a); }} />
                      <Input label="City" value={addr.city || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], city: e.target.value }; setAddresses(a); }} />
                      <div className="grid grid-cols-2 gap-3">
                        <Input label="State" value={addr.state || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], state: e.target.value }; setAddresses(a); }} />
                        <Input label="ZIP" value={addr.zip || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], zip: e.target.value }; setAddresses(a); }} />
                      </div>
                    </div>
                    <Input label="Delivery Notes" value={addr.delivery_notes || ''} onChange={(e) => { const a = [...addresses]; a[idx] = { ...a[idx], delivery_notes: e.target.value }; setAddresses(a); }} placeholder="Gate code, directions, etc." />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Default" accent="Commission Split" />
            <CommissionSplitEditor
              value={(customer.default_commission_split as CommissionSplit) || { splits: [{ recipient: '', percentage: 100 }] }}
              onChange={(val) => update('default_commission_split', val)}
              label=""
            />
            <p className="text-xs text-secondary mt-2">
              This default split is applied to new quotes for this customer.
            </p>
          </Card>

          <Card>
            <CardHeader title="Notes" accent="" />
            <textarea
              value={customer.notes || ''}
              onChange={(e) => update('notes', e.target.value)}
              rows={4}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
              placeholder="General notes about this customer..."
            />
          </Card>

          <div className="flex justify-end">
            <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
              {isNew ? 'Create Customer' : 'Save Changes'}
            </Button>
          </div>
        </div>
      )}

      {tab === 'fields' && !isNew && (
        <>
          {/* Mini map showing this customer's fields */}
          {!tabLoading && fields.some((f) => f.centroid_geojson) && (
            <Card>
              <CardHeader title="Field" accent="Locations" />
              <MapContainer className="h-[250px] w-full rounded-lg overflow-hidden">
                <FieldMarkers
                  fields={fields as any}
                  onFieldClick={(fieldId) => navigate(`/fields/${fieldId}`)}
                />
              </MapContainer>
            </Card>
          )}

          <Card padding={false}>
            <div className="p-5">
              <CardHeader
                title="Customer"
                accent="Fields"
                action={
                  <Button variant="ghost" size="sm" icon={<Plus className="w-3 h-3" />} showChevron={false} onClick={() => navigate('/fields/new')}>
                    Add Field
                  </Button>
                }
              />
            </div>
            {tabLoading ? (
              <div className="px-5 pb-5 space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
                ))}
              </div>
            ) : fields.length === 0 ? (
              <div className="px-5 pb-5">
                <p className="text-sm text-secondary">No fields for this customer yet.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-t border-b border-gray-100">
                      <th className="px-5 py-3 text-left font-medium text-secondary">Field Name</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Acres</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Crop</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">County</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Legal Desc.</th>
                      <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((f) => (
                      <tr
                        key={f.id}
                        onClick={() => navigate(`/fields/${f.id}`)}
                        className="border-b border-gray-50 hover:bg-crx-green-tint cursor-pointer transition-colors"
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <MapPin className="w-4 h-4 text-crx-green flex-shrink-0" />
                            <span className="font-medium text-nav-dark">{f.field_name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3">{f.total_acres?.toLocaleString() || '-'}</td>
                        <td className="px-4 py-3">
                          {f.crop_type ? (
                            <Badge variant="info">{f.crop_type}</Badge>
                          ) : '-'}
                        </td>
                        <td className="px-4 py-3 text-secondary">{f.county || '-'}</td>
                        <td className="px-4 py-3 text-secondary text-xs truncate max-w-[200px]">
                          {f.legal_description || '-'}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={f.is_active ? 'success' : 'default'}>
                            {f.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {tab === 'quotes' && !isNew && (
        <Card padding={false}>
          <div className="p-5">
            <CardHeader
              title="Customer"
              accent="Quotes"
              action={
                <Button variant="ghost" size="sm" onClick={() => navigate('/quotes/new')}>
                  New Quote
                </Button>
              }
            />
          </div>
          {tabLoading ? (
            <div className="px-5 pb-5 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : quotes.length === 0 ? (
            <div className="px-5 pb-5">
              <p className="text-sm text-secondary">No quotes for this customer yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-t border-b border-gray-100">
                    <th className="px-5 py-3 text-left font-medium text-secondary">Quote #</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Tier</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Total</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Margin</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {quotes.map((q) => (
                    <tr
                      key={q.id}
                      onClick={() => navigate(`/quotes/${q.id}`)}
                      className="border-b border-gray-50 hover:bg-crx-green-tint cursor-pointer transition-colors"
                    >
                      <td className="px-5 py-3 font-medium text-nav-dark">{q.quote_number}</td>
                      <td className="px-4 py-3">
                        <Badge variant={statusToBadgeVariant[q.status] || 'default'}>
                          {q.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">T{q.tier}</td>
                      <td className="px-4 py-3 font-mono">{fmt(q.total_price)}</td>
                      <td className="px-4 py-3 font-mono text-emerald-600">{q.total_margin_pct.toFixed(1)}%</td>
                      <td className="px-4 py-3 text-secondary">
                        {new Date(q.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'orders' && !isNew && (
        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Customer" accent="Orders" />
          </div>
          {tabLoading ? (
            <div className="px-5 pb-5 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : orders.length === 0 ? (
            <div className="px-5 pb-5">
              <p className="text-sm text-secondary">No orders for this customer yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-t border-b border-gray-100">
                    <th className="px-5 py-3 text-left font-medium text-secondary">Order #</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Total</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Profit</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Date</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary w-40">Fulfillment</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      onClick={() => navigate(`/orders/${o.id}`)}
                      className="border-b border-gray-50 hover:bg-crx-green-tint cursor-pointer transition-colors"
                    >
                      <td className="px-5 py-3 font-medium text-nav-dark">{o.order_number}</td>
                      <td className="px-4 py-3">
                        <Badge variant={statusToBadgeVariant[o.status] || 'default'}>
                          {o.status.replace('_', ' ')}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-mono">{fmt(o.total_price)}</td>
                      <td className="px-4 py-3 font-mono text-emerald-600">{fmt(o.total_profit)}</td>
                      <td className="px-4 py-3 text-secondary">
                        {new Date(o.order_date).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-crx-green rounded-full transition-all"
                              style={{ width: `${o.fulfillment_pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-secondary w-8">{o.fulfillment_pct}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'deliveries' && !isNew && (
        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Customer" accent="Deliveries" />
          </div>
          {tabLoading ? (
            <div className="px-5 pb-5 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : deliveries.length === 0 ? (
            <div className="px-5 pb-5">
              <p className="text-sm text-secondary">No deliveries for this customer yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-t border-b border-gray-100">
                    <th className="px-5 py-3 text-left font-medium text-secondary">Delivery #</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Driver</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Scheduled</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => navigate(`/deliveries/${d.id}`)}
                      className="border-b border-gray-50 hover:bg-crx-green-tint cursor-pointer transition-colors"
                    >
                      <td className="px-5 py-3 font-medium text-nav-dark">{d.delivery_number}</td>
                      <td className="px-4 py-3">
                        <Badge variant={statusToBadgeVariant[d.status] || 'default'}>
                          {d.status.replace('_', ' ')}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">{d.driver_name}</td>
                      <td className="px-4 py-3 text-secondary">
                        {new Date(d.scheduled_date).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-secondary">
                        {d.completed_at ? new Date(d.completed_at).toLocaleDateString() : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* GAP FIX #15: Purchase History Tab */}
      {tab === 'history' && !isNew && (
        <Card padding={false}>
          <div className="p-5">
            <CardHeader title="Purchase" accent="History" />
            <p className="text-xs text-secondary mt-1">Products ordered by this customer, aggregated across all orders</p>
          </div>
          {tabLoading ? (
            <div className="px-5 pb-5 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className="px-5 pb-5">
              <p className="text-sm text-secondary">No purchase history yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-t border-b border-gray-100">
                    <th className="px-5 py-3 text-left font-medium text-secondary">Product</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Times Ordered</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Total Units</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Units Delivered</th>
                    <th className="px-4 py-3 text-left font-medium text-secondary">Total Spent</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h, idx) => (
                    <tr key={idx} className="border-b border-gray-50">
                      <td className="px-5 py-3 font-medium text-nav-dark">{h.product_name}</td>
                      <td className="px-4 py-3">{h.order_count}</td>
                      <td className="px-4 py-3">{h.total_units.toLocaleString()}</td>
                      <td className="px-4 py-3">{h.total_delivered.toLocaleString()}</td>
                      <td className="px-4 py-3 font-mono text-crx-green">
                        {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(h.total_spent)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-200 bg-gray-50">
                    <td className="px-5 py-3 font-semibold text-nav-dark">Total</td>
                    <td className="px-4 py-3 font-semibold">{history.reduce((s: number, h: any) => s + h.order_count, 0)}</td>
                    <td className="px-4 py-3 font-semibold">{history.reduce((s: number, h: any) => s + h.total_units, 0).toLocaleString()}</td>
                    <td className="px-4 py-3 font-semibold">{history.reduce((s: number, h: any) => s + h.total_delivered, 0).toLocaleString()}</td>
                    <td className="px-4 py-3 font-semibold font-mono text-crx-green">
                      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(history.reduce((s: number, h: any) => s + h.total_spent, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      )}

      <YearEndSummaryDialog
        open={showSummaryDialog}
        onClose={() => setShowSummaryDialog(false)}
        onGenerate={handleGenerateSummary}
        loading={summaryLoading}
        customerName={customer.farm_name || ''}
      />

      <UnsavedChangesModal
        open={blocker.state === 'blocked'}
        onStay={() => blocker.reset?.()}
        onLeave={() => blocker.proceed?.()}
      />
    </div>
  );
}
