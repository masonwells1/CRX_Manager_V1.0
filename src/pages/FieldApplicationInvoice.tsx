import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Save, Send, Trash2, Printer, MapPin, FlaskConical, Users, ClipboardList, ArrowLeft,
} from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, assertRpcResult, checkMutationResult } from '../lib/db';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { logActivity } from '../lib/activityLogger';
import { Sentry } from '../lib/sentry';
import Breadcrumbs from '../components/ui/Breadcrumbs';
import ConfirmModal from '../components/ui/ConfirmModal';
import SelectLocationsModal from '../components/field-app/SelectLocationsModal';
import FieldAppChemicalEntry, { type ChemicalLine } from '../components/field-app/FieldAppChemicalEntry';
import CustomerSharesTable from '../components/field-app/CustomerSharesTable';
import type { Field, CustomerShareResult, InvoiceStatus } from '../types';

interface FieldLocation {
  field_id: string;
  field_name: string;
  map_number: number | null;
  total_acres: number | null;
  planted_acres: number | null;
  applied_acres: number | null;
  crop_type: string | null;
  wind_direction: string | null;
  sort_order: number;
  customer_name?: string;
}

type TabKey = 'locations' | 'chemicals' | 'customers' | 'applied_info';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'locations', label: 'Locations', icon: <MapPin className="w-4 h-4" /> },
  { key: 'chemicals', label: 'Chemicals/Charges', icon: <FlaskConical className="w-4 h-4" /> },
  { key: 'customers', label: 'Customers', icon: <Users className="w-4 h-4" /> },
  { key: 'applied_info', label: 'Applied Info', icon: <ClipboardList className="w-4 h-4" /> },
];

const fmt = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

