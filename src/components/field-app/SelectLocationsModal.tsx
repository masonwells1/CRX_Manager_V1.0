import { useState, useEffect, useMemo, useCallback } from 'react';
import { X, MapPin, Search } from 'lucide-react';
import Button from '../ui/Button';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import CRXMap from '../map/CRXMap';
import FieldBoundaryLayer from '../map/FieldBoundaryLayer';
import type { Field, Customer } from '../../types';

interface FieldWithBilling extends Field {
  customer_name?: string;
  billing_customer_names?: string;
}

interface SelectLocationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (fields: FieldWithBilling[]) => void;
  initialSelectedIds?: string[];
}

export default function SelectLocationsModal({
  isOpen,
  onClose,
  onSelect,
  initialSelectedIds = [],
}: SelectLocationsModalProps) {
  const [fields, setFields] = useState<FieldWithBilling[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(initialSelectedIds));
  const [customerFilter, setCustomerFilter] = useState('');
  const [searchText, setSearchText] = useState('');
  const [cropFilter, setCropFilter] = useState('');

  const fetchFields = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('fields')
      .select('*, customer:customers!fields_customer_id_fkey(farm_name), billing_defaults:field_billing_defaults(customer_id, split_pct, is_primary, customer:customers!field_billing_defaults_customer_id_fkey(farm_name))')
      .eq('is_active', true)
      .order('field_name');

    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', component: 'SelectLocationsModal' } });
      setLoading(false);
      return;
    }

    const enriched = ((data || []) as Array<Record<string, unknown>>).map((f) => {
      const cust = f.customer as { farm_name: string } | null;
      const defaults = (f.billing_defaults || []) as Array<{ customer: { farm_name: string } | null }>;
      const billingNames = defaults
        .map((d) => d.customer?.farm_name)
        .filter(Boolean)
        .join(', ');
      return {
        ...f,
        customer_name: cust?.farm_name || 'Unknown',
        billing_customer_names: billingNames || cust?.farm_name || '',
      } as unknown as FieldWithBilling;
    });

    setFields(enriched);
    setLoading(false);
  }, []);

  const fetchCustomers = useCallback(async () => {
    const { data } = await supabase
      .from('customers')
      .select('id, farm_name')
      .eq('is_active', true)
      .order('farm_name');
    setCustomers((data || []) as Customer[]);
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchFields();
      fetchCustomers();
      setSelectedIds(new Set(initialSelectedIds));
    }
  }, [isOpen, fetchFields, fetchCustomers, initialSelectedIds]);

  const cropTypes = useMemo(() => {
    const set = new Set(fields.map((f) => f.crop_type).filter(Boolean) as string[]);
    return Array.from(set).sort();
  }, [fields]);

  const filtered = useMemo(() => {
    return fields.filter((f) => {
      if (customerFilter && f.customer_id !== customerFilter) return false;
      if (searchText) {
        const lower = searchText.toLowerCase();
        const nameMatch = f.field_name?.toLowerCase().includes(lower);
        const custMatch = f.customer_name?.toLowerCase().includes(lower);
        if (!nameMatch && !custMatch) return false;
      }
      if (cropFilter && f.crop_type !== cropFilter) return false;
      return true;
    });
  }, [fields, customerFilter, searchText, cropFilter]);

  const selectedFields = useMemo(() => fields.filter((f) => selectedIds.has(f.id)), [fields, selectedIds]);

  const totalPlantedAcres = useMemo(
    () => selectedFields.reduce((sum, f) => sum + (f.total_acres || 0), 0),
    [selectedFields]
  );

  const toggleField = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((f) => f.id)));
    }
  };

  const handleSelect = () => {
    onSelect(selectedFields);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch bg-black/50">
      <div className="flex flex-1 bg-white m-4 rounded-xl shadow-2xl overflow-hidden">
        {/* Left: Map */}
        <div className="w-1/2 relative">
          <CRXMap
            className="h-full w-full"
            showLayerToggle
            showLocateMe
          >
            {/* Phase 6 (2026-04-30): show ALL filtered fields with selected ones
                highlighted, so the map is a usable picker even before any
                selection. Click on the map to toggle. */}
            <FieldBoundaryLayer
              fields={filtered}
              selectedIds={selectedIds}
              onFieldClick={toggleField}
              showLabels
            />
          </CRXMap>
        </div>

        {/* Right: Table */}
        <div className="w-1/2 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <div className="flex items-center gap-2">
              <MapPin className="w-5 h-5 text-crx-green" />
              <h2 className="text-lg font-semibold">Select Locations</h2>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Filters */}
          <div className="flex gap-2 px-4 py-2 border-b bg-gray-50">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search fields..."
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-sm border rounded-lg"
              />
            </div>
            <select
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              className="text-sm border rounded-lg px-2 py-2"
            >
              <option value="">All Customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.farm_name}</option>
              ))}
            </select>
            <select
              value={cropFilter}
              onChange={(e) => setCropFilter(e.target.value)}
              className="text-sm border rounded-lg px-2 py-2"
            >
              <option value="">All Crops</option>
              {cropTypes.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="w-6 h-6 border-4 border-crx-green border-t-transparent rounded-full animate-spin" />
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left">
                      <input
                        type="checkbox"
                        checked={filtered.length > 0 && selectedIds.size === filtered.length}
                        onChange={toggleAll}
                        className="rounded"
                      />
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Name</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Crop</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Customers</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Total Acres</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((f) => (
                    <tr
                      key={f.id}
                      className={`hover:bg-gray-50 cursor-pointer ${selectedIds.has(f.id) ? 'bg-crx-green/5' : ''}`}
                      onClick={() => toggleField(f.id)}
                    >
                      {/* Phase 6 (2026-04-30): stop event propagation here so
                          clicking the checkbox doesn't ALSO fire the row's
                          onClick (was double-toggling, leaving state unchanged). */}
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(f.id)}
                          onChange={() => toggleField(f.id)}
                          className="rounded"
                        />
                      </td>
                      <td className="px-3 py-2 font-medium">{f.field_name}</td>
                      <td className="px-3 py-2 text-gray-600">{f.crop_type || '\u2014'}</td>
                      <td className="px-3 py-2 text-gray-600 truncate max-w-[140px]" title={f.billing_customer_names}>
                        {f.billing_customer_names || f.customer_name}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{f.total_acres?.toFixed(1) || '\u2014'}</td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-8 text-center text-gray-400">No fields found</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
            <div className="text-sm text-gray-600">
              <span className="font-medium">{selectedIds.size}</span> locations selected
              {' \u00B7 '}
              <span className="font-medium">{totalPlantedAcres.toFixed(1)}</span> total acres
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button onClick={handleSelect} disabled={selectedIds.size === 0}>
                Select {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
