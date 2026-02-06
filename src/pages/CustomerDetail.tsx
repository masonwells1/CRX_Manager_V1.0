import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Plus, Trash2 } from 'lucide-react';
import Card, { CardHeader } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import type { Customer, CustomerAddress } from '../types';

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
    default_commission_split: { splits: [{ recipient: 'Mason Wells', percentage: 50 }, { recipient: 'Chance Tuttle', percentage: 50 }] },
  });
  const [addresses, setAddresses] = useState<Partial<CustomerAddress>[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'info' | 'quotes' | 'orders' | 'deliveries'>('info');

  useEffect(() => {
    if (!isNew && id) {
      fetchCustomer();
      fetchAddresses();
    }
  }, [id]);

  const fetchCustomer = async () => {
    const { data } = await supabase.from('customers').select('*').eq('id', id).maybeSingle();
    if (data) setCustomer(data);
    setLoading(false);
  };

  const fetchAddresses = async () => {
    const { data } = await supabase.from('customer_addresses').select('*').eq('customer_id', id).order('created_at');
    setAddresses(data || []);
  };

  const handleSave = async () => {
    if (!customer.farm_name) {
      toast('error', 'Farm name is required');
      return;
    }
    setSaving(true);
    if (isNew) {
      const { data, error } = await supabase.from('customers').insert([customer]).select().maybeSingle();
      if (error) {
        toast('error', error.message);
      } else if (data) {
        for (const addr of addresses) {
          if (addr.label || addr.address_line) {
            await supabase.from('customer_addresses').insert([{ ...addr, customer_id: data.id }]);
          }
        }
        toast('success', 'Customer created');
        navigate(`/customers/${data.id}`);
      }
    } else {
      const { error } = await supabase
        .from('customers')
        .update({ ...customer, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) {
        toast('error', error.message);
      } else {
        toast('success', 'Customer updated');
      }
    }
    setSaving(false);
  };

  const update = (field: string, value: unknown) => setCustomer((c) => ({ ...c, [field]: value }));

  if (loading) {
    return <div className="animate-pulse"><div className="h-64 bg-gray-200 rounded" /></div>;
  }

  const tabs = ['info', 'quotes', 'orders', 'deliveries'] as const;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/customers')} className="p-2 rounded-lg hover:bg-white hover:shadow-sm transition-all text-secondary">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold font-heading text-nav-dark">
          {isNew ? 'New Customer' : customer.farm_name}
        </h2>
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
              <Input label="Farm Name" value={customer.farm_name || ''} onChange={(e) => update('farm_name', e.target.value)} />
              <Input label="Contact Name" value={customer.contact_name || ''} onChange={(e) => update('contact_name', e.target.value)} />
              <Input label="Phone" value={customer.phone || ''} onChange={(e) => update('phone', e.target.value)} />
              <Input label="Email" type="email" value={customer.email || ''} onChange={(e) => update('email', e.target.value)} />
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
                  <div key={idx} className="p-4 border border-gray-100 rounded-lg space-y-3">
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

      {tab === 'quotes' && !isNew && (
        <Card>
          <p className="text-sm text-secondary">Quotes for this customer will appear here.</p>
        </Card>
      )}
      {tab === 'orders' && !isNew && (
        <Card>
          <p className="text-sm text-secondary">Orders for this customer will appear here.</p>
        </Card>
      )}
      {tab === 'deliveries' && !isNew && (
        <Card>
          <p className="text-sm text-secondary">Deliveries for this customer will appear here.</p>
        </Card>
      )}
    </div>
  );
}