export default function FieldApplicationInvoice() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const saveIdem = useIdempotencyKey('save_field_app_invoice', profile?.id || '');

  const [activeTab, setActiveTab] = useState<TabKey>('locations');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showLocationsModal, setShowLocationsModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [transactionDate, setTransactionDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<InvoiceStatus>('draft');

  const [locations, setLocations] = useState<FieldLocation[]>([]);
  const [chemicals, setChemicals] = useState<ChemicalLine[]>([]);
  const [shares, setShares] = useState<CustomerShareResult[]>([]);

  const [windDirection, setWindDirection] = useState('');
  const [temperature, setTemperature] = useState('');
  const [applicator, setApplicator] = useState('');

  useUnsavedChanges(dirty);

  const isNew = !id;

  const totalAppliedAcres = useMemo(
    () => locations.reduce((sum, l) => sum + (l.applied_acres || l.total_acres || 0), 0),
    [locations]
  );

  const invoiceTotalCents = useMemo(
    () => chemicals.reduce((sum, c) => sum + c.extended_cents, 0),
    [chemicals]
  );

  const fetchInvoice = useCallback(async () => {
    if (!id) return;
    const { data: inv, error } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !inv) {
      toast('error', 'Failed to load invoice');
      navigate('/invoices');
      return;
    }

    const invoice = inv as Record<string, unknown>;
    setInvoiceNumber((invoice.invoice_number as string) || '');
    setTransactionDate((invoice.transaction_date as string) || '');
    setNotes((invoice.notes as string) || '');
    setStatus((invoice.status as InvoiceStatus) || 'draft');

    const { data: locs } = await supabase
      .from('field_app_locations')
      .select('*, field:fields!field_app_locations_field_id_fkey(field_name, crop_type, total_acres, customer:customers!fields_customer_id_fkey(farm_name))')
      .eq('invoice_id', id)
      .order('sort_order');

    if (locs) {
      setLocations(
        (locs as Array<Record<string, unknown>>).map((l) => {
          const field = l.field as { field_name: string; crop_type: string | null; total_acres: number | null; customer: { farm_name: string } | null } | null;
          return {
            field_id: l.field_id as string,
            field_name: field?.field_name || 'Unknown',
            map_number: l.map_number as number | null,
            total_acres: (l.total_acres as number | null) ?? field?.total_acres ?? null,
            planted_acres: l.planted_acres as number | null,
            applied_acres: l.applied_acres as number | null,
            crop_type: (l.crop_type as string | null) ?? field?.crop_type ?? null,
            wind_direction: l.wind_direction as string | null,
            sort_order: l.sort_order as number,
            customer_name: field?.customer?.farm_name,
          };
        })
      );
    }

    const { data: items } = await supabase
      .from('invoice_items')
      .select('*')
      .eq('invoice_id', id)
      .order('sort_order');

    if (items) {
      setChemicals(
        (items as Array<Record<string, unknown>>).map((it, idx) => ({
          id: (it.id as string) || `chem_${idx}`,
          product_id: it.product_id as string | null,
          product_name: (it.product_name as string) || '',
          rate_per_acre: it.rate_per_acre as number | null,
          rate_unit: (it.rate_unit as string) || 'oz',
          quantity: (it.quantity as number) || 0,
          unit: (it.unit as string) || 'oz',
          unit_price_cents: (it.unit_price_cents as number) || 0,
          price_unit: (it.unit as string) || 'oz',
          extended_cents: (it.extended_cents as number) || 0,
          unit_cost_cents: (it.unit_cost_cents as number) || 0,
          sort_order: (it.sort_order as number) || idx,
        }))
      );
    }

    const { data: shareData } = await supabase
      .from('invoice_shares')
      .select('customer_id, customer_name, split_percentage, acres, amount_cents, is_primary')
      .eq('invoice_id', id)
      .order('sort_order');

    if (shareData) {
      setShares(
        (shareData as Array<Record<string, unknown>>).map((s) => ({
          customer_id: s.customer_id as string,
          customer_name: (s.customer_name as string) || '',
          is_primary: (s.is_primary as boolean) || false,
          total_acres: (s.acres as number) || 0,
          split_pct: (s.split_percentage as number) || 0,
        }))
      );
    }
  }, [id, toast, navigate]);

  useEffect(() => {
    fetchInvoice();
  }, [fetchInvoice]);

  const deriveShares = useCallback(async (fieldIds: string[], appliedAcresMap: Record<string, number>) => {
    if (fieldIds.length === 0) {
      setShares([]);
      return;
    }
    try {
      const { data, error } = await supabase.rpc('derive_customer_shares_from_fields', {
        p_field_ids: fieldIds,
        p_applied_acres_map: appliedAcresMap,
      });
      if (error) throw error;
      const result = assertRpcResult<{ shares: CustomerShareResult[] }>(data, 'derive_customer_shares_from_fields');
      setShares(result.shares || []);
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: 'derive_customer_shares_from_fields' } });
      toast('error', 'Failed to derive customer shares');
    }
  }, [toast]);

  const handleLocationsSelected = useCallback((selectedFields: (Field & { customer_name?: string })[]) => {
    const newLocations: FieldLocation[] = selectedFields.map((f, idx) => ({
      field_id: f.id,
      field_name: f.field_name,
      map_number: idx + 1,
      total_acres: f.total_acres,
      planted_acres: null,
      applied_acres: f.total_acres,
      crop_type: f.crop_type,
      wind_direction: null,
      sort_order: idx,
      customer_name: f.customer_name,
    }));
    setLocations(newLocations);
    setDirty(true);

    const fieldIds = newLocations.map((l) => l.field_id);
    const acresMap: Record<string, number> = {};
    newLocations.forEach((l) => {
      acresMap[l.field_id] = l.applied_acres || l.total_acres || 0;
    });
    deriveShares(fieldIds, acresMap);
  }, [deriveShares]);

  const updateLocationAcres = (fieldId: string, acres: number) => {
    setLocations((prev) =>
      prev.map((l) => (l.field_id === fieldId ? { ...l, applied_acres: acres } : l))
    );
    setDirty(true);

    const acresMap: Record<string, number> = {};
    locations.forEach((l) => {
      acresMap[l.field_id] = l.field_id === fieldId ? acres : (l.applied_acres || l.total_acres || 0);
    });
    deriveShares(locations.map((l) => l.field_id), acresMap);
  };

  const handleChemicalsChange = (updated: ChemicalLine[]) => {
    setChemicals(updated);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!profile) return;
    setSaving(true);
    try {
      const key = saveIdem.getKey();
      const { data, error } = await supabase.rpc('save_field_app_invoice', {
        p_invoice_id: id || null,
        p_invoice: {
          invoice_number: invoiceNumber || null,
          transaction_date: transactionDate,
          salesman_id: profile.id,
          notes: notes || null,
        },
        p_locations: locations.map((l, idx) => ({
          field_id: l.field_id,
          map_number: l.map_number || idx + 1,
          total_acres: l.total_acres,
          planted_acres: l.planted_acres,
          applied_acres: l.applied_acres || l.total_acres,
          crop_type: l.crop_type,
          wind_direction: l.wind_direction || windDirection || null,
          sort_order: idx,
        })),
        p_chemicals: chemicals.map((c, idx) => ({
          product_id: c.product_id,
          product_name: c.product_name,
          quantity: c.quantity,
          unit: c.unit,
          unit_price_cents: c.unit_price_cents,
          extended_cents: c.extended_cents,
          unit_cost_cents: c.unit_cost_cents,
          sort_order: idx,
          rate_per_acre: c.rate_per_acre,
          rate_unit: c.rate_unit,
        })),
        p_performed_by: profile.id,
        p_idempotency_key: key,
      });

      if (error) throw error;
      const result = assertRpcResult<{ invoice_id: string }>(data, 'save_field_app_invoice');
      saveIdem.resetKey();
      setDirty(false);
      toast('success', isNew ? 'Invoice created' : 'Invoice saved');

      if (isNew) {
        navigate(`/invoices/field-app/${result.invoice_id}`, { replace: true });
      } else {
        fetchInvoice();
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { rpc: 'save_field_app_invoice' } });
      toast('error', `Save failed: ${sanitizeError(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !profile) return;
    try {
      const deleteResult = await supabase
        .from('invoices')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
        .select();
      checkMutationResult(deleteResult, 'Soft delete field app invoice');

      await logActivity({
        event: 'field_app_invoice_deleted',
        description: `Deleted field application invoice ${invoiceNumber}`,
        performedBy: profile.id,
        entityType: 'invoice',
        entityId: id,
      });

      toast('success', 'Invoice deleted');
      navigate('/invoices');
    } catch (err) {
      Sentry.captureException(err, { tags: { action: 'delete_field_app_invoice' } });
      toast('error', `Delete failed: ${sanitizeError(err)}`);
    }
  };

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          { label: 'Invoices', href: '/invoices' },
          { label: isNew ? 'New Field Application' : `Invoice ${invoiceNumber || id?.slice(0, 8)}` },
        ]}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/invoices')} className="p-1 rounded hover:bg-gray-100">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold">
              {isNew ? 'New Field Application Invoice' : `Field Application ${invoiceNumber}`}
            </h1>
            <p className="text-sm text-gray-500">
              {totalAppliedAcres.toFixed(1)} acres &middot; {locations.length} locations &middot; {fmt(invoiceTotalCents)}
            </p>
          </div>
          {!isNew && <Badge variant={status === 'draft' ? 'default' : status === 'posted' ? 'success' : 'warning'}>{status}</Badge>}
        </div>
        <div className="flex gap-2">
          {!isNew && (
            <Button variant="danger" size="sm" icon={<Trash2 className="w-4 h-4" />} onClick={() => setShowDeleteConfirm(true)}>
              Delete
            </Button>
          )}
          {!isNew && (
            <Button variant="secondary" size="sm" icon={<Printer className="w-4 h-4" />} onClick={() => { /* TODO: print */ }}>
              Print
            </Button>
          )}
          {!isNew && status === 'draft' && (
            <Button variant="secondary" size="sm" icon={<Send className="w-4 h-4" />} onClick={() => { /* TODO: post */ }}>
              Post
            </Button>
          )}
          <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving} disabled={saving}>
            Save
          </Button>
        </div>
      </div>

      <Card>
        <div className="grid grid-cols-3 gap-4 p-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Invoice #</label>
            <input
              type="text"
              value={invoiceNumber}
              onChange={(e) => { setInvoiceNumber(e.target.value); setDirty(true); }}
              placeholder="Auto-generated"
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Transaction Date</label>
            <input
              type="date"
              value={transactionDate}
              onChange={(e) => { setTransactionDate(e.target.value); setDirty(true); }}
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
            <input
              type="text"
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
              placeholder="Optional notes"
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
        </div>
      </Card>

      <div className="border-b">
        <nav className="flex gap-1 px-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-crx-green text-crx-green'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.key === 'locations' && locations.length > 0 && (
                <span className="ml-1 text-xs bg-gray-100 rounded-full px-1.5">{locations.length}</span>
              )}
              {tab.key === 'chemicals' && chemicals.length > 0 && (
                <span className="ml-1 text-xs bg-gray-100 rounded-full px-1.5">{chemicals.length}</span>
              )}
              {tab.key === 'customers' && shares.length > 0 && (
                <span className="ml-1 text-xs bg-gray-100 rounded-full px-1.5">{shares.length}</span>
              )}
            </button>
          ))}
        </nav>
      </div>

      <Card>
        {activeTab === 'locations' && (
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Application Locations</h3>
              <Button
                size="sm"
                icon={<MapPin className="w-4 h-4" />}
                onClick={() => setShowLocationsModal(true)}
              >
                {locations.length > 0 ? 'Change Locations' : 'Select Locations'}
              </Button>
            </div>

            {locations.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b">
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Map #</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Field Name</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Crop</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Customer</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Total Acres</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Applied Acres</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {locations.map((loc) => (
                    <tr key={loc.field_id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 tabular-nums">{loc.map_number}</td>
                      <td className="px-3 py-2 font-medium">{loc.field_name}</td>
                      <td className="px-3 py-2 text-gray-600">{loc.crop_type || '\u2014'}</td>
                      <td className="px-3 py-2 text-gray-600">{loc.customer_name || '\u2014'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{loc.total_acres?.toFixed(1) || '\u2014'}</td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          step="0.1"
                          value={loc.applied_acres ?? ''}
                          onChange={(e) => updateLocationAcres(loc.field_id, Number(e.target.value))}
                          className="w-24 ml-auto px-2 py-1 border rounded text-right text-sm tabular-nums"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 font-semibold border-t">
                    <td colSpan={4} className="px-3 py-2">Totals</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {locations.reduce((s, l) => s + (l.total_acres || 0), 0).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {totalAppliedAcres.toFixed(1)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <div className="text-center py-12 text-gray-400">
                <MapPin className="w-8 h-8 mx-auto mb-2" />
                <p>No locations selected</p>
                <p className="text-sm">Click Select Locations to choose fields for this application</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'chemicals' && (
          <div className="p-4">
            <FieldAppChemicalEntry
              chemicals={chemicals}
              onChemicalsChange={handleChemicalsChange}
              totalAppliedAcres={totalAppliedAcres}
            />
          </div>
        )}

        {activeTab === 'customers' && (
          <div className="p-4">
            <CustomerSharesTable
              shares={shares}
              invoiceTotalCents={invoiceTotalCents}
            />
          </div>
        )}

        {activeTab === 'applied_info' && (
          <div className="p-4 space-y-4">
            <h3 className="font-semibold">Application Details</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Wind Direction</label>
                <input
                  type="text"
                  value={windDirection}
                  onChange={(e) => { setWindDirection(e.target.value); setDirty(true); }}
                  placeholder="e.g. NW 5-10 mph"
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Temperature</label>
                <input
                  type="text"
                  value={temperature}
                  onChange={(e) => { setTemperature(e.target.value); setDirty(true); }}
                  placeholder="e.g. 72F"
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Applicator</label>
                <input
                  type="text"
                  value={applicator}
                  onChange={(e) => { setApplicator(e.target.value); setDirty(true); }}
                  placeholder="Applicator name"
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
            </div>
          </div>
        )}
      </Card>

      <SelectLocationsModal
        isOpen={showLocationsModal}
        onClose={() => setShowLocationsModal(false)}
        onSelect={handleLocationsSelected}
        initialSelectedIds={locations.map((l) => l.field_id)}
      />

      <ConfirmModal
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete Invoice"
        message="Are you sure you want to delete this field application invoice? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
